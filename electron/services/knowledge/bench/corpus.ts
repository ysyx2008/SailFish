/**
 * 召回基线：语料入库与善后
 *
 * 基线会反复跑，语料不能在用户库里堆积；而用户自己早就放进去的同一份文档，
 * 也不能被基线顺手删掉。所以这里只记「本次自己加的」，清理只认这一份名单。
 */

import type { DocumentParserService } from '../../document-parser.service'
import type { KnowledgeService } from '../index'
import type { BenchCorpusEntry } from './types'

export class BenchCorpus {
  private readonly docIdByEntry = new Map<string, string>()
  private readonly addedDocIds: string[] = []
  private reusedCount = 0

  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly parser: DocumentParserService
  ) {}

  /** 语料全部就位；已在库里的原样复用 */
  async ensure(
    entries: BenchCorpusEntry[],
    resolveFile: (entry: BenchCorpusEntry) => string,
    onProgress?: (done: number, total: number, label: string) => void
  ): Promise<void> {
    let done = 0
    for (const entry of entries) {
      const file = resolveFile(entry)
      const fs = await import('fs')
      const path = await import('path')

      if (!fs.existsSync(file)) {
        throw new Error(`语料文件不存在：${file}（语料 id: ${entry.id}）`)
      }

      const parsed = await this.parser.parseDocument({
        name: path.basename(file),
        path: file,
        size: fs.statSync(file).size
      })
      if (parsed.error) throw new Error(`语料解析失败：${file} — ${parsed.error}`)
      if (parsed.skipped) throw new Error(`语料超出解析上限：${file}`)
      if (!parsed.content.trim()) throw new Error(`语料解析不出正文：${file}`)

      const duplicate = this.knowledge.isDuplicate(parsed.content)
      if (duplicate.isDuplicate && duplicate.existingDoc) {
        this.docIdByEntry.set(entry.id, duplicate.existingDoc.id)
        this.reusedCount++
      } else {
        const docId = await this.knowledge.addDocument(parsed, {})
        this.docIdByEntry.set(entry.id, docId)
        this.addedDocIds.push(docId)
      }

      done++
      onProgress?.(done, entries.length, parsed.filename)
    }
  }

  docIdOf(entryId: string): string | undefined {
    return this.docIdByEntry.get(entryId)
  }

  get reused(): number {
    return this.reusedCount
  }

  /** 只删本次入库的；返回删掉的份数 */
  async cleanup(): Promise<number> {
    let removed = 0
    for (const docId of this.addedDocIds) {
      if (await this.knowledge.removeDocument(docId)) removed++
    }
    this.addedDocIds.length = 0
    return removed
  }
}
