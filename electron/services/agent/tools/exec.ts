/**
 * 轻量命令执行器（基于 child_process.spawn）
 *
 * 用于无终端的助手，以及远程会话里在本机跑命令；直接执行 shell 命令并返回结果。
 * 与 PTY 版（command.ts）不同：
 * - 不需要终端会话，不追踪终端状态
 * - 不支持 sudo、续行检测等终端特有交互
 *
 * 同步 vs 后台：
 * - wait_seconds 内结束 → 返回完整结果（同传统 exec 行为）
 * - 仍在跑且 wait_seconds < max_seconds → 转后台，返回 task_id，Agent 可以先做别的
 * - 等待途中用户插话 → 立刻结束这次等待，命令继续跑
 * - 转后台或让路之后，有终点的命令这一轮盯到底，结束时结果送回这场对话；常驻命令（service）不盯
 * - 用户按停 → 正在等 / 正在盯的那条一起停掉（先喊停，再强制），并给下一轮留交代
 *
 * 进程托管见 exec-manager.ts。
 */
import * as os from 'os'
import { t } from '../i18n'
import { assessCommandRiskDetailed, analyzeCommand } from '../risk-assessor'
import { auditContextFromConfig } from '../audit-context-from-config'
import { commandNeedsConfirm, isSubAgentBlocked, formatHardBlockedMessage } from '../command-audit/confirm-policy'
import { resolveCommandToolConfirmation } from '../allowlist/resolve-command-confirm'
import { truncateFromEnd, EXEC_MAX_COMMAND_LENGTH, formatTotalTime } from './utils'
import { rejectOversizedCommand } from './command-persist'
import { externalizeToolOutput, externalizeFailedError } from '../tool-output-externalize'
import { getExecManager, MAX_PATTERN_LENGTH, type BackgroundExecTask, type BackgroundExecTaskSnapshot, type WaitReason } from './exec-manager'
import { getSkillEnvMap, mapSkillEnvToDeclaredCase } from '../../../services/credential.service'
import { getUserSkillService } from '../../../services/user-skill.service'
import { expandTilde, announcedLocalCwd } from './file'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'
import { MAX_WAIT_SECONDS, type BackgroundWatch } from '../background-watch'
import { getStreamPlaceholder } from '../tool-metadata'

const LABEL_MAX = 30

/** 只取第一行开头一小截，认得出就够 */
function clipLine(text: string): string {
  const lines = text.trim().split('\n')
  const first = Array.from(lines[0].trim())
  if (first.length <= LABEL_MAX && lines.length === 1) return first.join('')
  return `${first.slice(0, LABEL_MAX).join('')}…`
}

type LabeledCommand = { command: string; description?: string }

/** 卡片上指明是哪条命令：优先它附的人话说明，没附就用命令开头 */
function commandLabel(task: LabeledCommand): string {
  return (task.description && clipLine(task.description))
    || clipLine(task.command)
    || t('exec.this_command')
}

function normalizeDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const text = raw.replace(/\s+/g, ' ').trim()
  return text ? clipLine(text) : undefined
}

/** 执行命令那张卡：流式预卡和执行器落卡共用，完整命令一字不差 */
export function describeExecCall(args: Record<string, unknown>): string {
  const description = normalizeDescription(args.description)
  const title = description ? t('exec.executing_described', { description }) : t('status.executing')
  const command = typeof args.command === 'string' ? args.command : getStreamPlaceholder()
  return `${title}: ${command}`
}

/**
 * 等后台命令时给用户看的一行：哪条命令 + 已运行多久。
 * @internal 导出仅为单元测试
 */
export function formatAwaitingTitle(task: LabeledCommand, elapsed: string): string {
  return t('exec.awaiting', { command: commandLabel(task), elapsed })
}

/**
 * await_exec 参数还在流式到达时的预卡片：按编号去后台命令表里认出是哪条命令。
 * 认不出（编号还没传完、命令早已清理）就不指名，编号本身不给人看。
 */
export function describeAwaitExecCall(args: Record<string, unknown>): string {
  const taskId = typeof args.task_id === 'string' ? args.task_id : ''
  const task = taskId ? getExecManager().get(taskId) : undefined
  const label = task ? commandLabel(task) : ''
  if (isTrue(args.stop)) return t('exec.stopping', { command: label || t('exec.this_command') })
  if (isTrue(args.service)) return t('exec.marking_service', { command: label || t('exec.this_command') })
  return label ? `${t('exec.awaiting_short')} ${label}` : t('exec.awaiting_short')
}

function elapsedSince(startedAt: number): string {
  return formatTotalTime(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
}

function awaitingContent(task: BackgroundExecTask): string {
  return `⏳ ${formatAwaitingTitle(task, elapsedSince(task.startedAt))}`
}

function userSpoke(executor: ToolExecutorConfig): boolean {
  return executor.hasPendingUserSpeech?.() ?? false
}

async function deliverUnattendedReport(
  task: BackgroundExecTask,
  snap: BackgroundExecTaskSnapshot,
  executor: ToolExecutorConfig,
): Promise<void> {
  const manager = getExecManager()
  if (manager.isFinishReportConsumed(task)) return
  let output: string
  try {
    output = await formatTaskOutput(snap.output, executor)
  } catch (err) {
    output = err instanceof Error ? err.message : String(err)
  }
  if (manager.isFinishReportConsumed(task)) return
  manager.consumeFinishReport(task)
  if (!executor.deliverBackgroundNotice) return
  const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
  const command = snap.command.length > 180 ? `${snap.command.slice(0, 180)}…` : snap.command
  executor.deliverBackgroundNotice(`${t('exec.finished_unattended', {
    taskId: snap.taskId,
    status: snap.status,
    exitCode: String(exitCode),
    command,
  })}\n${output}`)
}

/** 按停交代里带的最近输出上限 */
const STOPPED_NOTE_OUTPUT_MAX = 1500
/** 检查点每隔几分钟一条、都留在对话里，只带够判断走向的一小段 */
const CHECKPOINT_OUTPUT_MAX = 600

/**
 * 这场对话正在等、或答应盯到底的一条命令。
 * - waiting：工具正在等它，按停就停掉它
 * - owed：等待结束时还在跑（用户插话、到点转后台、等到了某句输出），结束时结果要送回这场；这一轮收尾时专门等它
 * - released：不再盯（等到了结束，或是常驻命令）
 */
class CommandWatch implements BackgroundWatch {
  readonly key: string
  private phase: 'waiting' | 'owed' | 'released' = 'waiting'
  private holdStep?: { id: string; ticker: NodeJS.Timeout }
  private stopped = false

  constructor(
    private readonly task: BackgroundExecTask,
    private executor: ToolExecutorConfig,
  ) {
    this.key = task.taskId
  }

  get active(): boolean {
    return this.phase !== 'released'
  }

  get stoppedByUser(): boolean {
    return this.stopped
  }

  /** 开始一次等待。已经欠着的，换成当前这一轮来送结果 */
  beginWait(executor: ToolExecutorConfig): void {
    this.executor = executor
  }

  isPending(): boolean {
    if (this.phase === 'waiting') return this.task.status === 'running'
    if (this.phase === 'owed') return getExecManager().isFinishReportPending(this.task)
    return false
  }

  /** 一次等待结束了：还在跑、又不是常驻的 → 盯到底；否则工具自己等的这次就了结 */
  settle(reason: WaitReason | undefined): void {
    if (this.phase !== 'waiting') return
    const stillOwed = reason !== undefined && reason !== 'done' && reason !== 'aborted'
      && this.task.status === 'running' && !this.task.service
    if (stillOwed) {
      this.phase = 'owed'
      getExecManager().armFinishReport(this.task, (snap) => {
        void deliverUnattendedReport(this.task, snap, this.executor)
      })
      return
    }
    this.phase = 'released'
  }

  release(): void {
    this.phase = 'released'
    this.closeHoldStep()
  }

  holdStarted(): void {
    if (this.holdStep || this.phase !== 'owed' || this.task.status !== 'running') return
    const step = this.executor.addStep({
      type: 'tool_call',
      content: awaitingContent(this.task),
      toolName: 'await_exec',
      toolArgs: { task_id: this.key },
    })
    const ticker = setInterval(() => {
      this.executor.updateStep(step.id, { content: awaitingContent(this.task) })
    }, 1000)
    this.holdStep = { id: step.id, ticker }
  }

  holdEnded(checkpoint: boolean): void {
    if (!this.closeHoldStep()) return
    const snap = getExecManager().snapshot(this.task)
    if (snap.status === 'running') {
      const short = checkpoint ? t('exec.checkpoint_short') : t('exec.yielded_short')
      this.executor.addStep({ type: 'tool_result', content: `⏳ ${short}`, toolName: 'await_exec', toolResult: short })
      return
    }
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    const done = `${t('status.command_complete')} (${snap.status}, exit: ${exitCode})`
    this.executor.addStep({ type: 'tool_result', content: done, toolName: 'await_exec', toolResult: done })
  }

  checkpoint(): string | undefined {
    if (this.phase !== 'owed' || this.task.status !== 'running') return undefined
    const snap = getExecManager().snapshot(this.task)
    return t('exec.checkpoint', {
      taskId: this.key,
      pid: String(snap.pid ?? 'unknown'),
      elapsed: elapsedSince(snap.startedAt),
      command: shortCommand(snap.command),
      output: truncateFromEnd(snap.output.trim(), CHECKPOINT_OUTPUT_MAX) || t('exec.checkpoint_no_output'),
    })
  }

  stop(): (() => string) | undefined {
    if (this.phase === 'released') return undefined
    this.phase = 'released'
    const hadHold = this.closeHoldStep()
    const manager = getExecManager()
    if (!manager.stop(this.task)) return undefined
    this.stopped = true
    if (hadHold) {
      const short = t('exec.stopped_short')
      this.executor.addStep({ type: 'tool_result', content: `⏹️ ${short}`, toolName: 'await_exec', toolResult: short })
    }
    const task = this.task
    return () => {
      const snap = manager.snapshot(task)
      return t('exec.stopped_note', {
        taskId: snap.taskId,
        command: shortCommand(snap.command),
        output: truncateFromEnd(snap.output.trim(), STOPPED_NOTE_OUTPUT_MAX),
      })
    }
  }

  private closeHoldStep(): boolean {
    if (!this.holdStep) return false
    clearInterval(this.holdStep.ticker)
    this.holdStep = undefined
    return true
  }
}

function shortCommand(command: string): string {
  return command.length > 180 ? `${command.slice(0, 180)}…` : command
}

/** 登记这次要等的命令；已经欠着结果的沿用原来那一份 */
function watchCommand(task: BackgroundExecTask, executor: ToolExecutorConfig): CommandWatch {
  const existing = executor.findBackgroundWatch?.(task.taskId)
  const watch = existing instanceof CommandWatch && existing.active
    ? existing
    : new CommandWatch(task, executor)
  if (watch !== existing) executor.trackBackgroundWatch?.(watch)
  watch.beginWait(executor)
  return watch
}

/** 仍在跑时，告诉模型之后怎么处置：常驻的不盯，其余这一轮会盯到底 */
function followUpHint(task: BackgroundExecTask): string {
  return task.service
    ? t('exec.follow_service', { taskId: task.taskId })
    : t('exec.follow_watched', { taskId: task.taskId })
}

function runningSeconds(task: BackgroundExecTask): number {
  return Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000))
}

async function waitWatched(watch: CommandWatch, wait: () => Promise<WaitReason>): Promise<WaitReason> {
  let reason: WaitReason | undefined
  try {
    reason = await wait()
    return reason
  } finally {
    watch.settle(reason)
  }
}

const DEFAULT_WAIT_SECONDS = 60
const DEFAULT_MAX_SECONDS = 3600    // 后台最长允许运行 1 小时（防僵尸进程）
const MAX_MAX_SECONDS = 24 * 3600   // 最长 24 小时（极端长任务硬上限）

const OUTPUT_TRUNCATE = 16_384      // 返回给 Agent 的输出截断上限（16KB），动态预算收紧时取 min

/**
 * 把后台任务原始输出整理为 Agent 可读形态：先 trim 掉首尾空白（与旧版 exec 行为一致，
 * 避免 LLM 看到无意义的尾部换行），超上限时全文落盘 scratch 换「指针 + 尾部摘录」
 * （命令输出的结论/报错通常在末尾），不做截断——截断的中间部分无法找回。
 *
 * 当 executor 提供了动态预算（上下文紧张时收紧），上限取 min(预算, 16KB)；
 * 无预算时回退到 OUTPUT_TRUNCATE（保持向后兼容）。
 *
 * @throws 落盘失败时抛错（明确报错 + 建议缩小范围，禁止退回截断）
 * @internal 导出仅为单元测试，业务代码请用 executeCommandDirect 等入口
 */
export async function formatTaskOutput(raw: string, executor: ToolExecutorConfig): Promise<string> {
  const budget = executor.getToolOutputBudget?.()
  const maxChars = budget && budget.maxChars > 0
    ? Math.min(budget.maxChars, OUTPUT_TRUNCATE)
    : OUTPUT_TRUNCATE

  const trimmed = raw.trim()
  try {
    const externalized = await externalizeToolOutput({ output: trimmed, maxChars, toolName: 'exec', excerpt: 'tail' })
    if (externalized) return externalized.text
  } catch (err) {
    throw new Error(externalizeFailedError(trimmed.length, err instanceof Error ? err.message : String(err)))
  }
  return trimmed
}

/**
 * 解析数字参数，类型不对/越界时回退到默认值
 */
function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.max(raw, min), max)
}

/** 模型偶尔把布尔写成字符串 */
function isTrue(raw: unknown): boolean {
  return raw === true || raw === 'true'
}

/**
 * 主入口：执行命令，超过 wait_seconds 转后台
 */
export async function executeCommandDirect(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const command = args.command as string
  if (!command) {
    return { success: false, output: '', error: t('hint.command_empty') }
  }

  // 命令长度防误用（实际限制是 ARG_MAX，给 100KB 足够日常 oneliner）
  if (command.length > EXEC_MAX_COMMAND_LENGTH) {
    return rejectOversizedCommand({
      command,
      maxChars: EXEC_MAX_COMMAND_LENGTH,
      toolName: 'exec',
      executor,
    })
  }

  const handling = analyzeCommand(command)
  if (handling.strategy === 'block') {
    executor.addStep({
      type: 'tool_call',
      content: `🚫 ${command}`,
      toolName: 'exec',
      toolArgs: { command },
      riskLevel: 'blocked'
    })
    const errorMsg = `${t('hint.command_cannot_execute')}: ${handling.reason}。${handling.hint}`
    executor.addStep({
      type: 'tool_result',
      content: errorMsg,
      toolName: 'exec',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const assessment = await assessCommandRiskDetailed(command, auditContextFromConfig(config))
  const riskLevel = assessment.level
  if (riskLevel === 'blocked') {
    return { success: false, output: '', error: formatHardBlockedMessage(assessment, command) }
  }

  if (isSubAgentBlocked(assessment, config.commandRiskPolicy) && executor.isSubAgent) {
    return { success: false, output: '', error: t('dispatch.command_blocked', { command }) }
  }

  const needConfirm = commandNeedsConfirm(assessment, config.executionMode, config.commandRiskPolicy)
  const description = normalizeDescription(args.description)

  executor.addStep({
    type: 'tool_call',
    content: describeExecCall(args),
    toolName: 'exec',
    toolArgs: { command },
    riskLevel
  })

  let userApproved = false
  if (needConfirm) {
    const confirm = await resolveCommandToolConfirmation(
      'exec',
      { command },
      assessment,
      config,
      toolCallId,
      riskLevel,
      executor,
    )
    if (!confirm.proceed) {
      executor.addStep({
        type: 'tool_result',
        content: `⛔ ${t('status.user_rejected')}`,
        toolName: 'exec',
        toolResult: t('status.user_rejected'),
        rejected: true,
      })
      return confirm.result
    }
    userApproved = confirm.userApproved
  }

  const rawCwd = typeof args.cwd === 'string' ? args.cwd.trim() : ''
  const cwd = rawCwd ? expandTilde(rawCwd) : (announcedLocalCwd(executor.getAgentContext?.()) ?? os.homedir())
  const skillId = (args.skill_id as string) || undefined
  const waitSeconds = clampNumber(args.wait_seconds, DEFAULT_WAIT_SECONDS, 1, MAX_WAIT_SECONDS)
  const maxSeconds = clampNumber(args.max_seconds, DEFAULT_MAX_SECONDS, 1, MAX_MAX_SECONDS)

  // 转后台时实际等待时间是 min(wait, max)——max 已经是硬上限，wait > max 没意义
  const effectiveWait = Math.min(waitSeconds, maxSeconds)

  // 如果指定了 skill_id，注入该技能的 env（API Key 等）到子进程。
  // credential 层统一大写存储，这里按 SKILL.md 声明的原始大小写映射后再注入，
  // 保证技能脚本能用声明的变量名（可能是 api_key 而非 API_KEY）读到。
  let skillEnv: Record<string, string> | undefined
  if (skillId) {
    const envMap = await getSkillEnvMap(skillId) // key 已是大写
    if (Object.keys(envMap).length > 0) {
      const declaredEnvs = getUserSkillService().getSkill(skillId)?.requires?.env ?? []
      skillEnv = mapSkillEnvToDeclaredCase(envMap, declaredEnvs)
    }
  }

  const manager = getExecManager()
  const task = manager.spawn({ command, cwd, maxSeconds, env: skillEnv, owner: executor.agentId, description })
  if (isTrue(args.service)) manager.markService(task)
  const watch = watchCommand(task, executor)

  const reason = await waitWatched(watch, () => manager.wait({
    task,
    waitSeconds: effectiveWait,
    isAborted: () => executor.isAborted(),
    shouldYield: () => userSpoke(executor),
  }))

  const snap = manager.snapshot(task)

  // ============= abort：用户按停，正在等的这条已随之停掉 =============
  if (reason === 'aborted') {
    const output = await formatTaskOutput(snap.output, executor)
    executor.addStep({
      type: 'tool_result',
      content: `⏹️ ${watch.stoppedByUser ? t('exec.stopped_short') : t('status.user_rejected')}`,
      toolName: 'exec',
      toolResult: output
    })
    return {
      success: false,
      output,
      error: t('error.operation_aborted'),
      isRunning: snap.status === 'running',
    }
  }

  // ============= 任务在 wait_seconds 内结束 =============
  if (reason === 'done') {
    // userApproved 前缀在截断前拼接，让预算计算覆盖完整输出
    const rawOutput = userApproved
      ? `[${t('status.user_approved')}]\n${snap.output}`
      : snap.output
    const output = await formatTaskOutput(rawOutput, executor)
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_complete')} (exit: ${exitCode})`,
      toolName: 'exec',
      toolResult: output
    })

    const finalOutput = output

    if (snap.status === 'completed') {
      return { success: true, output: finalOutput }
    }
    if (snap.status === 'killed') {
      return {
        success: false,
        output: finalOutput,
        error: t('exec.killed_by_signal', { signal: snap.signal ?? 'unknown' })
      }
    }
    return {
      success: false,
      output: finalOutput,
      error: `exit code ${exitCode}: ${truncateFromEnd(snap.output.trim(), 500)}`
    }
  }

  // ============= 任务仍在跑 → 转后台，或用户插话先让路 =============
  const output = await formatTaskOutput(snap.output, executor)
  const pid = String(snap.pid ?? 'unknown')
  const status = reason === 'user_message'
    ? t('exec.yielded', { taskId: snap.taskId, pid, elapsed: runningSeconds(task) })
    : t('exec.backgrounded', { taskId: snap.taskId, pid, waited: effectiveWait, max: maxSeconds })
  const header = `${status}\n${followUpHint(task)}`
  const short = reason === 'user_message' ? t('exec.yielded_short') : t('exec.backgrounded_short')
  executor.addStep({
    type: 'tool_result',
    content: `⏳ ${short}`,
    toolName: 'exec',
    toolResult: `${header}\n${output}`
  })
  return {
    success: true,
    output: `${header}\n${output}`,
    isRunning: true,
  }
}

/**
 * await_exec：等待已转后台的任务结束、命中 pattern、或超时返回最新输出
 */
export async function awaitExec(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const taskId = typeof args.task_id === 'string' ? args.task_id : ''
  if (!taskId) {
    return { success: false, output: '', error: t('exec.task_id_required') }
  }

  const waitSeconds = clampNumber(args.wait_seconds, 30, 1, MAX_WAIT_SECONDS)

  let pattern: RegExp | undefined
  if (typeof args.pattern === 'string' && args.pattern) {
    if (args.pattern.length > MAX_PATTERN_LENGTH) {
      return {
        success: false,
        output: '',
        error: t('exec.invalid_pattern', { error: `pattern too long (>${MAX_PATTERN_LENGTH} chars)` })
      }
    }
    try {
      pattern = new RegExp(args.pattern, 'm')
    } catch (e) {
      return {
        success: false,
        output: '',
        error: t('exec.invalid_pattern', { error: (e as Error).message })
      }
    }
  }

  const manager = getExecManager()
  const task = manager.get(taskId)
  if (!task) {
    return { success: false, output: '', error: t('exec.task_not_found', { taskId }) }
  }

  if (isTrue(args.stop)) return stopOwnCommand(task, executor)

  if (isTrue(args.service)) {
    manager.markService(task)
    executor.findBackgroundWatch?.(taskId)?.release()
    if (!pattern && args.wait_seconds === undefined) return markedServiceResult(task, executor)
  }

  const step = executor.addStep({
    type: 'tool_call',
    content: awaitingContent(task),
    toolName: 'await_exec',
    toolArgs: { task_id: taskId },
  })

  const ticker = setInterval(() => {
    executor.updateStep(step.id, { content: awaitingContent(task) })
  }, 1000)

  const watch = watchCommand(task, executor)
  let reason: WaitReason
  try {
    reason = await waitWatched(watch, () => manager.wait({
      task,
      waitSeconds,
      pattern,
      isAborted: () => executor.isAborted(),
      shouldYield: () => userSpoke(executor),
    }))
  } finally {
    clearInterval(ticker)
  }

  const snap = manager.snapshot(task)
  const output = await formatTaskOutput(snap.output, executor)

  if (reason === 'aborted') {
    executor.addStep({
      type: 'tool_result',
      content: `⏹️ ${watch.stoppedByUser ? t('exec.stopped_short') : t('status.user_rejected')}`,
      toolName: 'await_exec',
      toolResult: output
    })
    return {
      success: false,
      output,
      error: t('error.operation_aborted'),
      isRunning: snap.status === 'running',
    }
  }

  if (reason === 'done') {
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    const header = t('exec.task_done', {
      taskId,
      status: snap.status,
      exitCode: String(exitCode),
    })
    executor.addStep({
      type: 'tool_result',
      content: `${t('status.command_complete')} (${snap.status}, exit: ${exitCode})`,
      toolName: 'await_exec',
      toolResult: `${header}\n${output}`
    })
    if (snap.status === 'completed') {
      return { success: true, output: `${header}\n${output}` }
    }
    return {
      success: false,
      output: `${header}\n${output}`,
      error: snap.status === 'killed'
        ? t('exec.killed_by_signal', { signal: snap.signal ?? 'unknown' })
        : `exit ${exitCode}`
    }
  }

  // pattern 命中、timeout，或用户插话：仍在跑
  const pid = String(snap.pid ?? 'unknown')
  const status = reason === 'user_message'
    ? t('exec.yielded', { taskId, pid, elapsed: runningSeconds(task) })
    : reason === 'pattern'
      ? t('exec.pattern_matched', { taskId, pid })
      : t('exec.still_running', { taskId, pid, waited: waitSeconds })
  const header = `${status}\n${followUpHint(task)}`

  const short = reason === 'user_message'
    ? t('exec.yielded_short')
    : reason === 'pattern'
      ? t('exec.pattern_matched_short')
      : t('exec.still_running_short')

  executor.addStep({
    type: 'tool_result',
    content: `⏳ ${short}`,
    toolName: 'await_exec',
    toolResult: `${header}\n${output}`
  })

  return {
    success: true,
    output: `${header}\n${output}`,
    isRunning: true,
  }
}

/** 叫停自己起的命令：和用户按停同一种停法，不另过风险确认 */
async function stopOwnCommand(task: BackgroundExecTask, executor: ToolExecutorConfig): Promise<ToolResult> {
  if (!task.owner || task.owner !== executor.agentId) {
    return { success: false, output: '', error: t('exec.stop_not_owner', { taskId: task.taskId }) }
  }
  const manager = getExecManager()
  executor.findBackgroundWatch?.(task.taskId)?.release()
  executor.addStep({
    type: 'tool_call',
    content: `⏹️ ${t('exec.stopping', { command: commandLabel(task) })}`,
    toolName: 'await_exec',
    toolArgs: { task_id: task.taskId, stop: true },
  })
  if (manager.stop(task)) {
    await manager.wait({ task, waitSeconds: 5, isAborted: () => executor.isAborted() })
  }
  const snap = manager.snapshot(task)
  const header = snap.status === 'running'
    ? t('exec.stop_pending', { taskId: task.taskId })
    : t('exec.task_done', { taskId: task.taskId, status: snap.status, exitCode: String(snap.exitCode ?? (snap.signal ? 1 : 0)) })
  const output = await formatTaskOutput(snap.output, executor)
  const short = snap.status === 'running' ? t('exec.stop_pending_short') : t('exec.stopped_short')
  executor.addStep({ type: 'tool_result', content: `⏹️ ${short}`, toolName: 'await_exec', toolResult: `${header}\n${output}` })
  return { success: true, output: `${header}\n${output}`, isRunning: snap.status === 'running' }
}

async function markedServiceResult(task: BackgroundExecTask, executor: ToolExecutorConfig): Promise<ToolResult> {
  const snap = getExecManager().snapshot(task)
  const pid = String(snap.pid ?? 'unknown')
  const short = t('exec.marked_service_short')
  executor.addStep({
    type: 'tool_call',
    content: t('exec.marking_service', { command: commandLabel(task) }),
    toolName: 'await_exec',
    toolArgs: { task_id: task.taskId, service: true },
  })
  const header = snap.status === 'running'
    ? `${t('exec.marked_service', { taskId: task.taskId, pid })}\n${followUpHint(task)}`
    : t('exec.task_done', { taskId: task.taskId, status: snap.status, exitCode: String(snap.exitCode ?? (snap.signal ? 1 : 0)) })
  const output = await formatTaskOutput(snap.output, executor)
  executor.addStep({ type: 'tool_result', content: short, toolName: 'await_exec', toolResult: `${header}\n${output}` })
  return { success: true, output: `${header}\n${output}`, isRunning: snap.status === 'running' }
}
