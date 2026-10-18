/**
 * 旧用户画像（觉醒页里的 USER.md）并入记忆里的「用户」。
 *
 * 两份都在写同一个人，且都会在每次对话开头交给 AI。这里让 AI 把两份整合成一份，
 * 不机械追加（记忆常常已经接近上限）。设计目标见 knowledge/SPEC.md
 * 「『关于用户』只有一份」。
 *
 * 成功才落盘，并把两份原文留底；失败什么都不动，旧画像照常给 AI 看，下次启动再试。
 */
import { createLogger } from '../../utils/logger'
import { PERSONAL_MEMORY_STYLE } from './memory-style'

const log = createLogger('UserProfileConsolidator')

export const USER_MEMORY_ID = 'personal'

/** 中文一个字最多约两个 token；另留一截给思考和格式 */
const OUTPUT_HEADROOM_TOKENS = 8192
const OUTPUT_TOKENS_CAP = 32000

export interface UserProfileConsolidatorDeps {
  /** 旧用户画像原文；没有或为空返回空串 */
  readLegacyProfile(): string
  /** 并入成功后把旧画像文件收起来（改名留底，不删） */
  archiveLegacyProfile(): void
  /** 把整合前的两份原文存起来；已有同名留底（上次中断留下的）不覆盖 */
  saveBackup(name: string, content: string): void
  memory: {
    getDocument(contextId: string): string
    setDocument(contextId: string, content: string): void
    /** 磁盘上实际存着的内容（写盘失败不会报错，只能回读确认）；读不到返回 null */
    getPersistedDocument(contextId: string): string | null
    getMaxDocChars(): number
  }
  /**
   * 一次性问模型；没有可用模型时抛错。
   * maxOutputTokens 要放得下整份记忆（模型可能还要先思考）；
   * complete 为 false 表示回复在中途被截断（输出额度用完，或只有思考没有正文）。
   */
  chat(
    messages: Array<{ role: 'user'; content: string }>,
    maxOutputTokens: number,
  ): Promise<{ text: string; complete: boolean }>
  /** 当前模型单次最多能输出多少；要的额度超过它就按它来 */
  getOutputLimit(): number
}

export type ConsolidateOutcome = 'none' | 'merged' | 'failed'

export class UserProfileConsolidator {
  private running: Promise<ConsolidateOutcome> | null = null

  constructor(private readonly deps: UserProfileConsolidatorDeps) {}

  run(): Promise<ConsolidateOutcome> {
    if (!this.running) {
      this.running = this.consolidate().finally(() => { this.running = null })
    }
    return this.running
  }

  private async consolidate(): Promise<ConsolidateOutcome> {
    const legacy = this.deps.readLegacyProfile().trim()
    if (!legacy) return 'none'

    const { memory } = this.deps
    const current = memory.getDocument(USER_MEMORY_ID).trim()
    const max = memory.getMaxDocChars()

    let merged: string | null
    if (!current && legacy.length <= max) {
      // 记忆里还没有用户这一份：旧画像本身就是它的开头，不必问模型
      merged = legacy
    } else {
      merged = await this.askModel(legacy, current, max)
    }
    if (merged === null) {
      log.warn('旧用户画像没能并入记忆，保持原样，下次启动再试')
      return 'failed'
    }

    // 问模型这段时间里，对话后的记忆更新可能已经改过这一份；整篇覆盖会把它们抹掉
    if (memory.getDocument(USER_MEMORY_ID).trim() !== current) {
      log.warn('整合期间「用户」记忆已被更新，这次结果作废，下次启动再试')
      return 'failed'
    }

    this.deps.saveBackup('USER.md', legacy)
    if (current) this.deps.saveBackup('personal.md', current)
    memory.setDocument(USER_MEMORY_ID, merged)
    // 写盘失败（磁盘满、被占用）不会抛错；没落盘就收起旧文件，重启后两份都回到原样、画像也不见了
    if (memory.getPersistedDocument(USER_MEMORY_ID)?.trim() !== merged) {
      log.warn('整合结果没能写到磁盘，旧用户画像保留，下次启动再试')
      return 'failed'
    }
    try {
      this.deps.archiveLegacyProfile()
    } catch (err) {
      // 记忆已经写好；旧文件没收起来，下次启动会再整合一次（两份原文都有留底）
      log.warn('旧用户画像文件没能收起来:', err)
    }
    log.info(`旧用户画像已并入记忆「用户」（${merged.length}/${max} 字）`)
    return 'merged'
  }

  /** 最多问两次；第二次带上第一次超出的字数。拿不到合格的结果返回 null */
  private async askModel(legacy: string, current: string, max: number): Promise<string | null> {
    let overBy = 0
    for (let attempt = 1; attempt <= 2; attempt++) {
      let reply: { text: string; complete: boolean }
      try {
        const tokens = Math.min(OUTPUT_TOKENS_CAP, this.deps.getOutputLimit(), OUTPUT_HEADROOM_TOKENS + max * 2)
        reply = await this.deps.chat(this.buildMessages(legacy, current, max, overBy), tokens)
      } catch (err) {
        log.warn('整合旧用户画像时模型调用失败:', err)
        return null
      }
      if (!reply.complete) {
        // 被截断的半截正文看起来也「不超限」，但缺了后半——不能当结果
        log.warn('整合旧用户画像：模型回复被截断')
        continue
      }
      const text = stripOuterFence(reply.text)
      if (!text) {
        log.warn('整合旧用户画像：模型没有给出内容')
        continue
      }
      if (text.length <= max) return text
      overBy = text.length - max
      log.warn(`整合旧用户画像：结果 ${text.length} 字，超过上限 ${max}`)
    }
    return null
  }

  private buildMessages(legacy: string, current: string, max: number, overBy: number) {
    const lines = [
      '下面是同一个人的两份资料，要合成一份，作为之后每次对话开头交给助手的「用户」记忆。',
      `写法：${PERSONAL_MEMORY_STYLE}`,
      `两份里重复的只留一次；两份说法对不上的，以「现有记忆」为准。不在两份资料里的内容不要添加。总长度不超过 ${max} 字。`,
      overBy > 0 ? `上一次写出的结果超出上限 ${overBy} 字，这次要更精简。` : '',
      '只回复合成后的正文，不加说明，不加代码块。',
      `<现有记忆>\n${current || '（还没有）'}\n</现有记忆>`,
      `<旧用户画像>\n${legacy}\n</旧用户画像>`,
    ].filter(Boolean)
    return [{ role: 'user' as const, content: lines.join('\n\n') }]
  }
}

/** 模型有时把整段正文包进一个代码块；只剥最外面这一层 */
export function stripOuterFence(text: string): string {
  const trimmed = text.trim()
  const m = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed)
  return (m ? m[1] : trimmed).trim()
}
