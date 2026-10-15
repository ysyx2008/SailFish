/**
 * 召回基线：让 AI 读完语料出候选问题
 *
 * 出的是候选，采纳与否由人定。问题的形态直接决定基线是否说真话——
 * 用检索腔的关键词出题，命中率会虚高，量不到真实对话里的情形。
 */

import * as fs from 'fs'
import * as path from 'path'
import type { AiMessage, AiService } from '../../ai.service'
import type { DocumentParserService } from '../../document-parser.service'
import type { BenchCase, BenchCorpusEntry, BenchQuestionSet } from './types'

/** 单份文档送进模型的正文上限，超出部分截断 */
const MAX_DOC_CHARS = 20000

/** 每批问几条。批小一点，输出不容易被模型侧的长度上限掐断 */
const QUESTIONS_PER_BATCH = 3

interface GeneratedQuestion {
  question: string
  expectText?: string
}

export class QuestionGenerator {
  constructor(
    private readonly ai: AiService,
    private readonly parser: DocumentParserService
  ) {}

  async generate(
    files: string[],
    options: { perDoc: number; profileId?: string; name?: string; noiseCount?: number }
  ): Promise<BenchQuestionSet> {
    const corpus: BenchCorpusEntry[] = []
    const cases: BenchCase[] = []
    const titles: string[] = []

    for (const [index, file] of files.entries()) {
      const parsed = await this.parser.parseDocument({
        name: path.basename(file),
        path: file,
        size: fs.statSync(file).size
      })
      if (parsed.error) throw new Error(`语料解析失败：${file} — ${parsed.error}`)
      if (!parsed.content.trim()) throw new Error(`语料解析不出正文：${file}`)

      const entryId = QuestionGenerator.entryId(file, index)
      corpus.push({ id: entryId, file })
      titles.push(parsed.filename)

      const generated = await this.askForQuestions(
        parsed.filename,
        parsed.content.slice(0, MAX_DOC_CHARS),
        options.perDoc,
        options.profileId
      )

      generated.forEach((g, i) => {
        if (!g.question?.trim()) return
        cases.push({
          id: `${entryId}-q${i + 1}`,
          question: g.question.trim(),
          expectDocId: entryId,
          expectText: g.expectText?.trim() || undefined,
          status: 'candidate'
        })
      })
    }

    const noiseQuestions = await this.askForNoise(titles, options.noiseCount ?? 5, options.profileId)

    return {
      name: options.name || '召回基线',
      createdAt: new Date().toISOString(),
      corpus,
      cases,
      noiseQuestions
    }
  }

  /**
   * 分小批问。一次要十条，输出常被模型侧的长度上限掐断；几条一批每次都短，
   * 还能把已出过的附在末尾去重——前缀不变，照样吃缓存。
   */
  private async askForQuestions(
    title: string,
    content: string,
    count: number,
    profileId?: string
  ): Promise<GeneratedQuestion[]> {
    const prefix =
      '知识库会在用户每轮提问时按语义自动检索，命中的片段直接进入对话上下文。\n\n' +
      '下面这批问题用来测量「用户这样问的时候，这份文档会不会被自动想起来」。' +
      '它们代表用户在对话框里实际打出的字：比检索关键词长，比正式表述随意，也可能一个原词都不含，' +
      '长度通常在十几到二十几个字。\n\n' +
      `文档《${title}》正文：\n${content}\n\n` +
      '输出 JSON 数组，每项两个字段：\n' +
      '- question：问题原文\n' +
      '- expectText：回答它所依据的那一段在文档里的定位词，例如条款号或小节标题\n\n' +
      '只输出 JSON 数组本身。'

    const collected: GeneratedQuestion[] = []
    const seen = new Set<string>()
    let failures = 0

    while (collected.length < count && failures < 2) {
      const need = Math.min(QUESTIONS_PER_BATCH, count - collected.length)
      const asked = collected.map(q => `- ${q.question}`).join('\n')
      const messages: AiMessage[] = [
        {
          role: 'user',
          content:
            prefix +
            `\n\n这一批要 ${need} 条。` +
            (asked ? `\n\n已经出过下面这些，换别的角度：\n${asked}` : '')
        }
      ]

      let batch: GeneratedQuestion[]
      try {
        batch = await this.askJsonArray<GeneratedQuestion>(messages, profileId, `《${title}》`)
      } catch (error) {
        // 已经攒到一些就先用着，一条都没有才算失败
        if (collected.length > 0) break
        throw error
      }

      const fresh = batch.filter(q => {
        const key = q?.question?.trim()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (fresh.length === 0) {
        failures++
        continue
      }
      collected.push(...fresh)
    }

    return collected.slice(0, count)
  }

  private async askForNoise(
    titles: string[],
    count: number,
    profileId?: string
  ): Promise<string[]> {
    if (count <= 0) return []

    const messages: AiMessage[] = [
      {
        role: 'user',
        content:
          '知识库里目前只有这些文档：\n' +
          titles.map(t => `- ${t}`).join('\n') +
          '\n\n需要一组与上述文档都无关的日常请求，用来检查它们不会被误召回。\n\n' +
          `输出 JSON 数组，${count} 项，每项是一句话（字符串）。只输出 JSON 数组本身。`
      }
    ]

    return (await this.askJsonArray<string>(messages, profileId, '无关问题'))
      .map(q => (typeof q === 'string' ? q : String((q as { question?: string })?.question || '')))
      .filter(q => q.trim().length > 0)
  }

  /**
   * 长文档出题时模型可能把输出预算耗在思考上，回来一个空 content，或者数组断在中间。
   * 所以这里重试一次，仍不行就把下一步能做什么说清楚。
   */
  private async askJsonArray<T>(
    messages: AiMessage[],
    profileId: string | undefined,
    label: string,
    attempts = 2
  ): Promise<T[]> {
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const reply = await this.ai.chat(messages, profileId)
        if (!String(reply || '').trim()) {
          throw new Error('模型返回了空内容')
        }
        return QuestionGenerator.parseJsonArray<T>(reply)
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(
      `${label} 出题失败：${lastError instanceof Error ? lastError.message : String(lastError)}\n` +
        '可以减小 --per-doc、或用 --profile 换一个输出长度更宽裕的模型；也可以手写问题集，格式见 docs/bench/repo-docs.question-set.json'
    )
  }

  /**
   * 模型常把 JSON 包在代码块里；输出长度用尽时数组还会断在中间。
   * 整段能解就整段解，断了就把已经完整的那几项捞出来——出题本就是候选，少几条不影响。
   */
  static parseJsonArray<T>(reply: string): T[] {
    const text = String(reply || '').trim()
    const start = text.indexOf('[')
    if (start < 0) {
      throw new Error(`模型没有返回 JSON 数组：${text.slice(0, 200)}`)
    }

    const end = text.lastIndexOf(']')
    if (end > start) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1))
        if (Array.isArray(parsed)) return parsed as T[]
      } catch {
        /* 整段解不动，往下逐项打捞 */
      }
    }

    const salvaged = QuestionGenerator.salvageItems<T>(text.slice(start + 1))
    if (salvaged.length === 0) {
      throw new Error(`模型返回的 JSON 无法解析（可能是输出长度不够被截断）：${text.slice(0, 200)}`)
    }
    return salvaged
  }

  /** 从未闭合的数组体里取出已完整的顶层元素（对象或字符串） */
  private static salvageItems<T>(body: string): T[] {
    const items: T[] = []
    let depth = 0
    let objStart = -1
    let strStart = -1
    let inString = false
    let escaped = false

    for (let i = 0; i < body.length; i++) {
      const ch = body[i]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
          if (depth === 0 && strStart >= 0) {
            try {
              items.push(JSON.parse(body.slice(strStart, i + 1)))
            } catch {
              /* 跳过这一项 */
            }
            strStart = -1
          }
        }
        continue
      }

      if (ch === '"') {
        inString = true
        if (depth === 0) strStart = i
        continue
      }
      if (ch === '{' || ch === '[') {
        if (depth === 0) objStart = i
        depth++
        continue
      }
      if (ch === '}' || ch === ']') {
        if (depth === 0) break // 外层数组收尾
        depth--
        if (depth === 0 && objStart >= 0) {
          try {
            items.push(JSON.parse(body.slice(objStart, i + 1)))
          } catch {
            /* 跳过这一项 */
          }
          objStart = -1
        }
      }
    }

    return items
  }

  /** 语料 id 取文件名的稳定片段，重名时带序号 */
  static entryId(file: string, index: number): string {
    const base = path
      .basename(file, path.extname(file))
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]/gu, '')
      .slice(0, 40)
    return base ? `${base}-${index + 1}` : `doc-${index + 1}`
  }
}
