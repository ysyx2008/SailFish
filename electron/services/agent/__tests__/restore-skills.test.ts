/**
 * 重开对话时把当时加载的技能再装回来。
 * 只覆盖「新对话记下清单 → 再打开按清单装」；老记录没有字段则不动。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

vi.mock('../../user-skill.service', () => {
  const skills: Record<string, { id: string; name: string; enabled: boolean; content: string; description?: string }> = {
    'my-skill': { id: 'my-skill', name: '我的技能', enabled: true, description: '自定义技能简介', content: '自定义技能正文' }
  }
  return {
    USER_SKILL_ID_PREFIX: 'user:',
    toUserSkillId: (id: string) => id.startsWith('user:') ? id : `user:${id}`,
    parseUserSkillId: (id: string) => {
      if (!id.startsWith('user:')) return null
      return id.slice(5) || null
    },
    getUserSkillService: () => ({
      getSkill: (id: string) => skills[id],
      getSkillContent: (id: string) => skills[id]?.content ?? null
    })
  }
})

import { Agent } from '../agent'
import { ConversationManager, ConversationStore } from '../../conversation'
import { configSkill } from '../skills/config'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext, AgentServices } from '../types'

class TestAgent extends Agent {
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(): string {
    return 'test'
  }
  protected getAgentId(): string {
    return 'test-agent'
  }
  exposeLoadedSkills() {
    return this.getSkillSession().getLoadedSkills()
  }
  exposeSkillSession() {
    return this.getSkillSession()
  }
  exposeMcpServers() {
    return this.getMcpToolSession().getLoadedServerIds()
  }
  exposeVisibleSkills() {
    return this.listVisibleSkills()
  }
  exposeLoadedSkillsRoster() {
    return this.getLoadedSkillsRoster()
  }
}

function createServices(overrides?: Partial<AgentServices>): AgentServices {
  const historyService = overrides?.historyService ?? {
    getAgentRecordById: vi.fn(),
    saveAgentRecord: vi.fn(),
    getAgentRecordStore: vi.fn(function (this: { getAgentRecordById: unknown }) {
      return this
    })
  }
  const services: AgentServices = {
    aiService: {
      chatWithToolsStream: vi.fn(
        (_m: unknown, _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
          onChunk('好')
          onDone({ content: '好', tool_calls: undefined })
          return Promise.resolve()
        }
      ),
      abort: vi.fn()
    } as never,
    ptyService: { onData: vi.fn().mockReturnValue(() => {}), write: vi.fn() } as never,
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
      getMcpServers: vi.fn().mockReturnValue([])
    } as never,
    ...overrides,
    historyService: historyService as never
  }
  if (!services.conversationManager) {
    services.conversationManager = new ConversationManager(
      new ConversationStore((services.historyService as unknown as { getAgentRecordStore: () => never }).getAgentRecordStore())
    )
  }
  return services
}

function ctx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    ptyId: 'test-pty',
    terminalOutput: [],
    systemInfo: { os: 'darwin', shell: '/bin/zsh' },
    terminalType: 'assistant',
    ...overrides
  }
}

const priorRecord = (id: string, extra?: Record<string, unknown>) => ({
  id,
  timestamp: Date.now() - 5000,
  terminalId: '',
  terminalType: 'assistant' as const,
  userTask: '上次的任务',
  steps: [
    { id: 'ut1', type: 'user_task', content: '上次的任务', timestamp: Date.now() - 5000 },
    { id: 'fr1', type: 'final_result', content: '上次的结果', timestamp: Date.now() - 4000 }
  ],
  messages: [
    { role: 'user', content: '上次的任务' },
    { role: 'assistant', content: '上次的结果' }
  ],
  duration: 1000,
  status: 'completed' as const,
  ...extra
})

describe('重开对话恢复技能', () => {
  it('新对话加载过技能后，检查点会记下清单', async () => {
    const saved: Array<{ loadedSkills?: string[] }> = []
    const historyService = {
      getAgentRecordById: vi.fn(),
      saveAgentRecord: vi.fn((record: { loadedSkills?: string[] }) => { saved.push(record) }),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const services = createServices({ historyService: historyService as never })
    const agent = new TestAgent(services)
    await agent.preloadSkills([configSkill.id])
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)

    await agent.run('继续', ctx({ sessionId: 'sess_new' }))

    const withSkills = saved.filter(r => r.loadedSkills?.includes(configSkill.id))
    expect(withSkills.length).toBeGreaterThan(0)
  })

  it('重开带清单的对话时，在组上下文之前把技能装回来', async () => {
    const sessionId = 'sess_restore_skills'
    const box: { agent?: TestAgent } = {}
    const chatWithToolsStream = vi.fn(
      (_m: unknown, _t: unknown, onChunk: (s: string) => void, _otc: unknown, onDone: (r: unknown) => void) => {
        expect(box.agent!.exposeLoadedSkills()).toContain(configSkill.id)
        expect(box.agent!.exposeMcpServers()).toContain('qcc')
        onChunk('好')
        onDone({ content: '好', tool_calls: undefined })
        return Promise.resolve()
      }
    )
    const ensureConnected = vi.fn().mockResolvedValue(undefined)
    const mcpService = {
      findConfiguredServer: vi.fn().mockReturnValue({ id: 'qcc', name: '企查查', enabled: true }),
      resolveServerRef: vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValue({ serverId: 'qcc', name: '企查查', toolCount: 3 }),
      ensureConnected
    }
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: [configSkill.id, 'mcp:qcc']
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const services = createServices({
      historyService: historyService as never,
      aiService: { chatWithToolsStream, abort: vi.fn() } as never,
      mcpService: mcpService as never,
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
        getMcpServers: vi.fn().mockReturnValue([{ id: 'qcc', name: '企查查', enabled: true }])
      } as never
    })
    const agent = new TestAgent(services)
    box.agent = agent

    await agent.run('接着写', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))

    expect(ensureConnected).toHaveBeenCalled()
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)
    expect(agent.exposeMcpServers()).toContain('qcc')
    expect(chatWithToolsStream).toHaveBeenCalled()
  })

  it('老记录没有清单则不强行装技能', async () => {
    const sessionId = 'sess_legacy'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId)),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const services = createServices({ historyService: historyService as never })
    const agent = new TestAgent(services)

    await agent.run('新问题', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))

    expect(agent.exposeLoadedSkills()).toEqual([])
  })

  it('装不上的技能仍挂在清单里，标成现在没有了', () => {
    const agent = new TestAgent(createServices({
      configService: {
        get: vi.fn((key: string) => key === 'disabledBuiltinSkills' ? [configSkill.id] : undefined),
        getAgentMbti: vi.fn().mockReturnValue(null),
        getAiRules: vi.fn().mockReturnValue(''),
        getAgentPersonalityText: vi.fn().mockReturnValue(''),
        getAgentName: vi.fn().mockReturnValue(''),
        getLanguage: vi.fn().mockReturnValue('zh-CN'),
        getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
        getActiveAiProfile: vi.fn().mockReturnValue('test'),
        getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
        hasVisionCapability: vi.fn().mockReturnValue(true),
        getMcpServers: vi.fn().mockReturnValue([])
      } as never
    }))
    agent.hydrateSkills(['not-a-real-skill', configSkill.id, 'user:gone'])
    const visible = agent.exposeVisibleSkills()
    expect(visible.find(s => s.id === 'not-a-real-skill')).toMatchObject({ unavailable: true })
    expect(visible.find(s => s.id === configSkill.id)).toMatchObject({ unavailable: true })
    expect(visible.find(s => s.id === 'user:gone')).toMatchObject({ unavailable: true })
  })

  it('清单里的技能已经不存在或被关掉，跳过，对话照常打开', async () => {
    const sessionId = 'sess_missing'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: ['not-a-real-skill', configSkill.id]
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const configService = {
      get: vi.fn((key: string) => key === 'disabledBuiltinSkills' ? [configSkill.id] : undefined),
      getAgentMbti: vi.fn().mockReturnValue(null),
      getAiRules: vi.fn().mockReturnValue(''),
      getAgentPersonalityText: vi.fn().mockReturnValue(''),
      getAgentName: vi.fn().mockReturnValue(''),
      getLanguage: vi.fn().mockReturnValue('zh-CN'),
      getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
      getActiveAiProfile: vi.fn().mockReturnValue('test'),
      getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
      hasVisionCapability: vi.fn().mockReturnValue(true),
      getMcpServers: vi.fn().mockReturnValue([])
    }
    const services = createServices({
      historyService: historyService as never,
      configService: configService as never
    })
    const agent = new TestAgent(services)

    await expect(agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))).resolves.toBeTruthy()
    expect(agent.exposeLoadedSkills()).toEqual([])
    expect(agent.exposeVisibleSkills().filter(s => s.unavailable).map(s => s.id).sort()).toEqual(
      ['not-a-real-skill', configSkill.id].sort()
    )
  })

  it('关切会话不按历史清单恢复技能', async () => {
    const sessionId = 'sess_watch'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        kind: 'watch',
        agentKey: '__watch__:abc',
        loadedSkills: [configSkill.id]
      })),
      saveAgentRecord: vi.fn(),
      getRecentAgentRecords: vi.fn().mockReturnValue([]),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const services = createServices({ historyService: historyService as never })
    const agent = new TestAgent(services)
    agent.setAgentId('__watch__:abc')

    await agent.run('心跳', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))

    expect(agent.exposeLoadedSkills()).toEqual([])
  })

  it('已删除或关掉的外部工具包跳过，不留空名', async () => {
    const sessionId = 'sess_mcp_gone'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: ['mcp:gone', 'mcp:off']
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const mcpService = {
      findConfiguredServer: vi.fn((id: string) =>
        id.includes('off') ? { id: 'off', name: '已关', enabled: false } : null
      ),
      resolveServerRef: vi.fn().mockReturnValue(null),
      ensureConnected: vi.fn()
    }
    const services = createServices({
      historyService: historyService as never,
      mcpService: mcpService as never
    })
    const agent = new TestAgent(services)

    await agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))

    expect(agent.exposeMcpServers()).toEqual([])
    expect(mcpService.ensureConnected).not.toHaveBeenCalled()
  })

  it('点新对话后，上一场技能不写进新记录', async () => {
    const saved: Array<{ loadedSkills?: string[] }> = []
    const historyService = {
      getAgentRecordById: vi.fn(),
      saveAgentRecord: vi.fn((record: { loadedSkills?: string[] }) => { saved.push(record) }),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const services = createServices({ historyService: historyService as never })
    const agent = new TestAgent(services)
    await agent.preloadSkills([configSkill.id])
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)

    agent.resetSession()
    await agent.run('全新开始', ctx())

    expect(agent.exposeLoadedSkills()).toEqual([])
    expect(saved.some(r => r.loadedSkills?.includes(configSkill.id))).toBe(false)
  })

  it('秘书 load_skill 新装上的内置技能排在末尾', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('excel')
    await agent.exposeSkillSession().loadSkill('calendar')
    agent.markBuiltinSkillLoaded('calendar')
    expect(agent.exposeVisibleSkills().map(s => s.id)).toEqual(['excel', 'calendar'])
  })

  it('用户 @ 装上的技能排在可见清单末尾', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('excel')
    await agent.pinSkill('calendar')
    expect(agent.exposeVisibleSkills().map(s => s.id)).toEqual(['excel', 'calendar'])

    await agent.exposeSkillSession().loadSkill('config')
    await agent.pinSkill('config')
    expect(agent.exposeVisibleSkills().map(s => s.id)).toEqual(['excel', 'calendar', 'config'])
  })

  it('用户 @ 再次选中的技能移到末尾', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('excel')
    await agent.pinSkill('calendar')
    await agent.pinSkill('excel')
    expect(agent.exposeVisibleSkills().map(s => s.id)).toEqual(['calendar', 'excel'])
  })

  it('用户点上的技能立刻出现在可见清单里', async () => {
    const agent = new TestAgent(createServices())
    const result = await agent.pinSkill(configSkill.id)
    expect(result.ok).toBe(true)
    expect(agent.exposeVisibleSkills().some(s => s.id === configSkill.id)).toBe(true)
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)
  })

  it('用户卸掉后，预加载不会再装回来', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill(configSkill.id)
    await agent.unpinSkill(configSkill.id)
    expect(agent.exposeVisibleSkills()).toEqual([])
    expect(agent.exposeLoadedSkills()).not.toContain(configSkill.id)
    expect(agent.isSkillDismissed(configSkill.id)).toBe(true)

    await agent.preloadSkills([configSkill.id])
    expect(agent.exposeLoadedSkills()).not.toContain(configSkill.id)
  })

  it('秘书 load_skill 可以装回用户卸掉的内置技能', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill(configSkill.id)
    await agent.unpinSkill(configSkill.id)
    expect(agent.isSkillDismissed(configSkill.id)).toBe(true)

    const result = await agent.exposeSkillSession().loadSkill(configSkill.id)
    expect(result.success).toBe(true)
    agent.markBuiltinSkillLoaded(configSkill.id)

    expect(agent.isSkillDismissed(configSkill.id)).toBe(false)
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)
    expect(agent.exposeVisibleSkills().some(s => s.id === configSkill.id)).toBe(true)
  })

  it('秘书再装上可以装回用户卸掉的用户技能', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('user:my-skill')
    await agent.unpinSkill('user:my-skill')
    expect(agent.isSkillDismissed('user:my-skill')).toBe(true)

    agent.markUserSkillLoaded('my-skill')

    expect(agent.isSkillDismissed('user:my-skill')).toBe(false)
    expect(agent.exposeVisibleSkills().some(s => s.id === 'user:my-skill')).toBe(true)
  })

  it('秘书卸掉用户技能后这场不再开着，也不算用户点掉', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('user:my-skill')
    agent.markSkillUnloaded('user:my-skill')
    expect(agent.exposeVisibleSkills()).toEqual([])
    expect(agent.isUserSkillLoaded('user:my-skill')).toBe(false)
    expect(agent.isSkillDismissed('user:my-skill')).toBe(false)
  })

  it('秘书卸掉后自己再装上可以', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('user:my-skill')
    agent.markSkillUnloaded('user:my-skill')
    agent.markUserSkillLoaded('my-skill')
    expect(agent.exposeVisibleSkills().some(s => s.id === 'user:my-skill')).toBe(true)
    expect(agent.isSkillDismissed('user:my-skill')).toBe(false)
  })

  it('秘书卸掉用户技能后，重开也不会再装回来', async () => {
    const sessionId = 'sess_secretary_unload_user'
    const saved: { latest: { loadedSkills?: string[] } | null } = { latest: null }
    const historyService = {
      getAgentRecordById: vi.fn().mockImplementation(() => saved.latest),
      saveAgentRecord: vi.fn((record: { loadedSkills?: string[] }) => { saved.latest = record }),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const agent = new TestAgent(createServices({ historyService: historyService as never }))
    await agent.run('先开一场', ctx({ sessionId }))
    await agent.pinSkill('user:my-skill')
    expect(saved.latest?.loadedSkills).toEqual(expect.arrayContaining(['user:my-skill']))

    agent.markSkillUnloaded('user:my-skill')
    expect(saved.latest?.loadedSkills ?? []).not.toContain('user:my-skill')

    const agent2 = new TestAgent(createServices({
      historyService: {
        getAgentRecordById: vi.fn().mockReturnValue(saved.latest),
        saveAgentRecord: vi.fn(),
        getAgentRecordStore: vi.fn(function (this: unknown) { return this })
      } as never
    }))
    await agent2.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))
    expect(agent2.exposeVisibleSkills().some(s => s.id === 'user:my-skill')).toBe(false)
  })

  it('重开后开口前点上的技能，不会被历史清单盖掉', async () => {
    const sessionId = 'sess_pin_before_run'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: []
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const agent = new TestAgent(createServices({ historyService: historyService as never }))
    agent.hydrateSkills([], [])
    await agent.pinSkill(configSkill.id)
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)

    await agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))
    expect(agent.exposeLoadedSkills()).toContain(configSkill.id)
  })

  it('重开后开口前卸掉的技能，开口时不会再装回来', async () => {
    const sessionId = 'sess_unpin_before_run'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: [configSkill.id]
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const agent = new TestAgent(createServices({ historyService: historyService as never }))
    agent.hydrateSkills([configSkill.id], [])
    await agent.unpinSkill(configSkill.id)

    await agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))
    expect(agent.exposeLoadedSkills()).not.toContain(configSkill.id)
    expect(agent.isSkillDismissed(configSkill.id)).toBe(true)
  })

  it('重开对话时自己写的技能会再装上', async () => {
    const sessionId = 'sess_user_skill_restore'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: ['user:my-skill']
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const agent = new TestAgent(createServices({ historyService: historyService as never }))
    await agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))
    expect(agent.exposeVisibleSkills().some(s => s.id === 'user:my-skill' && s.name === '我的技能')).toBe(true)
    expect(agent.exposeLoadedSkillsRoster()).toEqual(
      expect.arrayContaining([{ id: 'user:my-skill', name: '我的技能' }])
    )
  })

  it('用裸 id 点掉自己写的技能后，可见清单和秘书看到的都空了', async () => {
    const agent = new TestAgent(createServices())
    await agent.pinSkill('user:my-skill')
    expect(agent.exposeLoadedSkillsRoster()).toEqual(
      expect.arrayContaining([{ id: 'user:my-skill', name: '我的技能' }])
    )

    await agent.unpinSkill('my-skill')
    expect(agent.exposeVisibleSkills()).toEqual([])
    expect(agent.exposeLoadedSkillsRoster()).toEqual([])
    expect(agent.isSkillDismissed('user:my-skill')).toBe(true)
    expect(agent.isSkillDismissed('my-skill')).toBe(true)
  })

  it('用户点上自己写的技能会出现在可见清单里', async () => {
    const agent = new TestAgent(createServices())
    const result = await agent.pinSkill('user:my-skill')
    expect(result.ok).toBe(true)
    expect(agent.exposeVisibleSkills().some(s => s.id === 'user:my-skill' && s.name === '我的技能' && s.description === '自定义技能简介')).toBe(true)
    expect(agent.exposeLoadedSkillsRoster()).toEqual(
      expect.arrayContaining([{ id: 'user:my-skill', name: '我的技能' }])
    )
  })

  it('卸掉自己写的技能后，重开也不会再装回来', async () => {
    const sessionId = 'sess_user_skill_dismiss'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: ['user:my-skill']
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const agent = new TestAgent(createServices({ historyService: historyService as never }))
    agent.hydrateSkills(['user:my-skill'], [])
    await agent.unpinSkill('user:my-skill')
    expect(agent.exposeVisibleSkills()).toEqual([])
    expect(agent.exposeLoadedSkillsRoster()).toEqual([])

    await agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))
    expect(agent.exposeVisibleSkills().some(s => s.id === 'user:my-skill')).toBe(false)
    expect(agent.exposeLoadedSkillsRoster()).toEqual([])
  })

  it('重开对话时，用户卸掉的技能不出现在胶囊清单里', async () => {
    const sessionId = 'sess_dismissed_skill'
    const historyService = {
      getAgentRecordById: vi.fn().mockReturnValue(priorRecord(sessionId, {
        loadedSkills: [configSkill.id],
        userDismissedSkills: [configSkill.id]
      })),
      saveAgentRecord: vi.fn(),
      getAgentRecordStore: vi.fn(function (this: unknown) { return this })
    }
    const agent = new TestAgent(createServices({ historyService: historyService as never }))
    agent.hydrateSkills([configSkill.id], [configSkill.id])
    expect(agent.exposeVisibleSkills()).toEqual([])

    await agent.run('继续', ctx({ sessionId, sessionStartTime: Date.now() - 5000 }))
    expect(agent.exposeLoadedSkills()).not.toContain(configSkill.id)
  })
})
