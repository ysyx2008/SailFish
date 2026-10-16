/**
 * 目录名和文件名的向量，单独放一份 JSON。
 * 不进正文那张向量表，老库不用把正文重新嵌入一遍。
 */

import * as fs from 'fs'
import * as path from 'path'
import { cosineSimilarity } from './memory-utils'

export interface NameVectorRecord {
  id: string
  kind: 'file' | 'folder'
  text: string
  folder: string
  docId?: string
  vector: number[]
}

export function fileNameKey(docId: string): string {
  return `file:${docId}`
}

export function folderNameKey(folder: string): string {
  return `folder:${folder}`
}

export class NameVectorStore {
  private records = new Map<string, NameVectorRecord>()
  private broken = false
  private loaded = false

  constructor(private readonly filePath: string) {}

  isBroken(): boolean {
    this.ensureLoaded()
    return this.broken
  }

  texts(): Map<string, string> {
    this.ensureLoaded()
    return new Map([...this.records.entries()].map(([id, row]) => [id, row.text]))
  }

  snapshot(): Map<string, { text: string; folder: string; vector: number[] }> {
    this.ensureLoaded()
    return new Map([...this.records.entries()].map(([id, row]) => [id, {
      text: row.text,
      folder: row.folder,
      vector: row.vector,
    }]))
  }

  listMeta(): { kind: 'file' | 'folder'; folder: string; docId?: string }[] {
    this.ensureLoaded()
    if (this.broken) return []
    return [...this.records.values()].map(row => ({
      kind: row.kind,
      folder: row.folder,
      docId: row.docId,
    }))
  }

  remove(id: string): void {
    this.ensureLoaded()
    if (!this.records.delete(id)) return
    this.save()
  }

  replace(removeIds: string[], upserts: NameVectorRecord[]): void {
    this.ensureLoaded()
    if (this.broken) return
    let changed = false
    for (const id of removeIds) {
      if (this.records.delete(id)) changed = true
    }
    for (const row of upserts) {
      if (!row.vector.length) continue
      this.records.set(row.id, row)
      changed = true
    }
    if (changed) this.save()
  }

  clear(): void {
    this.records.clear()
    this.broken = false
    this.loaded = true
    this.save()
  }

  search(query: number[], limit: number): { kind: 'file' | 'folder'; score: number; folder: string; docId?: string }[] {
    this.ensureLoaded()
    if (this.broken || query.length === 0) return []
    const hits: { kind: 'file' | 'folder'; score: number; folder: string; docId?: string }[] = []
    for (const row of this.records.values()) {
      if (row.vector.length !== query.length) continue
      hits.push({
        kind: row.kind,
        score: cosineSimilarity(query, row.vector),
        folder: row.folder,
        docId: row.docId,
      })
    }
    hits.sort((a, b) => b.score - a.score)
    return limit > 0 ? hits.slice(0, limit) : hits
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { records?: NameVectorRecord[] }
      const list = Array.isArray(raw.records) ? raw.records : null
      if (!list) {
        this.broken = true
        return
      }
      for (const row of list) {
        if (!row || typeof row.id !== 'string' || typeof row.text !== 'string') continue
        if (row.kind !== 'file' && row.kind !== 'folder') continue
        if (!Array.isArray(row.vector)) continue
        this.records.set(row.id, row)
      }
    } catch {
      this.broken = true
      this.records.clear()
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify({ records: [...this.records.values()] })
    const temp = `${this.filePath}.tmp`
    fs.writeFileSync(temp, payload, 'utf-8')
    fs.renameSync(temp, this.filePath)
  }
}
