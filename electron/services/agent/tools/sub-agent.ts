/**
 * 伙计调度：派出 / 再交代 / 等待 / 打断。
 * 伙计用真正的 Agent 循环，花名册活在这场 run 里。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolDefinition } from '../../ai.service'
import type { AgentStep, RemoteAccessRequest, SubAgentResult } from '@shared/types'
import type { AgentContext } from '../types'
import { getDefaultShell, getLocalOS } from '../../../utils/platform'
import { getMetaByName } from '../tool-metadata'
import { MAX_LIVE_CHILDREN, type ChildSnapshot, type DormantChild, type RosterSpawnDeps, type SpawnTask, type SubAgentRoster } from '../sub-agent-roster'
import { parseForkTurns, sanitizeParentMessages, type ForkTurns } from '../sanitize-parent-messages'
import type { ToolExecutorConfig, ToolResult, AgentConfig } from './types'
import { getAgentTools, filterSubAgentTools, dispatchTitle } from '../tools'
import { truncateFromEnd, truncateFromEndWithNotice } from './utils'
import { getScratchPath } from './file'
import { createLogger } from '../../../utils/logger'
import { t } from '../i18n'
import {
  labelLength, MAX_ROLE_CHARS, MAX_TEAM_NAME_CHARS, MAX_TEAM_SIZE, MIN_TEAM_SIZE, TEAM_LEADER,
  teamNameFrom, tidyLabel, WAKES_PER_CHECKPOINT, type ExpertTeam
} from '../expert-team'
import type { ExpertTeamChatStore } from '../../history/expert-team-chat-store'
import { createTeamTexts, expertOpening, formatTranscript, renamedList } from './expert-team-text'
import { inferConversationKind } from '@shared/types'
import { conversationPolicy } from '../../conversation/policy'
import { getConfigService } from '../../config.service'
import { RemoteExecPool, resolveRemoteHost } from '../../remote-exec'
import { RemoteExpert, type ExpertPartial } from '../remote-access/expert'
import { RemoteDispatchGate, type ExpertLiveUpdate, type SavedSessionRef } from '../remote-access/remote-dispatch-gate'
import type { RemoteGrant } from '../remote-access/remote-grant'
import { RemoteOpRecorder } from '../remote-access/remote-op-recorder'
import { WorkerRemoteAccess } from '../remote-access/worker-remote-access'
import { describeRemoteScope } from '../remote-access/worker-situation'

const log = createLogger('SubAgent')
/** 直接带回对话的结果：各人上限乘这一轮派过的人数，大致不超过这个预算 */
const INLINE_RESULT_BUDGET = 40000
const INLINE_RESULT_MAX = 8000
const INLINE_RESULT_MIN = 1000
/** 伙计进度推给界面最多约每秒 4 次 */
const PROGRESS_INTERVAL_MS = 250
/** 总览是给秘书读的文件，不用像界面那样勤；伙计多时每次重写都要把所有人的步骤过一遍 */
const OVERVIEW_INTERVAL_MS = 1000
/** 等伙计时多久看一次用户有没有说话 */
const USER_SPEECH_POLL_MS = 200

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

/** 总览里的状态一格：还在干的写做到第几步、最近用了什么工具，看得出是在忙还是停住了 */
function statusCell(c: ChildSnapshot): string {
  if (c.status !== 'running' && c.status !== 'pending') return statusLabel(c.status)
  const last = c.steps[c.steps.length - 1]
  const detail = [
    last && t('dispatch.overview_steps', { steps: c.steps.length, tool: last.tool }),
    c.waitingForModel && t('dispatch.overview_queued'),
  ].filter(Boolean).join('；')
  return detail ? t('dispatch.overview_live', { status: statusLabel(c.status), detail }) : statusLabel(c.status)
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
  /** 总览上次写进去的内容，没变就不重写 */
  private lastOverview?: string
  /** 每个群聊文件写到第几条 */
  private readonly transcriptCounts = new Map<string, number>()
  /** 团名对应的群聊文件名 */
  private readonly transcriptFiles = new Map<string, string>()
  /** 随会话保存的群聊全文：团名对应的文件和写到第几条 */
  private readonly chatFiles = new Map<string, { file: string; written: number }>()
  private chats?: { store: ExpertTeamChatStore; sessionId: string }

  constructor(dir = buildArtifactDir()) {
    this.dir = dir
    this.overviewPath = path.join(dir, 'overview.md')
  }

  /** 有会话才存群聊全文；只认第一次挂上的 */
  attachChats(store: ExpertTeamChatStore | undefined, sessionId: string | undefined): void {
    if (this.chats || !store || !sessionId) return
    this.chats = { store, sessionId }
  }

  /** 群里的新消息追加进随会话保存的全文 */
  writeTeamChat(team: ExpertTeam): void {
    if (!this.chats) return
    let chat = this.chatFiles.get(team.name)
    if (!chat) {
      const stem = `${path.basename(this.dir)}-${this.teamTranscriptFile(team).replace(/\.md$/, '')}`
      const file = this.chats.store.create(this.chats.sessionId, stem)
      if (!file) return
      chat = { file, written: 0 }
      this.chatFiles.set(team.name, chat)
    }
    const fresh = team.messagesAfter(chat.written)
    if (fresh.length && this.chats.store.append(chat.file, fresh)) chat.written = fresh[fresh.length - 1].seq
  }

  /** 写进去过才给界面，否则界面用派出那一步里的那一小段 */
  teamChatFile(team: ExpertTeam): string | undefined {
    const chat = this.chatFiles.get(team.name)
    return chat && chat.written > 0 ? chat.file : undefined
  }

  /** 这一轮的落盘目录 */
  get directory(): string {
    return this.dir
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
        return [c.name, statusCell(c), kept ? String(kept.chars) : '-', kept?.file ?? '-', task].join(' | ')
      }),
    ]
    const content = lines.join('\n') + '\n'
    if (content === this.lastOverview) return
    if (this.write('overview.md', content)) this.lastOverview = content
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

/** 这场伙计共用的远程通道：花名册整场被打断时一起关掉 */
const remotePools = new WeakMap<SubAgentRoster, RemoteExecPool>()

function remotePoolOf(roster: SubAgentRoster): RemoteExecPool {
  let pool = remotePools.get(roster)
  if (!pool || pool.isDisposed) {
    const fresh = new RemoteExecPool()
    pool = fresh
    remotePools.set(roster, fresh)
    roster.onAbortAll(() => fresh.dispose())
  }
  return pool
}

const recorders = new WeakMap<SubAgentRoster, RemoteOpRecorder>()

function recorderOf(roster: SubAgentRoster): RemoteOpRecorder {
  let recorder = recorders.get(roster)
  if (!recorder) {
    recorder = new RemoteOpRecorder(workspaceOf(roster).directory)
    recorders.set(roster, recorder)
  }
  return recorder
}

function remoteAccessFor(roster: SubAgentRoster, name: string, grant: RemoteGrant): WorkerRemoteAccess {
  return new WorkerRemoteAccess({
    workerName: name,
    grant,
    pool: remotePoolOf(roster),
    recorder: recorderOf(roster),
    resolveHost: (hostId) => {
      const config = getConfigService()
      const session = config.getSshSessions().find(s => s.id === hostId)
      return session ? resolveRemoteHost(session, config.getSessionGroups()) : undefined
    },
  })
}

/**
 * 专家看这一批时，界面上始终只有一行：先显示「在看」，结论一到就换成结论，说明写长了就改这一行。
 * 静默放行（自由、替我审批）写完后收进过程；其余留在外面，和确认卡一起看得见。
 */
function expertLiveSteps(
  config: AgentConfig | undefined,
  executor: ToolExecutorConfig,
  toolCallId: string | undefined,
  toolName: string,
) {
  let stepId: string | undefined
  let wrote = false
  const executionMode = config?.executionMode ?? 'strict'
  const silentAllow = executionMode === 'free' || executor.isAutoReview?.() === true

  const actionOf = (request: RemoteAccessRequest) => t('remote.expert_action', { count: request.hosts.length })
  const quote = (text: string) => text.trim().replace(/\n+/g, ' ')

  const show = (
    request: RemoteAccessRequest,
    content: string,
    streaming: boolean,
    autoReview: NonNullable<AgentStep['autoReview']>,
  ) => {
    if (!stepId) {
      stepId = executor.addStep({
        type: 'auto_review',
        content,
        toolName,
        toolCallId,
        isStreaming: streaming,
        autoReview,
      }).id
      return
    }
    executor.updateStep(stepId, { content, isStreaming: streaming, autoReview })
  }

  const titleFor = (partial: ExpertPartial, action: string) => {
    if (partial.outcome === 'allow' && silentAllow) return t('autoReview.approved', { action })
    if (partial.outcome === 'refuse') return t('remote.expert_live_refuse', { action })
    if (partial.outcome === 'allow') return t('remote.expert_live_allow', { action })
    return t('autoReview.handed_over', { action })
  }

  const paintPartial = (partial: ExpertPartial, request: RemoteAccessRequest, done: boolean) => {
    wrote = true
    const action = actionOf(request)
    const silent = done && partial.outcome === 'allow' && silentAllow
    const line = quote(partial.text)
    const content = line ? `${titleFor(partial, action)}\n\n> ${line}` : titleFor(partial, action)
    show(request, content, !done, silent
      ? { outcome: 'approved', rationale: line || undefined }
      : { outcome: 'handed_over', reason: 'not_approved', ...(line ? { rationale: line } : {}) })
  }

  return {
    onExpertLive: (update: ExpertLiveUpdate, request: RemoteAccessRequest) => {
      const action = actionOf(request)
      if (update.kind === 'looking') {
        show(request, t('remote.expert_reviewing', { action }), true, { outcome: 'handed_over' })
        return
      }
      if (update.kind === 'writing') {
        paintPartial(update.partial, request, false)
        return
      }
      if (update.kind === 'settled') {
        paintPartial(update.partial, request, true)
        return
      }
      if (update.kind === 'failed') {
        show(request, [t('autoReview.handed_over', { action }), t('autoReview.reason.failed')].join('\n\n'), false, {
          outcome: 'handed_over',
          reason: 'failed',
        })
        return
      }
      if (update.kind !== 'stop' || !stepId) return
      if (update.why === 'cancelled') {
        show(request, t('autoReview.cancelled', { action }), false, { outcome: 'handed_over', reason: 'failed' })
        return
      }
      if (!wrote) {
        // 自由模式下没评成，改按只读来看。这行收进过程，不挡在对话中间。
        show(request, t('remote.expert_no_verdict', { action }), false, { outcome: 'approved' })
        return
      }
      executor.updateStep(stepId, { isStreaming: false })
    },
    onExpertAllowed: (note: string, request: RemoteAccessRequest) => {
      if (stepId) return
      paintPartial({ outcome: 'allow', text: note }, request, true)
    },
    onExpertHandedOver: (note: string | undefined, request: RemoteAccessRequest) => {
      if (note) {
        if (stepId) return
        paintPartial({ outcome: 'ask_user', text: note }, request, true)
        return
      }
      const action = actionOf(request)
      show(request, [t('autoReview.handed_over', { action }), t('autoReview.reason.failed')].join('\n\n'), false, {
        outcome: 'handed_over',
        reason: 'failed',
      })
    },
  }
}

function remoteGateFor(config: AgentConfig | undefined, executor: ToolExecutorConfig, toolCallId: string | undefined, toolName: string): RemoteDispatchGate {
  const saved = getConfigService()
  const kind = inferConversationKind(executor.agentId)
  const expertEnv = executor.getRemoteExpertEnv?.()
  return new RemoteDispatchGate({
    sessions: saved.getSshSessions() as readonly SavedSessionRef[],
    groups: saved.getSessionGroups(),
    executionMode: config?.executionMode ?? 'strict',
    conversationAllows: conversationPolicy(kind).workersMayUseRemoteHosts,
    attended: !executor.getAgentContext?.()?.unattended,
    // 有专家时，这一批由专家判；「替我审批」的评审员不再对同一件事重复判
    confirm: (request, toolArgs, displayName, reasons) =>
      executor.waitForConfirmation(
        toolCallId ?? toolName, toolName, toolArgs, 'moderate', displayName, reasons, undefined,
        { remoteAccess: request, ...(expertEnv ? { humanOnly: true } : {}) },
      ),
    ...(expertEnv ? {
      expert: new RemoteExpert(expertEnv),
      autoReview: executor.isAutoReview?.() === true,
      ...expertLiveSteps(config, executor, toolCallId, toolName),
    } : {}),
  })
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

function formatSpawned(names: string[], snapshots: ChildSnapshot[], roster: SubAgentRoster, team?: string): string {
  const list = snapshots
    .map(c => c.role
      ? t('expert.list_item', { name: c.name, role: c.role, description: c.description })
      : `- ${c.name}：${c.description}`)
    .join('\n')
  const count = names.length
  const head = team
    ? t('expert.spawned_team', { team, count, list, limit: WAKES_PER_CHECKPOINT })
    : snapshots.every(c => !!c.role)
      ? t('expert.spawned', { count, list })
      : t('dispatch.spawned', { count, list })
  const renamed = renamedList(snapshots)
  return [
    head,
    ...(renamed ? [t('dispatch.renamed', { list: renamed })] : []),
    t('dispatch.capacity', { live: roster.liveCount(), room: roster.room() }),
    t('dispatch.overview_at', { path: workspaceOf(roster).overviewPath }),
  ].join('\n')
}

/**
 * 派出那一步存盘是一行，单行超过上限读回时整步会被换成占位（卡片和群聊都没了），
 * 还会每 250ms 推一次界面。所以每位只留最近的几步，一批人合计也有上限；
 * 完整过程另存在他自己的记录里。
 */
export const VIEW_STEPS_PER_AGENT = 20
export const VIEW_STEPS_TOTAL = 300
export const VIEW_STEPS_MIN = 3

export function viewStepsPerAgent(agentCount: number): number {
  if (agentCount <= 0) return VIEW_STEPS_PER_AGENT
  return Math.max(VIEW_STEPS_MIN, Math.min(VIEW_STEPS_PER_AGENT, Math.floor(VIEW_STEPS_TOTAL / agentCount)))
}

/**
 * 推给界面、随会话落盘的那份：步骤只留工具名、对象、状态，不带工具输出，
 * 且只留最近一小段；结果只带直接带回的那段（超长时里面有文件位置）。
 */
export function toSubAgentView(c: ChildSnapshot, stepLimit: number = VIEW_STEPS_PER_AGENT): SubAgentResult {
  return {
    id: c.name,
    name: c.name,
    description: c.description,
    prompt: c.shownPrompt ?? c.prompt,
    status: c.status,
    result: c.result,
    error: c.error,
    steps: c.steps.slice(-stepLimit).map(({ id, tool, args, status }) => ({ id, tool, args, status })),
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
  const workspace = workspaceOf(roster)
  return {
    subAgents: mine.map(c => toSubAgentView(c, viewStepsPerAgent(mine.length))),
    ...(team ? {
      expertTeam: team.view({ transcriptPath: workspace.teamTranscriptPath(team), chatFile: workspace.teamChatFile(team) }),
    } : {}),
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

const NOTICE_LISTED_CALLS = 5
const NOTICE_TARGET_CHARS = 80

/**
 * 叫醒一位以前停下的伙计时，开口前告诉他上次是怎么停的。只讲事实：停在哪、什么没有记下来。
 * 做完的没有可说的。
 */
export function resumeNoticeFor(child: DormantChild): string {
  if (child.status === 'completed' && !child.abnormalExit) return ''
  const head = child.abnormalExit
    ? t('dispatch.resume_abnormal')
    : child.status === 'failed'
      ? t('dispatch.resume_failed', { error: child.error || '-' })
      : t('dispatch.resume_interrupted')
  const calls = child.interruptedCalls ?? []
  if (calls.length === 0) return head
  const shown = calls.slice(0, NOTICE_LISTED_CALLS).map(call => {
    const target = call.target && call.target.length > NOTICE_TARGET_CHARS
      ? `${call.target.slice(0, NOTICE_TARGET_CHARS)}…`
      : call.target
    return target ? `${call.tool} ${target}` : call.tool
  })
  const list = calls.length > shown.length ? `${shown.join('、')}…` : shown.join('、')
  return `${head}\n${t('dispatch.resume_unanswered', { count: calls.length, list })}`
}

export function spawnDeps(
  executor: ToolExecutorConfig,
  progressStepId: string,
  ownedNames?: Set<string>
): RosterSpawnDeps | { error: string } {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { error: 'dispatch_agents 需要主人花名册（内部错误）' }
  const workspace = workspaceOf(roster)
  workspace.attachChats(executor.getExpertTeamChats?.(), executor.getSessionId?.())
  const overviewProgress = new ProgressThrottle(() => workspace.writeOverview(roster.list()), OVERVIEW_INTERVAL_MS)
  const progress = new ProgressThrottle(() => {
    const names = ownedNames ?? new Set(roster.list().map(c => c.name))
    for (const team of roster.listTeams()) workspace.writeTeamChat(team)
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
      for (const team of roster.listTeams()) {
        workspace.writeTeamChat(team)
        workspace.writeTeamTranscript(team)
      }
      executor.knockParent?.(message)
    },
    openingFor: expertOpening,
    restoreDormant: executor.restoreDormantChildren,
    resumeNotice: resumeNoticeFor,
    teamTexts: createTeamTexts(team => workspace.teamTranscriptPath(team)),
    onProgress: () => {
      progress.schedule()
      overviewProgress.schedule()
    },
    ownedNames,
    isParentAborted: () => executor.isAborted(),
    sanitize: sanitizeParentMessages,
    formatKnock,
    archiveResult: (name, text) => workspace.keepResult(name, text, roster.list().length),
    remoteAccessFor: (name, grant) => remoteAccessFor(roster, name, grant),
  }
}

type ParsedSpawnTask = SpawnTask & { forkTurns: ForkTurns; hosts?: string[] }

function optionalName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** 一句话简述：折成一行（它要摆进总览的一行和每位专家开场里的团员名单） */
function oneLine(value: unknown): string | undefined {
  return typeof value === 'string' ? tidyLabel(value) || undefined : undefined
}

/** hosts：已存会话 id 的数组，去掉重复；不写返回 undefined */
function parseHosts(value: unknown, where: string): { hosts?: string[] } | { error: string } {
  if (value === undefined) return {}
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.trim() === '')) {
    return { error: `${where}：hosts 必须是字符串数组，每项是 list_ssh_sessions 返回的 sessionId` }
  }
  const hosts = [...new Set((value as string[]).map(v => v.trim()))]
  return hosts.length > 0 ? { hosts } : {}
}

/** remote_commands：每条一项，去掉首尾空白；不写返回空数组 */
export function parseRemoteCommands(args: Record<string, unknown>): { commands: string[] } | { error: string } {
  const raw = args.remote_commands
  if (raw === undefined) return { commands: [] }
  if (!Array.isArray(raw) || raw.some(v => typeof v !== 'string' || v.trim() === '')) {
    return { error: 'remote_commands 必须是字符串数组，每条是一条命令' }
  }
  return { commands: [...new Set((raw as string[]).map(v => v.trim()))] }
}

function isBatchArgs(value: unknown): value is { instruction: string } {
  return !!value && typeof value === 'object' && typeof (value as { instruction?: unknown }).instruction === 'string'
}

/**
 * tasks 每人一份指令；batch 一份共同指令加一批条目，交给伙计的是共同指令、换行、本条目。两种可同次混用。
 * tasks 里带 role 的是专家；带 team 时这次 tasks 里的人组成专家团（每位都带 role，不用 batch）。
 */
export function parseDispatchTasks(args: Record<string, unknown>): { tasks: ParsedSpawnTask[]; team?: string } | { error: string } {
  const tasks: ParsedSpawnTask[] = []
  const problems: string[] = []
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
      const name = optionalName(task.name)
      const role = typeof task.role === 'string' ? tidyLabel(task.role) || undefined : undefined
      if (role && (name?.trim() === TEAM_LEADER || role === TEAM_LEADER)) {
        return { error: `「${TEAM_LEADER}」留给派出专家团的你，专家的名字和角色都不能用它（子任务 ${i + 1}）` }
      }
      if (role && labelLength(role) > MAX_ROLE_CHARS) {
        problems.push(`子任务 ${i + 1} 的 role 最长 ${MAX_ROLE_CHARS} 个字，这次 ${labelLength(role)} 个字。`)
      }
      const description = oneLine(task.description)
      const hosts = parseHosts(task.hosts, `子任务 ${i + 1}`)
      if ('error' in hosts) return { error: hosts.error }
      tasks.push({
        name,
        description: description ?? (role ? name ?? role : 'task'),
        prompt: task.prompt,
        forkTurns,
        ...(role ? { role } : {}),
        ...hosts,
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
      const hosts = parseHosts(item.hosts, `batch 第 ${i + 1} 条`)
      if ('error' in hosts) return { error: hosts.error }
      tasks.push({
        name,
        description: oneLine(item.description) ?? (name ?? `${i + 1}`),
        prompt: `${batch.instruction}\n${item.input}`,
        shownPrompt: item.input,
        forkTurns,
        ...hosts,
      })
    }
  }
  if (tasks.length === 0) {
    return { error: 'tasks 和 batch 至少给一个，且不能为空' }
  }
  const team = teamNameFrom(args.team)
  if (!team) return problems.length ? { error: `没派：${problems.join('')}` } : { tasks }
  if (labelLength(team) > MAX_TEAM_NAME_CHARS) {
    problems.push(`团名最长 ${MAX_TEAM_NAME_CHARS} 个字，这次 ${labelLength(team)} 个字。`)
  }
  if (rawBatch !== undefined) problems.push('带 team 时只用 tasks 写每位专家，不能用 batch。')
  const noRole = tasks.findIndex(task => !task.role)
  if (noRole >= 0) problems.push(`带 team 时每位都要有 role（专家角色），第 ${noRole + 1} 位没有。`)
  if (tasks.length < MIN_TEAM_SIZE || tasks.length > MAX_TEAM_SIZE) {
    problems.push(`一个专家团 ${MIN_TEAM_SIZE} 到 ${MAX_TEAM_SIZE} 位专家，这次 ${tasks.length} 位。`
      + (tasks.length < MIN_TEAM_SIZE
        ? '一位专家没有可交接的人，不带 team 就是单独派。'
        : '可以拆成几个团，或不带 team 各干各的。'))
  }
  if (problems.length) return { error: `没派：${problems.join('')}` }
  return { tasks, team }
}

/**
 * 派出前的远程授权：带了 hosts 的伙计要过只读判定、按这场对话的审批方式确认。
 * 通过后，每位伙计的任务后面接上他的处境说明，范围跟着他走。
 */
async function authorizeRemoteScopes(
  args: Record<string, unknown>,
  tasks: ParsedSpawnTask[],
  config: AgentConfig,
  executor: ToolExecutorConfig,
  toolCallId: string | undefined,
): Promise<{ tasks: SpawnTask[] } | { error: string }> {
  const parsedCommands = parseRemoteCommands(args)
  if ('error' in parsedCommands) return { error: parsedCommands.error }
  const commands = parsedCommands.commands
  if (commands.length === 0 && !tasks.some(task => task.hosts)) {
    return { tasks }
  }

  const gate = remoteGateFor(config, executor, toolCallId, 'dispatch_agents')
  const outcome = await gate.authorizeDispatch(tasks, commands)
  if (!outcome.ok) return { error: outcome.error }

  return {
    tasks: tasks.map((task, i): SpawnTask => {
      const grant = outcome.value[i]
      const { hosts: _hosts, ...rest } = task
      if (!grant) return rest
      return {
        ...rest,
        shownPrompt: task.shownPrompt ?? task.prompt,
        prompt: `${task.prompt}\n\n${describeRemoteScope(grant)}`,
        remoteGrant: grant,
      }
    }),
  }
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
  const { tasks: parsedTasks, team } = parsed
  const allExperts = parsedTasks.every(task => !!task.role)
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

  const remote = await authorizeRemoteScopes(args, parsedTasks, _config, executor, _toolCallId)
  if ('error' in remote) return { success: false, output: '', error: remote.error }

  const progressStep = executor.addStep({
    type: 'tool_call',
    content: dispatchTitle(parsedTasks.length, allExperts, team),
    toolName: 'dispatch_agents',
    toolArgs: {
      tasks: parsedTasks.map(task => ({ name: task.name, description: task.description, ...(task.role ? { role: task.role } : {}) })),
      ...(team ? { team } : {}),
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

  const names = roster.spawn(remote.tasks, deps, team ? { team } : undefined)
  const workspace = workspaceOf(roster)
  workspace.writeOverview(roster.list())
  const created = team ? roster.teamOf(names[0]) : undefined
  if (created) {
    workspace.writeTeamChat(created)
    workspace.writeTeamTranscript(created)
  }

  const snapshots = roster.list().filter(c => names.includes(c.name))
  executor.updateStep(progressStep.id, {
    content: dispatchTitle(names.length, allExperts, created?.name),
    ...dispatchStepView(roster, new Set(names)),
  })

  log.info(`Dispatched ${names.length} sub-agents${created ? ` as team ${created.name}` : ''}: ${names.join(', ')}`)
  const blankTeam = typeof args.team === 'string' && !teamNameFrom(args.team)
  return {
    success: true,
    output: formatSpawned(names, snapshots, roster, created?.name) + (blankTeam ? `\n\n${t('expert.blank_team')}` : '')
  }
}

export async function followupAgent(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  config?: AgentConfig,
  toolCallId?: string,
): Promise<ToolResult> {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { success: false, output: '', error: '没有花名册' }
  const name = typeof args.name === 'string' ? args.name.trim() : ''
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!name || !message) return { success: false, output: '', error: '需要 name 和 message' }

  const parsedCommands = parseRemoteCommands(args)
  if ('error' in parsedCommands) return { success: false, output: '', error: parsedCommands.error }
  const remoteCommands = parsedCommands.commands
  const grant = roster.remoteGrantOf(name)
  if (remoteCommands.length > 0) {
    if (!roster.get(name)) return { success: false, output: '', error: `没有叫 ${name} 的伙计` }
    const gate = remoteGateFor(config, executor, toolCallId, 'followup_agent')
    const outcome = await gate.authorizeFollowup(name, grant, remoteCommands)
    if (!outcome.ok) return { success: false, output: '', error: outcome.error }
  }

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

  // 他还在跑时一收到话就可能用上新命令，所以先记进单子，再交话
  if (grant && remoteCommands.length > 0) grant.addCommands(remoteCommands)
  const followupMessage = grant && remoteCommands.length > 0
    ? `${message}\n\n${describeRemoteScope(grant)}`
    : message
  const result = roster.followup(name, followupMessage, deps)
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

  // 等的时候用户说话：这次等待先停下，让主人先回应；伙计照旧在后台干
  const userSpoke = new AbortController()
  const spoke = () => executor.hasPendingUserSpeech?.() ?? false
  const parentSignal = executor.getAbortSignal?.()
  const timeout = AbortSignal.timeout(timeoutSec * 1000)
  const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), timeout, userSpoke.signal])
  if (spoke()) userSpoke.abort()
  const poll = executor.hasPendingUserSpeech
    ? setInterval(() => { if (spoke()) userSpoke.abort() }, USER_SPEECH_POLL_MS)
    : undefined

  let news: Awaited<ReturnType<SubAgentRoster['waitForNews']>>
  try {
    news = await roster.waitForNews(names, signal)
  } finally {
    if (poll) clearInterval(poll)
  }
  if (executor.isAborted()) {
    return { success: false, output: '', error: t('error.operation_aborted') }
  }
  if (news.targets.length === 0) {
    return { success: true, output: t('dispatch.wait_empty') }
  }

  const stillWorking = news.targets.some(c => c.status === 'pending' || c.status === 'running')
  const headline = news.arrived.length > 0
    ? t('dispatch.wait_arrived', { list: news.arrived.map(c => `${c.name}（${statusLabel(c.status)}）`).join('、') })
    : userSpoke.signal.aborted
      ? t('dispatch.wait_user_spoke')
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
  const result = roster.interrupt(name, { restoreDormant: executor.restoreDormantChildren })
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
