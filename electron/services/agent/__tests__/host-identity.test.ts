import { describe, it, expect } from 'vitest'
import {
  hostIdFromConnection,
  resolveHostIdForPty,
  resolveKnowledgeUpdateTargets,
  sessionKnowledgeHostId,
  hostIdForKnowledgeRecord,
  composeKnowledgeDocuments,
  collectOpenPaneHostIds,
  notePaneHostOperationIfNeeded,
} from '../tools/host-identity'
import type { ToolExecutorConfig } from '../tools/types'
import { ptyExecuteCommandTool, terminalOnlyTools } from '../skills/terminal/tools'
import type { ToolDefinitionWithMeta } from '../tools'

describe('hostIdFromConnection', () => {
  it('本机就是 local', () => {
    expect(hostIdFromConnection('local')).toBe('local')
  })

  it('远程用 user@host', () => {
    expect(hostIdFromConnection('ssh', { username: 'root', host: '10.0.0.1' })).toBe('root@10.0.0.1')
  })

  it('认不出类型就不给身份', () => {
    expect(hostIdFromConnection(null)).toBeUndefined()
    expect(hostIdFromConnection(undefined)).toBeUndefined()
  })
})

describe('resolveHostIdForPty', () => {
  it('按窗格当前连接取身份', () => {
    const deps = {
      getTerminalType: (id: string) => (id === 'pty-ssh' ? 'ssh' as const : id === 'pty-local' ? 'local' as const : null),
      getSshConfig: (id: string) => id === 'pty-ssh' ? { username: 'ubuntu', host: 'box.example' } : null,
    }
    expect(resolveHostIdForPty('pty-local', deps)).toBe('local')
    expect(resolveHostIdForPty('pty-ssh', deps)).toBe('ubuntu@box.example')
    expect(resolveHostIdForPty('missing', deps)).toBeUndefined()
    expect(resolveHostIdForPty(undefined, deps)).toBeUndefined()
  })
})

describe('resolveKnowledgeUpdateTargets', () => {
  it('助手只聊天：只写个人', () => {
    expect(resolveKnowledgeUpdateTargets({
      terminalType: 'assistant',
      sessionHostId: 'personal',
      operatedHostIds: [],
    })).toEqual({ personal: true, hostIds: [] })
  })

  it('助手动过 A 和 B：个人 + 各台', () => {
    expect(resolveKnowledgeUpdateTargets({
      terminalType: 'assistant',
      sessionHostId: 'personal',
      operatedHostIds: ['root@a', 'ubuntu@b', 'root@a'],
    })).toEqual({ personal: true, hostIds: ['root@a', 'ubuntu@b'] })
  })

  it('助手开了本机窗并动手：个人 + local', () => {
    expect(resolveKnowledgeUpdateTargets({
      terminalType: 'assistant',
      sessionHostId: 'personal',
      operatedHostIds: ['local'],
    })).toEqual({ personal: true, hostIds: ['local'] })
  })

  it('远程终端页：写自己那台；分屏另动手过的也写', () => {
    expect(resolveKnowledgeUpdateTargets({
      terminalType: 'ssh',
      sessionHostId: 'root@prod',
      operatedHostIds: ['root@staging'],
    })).toEqual({ personal: false, hostIds: ['root@prod', 'root@staging'] })
  })

  it('本机终端页没另动手：只写 local', () => {
    expect(resolveKnowledgeUpdateTargets({
      terminalType: 'local',
      sessionHostId: 'local',
      operatedHostIds: [],
    })).toEqual({ personal: false, hostIds: ['local'] })
  })
})

describe('sessionKnowledgeHostId', () => {
  it('助手永远是个人，哪怕前端误传了本机', () => {
    expect(sessionKnowledgeHostId({ terminalType: 'assistant', hostId: 'local' })).toBe('personal')
    expect(sessionKnowledgeHostId({ terminalType: 'assistant' })).toBe('personal')
  })

  it('终端页沿用这场绑的那台', () => {
    expect(sessionKnowledgeHostId({ terminalType: 'ssh', hostId: 'root@prod' })).toBe('root@prod')
    expect(sessionKnowledgeHostId({ terminalType: 'local', hostId: 'local' })).toBe('local')
  })
})

describe('hostIdForKnowledgeRecord', () => {
  it('动手过的记到那台；没动手的助手记个人、终端页记自己', () => {
    expect(hostIdForKnowledgeRecord({
      mappedHostId: 'root@a',
      sessionHostId: 'personal',
      terminalType: 'assistant',
    })).toBe('root@a')
    expect(hostIdForKnowledgeRecord({
      sessionHostId: 'personal',
      terminalType: 'assistant',
    })).toBe('personal')
    expect(hostIdForKnowledgeRecord({
      sessionHostId: 'root@prod',
      terminalType: 'ssh',
    })).toBe('root@prod')
  })
})

describe('composeKnowledgeDocuments', () => {
  it('只有一份就不加标题', () => {
    expect(composeKnowledgeDocuments([{ contextId: 'personal', content: '喜欢简洁' }])).toBe('喜欢简洁')
  })

  it('多份各标各的', () => {
    const text = composeKnowledgeDocuments([
      { contextId: 'personal', content: '喜欢简洁' },
      { contextId: 'root@a', content: 'nginx 在 8080' },
    ])
    expect(text).toContain('### 个人')
    expect(text).toContain('喜欢简洁')
    expect(text).toContain('### 主机 root@a')
    expect(text).toContain('nginx 在 8080')
  })

  it('空文档不注入', () => {
    expect(composeKnowledgeDocuments([{ contextId: 'personal', content: '   ' }])).toBe('')
  })
})

describe('collectOpenPaneHostIds', () => {
  it('从已开着的窗解析身份，去重', () => {
    const deps = {
      getTerminalType: (id: string) => id.startsWith('ssh') ? 'ssh' as const : id.startsWith('local') ? 'local' as const : null,
      getSshConfig: (id: string) => id === 'ssh-a' ? { username: 'root', host: 'a' } : id === 'ssh-b' ? { username: 'root', host: 'b' } : null,
    }
    expect(collectOpenPaneHostIds(['local-1', 'ssh-a', 'ssh-a', undefined, 'gone'], deps))
      .toEqual(['local', 'root@a'])
  })
})

describe('notePaneHostOperationIfNeeded', () => {
  function makeExecutor(noted: Array<{ hostId: string; toolCallId?: string }>): ToolExecutorConfig {
    return {
      terminalService: {
        getTerminalType: (id: string) => id === 'pty-ssh' ? 'ssh' : id === 'pty-local' ? 'local' : null,
      } as ToolExecutorConfig['terminalService'],
      getSshConfig: (id: string) => id === 'pty-ssh' ? { username: 'ubuntu', host: 'box' } : null,
      getToolCatalog: () => [
        { type: 'function', function: { name: 'hands_on', parameters: { type: 'object', properties: {} } }, _meta: { hostScope: 'pane' } },
        { type: 'function', function: { name: 'just_look', parameters: { type: 'object', properties: {} } } },
      ],
      noteHostOperation: (hostId: string, meta?: { toolCallId?: string }) => noted.push({ hostId, toolCallId: meta?.toolCallId }),
    } as unknown as ToolExecutorConfig
  }

  it('声明了对窗动手才记账', () => {
    const noted: Array<{ hostId: string; toolCallId?: string }> = []
    const executor = makeExecutor(noted)
    notePaneHostOperationIfNeeded('hands_on', {}, 'pty-ssh', executor, 'call-1')
    notePaneHostOperationIfNeeded('just_look', {}, 'pty-ssh', executor, 'call-2')
    expect(noted).toEqual([{ hostId: 'ubuntu@box', toolCallId: 'call-1' }])
  })

  it('认不出窗就不记', () => {
    const noted: Array<{ hostId: string; toolCallId?: string }> = []
    notePaneHostOperationIfNeeded('hands_on', {}, undefined, makeExecutor(noted), 'call-1')
    expect(noted).toEqual([])
  })

  it('没默认窗但指定了窗格，也能认', () => {
    const noted: Array<{ hostId: string; toolCallId?: string }> = []
    notePaneHostOperationIfNeeded('hands_on', { pane_id: 'pty-local' }, undefined, makeExecutor(noted), 'call-3')
    expect(noted).toEqual([{ hostId: 'local', toolCallId: 'call-3' }])
  })
})

describe('动手工具声明', () => {
  it('会对看得见的窗干活的工具标了 hostScope', () => {
    expect(ptyExecuteCommandTool._meta?.hostScope).toBe('pane')
    const byName = Object.fromEntries(
      terminalOnlyTools.map(t => [t.function.name, (t as ToolDefinitionWithMeta)._meta])
    )
    expect(byName.send_input?.hostScope).toBe('pane')
    expect(byName.send_control_key?.hostScope).toBe('pane')
    expect(byName.get_terminal_context?.hostScope).toBeUndefined()
    expect(byName.check_terminal_status?.hostScope).toBeUndefined()
  })
})
