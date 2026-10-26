/**
 * 伙计连远程主机：派出时的授权、伙计手里的 remote_exec、补单、按处境出现的工具。
 * 通道用假的（只记下调用），真 sshd 的验证在 remote-exec 目录下。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-remote-dispatch-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

vi.mock('../../im/im.service', () => ({ getIMService: vi.fn().mockReturnValue(null) }))
vi.mock('../../user-skill.service', () => ({ getUserSkillService: () => ({ getEnabledSkills: () => [] }) }))
vi.mock('../../web-search/index', () => ({ isConfigured: () => false, getApiKey: () => '' }))

const savedSessions = [
  { id: 'a1', name: 'web-01', host: '10.0.0.11', port: 22, username: 'deploy', groupId: 'g-prod', authType: 'password', password: 'x' },
  { id: 'a2', name: 'web-02', host: '10.0.0.12', port: 22, username: 'deploy', groupId: 'g-prod', authType: 'password', password: 'x' },
  { id: 'b1', name: 'lab', host: '10.0.1.5', port: 22, username: 'root', authType: 'password', password: 'y' },
]
vi.mock('../../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    getSshSessions: () => savedSessions,
    getSessionGroups: () => [{ id: 'g-prod', name: '生产' }],
  }),
}))

import { dispatchSubAgents, followupAgent, parseDispatchTasks, parseRemoteCommands } from '../tools/sub-agent'
import { remoteExecTool } from '../tools/remote-exec'
import { getAgentTools, filterSubAgentTools } from '../tools'
import { SubAgentRoster, type ChildAgentHandle } from '../sub-agent-roster'
import { WorkerRemoteAccess } from '../remote-access/worker-remote-access'
import { RemoteGrant } from '../remote-access/remote-grant'
import { RemoteOpRecorder } from '../remote-access/remote-op-recorder'
import { ensureAgentWorkspaceDirs } from '../tools/file'
import type { ToolExecutorConfig, AgentConfig } from '../tools/types'
import type { AgentContext } from '../types'
import type { AgentStep, ExecutionMode } from '@shared/types'
import type { RemoteExecPool, RemoteExecResult } from '../../remote-exec'

beforeAll(async () => {
  fs.mkdirSync(mockUserData, { recursive: true })
  ensureAgentWorkspaceDirs()
  const { ensureShellAstReady } = await import('../command-audit/parser')
  await ensureShellAstReady()
})

afterAll(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true })
})

const baseContext: AgentContext = {
  terminalOutput: [],
  systemInfo: { os: 'darwin', shell: 'zsh' },
  terminalType: 'assistant',
  cwd: '/tmp',
}

function configOf(executionMode: ExecutionMode): AgentConfig {
  return {
    enabled: true, maxSteps: 0, commandTimeout: 30000, autoExecuteSafe: true, autoExecuteModerate: true,
    executionMode, debugMode: false,
  }
}

interface StubChild extends ChildAgentHandle {
  access?: WorkerRemoteAccess
  prompts: string[]
}

function stubChild(): StubChild {
  const child: StubChild = {
    prompts: [],
    isRunning: () => false,
    abort: () => true,
    addUserMessage: (message: string) => { child.prompts.push(message); return true },
    setRemoteAccess: (access) => { child.access = access },
    async run(message: string) {
      child.prompts.push(message)
      return 'done'
    },
  }
  return child
}

function executorFor(
  roster: SubAgentRoster,
  opts: { agentId?: string; unattended?: boolean; confirm?: (...args: unknown[]) => Promise<boolean> } = {},
) {
  const steps: AgentStep[] = []
  const children = new Map<string, StubChild>()
  const confirm = vi.fn(opts.confirm ?? (async () => true))
  let n = 0
  const executor = {
    agentId: opts.agentId ?? 'assistant:run-1',
    terminalService: {} as never,
    addStep: (partial: Partial<AgentStep>) => {
      const step = { ...partial, id: `s-${++n}`, timestamp: Date.now() } as AgentStep
      steps.push(step)
      return step
    },
    updateStep: () => {},
    waitForConfirmation: confirm,
    requestSecureInput: async () => false,
    isAborted: () => false,
    getHostId: () => undefined,
    hasPendingUserMessage: () => false,
    peekPendingUserMessage: () => undefined,
    consumePendingUserMessage: () => undefined,
    getRealtimeTerminalOutput: () => [],
    getCurrentPlan: () => undefined,
    setCurrentPlan: () => {},
    getTaskMemory: () => ({}) as never,
    getAgentContext: () => ({ ...baseContext, ...(opts.unattended ? { unattended: true } : {}) }),
    getAiRules: () => '',
    getSubAgentRoster: () => roster,
    getParentMessages: () => [],
    knockParent: () => {},
    createChildAgent: (name: string) => {
      const child = stubChild()
      children.set(name, child)
      return child
    },
  } as unknown as ToolExecutorConfig
  return { executor, confirm, children }
}

async function settle(roster: SubAgentRoster): Promise<void> {
  await roster.waitUntil(undefined, new AbortController().signal)
}

const remoteArgs = {
  tasks: [
    { description: '看 web-01', prompt: '看磁盘', hosts: ['a1'] },
    { description: '看 web-02 和 lab', prompt: '看磁盘', hosts: ['a2', 'b1'] },
    { description: '本机的活', prompt: '看本机' },
  ],
  remote_commands: ['df -h', 'uptime'],
}

describe('参数解析', () => {
  it('hosts 去重；写错类型整批退回', () => {
    const ok = parseDispatchTasks({ tasks: [{ description: 'a', prompt: 'p', hosts: ['a1', ' a1 ', 'a2'] }] })
    expect('tasks' in ok && ok.tasks[0]).toMatchObject({ hosts: ['a1', 'a2'] })
    expect('error' in parseDispatchTasks({ tasks: [{ description: 'a', prompt: 'p', hosts: 'a1' }] })).toBe(true)
    expect('error' in parseDispatchTasks({ batch: { instruction: 'i', items: [{ description: 'a', input: 'x', hosts: [1] }] } })).toBe(true)
  })

  it('batch 条目也能带 hosts', () => {
    const r = parseDispatchTasks({ batch: { instruction: '看', items: [{ description: 'a', input: 'x', hosts: ['a1'] }] } })
    expect('tasks' in r && r.tasks[0]).toMatchObject({ hosts: ['a1'] })
  })

  it('每个伙计和 batch 条目可以带自己的 remote_commands；写错类型整批退回', () => {
    const ok = parseDispatchTasks({ tasks: [{ description: 'a', prompt: 'p', hosts: ['a1'], remote_commands: [' df -h ', 'df -h'] }] })
    expect('tasks' in ok && ok.tasks[0]).toMatchObject({ remoteCommands: ['df -h'] })
    const batch = parseDispatchTasks({ batch: { instruction: '看', items: [{ description: 'a', input: 'x', hosts: ['a1'], remote_commands: ['uptime'] }] } })
    expect('tasks' in batch && batch.tasks[0]).toMatchObject({ remoteCommands: ['uptime'] })
    const err = parseDispatchTasks({ tasks: [{ description: 'a', prompt: 'p', hosts: ['a1'], remote_commands: 'df -h' }] })
    expect('error' in err && err.error).toContain('子任务 1')
    expect('error' in parseDispatchTasks({ batch: { instruction: 'i', items: [{ description: 'a', input: 'x', remote_commands: [1] }] } })).toBe(true)
  })

  it('remote_commands 去重去空白；类型不对退回', () => {
    expect(parseRemoteCommands({ remote_commands: [' df -h ', 'df -h', 'uptime'] })).toEqual({ commands: ['df -h', 'uptime'] })
    expect(parseRemoteCommands({})).toEqual({ commands: [] })
    expect('error' in parseRemoteCommands({ remote_commands: 'df -h' })).toBe(true)
  })
})

describe('派出', () => {
  let roster: SubAgentRoster
  beforeEach(() => {
    roster = new SubAgentRoster()
  })

  it('宽松档：问一次；批准后每个伙计各拿自己的范围，处境说明接在任务后面', async () => {
    const { executor, confirm, children } = executorFor(roster)
    const result = await dispatchSubAgents(remoteArgs, configOf('relaxed'), executor, 'call-1')
    expect(result.success).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    const call = confirm.mock.calls[0] as unknown[]
    expect(call[1]).toBe('dispatch_agents')
    expect(call[3]).toBe('moderate')
    expect((call[7] as { remoteAccess: { commands: string[] } }).remoteAccess.commands).toEqual(['df -h', 'uptime'])
    await settle(roster)

    const [first, second, third] = [...children.values()]
    expect(first!.access?.grant.hosts.map(h => h.id)).toEqual(['a1'])
    expect(second!.access?.grant.hosts.map(h => h.id)).toEqual(['a2', 'b1'])
    expect(third!.access).toBeUndefined()
    expect(first!.prompts[0]).toContain('看磁盘')
    expect(first!.prompts[0]).toContain('web-01（sessionId: a1，deploy@10.0.0.11:22，分组：生产）')
    expect(first!.prompts[0]).toContain('1. `df -h`')
    expect(third!.prompts[0]).toBe('看本机')
    // 界面上显示的仍是原来的指令，不带处境说明
    expect(roster.list().find(c => c.description === '看 web-01')?.shownPrompt).toBe('看磁盘')
  })

  it('伙计各带自己的命令：卡上分块，每个伙计只拿到共有的加自己的', async () => {
    const { executor, confirm, children } = executorFor(roster)
    const result = await dispatchSubAgents(
      {
        tasks: [
          { description: '看 web-01', prompt: '看磁盘', hosts: ['a1'], remote_commands: ['df -h'] },
          { description: '看 web-02', prompt: '看负载', hosts: ['a2'], remote_commands: ['uptime'] },
        ],
        remote_commands: ['hostname'],
      },
      configOf('relaxed'),
      executor,
      'call-1',
    )
    expect(result.success).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    const card = (confirm.mock.calls[0] as unknown[])[7] as { remoteAccess: { assignments: Array<{ commands: string[] }> } }
    expect(card.remoteAccess.assignments.map(b => b.commands)).toEqual([['hostname', 'df -h'], ['hostname', 'uptime']])
    await settle(roster)
    const [first, second] = [...children.values()]
    expect(first!.access?.grant.permitsCommand('df -h')).toBe(true)
    expect(first!.access?.grant.permitsCommand('uptime')).toBe(false)
    expect(second!.access?.grant.permitsCommand('uptime')).toBe(true)
    expect(second!.access?.grant.permitsCommand('df -h')).toBe(false)
    expect(first!.prompts[0]).toContain('`df -h`')
    expect(first!.prompts[0]).not.toContain('`uptime`')
  })

  it('自由模式：不问，范围照样给', async () => {
    const { executor, confirm, children } = executorFor(roster)
    const result = await dispatchSubAgents(remoteArgs, configOf('free'), executor, 'call-1')
    expect(result.success).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    await settle(roster)
    expect([...children.values()][0]!.access?.grant.commands).toEqual(['df -h', 'uptime'])
  })

  it('没带 hosts 的派出和从前一样：不问', async () => {
    const { executor, confirm } = executorFor(roster)
    const result = await dispatchSubAgents({ tasks: [{ description: 'a', prompt: 'p' }] }, configOf('strict'), executor)
    expect(result.success).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    await settle(roster)
  })

  it('命令不是只读：整批退回，一个伙计都没派，也没问人', async () => {
    const { executor, confirm } = executorFor(roster)
    const result = await dispatchSubAgents(
      { ...remoteArgs, remote_commands: ['df -h', 'rm -rf /var/log/app'] },
      configOf('free'), executor,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('第 2 条')
    expect(roster.list()).toHaveLength(0)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('用户拒绝：整批退回', async () => {
    const { executor } = executorFor(roster, { confirm: async () => false })
    const result = await dispatchSubAgents(remoteArgs, configOf('relaxed'), executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('用户没有批准')
    expect(roster.list()).toHaveLength(0)
  })

  it('关切里：退回，哪怕是自由模式', async () => {
    const { executor, confirm } = executorFor(roster, { agentId: '__watch__:w1', unattended: true })
    const result = await dispatchSubAgents(remoteArgs, configOf('free'), executor)
    expect(result.success).toBe(false)
    expect(result.error).toContain('后台执行里不能派')
    expect(confirm).not.toHaveBeenCalled()
    expect(roster.list()).toHaveLength(0)
  })

  it('唤醒里：同样退回', async () => {
    const { executor } = executorFor(roster, { agentId: '__wakeup__', unattended: true })
    const result = await dispatchSubAgents(remoteArgs, configOf('free'), executor)
    expect(result.success).toBe(false)
  })

  it('没人值守的命令行：非自由模式退回，自由模式可派', async () => {
    const denied = executorFor(new SubAgentRoster(), { unattended: true })
    const r1 = await dispatchSubAgents(remoteArgs, configOf('relaxed'), denied.executor)
    expect(r1.success).toBe(false)
    expect(r1.error).toContain('没有人能确认')

    const allowed = executorFor(roster, { unattended: true })
    const r2 = await dispatchSubAgents(remoteArgs, configOf('free'), allowed.executor)
    expect(r2.success).toBe(true)
    await settle(roster)
  })

  it('主机写成不存在的 id：整批退回', async () => {
    const { executor } = executorFor(roster)
    const result = await dispatchSubAgents(
      { tasks: [{ description: 'a', prompt: 'p', hosts: ['zz'] }], remote_commands: ['df -h'] },
      configOf('free'), executor,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('zz')
  })
})

describe('补单', () => {
  it('补的命令按审批方式问；批准后记进他的单子，话里带上新的处境', async () => {
    const roster = new SubAgentRoster()
    const { executor, confirm, children } = executorFor(roster)
    await dispatchSubAgents({ tasks: [{ description: 'w', prompt: 'p', hosts: ['a1'] }], remote_commands: ['df -h'] }, configOf('free'), executor)
    await settle(roster)
    const name = roster.list()[0]!.name
    const child = children.get(name)!

    const result = await followupAgent({ name, message: '再看看内存', remote_commands: ['free -g'] }, executor, configOf('relaxed'), 'call-2')
    expect(result.success).toBe(true)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect((confirm.mock.calls[0] as unknown[])[1]).toBe('followup_agent')
    expect(roster.remoteGrantOf(name)?.commands).toEqual(['df -h', 'free -g'])
    expect(child.access?.grant.permitsCommand('free -g')).toBe(true)
    await settle(roster)
    expect(child.prompts.at(-1)).toContain('再看看内存')
    expect(child.prompts.at(-1)).toContain('2. `free -g`')
  })

  it('用户拒绝：单子不变，话也不交', async () => {
    const roster = new SubAgentRoster()
    const approving = executorFor(roster)
    await dispatchSubAgents({ tasks: [{ description: 'w', prompt: 'p', hosts: ['a1'] }], remote_commands: ['df -h'] }, configOf('free'), approving.executor)
    await settle(roster)
    const name = roster.list()[0]!.name

    const { executor } = executorFor(roster, { confirm: async () => false })
    const result = await followupAgent({ name, message: 'm', remote_commands: ['uptime'] }, executor, configOf('relaxed'))
    expect(result.success).toBe(false)
    expect(roster.remoteGrantOf(name)?.commands).toEqual(['df -h'])
  })

  it('没有主机范围的伙计：不能补远程命令', async () => {
    const roster = new SubAgentRoster()
    const { executor } = executorFor(roster)
    await dispatchSubAgents({ tasks: [{ description: 'w', prompt: 'p' }] }, configOf('free'), executor)
    await settle(roster)
    const name = roster.list()[0]!.name
    const result = await followupAgent({ name, message: 'm', remote_commands: ['uptime'] }, executor, configOf('free'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('没有远程主机范围')
  })

  it('补话不带命令时和从前一样', async () => {
    const roster = new SubAgentRoster()
    const { executor, confirm } = executorFor(roster)
    await dispatchSubAgents({ tasks: [{ description: 'w', prompt: 'p', hosts: ['a1'] }], remote_commands: ['df -h'] }, configOf('free'), executor)
    await settle(roster)
    const name = roster.list()[0]!.name
    const result = await followupAgent({ name, message: '再看看' }, executor, configOf('strict'))
    expect(result.success).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('伙计手里的 remote_exec', () => {
  let dir: string
  let exec: ReturnType<typeof vi.fn>
  let access: WorkerRemoteAccess
  let recorder: RemoteOpRecorder

  function resultOf(partial: Partial<RemoteExecResult> = {}): RemoteExecResult {
    return {
      hostId: 'a1', hostName: 'web-01', exitCode: 0, output: 'ok\n', outputTruncated: false,
      durationMs: 1200, timedOut: false, aborted: false, ...partial,
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(mockUserData, 'ops-'))
    exec = vi.fn(async () => resultOf())
    recorder = new RemoteOpRecorder(dir)
    access = new WorkerRemoteAccess({
      workerName: 'w1',
      grant: new RemoteGrant([{ id: 'a1', name: 'web-01', address: 'deploy@10.0.0.11:22', group: '生产' }], ['df -h', 'uptime']),
      pool: { exec } as unknown as RemoteExecPool,
      resolveHost: (id) => id === 'a1'
        ? { id, name: 'web-01', host: '10.0.0.11', port: 22, username: 'deploy', encoding: 'utf-8' }
        : undefined,
      recorder,
    })
  })

  function executorWith(a?: WorkerRemoteAccess): ToolExecutorConfig {
    return { getRemoteAccess: () => a, getAbortSignal: () => undefined } as unknown as ToolExecutorConfig
  }

  it('单上的命令在范围里的主机上跑，返回退出码和输出', async () => {
    const r = await remoteExecTool({ host: 'a1', command: 'df -h' }, executorWith(access))
    expect(r.success).toBe(true)
    expect(r.output).toContain('主机：web-01（deploy@10.0.0.11:22）')
    expect(r.output).toContain('退出码：0')
    expect(r.output).toContain('ok')
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]![1]).toBe('df -h')
    expect(exec.mock.calls[0]![2]).toMatchObject({ timeoutMs: 60_000 })
  })

  it('范围外的主机：拒绝，说清能连哪些，不连', async () => {
    const r = await remoteExecTool({ host: 'b1', command: 'df -h' }, executorWith(access))
    expect(r.success).toBe(false)
    expect(r.error).toContain('b1')
    expect(r.error).toContain('web-01')
    expect(exec).not.toHaveBeenCalled()
  })

  it('单外的命令：拒绝，列出批准过的，不连', async () => {
    const r = await remoteExecTool({ host: 'a1', command: 'df -h; id' }, executorWith(access))
    expect(r.success).toBe(false)
    expect(r.error).toContain('不在批准的清单里')
    expect(r.error).toContain('1. `df -h`')
    expect(exec).not.toHaveBeenCalled()
  })

  it('超时秒数有默认和上限', async () => {
    await remoteExecTool({ host: 'a1', command: 'uptime', timeout_seconds: 9999 }, executorWith(access))
    expect(exec.mock.calls[0]![2]).toMatchObject({ timeoutMs: 600_000 })
    await remoteExecTool({ host: 'a1', command: 'uptime', timeout_seconds: 5 }, executorWith(access))
    expect(exec.mock.calls[1]![2]).toMatchObject({ timeoutMs: 5_000 })
  })

  it('没有远程范围的 Agent 调它：拒绝', async () => {
    const r = await remoteExecTool({ host: 'a1', command: 'df -h' }, executorWith(undefined))
    expect(r.success).toBe(false)
  })

  it('输出太长：留头尾交给伙计，全文落盘，留痕一行一条', async () => {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n')
    exec.mockResolvedValueOnce(resultOf({ output: long }))
    const r = await remoteExecTool({ host: 'a1', command: 'df -h' }, executorWith(access))
    expect(r.success).toBe(true)
    expect(r.output.length).toBeLessThan(5000)
    expect(r.output).toContain('line 0')
    expect(r.output).toContain('line 2999')
    const file = path.join(dir, 'remote', 'w1', '1.txt')
    expect(r.output).toContain(file)
    expect(fs.readFileSync(file, 'utf-8')).toBe(long)

    await recorder.flush()
    const lines = fs.readFileSync(path.join(dir, 'remote-ops.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ worker: 'w1', hostId: 'a1', hostName: 'web-01', command: 'df -h', exitCode: 0, outputFile: file })
  })

  it('非零退出码也算跑完了，原样告诉伙计', async () => {
    exec.mockResolvedValueOnce(resultOf({ exitCode: 3, output: 'boom' }))
    const r = await remoteExecTool({ host: 'a1', command: 'df -h' }, executorWith(access))
    expect(r.success).toBe(true)
    expect(r.output).toContain('退出码：3')
  })

  it('超时、连不上：说清楚原因，留痕里记下', async () => {
    exec.mockResolvedValueOnce(resultOf({ exitCode: null, output: '', timedOut: true, durationMs: 60_000 }))
    const timedOut = await remoteExecTool({ host: 'a1', command: 'df -h' }, executorWith(access))
    expect(timedOut.success).toBe(false)
    expect(timedOut.error).toContain('超过 60 秒')

    exec.mockResolvedValueOnce(resultOf({ exitCode: null, output: '', error: { kind: 'auth_failed', message: '登录被拒绝' } }))
    const refused = await remoteExecTool({ host: 'a1', command: 'df -h' }, executorWith(access))
    expect(refused.success).toBe(false)
    expect(refused.error).toContain('登录被拒绝')

    await recorder.flush()
    const lines = fs.readFileSync(path.join(dir, 'remote-ops.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l))
    expect(lines.map(l => l.exitCode)).toEqual([null, null])
    expect(lines[0].failure).toContain('超过 60 秒')
  })

  it('已存会话被删了：不执行', async () => {
    const gone = new WorkerRemoteAccess({
      workerName: 'w1',
      grant: new RemoteGrant([{ id: 'zz', name: 'old', address: 'a@b:22' }], ['df -h']),
      pool: { exec } as unknown as RemoteExecPool,
      resolveHost: () => undefined,
      recorder,
    })
    const r = await remoteExecTool({ host: 'zz', command: 'df -h' }, executorWith(gone))
    expect(r.success).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })
})

describe('工具按处境出现', () => {
  const names = (tools: Array<{ function: { name: string } }>) => tools.map(t => t.function.name)

  it('没有远程范围的 Agent 清单里没有 remote_exec', () => {
    expect(names(getAgentTools(undefined, { mode: 'assistant' }))).not.toContain('remote_exec')
    expect(names(filterSubAgentTools(getAgentTools(undefined, { mode: 'assistant' })))).not.toContain('remote_exec')
  })

  it('带了范围的伙计有；秘书那份（本机/远程终端形态）仍然没有', () => {
    const forWorker = filterSubAgentTools(getAgentTools(undefined, { mode: 'assistant', remoteAccess: true }))
    expect(names(forWorker)).toContain('remote_exec')
    expect(names(getAgentTools(undefined, { mode: 'ssh', remoteAccess: true }))).not.toContain('remote_exec')
  })

  it('只有主人能派伙计、补单；伙计清单里没有这两个', () => {
    const forWorker = names(filterSubAgentTools(getAgentTools(undefined, { mode: 'assistant', remoteAccess: true })))
    expect(forWorker).not.toContain('dispatch_agents')
    expect(forWorker).not.toContain('followup_agent')
    expect(forWorker).not.toContain('list_ssh_sessions')
  })
})
