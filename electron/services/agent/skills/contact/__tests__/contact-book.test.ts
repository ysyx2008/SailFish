import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-contact-book-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { ContactBook } from '../contact-book'
import { getContactStorePath, onContactStoreChanged, resetWriteQueueForTest } from '../store'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

describe('ContactBook', () => {
  let book: ContactBook

  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    resetWriteQueueForTest()
    book = new ContactBook()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  async function addOk(input: Parameters<ContactBook['add']>[0]) {
    const result = await book.add(input)
    if (result.type !== 'created') throw new Error('expected created')
    return result.contact
  }

  it('merges the source into the target and removes the source', async () => {
    const target = await addOk({
      name: '梁总',
      organization: '火山引擎',
      channels: [{ kind: 'email', value: 'liang@example.com' }],
      note: '对接大模型采购',
    })
    const source = await addOk({
      name: '梁晓东',
      aliases: ['晓东'],
      role: '销售总监',
      organization: '另一家',
      channels: [
        { kind: 'email', value: 'LIANG@example.com' },
        { kind: 'phone', value: '138 0000 0000' },
      ],
      note: '去年在峰会认识',
    })

    const result = await book.merge(target.id, source.id)
    expect(result.type).toBe('merged')
    if (result.type !== 'merged') return

    const merged = result.contact
    expect(merged.name).toBe('梁总')
    expect(merged.aliases).toEqual(['梁晓东', '晓东'])
    expect(merged.organization).toBe('火山引擎')
    expect(merged.role).toBe('销售总监')
    expect(merged.channels).toEqual([
      { kind: 'email', value: 'liang@example.com' },
      { kind: 'phone', value: '138 0000 0000' },
    ])
    expect(merged.note).toBe('对接大模型采购\n\n去年在峰会认识')

    const all = book.list()
    expect(all.map(c => c.id)).toEqual([target.id])
    expect(book.search('晓东').map(c => c.id)).toEqual([target.id])
  })

  it('keeps one copy of an identical note and the earlier createdAt', async () => {
    const target = await addOk({ name: 'A', note: '同一段' })
    const source = await addOk({ name: 'B', note: ' 同一段 ' })
    const result = await book.merge(target.id, source.id)
    if (result.type !== 'merged') throw new Error('expected merged')
    expect(result.contact.note).toBe('同一段')
    expect(result.contact.createdAt <= source.createdAt).toBe(true)
  })

  it('refuses to merge a contact into itself or a missing one', async () => {
    const a = await addOk({ name: 'A' })
    expect((await book.merge(a.id, a.id)).type).toBe('same')
    expect((await book.merge(a.id, 'nope')).type).toBe('missing')
    expect(book.list()).toHaveLength(1)
  })

  it('refuses a merge whose names would collide with a third contact', async () => {
    const a = await addOk({ name: 'A' })
    await addOk({ name: 'C', aliases: ['共用'] })
    const b = await addOk({ name: 'B' })
    const raw = JSON.parse(fs.readFileSync(getContactStorePath(), 'utf-8'))
    raw.contacts.find((c: { id: string }) => c.id === b.id).aliases = ['共用']
    fs.writeFileSync(getContactStorePath(), JSON.stringify(raw))

    const result = await book.merge(a.id, b.id)
    expect(result.type).toBe('collision')
    expect(book.list()).toHaveLength(3)
  })

  it('notifies listeners only when something was written', async () => {
    const listener = vi.fn()
    const off = onContactStoreChanged(listener)
    const a = await addOk({ name: 'A' })
    expect(listener).toHaveBeenCalledTimes(1)
    await book.add({ name: 'A' })
    expect(listener).toHaveBeenCalledTimes(1)
    await book.remove(a.id)
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    await addOk({ name: 'B' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
