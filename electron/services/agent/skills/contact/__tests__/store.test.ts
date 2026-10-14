import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-contact-store-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  createContact,
  emptyStore,
  findPossibleSamePeople,
  getContactStorePath,
  loadStore,
  mutateStore,
  normalizeStore,
  resetWriteQueueForTest,
  searchContacts,
} from '../store'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

describe('contact store', () => {
  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    resetWriteQueueForTest()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('loadStore returns empty when file missing', () => {
    const store = loadStore()
    expect(store.version).toBe(1)
    expect(store.contacts).toEqual([])
  })

  it('roundtrips through mutateStore', async () => {
    const item = createContact({
      name: '沈义君',
      aliases: ['沈总', '沈义君'],
      organization: '国元证券证券金融部',
      role: '证券金融部负责人',
      channels: [{ kind: 'email', value: 'Shen@example.com' }],
    })
    await mutateStore(store => {
      store.contacts.push(item)
    })
    const loaded = loadStore()
    expect(loaded.contacts).toHaveLength(1)
    expect(loaded.contacts[0].aliases).toEqual(['沈总'])
    expect(loaded.contacts[0].channels?.[0].value).toBe('Shen@example.com')
    expect(fs.existsSync(getContactStorePath())).toBe(true)
  })

  it('normalizeStore drops blank names and bad kinds', () => {
    const normalized = normalizeStore({
      contacts: [
        { name: '  ' },
        { name: '火山引擎', kind: 'nope' },
        { id: 'ok', name: '王瑜', kind: 'person', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    })
    expect(normalized.contacts).toHaveLength(2)
    expect(normalized.contacts[0].kind).toBe('person')
    expect(normalized.contacts[0].id).toBeTruthy()
    expect(normalized.contacts[1].id).toBe('ok')
  })

  it('bad JSON falls back to empty store', () => {
    fs.writeFileSync(getContactStorePath(), '{not-json', 'utf-8')
    expect(loadStore().contacts).toEqual([])
  })

  it('possible-same match on names is exact after normalize, not a substring', () => {
    const contacts = [
      createContact({ name: '沈义君', aliases: ['沈总'] }),
    ]
    expect(findPossibleSamePeople(contacts, { name: '沈总' })).toHaveLength(1)
    expect(findPossibleSamePeople(contacts, { name: '  沈义君 ' })).toHaveLength(1)
    expect(findPossibleSamePeople(contacts, { name: '沈' })).toHaveLength(0)
  })

  it('possible-same match on email or phone, not on IM', () => {
    const contacts = [
      createContact({
        name: '沈义君',
        channels: [
          { kind: 'email', value: 'Shen@Example.com' },
          { kind: 'phone', value: '138-0000-0000' },
          { kind: 'im', platform: 'wecom', value: 'shen' },
        ],
      }),
    ]
    expect(findPossibleSamePeople(contacts, {
      name: '老沈',
      channels: [{ kind: 'email', value: ' shen@example.com ' }],
    })).toHaveLength(1)
    expect(findPossibleSamePeople(contacts, {
      name: '老沈',
      channels: [{ kind: 'phone', value: '138 0000 0000' }],
    })).toHaveLength(1)
    expect(findPossibleSamePeople(contacts, {
      name: '老沈',
      channels: [{ kind: 'im', platform: 'wecom', value: 'shen' }],
    })).toHaveLength(0)
  })

  it('search hits alias, org, and phone with dashes stripped', () => {
    const contacts = [
      createContact({
        name: '柏金鑫',
        organization: '国元证券金融科技部',
        channels: [{ kind: 'phone', value: '0551-62201548' }],
      }),
    ]
    expect(searchContacts(contacts, '金鑫')).toHaveLength(1)
    expect(searchContacts(contacts, '金融科技部')).toHaveLength(1)
    expect(searchContacts(contacts, '055162201548')).toHaveLength(1)
    expect(searchContacts(contacts, '没有这个人')).toHaveLength(0)
  })

  it('a mutation that changes nothing does not rewrite the file', async () => {
    await mutateStore(store => {
      store.contacts.push(createContact({ name: '王瑜' }))
    })
    const before = fs.readFileSync(getContactStorePath(), 'utf-8')
    const outcome = await mutateStore(store => {
      const hits = findPossibleSamePeople(store.contacts, { name: '王瑜' })
      if (hits.length) return 'possibleSame'
      store.contacts.push(createContact({ name: '王瑜' }))
      return 'created'
    })
    expect(outcome).toBe('possibleSame')
    expect(fs.readFileSync(getContactStorePath(), 'utf-8')).toBe(before)
    expect(emptyStore().contacts).toEqual([])
  })
})
