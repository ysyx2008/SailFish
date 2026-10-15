/**
 * 召回基线：问题集读写
 */

import * as fs from 'fs'
import * as path from 'path'
import type { BenchCase, BenchCorpusEntry, BenchQuestionSet } from './types'

export class QuestionSetStore {
  constructor(private readonly filePath: string) {}

  get baseDir(): string {
    return path.dirname(path.resolve(this.filePath))
  }

  exists(): boolean {
    return fs.existsSync(this.filePath)
  }

  load(): BenchQuestionSet {
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
    return QuestionSetStore.normalize(raw, this.filePath)
  }

  save(set: BenchQuestionSet): void {
    fs.mkdirSync(path.dirname(path.resolve(this.filePath)), { recursive: true })
    fs.writeFileSync(this.filePath, JSON.stringify(set, null, 2) + '\n', 'utf-8')
  }

  resolveCorpusFile(entry: BenchCorpusEntry): string {
    return QuestionSetStore.resolveCorpusFile(entry, this.baseDir)
  }

  /** 语料路径：绝对路径照用，相对路径按问题集所在目录解析 */
  static resolveCorpusFile(entry: BenchCorpusEntry, baseDir: string): string {
    return path.isAbsolute(entry.file) ? entry.file : path.resolve(baseDir, entry.file)
  }

  /** 老问题集缺字段时补默认值，并把明显写错的结构挡在入口 */
  static normalize(raw: unknown, source: string): BenchQuestionSet {
    const obj = (raw || {}) as Partial<BenchQuestionSet>
    const corpus = Array.isArray(obj.corpus) ? obj.corpus : []
    const cases = Array.isArray(obj.cases) ? obj.cases : []

    if (corpus.length === 0) {
      throw new Error(`问题集没有语料：${source}`)
    }

    const corpusIds = new Set(corpus.map(c => c.id))
    const unknown = cases.filter(c => !corpusIds.has(c.expectDocId)).map(c => c.expectDocId)
    if (unknown.length > 0) {
      throw new Error(`问题集里有指向未知语料的问题：${[...new Set(unknown)].join(', ')}（${source}）`)
    }

    return {
      name: obj.name || path.basename(source),
      createdAt: obj.createdAt || new Date().toISOString(),
      corpus: corpus.map(c => ({ id: String(c.id), file: String(c.file) })),
      cases: cases.map((c, i) => ({
        id: c.id || `q${i + 1}`,
        question: String(c.question || ''),
        expectDocId: String(c.expectDocId),
        expectText: c.expectText ? String(c.expectText) : undefined,
        status: c.status === 'approved' || c.status === 'rejected' ? c.status : 'candidate'
      })),
      noiseQuestions: Array.isArray(obj.noiseQuestions) ? obj.noiseQuestions.map(String) : []
    }
  }

  /** 参与评测的问题：默认只用已采纳的，没有采纳记录时可放开到候选 */
  static selectCases(set: BenchQuestionSet, includeCandidates = false): BenchCase[] {
    return set.cases.filter(c => {
      if (c.status === 'rejected') return false
      if (c.status === 'approved') return true
      return includeCandidates
    })
  }
}
