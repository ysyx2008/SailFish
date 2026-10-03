/**
 * manage_tasks 工具的执行器：联络 Agent 的任务管理。
 *
 * 工具定义由联络工作台贡献（@sailfish/workbench-companion/agent-tools），
 * 仅 __companion__ 注册（见 sailfish.getAvailableTools）；本文件只含执行逻辑。
 * 信任模型（转述制）：confirm 只把用户的明确决定传达给任务 Agent。
 */
import { t } from '../i18n'
import { createLogger } from '../../../utils/logger'
import type { ToolExecutorConfig, ToolResult } from './types'
import type { TaskSupervisor, SupervisedTaskInfo } from '../task-supervisor'

const log = createLogger('tools/task-manager')

export async function manageTasks(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const supervisor = executor.taskSupervisor
  if (!supervisor) {
    return { success: false, output: '', error: t('taskmgr.not_available') }
  }

  const action = typeof args.action === 'string' ? args.action : ''
  const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
  const toolCallId = typeof args.tool_call_id === 'string' ? args.tool_call_id.trim() : ''
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
  const fullAuto = args.full_auto === true

  executor.addStep({
    type: 'tool_call',
    content: `${t('taskmgr.step')}：${action}${title ? `「${title}」` : ''}`,
    toolName: 'manage_tasks',
    toolArgs: { ...args },
    riskLevel: 'safe',
  })

  const finish = (result: ToolResult, stepContent: string): ToolResult => {
    executor.addStep({
      type: 'tool_result',
      content: stepContent,
      toolName: 'manage_tasks',
      toolResult: result.success ? result.output : result.error,
    })
    return result
  }

  try {
    switch (action) {
      case 'list':
        return finish(doList(supervisor), t('taskmgr.action.list'))

      case 'inspect':
        return finish(doInspect(supervisor, taskId), t('taskmgr.action.inspect'))

      case 'create': {
        if (!title) return finish(fail(t('taskmgr.missing_param', { param: 'title' })), t('taskmgr.action.create'))
        if (!brief) return finish(fail(t('taskmgr.missing_param', { param: 'brief' })), t('taskmgr.action.create'))
        const { agentKey } = await supervisor.createTask({ title, brief, fullAuto })
        log.info(`联络创建任务: 「${title}」(${agentKey}, fullAuto=${fullAuto})`)
        const mode = t(fullAuto ? 'taskmgr.mode_free' : 'taskmgr.mode_relaxed')
        return finish(
          ok(t('taskmgr.created', { title, taskId: agentKey, mode })),
          t('taskmgr.action.create')
        )
      }

      case 'confirm': {
        if (!taskId) return finish(fail(t('taskmgr.missing_param', { param: 'task_id' })), t('taskmgr.action.confirm'))
        if (!toolCallId) return finish(fail(t('taskmgr.missing_param', { param: 'tool_call_id' })), t('taskmgr.action.confirm'))
        if (typeof args.approve !== 'boolean') return finish(fail(t('taskmgr.missing_param', { param: 'approve' })), t('taskmgr.action.confirm'))
        const result = supervisor.confirmTask(taskId, toolCallId, args.approve)
        if (!result.ok) {
          const msg = result.reason === 'task_not_found'
            ? t('taskmgr.task_not_found', { taskId })
            : result.reason === 'settled'
              ? t('taskmgr.settled', { title: result.title ?? taskId })
              : t('taskmgr.confirm_stale')
          return finish(fail(msg), t('taskmgr.action.confirm'))
        }
        const decision = t(args.approve ? 'taskmgr.approve' : 'taskmgr.reject')
        log.info(`联络传达确认决定: task=${taskId}, toolCallId=${toolCallId}, approved=${args.approve}`)
        return finish(
          ok(t('taskmgr.confirm_done', { decision, title: result.title ?? taskId })),
          t('taskmgr.action.confirm')
        )
      }

      case 'stop': {
        if (!taskId) return finish(fail(t('taskmgr.missing_param', { param: 'task_id' })), t('taskmgr.action.stop'))
        const result = supervisor.stopTask(taskId)
        if (!result.ok) {
          const msg = result.reason === 'task_not_found'
            ? t('taskmgr.task_not_found', { taskId })
            : result.reason === 'settled'
              ? t('taskmgr.settled', { title: result.title ?? taskId })
              : t('taskmgr.not_running', { title: result.title ?? taskId })
          return finish(fail(msg), t('taskmgr.action.stop'))
        }
        log.info(`联络停止任务: ${taskId}`)
        return finish(ok(t('taskmgr.stopped', { title: result.title ?? taskId })), t('taskmgr.action.stop'))
      }

      default:
        return finish(fail(t('taskmgr.unknown_action', { action: action || '(empty)' })), t('taskmgr.step'))
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error('manage_tasks 执行失败:', err)
    return finish(fail(msg), t('taskmgr.step'))
  }
}

function ok(output: string): ToolResult {
  return { success: true, output }
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}

function statusLabel(info: SupervisedTaskInfo): string {
  if (info.pendingConfirmation) return t('taskmgr.status_pending')
  if (info.isRunning) return t('taskmgr.status_running')
  if (info.settled === 'failed') return t('taskmgr.status_failed')
  if (info.settled === 'aborted') return t('taskmgr.status_aborted')
  if (info.settled === 'completed') return t('taskmgr.status_completed')
  return t('taskmgr.status_idle')
}

function formatTaskLine(index: number, info: SupervisedTaskInfo): string {
  const parts = [
    `${index}. 「${info.title}」`,
    t('taskmgr.line_status', { status: statusLabel(info) }),
  ]
  if (info.pendingConfirmation) {
    parts.push(t('taskmgr.line_pending', {
      tool: info.pendingConfirmation.displayName || info.pendingConfirmation.toolName,
      risk: info.pendingConfirmation.riskLevel,
      toolCallId: info.pendingConfirmation.toolCallId,
      args: info.pendingConfirmation.argsPreview || '-',
    }))
  } else if (info.isRunning) {
    parts.push(t('taskmgr.line_running', { tool: info.currentToolName || '-', steps: info.stepCount }))
  } else if (!info.settled) {
    parts.push(t('taskmgr.line_idle', { steps: info.stepCount }))
  }
  parts.push(`task_id=${info.agentKey}`)
  return parts.join('｜')
}

function doList(supervisor: TaskSupervisor): ToolResult {
  const tasks = supervisor.listSupervisedTasks()
  if (tasks.length === 0) return ok(t('taskmgr.list_empty'))
  const lines = tasks.map((task, i) => formatTaskLine(i + 1, task))
  return ok(`${t('taskmgr.list_header', { count: tasks.length })}\n${lines.join('\n')}`)
}

function doInspect(supervisor: TaskSupervisor, taskId: string): ToolResult {
  if (!taskId) return fail(t('taskmgr.missing_param', { param: 'task_id' }))
  const detail = supervisor.inspectTask(taskId)
  if (!detail) return fail(t('taskmgr.task_not_found', { taskId }))

  const lines = [
    t('taskmgr.inspect_header', { title: detail.title, taskId: detail.agentKey }),
    t('taskmgr.inspect_meta', {
      terminalType: detail.terminalType,
      status: statusLabel(detail),
      steps: detail.stepCount,
    }),
  ]
  if (detail.pendingConfirmation) {
    lines.push(t('taskmgr.inspect_pending', {
      tool: detail.pendingConfirmation.displayName || detail.pendingConfirmation.toolName,
      risk: detail.pendingConfirmation.riskLevel,
      toolCallId: detail.pendingConfirmation.toolCallId,
      args: detail.pendingConfirmation.argsPreview || '-',
    }))
  }
  lines.push(t('taskmgr.inspect_recent', { count: detail.recentSteps.length }))
  lines.push(...detail.recentSteps)
  return ok(lines.join('\n'))
}
