/**
 * SSH 主机：列表展示 + 一条一条增删改（禁止整表覆盖）
 */

import { v4 as uuidv4 } from 'uuid'
import type { SshEncoding } from '@shared/types'
import type { SessionGroup, SshSession } from '../../../config.service'
import type { ToolResult } from '../../tools/types'

export interface SshSessionStore {
  getSshSessions(): SshSession[]
  addSshSession(session: SshSession): void
  updateSshSession(session: SshSession): void
  deleteSshSession(id: string): void
  getSessionGroups(): SessionGroup[]
  addSessionGroup(group: SessionGroup): void
}

const ENCODINGS = new Set<SshEncoding>([
  'utf-8', 'gbk', 'gb2312', 'gb18030', 'big5',
  'shift_jis', 'euc-jp', 'euc-kr',
  'iso-8859-1', 'iso-8859-15', 'windows-1252',
  'koi8-r', 'windows-1251',
])

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 步骤标题里给用户看的那一段。
 * 改名时用即将写入的名字；只按 id 操作时查出当前名字，没有名字就用地址。
 * 查不到就不附 id。
 */
export function sshSessionStreamHint(
  args: Record<string, unknown>,
  lookupLabel: (id: string) => string | undefined,
): string {
  const action = typeof args.action === 'string' ? args.action : ''
  const givenName = argStr(args, 'name')
  if (givenName && action !== 'delete') return givenName

  const id = argStr(args, 'sessionId') || argStr(args, 'id')
  if (id) {
    const resolved = lookupLabel(id)?.trim()
    if (resolved) return resolved
  }

  const host = argStr(args, 'host')
  if (host && action !== 'delete') return host
  return action === 'delete' ? givenName : ''
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

function authLabel(s: SshSession): string {
  if (s.authType === 'privateKey' && s.privateKeyPath) return '私钥已配置'
  if (s.password) return '密码已配置'
  if (s.privateKeyPath) return '私钥已配置'
  return '未配置认证'
}

function groupName(store: SshSessionStore, session: SshSession): string {
  if (session.groupId) {
    return store.getSessionGroups().find(g => g.id === session.groupId)?.name || session.groupId
  }
  return session.group || '未分组'
}

function sessionLine(store: SshSessionStore, s: SshSession): string {
  const user = s.username ? `${s.username}@` : ''
  const port = s.port && s.port !== 22 ? `:${s.port}` : ''
  return `    - **${s.name}** \`${s.id}\` · ${user}${s.host}${port} · ${groupName(store, s)} · ${authLabel(s)}`
}

export function formatSshSessionsSummary(store: SshSessionStore): string {
  const sessions = store.getSshSessions()
  if (sessions.length === 0) {
    return '  - **SSH 主机** — _(未配置)_  使用 `config_ssh_session` action=add 添加'
  }
  return `  - **SSH 主机** — ${sessions.length} 个（勿用 config_set 整表覆盖；用 config_ssh_session）\n${sessions.map(s => sessionLine(store, s)).join('\n')}`
}

export function formatSshSessionsDetail(store: SshSessionStore): string {
  const sessions = store.getSshSessions()
  if (sessions.length === 0) {
    return '_(未配置)_\n\n使用 `config_ssh_session` action=add 添加主机。'
  }
  const blocks = sessions.map((s, i) => {
    const parts = [
      `${i + 1}. **${s.name}**`,
      `- id: \`${s.id}\``,
      `- host: \`${s.host}\``,
      `- port: \`${s.port || 22}\``,
      `- username: \`${s.username || ''}\``,
      `- group: ${groupName(store, s)}`,
      `- auth: ${authLabel(s)}`,
    ]
    return parts.join('\n')
  })
  return `共 ${sessions.length} 个：\n\n${blocks.join('\n\n')}\n\n增删改请用 \`config_ssh_session\`（action=add/update/delete），勿用 \`config_set\` 写入整表。`
}

export function formatSessionGroupsSummary(store: SshSessionStore): string {
  const groups = store.getSessionGroups()
  if (groups.length === 0) return '  - **会话分组** — _(无分组)_'
  return `  - **会话分组** — ${groups.map(g => `${g.name} (\`${g.id}\`)`).join('、')}`
}

function findSession(store: SshSessionStore, args: Record<string, unknown>): SshSession | { error: string } {
  const id = argStr(args, 'sessionId') || argStr(args, 'id')
  const sessions = store.getSshSessions()
  if (id) {
    const found = sessions.find(s => s.id === id)
    return found || { error: `未找到 id 为 "${id}" 的主机` }
  }
  const name = argStr(args, 'name')
  if (!name) return { error: '缺少 sessionId（或唯一的 name）' }
  const matches = sessions.filter(s => s.name === name)
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) return { error: `未找到名为 "${name}" 的主机` }
  return { error: `有 ${matches.length} 台主机都叫 "${name}"，请用 sessionId 指定` }
}

function parsePort(raw: number | undefined, fallback: number): number | { error: string } {
  if (raw === undefined) return fallback
  if (Number.isNaN(raw) || raw < 1 || raw > 65535 || !Number.isInteger(raw)) {
    return { error: 'port 须为 1–65535 的整数' }
  }
  return raw
}

function parseEncoding(raw: string): SshEncoding | undefined | { error: string } {
  if (!raw) return undefined
  if (!ENCODINGS.has(raw as SshEncoding)) return { error: `encoding 无效：${raw}` }
  return raw as SshEncoding
}

function resolveAuthType(
  args: Record<string, unknown>,
  fallback: SshSession['authType']
): SshSession['authType'] | { error: string } {
  const raw = argStr(args, 'authType')
  if (raw) {
    if (raw !== 'password' && raw !== 'privateKey') return { error: 'authType 须为 password 或 privateKey' }
    return raw
  }
  if (args.privateKeyPath !== undefined && argStr(args, 'privateKeyPath')) return 'privateKey'
  if (args.password !== undefined && argStr(args, 'password')) return 'password'
  return fallback
}

function resolveGroupId(
  store: SshSessionStore,
  args: Record<string, unknown>,
  existing?: string
): string | undefined | { error: string } {
  if (args.group === undefined && args.groupId === undefined) return existing
  const groupId = argStr(args, 'groupId')
  const groupNameArg = argStr(args, 'group')
  if (!groupId && !groupNameArg) return undefined

  const groups = store.getSessionGroups()
  if (groupId) {
    if (!groups.some(g => g.id === groupId)) return { error: `未找到 id 为 "${groupId}" 的分组` }
    return groupId
  }

  const found = groups.find(g => g.name === groupNameArg)
  if (found) return found.id

  const created: SessionGroup = { id: uuidv4(), name: groupNameArg }
  store.addSessionGroup(created)
  return created.id
}

export function addSshSessionConfig(
  store: SshSessionStore,
  args: Record<string, unknown>
): ToolResult {
  const host = argStr(args, 'host')
  if (!host) return { success: false, output: '', error: '缺少 host' }

  const name = argStr(args, 'name') || host
  const port = parsePort(argNum(args, 'port'), 22)
  if (typeof port === 'object') return { success: false, output: '', error: port.error }

  const authType = resolveAuthType(args, 'password')
  if (typeof authType === 'object') return { success: false, output: '', error: authType.error }

  const encoding = parseEncoding(argStr(args, 'encoding'))
  if (encoding && typeof encoding === 'object' && 'error' in encoding) {
    return { success: false, output: '', error: encoding.error }
  }

  const id = argStr(args, 'id') || uuidv4()
  if (store.getSshSessions().some(s => s.id === id)) {
    return { success: false, output: '', error: `已存在 id 为 "${id}" 的主机` }
  }

  const groupId = resolveGroupId(store, args)
  if (groupId && typeof groupId === 'object') {
    return { success: false, output: '', error: groupId.error }
  }

  const session: SshSession = {
    id,
    name,
    host,
    port,
    username: argStr(args, 'username') || 'root',
    authType,
    password: argStr(args, 'password') || undefined,
    privateKeyPath: argStr(args, 'privateKeyPath') || undefined,
    passphrase: argStr(args, 'passphrase') || undefined,
    groupId,
  }
  if (encoding && typeof encoding === 'string') {
    (session as SshSession & { encoding?: SshEncoding }).encoding = encoding
  }

  store.addSshSession(session)
  const n = store.getSshSessions().length
  return {
    success: true,
    output: `✅ 已添加主机 **${name}**（id: \`${id}\`，${session.username}@${host}:${port}）。当前共 ${n} 台。`,
  }
}

export function updateSshSessionConfig(
  store: SshSessionStore,
  args: Record<string, unknown>
): ToolResult {
  const found = findSession(store, args)
  if ('error' in found) return { success: false, output: '', error: found.error }

  const host = args.host !== undefined ? argStr(args, 'host') : found.host
  if (!host) return { success: false, output: '', error: 'host 不能为空' }

  const name = args.name !== undefined ? (argStr(args, 'name') || host) : found.name
  const port = parsePort(argNum(args, 'port'), found.port || 22)
  if (typeof port === 'object') return { success: false, output: '', error: port.error }

  const authType = resolveAuthType(args, found.authType)
  if (typeof authType === 'object') return { success: false, output: '', error: authType.error }

  const encoding = parseEncoding(argStr(args, 'encoding'))
  if (encoding && typeof encoding === 'object' && 'error' in encoding) {
    return { success: false, output: '', error: encoding.error }
  }

  const groupId = resolveGroupId(store, args, found.groupId)
  if (groupId && typeof groupId === 'object') {
    return { success: false, output: '', error: groupId.error }
  }

  const merged: SshSession = {
    ...found,
    name,
    host,
    port,
    username: args.username !== undefined ? (argStr(args, 'username') || found.username) : found.username,
    authType,
    password: args.password !== undefined ? (argStr(args, 'password') || undefined) : found.password,
    privateKeyPath: args.privateKeyPath !== undefined
      ? (argStr(args, 'privateKeyPath') || undefined)
      : found.privateKeyPath,
    passphrase: args.passphrase !== undefined ? (argStr(args, 'passphrase') || undefined) : found.passphrase,
    groupId,
  }
  if (encoding && typeof encoding === 'string') {
    (merged as SshSession & { encoding?: SshEncoding }).encoding = encoding
  }

  store.updateSshSession(merged)
  return { success: true, output: `✅ 已更新主机 **${merged.name}**（\`${merged.id}\`）。` }
}

export function deleteSshSessionConfig(
  store: SshSessionStore,
  args: Record<string, unknown>
): ToolResult {
  const found = findSession(store, args)
  if ('error' in found) return { success: false, output: '', error: found.error }
  store.deleteSshSession(found.id)
  const n = store.getSshSessions().length
  return { success: true, output: `✅ 已删除主机 **${found.name}**（\`${found.id}\`）。剩余 ${n} 台。` }
}

export function executeSshSessionAction(
  store: SshSessionStore,
  args: Record<string, unknown>
): ToolResult {
  const action = argStr(args, 'action')
  if (action === 'add') return addSshSessionConfig(store, args)
  if (action === 'update') return updateSshSessionConfig(store, args)
  if (action === 'delete') return deleteSshSessionConfig(store, args)
  return { success: false, output: '', error: 'action 须为 add、update 或 delete' }
}
