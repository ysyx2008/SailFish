/**
 * 伙计调度：派出 / 再交代 / 等待 / 打断。
 * 伙计用真正的 Agent 循环，花名册活在这场 run 里。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentStep, SubAgentResult } from '@shared/types'
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
import type { ExpertTeam } from '../expert-team'
import { createTeamTexts, expertOpening, formatTranscript } from './expert-team-text'

const log = createLogger('SubAgent')
/** 直接带回对话的结果：各人上限乘这一轮派过的人数，大致不超过这个预算 */
const INLINE_RESULT_BUDGET = 40000
const INLINE_RESULT_MAX = 8000
const INLINE_RESULT_MIN = 1000
/** 伙计进度推给界面最多约每秒 4 次 */
const PROGRESS_INTERVAL_MS = 250

function buildArtifactDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const nonce = Math.random().toString(36).slice(2, 6)
  return path.join(getScratchPath(), 'sub-agents', `${stamp}-${nonce}`)
}

function statusLabel(status: ChildSnapshot['status']): string {
  switch (status) {
    case 'completed': return t('dispatch.status_completed')
    case 'interrupted': return t('dispatch.status_interrupted')
    case 'failed': return t('dispatch.status_failed')
    case 'pending': return t('dispatch.status_pending')
    default: return t('dispatch.status_running')
  }
}

/** 做完 / 在干 / 失败 / 已打断各几个 */
function formatCounts(children: ChildSnapshot[]): string {
  const count = (pred: (c: ChildSnapshot) => boolean) => children.filter(pred).length
  return t('dispatch.counts', {
    completed: count(c => c.status === 'completed'),
    running: count(c => c.status === 'running' || c.status === 'pending'),
    failed: count(c => c.status === 'failed'),
    interrupted: count(c => c.status === 'interrupted'),
  })
}

/** 这一轮伙计的落盘处：每人一份结果文件，再加一份总览，一人一行。 */
export class SubAgentWorkspace {
  private readonly dir: string
  readonly overviewPath: string
  private readonly results = new Map<string, { chars: number; file?: string }>()
  /** 每个群聊文件写到第几条 */
  private readonly transcriptCounts = new Map<string, number>()
  /** 团名对应的群聊文件名 */
  private readonly transcriptFiles = new Map<string, string>()

  constructor(dir = buildArtifactDir()) {
    this.dir = dir
    this.overviewPath = path.join(dir, 'overview.md')
  }

  /** 直接带回对话的字数上限：这一轮派得越多越紧 */
  static inlineLimit(dispatched: number): number {
    const share = Math.floor(INLINE_RESULT_BUDGET / Math.max(1, dispatched))
    return Math.min(INLINE_RESULT_MAX, Math.max(INLINE_RESULT_MIN, share))
  }

  /** 全文落文件；返回带进对话的那份，超出上限只留尾部和文件位置 */
  keepResult(name: string, text: string, dispatched: number): string {
    const file = this.write(`${name}.md`, text)
    this.results.set(name, { chars: text.length, file })
    const limit = SubAgentWorkspace.inlineLimit(dispatched)
    if (text.length <= limit) return text
    if (!file) return truncateFromEnd(text, limit)
    return truncateFromEndWithNotice(text, limit, (originalLength) =>
      t('dispatch.result_archived', { total: originalLength, path: file }))
  }

  writeOverview(children: ChildSnapshot[]): void {
    const lines = [
      t('dispatch.overview_title', { total: children.length, counts: formatCounts(children) }),
      t('dispatch.overview_header'),
      ...children.map(c => {
        const kept = this.results.get(c.name)
        const who = [c.role, c.team && `「${c.team}」`].filter(Boolean).join(' ')
        const task = who ? `[${who}] ${c.description}` : c.description
        return [c.name, statusLabel(c.status), kept ? String(kept.chars) : '-', kept?.file ?? '-', task].join(' | ')
      }),
    ]
    this.write('overview.md', lines.join('\n') + '\n')
  }

  teamTranscriptPath(team: ExpertTeam): string {
    return path.join(this.dir, this.teamTranscriptFile(team))
  }

  /** 群里有新消息才重写 */
  writeTeamTranscript(team: ExpertTeam): void {
    const count = team.messageCount()
    if (this.transcriptCounts.get(team.name) === count) return
    if (this.write(this.teamTranscriptFile(team), formatTranscript(team))) this.transcriptCounts.set(team.name, count)
  }

  /** 一个团一个文件名：团名去掉不能进文件名的字符、截短，撞了加序号（不分大小写） */
  private teamTranscriptFile(team: ExpertTeam): string {
    const known = this.transcriptFiles.get(team.name)
    if (known) return known
    const safe = team.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'team'
    const taken = new Set([...this.transcriptFiles.values()].map(f => f.toLowerCase()))
    let file = `team-${safe}.md`
    for (let i = 2; taken.has(file.toLowerCase()); i++) file = `team-${safe}-${i}.md`
    this.transcriptFiles.set(team.name, file)
    return file
  }

  private write(fileName: string, content: string): string | undefined {
    const filePath = path.join(this.dir, fileName)
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      return filePath
    } catch (err) {
      log.warn(`Sub-agent workspace write failed (${filePath}): ${err}`)
      return undefined
    }
  }
}

const workspaces = new WeakMap<SubAgentRoster, SubAgentWorkspace>()

export function workspaceOf(roster: SubAgentRoster): SubAgentWorkspace {
  let workspace = workspaces.get(roster)
  if (!workspace) {
    workspace = new SubAgentWorkspace()
    workspaces.set(roster, workspace)
  }
  return workspace
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
  if (child.role) return formatExpertKnock(child, child.role)
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

function formatExpertKnock(child: ChildSnapshot, role: string): string {
  const base = { name: child.name, role, description: child.description }
  if (child.status === 'completed') return t('expert.knock_done', { ...base, result: child.result || '(no output)' })
  if (child.status === 'interrupted') return t('expert.knock_interrupted', base)
  return t('expert.knock_fail', { ...base, error: child.error || 'Unknown error' })
}

function formatSpawned(names: string[], snapshots: ChildSnapshot[], roster: SubAgentRoster): string {
  const lines = snapshots.map(c => `- ${c.name}：${c.description}`)
  return [
    t('dispatch.spawned', { count: names.length, list: lines.join('\n') }),
    t('dispatch.capacity', { live: roster.liveCount(), room: roster.room() }),
    t('dispatch.overview_at', { path: workspaceOf(roster).overviewPath }),
  ].join('\n')
}

/**
 * 推给界面、随会话落盘的那份：步骤只留工具名、对象、状态，不带工具输出；
 * 结果只带直接带回的那段（超长时里面有文件位置）。
 */
export function toSubAgentView(c: ChildSnapshot): SubAgentResult {
  return {
    id: c.name,
    name: c.name,
    description: c.description,
    prompt: c.shownPrompt ?? c.prompt,
    status: c.status,
    result: c.result,
    error: c.error,
    steps: c.steps.map(({ id, tool, args, status }) => ({ id, tool, args, status })),
    blockedReason: c.blockedReason,
    waitingForModel: c.waitingForModel,
    ...(c.role ? { role: c.role } : {}),
  }
}

/** 派出那一步上显示的人和群聊：只看这一次派的人；他们组了团就带上群聊 */
export function dispatchStepView(roster: SubAgentRoster, names: ReadonlySet<string>): Pick<AgentStep, 'subAgents' | 'expertTeam'> {
  const mine = roster.list().filter(c => names.has(c.name))
  const teamName = mine.find(c => c.team)?.team
  const team = teamName ? roster.getTeam(teamName) : undefined
  return {
    subAgents: mine.map(toSubAgentView),
    ...(team ? { expertTeam: team.view(workspaceOf(roster).teamTranscriptPath(team)) } : {}),
  }
}

/** 伙计变化攒一下再推：最多每 PROGRESS_INTERVAL_MS 一次，最后一次变化一定会推出去 */
class ProgressThrottle {
  private timer?: ReturnType<typeof setTimeout>
  private lastPushAt = 0
  private dirty = false

  constructor(private readonly push: () => void, private readonly intervalMs = PROGRESS_INTERVAL_MS) {}

  schedule(): void {
    this.dirty = true
    if (this.timer) return
    const wait = this.lastPushAt + this.intervalMs - Date.now()
    if (wait <= 0) {
      this.flush()
      return
    }
    this.timer = setTimeout(() => this.flush(), wait)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    this.lastPushAt = Date.now()
    this.push()
  }
}

export function spawnDeps(
  executor: ToolExecutorConfig,
  progressStepId: string,
  ownedNames?: Set<string>
): RosterSpawnDeps | { error: string } {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { error: 'dispatch_agents 需要主人花名册（内部错误）' }
  const workspace = workspaceOf(roster)
  const progress = new ProgressThrottle(() => {
    const names = ownedNames ?? new Set(roster.list().map(c => c.name))
    executor.updateStep(progressStepId, dispatchStepView(roster, names))
    for (const team of roster.listTeams()) workspace.writeTeamTranscript(team)
  })
  const createChild = executor.createChildAgent
  if (!createChild) return { error: 'dispatch_agents 需要能创建伙计（内部错误）' }
  const agentContext = executor.getAgentContext?.()
  if (!agentContext) return { error: 'dispatch_agents 需要 Agent 运行上下文（内部错误）' }

  return {
    createChild,
    getParentMessages: () => executor.getParentMessages?.() ?? [],
    getParentContext: () => toSubAgentContext(executor.getAgentContext?.() ?? agentContext),
    knock: (message) => {
      progress.flush()
      workspace.writeOverview(roster.list())
      for (const team of roster.listTeams()) workspace.writeTeamTranscript(team)
      executor.knockParent?.(message)
    },
    openingFor: expertOpening,
    teamTexts: createTeamTexts(team => workspace.teamTranscriptPath(team)),
    onProgress: () => progress.schedule(),
    ownedNames,
    isParentAborted: () => executor.isAborted(),
    sanitize: sanitizeParentMessages,
    formatKnock,
    archiveResult: (name, text) => workspace.keepResult(name, text, roster.list().length),
  }
}

type ParsedSpawnTask = SpawnTask & { forkTurns: ForkTurns }

function optionalName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function isBatchArgs(value: unknown): value is { instruction: string } {
  return !!value && typeof value === 'object' && typeof (value as { instruction?: unknown }).instruction === 'string'
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
        shownPrompt: item.input,
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
    toolArgs: {
      tasks: parsedTasks.map(task => ({ name: task.name, description: task.description })),
      ...(isBatchArgs(args.batch) ? { batch: { instruction: args.batch.instruction } } : {}),
    },
    riskLevel: 'safe',
    success: true,
    subAgents: []
  })

  const ownedNames = new Set<string>()
  const deps = spawnDeps(executor, progressStep.id, ownedNames)
  if ('error' in deps) {
    return { success: false, output: '', error: deps.error }
  }

  const names = roster.spawn(parsedTasks, deps)
  workspaceOf(roster).writeOverview(roster.list())

  const snapshots = roster.list().filter(c => names.includes(c.name))
  executor.updateStep(progressStep.id, {
    content: t('dispatch.running', { count: names.length }),
    subAgents: snapshots.map(toSubAgentView),
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

  const deps = spawnDeps(executor, progressStep.id, new Set([name]))
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

  const news = await roster.waitForNews(names, signal)
  if (executor.isAborted()) {
    return { success: false, output: '', error: t('error.operation_aborted') }
  }
  if (news.targets.length === 0) {
    return { success: true, output: t('dispatch.wait_empty') }
  }

  const stillWorking = news.targets.some(c => c.status === 'pending' || c.status === 'running')
  const headline = news.arrived.length > 0
    ? t('dispatch.wait_arrived', { list: news.arrived.map(c => `${c.name}（${statusLabel(c.status)}）`).join('、') })
    : stillWorking
      ? t('dispatch.wait_news_timeout', { seconds: timeoutSec })
      : t('dispatch.wait_all_done')
  return {
    success: true,
    output: [
      headline,
      t('dispatch.wait_counts', { total: news.targets.length, counts: formatCounts(news.targets) }),
      t('dispatch.overview_at', { path: workspaceOf(roster).overviewPath }),
    ].join('\n'),
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
    workspaceOf(roster).writeOverview(roster.list())
    if (snap) executor.knockParent?.(formatKnock(snap))
  }
  return { success: true, output: t('dispatch.interrupt_ok', { name }) }
}

/** 工具不给这位用时硬拦：仅主人可用的不给伙计，只给专家团成员的不给团外 */
export function denyIfNotForThisAgent(executor: ToolExecutorConfig, toolName: string): ToolResult | null {
  const catalog = executor.getToolCatalog?.()
  if (!catalog) return null
  const meta = getMetaByName(catalog, toolName)
  if (meta?.onlyForTeamMember && !executor.teamSeat) {
    return { success: false, output: '', error: t('expert.say_denied') }
  }
  if (executor.isSubAgent && meta?.allowedForSubAgent === false) {
    return { success: false, output: '', error: t('dispatch.tool_denied') }
  }
  return null
}
