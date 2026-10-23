/**
 * 任务侧栏短标题生成单测
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  sanitizeConversationTitle,
  generateConversationTitle,
  resetTitleGeneratorInflightForTest,
  shouldRefreshConversationTitle,
  titlesEquivalent,
} from '../title-generator'
import type { AiService } from '../../ai.service'
import type { ConfigService } from '../../config.service'
import type { HistoryService } from '../../history.service'
import type { ConversationTitleWriter } from '../title-generator'

vi.mock('../../agent/skills/config/executor', () => ({
  notifyFrontendConfigChanged: vi.fn(),
}))

describe('sanitizeConversationTitle', () => {
  it('去掉首尾引号与空白，只取首行', () => {
    expect(sanitizeConversationTitle('  "修复登录重定向"  \n多余一行')).toBe('修复登录重定向')
    expect(sanitizeConversationTitle("「Fix auth」")).toBe('Fix auth')
  })

  it('超长截断到 40 字符', () => {
    const long = '一'.repeat(50)
    expect(sanitizeConversationTitle(long)?.length).toBe(40)
  })

  it('空串返回 null', () => {
    expect(sanitizeConversationTitle('')).toBeNull()
    expect(sanitizeConversationTitle('   ')).toBeNull()
    expect(sanitizeConversationTitle('""')).toBeNull()
  })
})

describe('shouldRefreshConversationTitle', () => {
  it('第 3 / 6 / 9 轮刷新，其余不刷', () => {
    expect(shouldRefreshConversationTitle(0)).toBe(false)
    expect(shouldRefreshConversationTitle(1)).toBe(false)
    expect(shouldRefreshConversationTitle(2)).toBe(false)
    expect(shouldRefreshConversationTitle(3)).toBe(true)
    expect(shouldRefreshConversationTitle(4)).toBe(false)
    expect(shouldRefreshConversationTitle(6)).toBe(true)
    expect(shouldRefreshConversationTitle(9)).toBe(true)
  })
})

describe('titlesEquivalent', () => {
  it('忽略空白与大小写', () => {
    expect(titlesEquivalent('写周报', '写周报')).toBe(true)
    expect(titlesEquivalent('Fix Auth', 'fix auth')).toBe(true)
    expect(titlesEquivalent('写周报', '排查 nginx')).toBe(false)
  })

  it('高度包含视为几乎一样', () => {
    expect(titlesEquivalent('写周报', '写周报第三段')).toBe(true)
    expect(titlesEquivalent('排查 nginx 502', '写周报')).toBe(false)
  })
})

describe('generateConversationTitle', () => {
  beforeEach(() => {
    resetTitleGeneratorInflightForTest()
    vi.clearAllMocks()
  })

  function makeDeps(opts?: {
    existingTitle?: string
    titleLocked?: boolean
    chatResult?: string
    chatError?: Error
  }) {
    let recordTitle = opts?.existingTitle
    let recordLocked = opts?.titleLocked === true
    const historyService = {
      getAgentRecordById: vi.fn((sessionId: string) =>
        recordTitle || recordLocked
          ? { id: sessionId, title: recordTitle, titleLocked: recordLocked || undefined }
          : undefined
      ),
    } as unknown as HistoryService

    const agentService: ConversationTitleWriter = {
      setConversationTitleBySessionId: vi.fn((sessionId: string, title: string) => {
        recordTitle = title
        return true
      }),
    }

    const configService = {
      getLanguage: vi.fn(() => 'zh-CN' as const),
    } as unknown as ConfigService

    const aiService = {
      chat: vi.fn(async () => {
        if (opts?.chatError) throw opts.chatError
        return opts?.chatResult ?? '修复登录重定向'
      }),
      chatWithTools: vi.fn(async () => {
        if (opts?.chatError) throw opts.chatError
        return { content: opts?.chatResult ?? '排查 nginx 502' }
      }),
    } as unknown as AiService

    return {
      configService,
      aiService,
      historyService,
      agentService,
      getRecordTitle: () => recordTitle,
      lockTitle: () => { recordLocked = true },
    }
  }

  it('成功生成并写入会话 title', async () => {
    const deps = makeDeps()
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '帮我看看登录为什么总跳错页',
    })
    expect(title).toBe('修复登录重定向')
    expect(deps.agentService.setConversationTitleBySessionId).toHaveBeenCalledWith(
      'session_1',
      '修复登录重定向'
    )
  })

  it('已有标题则首条生成跳过且不调 LLM', async () => {
    const deps = makeDeps({ existingTitle: '我改的名字' })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '随便',
    })
    expect(title).toBeNull()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
  })

  it('系统占位消息跳过', async () => {
    const deps = makeDeps()
    expect(
      await generateConversationTitle(deps, {
        sessionId: 'session_1',
        userMessage: '__onboarding__',
      })
    ).toBeNull()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
  })

  it('LLM 失败时静默返回 null', async () => {
    const deps = makeDeps({ chatError: new Error('network') })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '测一下',
    })
    expect(title).toBeNull()
    expect(deps.agentService.setConversationTitleBySessionId).not.toHaveBeenCalled()
  })

  it('生成期间用户已手动改名则不覆盖', async () => {
    const deps = makeDeps()
    ;(deps.aiService.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      deps.agentService.setConversationTitleBySessionId('session_1', '手动标题')
      return '模型标题'
    })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      userMessage: '测一下',
    })
    expect(title).toBeNull()
    expect(deps.getRecordTitle()).toBe('手动标题')
  })

  it('refresh 可覆盖自动标题，并走带工具的前缀请求', async () => {
    const deps = makeDeps({ existingTitle: '帮我看看这个', chatResult: '排查 nginx 502' })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      mode: 'refresh',
      cachePrefix: [{ role: 'user', content: '服务器 502 了' }],
      tools: [{ type: 'function', function: { name: 'exec', description: '', parameters: { type: 'object', properties: {} } } }],
    })
    expect(title).toBe('排查 nginx 502')
    expect(deps.aiService.chatWithTools).toHaveBeenCalled()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
    expect(deps.agentService.setConversationTitleBySessionId).toHaveBeenCalledWith(
      'session_1',
      '排查 nginx 502'
    )
  })

  it('refresh 在用户锁定后跳过', async () => {
    const deps = makeDeps({ existingTitle: '我起的名', titleLocked: true })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      mode: 'refresh',
      cachePrefix: [{ role: 'user', content: '还是这个' }],
    })
    expect(title).toBeNull()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
    expect(deps.aiService.chatWithTools).not.toHaveBeenCalled()
  })

  it('refresh 新标题几乎一样则不写', async () => {
    const deps = makeDeps({ existingTitle: '写周报', chatResult: '写周报' })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      mode: 'refresh',
      cachePrefix: [{ role: 'user', content: '再改第三段' }],
    })
    expect(title).toBeNull()
    expect(deps.agentService.setConversationTitleBySessionId).not.toHaveBeenCalled()
  })

  it('refresh 无前缀则跳过', async () => {
    const deps = makeDeps({ existingTitle: '旧标题' })
    const title = await generateConversationTitle(deps, {
      sessionId: 'session_1',
      mode: 'refresh',
    })
    expect(title).toBeNull()
    expect(deps.aiService.chat).not.toHaveBeenCalled()
  })
})
