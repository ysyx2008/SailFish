/**
 * 本地联系人存储
 * 路径：{userData}/agent-workspace/CONTACTS.json
 *
 * 无面板、无心跳注入。写入只经本模块的队列，避免并发丢条目。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import type {
  Contact,
  ContactChannel,
  ContactChannelKind,
  ContactKind,
  ContactStoreData,
} from '@sailfish/shared-types'
import { getWorkspacePath } from '../../tools/file'
import { createLogger } from '../../../../utils/logger'
import {
  CONTACTS_FILENAME,
  LEGACY_CONTACTS_MD,
  MIGRATION_MARKER_FILENAME,
  MIGRATIONS_DIR,
  readContactMigrationMarker,
} from './migration-marker'

export { CONTACTS_FILENAME, LEGACY_CONTACTS_MD } from './migration-marker'

const log = createLogger('ContactStore')

const VALID_KINDS: ContactKind[] = ['person', 'org']
const VALID_CHANNEL_KINDS: ContactChannelKind[] = ['email', 'phone', 'im']

export const LEGACY_CONTACTS_MD_HINT =
  '工作空间还有旧版 CONTACTS.md，里面的人尚未整理进来。这里查不到的人，那份笔记里可能有（read_file 可读）。'

let writeQueue: Promise<void> = Promise.resolve()

export function resetWriteQueueForTest(): void {
  writeQueue = Promise.resolve()
}

export function getContactStorePath(): string {
  return path.join(getWorkspacePath(), CONTACTS_FILENAME)
}

export function getLegacyContactsMdPath(): string {
  return path.join(getWorkspacePath(), LEGACY_CONTACTS_MD)
}

export function hasLegacyContactsMd(): boolean {
  try {
    return fs.existsSync(getLegacyContactsMdPath())
  } catch {
    return false
  }
}

/** 旧笔记还在、且用户没说过不用迁 */
export function shouldPointToLegacyContactsMd(): boolean {
  if (!hasLegacyContactsMd()) return false
  const marker = readContactMigrationMarker(
    path.join(getWorkspacePath(), MIGRATIONS_DIR, MIGRATION_MARKER_FILENAME)
  )
  return marker?.status !== 'skipped' && marker?.status !== 'done'
}

/** 比对用：去首尾空白、合并连续空白、英文小写。中文不受大小写影响。 */
export function normalizeContactKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function normalizeChannelValue(kind: ContactChannelKind, value: string): string {
  const v = value.trim().toLowerCase()
  if (kind === 'phone') return v.replace(/[\s-]/g, '')
  return v
}

export function emptyStore(): ContactStoreData {
  return { version: 1, contacts: [], updatedAt: Date.now() }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function keysOf(contact: Pick<Contact, 'name' | 'aliases'>): string[] {
  const raw = [contact.name, ...(contact.aliases ?? [])]
  const seen = new Set<string>()
  const keys: string[] = []
  for (const item of raw) {
    const key = normalizeContactKey(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

export function normalizeAliases(name: string, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const nameKey = normalizeContactKey(name)
  const seen = new Set<string>()
  const aliases: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    const key = normalizeContactKey(trimmed)
    if (!key || key === nameKey || seen.has(key)) continue
    seen.add(key)
    aliases.push(trimmed)
  }
  return aliases.length ? aliases : undefined
}

export function normalizeChannels(raw: unknown): ContactChannel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const seen = new Set<string>()
  const channels: ContactChannel[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const kind = t.kind as ContactChannelKind
    if (!VALID_CHANNEL_KINDS.includes(kind)) continue
    const value = optionalString(t.value)
    if (!value) continue
    const platform = kind === 'im' ? optionalString(t.platform) : undefined
    const dedupe = `${kind}:${normalizeChannelValue(kind, value)}:${platform ? normalizeContactKey(platform) : ''}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    const channel: ContactChannel = { kind, value }
    if (platform) channel.platform = platform
    const label = optionalString(t.label)
    if (label) channel.label = label
    channels.push(channel)
  }
  return channels.length ? channels : undefined
}

/** 文件里缺 id 的条目：每次读出来都要是同一个 id，否则查到的 id 改不了 */
function derivedId(index: number, name: string): string {
  return `derived-${createHash('sha1').update(`${index}\0${name}`).digest('hex').slice(0, 16)}`
}

export function normalizeStore(raw: unknown): ContactStoreData {
  if (!raw || typeof raw !== 'object') return emptyStore()
  const obj = raw as Record<string, unknown>
  const list = Array.isArray(obj.contacts) ? obj.contacts : []
  const contacts: Contact[] = []

  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    if (!name) continue
    const kind = VALID_KINDS.includes(t.kind as ContactKind) ? (t.kind as ContactKind) : 'person'
    const createdAt = typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : new Date(0).toISOString()
    const contact: Contact = {
      id: typeof t.id === 'string' && t.id ? t.id : derivedId(index, name),
      name,
      kind,
      createdAt,
      updatedAt: typeof t.updatedAt === 'string' && t.updatedAt ? t.updatedAt : createdAt,
    }
    const aliases = normalizeAliases(name, t.aliases)
    if (aliases) contact.aliases = aliases
    const organization = optionalString(t.organization)
    if (organization) contact.organization = organization
    const role = optionalString(t.role)
    if (role) contact.role = role
    const note = optionalString(t.note)
    if (note) contact.note = note
    const channels = normalizeChannels(t.channels)
    if (channels) contact.channels = channels
    contacts.push(contact)
  }

  return {
    version: 1,
    contacts,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : Date.now(),
  }
}

export function loadStore(): ContactStoreData {
  const filePath = getContactStorePath()
  try {
    if (!fs.existsSync(filePath)) return emptyStore()
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (!raw.trim()) return emptyStore()
    return normalizeStore(JSON.parse(raw))
  } catch (e) {
    log.warn('Failed to load CONTACTS.json, falling back to empty store:', e)
    return emptyStore()
  }
}

function writeSync(store: ContactStoreData): void {
  const workspace = getWorkspacePath()
  fs.mkdirSync(workspace, { recursive: true })
  const filePath = getContactStorePath()
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const payload: ContactStoreData = {
    version: 1,
    contacts: store.contacts,
    updatedAt: Date.now(),
  }
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

export async function mutateStore<T>(mutator: (store: ContactStoreData) => T): Promise<T> {
  const next = writeQueue.then(() => {
    const store = loadStore()
    const before = JSON.stringify(store.contacts)
    const result = mutator(store)
    if (JSON.stringify(store.contacts) !== before) writeSync(store)
    return result
  })
  writeQueue = next.then(
    () => undefined,
    (err) => {
      log.warn('CONTACTS.json mutate failed in queue:', err)
    }
  )
  return next
}

/**
 * 姓名或别名与已有联系人的姓名/别名完全重合（规范化后）。
 * 子串不算重合：「沈」不会挡住「沈义君」。
 */
export function findNameCollisions(
  contacts: Contact[],
  name: string,
  aliases: string[] = [],
  excludeId?: string,
): Contact[] {
  const incoming = new Set(
    [name, ...aliases].map(normalizeContactKey).filter(Boolean)
  )
  if (incoming.size === 0) return []
  return contacts.filter(contact => {
    if (excludeId && contact.id === excludeId) return false
    return keysOf(contact).some(key => incoming.has(key))
  })
}

/**
 * 用到才查。命中：姓名/别名互相包含（单字别名不反向包含整句）、单位、角色、渠道值。
 */
export function searchContacts(contacts: Contact[], query: string): Contact[] {
  const q = normalizeContactKey(query)
  if (!q) return []
  const phoneQuery = q.replace(/[\s-]/g, '')
  return contacts.filter(contact => {
    const keys = keysOf(contact)
    if (keys.some(key => key.includes(q) || (key.length >= 2 && q.includes(key)))) return true
    if (contact.organization && normalizeContactKey(contact.organization).includes(q)) return true
    if (contact.role && normalizeContactKey(contact.role).includes(q)) return true
    if (contact.channels?.some(channel => {
      const value = normalizeChannelValue(channel.kind, channel.value)
      return value.includes(q) || (channel.kind === 'phone' && phoneQuery.length >= 3 && value.includes(phoneQuery))
    })) return true
    return false
  })
}

export interface ContactCreateInput {
  name: string
  aliases?: string[]
  kind?: ContactKind
  organization?: string
  role?: string
  note?: string
  channels?: ContactChannel[]
}

export function createContact(input: ContactCreateInput): Contact {
  const now = new Date().toISOString()
  const name = input.name.trim()
  const kind = input.kind && VALID_KINDS.includes(input.kind) ? input.kind : 'person'
  const contact: Contact = {
    id: randomUUID(),
    name,
    kind,
    createdAt: now,
    updatedAt: now,
  }
  const aliases = normalizeAliases(name, input.aliases)
  if (aliases) contact.aliases = aliases
  const organization = input.organization?.trim()
  if (organization) contact.organization = organization
  const role = input.role?.trim()
  if (role) contact.role = role
  const note = input.note?.trim()
  if (note) contact.note = note
  const channels = normalizeChannels(input.channels)
  if (channels) contact.channels = channels
  return contact
}

export interface ContactUpdatePatch {
  name?: string
  kind?: ContactKind
  organization?: string | null
  role?: string | null
  note?: string | null
  aliases?: string[] | null
  addAliases?: string[]
  channels?: ContactChannel[] | null
  addChannels?: ContactChannel[]
  removeChannels?: Array<{ kind: ContactChannelKind, value: string }>
}

export function applyContactUpdate(item: Contact, patch: ContactUpdatePatch): Contact {
  const next: Contact = { ...item, aliases: item.aliases ? [...item.aliases] : undefined, channels: item.channels ? item.channels.map(c => ({ ...c })) : undefined }
  if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
  if (patch.kind && VALID_KINDS.includes(patch.kind)) next.kind = patch.kind

  if (patch.organization === null) delete next.organization
  else if (typeof patch.organization === 'string') {
    const value = patch.organization.trim()
    if (value) next.organization = value
    else delete next.organization
  }
  if (patch.role === null) delete next.role
  else if (typeof patch.role === 'string') {
    const value = patch.role.trim()
    if (value) next.role = value
    else delete next.role
  }
  if (patch.note === null) delete next.note
  else if (typeof patch.note === 'string') {
    const value = patch.note.trim()
    if (value) next.note = value
    else delete next.note
  }

  if (patch.aliases === null) delete next.aliases
  else if (Array.isArray(patch.aliases)) {
    const aliases = normalizeAliases(next.name, patch.aliases)
    if (aliases) next.aliases = aliases
    else delete next.aliases
  }
  if (patch.addAliases?.length) {
    const merged = normalizeAliases(next.name, [...(next.aliases ?? []), ...patch.addAliases])
    if (merged) next.aliases = merged
  }

  if (patch.channels === null) delete next.channels
  else if (Array.isArray(patch.channels)) {
    const channels = normalizeChannels(patch.channels)
    if (channels) next.channels = channels
    else delete next.channels
  }
  if (patch.addChannels?.length) {
    const channels = normalizeChannels([...(next.channels ?? []), ...patch.addChannels])
    if (channels) next.channels = channels
  }
  if (patch.removeChannels?.length && next.channels) {
    const drop = new Set(
      patch.removeChannels
        .filter(item => VALID_CHANNEL_KINDS.includes(item.kind) && item.value.trim())
        .map(item => `${item.kind}:${normalizeChannelValue(item.kind, item.value)}`)
    )
    const kept = next.channels.filter(channel => !drop.has(`${channel.kind}:${normalizeChannelValue(channel.kind, channel.value)}`))
    if (kept.length) next.channels = kept
    else delete next.channels
  }

  const aliases = normalizeAliases(next.name, next.aliases)
  if (aliases) next.aliases = aliases
  else delete next.aliases

  next.updatedAt = new Date().toISOString()
  return next
}
