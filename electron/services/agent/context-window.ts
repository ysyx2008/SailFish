/**
 * ContextWindowManager —— 上下文窗口管理协作者
 *
 * 从 `Agent` 基类抽出的内聚簇:token 估算 / 用量压力 / 上下文压缩 / 工具调用序列修复。
 * 只操作传入的 `AgentRun`,不持有 Agent 反向引用;Agent 通过 `ContextWindowDeps`
 * 注入它需要的只读依赖(配置、profileId、conversation 的 token 读数、UI 上报回调)。
 *
 * 设计依据:docs/conversation-refactor-design.md「拆 Agent 巨类」试点。
 */
import type { AiProfile } from '@shared/types'
import type { AiMessage } from '../ai.service'
import type { AgentRun } from './types'
import { estimateTextTokens } from './token-estimate'
import { t } from './i18n'
import { createLogger } from '../../utils/logger'
import { resolveRequestBudget } from '../ai-request-budget'

const log = createLogger('ContextWindow')

/**
 * 正在执行的工具回合先摘下来，避免交接把「还没写回结果的那条工具调用」一起收走。
 * 工具结果都齐了，或末尾不是未完成的工具调用，则不动。返回被摘下的尾部（可能为空）。
 */
export function peelOpenToolTurn(messages: AiMessage[]): AiMessage[] {
  let assistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      assistantIdx = i
      break
    }
    if (msg.role === 'user' || msg.role === 'assistant') return []
  }
  if (assistantIdx === -1) return []

  const pending = new Set(messages[assistantIdx].tool_calls!.map(call => call.id))
  for (let i = assistantIdx + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool' && msg.tool_call_id && pending.has(msg.tool_call_id)) {
      pending.delete(msg.tool_call_id)
    }
  }
  if (pending.size === 0) return []
  return messages.splice(assistantIdx)
}

/**
 * 首轮尚无实测时 system prompt 的缺省估值。实测（26 个技能、无用户规则）约 4K，
 * 取整数量级即可——第二轮起就被真实值替换。
 */
const DEFAULT_SYSTEM_PROMPT_TOKENS = 4000

/** Agent 注入的最小只读依赖面。 */
export interface ContextWindowDeps {
  /** AI 配置(取 profiles / active profile)。缺省时回退 128000。 */
  config?: {
    getAiProfiles(): AiProfile[]
    getActiveAiProfile(): string
  }
  /** 当前生效的 profileId(可为 undefined,走 active)。 */
  getProfileId: () => string | undefined
  /** 最近一次 LLM provider 返回的精确 prompt token 数(优先于估算)。 */
  getLastPromptTokens: () => number | undefined
  /** 最近一次的缓存命中率(可选,仅用于 UI 上报)。 */
  getLastCacheHitRate: () => number | undefined
  /** 把 token 用量推到当前 run 的 lastStep + onStep 回调(UI 展示)。 */
  reportUsage: (tokens: number, cacheHitRate?: number) => void
  /**
   * 作废真实用量锚点。压缩后 messages 结构已变,上一轮的 prompt_tokens 不再对应
   * 当前序列,继续拿它当锚点会把已经释放掉的部分算进来。作废后过渡一轮全量估算,
   * 下次 API 响应回来就有新锚点。
   */
  invalidateTokenAnchor?: () => void
  /**
   * 当前请求会带上的工具定义(冷启动全量估算用)。工具 schema 是每次请求都在的
   * 固定开销,实测占一两万 tokens,漏算会让估算严重偏低。
   */
  getTools?: () => Array<unknown>
  /**
   * 消息区间 [fromCount, toCount) 的真实 token 数,来自 API 逐次报告的用量序列。
   * 返回 undefined 表示这段没有真实读数（序列刚作废 / 端点不在记录上）,
   * 调用方回退估算。
   */
  measureMessageRange?: (fromCount: number, toCount: number) => number | undefined
  /**
   * 让 AI 写交接小结（proactive 路径专用：窗口将满、API 还可用时质量最高）。
   *
   * 传的是**当前完整对话**而非待归档切片：小结指令作为一条 user 消息追加在对话
   * 末尾发出去,前缀与上一轮逐字一致,provider 的前缀缓存直接命中；模型也是在原本
   * 的语境里写小结,而不是读一份拍平成文本、还得重新输入一遍的转录。
   *
   * 返回 null 或抛错 → 回退固定模板。
   */
  summarizeMessages?: (opts: { conversation: AiMessage[]; keepRecent: number; userHint?: string }) => Promise<string | null>
  /**
   * 主动压缩的最小可压缩范围（tokens），缺省用 MIN_PROACTIVE_RANGE_TOKENS。
   * 仅测试注入用——生产代码不要传。
   */
  minProactiveRangeTokens?: number
  /**
   * 快满时要不要催它自己调用 `context` 压缩。伙计没有这扇门；人选了不主动压缩时也不催。
   * 不传则催（与旧行为一致）。系统救命压不受影响。
   */
  shouldNudgeModelToCompact?: () => boolean
}

/**
 * 已结束任务的一对：用户原话 + 最终答复。
 *
 * 压缩时这两样逐字保留——用户说过的话是意图的真相源、体积小且不可再生；
 * 只留原话不留结果的话，模型会看到「用户要求了 A」却不知道做没做成，
 * 可能整件事重做一遍，失败与中止的状态尤其要留住，否则会重踩同一个坑。
 */
interface TaskPair {
  user: AiMessage
  userIndex: number
  reply?: AiMessage
  replyIndex?: number
}

/** 这场下一个归档编号。看已有最大号，不看条数，避免缺号时撞上旧 ID。 */
export function nextCompressedArchiveId(archives: Array<{ id: string }>): string {
  let max = 0
  for (const archive of archives) {
    if (!archive.id.startsWith('ca-')) continue
    const n = Number(archive.id.slice(3))
    if (Number.isInteger(n) && n > max) max = n
  }
  return `ca-${max + 1}`
}

/** 压缩结果(供 compress_context 工具回报给 AI)。 */
export interface CompressResult {
  beforeTokens: number
  afterTokens: number
  freedTokens: number
  archiveId: string
  /** 本次压缩实际保留的最近对话轮数（紧急压缩可能从 2 降到 1） */
  keepRecent: number
}

export class ContextWindowManager {
  /** 上下文管理功能激活阈值(用量百分比)。与 85% 警告消息对齐。 */
  static readonly THRESHOLD = 85
  /**
   * 压缩自身需要的空间(tokens)：压缩指令 + 小结输出 + 安全余量。
   *
   * 触发点按这个绝对值算,不按窗口百分比——同一个百分比在不同窗口下含义完全不同:
   * 128K 窗口留 5% 还有 6.4K 够写小结,32K 窗口留 5% 只剩 1.6K,小结写不完就被截断,
   * 压缩本身反倒成了信息丢失的来源。
   *
   * 构成：小结输出 SUMMARY_OUTPUT_BUDGET_CHARS(2000 字,按中文口径约 1.5K tokens)
   * + 压缩指令 + 本轮可能新增的零头。
   *
   * 注意固定前缀(system prompt + 工具 schema)不参与这个判断:剩余空间 =
   * 能发的输入 - 已用,前缀多大在两边同时出现、约掉了。压缩「压不压得动」是另一个问题,
   * 由 MIN_PROACTIVE_RANGE_TOKENS 与实效防抖负责。
   */
  static readonly COMPACTION_RESERVE_TOKENS = 4000

  /**
   * 预留空间占窗口的上限。极小窗口(如 8K)下 4000 会占掉一半,导致刚开场就判定该压缩;
   * 按比例封顶保证任何窗口下都先能正常干活。
   */
  static readonly MAX_RESERVE_RATIO = 0.25

  /**
   * 成对保留的历史任务占「可用空间」的比例。
   *
   * 必须从可用空间（窗口减掉压不掉的固定前缀）里切,不能按整窗切:固定前缀实测
   * 可达 15.6K,32K 窗口下光它就占一半,按整窗切保留项必然超发。
   *
   * 这个上限是本次重构最关键的不变量——成对内容会累积,第二次压缩时上一次留下的
   * 还在、再加上新结束的任务,不设上限就会一路涨到把窗口占满,等于把「压不动」
   * 换个形式重演。有了它,压缩后的规模就与会话跑了多久无关。
   */
  static readonly PRESERVED_PAIRS_RATIO = 0.3

  /**
   * 保留项里单条消息的 token 下限保护。单条超长时只截断该条、不牵连整对——
   * 用户粘进来的大段日志或 AI 写的长报告一条就能吃掉整个预算,但至少要保住
   * 「用户提过这个要求」这件事。
   */
  static readonly MIN_PRESERVED_MESSAGE_TOKENS = 500

  /**
   * 一次主动压缩至少要释放多少 token 才算有效。低于此值说明剩余结构压不动
   * （系统提示词占主导、或历史已全是摘要），继续尝试只是反复烧摘要调用。
   */
  static readonly MIN_EFFECTIVE_FREED_TOKENS = 500

  /**
   * 主动压缩的最小可压缩范围（tokens）。真实 E2E 发现：系统提示词占主导的会话里，
   * 可压缩消息可能只有几百 token，而 AI 小结 + 归档包装本身就近千 token——
   * 压缩反而净增（实测 freed=-148）。低于此下限跳过主动压缩，
   * 等对话积累更多内容后再压；紧急压缩（API 报错兜底）不受此限。
   */
  static readonly MIN_PROACTIVE_RANGE_TOKENS = 3000

  /**
   * 判断错误是否为上下文超限错误。
   *
   * 各 LLM provider 的错误码/消息不同，但 ai.service.ts 在解析到
   * context_length_exceeded（及火山豆包等稳定业务文案）时会统一翻译成
   * t('error.context_length_exceeded')，所以优先匹配翻译后的文案。
   *
   * 注意：这不是"基于关键词的模式分析"——它匹配的是固定的 API 错误码 /
   * provider 协议文案的翻译结果，是稳定的协议字段而非自然语言模式。
   */
  static isContextLimitError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error)
    if (!msg) return false
    // 翻译后的中英文案 + 原始错误码 + 未翻译时漏网的 provider 稳定文案
    return (
      msg.includes('context_length_exceeded') ||
      msg.includes('上下文超出模型限制') ||
      msg.includes('Context length exceeded') ||
      // 火山方舟豆包：code 常为空，message 为固定英文句（见 ai.service isContextLengthApiFailure）
      msg.includes('exceed max message tokens')
    )
  }

  private _enabled = false
  /** 主动压缩已经压不动（上次几乎没释放空间），本任务内不再尝试 */
  private _proactiveCompressStalled = false
  /** 上一轮实测的 system prompt 规模，用于预算分配（见 getFixedPrefixTokens） */
  private _lastSystemPromptTokens?: number
  /** _lastSystemPromptTokens 是在哪个 profile + 模式下测的（换了就作废） */
  private _lastSystemPromptScope?: string

  /**
   * 新任务开始时重置逐任务状态。
   *
   * 本对象由 Agent 持有、跨所有 run 复用,「压不动」这类判定必须按任务清零——
   * 否则某个任务压不动会让**整个会话**永久失去主动压缩能力,只剩紧急压缩兜底,
   * 而对超限默默截断的 provider 那条兜底等于没有。
   *
   * `_enabled`（上下文管理工具是否可用）刻意不清:它一旦激活就不回退。
   */
  resetForNewRun(): void {
    this._proactiveCompressStalled = false
  }

  constructor(private deps: ContextWindowDeps) {}

  /** 用量是否已到高水位。一旦激活不回退（压缩后用量可能降低）。查看/压缩从一开始就在；高水位才带记忆管理。 */
  get enabled(): boolean {
    return this._enabled
  }

  /**
   * 这次「能不能发」所对照的配置。
   * 指定了 id 却找不到 → undefined（保守窗口），不借 active / 第一个的大窗口。
   * 没指定 id → active → 列表第一个。
   */
  private getBudgetProfile(): AiProfile | undefined {
    const config = this.deps.config
    if (!config) return undefined

    const profiles = config.getAiProfiles()
    if (profiles.length === 0) return undefined

    const profileId = this.deps.getProfileId()
    if (profileId) {
      return profiles.find(p => p.id === profileId)
    }

    const activeId = config.getActiveAiProfile()
    return profiles.find(p => p.id === activeId) || profiles[0]
  }

  /**
   * 整窗长度（界面用量、账单对照）。指定配置找不到时按保守 128000，不借旁边那套。
   */
  getContextLength(): number {
    return resolveRequestBudget(this.getBudgetProfile()).contextLength
  }

  /**
   * 这次还能发多少输入：整窗先扣输出额度和余量。
   * 写交接小结时可传入更紧的输出上限。
   */
  getInputLimit(outputOverride?: number): number {
    return resolveRequestBudget(this.getBudgetProfile(), outputOverride).inputLimit
  }

  /**
   * 按当前估算，发出去会不会先把输入预算撑破（冷启动无真实用量也算）。
   */
  needsRequestCompaction(run: AgentRun, outputOverride?: number): boolean {
    return this.estimateSendableTokens(run.messages) > this.getInputLimit(outputOverride)
  }

  /**
   * 这一次发出去会占多少：有真实锚点跟账单走；冷启动补上 system prompt
   *（全量估算本来只计消息 + 工具 schema）。
   */
  private estimateSendableTokens(messages: AiMessage[]): number {
    const used = this.estimateCurrentPromptTokens(messages)
    if (this.deps.getLastPromptTokens() !== undefined) return used
    const systemTokens = this._lastSystemPromptTokens ?? DEFAULT_SYSTEM_PROMPT_TOKENS
    return used + systemTokens
  }

  /**
   * 估算文本的 token 数量(委托共享纯函数 estimateTextTokens)。
   * 保留实例方法形态,供 estimateTotalTokens 内部调用及单测直接验证。
   */
  estimateTokens(text: string | null | undefined): number {
    return estimateTextTokens(text)
  }

  /**
   * 全量估算一次请求的 prompt 规模:消息列表 + 工具 schema 固定开销。
   *
   * 仅用于够不着真实用量的场合(冷启动首轮、锚点刚被作废)。有锚点时一律走
   * estimateCurrentPromptTokens——全量估算的系统性偏差会随历史长度累积放大。
   */
  estimateTotalTokens(messages: AiMessage[]): number {
    return this.estimateMessagesTokens(messages) + this.estimateFixedOverheadTokens()
  }

  /**
   * 工具 schema 的固定开销。每次请求都随行,实测（28 个内置工具）约 9.5K tokens,
   * 装了技能/插件/MCP 后更大——按常数估会严重偏低。
   * 拿不到工具列表时退回经验值 4000（历史缺省）。
   */
  private estimateFixedOverheadTokens(): number {
    const tools = this.deps.getTools?.()
    if (!tools || tools.length === 0) return 4000
    return this.estimateTokens(JSON.stringify(tools))
  }

  /**
   * 一次请求里雷打不动的部分:工具 schema + system prompt。历史预算必须在
   * 「窗口减去它」的剩余空间里分配。
   *
   * system prompt 自身含历史摘要,与预算互为因果,所以取**上一轮实测值**打破
   * 循环——同一 Agent 内它高度稳定,首轮用保守缺省。
   *
   * 注意这里对历史留了双重余量:读数含 system prompt 里的历史摘要,而预算又单独
   * 给历史切了一份。刻意不去精确拆分——方向是保守的(历史宁可少塞不超发),而按
   * 段落拆解 system prompt 只会换来易错的复杂度。别当 bug 修。
   */
  getFixedPrefixTokens(scope?: string): number {
    const systemPromptTokens =
      this._lastSystemPromptTokens !== undefined && this._lastSystemPromptScope === scope
        ? this._lastSystemPromptTokens
        : DEFAULT_SYSTEM_PROMPT_TOKENS
    return this.estimateFixedOverheadTokens() + systemPromptTokens
  }

  /**
   * 记下本轮 system prompt 的规模（估算值,非 API 真值）,供下一轮预算分配使用。
   *
   * `scope` 标识这个读数是在哪个 profile + 终端模式下取的。换了 profile 或模式
   * （local/ssh/assistant 的 system prompt 规模差异可达数千 tokens）后读数不再适用,
   * 下次会退回缺省值重新自校准,而不是拿旧配置的规模去切新配置的预算。
   */
  recordSystemPromptTokens(systemPrompt: string, scope?: string): void {
    this._lastSystemPromptTokens = this.estimateTokens(systemPrompt)
    this._lastSystemPromptScope = scope
  }

  /**
   * 当前请求的 prompt token 数:以上一轮 API 返回的真实 prompt_tokens 为锚点,
   * 只估算那之后新增的消息。
   *
   * 为什么不全量重估:估算公式的系统性偏差会乘以历史长度。锚点法把估算的作用
   * 范围压到「上一轮响应至今」的几条消息,同时让各家 provider 的分词差异被真实
   * 用量自动吸收,不必为每个模型分别调系数。（同 Codex Harness 的口径。）
   *
   * 锚点覆盖到上一轮请求发出去的全部内容;那之后新增的是「上一轮的 assistant
   * 回复 + 其后的 tool 结果 / 新 user 消息」,所以从最后一条 assistant 消息起算。
   */
  estimateCurrentPromptTokens(messages: AiMessage[]): number {
    const anchor = this.deps.getLastPromptTokens()
    if (anchor === undefined) return this.estimateTotalTokens(messages)

    let lastAssistantIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantIdx = i
        break
      }
    }
    // 没有 assistant 消息 = 还没发生过响应,锚点无从对应,退回全量估算
    if (lastAssistantIdx === -1) return this.estimateTotalTokens(messages)

    return anchor + this.estimateMessagesTokens(messages.slice(lastAssistantIdx))
  }

  /** 仅估算消息列表本身的 token（不含系统提示词等固定开销） */
  estimateMessagesTokens(messages: AiMessage[]): number {
    const MESSAGE_OVERHEAD = 4
    // 多模态图片 token 估算（保守上限）：OpenAI high detail 模式下 1024×1024=765、
    // 1920×1080=595、2048×4096=1105；Anthropic 面积公式约 1590 封顶。取 1500 作为
    // 单张图保守估值——宁可高估触发 cache path 跳过/cold start 重建，也不要低估导致
    // 真实 prompt 超过模型上下文窗口被 LLM 截断（图片发出去但 AI 收不到）。
    const IMAGE_TOKENS_PER_ITEM = 1500

    return messages.reduce((sum, msg) => {
      let tokens = this.estimateTokens(msg.content) + MESSAGE_OVERHEAD
      if (msg.tool_calls) {
        tokens += msg.tool_calls.reduce(
          (t, tc) => t + this.estimateTokens(tc.function.name) + this.estimateTokens(tc.function.arguments),
          0
        )
      }
      if (msg.reasoning_content) {
        tokens += this.estimateTokens(msg.reasoning_content)
      }
      // 多模态图片：base64 data URL 在 formatMessageForApi 中转为 image_url content part，
      // 由 LLM 按 tile/patch 算法计费。这里保守按固定值估算，避免 cache path 判断漏算图片
      // 导致 prevTokens 严重低估（companion 长会话累积历史带图消息时尤其影响）。
      if (msg.images && msg.images.length > 0) {
        tokens += msg.images.length * IMAGE_TOKENS_PER_ITEM
      }
      return sum + tokens
    }, 0)
  }

  /**
   * 更新上下文压力状态:注入用量到 UI + 渐进式提醒。
   *
   * 设计原则:程序只提供信息,所有压缩决策由 AI 做。
   * - < 85%: 不注入告警(最大化前缀缓存命中)
   * - >= 85%: 注入警告消息到 messages 末尾（查看/压缩工具从一开始就在）
   * - API 自然报错 context_length_exceeded: emergencyCompress 自动压缩兜底
   *   (见 executeLoop catch → ContextWindowManager.isContextLimitError → emergencyCompress)
   */
  updatePressure(run: AgentRun): void {
    const inputLimit = this.getInputLimit()
    const lastPromptTokens = this.deps.getLastPromptTokens()
    const hasRealData = lastPromptTokens !== undefined
    // 压力判断用「真实锚点 + 本轮新增」：ReAct 循环里 tool 结果持续累积,
    // 只看上一轮的锚点会低估,等下一次 API 响应才发现已经撑满。
    const totalTokens = this.estimateCurrentPromptTokens(run.messages)
    // 界面数字仍按整窗（对账单）；激活工具 / 告警按能发的输入，免得栏还很空就已经拦发送
    const sendUsagePercent = Math.round((totalTokens / inputLimit) * 100)
    const remaining = Math.max(0, inputLimit - totalTokens)

    // 推给 UI 的仍是 API 确认过的原值:界面上的数字必须能对得上账单,
    // 不掺估算（SPEC: 本轮 usage 以 API 为唯一真相源）。
    if (hasRealData) {
      this.deps.reportUsage(lastPromptTokens, this.deps.getLastCacheHitRate())
    }

    // 超过阈值时记下「已经告过警」(一旦激活不会关闭,因为压缩后用量可能降低)
    if (!this._enabled && sendUsagePercent >= ContextWindowManager.THRESHOLD) {
      this._enabled = true
    }

    // [缓存优化] 「上下文状态注入系统提示词」已禁用:每轮用量数字都变,注入系统提示
    // 会破坏 DeepSeek/OpenAI/Anthropic 前缀缓存。上下文压力由下方 85% 警告消息兜底。

    // 85%+ 额外注入警告消息(避免重复注入)。伙计没有这扇门，不主动压缩也不催它自己压。
    if (sendUsagePercent >= 85 && (this.deps.shouldNudgeModelToCompact?.() ?? true)) {
      const lastMsg = run.messages[run.messages.length - 1]
      const lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : ''
      const isAlreadyWarned =
        lastMsg?.role === 'user' &&
        (lastText.includes('[系统] 上下文用量告警') || lastText.includes('[System] Context usage critical'))

      if (!isAlreadyWarned) {
        run.messages.push({
          role: 'user',
          content: t('agent.context_pressure_warning', {
            percentage: sendUsagePercent,
            remaining: remaining.toLocaleString()
          }),
          _systemInjected: true
        })
      }
    }
  }

  /**
   * 计算可压缩范围：当前任务（最后一条真实 user 消息之后）中，除最近 keepRecent 组
   * assistant 轮次之外的早期消息。proactive 的摘要装配与 compress 共用此计算，
   * 保证「摘要覆盖的消息」与「实际归档的消息」一致。
   */
  /** 最后一条用户真正说的话。系统注入的 user（用量告警等）不算任务边界。 */
  private findLastRealUserIndex(messages: AiMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user' && !messages[i]._systemInjected) return i
    }
    return -1
  }

  private findCompressibleRange(run: AgentRun, keepRecent: number): { lastUserIndex: number; toCompress: AiMessage[] } | null {
    const lastUserIndex = this.findLastRealUserIndex(run.messages)

    if (lastUserIndex === -1) return null

    // 当前任务的消息(user 消息之后到末尾)
    const taskMessages = run.messages.slice(lastUserIndex + 1)

    // 从后往前数 keepRecent 组(每组以 assistant 起头)
    let keepFromIndex = taskMessages.length
    let groupCount = 0
    for (let i = taskMessages.length - 1; i >= 0; i--) {
      if (taskMessages[i].role === 'assistant') {
        groupCount++
        if (groupCount >= keepRecent) {
          keepFromIndex = i
          break
        }
      }
    }

    const toCompress = taskMessages.slice(0, keepFromIndex)
    if (toCompress.length === 0) return null
    return { lastUserIndex, toCompress }
  }

  /** 成对保留的历史任务预算：从可用空间（能发的输入 - 固定前缀）里切。 */
  getPreservedPairsBudget(): number {
    const available = Math.max(0, this.getInputLimit() - this.getFixedPrefixTokens(this._lastSystemPromptScope))
    return Math.floor(available * ContextWindowManager.PRESERVED_PAIRS_RATIO)
  }

  /**
   * 把 [0, endIndex) 内的消息按真实 user 消息切成「用户原话 + 最终答复」对。
   *
   * 系统注入的 user 消息（用量告警之类）不构成任务边界——那不是用户说的话。
   * 最终答复取该任务里最后一条不带 tool_calls 的 assistant 消息：带 tool_calls 的
   * 是中间过程，只有纯文本那条才是给用户的交代。
   */
  private extractTaskPairs(messages: AiMessage[], endIndex: number): TaskPair[] {
    const pairs: TaskPair[] = []
    let current: TaskPair | undefined
    for (let i = 0; i < endIndex; i++) {
      const msg = messages[i]
      if (msg.role === 'system') continue
      if (msg.role === 'user' && !msg._systemInjected) {
        if (current) pairs.push(current)
        current = { user: msg, userIndex: i }
        continue
      }
      if (!current) continue
      const isPlainReply =
        msg.role === 'assistant' &&
        !msg.tool_calls?.length &&
        typeof msg.content === 'string' &&
        msg.content.trim().length > 0
      if (isPlainReply) {
        current.reply = msg
        current.replyIndex = i
      }
    }
    if (current) pairs.push(current)
    return pairs
  }

  /**
   * 按预算从最近往前选成对内容。超预算的老任务整对移出（进归档，可取回）。
   *
   * 被移出的老任务不等于信息丢失：AI 写小结时看得见完整对话，重要的它会写进去。
   * 近期靠精确保留，远期靠 AI 挑重点，两者互补。
   */
  private selectPairsWithinBudget(
    pairs: TaskPair[],
    budgetTokens: number,
    archiveId: string
  ): { messages: AiMessage[]; keptIndices: Set<number> } {
    const perMessageCap = Math.max(
      ContextWindowManager.MIN_PRESERVED_MESSAGE_TOKENS,
      Math.floor(budgetTokens / 4)
    )
    const messages: AiMessage[] = []
    const keptIndices = new Set<number>()
    let remaining = budgetTokens

    for (let i = pairs.length - 1; i >= 0; i--) {
      const pair = pairs[i]
      const user = this.capMessage(pair.user, perMessageCap, archiveId)
      // 任务没有最终答复（被中止/还没答就转入下一件事）时补一条状态，
      // 既留住「这件事没有收尾」这个事实，也避免保留序列里出现连续两条 user
      const reply = pair.reply
        ? this.capMessage(pair.reply, perMessageCap, archiveId)
        : { role: 'assistant' as const, content: t('agent.compress_pair_no_reply') }
      const cost = this.estimateMessagesTokens([user, reply])
      // 预算再紧也要留下最近一对：用户原话是意图的真相源，一条不留的话模型
      // 连"要做什么"都不知道，压缩就把任务本身弄丢了
      if (cost > remaining && messages.length > 0) break
      remaining -= cost
      messages.unshift(reply)
      messages.unshift(user)
      keptIndices.add(pair.userIndex)
      if (pair.replyIndex !== undefined) keptIndices.add(pair.replyIndex)
    }

    return { messages, keptIndices }
  }

  /** 单条超长时截断保留头部，标注归档 ID 让 AI 知道去哪找全文。 */
  private capMessage(msg: AiMessage, capTokens: number, archiveId: string): AiMessage {
    const content = typeof msg.content === 'string' ? msg.content : ''
    if (this.estimateTokens(content) <= capTokens) return { ...msg }
    // 按字符数截断：中文一个字约 0.75 token，取 capTokens 个字符对任何语种都不会超预算
    const kept = content.slice(0, capTokens)
    return {
      ...msg,
      content: `${kept}\n\n[内容过长已截断，完整原文见归档 "${archiveId}"，可用 recall(archive_id: "${archiveId}") 取回]`
    }
  }

  /**
   * 把已写好的小结套进给定范围。人按压缩和它自己压都不走这里，
   * 它们走 userCompress（同一套交接）。
   */
  compress(run: AgentRun, summary: string, keepRecent: number): CompressResult | null {
    return this.doCompress(run, summary, keepRecent, this.findCompressibleRange(run, keepRecent))
  }

  /** 压缩实现主体：range 为 null 表示当前结构不可压缩 */
  private doCompress(
    run: AgentRun,
    summary: string,
    keepRecent: number,
    range: { lastUserIndex: number; toCompress: AiMessage[] } | null
  ): CompressResult | null {
    if (!range) return null
    const { lastUserIndex, toCompress } = range

    const beforeTokens = this.estimateTotalTokens(run.messages)

    // 编号按这场已有归档的最大号接着走，不按条数。条数在缺号时会撞上旧 ID。
    if (!run.compressedArchives) {
      run.compressedArchives = []
    }
    const archiveId = nextCompressedArchiveId(run.compressedArchives)

    // 段 A：当前任务之前的历史。成对提取「用户原话 + 最终答复」，按预算从近往远
    // 保留，其余（中间过程的 assistant/tool）连同段 B 一起进归档。
    const systemMessages = run.messages.slice(0, lastUserIndex).filter(m => m.role === 'system')
    const pairs = this.extractTaskPairs(run.messages, lastUserIndex)
    const { messages: preservedHistory, keptIndices } = this.selectPairsWithinBudget(
      pairs,
      this.getPreservedPairsBudget(),
      archiveId
    )
    const historyArchived = run.messages
      .slice(0, lastUserIndex)
      .filter((m, i) => m.role !== 'system' && !keptIndices.has(i))

    if (toCompress.length === 0 && historyArchived.length === 0) return null

    // 归档原始消息(深拷贝,防止后续 run.messages 修改影响归档)
    run.compressedArchives.push({
      id: archiveId,
      messages: JSON.parse(JSON.stringify([...historyArchived, ...toCompress])),
      summary,
      timestamp: Date.now()
    })

    // 替换:用一条摘要消息替换被压缩的消息
    const summaryMessage: AiMessage = {
      role: 'assistant',
      content: `[早期对话已压缩，归档 ID: "${archiveId}"。如需查看原始内容，请调用 recall(archive_id: "${archiveId}")。]\n\n${summary}`
    }

    log.info(
      `Compress layout: ${pairs.length} history tasks → kept ${preservedHistory.length} messages ` +
      `(budget ${this.getPreservedPairsBudget()} tokens), archived ${historyArchived.length} history + ${toCompress.length} current-task messages`
    )

    // 重建 messages: system + 成对保留的历史 + 当前 user + 摘要 + 保留的最近消息
    //
    // 摘要放在当前 user 之后：它主要覆盖的是这条请求之后的执行步骤（段 B），
    // 放到请求之前会让时序错乱。这个位置同时让角色天然交替——成对历史以
    // assistant 收尾、接 user、再接 assistant 摘要，不会出现连续同角色。
    const preserved = run.messages.slice(lastUserIndex + 1 + toCompress.length)
    run.messages = [
      ...systemMessages,
      ...preservedHistory,
      run.messages[lastUserIndex],
      summaryMessage,
      ...preserved
    ]

    // 序列已变,上一轮的 prompt_tokens 不再对应当前 messages——继续拿它当锚点
    // 会把刚刚释放掉的部分又算回来,压缩看起来"没生效"。
    this.deps.invalidateTokenAnchor?.()

    const afterTokens = this.estimateTotalTokens(run.messages)

    return {
      beforeTokens,
      afterTokens,
      freedTokens: beforeTokens - afterTokens,
      archiveId,
      keepRecent
    }
  }

  /**
   * 紧急压缩：当 API 返回 context_length_exceeded 时作为最终兜底。
   *
   * 与常规 compress 的区别：
   * - 更激进：keepRecent=2（常规默认 4），尽量多释放空间
   * - 多次尝试：先 keepRecent=2，若释放不足再 keepRecent=1
   * - 不依赖 AI 调用 compress_context 工具（AI 可能忽略 85% 警告）
   *
   * @returns 压缩结果；若 messages 结构不允许压缩（如无 user 消息）返回 null
   */
  emergencyCompress(run: AgentRun): CompressResult | null {
    const result = this.compressAggressively(run, this.buildEmergencySummary())
    if (result) {
      log.info(`Emergency compress: freed ${result.freedTokens} tokens, kept recent ${result.keepRecent} rounds (archive ${result.archiveId})`)
    }
    return result
  }

  /**
   * 是否应该主动压缩（本地触发路径，不等 API 报错）。
   *
   * 触发条件：窗口剩余空间已经装不下「写一份交接小结」所需的量（见
   * COMPACTION_RESERVE_TOKENS）。常态下不因为历史变长就主动动手——不动前缀才能
   * 把 provider 的前缀缓存吃满，压缩是接近装满时的一次性动作。
   *
   * 仍要求有真实用量锚点，无真实值（首次对话 / cold start）时不触发——避免估算误差导致误压缩。
   * 这条要求同时提供了天然的轮次间隔：压缩会作废锚点，必须等下一次 API 响应
   * 拿到新的真实值才可能再压，不会在同一轮里连续压。
   *
   * 不限制次数（SPEC「一次任务里该压几次就压几次」）：长任务压完一轮照样会重新
   * 涨满，限制次数等于把后续交给"等 API 报错"，而对超限默默截断的 provider
   * 那条路等于没有。防抖改为要求实效——上一次压不动就不再空转（_proactiveCompressStalled）。
   *
   * 与 emergencyCompress 的分工：
   * - 本方法在 API 调用前主动压缩（基于上一轮真实值预测本轮会超限）
   * - emergencyCompress 在 API 调用失败后兜底（针对真报 context_length_exceeded 的 provider）
   * - DeepSeek 等不报错的 provider：本方法能在"超限但 API 默默截断"前主动压缩，保住上下文质量
   */
  shouldProactiveCompress(run: AgentRun): boolean {
    if (this._proactiveCompressStalled) return false  // 上次压不动，不再空转
    // 必须有真实锚点：冷启动首轮不赌纯估算，避免刚建好的上下文被误压
    if (this.deps.getLastPromptTokens() === undefined) return false
    // 判断值含本轮新增：锚点只反映上一轮请求的规模，单步塞进一大段 tool 输出时
    // 实际已经装不下了而锚点还停在安全线内——只看锚点会滞后一轮，压缩赶不上超限。
    // 对照能发的输入（已扣输出额度），不要拿整窗当还能塞多少
    const remaining = this.getInputLimit() - this.estimateCurrentPromptTokens(run.messages)
    return remaining < this.getCompactionReserveTokens()
  }

  /**
   * 一段消息的规模：优先用 API 报告过的真实读数，没有才估算。
   *
   * 压缩决策（保留几轮、这次能释放多少）用它取代纯估算——真实读数不花钱、
   * 不受中英文比例与工具 schema 影响，比任何系数都准。
   */
  measureMessages(run: AgentRun, fromCount: number, toCount: number): number {
    const real = this.deps.measureMessageRange?.(fromCount, toCount)
    if (real !== undefined) return real
    return this.estimateMessagesTokens(run.messages.slice(fromCount, toCount))
  }

  /**
   * 压缩自身需要预留的空间。取绝对值与「窗口 × 比例上限」的较小者：
   * 绝对值保证大窗口下不会为了凑比例而过早压缩，比例上限保证小窗口下预留
   * 不会大到刚开场就判定该压。
   */
  getCompactionReserveTokens(): number {
    return Math.min(
      ContextWindowManager.COMPACTION_RESERVE_TOKENS,
      Math.floor(this.getContextLength() * ContextWindowManager.MAX_RESERVE_RATIO)
    )
  }

  /**
   * 主动压缩（本地触发）：先让 AI 为待归档消息写小结（窗口将满、API 还可用时
   * 摘要质量最高），小结直接替换被归档的早期对话；摘要调用失败/不可用才回退
   * 固定模板。压缩动作本身复用 emergencyCompress 的激进逻辑。
   *
   * 不限次数（长任务压完还会涨回来），但压不动就停手——见 shouldProactiveCompress。
   *
   * @returns 压缩结果；若已判定压不动或 messages 结构不允许压缩返回 null
   */
  async proactiveCompress(run: AgentRun): Promise<CompressResult | null> {
    if (this._proactiveCompressStalled) return null
    const result = await this.compressByHandoff(run)
    if (result && result.freedTokens < ContextWindowManager.MIN_EFFECTIVE_FREED_TOKENS) {
      this._proactiveCompressStalled = true
      log.warn(`Proactive compress stalled: only freed ${result.freedTokens} tokens, disabling further attempts this task`)
    }
    return result
  }

  /**
   * 用户主动压缩：不看窗口是否快满，也不吃「上次压不动」的停手。
   * 有用户原话就写交接；空对话才空手返回。
   */
  async userCompress(run: AgentRun, opts?: { userHint?: string }): Promise<CompressResult | null> {
    const lastUserIndex = this.findLastRealUserIndex(run.messages)
    if (lastUserIndex === -1) return null
    const range2 = this.findCompressibleRange(run, 2)
    const range1 = this.findCompressibleRange(run, 1)
    const range = range2 ?? range1 ?? { lastUserIndex, toCompress: [] as AiMessage[] }
    const keepRecent = range2 ? this.decideKeepRecent(run, range2) : 1
    return this.compressByHandoff(run, {
      userHint: opts?.userHint,
      plan: { keepRecent, range },
      skipMinRange: true
    })
  }

  /** 这场里有没有用户真正说过的话。人点名压时只拿这个挡空对话。 */
  canHandoff(run: AgentRun): boolean {
    return this.findLastRealUserIndex(run.messages) !== -1
  }

  private async compressByHandoff(run: AgentRun, opts?: {
    userHint?: string
    plan?: { keepRecent: number; range: { lastUserIndex: number; toCompress: AiMessage[] } }
    skipMinRange?: boolean
  }): Promise<CompressResult | null> {
    // 可压缩范围只算一次：摘要装配与实际归档必须用同一份消息切片，
    // 否则「摘要覆盖的内容」和「被归档的内容」可能不一致
    const range = opts?.plan?.range ?? this.findCompressibleRange(run, 2)
    if (!range) return null
    // 自动压：范围太小是负收益，跳过，不算"压不动"。人点名则不拦。
    if (!opts?.skipMinRange) {
      const minRange = this.deps.minProactiveRangeTokens ?? ContextWindowManager.MIN_PROACTIVE_RANGE_TOKENS
      const rangeTokens = this.measureMessages(
        run,
        range.lastUserIndex + 1,
        range.lastUserIndex + 1 + range.toCompress.length
      )
      if (rangeTokens < minRange) {
        log.info(`Handoff compress skipped: compressible range too small (~${rangeTokens} tokens < ${minRange})`)
        return null
      }
    }
    // 保留几轮必须在写小结**之前**定下来：提示词要如实告诉模型压完还能看到几轮，
    // 模型据此判断哪些不必重复写。若沿用「先按 2 轮压、发现还紧张再降到 1 轮」，
    // 承诺就与实际不符，模型以为还看得见而省略的内容会真的丢掉。
    const keepRecent = opts?.plan?.keepRecent ?? this.decideKeepRecent(run, range)
    const effectiveRange = opts?.plan
      ? range
      : keepRecent === 2
        ? range
        : this.findCompressibleRange(run, keepRecent)
    if (!effectiveRange) return null

    const summary = await this.buildProactiveSummary(run.messages, keepRecent, opts?.userHint)
    const result = this.compressWithRange(run, summary, keepRecent, effectiveRange)
    if (result) this._enabled = true
    if (result) {
      log.info(`Handoff compress: freed ${result.freedTokens} tokens, kept recent ${result.keepRecent} rounds (archive ${result.archiveId})`)
    }
    return result
  }

  /**
   * 压之前算好保留几轮。
   *
   * 压缩后的规模 ≈ 固定前缀 + 成对保留 + 小结 + 最近 N 轮，其中「最近 N 轮多大」
   * 有真实读数可用（相邻两次用量相减），算得准，不必压完看比例再降级——事后降级
   * 会让提示词承诺的保留轮数与实际不符。装不下就降到 1 轮。
   */
  private decideKeepRecent(
    run: AgentRun,
    range: { lastUserIndex: number; toCompress: AiMessage[] }
  ): number {
    const inputLimit = this.getInputLimit()
    const recentStart = range.lastUserIndex + 1 + range.toCompress.length
    const recentTokens = this.measureMessages(run, recentStart, run.messages.length)
    const projected =
      this.getFixedPrefixTokens(this._lastSystemPromptScope) +
      this.getPreservedPairsBudget() +
      ContextWindowManager.COMPACTION_RESERVE_TOKENS +
      recentTokens
    return projected > inputLimit * 0.9 ? 1 : 2
  }

  /**
   * 主动压缩的摘要：优先让 AI 在完整对话里写交接小结（写给未来的自己），
   * 失败/不可用才回退固定模板。
   */
  private async buildProactiveSummary(
    conversation: AiMessage[],
    keepRecent: number,
    userHint?: string
  ): Promise<string> {
    const summarize = this.deps.summarizeMessages
    if (summarize) {
      try {
        // keepRecent 如实传给提示词：小结里说"还能看到最近几轮"必须与实际保留一致，
        // 模型据此判断哪些内容不必重复写
        const aiSummary = await summarize({ conversation, keepRecent, userHint })
        if (aiSummary && aiSummary.trim()) return aiSummary.trim()
      } catch (err) {
        log.warn(`AI 小结生成失败，回退固定模板: ${err}`)
      }
    }
    return this.buildProactiveTemplateSummary()
  }

  /**
   * 紧急压缩的实现：先 keepRecent=2，若压缩后仍 >90% 再降到 keepRecent=1。
   *
   * 只服务 emergencyCompress（API 已报超限）。那条路用的是固定模板摘要，事后降级
   * 不存在「承诺与实际不符」的问题；主动压缩则必须在写小结前就定下保留轮数，
   * 见 decideKeepRecent。
   */
  private compressAggressively(
    run: AgentRun,
    summary: string,
    precomputedRange?: { lastUserIndex: number; toCompress: AiMessage[] }
  ): CompressResult | null {
    let result = this.compressWithRange(run, summary, 2, precomputedRange)
    if (result) {
      const afterUsage = this.estimateTotalTokens(run.messages) / this.getInputLimit()
      if (afterUsage > 0.9) {
        // 降级到 keepRecent=1 时归档范围比摘要装配时多一组最近轮次（该轮未进摘要但完整在归档里），补说明避免误读
        const result2 = this.compressWithRange(run, summary + '\n\n（注：归档后上下文仍紧张，归档范围扩大为仅保留最近 1 轮；多归档的那一轮未纳入本摘要，但完整内容仍在归档中，可用 recall(archive_id) 查看。）', 1)
        if (result2) {
          result = result2
        }
      }
      this._enabled = true
    }
    return result
  }

  /** compress 的内部实现：允许调用方传入预计算范围（仅当 keepRecent 与范围匹配时） */
  private compressWithRange(
    run: AgentRun,
    summary: string,
    keepRecent: number,
    range?: { lastUserIndex: number; toCompress: AiMessage[] }
  ): CompressResult | null {
    return this.doCompress(run, summary, keepRecent, range ?? this.findCompressibleRange(run, keepRecent))
  }

  /**
   * 构建紧急压缩的摘要文本。不依赖 AI 生成摘要（API 已不可用），
   * 用结构化占位让 AI 知道这段对话被压缩了、可以从归档找回。
   */
  private buildEmergencySummary(): string {
    return '【系统自动压缩】此前的对话因超出模型上下文限制已被紧急归档。' +
      '关键信息摘要请参考上方的 task_memory / 知识文档；如需原始对话细节，请调用 recall(archive_id) 找回。'
  }

  /**
   * 构建主动压缩的固定模板摘要（AI 小结不可用时的兜底）。此时 API 尚未报错，
   * 是基于上一轮真实 token 用量预测本轮会超限而提前压缩。
   */
  private buildProactiveTemplateSummary(): string {
    return '【系统主动压缩】检测到上下文用量即将达到模型上限（基于上一轮真实 token 用量），' +
      '为避免本轮请求超限，已提前归档早期对话。关键信息摘要请参考上方的 task_memory / 知识文档；' +
      '如需原始对话细节，请调用 recall(archive_id) 找回。'
  }

  /**
   * 修复不完整的工具调用序列:用户中断或运行抛错时,可能存在 assistant 消息(含 tool_calls)
   * 但缺少对应的 tool result。同时镜像写入 taskMessageLog,确保下次任务的 cache path / cold start
   * 看到的对话序列合法。
   *
   * @param placeholder 占位 tool result 的内容(默认按"用户中断"语义;错误路径应传入更具体的描述)
   */
  fixIncompleteToolCalls(run: AgentRun, placeholder: string = '[操作被用户中断]'): void {
    const { messages } = run
    if (messages.length === 0) return

    // 从后往前查找最后一个带有 tool_calls 的 assistant 消息
    let lastAssistantWithToolCallsIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        lastAssistantWithToolCallsIndex = i
        break
      }
      // 如果遇到 user 消息,说明之前的对话是完整的
      if (msg.role === 'user') break
    }

    if (lastAssistantWithToolCallsIndex === -1) return

    const assistantMsg = messages[lastAssistantWithToolCallsIndex]
    const toolCalls = assistantMsg.tool_calls!

    // 收集该 assistant 消息之后已有的 tool result
    const existingToolCallIds = new Set<string>()
    for (let i = lastAssistantWithToolCallsIndex + 1; i < messages.length; i++) {
      const msg = messages[i]
      if (msg.role === 'tool' && msg.tool_call_id) {
        existingToolCallIds.add(msg.tool_call_id)
      }
    }

    // 为缺失的 tool_call_id 添加占位的 tool result
    const missingToolCalls = toolCalls.filter(tc => !existingToolCallIds.has(tc.id))
    if (missingToolCalls.length > 0) {
      log.info(`修复 ${missingToolCalls.length} 个缺失的 tool result 消息`)
      for (const tc of missingToolCalls) {
        const toolMsg: AiMessage = {
          role: 'tool',
          content: placeholder,
          tool_call_id: tc.id
        }
        messages.push(toolMsg)
        // 镜像写入 taskMessageLog:保持 append-only 的对话日志与 messages 同步,
        // 否则 TaskMemory 持久化的 messages 会缺失 tool result,下次任务复用时序列违法
        run.taskMessageLog.push({ ...toolMsg })
      }
    }
  }
}
