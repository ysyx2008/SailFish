/**
 * 伙计调度：派出 / 再交代 / 等待 / 打断。
 * 伙计用真正的 Agent 循环，花名册活在这场 run 里。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentContext } from '../types'
import { getDefaultShell, getLocalOS } from '../../../utils/platform'
import { getMetaByName } from '../tool-metadata'
import { MAX_LIVE_CHILDREN, type ChildSnapshot, type RosterSpawnDeps, type SpawnTask, type SubAgentRoster } from '../sub-agent-roster'
import { parseForkTurns, sanitizeParentMessages, type ForkTurns } from '../sanitize-parent-messages'
import type { ToolExecutorConfig, ToolResult, AgentConfig } from './types'
import { getAgentTools, filterSubAgentTools } from '../tools'
import { truncateFromEnd, truncateFromEndWithNotice } from './utils'
import { getScratchPath } from './file'
import { createLogger } from '../../../utils/logger'
import { t } from '../i18n'

const log = createLogger('SubAgent')
const MAX_RESULT_LENGTH = 8000

function archiveLongResult(taskId: string, text: string, artifactDir: string): string {
  if (text.length <= MAX_RESULT_LENGTH) return text
  try {
    fs.mkdirSync(artifactDir, { recursive: true })
    const filePath = path.join(artifactDir, `${taskId}.md`)
    fs.writeFileSync(filePath, text, 'utf-8')
    log.info(`Sub-agent [${taskId}] result archived to ${filePath} (${text.length} chars)`)
    return truncateFromEndWithNotice(text, MAX_RESULT_LENGTH, (originalLength) =>
      t('dispatch.result_archived', { total: originalLength, path: filePath }))
  } catch (err) {
    log.warn(`Sub-agent [${taskId}] failed to archive result, falling back to truncation: ${err}`)
    return truncateFromEnd(text, MAX_RESULT_LENGTH)
  }
}

function buildArtifactDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const nonce = Math.random().toString(36).slice(2, 6)
  return path.join(getScratchPath(), 'sub-agents', `${stamp}-${nonce}`)
}

/** 伙计工具清单：按元数据过滤，不再分 read/write */
export function getSubAgentTools(_ignored?: string): ToolDefinition[] {
  return filterSubAgentTools(getAgentTools(undefined, { mode: 'assistant' }))
}

/**
 * 伙计的运行上下文：不管主人从哪里派出，伙计都没有窗、在本机干活。
 * 主人眼前的窗格、远程主机的系统与目录都不带过去；其余字段照旧带。
 * AgentContext 新增与窗格或远程主机相关的字段时，必须在这里剥掉。
 */
export function toSubAgentContext(parent: AgentContext): AgentContext {
  const {
    ptyId: _ptyId,
    panes: _panes,
    activePaneId: _activePaneId,
    mode: _mode,
    sshHost: _sshHost,
    workbenchPrompt: _workbenchPrompt,
    ...rest
  } = parent
  return {
    ...rest,
    terminalType: 'assistant',
    terminalOutput: [],
    systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
    hostId: 'local',
    cwd: parent.terminalType === 'ssh' ? os.homedir() : (parent.cwd || os.homedir()),
    unattended: true,
  }
}

function formatKnock(child: ChildSnapshot): string {
  if (child.status === 'completed') {
    return t('dispatch.knock_done', {
      name: child.name,
      description: child.description,
      result: child.result || '(no output)'
    })
  }
  if (child.status === 'interrupted') {
    return t('dispatch.knock_interrupted', {
      name: child.name,
      description: child.description
    })
  }
  return t('dispatch.knock_fail', {
    name: child.name,
    description: child.description,
    error: child.error || 'Unknown error'
  })
}

function formatSpawned(names: string[], snapshots: ChildSnapshot[], roster: SubAgentRoster): string {
  const lines = snapshots.map(c => `- ${c.name}：${c.description}`)
  return [
    t('dispatch.spawned', { count: names.length, list: lines.join('\n') }),
    t('dispatch.capacity', { live: roster.liveCount(), room: roster.room() }),
  ].join('\n')
}

function spawnDeps(
  executor: ToolExecutorConfig,
  progressStepId: string,
  artifactDir: string,
  ownedNames?: Set<string>
): RosterSpawnDeps | { error: string } {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { error: 'dispatch_agents 需要主人花名册（内部错误）' }
  const createChild = executor.createChildAgent
  if (!createChild) return { error: 'dispatch_agents 需要能创建伙计（内部错误）' }
  const agentContext = executor.getAgentContext?.()
  if (!agentContext) return { error: 'dispatch_agents 需要 Agent 运行上下文（内部错误）' }

  return {
    createChild,
    getParentMessages: () => executor.getParentMessages?.() ?? [],
    getParentContext: () => toSubAgentContext(executor.getAgentContext?.() ?? agentContext),
    knock: (message) => executor.knockParent?.(message),
    onProgress: (children) => {
      const visible = ownedNames
        ? children.filter(c => ownedNames.has(c.name))
        : children
      executor.updateStep(progressStepId, {
        subAgents: visible.map(c => ({
          id: c.name,
          name: c.name,
          description: c.description,
          prompt: c.prompt,
          status: c.status,
          result: c.result,
          error: c.error,
          steps: c.steps,
          blockedReason: c.blockedReason,
        }))
      })
    },
    ownedNames,
    isParentAborted: () => executor.isAborted(),
    sanitize: sanitizeParentMessages,
    formatKnock,
    archiveResult: (name, text) => archiveLongResult(name, text, artifactDir),
  }
}

type ParsedSpawnTask = SpawnTask & { forkTurns: ForkTurns }

function optionalName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** tasks 每人一份指令；batch 一份共同指令加一批条目，交给伙计的是共同指令、换行、本条目。两种可同次混用。 */
export function parseDispatchTasks(args: Record<string, unknown>): { tasks: ParsedSpawnTask[] } | { error: string } {
  const tasks: ParsedSpawnTask[] = []
  const rawTasks = args.tasks
  const rawBatch = args.batch
  if (rawTasks !== undefined && !Array.isArray(rawTasks)) {
    return { error: 'tasks 必须是数组，每项包含 description 和 prompt' }
  }
  if (Array.isArray(rawTasks)) {
    for (let i = 0; i < rawTasks.length; i++) {
      const task = rawTasks[i] as Record<string, unknown> | undefined
      if (typeof task?.prompt !== 'string' || task.prompt.trim() === '') {
        return { error: `子任务 ${i + 1} 缺少 prompt（任务指令）` }
      }
      const forkTurns = parseForkTurns(task.fork_turns)
      if ('error' in forkTurns) return { error: `子任务 ${i + 1}：${forkTurns.error}` }
      tasks.push({
        name: optionalName(task.name),
        description: typeof task.description === 'string' && task.description ? task.description : 'task',
        prompt: task.prompt,
        forkTurns,
      })
    }
  }
  if (rawBatch !== undefined) {
    const batch = rawBatch as Record<string, unknown> | null
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
      return { error: 'batch 必须是对象，包含 instruction 和 items' }
    }
    if (typeof batch.instruction !== 'string' || batch.instruction.trim() === '') {
      return { error: 'batch 缺少 instruction（共同指令）' }
    }
    if (!Array.isArray(batch.items) || batch.items.length === 0) {
      return { error: 'batch.items 必须是非空数组，每项包含 description 和 input' }
    }
    const forkTurns = parseForkTurns(batch.fork_turns)
    if ('error' in forkTurns) return { error: `batch：${forkTurns.error}` }
    for (let i = 0; i < batch.items.length; i++) {
      const item = batch.items[i] as Record<string, unknown> | undefined
      if (typeof item?.input !== 'string' || item.input.trim() === '') {
        return { error: `batch 第 ${i + 1} 条缺少 input` }
      }
      const name = optionalName(item.name)
      tasks.push({
        name,
        description: typeof item.description === 'string' && item.description ? item.description : (name ?? `${i + 1}`),
        prompt: `${batch.instruction}\n${item.input}`,
        forkTurns,
      })
    }
  }
  if (tasks.length === 0) {
    return { error: 'tasks 和 batch 至少给一个，且不能为空' }
  }
  return { tasks }
}

export async function dispatchSubAgents(
  args: Record<string, unknown>,
  _config: AgentConfig,
  executor: ToolExecutorConfig,
  _toolCallId?: string
): Promise<ToolResult> {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) {
    return { success: false, output: '', error: 'dispatch_agents 需要主人花名册（内部错误）' }
  }

  const parsed = parseDispatchTasks(args)
  if ('error' in parsed) {
    return { success: false, output: '', error: parsed.error }
  }
  const parsedTasks = parsed.tasks
  if (parsedTasks.length > roster.room()) {
    return {
      success: false,
      output: '',
      error: t('dispatch.over_fuse', {
        max: MAX_LIVE_CHILDREN,
        live: roster.liveCount(),
        room: roster.room(),
        count: parsedTasks.length,
      }),
    }
  }

  const progressStep = executor.addStep({
    type: 'tool_call',
    content: t('dispatch.running', { count: parsedTasks.length }),
    toolName: 'dispatch_agents',
    toolArgs: { tasks: parsedTasks.map(task => ({ name: task.name, description: task.description })) },
    riskLevel: 'safe',
    success: true,
    subAgents: []
  })

  const ownedNames = new Set<string>()
  const deps = spawnDeps(executor, progressStep.id, buildArtifactDir(), ownedNames)
  if ('error' in deps) {
    return { success: false, output: '', error: deps.error }
  }

  const names = roster.spawn(parsedTasks, deps)

  const snapshots = roster.list().filter(c => names.includes(c.name))
  executor.updateStep(progressStep.id, {
    content: t('dispatch.running', { count: names.length }),
    subAgents: snapshots.map(c => ({
      id: c.name,
      name: c.name,
      description: c.description,
      prompt: c.prompt,
      status: c.status,
    }))
  })

  log.info(`Dispatched ${names.length} sub-agents: ${names.join(', ')}`)
  return {
    success: true,
    output: formatSpawned(names, snapshots, roster)
  }
}

export async function followupAgent(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { success: false, output: '', error: '没有花名册' }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!name || !message) return { success: false, output: '', error: '需要 name 和 message' }

  const progressStep = executor.addStep({
    type: 'tool_call',
    content: t('dispatch.followup_ok', { name }),
    toolName: 'followup_agent',
    toolArgs: { name, message },
    riskLevel: 'safe',
    success: true,
  })

  const deps = spawnDeps(executor, progressStep.id, buildArtifactDir())
  if ('error' in deps) return { success: false, output: '', error: deps.error }

  const result = roster.followup(name, message, deps)
  if (!result.ok) {
    executor.updateStep(progressStep.id, { success: false, content: result.error })
    return { success: false, output: '', error: result.error }
  }
  return { success: true, output: t('dispatch.followup_ok', { name }) }
}

export async function waitAgents(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { success: false, output: '', error: '没有花名册' }
  const names = Array.isArray(args.names)
    ? (args.names as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : undefined
  const timeoutSec = Math.min(Math.max(1, Number(args.timeout) || 120), 600)

  const parentSignal = executor.getAbortSignal?.()
  const timeout = AbortSignal.timeout(timeoutSec * 1000)
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeout])
    : timeout

  const snapshots = await roster.waitForNews(names, signal)
  if (executor.isAborted()) {
    return { success: false, output: '', error: t('error.operation_aborted') }
  }

  const stillLive = snapshots.some(c => c.status === 'pending' || c.status === 'running')
  const noneLeft = snapshots.length === 0
  const rosterLines = snapshots.map(c => {
    const status = c.status === 'completed'
      ? t('dispatch.status_completed')
      : c.status === 'interrupted'
        ? t('dispatch.status_interrupted')
        : c.status === 'failed'
          ? t('dispatch.status_failed')
          : c.status === 'pending'
            ? t('dispatch.status_pending')
            : t('dispatch.status_running')
    return `- ${c.name}：${status}`
  })
  const body = rosterLines.join('\n') || t('dispatch.wait_empty')
  if (noneLeft) {
    return { success: true, output: body }
  }
  if (stillLive && snapshots.every(c => c.status === 'pending' || c.status === 'running')) {
    return { success: true, output: `${t('dispatch.wait_news_timeout', { seconds: timeoutSec })}\n${body}` }
  }
  return {
    success: true,
    output: `${t('dispatch.wait_news')}\n${body}`
  }
}

export async function interruptAgent(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { success: false, output: '', error: '没有花名册' }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  if (!name) return { success: false, output: '', error: '需要 name' }
  const result = roster.interrupt(name)
  if (!result.ok) return { success: false, output: '', error: result.error }
  if (result.finalized) {
    const snap = roster.get(name)
    if (snap) executor.knockParent?.(formatKnock(snap))
  }
  return { success: true, output: t('dispatch.interrupt_ok', { name }) }
}

export function denyIfParentOnly(executor: ToolExecutorConfig, toolName: string): ToolResult | null {
  if (!executor.isSubAgent) return null
  const catalog = executor.getToolCatalog?.()
  if (!catalog) return null
  const meta = getMetaByName(catalog, toolName)
  if (meta?.allowedForSubAgent === false) {
    return { success: false, output: '', error: t('dispatch.tool_denied') }
  }
  return null
}
