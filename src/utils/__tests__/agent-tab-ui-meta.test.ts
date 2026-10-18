import { describe, expect, it } from 'vitest'
import {
  deriveTabAgentUiMeta,
  formatAgentAttentionTooltip,
  formatHistoryConversationTooltip,
  hasHubTasksAreaAttention,
  isAssistantConversationSurfaceVisible,
} from '../agent-tab-ui-meta'

const COMPANION = '__companion__'

const t = (key: string) => key

describe('deriveTabAgentUiMeta', () => {
  it('returns open when agentState is undefined', () => {
    const meta = deriveTabAgentUiMeta(undefined)
    expect(meta).toEqual({
      status: 'open',
      pendingConfirm: false,
      agentCompletedUnseen: false,
      needsAttention: false,
      isRunning: false,
    })
  })

  it('returns open when idle', () => {
    const meta = deriveTabAgentUiMeta({ isRunning: false })
    expect(meta.status).toBe('open')
    expect(meta.needsAttention).toBe(false)
  })

  it('returns running when busy without attention flags', () => {
    const meta = deriveTabAgentUiMeta({ isRunning: true })
    expect(meta.status).toBe('running')
    expect(meta.needsAttention).toBe(false)
  })

  it('returns attention when pending confirm even if running', () => {
    const meta = deriveTabAgentUiMeta({
      isRunning: true,
      pendingConfirm: { agentId: 'agent-1', toolCallId: 'x', toolName: 'exec', toolArgs: {}, riskLevel: 'dangerous' },
    })
    expect(meta.status).toBe('attention')
    expect(meta.needsAttention).toBe(true)
    expect(meta.pendingConfirm).toBe(true)
  })

  it('returns attention when task completed unseen', () => {
    const meta = deriveTabAgentUiMeta({ isRunning: false, agentCompletedUnseen: true })
    expect(meta.status).toBe('attention')
    expect(meta.agentCompletedUnseen).toBe(true)
  })
})

describe('formatAgentAttentionTooltip', () => {
  it('returns undefined when no attention needed', () => {
    expect(formatAgentAttentionTooltip({ pendingConfirm: false, agentCompletedUnseen: false, needsAttention: false }, t)).toBeUndefined()
  })

  it('returns confirm key when pending confirm', () => {
    expect(formatAgentAttentionTooltip({ pendingConfirm: true, agentCompletedUnseen: false, needsAttention: true }, t)).toBe('tabs.needsAttentionConfirm')
  })
})

describe('formatHistoryConversationTooltip', () => {
  it('returns running label for running status', () => {
    expect(formatHistoryConversationTooltip({ status: 'running', pendingConfirm: false, agentCompletedUnseen: false }, t))
      .toBe('welcome.conversations.agentRunning')
  })
})

describe('isAssistantConversationSurfaceVisible', () => {
  it('returns true for active TabBar tab', () => {
    expect(isAssistantConversationSurfaceVisible('tab-a', {
      activeTabId: 'tab-a',
      hubFocusedAssistantTabId: 'tab-b',
    })).toBe(true)
  })

  it('returns true for hub focus only when in task area', () => {
    expect(isAssistantConversationSurfaceVisible('hub-tab', {
      activeTabId: '',
      hubFocusedAssistantTabId: 'hub-tab',
    })).toBe(true)
    expect(isAssistantConversationSurfaceVisible('hub-tab', {
      activeTabId: 'companion-tab',
      hubFocusedAssistantTabId: 'hub-tab',
    })).toBe(false)
    expect(isAssistantConversationSurfaceVisible('hub-tab', {
      activeTabId: '',
      hubFocusedAssistantTabId: 'hub-tab',
      secretaryPanel: 'todos',
    })).toBe(false)
    // 记忆栏目与待办、联系人一样占主区，会话不在眼前
    expect(isAssistantConversationSurfaceVisible('hub-tab', {
      activeTabId: '',
      hubFocusedAssistantTabId: 'hub-tab',
      secretaryPanel: 'memory',
    })).toBe(false)
  })

  // 空终端页与任务区一样没有活跃 tab，靠这个标志才分得开
  it('returns false on the empty terminal place', () => {
    expect(isAssistantConversationSurfaceVisible('hub-tab', {
      activeTabId: '',
      hubFocusedAssistantTabId: 'hub-tab',
      terminalPlaceActive: true,
    })).toBe(false)
  })

  it('returns false when neither active nor visible hub focus', () => {
    expect(isAssistantConversationSurfaceVisible('hub-tab', {
      activeTabId: 'ssh-tab',
      hubFocusedAssistantTabId: 'other-hub',
    })).toBe(false)
  })
})

describe('hasHubTasksAreaAttention', () => {
  const hubTab = {
    type: 'assistant',
    agentId: 'tab-1',
    agentState: { agentCompletedUnseen: true },
  }

  it('returns false when user is already in task area', () => {
    expect(hasHubTasksAreaAttention([hubTab], '', COMPANION)).toBe(false)
  })

  it('returns true when hub session needs attention and user is on another tab', () => {
    expect(hasHubTasksAreaAttention([hubTab], 'ssh-tab', COMPANION)).toBe(true)
  })

  it('returns true when hub session needs attention and user is on todos', () => {
    expect(hasHubTasksAreaAttention([hubTab], '', COMPANION, true)).toBe(true)
  })

  it('ignores promoted assistant tabs (they have their own TabBar attention)', () => {
    expect(
      hasHubTasksAreaAttention(
        [{ ...hubTab, isPromoted: true }],
        'ssh-tab',
        COMPANION
      )
    ).toBe(false)
  })

  it('ignores companion tab', () => {
    expect(
      hasHubTasksAreaAttention(
        [{ type: 'assistant', agentId: COMPANION, agentState: { agentCompletedUnseen: true } }],
        'ssh-tab',
        COMPANION
      )
    ).toBe(false)
  })
})
