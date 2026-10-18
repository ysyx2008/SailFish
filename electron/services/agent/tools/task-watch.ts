/**
 * 联络派出去的任务：这一轮答应了要等它交回执。
 *
 * 和后台命令是同一个机制——还欠着回执，这一轮闲下来就不收工；回执送到、用户说话，都把这一轮叫醒。
 * 不同：任务是独立的一场对话，用户按停联络只是不再等它，不会停掉任务本身；
 * 欠不欠回执由任务监督记账，这里只管「等」这一件事。
 */
import { t } from '../i18n'
import type { BackgroundWatch } from '../background-watch'
import { formatTotalTime } from './utils'
import type { ToolExecutorConfig } from './types'

/** 回执的账：哪几场任务还欠联络这一轮一份回执 */
export interface TaskReceiptLedger {
  isOwed(agentKey: string): boolean
}

export function taskWatchKey(agentKey: string): string {
  return `task:${agentKey}`
}

export class TaskWatch implements BackgroundWatch {
  readonly key: string
  private card?: { id: string; ticker: NodeJS.Timeout }
  private released = false
  private startedAt = Date.now()

  constructor(
    private readonly ledger: TaskReceiptLedger,
    private readonly agentKey: string,
    private readonly title: string,
    private executor: ToolExecutorConfig,
  ) {
    this.key = taskWatchKey(agentKey)
  }

  /** 对同一场任务又交代了一句：沿用这一份，从现在起重新计时 */
  rebind(executor: ToolExecutorConfig): void {
    this.executor = executor
    this.startedAt = Date.now()
  }

  isPending(): boolean {
    return !this.released && this.ledger.isOwed(this.agentKey)
  }

  holdStarted(): void {
    if (this.card || !this.isPending()) return
    const step = this.executor.addStep({
      type: 'tool_call',
      content: this.cardContent(),
      toolName: 'manage_tasks',
      toolArgs: { action: 'await', task_id: this.agentKey },
      riskLevel: 'safe',
    })
    const ticker = setInterval(() => {
      this.executor.updateStep(step.id, { content: this.cardContent() })
    }, 1000)
    ticker.unref?.()
    this.card = { id: step.id, ticker }
  }

  holdEnded(checkpoint: boolean): void {
    // 到点醒一下不是任务有了回音：等待卡接着走，不换成「先回答你」
    if (checkpoint) return
    if (!this.closeCard()) return
    const short = t(this.isPending() ? 'taskmgr.await.yielded_short' : 'taskmgr.await.back_short')
    this.executor.addStep({
      type: 'tool_result',
      content: `⏳ ${short}`,
      toolName: 'manage_tasks',
      toolResult: short,
    })
  }

  /** 任务做多久都是它自己的事，没有可交给模型判断的进度 */
  checkpoint(): string | undefined {
    return undefined
  }

  release(): void {
    this.released = true
    this.closeCard()
  }

  /** 用户按停联络：只是不再等，任务照常做；它的回执之后仍会送来 */
  stop(): (() => string) | undefined {
    if (this.released) return undefined
    this.released = true
    const card = this.card
    if (!this.closeCard() || !card) return undefined
    const short = t('taskmgr.await.stopped_short')
    this.executor.updateStep(card.id, {
      success: false,
      isStreaming: false,
      content: `⏹️ ${short}`,
    })
    this.executor.addStep({
      type: 'tool_result',
      content: `⏹️ ${short}`,
      toolName: 'manage_tasks',
      toolResult: short,
    })
    return undefined
  }

  private cardContent(): string {
    const elapsed = formatTotalTime(Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)))
    return `⏳ ${t('taskmgr.await.title', { title: this.title, elapsed })}`
  }

  private closeCard(): boolean {
    if (!this.card) return false
    clearInterval(this.card.ticker)
    this.card = undefined
    return true
  }
}
