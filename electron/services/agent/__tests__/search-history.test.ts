import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../knowledge', () => ({
  getKnowledgeService: vi.fn(),
}))

import { getKnowledgeService } from '../../knowledge'
import { searchHistory } from '../tools/memory'
import type { ToolExecutorConfig } from '../tools/types'

function makeExecutor(overrides: Partial<ToolExecutorConfig> = {}): ToolExecutorConfig {
  return {
    isAborted: () => false,
    addStep: vi.fn(),
    getHostId: () => 'personal',
    getAbortSignal: () => undefined,
    ...overrides,
  } as unknown as ToolExecutorConfig
}

describe('searchHistory semantic detail=full', () => {
  const searchConversations = vi.fn()
  const getAgentRecordById = vi.fn()
  const searchAgentRecordsAdvanced = vi.fn()

  beforeEach(() => {
    searchConversations.mockReset()
    getAgentRecordById.mockReset()
    searchAgentRecordsAdvanced.mockReset()
    vi.mocked(getKnowledgeService).mockReturnValue({
      isEnabled: () => true,
      searchConversations,
    } as unknown as ReturnType<typeof getKnowledgeService>)
  })

  it('按 taskId 定点取记录，不走全文关键词扫描', async () => {
    searchConversations.mockResolvedValue([{
      taskId: 'sess_abc',
      userRequest: '写论文',
      finalResult: 'ok',
      status: 'success',
      timestamp: 1,
      relevance: 0.9,
    }])
    getAgentRecordById.mockReturnValue({
      id: 'sess_abc',
      steps: [
        { type: 'tool_call', toolName: 'read_file', toolArgs: { path: '/tmp/a' } },
      ],
    })

    const executor = makeExecutor({
      historyService: { getAgentRecordById, searchAgentRecordsAdvanced } as unknown as ToolExecutorConfig['historyService'],
    })

    const result = await searchHistory(
      { mode: 'semantic', keyword: '论文', detail: 'full' },
      executor
    )

    expect(getAgentRecordById).toHaveBeenCalledWith('sess_abc', { omitCanvasData: true })
    expect(searchAgentRecordsAdvanced).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.output).toContain('read_file')
    expect(result.output).toContain('写论文')
  })

  it('taskId 对不上时不抛错，只给摘要', async () => {
    searchConversations.mockResolvedValue([{
      taskId: 'already-deleted',
      userRequest: '写论文',
      finalResult: 'ok',
      status: 'success',
      timestamp: 1,
      relevance: 0.8,
    }])
    getAgentRecordById.mockReturnValue(undefined)

    const executor = makeExecutor({
      historyService: { getAgentRecordById, searchAgentRecordsAdvanced } as unknown as ToolExecutorConfig['historyService'],
    })

    const result = await searchHistory(
      { mode: 'semantic', keyword: '论文', detail: 'full' },
      executor
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain('写论文')
    expect(result.output).not.toContain('**工具调用**')
  })

  it('写法与自动召回一致：标出是哪场、不标成功、不报排名分', async () => {
    searchConversations.mockResolvedValue([{
      taskId: 'old',
      userRequest: '深度测试你的子智能体能力',
      finalResult: '操作已中止',
      status: 'success',
      timestamp: new Date(2026, 3, 25, 11, 43).getTime(),
      relevance: 0.0164,
      sameSession: false,
    }])
    const recalling = { id: 'session_now', startedAt: 2_000 }
    const executor = makeExecutor({ getRecallingConversation: () => recalling })

    const result = await searchHistory({ mode: 'semantic', keyword: '深度测试' }, executor)

    expect(searchConversations).toHaveBeenCalledWith('深度测试', 'personal', 10, recalling)
    expect(result.output).toContain('### 过往对话 · 2026-04-25 11:43 · 另一场对话\n')
    expect(result.output).toContain('当时用户说：深度测试你的子智能体能力')
    expect(result.output).not.toContain('✅')
    expect(result.output).not.toContain('% 相关')
  })
})

describe('searchHistory keyword', () => {
  it('不标成功，失败、中止用文字标', async () => {
    const searchAgentRecordsAdvanced = vi.fn().mockResolvedValue({
      records: [
        { id: 'a', userTask: '任务甲', finalResult: '好了', status: 'completed', timestamp: 1, steps: [] },
        { id: 'b', userTask: '任务乙', finalResult: '断了', status: 'aborted', timestamp: 2, steps: [] },
      ],
    })
    const executor = makeExecutor({
      historyService: { searchAgentRecordsAdvanced } as unknown as ToolExecutorConfig['historyService'],
    })

    const result = await searchHistory({ keyword: '任务' }, executor)

    expect(result.output).not.toContain('✅')
    expect(result.output).toMatch(/### 2\. .+ · 中止/)
    expect(result.output).not.toMatch(/### 1\. .+ · /)
  })
})
