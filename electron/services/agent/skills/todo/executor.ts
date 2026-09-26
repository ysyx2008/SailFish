/**
 * 本地秘书待办技能 - 执行器
 */
import type { TodoItem, TodoJournalKind, TodoPriority, TodoSourceKind, TodoStatus } from '@sailfish/shared-types'
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../tools/types'
import {
  applyTodoUpdate,
  createTodoItem,
  getTodoService,
  hasLegacyTodoMd,
  LEGACY_TODO_MD_HINT,
  mutateStore,
  type TodoJournalInput,
  type TodoSourceInput,
} from './store'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('TodoExecutor')

const PRIORITY_RANK: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
}

function withLegacyHint(output: string): string {
  if (!hasLegacyTodoMd()) return output
  return `${output}\n\n${LEGACY_TODO_MD_HINT}`
}

function formatItem(item: TodoItem): string {
  const parts = [
    `- **${item.title}** [\`${item.id}\`]`,
    `  status: ${item.status}`,
  ]
  if (item.priority) parts.push(`  priority: ${item.priority}`)
  if (item.dueDate) parts.push(`  due: ${item.dueDate}`)
  parts.push(`  created: ${item.createdAt}`)
  parts.push(`  updated: ${item.updatedAt}`)
  if (item.completedAt) parts.push(`  completed: ${item.completedAt}`)
  if (item.description) parts.push(`  desc: ${item.description}`)
  if (item.tags?.length) parts.push(`  tags: ${item.tags.join(', ')}`)
  if (item.sources?.length) {
    parts.push(`  sources: ${item.sources.map(s => s.kind + (s.label ? `(${s.label})` : '')).join(', ')}`)
  }
  if (item.journal?.length) {
    parts.push(`  journal: ${item.journal.length}`)
  }
  return parts.join('\n')
}

async function todoList(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const store = getTodoService().load()
  let items = [...store.todos]

  const status = args.status as string | undefined
  const includeDone = args.include_done === true || status === 'all'

  if (status && status !== 'all') {
    items = items.filter(t => t.status === status)
  } else if (!includeDone) {
    items = items.filter(t => t.status === 'pending' || t.status === 'in_progress')
  }

  if (typeof args.priority === 'string' && args.priority) {
    items = items.filter(t => t.priority === args.priority)
  }
  const dueBefore = typeof args.due_before === 'string' ? args.due_before : ''
  if (dueBefore) {
    items = items.filter(t => t.dueDate && t.dueDate <= dueBefore)
  }
  const dueAfter = typeof args.due_after === 'string' ? args.due_after : ''
  if (dueAfter) {
    items = items.filter(t => t.dueDate && t.dueDate >= dueAfter)
  }
  if (typeof args.tag === 'string' && args.tag) {
    items = items.filter(t => t.tags?.includes(args.tag as string))
  }

  const sortBy = (args.sort_by as string) || 'due'
  const sortOrder = (args.sort_order as string) === 'desc' ? -1 : 1
  items.sort((a, b) => {
    let cmp = 0
    switch (sortBy) {
      case 'created':
        cmp = a.createdAt.localeCompare(b.createdAt)
        break
      case 'updated':
        cmp = a.updatedAt.localeCompare(b.updatedAt)
        break
      case 'priority': {
        const ra = a.priority ? PRIORITY_RANK[a.priority] : 99
        const rb = b.priority ? PRIORITY_RANK[b.priority] : 99
        cmp = ra - rb
        break
      }
      case 'due':
      default: {
        if (a.dueDate && b.dueDate) cmp = a.dueDate.localeCompare(b.dueDate)
        else if (a.dueDate) cmp = -1
        else if (b.dueDate) cmp = 1
        else cmp = a.createdAt.localeCompare(b.createdAt)
        break
      }
    }
    return cmp * sortOrder
  })

  executor.addStep({
    type: 'tool_call',
    content: `列出本地待办 (${items.length})`,
    toolName: 'todo_list',
    toolArgs: args,
    riskLevel: 'safe',
  })

  const body =
    items.length === 0
      ? '（无匹配待办）'
      : items.map(formatItem).join('\n\n')
  const output = withLegacyHint(`## 本地待办 (${items.length})\n\n${body}`)

  executor.addStep({
    type: 'tool_result',
    content: `本地待办 ${items.length} 条`,
    toolName: 'todo_list',
    toolResult: output,
  })

  return { success: true, output }
}

async function todoCreate(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) {
    return { success: false, output: '', error: 'title is required' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `创建待办: ${title}`,
    toolName: 'todo_create',
    toolArgs: { title },
    riskLevel: 'safe',
  })

  const sessionId = executor.getSessionId?.()
  const sources = sessionId
    ? [{ kind: 'conversation' as const, sessionId, agentKey: executor.agentId }]
    : undefined

  const item = createTodoItem({
    title,
    description: typeof args.description === 'string' ? args.description : undefined,
    priority: args.priority as TodoPriority | undefined,
    dueDate: typeof args.due_date === 'string' ? args.due_date : undefined,
    tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
    status: args.status as TodoStatus | undefined,
    sources,
  })

  await mutateStore(store => {
    store.todos.push(item)
  })

  const output = withLegacyHint(`已创建待办：${item.title}\nID: ${item.id}\ncreatedAt: ${item.createdAt}`)
  executor.addStep({
    type: 'tool_result',
    content: `已创建: ${item.title}`,
    toolName: 'todo_create',
    toolResult: output,
  })
  return { success: true, output }
}

async function todoUpdate(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) return { success: false, output: '', error: 'id is required' }

  // 先找条目做 step 文案；真正更新在 mutateStore 内原子完成
  const existing = getTodoService().load().todos.find(t => t.id === id)
  if (!existing) return { success: false, output: '', error: `Todo not found: ${id}` }

  executor.addStep({
    type: 'tool_call',
    content: `更新待办: ${existing.title}`,
    toolName: 'todo_update',
    toolArgs: { id },
    riskLevel: 'safe',
  })

  const patch: Parameters<typeof applyTodoUpdate>[1] = {}
  if (typeof args.title === 'string') patch.title = args.title
  if (args.clear_description === true) patch.description = null
  else if (typeof args.description === 'string') {
    patch.description = args.description === '' ? null : args.description
  }
  const notes: string[] = []
  if (args.clear_priority === true || args.priority === '') {
    patch.priority = null
  } else if (typeof args.priority === 'string') {
    const p = args.priority as TodoPriority
    if (['low', 'normal', 'high', 'urgent'].includes(p)) patch.priority = p
    else notes.push(`ignored invalid priority: ${args.priority}`)
  }
  if (args.clear_due_date === true || args.due_date === '') patch.dueDate = null
  else if (typeof args.due_date === 'string') patch.dueDate = args.due_date
  if (args.clear_tags === true) patch.tags = null
  else if (Array.isArray(args.tags)) patch.tags = args.tags as string[]
  if (typeof args.status === 'string') {
    const s = args.status as TodoStatus
    if (['pending', 'in_progress', 'completed', 'cancelled'].includes(s)) patch.status = s
    else notes.push(`ignored invalid status: ${args.status}`)
  }

  const journalErr = journalInputError(args.journal)
  if (journalErr) return { success: false, output: '', error: journalErr }
  const sourceErr = sourceInputError(args.source)
  if (sourceErr) return { success: false, output: '', error: sourceErr }

  let updated = await mutateStore(store => {
    const idx = store.todos.findIndex(t => t.id === id)
    if (idx < 0) return null
    const next = applyTodoUpdate(store.todos[idx], patch)
    store.todos[idx] = next
    return next
  })
  if (!updated) return { success: false, output: '', error: `Todo not found: ${id}` }

  const journal = parseJournalInput(args.journal, executor.getSessionId?.())
  if (journal) {
    updated = await getTodoService().appendJournal(id, journal) ?? updated
  }
  const source = parseSourceInput(args.source)
  if (source) {
    updated = await getTodoService().addSource(id, source) ?? updated
  }

  let output = `已更新待办：\n${formatItem(updated)}`
  if (notes.length) output += `\n\n备注：${notes.join('; ')}`
  output = withLegacyHint(output)
  executor.addStep({
    type: 'tool_result',
    content: `已更新: ${updated.title}`,
    toolName: 'todo_update',
    toolResult: output,
  })
  return { success: true, output }
}

async function todoComplete(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) return { success: false, output: '', error: 'id is required' }

  const existing = getTodoService().load().todos.find(t => t.id === id)
  if (!existing) return { success: false, output: '', error: `Todo not found: ${id}` }

  executor.addStep({
    type: 'tool_call',
    content: `完成待办: ${existing.title}`,
    toolName: 'todo_complete',
    toolArgs: { id },
    riskLevel: 'safe',
  })

  const updated = await mutateStore(store => {
    const idx = store.todos.findIndex(t => t.id === id)
    if (idx < 0) return null
    const next = applyTodoUpdate(store.todos[idx], { status: 'completed' })
    store.todos[idx] = next
    return next
  })
  if (!updated) return { success: false, output: '', error: `Todo not found: ${id}` }

  const output = withLegacyHint(`已完成待办：${updated.title} (${id})`)
  executor.addStep({
    type: 'tool_result',
    content: `已完成: ${updated.title}`,
    toolName: 'todo_complete',
    toolResult: output,
  })
  return { success: true, output }
}

async function todoDelete(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const id = typeof args.id === 'string' ? args.id : ''
  if (!id) return { success: false, output: '', error: 'id is required' }

  const existing = getTodoService().load().todos.find(t => t.id === id)
  if (!existing) return { success: false, output: '', error: `Todo not found: ${id}` }

  executor.addStep({
    type: 'tool_call',
    content: `删除待办: ${existing.title}`,
    toolName: 'todo_delete',
    toolArgs: { id },
    riskLevel: 'safe',
  })

  const removed = await mutateStore(store => {
    const idx = store.todos.findIndex(t => t.id === id)
    if (idx < 0) return null
    const [item] = store.todos.splice(idx, 1)
    return item
  })
  if (!removed) return { success: false, output: '', error: `Todo not found: ${id}` }

  const output = withLegacyHint(`已删除待办：${removed.title} (${id})`)
  executor.addStep({
    type: 'tool_result',
    content: `已删除: ${removed.title}`,
    toolName: 'todo_delete',
    toolResult: output,
  })
  return { success: true, output }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function journalInputError(raw: unknown): string | null {
  if (raw == null) return null
  const obj = asRecord(raw)
  if (!obj) return 'journal must be an object'
  const kind = obj.kind
  if (kind !== 'scheduled' && kind !== 'progress') return 'journal.kind must be scheduled or progress'
  if (kind === 'scheduled' && typeof obj.start !== 'string') return 'scheduled journal requires start'
  if (kind === 'progress' && typeof obj.note !== 'string') return 'progress journal requires note'
  return null
}

function sourceInputError(raw: unknown): string | null {
  if (raw == null) return null
  const obj = asRecord(raw)
  if (!obj) return 'source must be an object'
  const kind = obj.kind
  if (kind !== 'email' && kind !== 'file' && kind !== 'url') return 'source.kind must be email, file, or url'
  if (kind === 'file' && typeof obj.path !== 'string') return 'file source requires path'
  if (kind === 'url' && typeof obj.url !== 'string') return 'url source requires url'
  if (kind === 'email' && typeof obj.message_id !== 'string' && typeof obj.subject !== 'string' && typeof obj.from !== 'string') {
    return 'email source requires message_id, subject, or from'
  }
  return null
}

function parseJournalInput(raw: unknown, sessionId?: string): TodoJournalInput | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const kind = obj.kind as TodoJournalKind
  const input: TodoJournalInput = { kind }
  if (typeof obj.start === 'string') input.start = obj.start
  if (typeof obj.end === 'string') input.end = obj.end
  if (typeof obj.calendar_id === 'string') input.calendarId = obj.calendar_id
  if (typeof obj.event_id === 'string') input.eventId = obj.event_id
  if (typeof obj.note === 'string') input.note = obj.note
  if (sessionId) input.sessionId = sessionId
  return input
}

function parseSourceInput(raw: unknown): TodoSourceInput | null {
  const obj = asRecord(raw)
  if (!obj) return null
  const input: TodoSourceInput = { kind: obj.kind as TodoSourceKind }
  if (typeof obj.label === 'string') input.label = obj.label
  if (typeof obj.message_id === 'string') input.messageId = obj.message_id
  if (typeof obj.subject === 'string') input.subject = obj.subject
  if (typeof obj.from === 'string') input.from = obj.from
  if (typeof obj.path === 'string') input.path = obj.path
  if (typeof obj.url === 'string') input.url = obj.url
  return input
}

/**
 * 执行本地 todo 技能工具
 */
export async function executeTodoTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'todo_list':
        return await todoList(args, executor)
      case 'todo_create':
        return await todoCreate(args, executor)
      case 'todo_update':
        return await todoUpdate(args, executor)
      case 'todo_complete':
        return await todoComplete(args, executor)
      case 'todo_delete':
        return await todoDelete(args, executor)
      default:
        return { success: false, output: '', error: `Unknown todo tool: ${toolName}` }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log.error(`todo tool failed: ${toolName}`, e)
    return { success: false, output: '', error: msg }
  }
}
