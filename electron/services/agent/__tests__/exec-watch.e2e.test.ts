/**
 * 等命令不卡人：插话先回答、有终点的命令盯到底、常驻的放手；按停连命令一起停。
 * 真实 SailFish.run() + 真实子进程 + 脚本化模型。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices, AgentStep } from '../types'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../knowledge', () => ({
  getKnowledgeService: () => ({
    isEnabled: () => false,
    searchConversations: async () => [],
    buildContext: async () => '',
  })
}))

const checkpoint = vi.hoisted(() => ({ ms: 3 * 60_000 }))
// 只改挂着等的检查点间隔；工具单次等待上限在导入时已定，不受影响
vi.mock('../background-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../background-watch')>()
  return {
    ...actual,
    get HOLD_CHECKPOINT_MS() { return checkpoint.ms },
  }
})

import { SailFish } from '../sailfish'
import { getExecManager } from '../tools/exec-manager'

type Msg = { role?: string; content?: unknown; tool_calls?: unknown }
type LlmResponse = {
  content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}

const itPosix = process.platform === 'win32' ? it.skip : it

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return String(messages[i].content || '')
  }
  return ''
}

function allText(messages: Msg[]): string {
  return messages.map(m => String(m.content ?? '')).join('\n')
}

function tc(name: string, args: Record<string, unknown>, id = `tc-${name}-${Math.random().toString(36).slice(2, 7)}`) {
  return { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }
}

function makeServices(responder: (call: { index: number; messages: Msg[] }) => LlmResponse | Promise<LlmResponse>): AgentServices {
  let index = 0
  const inflight = new Set<() => void>()
  return {
    aiService: {
      chat: vi.fn().mockResolvedValue(''),
      chatWithToolsStream: vi.fn(async (
        messages: Msg[],
        _tools: ToolDefinition[],
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
        onError?: (e: string) => void
      ) => {
        let cancelled = false
        const cancel = () => { cancelled = true }
        inflight.add(cancel)
        try {
          const r = await responder({ index: index++, messages: JSON.parse(JSON.stringify(messages)) })
          if (cancelled) {
            onError?.('aborted')
            return
          }
          const content = r.content ?? ''
          if (content) onChunk(content)
          onDone({ content, tool_calls: r.tool_calls })
        } finally {
          inflight.delete(cancel)
        }
      }),
      abort: vi.fn(() => {
        for (const cancel of inflight) cancel()
        inflight.clear()
      })
    } as any,
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as any,
    configService: {
      get: vi.fn().mockReturnValue(undefined),
      getAgentMbti: vi.fn().mockReturnValue(null),
      getAiRules: vi.fn().mockReturnValue(''),
      getAgentPersonalityText: vi.fn().mockReturnValue(''),
      getAgentName: vi.fn().mockReturnValue(''),
      getLanguage: vi.fn().mockReturnValue('zh-CN'),
      getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
      getActiveAiProfile: vi.fn().mockReturnValue('test'),
      getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
      hasVisionCapability: vi.fn().mockReturnValue(true),
      getCommandRiskPolicy: vi.fn().mockReturnValue(undefined),
      isAutoApprovalReviewEnabled: vi.fn().mockReturnValue(false)
    } as any,
    hostProfileService: {
      generateHostContext: vi.fn().mockReturnValue(''),
      addNote: vi.fn(),
      getProfile: vi.fn().mockReturnValue(null)
    } as any,
    historyService: undefined,
    conversationManager: undefined
  }
}

function ctx(): AgentContext {
  return {
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    cwd: tmpDir,
  }
}

function newAgent(services: AgentServices, id: string): SailFish {
  const agent = new SailFish(services)
  agent.setAgentId(id)
  agent.updateConfig({ executionMode: 'free' })
  return agent
}

function pidFrom(messages: Msg[]): number | undefined {
  const m = allText(messages).match(/pid=(\d+)/)
  return m ? Number(m[1]) : undefined
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

describe('等命令不卡人：插话先回答、有终点的盯到底、常驻的放手；按停连命令一起停', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-exec-watch-e2e-'))
  })
  afterEach(() => {
    checkpoint.ms = 3 * 60_000
    getExecManager()._resetForTest()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  itPosix('插话先回答，答完这一轮不收工；盯的时候再问也马上回；命令跑完在同一轮里报结果', async () => {
    const timeline: string[] = []
    const services = makeServices(({ index, messages }) => {
      const last = lastUserText(messages)
      if (index === 0) {
        return { content: '这就跑', tool_calls: [tc('exec', { command: 'echo start; sleep 2; echo done-marker', wait_seconds: 30 })] }
      }
      if (last.includes('done-marker')) {
        timeline.push('reported')
        return { content: '最后一行：done-marker' }
      }
      if (last.includes('第二问')) {
        timeline.push('answered-2')
        return { content: '还在跑' }
      }
      timeline.push('answered-1')
      return { content: '跑了不到一秒，命令没停' }
    })
    const agent = newAgent(services, 'e2e-exec-watch')
    const steps: AgentStep[] = []
    const started = Date.now()
    const runPromise = agent.run('跑这条命令，等它结束告诉我最后一行', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await sleep(400)
    agent.addUserMessage('现在跑了多久？命令别停')
    await sleep(700)
    expect(timeline).toEqual(['answered-1'])
    expect(agent.isRunning()).toBe(true)

    agent.addUserMessage('第二问：还在吗')
    await sleep(300)
    expect(timeline).toEqual(['answered-1', 'answered-2'])

    const result = await runPromise
    expect(result).toContain('done-marker')
    expect(timeline).toEqual(['answered-1', 'answered-2', 'reported'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(1800)

    // 不冒一条假装是用户说的
    const userBubbles = steps.filter(s => s.type === 'user_task' || s.type === 'user_supplement').map(s => s.content)
    expect(userBubbles.some(c => c.includes('done-marker'))).toBe(false)
    // 盯着的时候界面上看得出在等
    expect(steps.some(s => s.type === 'tool_call' && s.toolName === 'await_exec')).toBe(true)
  }, 15000)

  itPosix('到点转后台的有终点命令：这一轮收尾时没跑完就不收工，跑完在同一轮里报结果', async () => {
    const timeline: string[] = []
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'sleep 2; echo bg-done', wait_seconds: 1 })] }
      }
      if (lastUserText(messages).includes('bg-done')) {
        timeline.push('reported')
        return { content: '后台那条跑完了：bg-done' }
      }
      timeline.push('wrapped-up')
      return { content: '先放后台，我去干别的' }
    })
    const agent = newAgent(services, 'e2e-exec-bg')
    const steps: AgentStep[] = []
    const started = Date.now()
    const result = await agent.run('跑个 sleep', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    expect(result).toContain('bg-done')
    expect(timeline).toEqual(['wrapped-up', 'reported'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(1800)
    expect(steps.some(s => s.type === 'tool_call' && s.toolName === 'await_exec')).toBe(true)
    const userBubbles = steps.filter(s => s.type === 'user_task' || s.type === 'user_supplement').map(s => s.content)
    expect(userBubbles.some(c => c.includes('bg-done'))).toBe(false)
  }, 15000)

  itPosix('启动时标成常驻的：不挂住这一轮，结束也不回头找人', async () => {
    let calls = 0
    const services = makeServices(({ index }) => {
      calls++
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'sleep 4', wait_seconds: 1, service: true })] }
      }
      return { content: '服务起来了' }
    })
    const agent = newAgent(services, 'e2e-exec-service')
    const started = Date.now()
    const result = await agent.run('起个服务', ctx())
    expect(result).toContain('服务起来了')
    expect(Date.now() - started).toBeLessThan(3000)
    await sleep(3500)
    expect(calls).toBe(2)
    expect(agent.isRunning()).toBe(false)
  }, 15000)

  for (const extra of [{}, { wait_seconds: 1 }]) {
    itPosix(`忘了标常驻，事后改标：这一轮照样能收工 ${JSON.stringify(extra)}`, async () => {
      let calls = 0
      const services = makeServices(({ index, messages }) => {
        calls++
        if (index === 0) {
          return { tool_calls: [tc('exec', { command: 'sleep 5', wait_seconds: 1 })] }
        }
        if (index === 1) {
          const taskId = allText(messages).match(/task_id=(exec-\d+)/)?.[1]
          return { tool_calls: [tc('await_exec', { task_id: taskId, service: true, ...extra })] }
        }
        return { content: '改标成常驻了' }
      })
      const agent = newAgent(services, 'e2e-exec-remark')
      const started = Date.now()
      const result = await agent.run('起个服务', ctx())
      expect(result).toContain('改标成常驻了')
      expect(Date.now() - started).toBeLessThan(4000)
      await sleep(4000)
      expect(calls).toBe(3)
      expect(agent.isRunning()).toBe(false)
    }, 15000)
  }

  itPosix('盯着时按停：命令连子进程一起停掉，不再送回结果；下一轮带着交代', async () => {
    let pid: number | undefined
    const seenNextTurn: string[] = []
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        // 后台的 sleep 在非交互 shell 里不理 Ctrl+C，只能靠到点强制结束
        return { tool_calls: [tc('exec', { command: "trap 'echo cleaned; exit 3' INT; echo start; sleep 30 & wait", wait_seconds: 30 })] }
      }
      pid = pid ?? pidFrom(messages)
      const last = lastUserText(messages)
      if (last.includes('刚才那条')) {
        seenNextTurn.push(last)
        return { content: '那条被你停在半截了' }
      }
      return { content: '还在跑，我接着盯' }
    })
    const agent = newAgent(services, 'e2e-exec-stop')
    const steps: AgentStep[] = []
    const runPromise = agent.run('跑个长命令', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })

    await sleep(400)
    agent.addUserMessage('跑多久了')
    await sleep(500)
    expect(pid).toBeTruthy()
    expect(groupAlive(pid!)).toBe(true)

    expect(agent.abort()).toBe(true)
    await runPromise.catch(() => undefined)

    await sleep(4000)
    expect(groupAlive(pid!)).toBe(false)
    expect(steps.some(s => s.type === 'tool_result' && String(s.content).includes('已停止'))).toBe(true)

    await agent.run('刚才那条怎么样了', ctx())
    expect(seenNextTurn).toHaveLength(1)
    expect(seenNextTurn[0]).toContain('中途停掉')
    expect(seenNextTurn[0]).toContain('sleep 30')
    // 停下之后命令收尾打印的也带上
    expect(seenNextTurn[0]).toContain('cleaned')
  }, 20000)

  itPosix('插话后过了原定等待仍在跑：照样盯到底，跑完报结果', async () => {
    const timeline: string[] = []
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'sleep 3; echo late-done', wait_seconds: 1 })] }
      }
      if (lastUserText(messages).includes('late-done')) {
        timeline.push('reported')
        return { content: '跑完了：late-done' }
      }
      timeline.push('answered')
      return { content: '还在跑' }
    })
    const agent = newAgent(services, 'e2e-exec-past-wait')
    const started = Date.now()
    const runPromise = agent.run('跑 sleep', ctx())
    await sleep(300)
    agent.addUserMessage('还要多久')
    const result = await runPromise
    expect(result).toContain('late-done')
    expect(timeline).toEqual(['answered', 'reported'])
    expect(Date.now() - started).toBeGreaterThanOrEqual(2800)
  }, 15000)

  itPosix('工具还在等时按停：正在等的那条也一起停', async () => {
    let pid: number | undefined
    const services = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'echo $$; sleep 30', wait_seconds: 30 })] }
      }
      return { content: '好' }
    })
    const agent = newAgent(services, 'e2e-exec-stop-waiting')
    const runPromise = agent.run('跑个长命令', ctx())
    await sleep(500)
    const running = getExecManager().list().find(t => t.status === 'running')
    pid = running?.pid
    expect(pid).toBeTruthy()
    agent.abort()
    await runPromise.catch(() => undefined)
    await sleep(4000)
    expect(groupAlive(pid!)).toBe(false)
  }, 15000)

  itPosix('盯久了叫醒它看一眼：看到还在推进就接着等，跑完照样在同一轮报结果', async () => {
    checkpoint.ms = 800
    const timeline: string[] = []
    const seenAtCheckpoint: string[] = []
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'echo step1; sleep 1.5; echo step2; sleep 1.5; echo fin', wait_seconds: 1 })] }
      }
      const last = lastUserText(messages)
      if (last.includes('已经结束')) {
        timeline.push('reported')
        return { content: '跑完了：fin' }
      }
      if (last.includes('看一眼再决定')) {
        timeline.push('checkpoint')
        seenAtCheckpoint.push(last)
        return { content: '还在跑' }
      }
      timeline.push('wrapped-up')
      return { content: '先放后台' }
    })
    const agent = newAgent(services, 'e2e-exec-checkpoint')
    const steps: AgentStep[] = []
    const result = await agent.run('跑个脚本', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    expect(result).toContain('fin')
    expect(timeline[0]).toBe('wrapped-up')
    expect(timeline.at(-1)).toBe('reported')
    expect(timeline.filter(t => t === 'checkpoint').length).toBeGreaterThanOrEqual(1)
    // 交给它看的是实时输出
    expect(seenAtCheckpoint[0]).toContain('step1')
    expect(steps.some(s => s.type === 'tool_result' && String(s.content).includes('看一眼进度'))).toBe(true)
  }, 15000)

  itPosix('检查点看出卡死了就自己停掉：命令连子进程一起结束，这一轮收工', async () => {
    checkpoint.ms = 800
    let pid: number | undefined
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'echo stuck; sleep 30', wait_seconds: 1 })] }
      }
      const last = lastUserText(messages)
      if (pid) return { content: '已停掉那条卡住的命令' }
      if (last.includes('看一眼再决定')) {
        pid = Number(last.match(/pid=(\d+)/)?.[1])
        const taskId = last.match(/task_id=(exec-\d+)/)?.[1]
        return { content: '一直没动静，停掉它', tool_calls: [tc('await_exec', { task_id: taskId, stop: true })] }
      }
      return { content: '先放后台' }
    })
    const agent = newAgent(services, 'e2e-exec-checkpoint-stop')
    // 默认的宽松模式：停自己起的命令不该卡在确认框上
    agent.updateConfig({ executionMode: 'relaxed' })
    const steps: AgentStep[] = []
    const started = Date.now()
    const result = await agent.run('跑个脚本', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    expect(pid).toBeTruthy()
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result).toContain('已停掉')
    expect(steps.some(s => s.type === 'confirm')).toBe(false)
    expect(steps.some(s => s.type === 'tool_result' && String(s.content).includes('已停止'))).toBe(true)
    await sleep(3500)
    expect(groupAlive(pid!)).toBe(false)
  }, 15000)

  itPosix('附了人话说明：执行命令那张卡说明和完整命令都在，等待卡用同一句说明', async () => {
    const command = "echo $'a'; sleep 2; echo \"$&b\""
    const services = makeServices(({ index, messages }) => {
      if (index === 0) {
        return { content: '跑一下', tool_calls: [tc('exec', { command, description: '跑个小脚本', wait_seconds: 1 })] }
      }
      if (lastUserText(messages).includes('已经结束')) return { content: '跑完了' }
      return { content: '先放后台' }
    })
    const agent = newAgent(services, 'e2e-exec-description')
    const steps: AgentStep[] = []
    await agent.run('跑个脚本', ctx(), {
      callbacks: { onStep: (_id, step) => { steps.push({ ...step }) } }
    })
    const calls = steps.filter(s => s.type === 'tool_call')
    const execCard = calls.find(s => s.toolName === 'exec')
    expect(String(execCard?.content)).toContain('跑个小脚本')
    expect(String(execCard?.content).endsWith(`: ${command}`)).toBe(true)
    const waits = calls.filter(s => s.toolName === 'await_exec')
    expect(waits.length).toBeGreaterThan(0)
    expect(waits.every(s => String(s.content).includes('跑个小脚本'))).toBe(true)
    expect(waits.some(s => String(s.content).includes('exec-'))).toBe(false)
  }, 15000)

  itPosix('风险确认只拿到完整命令，看不到人话说明', async () => {
    const command = `rm -rf ${path.join(os.tmpdir(), `sft-desc-confirm-${process.pid}`)}`
    const services = makeServices(({ index }) => {
      if (index === 0) {
        return { tool_calls: [tc('exec', { command, description: '清理旧构建' })] }
      }
      return { content: '好，不删了' }
    })
    const agent = newAgent(services, 'e2e-exec-description-confirm')
    agent.updateConfig({ executionMode: 'strict' })
    const asked: Array<Record<string, unknown>> = []
    await agent.run('清理一下', ctx(), {
      callbacks: {
        onNeedConfirm: (confirmation) => {
          asked.push(confirmation.toolArgs)
          agent.confirmToolCall(confirmation.toolCallId, false)
        }
      }
    })
    expect(asked).toEqual([{ command }])
  }, 15000)

  itPosix('只能叫停这场对话自己起的命令，别的对话起的停不了', async () => {
    const owner = newAgent(makeServices(({ index }) => index === 0
      ? { content: '起个服务', tool_calls: [tc('exec', { command: 'echo up; sleep 20', wait_seconds: 1, service: true })] }
      : { content: '起好了' }), 'e2e-exec-stop-owner')
    await owner.run('起个服务', ctx())
    const task = getExecManager().list().find(t => t.status === 'running')
    expect(task).toBeTruthy()

    let refusal = ''
    const other = newAgent(makeServices(({ index, messages }) => {
      if (index === 0) return { content: '停掉它', tool_calls: [tc('await_exec', { task_id: task!.taskId, stop: true })] }
      refusal = allText(messages)
      return { content: '停不了' }
    }), 'e2e-exec-stop-other')
    await other.run('把那条命令停了', ctx())
    expect(refusal).toContain('不是这场对话起的命令')
    expect(getExecManager().get(task!.taskId)?.status).toBe('running')
    expect(groupAlive(task!.pid!)).toBe(true)
  }, 15000)

  it('检查点间隔卡在模型缓存有效期（常见 5 分钟）以内', async () => {
    const actual = await vi.importActual<typeof import('../background-watch')>('../background-watch')
    expect(actual.HOLD_CHECKPOINT_MS).toBeLessThan(5 * 60_000)
    expect(actual.MAX_WAIT_SECONDS * 1000).toBeLessThanOrEqual(actual.HOLD_CHECKPOINT_MS)
  })

  itPosix('检查点看出其实是常驻的：改标后这一轮收工', async () => {
    checkpoint.ms = 800
    let calls = 0
    let marked = false
    const services = makeServices(({ index, messages }) => {
      calls++
      if (index === 0) {
        return { tool_calls: [tc('exec', { command: 'echo listening; sleep 5', wait_seconds: 1 })] }
      }
      if (marked) return { content: '放手了，服务留着' }
      const last = lastUserText(messages)
      if (last.includes('看一眼再决定')) {
        marked = true
        const taskId = last.match(/task_id=(exec-\d+)/)?.[1]
        return { tool_calls: [tc('await_exec', { task_id: taskId, service: true })] }
      }
      return { content: '先放后台' }
    })
    const agent = newAgent(services, 'e2e-exec-checkpoint-service')
    const started = Date.now()
    const result = await agent.run('起个服务', ctx())
    expect(result).toContain('放手了')
    expect(Date.now() - started).toBeLessThan(4000)
    const callsAtEnd = calls
    await sleep(4500)
    expect(calls).toBe(callsAtEnd)
  }, 15000)
})
