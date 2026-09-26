/**
 * 真机：192.168.230.130
 * 连上后跑一条命令，确认记忆写到 yushen@192.168.230.130，不写本机。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { ToolDefinition } from '../tools'
import type { AgentContext, AgentServices, PromptOptions } from '../types'
import { ptyExecuteCommandTool } from '../skills/terminal/tools'
import { resolveHostIdForPty } from '../tools/host-identity'

const HOST = '192.168.230.130'
const USER = 'yushen'
const EXPECTED_HOST_ID = `${USER}@${HOST}`
const TOKEN_REMOTE = `SF_HOST_MEM_LIVE_R_${Date.now()}`
const TOKEN_LOCAL = `SF_HOST_MEM_LIVE_L_${Date.now()}`

let tmpDir = ''
let ck: import('../../knowledge/context-knowledge').ContextKnowledgeService
let sshId = ''
let localPtyId = ''

function findSshKey(): string | undefined {
  return ['id_ed25519', 'id_rsa', 'id_ecdsa']
    .map(name => path.join(os.homedir(), '.ssh', name))
    .find(p => fs.existsSync(p))
}

const sshKeyPath = findSshKey()
const hostReachable = Boolean(sshKeyPath) && spawnSync(
  'ssh',
  ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', '-o', 'StrictHostKeyChecking=accept-new', `${USER}@${HOST}`, 'true'],
  { encoding: 'utf8' },
).status === 0

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir || os.tmpdir(),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null),
}))

vi.mock('../../knowledge', () => ({
  getKnowledgeService: () => ({
    isEnabled: () => false,
    searchConversations: async () => [],
    buildContext: async () => '',
    indexConversation: async () => {},
  }),
}))

vi.mock('../../knowledge/context-knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../knowledge/context-knowledge')>()
  return {
    ...actual,
    getContextKnowledgeService: () => ck,
  }
})

import { Agent } from '../agent'
import { ContextKnowledgeService } from '../../knowledge/context-knowledge'
import { SshService } from '../../ssh.service'
import { PtyService } from '../../pty.service'
import { UnifiedTerminalService } from '../../unified-terminal.service'

class LiveMemoryAgent extends Agent {
  lastSystemPrompt = ''
  protected getAgentId(): string {
    return 'live-memory'
  }
  getAvailableTools(): ToolDefinition[] {
    return [ptyExecuteCommandTool]
  }
  protected buildSystemPrompt(_context: AgentContext, options: PromptOptions): string {
    this.lastSystemPrompt = `# 已知信息\n\n${options.contextKnowledgeDoc || ''}`
    return this.lastSystemPrompt
  }
}

function knowledgeReply(messages: Array<{ role?: string; content?: unknown }>, allowLocal = false): string {
  const prompt = String(messages[0]?.content || '')
  if (prompt.includes(EXPECTED_HOST_ID)) return `## ${EXPECTED_HOST_ID}\n探针 ${TOKEN_REMOTE}\n主机名 ubuntu20045\n`
  if (prompt.includes('本机这条连接') || prompt.includes('本地主机')) {
    return allowLocal ? `## 本机\n探针 ${TOKEN_LOCAL}\n` : '## 本机\n不该出现\n'
  }
  if (prompt.includes('个人')) return '## 个人\n用户在测 230\n'
  return 'NO_CHANGE'
}

function docsOnDisk(): Record<string, string> {
  const dir = path.join(tmpDir, 'knowledge', 'context-docs')
  if (!fs.existsSync(dir)) return {}
  const out: Record<string, string> = {}
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    out[file.replace(/\.md$/, '')] = fs.readFileSync(path.join(dir, file), 'utf-8')
  }
  return out
}

async function waitForDocs(pred: (docs: Record<string, string>) => boolean, timeoutMs = 8000) {
  const start = Date.now()
  let last = docsOnDisk()
  while (Date.now() - start < timeoutMs) {
    last = docsOnDisk()
    if (pred(last)) return last
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`真机记忆未落到预期: ${JSON.stringify(last)}`)
}

function makeServices(
  ssh: SshService,
  unified: UnifiedTerminalService,
  firstToolCalls: Array<{ id: string; command: string; pane_id: string }>,
  allowLocal = false,
): AgentServices {
  let turn = 0
  return {
    aiService: {
      chat: vi.fn(async (messages: Array<{ role?: string; content?: unknown }>) => knowledgeReply(messages, allowLocal)),
      chatWithToolsStream: vi.fn(async (
        _messages: unknown[],
        _tools: unknown,
        onChunk: (s: string) => void,
        _onToolCall: unknown,
        onDone: (r: unknown) => void,
      ) => {
        if (turn++ === 0) {
          onDone({
            content: '',
            tool_calls: firstToolCalls.map(c => ({
              id: c.id,
              type: 'function',
              function: {
                name: 'execute_command',
                arguments: JSON.stringify({ command: c.command, pane_id: c.pane_id }),
              },
            })),
          })
          return
        }
        onChunk('探针打完了')
        onDone({ content: '探针打完了' })
      }),
      abort: vi.fn(),
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
    } as any,
    unifiedTerminalService: unified,
    sshService: ssh,
  }
}

describe.skipIf(!hostReachable)('真机 192.168.230.130 主机记忆', () => {
  let ssh: SshService
  let pty: PtyService
  let unified: UnifiedTerminalService

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-host-mem-live-'))
    ck = new ContextKnowledgeService()
    if (!sshKeyPath) throw new Error('本机没有 SSH 私钥，无法免密连 230')

    ssh = new SshService()
    pty = new PtyService()
    unified = new UnifiedTerminalService(pty, ssh)
    sshId = await ssh.connect({
      host: HOST,
      port: 22,
      username: USER,
      privateKeyPath: sshKeyPath,
    })
    localPtyId = pty.create().id
  }, 20_000)

  afterAll(() => {
    if (localPtyId) pty.dispose(localPtyId)
    if (sshId) ssh.disconnect(sshId)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('能在这台上跑命令，并认出 yushen@192.168.230.130', async () => {
    const result = await unified.executeInTerminal(sshId, `echo ${TOKEN_REMOTE}; hostname`, 15_000)
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.output).toContain(TOKEN_REMOTE)
    expect(result.output).toContain('ubuntu20045')
    expect(resolveHostIdForPty(sshId, {
      getTerminalType: id => unified.getTerminalType(id),
      getSshConfig: id => ssh.getConfig(id),
    })).toBe(EXPECTED_HOST_ID)
  })

  it('助手对这台动手后，记忆写到这台，不写本机', async () => {
    const agent = new LiveMemoryAgent(makeServices(ssh, unified, [
      { id: 'live-exec', command: `echo ${TOKEN_REMOTE}`, pane_id: sshId },
    ]))
    agent.updateConfig({ executionMode: 'free' })
    await agent.run('在 230 上打一条探针，不要动别的机器', {
      ptyId: sshId,
      terminalOutput: [],
      systemInfo: { os: 'linux', shell: '/bin/bash' },
      terminalType: 'assistant',
      hostId: 'local',
    })

    const docs = await waitForDocs(d => Boolean(d[EXPECTED_HOST_ID]))
    expect(docs[EXPECTED_HOST_ID]).toContain(TOKEN_REMOTE)
    expect(docs[EXPECTED_HOST_ID]).toContain('ubuntu20045')
    expect(docs.local).toBeUndefined()
    expect(docs.personal).toBeTruthy()
  }, 60_000)

  it('一场里对本机和 230 都动手：各记各的', async () => {
    const docsDir = path.join(tmpDir, 'knowledge', 'context-docs')
    if (fs.existsSync(docsDir)) fs.rmSync(docsDir, { recursive: true, force: true })
    ck = new ContextKnowledgeService()

    const agent = new LiveMemoryAgent(makeServices(ssh, unified, [
      { id: 'live-remote', command: `echo ${TOKEN_REMOTE}`, pane_id: sshId },
      { id: 'live-local', command: `echo ${TOKEN_LOCAL}`, pane_id: localPtyId },
    ], true))
    agent.updateConfig({ executionMode: 'free' })
    await agent.run('本机和 230 各打一条探针', {
      ptyId: sshId,
      terminalOutput: [],
      systemInfo: { os: 'darwin', shell: '/bin/zsh' },
      terminalType: 'assistant',
      hostId: 'local',
      panes: [
        { paneId: 'p-ssh', ptyId: sshId, label: '230', isActive: true, terminalOutput: [], terminalType: 'ssh' },
        { paneId: 'p-local', ptyId: localPtyId, label: '本机', isActive: false, terminalOutput: [], terminalType: 'local' },
      ],
    })

    const docs = await waitForDocs(d => Boolean(d[EXPECTED_HOST_ID]) && Boolean(d.local) && Boolean(d.personal))
    expect(docs[EXPECTED_HOST_ID]).toContain(TOKEN_REMOTE)
    expect(docs[EXPECTED_HOST_ID]).not.toContain(TOKEN_LOCAL)
    expect(docs.local).toContain(TOKEN_LOCAL)
    expect(docs.local).not.toContain(TOKEN_REMOTE)
    expect(docs.personal).toBeTruthy()
  }, 60_000)
})
