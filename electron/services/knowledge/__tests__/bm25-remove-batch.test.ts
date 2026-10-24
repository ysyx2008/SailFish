import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BM25Index } from '../bm25'

describe('BM25Index.removeManyDocumentChunks', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('drops every chunk of the given documents and rewrites the index once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-bm25-'))
    dirs.push(dir)
    const indexPath = path.join(dir, 'bm25-index.json')
    const index = new BM25Index(indexPath)
    const writes: string[] = []
    const original = fs.promises.writeFile.bind(fs.promises)
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (file, data, options) => {
      const target = String(file)
      if (target.startsWith(dir)) writes.push(target)
      return original(file, data, options)
    })

    await index.addDocuments([
      { id: 'c1', docId: 'doc-a', content: '香蕉牛奶', filename: 'a', hostId: 'personal', tags: 'conversation' },
      { id: 'c2', docId: 'doc-b', content: '苹果派', filename: 'b', hostId: 'personal', tags: 'conversation' },
      { id: 'c3', docId: 'doc-a', content: '香蕉蛋糕', filename: 'a2', hostId: 'personal', tags: 'conversation' },
    ], { skipSave: true })

    const removed = await index.removeManyDocumentChunks(['doc-a'])

    expect(removed).toBe(2)
    expect(writes).toHaveLength(1)
    expect([...index.getIndexedDocIds()]).toEqual(['doc-b'])
    const saved = fs.readFileSync(indexPath, 'utf-8')
    expect(saved).toContain('doc-b')
    expect(saved).not.toContain('doc-a')
  })
})
