/**
 * 检索说明的向量，单独放一份 JSON。
 * 不进正文那张向量表，所以坏了可以丢掉重写，也不改公共检索。
 */

import * as fs from 'fs'
import * as path from 'path'
import { cosineSimilarity } from './memory-utils'

interface StoredCardVector {
  docId: string
  vector: number[]
}

export class CardVectorStore {
  private records = new Map<string, number[]>()
  private broken = false
  private loaded = false

  constructor(private readonly filePath: string) {}

  isBroken(): boolean {
    this.ensureLoaded()
    return this.broken
  }

  size(): number {
    this.ensureLoaded()
    return this.records.size
  }

  has(docId: string): boolean {
    this.ensureLoaded()
    return this.records.has(docId)
  }

  upsert(docId: string, vector: number[]): void {
    this.ensureLoaded()
    if (this.broken) return
    this.records.set(docId, vector)
    this.save()
  }

  remove(docId: string): void {
    this.ensureLoaded()
    if (!this.records.delete(docId)) return
    this.save()
  }

  clear(): void {
    this.records.clear()
    this.broken = false
    this.loaded = true
    this.save()
  }

  search(query: number[], limit: number): { docId: string; score: number }[] {
    this.ensureLoaded()
    if (this.broken || query.length === 0) return []
    const hits: { docId: string; score: number }[] = []
    for (const [docId, vector] of this.records) {
      if (vector.length !== query.length) continue
      hits.push({ docId, score: cosineSimilarity(query, vector) })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit)
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { records?: StoredCardVector[] }
      const list = Array.isArray(raw.records) ? raw.records : null
      if (!list) {
        this.broken = true
        return
      }
      for (const row of list) {
        if (!row || typeof row.docId !== 'string' || !Array.isArray(row.vector)) continue
        this.records.set(row.docId, row.vector)
      }
    } catch {
      this.broken = true
      this.records.clear()
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({
      records: [...this.records.entries()].map(([docId, vector]) => ({ docId, vector })),
    })
    const temp = `${this.filePath}.tmp`
    fs.writeFileSync(temp, payload, 'utf-8')
    fs.renameSync(temp, this.filePath)
  }
}
