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

  it('lets a rename leave two contacts with the same name', async () => {
    await addOk({ name: 'A' })
    const b = await addOk({ name: 'B' })
    const renamed = await book.update(b.id, { name: 'A' })
    expect(renamed.type).toBe('updated')
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
