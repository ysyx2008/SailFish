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
import { onContactStoreChanged, resetWriteQueueForTest } from '../store'
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
    const result = await book.add(input, { confirmedDifferent: true })
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

  it('holds back a same-name add until confirmed as a different person', async () => {
    const first = await addOk({ name: '王瑜', organization: '国元证券' })
    const held = await book.add({ name: ' 王瑜 ', organization: '火山引擎' })
    expect(held.type).toBe('possibleSame')
    if (held.type !== 'possibleSame') return
    expect(held.candidates.map(c => c.id)).toEqual([first.id])
    expect(book.list()).toHaveLength(1)

    const second = await book.add({ name: '王瑜', organization: '火山引擎' }, { confirmedDifferent: true })
    expect(second.type).toBe('created')
    expect(book.list()).toHaveLength(2)
    expect(book.search('王瑜')).toHaveLength(2)
  })

  it('holds back an add whose email matches someone with another name', async () => {
    const first = await addOk({ name: '沈义君', channels: [{ kind: 'email', value: 'shen@example.com' }] })
    const held = await book.add({ name: '老沈', channels: [{ kind: 'email', value: 'SHEN@example.com' }] })
    if (held.type !== 'possibleSame') throw new Error('expected possibleSame')
    expect(held.candidates.map(c => c.id)).toEqual([first.id])
  })

  it('lets a rename or merge leave two contacts with the same name', async () => {
    const a = await addOk({ name: 'A' })
    const b = await addOk({ name: 'B' })
    const c = await addOk({ name: 'C' })
    const renamed = await book.update(b.id, { name: 'A' })
    expect(renamed.type).toBe('updated')

    const merged = await book.merge(a.id, c.id)
    expect(merged.type).toBe('merged')
    expect(book.list().map(x => x.name).sort()).toEqual(['A', 'A'])
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
