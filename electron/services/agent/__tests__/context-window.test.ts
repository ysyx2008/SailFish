/**
 * ContextWindowManager 单元测试
 *
 * 验证从 Agent 基类抽出的上下文窗口管理簇:token 估算 / 用量压力 / 压缩 / 工具调用序列修复。
 * 直接 `new ContextWindowManager(mockDeps)`,无需构造 Agent——这正是抽出的可测性收益。
 */
import { describe, it, expect, vi } from 'vitest'
import { ContextWindowManager, nextCompressedArchiveId, peelOpenToolTurn, type ContextWindowDeps } from '../context-window'
import type { AiMessage, ToolCall } from '../../ai.service'
import type { AgentRun } from '../types'
import type { AiProfile } from '@shared/types'

// ==================== 工具:构造 mock deps / run ====================

function makeDeps(overrides?: Partial<ContextWindowDeps>): ContextWindowDeps {
  return {
    config: {
      getAiProfiles: () => [{ id: 'p1', contextLength: 128000 } as AiProfile],
      getActiveAiProfile: () => 'p1'
    },
    getProfileId: () => undefined,
    getLastPromptTokens: () => undefined,
    getLastCacheHitRate: () => undefined,
    reportUsage: vi.fn(),
    // 测试消息普遍很短，默认绕过「最小可压缩范围」守卫；守卫本身有专项用例
    minProactiveRangeTokens: 0,
    ...overrides
  }
}

function makeRun(messages: AiMessage[] = [], extra?: Partial<AgentRun>): AgentRun {
  return {
    id: 'r1',
    originalUserRequest: 'test',
    messages,
    steps: [],
    isRunning: false,
    aborted: false,
    pendingUserMessages: [],
    config: {} as AgentRun['config'],
    context: {} as AgentRun['context'],
    realtimeOutputBuffer: [],
    executionPhase: 'idle',
    taskMessageLog: [],
    ...extra
  } as AgentRun
}

const asst = (content: string, toolCalls?: AiMessage['tool_calls']): AiMessage => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { tool_calls: toolCalls } : {})
})
const user = (content: string): AiMessage => ({ role: 'user', content })
const tool = (id: string, content = 'ok'): AiMessage => ({ role: 'tool', content, tool_call_id: id })
const tc = (id: string, name: string, args = '{}'): ToolCall => ({ id, type: 'function', function: { name, arguments: args } })

/** 多轮历史 + 当前任务：前两轮已结束（各有最终答复），第三轮进行中 */
function multiTaskRun(): AgentRun {
  return makeRun([
    { role: 'system', content: 'sys prompt' },
    user('任务一：查磁盘'),
    asst('', [tc('c1', 'exec')]), tool('c1', 'df 输出一大段'),
    asst('任务一完成：根分区 80%'),
    user('任务二：清日志'),
    asst('', [tc('c2', 'exec')]), tool('c2', 'rm 输出'),
    asst('任务二失败：权限不足'),
    user('任务三：装依赖'),
    asst('', [tc('c3', 'exec')]), tool('c3', 'npm 输出'),
    asst('', [tc('c4', 'exec')]), tool('c4', 'npm 输出2'),
    asst('', [tc('c5', 'exec')]), tool('c5', 'npm 输出3')
  ])
}

// ==================== estimateTokens ====================

describe('ContextWindowManager.estimateTokens', () => {
  it('null / undefined / 空串 → 0', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTokens(null)).toBe(0)
    expect(m.estimateTokens(undefined)).toBe(0)
    expect(m.estimateTokens('')).toBe(0)
  })

  it('纯中文:UTF-8 每字 3 字节 → 0.75 tokens/字', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTokens('你好世界')).toBe(Math.ceil((4 * 3) / 4)) // 3
  })

  it('纯英文/符号:每字符 1 字节 → 0.25 tokens/字符', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTokens('hello')).toBe(Math.ceil(5 / 4)) // 2
  })

  it('混合:按 UTF-8 字节合计', () => {
    const m = new ContextWindowManager(makeDeps())
    // 2 中文(6 字节) + 5 非中文(5 字节) = 11 字节 → ceil(11/4) = 3
    expect(m.estimateTokens('你好hello')).toBe(3)
  })
})

// ==================== estimateTotalTokens ====================

describe('ContextWindowManager.estimateTotalTokens', () => {
  it('空消息列表:仅 4000 基线', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.estimateTotalTokens([])).toBe(4000)
  })

  it('单条 user:content tokens + 4 overhead + 4000 基线', () => {
    const m = new ContextWindowManager(makeDeps())
    // 'hello' = 5 字节 → 2 tokens; +4 overhead; +4000 = 4006
    expect(m.estimateTotalTokens([user('hello')])).toBe(4006)
  })

  it('含 tool_calls:累加 name + arguments 的 tokens', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = {
      role: 'assistant',
      content: 'hi', // 2 字节 → 1 token
      tool_calls: [tc('c1', 'foo', '{"a":1}')]
    }
    // content 1 + overhead 4 + 'foo'(3 字节→1) + '{"a":1}'(7 字节→2) = 8; +4000 = 4008
    const result = m.estimateTotalTokens([msg])
    expect(result).toBe(4008)
  })

  it('含 reasoning_content:累加其 tokens', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = {
      role: 'assistant',
      content: 'a', // 1 char * 0.5 = ceil(0.5) = 1
      reasoning_content: 'bb' // 2 chars * 0.5 = 1
    }
    // 1 + 4 overhead + 1 reasoning = 6; +4000 = 4006
    expect(m.estimateTotalTokens([msg])).toBe(4006)
  })

  it('含 images:每张按 IMAGE_TOKENS_PER_ITEM 累加（user 角色多模态消息）', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = {
      role: 'user',
      content: 'hi', // 2 chars * 0.5 = 1 token
      images: ['data:image/png;base64,xxx', 'data:image/png;base64,yyy', 'data:image/png;base64,zzz']
    }
    // content 1 + overhead 4 + 3 张图 × 1500 = 4505; +4000 基线 = 8505
    expect(m.estimateTotalTokens([msg])).toBe(8505)
  })

  it('images 为空数组不增 token（边界）', () => {
    const m = new ContextWindowManager(makeDeps())
    const msg: AiMessage = { role: 'user', content: 'hi', images: [] }
    // 与无 images 一致:1 + 4 + 4000 = 4005
    expect(m.estimateTotalTokens([msg])).toBe(4005)
  })
})

// ==================== getContextLength ====================

describe('ContextWindowManager.getContextLength', () => {
  it('无 config → 默认 128000', () => {
    const m = new ContextWindowManager(makeDeps({ config: undefined }))
    expect(m.getContextLength()).toBe(128000)
  })

  it('空 profiles → 默认 128000', () => {
    const m = new ContextWindowManager(makeDeps({ config: { getAiProfiles: () => [], getActiveAiProfile: () => 'x' } }))
    expect(m.getContextLength()).toBe(128000)
  })

  it('profileId 命中 → 取该 profile 的 contextLength', () => {
    const profiles = [{ id: 'a', contextLength: 32000 }, { id: 'b', contextLength: 200000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'a' },
      getProfileId: () => 'b'
    }))
    expect(m.getContextLength()).toBe(200000)
  })

  it('profileId 缺失 → 回退 active profile', () => {
    const profiles = [{ id: 'a', contextLength: 32000 }, { id: 'b', contextLength: 200000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'b' },
      getProfileId: () => undefined
    }))
    expect(m.getContextLength()).toBe(200000)
  })

  it('profileId 与 active 都不命中 → 取第一个', () => {
    const profiles = [{ id: 'a', contextLength: 32000 }, { id: 'b', contextLength: 200000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'nope' },
      getProfileId: () => undefined
    }))
    expect(m.getContextLength()).toBe(32000)
  })

  it('命中 profile 但 contextLength 缺省 → 128000', () => {
    const profiles = [{ id: 'a' } as AiProfile]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'a' }
    }))
    expect(m.getContextLength()).toBe(128000)
  })

  it('指定 profileId 找不到 → 保守 128000，不借第一个的大窗口', () => {
    const profiles = [{ id: 'huge', contextLength: 1000000 }] as AiProfile[]
    const m = new ContextWindowManager(makeDeps({
      config: { getAiProfiles: () => profiles, getActiveAiProfile: () => 'huge' },
      getProfileId: () => 'missing'
    }))
    expect(m.getContextLength()).toBe(128000)
    expect(m.getInputLimit()).toBeLessThan(128000)
  })
})

describe('ContextWindowManager.getInputLimit / needsRequestCompaction', () => {
  it('能发的输入先扣输出额度和余量', () => {
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 128000, maxOutputTokens: 8000 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      }
    }))
    expect(m.getContextLength()).toBe(128000)
    expect(m.getInputLimit()).toBe(128000 - 8000 - 1024)
  })

  it('指定配置找不到时按保守窗口估，不按旁边 1M 估', () => {
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'huge', contextLength: 1000000, maxOutputTokens: 4096 } as AiProfile],
        getActiveAiProfile: () => 'huge'
      },
      getProfileId: () => 'gone'
    }))
    expect(m.getInputLimit()).toBe(128000 - 32000 - 1024)
  })

  it('冷启动无真实用量：估出来已经超输入预算 → 需要先压', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => undefined }))
    const huge = 'x'.repeat(400_000)
    const run = makeRun([user(huge), asst(huge)])
    expect(m.needsRequestCompaction(run)).toBe(true)
  })

  it('短对话不需要先压', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => undefined }))
    expect(m.needsRequestCompaction(makeRun([user('hi')]))).toBe(false)
  })
})

// ==================== updatePressure ====================

describe('ContextWindowManager.updatePressure', () => {
  it('仅有估算值(无 lastPromptTokens)时:不推 UI', () => {
    const reportUsage = vi.fn()
    const m = new ContextWindowManager(makeDeps({ reportUsage, getLastPromptTokens: () => undefined }))
    m.updatePressure(makeRun([user('hi')]))
    expect(reportUsage).not.toHaveBeenCalled()
  })

  it('有 API 精确值时:推 UI(tokens + cacheHitRate)', () => {
    const reportUsage = vi.fn()
    const m = new ContextWindowManager(makeDeps({
      reportUsage,
      getLastPromptTokens: () => 100000,
      getLastCacheHitRate: () => 42
    }))
    m.updatePressure(makeRun([user('hi')]))
    expect(reportUsage).toHaveBeenCalledWith(100000, 42)
  })

  // 有锚点 ⇒ 上一轮响应过 ⇒ 它的 assistant 回复必在 messages 里。
  // 只有 [user] 而带锚点是不可能出现的状态，用例按真实序列构造。
  const answered = () => makeRun([user('hi'), asst('ok')])

  it('用量 >= 85% → enabled 翻 true;< 85% 保持 false', () => {
    const low = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 1000 })) // 1000/128000 < 1%
    low.updatePressure(answered())
    expect(low.enabled).toBe(false)

    const high = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 })) // ~86%
    high.updatePressure(answered())
    expect(high.enabled).toBe(true)
  })

  it('enabled 一旦 true 不回退:低用量再调仍为 true', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 }))
    m.updatePressure(answered())
    expect(m.enabled).toBe(true)
    // 重新构造不可控的内部状态,但同一实例后续低用量不应回退
    const m2 = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 1000 }))
    m2.updatePressure(answered())
    expect(m2.enabled).toBe(false)
    // m 仍是 true(已激活)
    expect(m.enabled).toBe(true)
  })

  it('用量 >= 85%:注入警告消息(带 _systemInjected)', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 }))
    const run = answered()
    m.updatePressure(run)
    const last = run.messages[run.messages.length - 1]
    expect(last.role).toBe('user')
    expect(last._systemInjected).toBe(true)
    expect(typeof last.content).toBe('string')
    expect((last.content as string).includes('[系统] 上下文用量告警')).toBe(true)
  })

  it('警告去重:连续两次 updatePressure 只注入一条警告', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 110000 }))
    const run = answered()
    m.updatePressure(run)
    m.updatePressure(run)
    const warnings = run.messages.filter(
      msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('[系统] 上下文用量告警')
    )
    expect(warnings.length).toBe(1)
  })

  it('不催它自己压时：快满也不注入警告，高水位仍激活', () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 110000,
      shouldNudgeModelToCompact: () => false,
    }))
    const run = answered()
    m.updatePressure(run)
    expect(run.messages.length).toBe(2)
    expect(m.enabled).toBe(true)
  })

  it('用量 < 85%:不注入警告', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 1000 }))
    const run = answered()
    m.updatePressure(run)
    expect(run.messages.length).toBe(2) // 原样,未追加
  })

  it('压力判断计入本轮新增:锚点未变但 tool 结果堆积也会触发告警', () => {
    // 锚点 100000（78%，本身不触发）；本轮新增一大段 tool 输出后越过 85%
    const bulk = 'x'.repeat(40000) // 40000 字节 → 10000 tokens
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 100000 }))
    const run = makeRun([user('hi'), asst('call', [tc('c1', 'read', '{}')]), tool('c1', bulk)])
    m.updatePressure(run)
    expect(m.enabled).toBe(true)
  })
})

// ==================== compress ====================

describe('ContextWindowManager.compress', () => {
  it('无 user 消息 → null', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.compress(makeRun([asst('hi')]), '摘要', 1)).toBeNull()
  })

  it('无可压缩内容(keepRecent 覆盖全部) → null', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([user('do'), asst('a1'), tool('c1')])
    // keepRecent=1 → 保留最后一组(asst a1 + tool c1),toCompress 为空 → null
    expect(m.compress(run, '摘要', 1)).toBeNull()
  })

  it('按 assistant 分组保留 keepRecent 组,归档深拷贝,messages 重建', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do task'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3')
    ])
    const result = m.compress(run, '早期摘要', 1)
    expect(result).not.toBeNull()
    expect(result!.archiveId).toBe('ca-1')
    expect(result!.freedTokens).toBe(result!.beforeTokens - result!.afterTokens)

    // 归档了前 2 组(a1+c1, a2+c2) = 4 条
    expect(run.compressedArchives).toHaveLength(1)
    expect(run.compressedArchives![0].messages).toHaveLength(4)
    expect(run.compressedArchives![0].summary).toBe('早期摘要')

    // messages 重建:[user, summary, asst a3, tool c3]
    expect(run.messages).toHaveLength(4)
    expect(run.messages[0].role).toBe('user')
    expect(run.messages[1].role).toBe('assistant') // 摘要消息
    expect((run.messages[1].content as string).includes('早期摘要')).toBe(true)
    expect(run.messages[2]).toEqual(asst('a3', [tc('c3', 'baz')]))
    expect(run.messages[3]).toEqual(tool('c3', 'r3'))
  })

  it('归档深拷贝:后续修改 run.messages 不影响归档', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([user('do'), asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'), asst('a2'), tool('c2', 'r2')])
    m.compress(run, '摘要', 1)
    const archived = run.compressedArchives![0].messages
    const archivedBefore = JSON.stringify(archived)
    // 修改 run.messages
    run.messages.push(user('new'))
    expect(JSON.stringify(archived)).toBe(archivedBefore) // 归档未受影响
  })
})

// ==================== fixIncompleteToolCalls ====================

describe('ContextWindowManager.fixIncompleteToolCalls', () => {
  it('为缺失的 tool_call 补占位 tool result,并镜像到 taskMessageLog', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo'), tc('c2', 'bar')])])
    m.fixIncompleteToolCalls(run)
    // 追加 2 条 tool 消息
    expect(run.messages).toHaveLength(3)
    expect(run.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1', content: '[操作被用户中断]' })
    expect(run.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
    // 镜像到 taskMessageLog
    expect(run.taskMessageLog).toHaveLength(2)
    expect(run.taskMessageLog[0]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })
  })

  it('自定义 placeholder 内容', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo')])])
    m.fixIncompleteToolCalls(run, '[执行中断: boom]')
    expect((run.messages[1].content as string)).toBe('[执行中断: boom]')
  })

  it('部分 tool result 已存在:只补缺失的', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo'), tc('c2', 'bar')]), tool('c1', 'r1')])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(3) // asst + 已有 tool c1 + 新补 tool c2
    expect(run.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c2' })
    expect(run.taskMessageLog).toHaveLength(1) // 仅镜像新补的
  })

  it('完整序列(所有 tool result 已存在) → no-op', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('plan', [tc('c1', 'foo')]), tool('c1', 'r1')])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(2)
    expect(run.taskMessageLog).toHaveLength(0)
  })

  it('遇到 user 消息即停:之前的 assistant 不再补', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      asst('old', [tc('c9', 'ghost')]), // 之前残留的"完整"序列(被 user 隔开)
      user('new turn'),
      asst('plan', [tc('c1', 'foo')]),
      tool('c1', 'r1')
    ])
    m.fixIncompleteToolCalls(run)
    // 不应为 c9 补占位;末尾序列已完整,no-op
    expect(run.messages).toHaveLength(4)
    expect(run.taskMessageLog).toHaveLength(0)
  })

  it('空 messages → no-op', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(0)
  })

  it('无 tool_calls 的 assistant → no-op', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([asst('just text')])
    m.fixIncompleteToolCalls(run)
    expect(run.messages).toHaveLength(1)
  })
})

// ==================== isContextLimitError ====================

describe('ContextWindowManager.isContextLimitError', () => {
  it('匹配原始错误码 context_length_exceeded', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('context_length_exceeded'))).toBe(true)
    expect(ContextWindowManager.isContextLimitError(new Error('Error: context_length_exceeded: too long'))).toBe(true)
  })

  it('匹配中文翻译文案（ai.service.ts 抛出的 t("error.context_length_exceeded")）', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('上下文超出模型限制。请清除部分对话历史后重试。'))).toBe(true)
  })

  it('匹配英文翻译文案', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('Context length exceeded. Please clear some conversation history and try again.'))).toBe(true)
  })

  it('匹配火山豆包固定英文文案（max message tokens）', () => {
    expect(ContextWindowManager.isContextLimitError(
      new Error('大模型 API 请求出错: Total tokens of image and text exceed max message tokens.')
    )).toBe(true)
    expect(ContextWindowManager.isContextLimitError(
      new Error('Total tokens of image and text exceed max message tokens.')
    )).toBe(true)
  })

  it('普通网络/超时/中止错误不匹配', () => {
    expect(ContextWindowManager.isContextLimitError(new Error('aborted'))).toBe(false)
    expect(ContextWindowManager.isContextLimitError(new Error('Request timeout'))).toBe(false)
    expect(ContextWindowManager.isContextLimitError(new Error('network error'))).toBe(false)
  })

  it('非 Error 对象 / 空字符串不匹配', () => {
    expect(ContextWindowManager.isContextLimitError(null)).toBe(false)
    expect(ContextWindowManager.isContextLimitError(undefined)).toBe(false)
    expect(ContextWindowManager.isContextLimitError('')).toBe(false)
    expect(ContextWindowManager.isContextLimitError(42)).toBe(false)
  })

  it('不误匹配 agent.context_limit_exceeded（英文版不含 "Context length exceeded"）', () => {
    // 这是给 AI 看的 UI 提示文案，不是 API 错误码翻译，不应被识别为 API 报错
    const enUiPrompt = '⚠️ Conversation context exceeds model limit (current 130000 tokens, model limit 128000 tokens, 101%).'
    expect(ContextWindowManager.isContextLimitError(new Error(enUiPrompt))).toBe(false)
  })
})

// ==================== emergencyCompress ====================

describe('ContextWindowManager.emergencyCompress', () => {
  it('无 user 消息 → null（无法压缩）', () => {
    const m = new ContextWindowManager(makeDeps())
    expect(m.emergencyCompress(makeRun([asst('hi')]))).toBeNull()
  })

  it('成功压缩：归档早期对话、保留最近 2 组、enabled 翻 true', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do task'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const beforeMsgCount = run.messages.length
    const result = m.emergencyCompress(run)
    expect(result).not.toBeNull()
    expect(result!.keepRecent).toBe(2)
    expect(result!.archiveId).toBe('ca-1')
    expect(m.enabled).toBe(true)
    // 归档存在
    expect(run.compressedArchives).toHaveLength(1)
    expect(run.compressedArchives![0].messages.length).toBeGreaterThan(0)
    // messages 条数减少（早期对话被摘要替换）
    // 原 9 条 → user + summary + a3 + c3 + a4 + c4 = 6 条
    expect(run.messages.length).toBeLessThan(beforeMsgCount)
    expect(run.messages.length).toBe(6)
    expect(run.messages[0].role).toBe('user')
    expect(run.messages[1].role).toBe('assistant') // 摘要
  })

  it('keepRecent=2 后仍超 90% → 自动降到 keepRecent=1（用小 contextLength 触发）', () => {
    // 用很小的 contextLength 让 keepRecent=2 压缩后 afterUsage 仍 > 90%
    // （4000 基线 / 4200 ≈ 95%，加上 summary 后肯定 > 90%）
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 4200 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      }
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const result = m.emergencyCompress(run)
    expect(result).not.toBeNull()
    // keepRecent=2 后仍 >90%，应触发第二次压缩到 keepRecent=1
    expect(result!.keepRecent).toBe(1)
    expect(run.compressedArchives!.length).toBeGreaterThanOrEqual(1)
  })

  it('恰好 keepRecent 组 assistant（toCompress 为空）→ null（无法再压缩）', () => {
    const m = new ContextWindowManager(makeDeps())
    // 2 个 assistant 组，keepRecent=2 → keepFromIndex=0 → toCompress 为空 → null
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2')
    ])
    expect(m.emergencyCompress(run)).toBeNull()
    expect(run.compressedArchives).toBeUndefined()
  })

  it('多次调用：每次产生新 archiveId，归档累积', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4'),
      asst('a5', [tc('c5', 'extra')]), tool('c5', 'r5')
    ])
    const r1 = m.emergencyCompress(run)
    expect(r1).not.toBeNull()
    expect(r1!.archiveId).toBe('ca-1')
    // 再压缩一次（保留最近 2 组）
    const r2 = m.emergencyCompress(run)
    if (r2) {
      expect(r2.archiveId).toBe('ca-2')
      expect(run.compressedArchives).toHaveLength(2)
    }
  })

  it('已有归档时编号接着走，不从 1 重起', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4'),
      asst('a5', [tc('c5', 'extra')]), tool('c5', 'r5')
    ], {
      compressedArchives: [
        { id: 'ca-1', messages: [user('old')], summary: '旧归档', timestamp: 1 }
      ]
    })
    const result = m.emergencyCompress(run)
    expect(result).not.toBeNull()
    expect(result!.archiveId).toBe('ca-2')
    expect(run.compressedArchives?.map(a => a.id)).toEqual(['ca-1', 'ca-2'])
  })

  it('编号看已有最大号，不按条数，缺号也不会撞车', () => {
    expect(nextCompressedArchiveId([])).toBe('ca-1')
    expect(nextCompressedArchiveId([{ id: 'ca-1' }, { id: 'ca-2' }])).toBe('ca-3')
    expect(nextCompressedArchiveId([{ id: 'ca-1' }, { id: 'ca-3' }])).toBe('ca-4')
  })

  it('摘要消息含 recall(archive_id) 指引（让 AI 知道可以找回归档）', () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    m.emergencyCompress(run)
    const summaryMsg = run.messages[1]
    expect(summaryMsg.role).toBe('assistant')
    expect(typeof summaryMsg.content).toBe('string')
    expect((summaryMsg.content as string).includes('recall(archive_id')).toBe(true)
    expect((summaryMsg.content as string).includes('系统自动压缩')).toBe(true)
  })
})

// ==================== shouldProactiveCompress ====================

describe('ContextWindowManager.shouldProactiveCompress', () => {
  it('无 lastPromptTokens（首次对话/cold start）→ false（不赌估算）', () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => undefined }))
    const run = makeRun([user('do'), asst('a1'), asst('a2')])
    expect(m.shouldProactiveCompress(run)).toBe(false)
  })

  it('剩余空间够写小结 → false（常态不动前缀，把缓存吃满）', () => {
    // 128000 窗口扣掉默认输出后输入预算约 94K；用了 80000 还剩约 14K，够写小结
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 80000 }))
    const run = makeRun([user('do'), asst('a1')])
    expect(m.shouldProactiveCompress(run)).toBe(false)
  })

  it('剩余空间装不下小结 → true（触发）', () => {
    // contextLength=128000，预留 4000；用了 125000 只剩 3000，写不完小结
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([user('do'), asst('a1'), asst('a2'), asst('a3')])
    expect(m.shouldProactiveCompress(run)).toBe(true)
  })

  it('小窗口：预留按窗口比例封顶，不会刚开场就判定该压', () => {
    // 8000 窗口下固定预留 4000 会占掉一半 → 封顶到 8000 × 25% = 2000
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 8000 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getLastPromptTokens: () => 2000
    }))
    expect(m.getCompactionReserveTokens()).toBe(2000)
    // 输入预算约 4976，用了 2000 还剩约 3K > 预留 2000 → 不触发
    expect(m.shouldProactiveCompress(makeRun([user('do'), asst('a1')]))).toBe(false)
  })

  it('大窗口：预留取绝对值，不随窗口按比例膨胀', () => {
    // 旧的 95% 百分比逻辑在 1M 窗口下用到 950K 就压，可那时还剩 50K，完全够用
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 1000000 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getLastPromptTokens: () => 960000
    }))
    expect(m.getCompactionReserveTokens()).toBe(4000)
    expect(m.shouldProactiveCompress(makeRun([user('do'), asst('a1')]))).toBe(false)
  })

  it('lastPromptTokens 逼近 contextLength（如 DeepSeek 默默接受 62K 但 profile 是 64K）→ 触发', () => {
    // 模拟 DeepSeek 场景：profile contextLength=64000，上一轮真实用了 62000，只剩 2000
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 64000 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getLastPromptTokens: () => 62000
    }))
    const run = makeRun([user('do'), asst('a1'), asst('a2')])
    expect(m.shouldProactiveCompress(run)).toBe(true)
  })

  it('压完几乎没释放空间 → 判定压不动，不再触发（实效防抖）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    expect(m.shouldProactiveCompress(run)).toBe(true)
    await m.proactiveCompress(run)
    // 压缩后即使 lastPromptTokens 仍高，也不再触发
    expect(m.shouldProactiveCompress(run)).toBe(false)
  })
})

// ==================== proactiveCompress ====================

describe('ContextWindowManager.proactiveCompress', () => {
  it('无 user 消息 → null（无法压缩）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    expect(await m.proactiveCompress(makeRun([asst('hi')]))).toBeNull()
  })

  it('可压缩范围低于下限 → 跳过（负收益守卫），且不标记已压缩（后续仍可触发）', async () => {
    // 真实 E2E 发现：系统提示词占主导时可压缩消息仅几百 token，
    // AI 小结 + 归档包装比原文还长（实测 freed=-148）
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      minProactiveRangeTokens: 3000
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3')
    ])
    expect(await m.proactiveCompress(run)).toBeNull()
    expect(run.compressedArchives ?? []).toHaveLength(0)
    // 未压缩过 → 后续轮次积累更多内容后仍允许触发
    expect(m.shouldProactiveCompress(run)).toBe(true)
  })

  it('成功压缩：归档早期对话、保留最近 2 组、enabled 翻 true', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const beforeMsgCount: number[] = []
    const run = makeRun([
      user('do task'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    beforeMsgCount.push(run.messages.length)
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    expect(result!.keepRecent).toBe(2)
    expect(result!.archiveId).toBe('ca-1')
    expect(m.enabled).toBe(true)
    expect(run.compressedArchives).toHaveLength(1)
    // messages 条数减少：9 → 6（user + summary + a3 + c3 + a4 + c4）
    expect(run.messages.length).toBeLessThan(beforeMsgCount[0])
    expect(run.messages.length).toBe(6)
  })

  it('摘要文案含"系统主动压缩"（区分 emergency 的"系统自动压缩"）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    await m.proactiveCompress(run)
    const summaryMsg = run.messages[1]
    expect(summaryMsg.role).toBe('assistant')
    expect((summaryMsg.content as string).includes('系统主动压缩')).toBe(true)
    expect((summaryMsg.content as string).includes('系统自动压缩')).toBe(false)  // 不能是 emergency 文案
    expect((summaryMsg.content as string).includes('recall(archive_id')).toBe(true)
  })

  it('keepRecent=2 后仍超 90% → 自动降到 keepRecent=1', async () => {
    // 用小 contextLength 让 keepRecent=2 压缩后 afterUsage 仍 > 90%
    const m = new ContextWindowManager(makeDeps({
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 4200 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      },
      getLastPromptTokens: () => 4100  // > 90% of 4200
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    expect(result!.keepRecent).toBe(1)
  })

  it('恰好 keepRecent 组 assistant（toCompress 为空）→ null', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2')
    ])
    expect(await m.proactiveCompress(run)).toBeNull()
  })

  it('压不动（几乎没释放空间）→ 判定 stalled，不再重试', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    // 这批消息都很短，压完释放不了 500 tokens → stalled
    const r1 = await m.proactiveCompress(run)
    expect(r1).not.toBeNull()
    expect(r1!.freedTokens).toBeLessThan(ContextWindowManager.MIN_EFFECTIVE_FREED_TOKENS)
    expect(m.shouldProactiveCompress(run)).toBe(false)
    expect(await m.proactiveCompress(run)).toBeNull()
  })

  it('stalled 只管本任务：新任务开始后恢复主动压缩能力', async () => {
    // ContextWindowManager 跨 run 复用。若 stalled 不清零，某个任务压不动会让
    // 整个会话永久失去主动压缩，只剩紧急压缩兜底——对超限不报错的 provider 等于没有。
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    await m.proactiveCompress(run)
    expect(m.shouldProactiveCompress(run)).toBe(false) // 已 stalled

    m.resetForNewRun()
    expect(m.shouldProactiveCompress(run)).toBe(true)
  })

  it('压得动 → 不设 stalled，涨回来还能再压（长任务）', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    // 每条工具输出 8KB → 单轮就够跨过 500 token 的实效门槛
    const bulk = (n: string) => `${n}:${'x'.repeat(8000)}`
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', bulk('r1')),
      asst('a2', [tc('c2', 'bar')]), tool('c2', bulk('r2')),
      asst('a3', [tc('c3', 'baz')]), tool('c3', bulk('r3')),
      asst('a4', [tc('c4', 'qux')]), tool('c4', bulk('r4'))
    ])
    const r1 = await m.proactiveCompress(run)
    expect(r1).not.toBeNull()
    expect(r1!.freedTokens).toBeGreaterThanOrEqual(ContextWindowManager.MIN_EFFECTIVE_FREED_TOKENS)
    // 未被标记 stalled：真实用量仍高时可以再压（不再是「一个 run 只准压一次」）
    expect(m.shouldProactiveCompress(run)).toBe(true)

    // 模拟任务继续跑、上下文又涨满
    for (let i = 5; i <= 8; i++) {
      run.messages.push(asst(`a${i}`, [tc(`c${i}`, 'more')]), tool(`c${i}`, bulk(`r${i}`)))
    }
    const r2 = await m.proactiveCompress(run)
    expect(r2).not.toBeNull()
    expect(run.compressedArchives!.length).toBeGreaterThanOrEqual(2)
  })

  it('proactiveCompress 与 emergencyCompress 独立（emergency 仍可触发）', async () => {
    // 验证：proactive 压缩后，emergency 仍能工作（两者配额独立）
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
    ])
    // proactive 先压一次
    const r1 = await m.proactiveCompress(run)
    expect(r1).not.toBeNull()
    // 模拟后续又积累，emergency 仍能压（不同入口，配额独立）
    run.messages.push(asst('a5', [tc('c5', 'extra')]), tool('c5', 'r5'))
    run.messages.push(asst('a6', [tc('c6', 'more')]), tool('c6', 'r6'))
    const r2 = m.emergencyCompress(run)
    expect(r2).not.toBeNull()
    expect(run.compressedArchives!.length).toBeGreaterThanOrEqual(2)
  })
})

// ==================== proactiveCompress · AI 小结 ====================

describe('ContextWindowManager.proactiveCompress — AI 小结', () => {
  const fourGroups = () => makeRun([
    user('评审 57 份 PDF'),
    asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
    asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
    asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3'),
    asst('a4', [tc('c4', 'qux')]), tool('c4', 'r4')
  ])

  it('summarizeMessages 成功 → 摘要用 AI 小结，且是在完整对话里写（前缀不变才吃得到缓存）', async () => {
    let received: { conversation: AiMessage[]; keepRecent: number } | undefined
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      summarizeMessages: vi.fn().mockImplementation(async (opts) => {
        received = opts
        return '【任务目标】评审 57 份 PDF。【当前进度】已评审 30/57。'
      })
    }))
    const run = fourGroups()
    const before = [...run.messages]
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    const summaryMsg = run.messages[1]
    expect(summaryMsg.role).toBe('assistant')
    expect(summaryMsg.content).toContain('已评审 30/57')
    expect(summaryMsg.content).not.toContain('系统主动压缩')  // AI 小结不用模板
    // 传的是压缩前的完整对话，不是拍平的待归档切片
    expect(received!.conversation).toEqual(before)
    // 保留轮数如实告知，提示词里说几轮就真是几轮
    expect(received!.keepRecent).toBe(result!.keepRecent)
    // 归档里也存了 AI 小结
    expect(run.compressedArchives![0].summary).toContain('已评审 30/57')
  })

  it('summarizeMessages 返回 null → 回退固定模板', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      summarizeMessages: vi.fn().mockResolvedValue(null)
    }))
    const run = fourGroups()
    await m.proactiveCompress(run)
    expect(run.messages[1].content).toContain('系统主动压缩')
  })

  it('summarizeMessages 抛错 → 回退固定模板（不阻断压缩）', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      summarizeMessages: vi.fn().mockRejectedValue(new Error('API timeout'))
    }))
    const run = fourGroups()
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()
    expect(run.messages[1].content).toContain('系统主动压缩')
  })

  it('summarizeMessages 返回空白 → 回退固定模板', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      summarizeMessages: vi.fn().mockResolvedValue('   ')
    }))
    const run = fourGroups()
    await m.proactiveCompress(run)
    expect(run.messages[1].content).toContain('系统主动压缩')
  })
})

// ==================== 历史成对保留与预算上界 ====================

describe('ContextWindowManager — 历史任务成对保留', () => {
  it('每轮用户原话与最终答复成对留下，中间过程移出但可从归档取回', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = multiTaskRun()
    const result = await m.proactiveCompress(run)
    expect(result).not.toBeNull()

    const contents = run.messages.map(msg => msg.content)
    expect(contents).toContain('任务一：查磁盘')
    expect(contents).toContain('任务一完成：根分区 80%')
    expect(contents).toContain('任务二：清日志')
    // 失败状态必须留住，否则之后会重踩同一个坑
    expect(contents).toContain('任务二失败：权限不足')
    expect(contents).toContain('任务三：装依赖')

    // 历史里的工具过程已移出
    expect(run.messages.some(msg => msg.tool_call_id === 'c1')).toBe(false)
    expect(run.messages.some(msg => msg.tool_call_id === 'c2')).toBe(false)
    // 但归档里找得回
    const archived = JSON.stringify(run.compressedArchives)
    expect(archived).toContain('df 输出一大段')
    expect(archived).toContain('rm 输出')
  })

  it('system 消息留在最前，压缩后不出现孤儿 tool 消息', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = multiTaskRun()
    await m.proactiveCompress(run)

    expect(run.messages[0].role).toBe('system')
    const callIds = new Set(
      run.messages.flatMap(msg => (msg.tool_calls ?? []).map(c => c.id))
    )
    for (const msg of run.messages) {
      if (msg.role === 'tool') expect(callIds.has(msg.tool_call_id!)).toBe(true)
    }
  })

  it('成对内容超预算 → 老任务整对移出（保证压缩后规模有上界）', async () => {
    // 预算压到极小：只装得下最近一对，更老的必须让位
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 4200 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      }
    }))
    expect(m.getPreservedPairsBudget()).toBeLessThan(500)

    const run = multiTaskRun()
    await m.proactiveCompress(run)
    const contents = run.messages.map(msg => msg.content)
    // 最老的一轮已让位，进归档
    expect(contents).not.toContain('任务一：查磁盘')
    expect(JSON.stringify(run.compressedArchives)).toContain('任务一：查磁盘')
    // 当前任务的请求本身始终在
    expect(contents).toContain('任务三：装依赖')
  })

  it('预算再紧也留住最近一对：用户原话一条不留等于把任务本身弄丢', async () => {
    // 窗口小到扣掉固定前缀几乎不剩，预算按比例算约等于 0
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      config: {
        getAiProfiles: () => [{ id: 'p1', contextLength: 4100 } as AiProfile],
        getActiveAiProfile: () => 'p1'
      }
    }))
    const run = multiTaskRun()
    await m.proactiveCompress(run)
    const contents = run.messages.map(msg => String(msg.content))
    // 当前任务的请求在，且最近一个已结束任务的原话也在
    expect(contents).toContain('任务三：装依赖')
    expect(contents.some(c => c.startsWith('任务二：清日志'))).toBe(true)
  })

  it('任务没有最终答复 → 补一条状态，保留序列里不出现连续两条 user', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = makeRun([
      user('任务一：查磁盘'),
      asst('', [tc('c1', 'exec')]), tool('c1', 'df 输出'),
      user('先别管了，改做任务二'),   // 任务一没有最终答复就被打断
      asst('任务二完成'),
      user('任务三'),
      asst('', [tc('c2', 'exec')]), tool('c2', 'r2'),
      asst('', [tc('c3', 'exec')]), tool('c3', 'r3'),
      asst('', [tc('c4', 'exec')]), tool('c4', 'r4')
    ])
    await m.proactiveCompress(run)

    for (let i = 1; i < run.messages.length; i++) {
      if (run.messages[i].role === 'user') {
        expect(run.messages[i - 1].role).not.toBe('user')
      }
    }
    expect(run.messages.some(msg => String(msg.content).includes('没有最终答复'))).toBe(true)
  })

  it('单条特别长 → 只截断该条并指向归档，不牵连整对', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const huge = 'x'.repeat(200000)
    const run = makeRun([
      user(`帮我看这段日志：${huge}`),
      asst('看完了，是磁盘满'),
      user('那清一下'),
      asst('', [tc('c1', 'exec')]), tool('c1', 'r1'),
      asst('', [tc('c2', 'exec')]), tool('c2', 'r2'),
      asst('', [tc('c3', 'exec')]), tool('c3', 'r3')
    ])
    await m.proactiveCompress(run)

    const contents = run.messages.map(msg => String(msg.content))
    // 用户那条被截断但仍在（「用户提过这个要求」这件事保住了）
    const userMsg = contents.find(c => c.startsWith('帮我看这段日志'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.length).toBeLessThan(huge.length)
    expect(userMsg).toContain('recall(archive_id')
    // 配对的答复没受牵连
    expect(contents).toContain('看完了，是磁盘满')
  })

  it('压不压得动看真实读数：真实值够大就压，哪怕估算看着不够', async () => {
    const summarize = vi.fn().mockResolvedValue('小结')
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      minProactiveRangeTokens: 3000,      // 这段消息很短，纯估算会判定"不值得压"
      measureMessageRange: () => 99999,   // 但真实读数说它很大
      summarizeMessages: summarize
    }))
    expect(await m.proactiveCompress(multiTaskRun())).not.toBeNull()
    expect(summarize).toHaveBeenCalled()
  })

  it('真实读数说压不动 → 连那次写交接的调用都不发（省掉纯浪费的一次）', async () => {
    const summarize = vi.fn()
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      minProactiveRangeTokens: 3000,
      measureMessageRange: () => 100,
      summarizeMessages: summarize
    }))
    expect(await m.proactiveCompress(multiTaskRun())).toBeNull()
    expect(summarize).not.toHaveBeenCalled()
  })

  it('压过一次之后再压：系统注入的通知不当作新任务的起点', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = multiTaskRun()
    await m.proactiveCompress(run)

    // 压缩完成后系统会注入一条通知（借 user 角色发给模型，但不是用户说的话）
    run.messages.push(
      { role: 'user', content: '[系统] 已压缩早期对话', _systemInjected: true } as AiMessage,
      asst('', [tc('e1', 'exec')]), tool('e1', 'x'.repeat(4000)),
      asst('', [tc('e2', 'exec')]), tool('e2', 'y'.repeat(4000)),
      asst('', [tc('e3', 'exec')]), tool('e3', 'z'.repeat(4000))
    )
    m.resetForNewRun()   // 第一次压得太少会触发「压不动」防抖，这里要的是真压第二次
    await m.proactiveCompress(run)

    // 通知被当成历史归档掉，而不是顶替真实请求成为「当前任务」
    expect(run.messages.some(msg => msg._systemInjected)).toBe(false)
    expect(run.messages.map(msg => String(msg.content))).toContain('任务三：装依赖')
  })

  it('最近轮次太大 → 压之前就定为保留 1 轮，提示词与实际一致', async () => {
    let told: number | undefined
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => 125000,
      measureMessageRange: () => 200000,   // 真实读数说最近轮次极大，2 轮装不下
      summarizeMessages: vi.fn().mockImplementation(async (opts) => {
        told = opts.keepRecent
        return '小结'
      })
    }))
    const result = await m.proactiveCompress(multiTaskRun())
    expect(told).toBe(1)
    expect(result!.keepRecent).toBe(1)
  })

  it('反复压缩不累积：第二次压缩后规模不超过第一次', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = multiTaskRun()
    await m.proactiveCompress(run)
    const afterFirst = m.estimateTotalTokens(run.messages)

    // 模拟压缩后又跑了几轮
    run.messages.push(
      asst('', [tc('d1', 'exec')]), tool('d1', 'x'.repeat(4000)),
      asst('', [tc('d2', 'exec')]), tool('d2', 'y'.repeat(4000)),
      asst('', [tc('d3', 'exec')]), tool('d3', 'z'.repeat(4000))
    )
    m.resetForNewRun()   // 否则第二次会被「压不动」防抖挡掉，测不到累积与否
    await m.proactiveCompress(run)
    const afterSecond = m.estimateTotalTokens(run.messages)

    expect(afterSecond).toBeLessThanOrEqual(afterFirst + m.getPreservedPairsBudget())
  })
})

describe('ContextWindowManager.userCompress', () => {
  it('窗口还宽裕也压（不要求真实锚点 / 快满）', async () => {
    const m = new ContextWindowManager(makeDeps({
      getLastPromptTokens: () => undefined
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'x'.repeat(4000)),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'y'.repeat(4000)),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'z'.repeat(4000)),
      asst('a4', [tc('c4', 'qux')]), tool('c4', 'w'.repeat(4000))
    ])
    const result = await m.userCompress(run)
    expect(result).not.toBeNull()
    expect(result!.freedTokens).toBeGreaterThan(0)
  })

  it('上次主动压缩停手之后，用户要求仍能再压', async () => {
    const m = new ContextWindowManager(makeDeps({ getLastPromptTokens: () => 125000 }))
    const run = multiTaskRun()
    const first = await m.proactiveCompress(run)
    expect(first).not.toBeNull()
    if (first && first.freedTokens < ContextWindowManager.MIN_EFFECTIVE_FREED_TOKENS) {
      expect(await m.proactiveCompress(run)).toBeNull()
    }
    run.messages.push(
      asst('', [tc('u1', 'exec')]), tool('u1', 'x'.repeat(4000)),
      asst('', [tc('u2', 'exec')]), tool('u2', 'y'.repeat(4000)),
      asst('', [tc('u3', 'exec')]), tool('u3', 'z'.repeat(4000))
    )
    expect(await m.userCompress(run)).not.toBeNull()
  })

  it('人点名时范围小也写交接，不先自己卡掉', async () => {
    const summarize = vi.fn().mockResolvedValue('小结')
    const m = new ContextWindowManager(makeDeps({
      minProactiveRangeTokens: 3000,
      summarizeMessages: summarize
    }))
    const run = makeRun([
      user('do'),
      asst('a1', [tc('c1', 'foo')]), tool('c1', 'r1'),
      asst('a2', [tc('c2', 'bar')]), tool('c2', 'r2'),
      asst('a3', [tc('c3', 'baz')]), tool('c3', 'r3')
    ])
    expect(await m.userCompress(run)).not.toBeNull()
    expect(summarize).toHaveBeenCalled()
  })

  it('把用户补充交给写小结', async () => {
    const summarize = vi.fn().mockResolvedValue('小结')
    const m = new ContextWindowManager(makeDeps({ summarizeMessages: summarize }))
    await m.userCompress(multiTaskRun(), { userHint: '重点留部署步骤' })
    expect(summarize).toHaveBeenCalledWith(expect.objectContaining({
      userHint: '重点留部署步骤'
    }))
  })

  it('一场做完（工具 + 收尾）也能压，不要求再留两轮', async () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('写方案'),
      asst('', [tc('c1', 'write_text_file')]), tool('c1', 'x'.repeat(4000)),
      asst('方案写好了')
    ])
    expect(m.canHandoff(run)).toBe(true)
    const result = await m.userCompress(run)
    expect(result).not.toBeNull()
    expect(result!.freedTokens).toBeGreaterThan(0)
  })

  it('短问答人点名了也写交接', async () => {
    const summarize = vi.fn().mockResolvedValue('小结')
    const m = new ContextWindowManager(makeDeps({
      minProactiveRangeTokens: 3000,
      summarizeMessages: summarize
    }))
    const run = makeRun([
      user('现在几点'),
      asst('下午两点')
    ])
    expect(m.canHandoff(run)).toBe(true)
    expect(await m.userCompress(run)).not.toBeNull()
    expect(summarize).toHaveBeenCalled()
  })

  it('上一场做过事、最后只是短收尾，也能压', async () => {
    const m = new ContextWindowManager(makeDeps())
    const run = makeRun([
      user('查磁盘'),
      asst('', [tc('c1', 'exec')]), tool('c1', 'x'.repeat(4000)),
      asst('根分区 80%'),
      user('好的就这样')
    ])
    expect(m.canHandoff(run)).toBe(true)
    expect(await m.userCompress(run)).not.toBeNull()
  })

  it('canHandoff：有用户原话为真，空对话为假', () => {
    const m = new ContextWindowManager(makeDeps({ minProactiveRangeTokens: 3000 }))
    expect(m.canHandoff(makeRun([]))).toBe(false)
    expect(m.canHandoff(makeRun([
      user('现在几点'),
      asst('下午两点')
    ]))).toBe(true)
  })

  it('这一轮还没开始，更早的大段也收得掉', async () => {
    const m = new ContextWindowManager(makeDeps())
    const bulk = '磁盘明细-' + 'x'.repeat(8000)
    const run = makeRun([
      user('查磁盘'),
      asst('', [tc('c1', 'exec')]), tool('c1', bulk),
      asst('根分区 80%'),
      user('压缩一下')
    ])
    const result = await m.userCompress(run)
    expect(result).not.toBeNull()
    expect(result!.freedTokens).toBeGreaterThan(0)
    expect(JSON.stringify(run.compressedArchives)).toContain('磁盘明细-')
    const contents = run.messages.map(msg => String(msg.content))
    expect(contents).toContain('查磁盘')
    expect(contents).toContain('根分区 80%')
    expect(contents).toContain('压缩一下')
    expect(contents.some(c => c.includes('磁盘明细-'))).toBe(false)
  })
})

describe('peelOpenToolTurn', () => {
  it('结果还没写回的工具调用先摘下来，齐了就不动', () => {
    const open = [
      user('压缩一下'),
      asst('', [tc('c9', 'context')])
    ]
    const tail = peelOpenToolTurn(open)
    expect(open).toEqual([user('压缩一下')])
    expect(tail).toEqual([asst('', [tc('c9', 'context')])])

    const done = [
      user('压缩一下'),
      asst('', [tc('c9', 'context')]),
      tool('c9', '已压缩')
    ]
    expect(peelOpenToolTurn(done)).toEqual([])
    expect(done).toHaveLength(3)
  })
})
