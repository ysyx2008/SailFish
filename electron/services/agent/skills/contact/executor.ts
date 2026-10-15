/**
 * 本地联系人技能 - 执行器
 */
import type { Contact, ContactChannel, ContactChannelKind, ContactKind, ContactUpdatePatch } from '@sailfish/shared-types'
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../tools/types'
import { LEGACY_CONTACTS_MD_HINT, shouldPointToLegacyContactsMd } from './store'
import { getContactBook } from './contact-book'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ContactExecutor')

function withLegacyHint(output: string, matched: number): string {
  if (matched > 0 || !shouldPointToLegacyContactsMd()) return output
  return `${output}\n\n${LEGACY_CONTACTS_MD_HINT}`
}

function formatChannel(channel: ContactChannel): string {
  const platform = channel.platform ? `${channel.platform} ` : ''
  const label = channel.label ? ` (${channel.label})` : ''
  return `${channel.kind}: ${platform}${channel.value}${label}`
}

export function formatContact(contact: Contact): string {
  const parts = [`- **${contact.name}** [\`${contact.id}\`] ${contact.kind}`]
  if (contact.aliases?.length) parts.push(`  aliases: ${contact.aliases.join('、')}`)
  if (contact.organization) parts.push(`  org: ${contact.organization}`)
  if (contact.role) parts.push(`  role: ${contact.role}`)
  if (contact.channels?.length) parts.push(`  ${contact.channels.map(formatChannel).join('; ')}`)
  if (contact.note) parts.push(`  note: ${contact.note}`)
  return parts.join('\n')
}

function formatList(contacts: Contact[], title: string): string {
  const body = contacts.length === 0 ? '（无）' : contacts.map(formatContact).join('\n\n')
  return withLegacyHint(`## ${title} (${contacts.length})\n\n${body}`, contacts.length)
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function parseChannel(raw: unknown): ContactChannel | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const kind = obj.kind
  if (kind !== 'email' && kind !== 'phone' && kind !== 'im') return null
  if (typeof obj.value !== 'string' || !obj.value.trim()) return null
  const channel: ContactChannel = { kind, value: obj.value.trim() }
  if (kind === 'im' && typeof obj.platform === 'string' && obj.platform.trim()) {
    channel.platform = obj.platform.trim()
  }
  if (typeof obj.label === 'string' && obj.label.trim()) channel.label = obj.label.trim()
  return channel
}

function parseChannels(raw: unknown): ContactChannel[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.map(parseChannel).filter((item): item is ContactChannel => item !== null)
}

function parseStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((item): item is string => typeof item === 'string')
}

function parseRemoveChannels(raw: unknown): Array<{ kind: ContactChannelKind, value: string }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const list: Array<{ kind: ContactChannelKind, value: string }> = []
  for (const item of raw) {
    const obj = asRecord(item)
    if (!obj) continue
    const kind = obj.kind
    if (kind !== 'email' && kind !== 'phone' && kind !== 'im') continue
    if (typeof obj.value !== 'string' || !obj.value.trim()) continue
    list.push({ kind, value: obj.value })
  }
  return list.length ? list : undefined
}

/** 给人看的是谁，不把编号摊在界面上。同名时带上单位或角色。改名则写成「原来 → 现在」。 */
function contactStepLabel(id: string, nextName?: string): string {
  const contact = getContactBook().list().find(item => item.id === id)
  if (!contact) return id
  const hint = contact.organization || contact.role
  const who = hint ? `${contact.name} · ${hint}` : contact.name
  const renamed = nextName?.trim()
  if (renamed && renamed !== contact.name) return `${who} → ${renamed}`
  return who
}

function step(executor: ToolExecutorConfig, toolName: string, content: string, args: Record<string, unknown>): void {
  executor.addStep({
    type: 'tool_call',
    content,
    toolName,
    toolArgs: args,
    riskLevel: 'safe',
  })
}

function resultStep(executor: ToolExecutorConfig, toolName: string, content: string, output: string): void {
  executor.addStep({
    type: 'tool_result',
    content,
    toolName,
    toolResult: output,
  })
}

async function contactSearch(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) return { success: false, output: '', error: 'query is required' }
  step(executor, 'contact_search', `查找联系人: ${query}`, { query })
  const matches = getContactBook().search(query)
  const output = formatList(matches, `联系人「${query}」`)
  resultStep(executor, 'contact_search', `匹配 ${matches.length} 人`, output)
  return { success: true, output }
}

async function contactList(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  step(executor, 'contact_list', '列出联系人', args)
  const contacts = getContactBook().list()
  const output = formatList(contacts, '本地联系人')
  resultStep(executor, 'contact_list', `联系人 ${contacts.length} 人`, output)
  return { success: true, output }
}

async function contactAdd(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return { success: false, output: '', error: 'name is required' }
  const aliases = parseStringList(args.aliases) ?? []
  step(executor, 'contact_add', `新增联系人: ${name}`, { name })

  const outcome = await getContactBook().add({
    name,
    aliases,
    kind: args.kind as ContactKind | undefined,
    organization: typeof args.organization === 'string' ? args.organization : undefined,
    role: typeof args.role === 'string' ? args.role : undefined,
    note: typeof args.note === 'string' ? args.note : undefined,
    channels: parseChannels(args.channels),
  }, { confirmedDifferent: args.different_person === true })

  if (outcome.type === 'possibleSame') {
    const output = `未新建：下面几位的姓名/别名或邮箱/电话与这次一样。是同一个人可用 contact_update 补充；是另一个人，带 different_person: true 再调用 contact_add。\n\n${outcome.candidates.map(formatContact).join('\n\n')}`
    resultStep(executor, 'contact_add', `可能已有此人: ${name}`, output)
    return { success: true, output }
  }

  const output = `已添加联系人：${outcome.contact.name}\nID: ${outcome.contact.id}`
  resultStep(executor, 'contact_add', `已添加: ${outcome.contact.name}`, output)
  return { success: true, output }
}

async function contactUpdate(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) return { success: false, output: '', error: 'id is required' }
  const nextName = typeof args.name === 'string' ? args.name : undefined
  step(executor, 'contact_update', `更新联系人: ${contactStepLabel(id, nextName)}`, { id })

  const patch: ContactUpdatePatch = {}
  if (typeof args.name === 'string' && args.name.trim()) patch.name = args.name
  if (args.kind === 'person' || args.kind === 'org') patch.kind = args.kind
  if (typeof args.organization === 'string') patch.organization = args.organization
  if (typeof args.role === 'string') patch.role = args.role
  if (typeof args.note === 'string') patch.note = args.note
  if (Array.isArray(args.aliases)) patch.aliases = parseStringList(args.aliases) ?? []
  if (Array.isArray(args.add_aliases)) patch.addAliases = parseStringList(args.add_aliases) ?? []
  if (Array.isArray(args.channels)) patch.channels = parseChannels(args.channels) ?? []
  if (Array.isArray(args.add_channels)) patch.addChannels = parseChannels(args.add_channels) ?? []
  if (Array.isArray(args.remove_channels)) patch.removeChannels = parseRemoveChannels(args.remove_channels)

  const outcome = await getContactBook().update(id, patch)

  if (outcome.type === 'missing') return { success: false, output: '', error: `contact not found: ${id}` }

  const output = `已更新联系人：${outcome.contact.name}\nID: ${id}`
  resultStep(executor, 'contact_update', `已更新: ${outcome.contact.name}`, output)
  return { success: true, output }
}

async function contactDelete(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id.trim() : ''
  if (!id) return { success: false, output: '', error: 'id is required' }
  step(executor, 'contact_delete', `删除联系人: ${contactStepLabel(id)}`, { id })
  const outcome = await getContactBook().remove(id)
  if (outcome.type === 'missing') return { success: false, output: '', error: `contact not found: ${id}` }
  const output = `已删除联系人：${outcome.contact.name}\nID: ${id}`
  resultStep(executor, 'contact_delete', `已删除: ${outcome.contact.name}`, output)
  return { success: true, output }
}

export async function executeContactTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'contact_search':
        return await contactSearch(args, executor)
      case 'contact_list':
        return await contactList(args, executor)
      case 'contact_add':
        return await contactAdd(args, executor)
      case 'contact_update':
        return await contactUpdate(args, executor)
      case 'contact_delete':
        return await contactDelete(args, executor)
      default:
        return { success: false, output: '', error: `Unknown contact tool: ${toolName}` }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error(`contact tool failed: ${toolName}`, e)
    return { success: false, output: '', error: msg }
  }
}
