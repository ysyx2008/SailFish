/**
 * 关切技能执行器
 * 实现 Agent 对关切的完整 CRUD + 触发 + 历史查询
 */
import { getWatchService } from '../../../watch/watch.service'
import type { WatchTrigger, WatchExecution, WatchOutput, WatchDefinition, CreateWatchParams } from '../../../watch/types'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'

export async function executeWatchTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'watch_list':
      return listWatches(args)
    case 'watch_create':
      return createWatch(args)
    case 'watch_update':
      return updateWatch(args)
    case 'watch_delete':
      return deleteWatch(args)
    case 'watch_toggle':
      return toggleWatch(args)
    case 'watch_trigger':
      return triggerWatch(args, executor)
    case 'watch_history':
      return getHistory(args)
    default:
      return { success: false, output: '', error: `未知的关切工具: ${toolName}` }
  }
}

async function listWatches(args: Record<string, unknown>): Promise<ToolResult> {
  const includeDisabled = args.include_disabled as boolean ?? true

  try {
    const service = getWatchService()
    let watches = service.getAll()

    if (!includeDisabled) {
      watches = watches.filter(w => w.enabled)
    }

    if (watches.length === 0) {
      return { success: true, output: '暂无关切。可通过对话让我帮你创建。' }
    }

    const list = watches.map(w => {
      const status = w.enabled ? '✓ 启用' : '○ 禁用'
      const triggers = w.triggers.map(t => formatTriggerBrief(t)).join(', ')
      const nextRun = w.nextRun ? new Date(w.nextRun).toLocaleString('zh-CN') : '—'
      const lastStatus = w.lastRun ? `${w.lastRun.status}` : '未执行'

      return `- **${w.name}** [${status}]
  ID: ${w.id}
  触发: ${triggers}
  上次: ${lastStatus} | 下次: ${nextRun}
  指令: ${w.prompt.substring(0, 60)}${w.prompt.length > 60 ? '...' : ''}`
    }).join('\n\n')

    return { success: true, output: `共 ${watches.length} 个关切：\n\n${list}` }
  } catch (error) {
    return { success: false, output: '', error: `获取关切列表失败: ${errMsg(error)}` }
  }
}

async function createWatch(args: Record<string, unknown>): Promise<ToolResult> {
  const name = args.name as string
  const prompt = args.prompt as string
  const rawTriggers = args.triggers as Array<Record<string, unknown>> | undefined

  if (!name?.trim()) return { success: false, output: '', error: '名称不能为空' }
  if (!prompt?.trim()) return { success: false, output: '', error: '执行指令不能为空' }
  if (!rawTriggers?.length) return { success: false, output: '', error: '至少需要一个触发方式' }

  try {
    const triggers = rawTriggers.map(parseTrigger)
    const output = parseOutput(args.output as string | undefined)

    const params: CreateWatchParams = {
      name: name.trim(),
      prompt: prompt.trim(),
      triggers,
      description: (args.description as string)?.trim(),
      skills: args.skills as string[] | undefined,
      execution: { type: 'local' } as WatchExecution,
      output,
      priority: (args.priority as CreateWatchParams['priority']) || 'normal',
      enabled: args.enabled as boolean ?? true,
    }

    const service = getWatchService()
    const watch = service.create(params)

    const nextRun = watch.nextRun ? new Date(watch.nextRun).toLocaleString('zh-CN') : '—'
    const triggerDesc = watch.triggers.map(t => formatTriggerBrief(t)).join(', ')

    return {
      success: true,
      output: `✅ 关切创建成功\n名称：${watch.name}\nID：${watch.id}\n触发：${triggerDesc}\n下次执行：${nextRun}`
    }
  } catch (error) {
    return { success: false, output: '', error: `创建关切失败: ${errMsg(error)}` }
  }
}

async function updateWatch(args: Record<string, unknown>): Promise<ToolResult> {
  const watchId = args.watch_id as string
  if (!watchId?.trim()) return { success: false, output: '', error: '关切 ID 不能为空' }

  try {
    const service = getWatchService()
    const existing = service.get(watchId)
    if (!existing) return { success: false, output: '', error: `关切不存在: ${watchId}` }

    const updates: Partial<CreateWatchParams> = {}
    if (args.name) updates.name = (args.name as string).trim()
    if (args.prompt) updates.prompt = (args.prompt as string).trim()
    if (args.triggers) updates.triggers = (args.triggers as Array<Record<string, unknown>>).map(parseTrigger)
    if (args.output) updates.output = parseOutput(args.output as string)
    if (args.priority) updates.priority = args.priority as CreateWatchParams['priority']
    if (args.enabled !== undefined) updates.enabled = args.enabled as boolean

    const watch = service.update(watchId, updates)
    if (!watch) return { success: false, output: '', error: '更新失败' }

    return { success: true, output: `✅ 关切 "${watch.name}" 已更新` }
  } catch (error) {
    return { success: false, output: '', error: `更新关切失败: ${errMsg(error)}` }
  }
}

async function deleteWatch(args: Record<string, unknown>): Promise<ToolResult> {
  const watchId = args.watch_id as string
  if (!watchId?.trim()) return { success: false, output: '', error: '关切 ID 不能为空' }

  try {
    const service = getWatchService()
    const watch = service.get(watchId)
    if (!watch) return { success: false, output: '', error: `关切不存在: ${watchId}` }

    const name = watch.name
    const ok = service.delete(watchId)
    return ok
      ? { success: true, output: `✅ 已删除关切：${name}` }
      : { success: false, output: '', error: '删除失败' }
  } catch (error) {
    return { success: false, output: '', error: `删除关切失败: ${errMsg(error)}` }
  }
}

async function toggleWatch(args: Record<string, unknown>): Promise<ToolResult> {
  const watchId = args.watch_id as string
  if (!watchId?.trim()) return { success: false, output: '', error: '关切 ID 不能为空' }

  try {
    const service = getWatchService()
    const watch = service.toggle(watchId)
    if (!watch) return { success: false, output: '', error: `关切不存在: ${watchId}` }

    const status = watch.enabled ? '启用' : '禁用'
    return { success: true, output: `✅ 关切 "${watch.name}" 已${status}` }
  } catch (error) {
    return { success: false, output: '', error: `切换关切状态失败: ${errMsg(error)}` }
  }
}

async function triggerWatch(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const watchId = args.watch_id as string
  if (!watchId?.trim()) return { success: false, output: '', error: '关切 ID 不能为空' }

  try {
    const service = getWatchService()
    const watch = service.get(watchId)
    if (!watch) return { success: false, output: '', error: `关切不存在: ${watchId}` }

    const step = executor.addStep({
      type: 'tool_call',
      content: `正在触发关切: ${watch.name}...`,
      toolName: 'watch_trigger',
      toolArgs: { watch_id: watchId },
      riskLevel: 'safe'
    })

    const result = await service.triggerWatch(watchId)

    executor.updateStep(step.id, {
      content: result.success
        ? `关切执行完成: ${watch.name}\n耗时: ${Math.round(result.duration / 1000)}s`
        : `关切执行失败: ${watch.name}\n错误: ${result.error}`
    })

    return result.success
      ? { success: true, output: `✅ 关切 "${watch.name}" 执行完成，耗时 ${Math.round(result.duration / 1000)} 秒${result.output ? `\n\n输出:\n${result.output}` : ''}` }
      : { success: false, output: result.output || '', error: result.error }
  } catch (error) {
    return { success: false, output: '', error: `触发关切失败: ${errMsg(error)}` }
  }
}

async function getHistory(args: Record<string, unknown>): Promise<ToolResult> {
  const watchId = args.watch_id as string | undefined
  const limit = args.limit as number ?? 10

  try {
    const service = getWatchService()
    const history = service.getHistory(watchId, limit)

    if (history.length === 0) {
      return { success: true, output: watchId ? `关切 ${watchId} 暂无执行记录` : '暂无执行记录' }
    }

    const statusIcons: Record<string, string> = {
      completed: '✓', failed: '✗', skipped: '⊘', timeout: '⏱', cancelled: '⊘', running: '●'
    }

    const list = history.map(r => {
      const icon = statusIcons[r.status] || '?'
      const time = new Date(r.at).toLocaleString('zh-CN')
      const dur = r.duration < 1000 ? `${r.duration}ms` : `${(r.duration / 1000).toFixed(1)}s`
      const extra = r.error ? `\n  错误: ${r.error}` : r.skipReason ? `\n  跳过: ${r.skipReason}` : ''
      return `${icon} **${r.watchName}** - ${time}\n  耗时: ${dur}${extra}`
    }).join('\n\n')

    return { success: true, output: `最近 ${history.length} 条执行记录:\n\n${list}` }
  } catch (error) {
    return { success: false, output: '', error: `获取历史记录失败: ${errMsg(error)}` }
  }
}

// ==================== 辅助函数 ====================

function parseTrigger(raw: Record<string, unknown>): WatchTrigger {
  const type = raw.type as string
  switch (type) {
    case 'cron': {
      const expression = raw.expression as string
      if (!expression?.trim()) throw new Error('cron 触发器需要 expression 字段')
      return { type: 'cron', expression }
    }
    case 'interval': {
      const seconds = Number(raw.seconds)
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('interval 触发器需要有效的正数 seconds')
      return { type: 'interval', seconds }
    }
    case 'heartbeat':
      return { type: 'heartbeat' }
    case 'manual':
      return { type: 'manual' }
    case 'webhook':
      return { type: 'webhook', token: '' }
    case 'file_change': {
      const paths = raw.paths as string[] | undefined
      if (!paths?.length) throw new Error('file_change 触发器需要 paths 字段')
      return {
        type: 'file_change',
        paths,
        pattern: raw.pattern as string | undefined,
        events: raw.events as Array<'add' | 'change' | 'unlink'> | undefined
      }
    }
    case 'calendar':
      return { type: 'calendar', beforeMinutes: Number(raw.before_minutes) || 15 }
    case 'email': {
      const filter: { from?: string; subject?: string; unseen: boolean } = { unseen: true }
      if (typeof raw.filter_from === 'string' && raw.filter_from.trim()) filter.from = raw.filter_from.trim()
      if (typeof raw.filter_subject === 'string' && raw.filter_subject.trim()) filter.subject = raw.filter_subject.trim()
      return { type: 'email', filter }
    }
    default:
      throw new Error(`不支持的触发类型: ${type}`)
  }
}

function parseOutput(raw: string | undefined): WatchOutput {
  const validTypes = ['desktop', 'im', 'notification', 'log', 'silent'] as const
  const type = (typeof raw === 'string' && validTypes.includes(raw as typeof validTypes[number]))
    ? raw as WatchOutput['type']
    : 'desktop'
  return { type }
}

function formatTriggerBrief(t: WatchTrigger): string {
  switch (t.type) {
    case 'cron': return `定时(${t.expression})`
    case 'interval': {
      if (t.seconds >= 3600) return `每${Math.round(t.seconds / 3600)}小时`
      if (t.seconds >= 60) return `每${Math.round(t.seconds / 60)}分钟`
      return `每${t.seconds}秒`
    }
    case 'heartbeat': return '心跳'
    case 'manual': return '手动'
    case 'webhook': return 'Webhook'
    case 'file_change': return `文件变化(${t.paths.length}个路径)`
    case 'calendar': return `日历(提前${t.beforeMinutes}分钟)`
    case 'email': return '邮件'
    default: return (t as WatchTrigger).type
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
