/**
 * 记忆（L2 知识文档）更新的时机与请求。
 *
 * 接在刚跑完的那场对话后面问：前缀与上一轮一字不差、工具清单照带，能吃到缓存，
 * 模型看到的也是完整对话和工具原文。写什么、怎么并回原文归记忆服务，这里只管
 * 什么时候问、拿哪段对话问。设计目标见 knowledge/SPEC.md「更新记忆时看完整对话」。
 *
 * 时机：
 * - 自上次更新以来新增的内容攒够一定量，一轮跑完就问
 * - 没攒够的，一阵没人接着说话再问（赶在缓存还有效时）
 * - 上下文交接之前必问——交接以后原文就不在了
 * - 会话要换掉（新对话、关掉、换会话）之前，把没记的补上
 */
import type { AiMessage, ChatWithToolsResult, ToolDefinition } from '../ai.service'
import { createLogger } from '../../utils/logger'

const log = createLogger('MemoryRefresh')

export interface MemoryRefreshKnowledge {
  buildRefreshInstruction(contextIds: readonly string[], visibleText: string): string
  applyRefreshResponse(response: string, contextIds: readonly string[]): string[]
  getMaxDocChars(): number
}

export interface MemoryRefreshDeps {
  chatWithTools?: (
    messages: AiMessage[],
    tools: ToolDefinition[],
    profileId?: string,
    signal?: AbortSignal,
    options?: { toolChoice?: 'auto' | 'none'; maxOutputTokens?: number }
  ) => Promise<ChatWithToolsResult>
  /** 与对话本身同一份工具清单（前缀的一部分） */
  getTools: () => ToolDefinition[]
  /** 与对话本身同一个模型，否则吃不到那份缓存 */
  getProfileId: () => string | undefined
  /** 这段消息作为一次请求发出时的规模（有真实用量时以它为锚） */
  measurePrompt: (messages: AiMessage[]) => number
  /** 只算开头的系统说明和工具清单：一场对话新开时内容从这里起算 */
  measureFixed: (messages: AiMessage[]) => number
  /** 扣掉给定输出额度后，这次请求还能放多少输入 */
  inputLimit: (maxOutputTokens: number) => number
  knowledge: MemoryRefreshKnowledge
}

export interface MemoryRefreshOptions {
  refreshEveryTokens?: number
  idleDelayMs?: number
}

export class MemoryRefresher {
  static readonly REFRESH_EVERY_TOKENS = 8000
  /** 常见缓存有效期约 5 分钟，空闲那次要在那之前发 */
  static readonly IDLE_DELAY_MS = 90_000
  private static readonly MIN_OUTPUT_TOKENS = 1024
  private static readonly MAX_OUTPUT_TOKENS = 16000

  private readonly refreshEveryTokens: number
  private readonly idleDelayMs: number

  /** 自上次更新以来，这场对话里该问到的几份记忆；非空即有没记的内容 */
  private readonly targets = new Set<string>()
  private pendingTokens = 0
  private lastTotal: number | undefined
  private conversationId: string | undefined
  private handoffDuringRun = false
  private latestPrefix: AiMessage[] | null = null
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private inflight: Promise<void> | null = null

  constructor(private readonly deps: MemoryRefreshDeps, options?: MemoryRefreshOptions) {
    this.refreshEveryTokens = options?.refreshEveryTokens ?? MemoryRefresher.REFRESH_EVERY_TOKENS
    this.idleDelayMs = options?.idleDelayMs ?? MemoryRefresher.IDLE_DELAY_MS
  }

  /** 新一轮开始：之前排着的空闲更新作罢，这一轮跑完再看 */
  onRunStart(): void {
    this.cancelIdle()
    this.handoffDuringRun = false
  }

  /**
   * 一轮跑完。
   * @param prefix 这一轮跑完后的完整对话（下一轮的前缀）
   * @param targets 这一轮该写的几份记忆
   */
  onRunEnd(input: { conversationId: string; prefix: AiMessage[] | null | undefined; targets: readonly string[] }): void {
    if (this.conversationId !== input.conversationId) {
      this.resetCounters()
      this.conversationId = input.conversationId
    }
    for (const id of input.targets) this.targets.add(id)
    const prefix = input.prefix
    if (!prefix?.length || this.targets.size === 0) return

    this.latestPrefix = prefix.slice()
    const total = this.deps.measurePrompt(prefix)
    if (!this.handoffDuringRun) {
      const from = this.lastTotal ?? this.deps.measureFixed(prefix)
      this.pendingTokens += Math.max(0, total - from)
    }
    this.lastTotal = total
    this.handoffDuringRun = false

    if (this.pendingTokens >= this.refreshEveryTokens) {
      void this.refresh(this.latestPrefix)
    } else {
      this.scheduleIdle()
    }
  }

  /**
   * 交接之前：这时的对话就是马上要被收起来的原文，先拿它问一次。
   * 与写交接那次请求同一份前缀，两次都吃得到缓存。
   */
  beforeHandoff(conversation: readonly AiMessage[], targets: readonly string[]): Promise<void> | undefined {
    for (const id of targets) this.targets.add(id)
    this.handoffDuringRun = true
    if (this.targets.size === 0 || conversation.length === 0) return undefined
    // 交接以后这份原文就没了，失败了当场再试一次
    return this.refresh(conversation.slice(), 2)
  }

  /** 会话要换掉之前：把没记的补上，然后从头计数 */
  flush(prefix: AiMessage[] | null | undefined): Promise<void> | undefined {
    this.cancelIdle()
    const pending = this.targets.size > 0 && prefix?.length ? this.refresh(prefix.slice()) : undefined
    this.resetCounters()
    this.conversationId = undefined
    return pending
  }

  dispose(): void {
    this.cancelIdle()
  }

  private resetCounters(): void {
    this.cancelIdle()
    this.targets.clear()
    this.pendingTokens = 0
    this.lastTotal = undefined
    this.handoffDuringRun = false
    this.latestPrefix = null
  }

  private scheduleIdle(): void {
    this.cancelIdle()
    if (this.targets.size === 0 || !this.latestPrefix) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.latestPrefix) void this.refresh(this.latestPrefix)
    }, this.idleDelayMs)
    // 关软件不为补这一次拖着不退出
    this.idleTimer.unref?.()
  }

  private cancelIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  /**
   * 当场取走待记的几份，之后的轮次另起一笔账。
   * 前一笔没回来就排在它后面：后一次要在前一次改完的记忆上合并。
   */
  private refresh(prefix: AiMessage[], attempts = 1): Promise<void> {
    const contextIds = [...this.targets]
    if (contextIds.length === 0) return Promise.resolve()
    this.targets.clear()
    this.pendingTokens = 0
    this.cancelIdle()

    const conversationId = this.conversationId
    const attempt = async (): Promise<void> => {
      for (let i = 1; ; i++) {
        try {
          return await this.request(prefix, contextIds)
        } catch (err) {
          if (i >= attempts) throw err
          log.info('记忆更新失败，再试一次:', err)
        }
      }
    }
    const previous = this.inflight ?? Promise.resolve()
    const task = previous
      .then(attempt)
      .catch(err => {
        log.warn('记忆更新失败，留到下次:', err)
        if (this.conversationId === conversationId) {
          for (const id of contextIds) this.targets.add(id)
        }
      })
      .finally(() => {
        if (this.inflight === task) this.inflight = null
      })
    this.inflight = task
    return task
  }

  private async request(prefix: AiMessage[], contextIds: string[]): Promise<void> {
    const chat = this.deps.chatWithTools
    if (!chat) return
    const { knowledge } = this.deps

    const visible = prefix.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const messages: AiMessage[] = [
      ...prefix,
      { role: 'user', content: knowledge.buildRefreshInstruction(contextIds, visible) },
    ]

    const wanted = Math.min(
      MemoryRefresher.MAX_OUTPUT_TOKENS,
      MemoryRefresher.MIN_OUTPUT_TOKENS + contextIds.length * knowledge.getMaxDocChars()
    )
    const room = this.deps.inputLimit(MemoryRefresher.MIN_OUTPUT_TOKENS) - this.deps.measurePrompt(messages)
    const maxOutputTokens = Math.min(wanted, MemoryRefresher.MIN_OUTPUT_TOKENS + room)
    if (maxOutputTokens < MemoryRefresher.MIN_OUTPUT_TOKENS) {
      throw new Error(`上下文已放不下这次记忆请求（${contextIds.join(', ')}）`)
    }

    // 工具清单照带：它是前缀的一部分，不带就等于换了前缀、白丢整段缓存
    const tools = this.deps.getTools()
    const profileId = this.deps.getProfileId()
    let result = await chat(messages, tools, profileId, undefined, { maxOutputTokens })
    if (!result?.content?.trim()) {
      // 模型转头去调工具了。再要一次并禁止调用——这次拿不到缓存，但要把结果拿到
      log.info('记忆更新没给正文（模型选了调工具），禁止调用后再要一次')
      result = await chat(messages, tools, profileId, undefined, { toolChoice: 'none', maxOutputTokens })
    }
    const text = result?.content?.trim() ?? ''
    const usage = result?.usage
    const cacheNote = usage?.cache_hit_tokens !== undefined
      ? `，缓存命中 ${usage.cache_hit_tokens}/${usage.prompt_tokens}`
      : ''
    if (!text) {
      log.warn(`记忆更新没拿到正文（${contextIds.join(', ')}）${cacheNote}`)
      return
    }
    const updated = knowledge.applyRefreshResponse(text, contextIds)
    log.info(`记忆更新（${contextIds.join(', ')}）：${updated.length ? `改了 ${updated.join(', ')}` : '无变化'}${cacheNote}`)
  }
}
