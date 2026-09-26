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
 * - 仍在跑且 wait_seconds < max_seconds → 转后台，返回 task_id 让 Agent 后续 await_exec
 * - 等待途中用户插话 → 立刻结束这次等待，命令继续跑；这一轮答完接着盯，结束时结果送回这场对话
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
import type { BackgroundWatch } from '../background-watch'

/**
 * 等后台任务时给用户看的一行：任务编号 + 已运行多久。
 * @internal 导出仅为单元测试
 */
export function formatAwaitingTitle(taskId: string, elapsed: string): string {
  return t('exec.awaiting', { taskId, elapsed })
}

function elapsedSince(startedAt: number): string {
  return formatTotalTime(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
}

function awaitingContent(taskId: string, startedAt: number): string {
  return `⏳ ${formatAwaitingTitle(taskId, elapsedSince(startedAt))}`
}

function userSpoke(executor: ToolExecutorConfig): boolean {
  return executor.hasPendingUserSpeech?.() ?? false
}

/**
 * 这次等待是被用户打断的，进程还在跑：结束时若没人接到，把结果送回这场对话。
 */
function armUnattendedReport(
  task: BackgroundExecTask,
  executor: ToolExecutorConfig,
): void {
  const manager = getExecManager()
  manager.armFinishReport(task, (snap) => {
    void deliverUnattendedReport(task, snap, executor)
  })
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

const STOPPED_NOTE_OUTPUT_MAX = 1500

/**
 * 这场对话正在等、或答应接着盯的一条命令。
 * - waiting：工具正在等它，按停就停掉它
 * - owed：用户插话打断过，还在跑，结束时结果要送回这场；这一轮闲下来专门等它
 * - released：不再盯（等到了结束，或模型自己放去后台不管）
 */
class CommandWatch implements BackgroundWatch {
  readonly key: string
  private phase: 'waiting' | 'owed' | 'released' = 'waiting'
  private holdStep?: { id: string; ticker: NodeJS.Timeout }
  private stopped = false
  /** 模型原本打算等到什么时候。插话不延长它，到点仍在跑就当作转后台 */
  private deadline = 0
  private deadlineTimer?: NodeJS.Timeout

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

  /** 开始一次等待。已经欠着的沿用原来的期限，换成当前这一轮来送结果 */
  beginWait(executor: ToolExecutorConfig, waitSeconds: number): void {
    this.executor = executor
    if (this.phase === 'waiting') this.deadline = Date.now() + waitSeconds * 1000
  }

  isPending(): boolean {
    if (this.phase === 'waiting') return this.task.status === 'running'
    if (this.phase === 'owed') return getExecManager().isFinishReportPending(this.task)
    return false
  }

  /** 一次等待结束了：用户打断且还在跑 → 欠着；否则工具自己等的这次就了结 */
  settle(reason: WaitReason | undefined): void {
    if (this.phase === 'released') return
    const interrupted = reason === 'user_message'
      || ((reason === 'timeout' || reason === 'pattern') && userSpoke(this.executor))
    if (interrupted && this.task.status === 'running' && this.phase === 'waiting') {
      this.owe()
      return
    }
    // 已经欠着的，不因为模型自己看了一眼进度就不管了
    if (this.phase === 'waiting') this.phase = 'released'
  }

  private owe(): void {
    this.phase = 'owed'
    armUnattendedReport(this.task, this.executor)
    this.deadlineTimer = setTimeout(() => this.expire(), Math.max(0, this.deadline - Date.now()))
    this.deadlineTimer.unref?.()
  }

  /** 到了原本要等的时间仍在跑：当作转后台告诉它，这一轮不再为它挂着，结束也不再送回 */
  private expire(): void {
    this.deadlineTimer = undefined
    if (this.phase !== 'owed' || this.task.status !== 'running') return
    this.phase = 'released'
    const manager = getExecManager()
    manager.consumeFinishReport(this.task)
    const snap = manager.snapshot(this.task)
    if (this.closeHoldStep()) {
      const short = t('exec.backgrounded_short', { taskId: this.key })
      this.executor.addStep({ type: 'tool_result', content: `⏳ ${short}`, toolName: 'await_exec', toolResult: short })
    }
    this.executor.deliverBackgroundNotice?.(t('exec.watch_expired', {
      taskId: this.key,
      pid: String(snap.pid ?? 'unknown'),
      command: shortCommand(snap.command),
      output: truncateFromEnd(snap.output.trim(), STOPPED_NOTE_OUTPUT_MAX),
    }))
  }

  release(): void {
    this.phase = 'released'
    this.closeHoldStep()
    this.clearDeadline()
  }

  holdStarted(): void {
    if (this.holdStep || this.phase !== 'owed' || this.task.status !== 'running') return
    const startedAt = this.task.startedAt
    const step = this.executor.addStep({
      type: 'tool_call',
      content: awaitingContent(this.key, startedAt),
      toolName: 'await_exec',
      toolArgs: { task_id: this.key },
    })
    const ticker = setInterval(() => {
      this.executor.updateStep(step.id, { content: awaitingContent(this.key, startedAt) })
    }, 1000)
    this.holdStep = { id: step.id, ticker }
  }

  holdEnded(): void {
    if (!this.closeHoldStep()) return
    const snap = getExecManager().snapshot(this.task)
    if (snap.status === 'running') {
      const short = t('exec.yielded_short', { taskId: this.key })
      this.executor.addStep({ type: 'tool_result', content: `⏳ ${short}`, toolName: 'await_exec', toolResult: short })
      return
    }
    const exitCode = snap.exitCode ?? (snap.signal ? 1 : 0)
    const done = `${t('status.command_complete')} (${snap.status}, exit: ${exitCode})`
    this.executor.addStep({ type: 'tool_result', content: done, toolName: 'await_exec', toolResult: done })
  }

  stop(): (() => string) | undefined {
    if (this.phase === 'released') return undefined
    this.phase = 'released'
    this.clearDeadline()
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

  private clearDeadline(): void {
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer)
    this.deadlineTimer = undefined
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
function watchCommand(task: BackgroundExecTask, executor: ToolExecutorConfig, waitSeconds: number): CommandWatch {
  const existing = executor.findBackgroundWatch?.(task.taskId)
  const watch = existing instanceof CommandWatch && existing.active
    ? existing
    : new CommandWatch(task, executor)
  if (watch !== existing) executor.trackBackgroundWatch?.(watch)
  watch.beginWait(executor, waitSeconds)
  return watch
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
const MAX_WAIT_SECONDS = 600        // 单次同步等待上限（防止 Agent 设置极长 wait 卡住会话）
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

  executor.addStep({
    type: 'tool_call',
    content: `${t('status.executing')}: ${command}`,
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
  const task = manager.spawn({ command, cwd, maxSeconds, env: skillEnv })
  const watch = watchCommand(task, executor, effectiveWait)

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
  const header = reason === 'user_message'
    ? t('exec.yielded', {
        taskId: snap.taskId,
        pid: String(snap.pid ?? 'unknown'),
      })
    : t('exec.backgrounded', {
        taskId: snap.taskId,
        pid: String(snap.pid ?? 'unknown'),
        waited: effectiveWait,
        max: maxSeconds,
      })
  const short = reason === 'user_message'
    ? t('exec.yielded_short', { taskId: snap.taskId })
    : t('exec.backgrounded_short', { taskId: snap.taskId })
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

  const snap0 = manager.snapshot(task)
  const step = executor.addStep({
    type: 'tool_call',
    content: awaitingContent(taskId, snap0.startedAt),
    toolName: 'await_exec',
    toolArgs: { task_id: taskId },
  })

  const ticker = setInterval(() => {
    executor.updateStep(step.id, {
      content: awaitingContent(taskId, snap0.startedAt),
    })
  }, 1000)

  const watch = watchCommand(task, executor, waitSeconds)
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
  const header = reason === 'user_message'
    ? t('exec.yielded', { taskId, pid: String(snap.pid ?? 'unknown') })
    : reason === 'pattern'
      ? t('exec.pattern_matched', { taskId, pid: String(snap.pid ?? 'unknown') })
      : t('exec.still_running', { taskId, pid: String(snap.pid ?? 'unknown'), waited: waitSeconds })

  const short = reason === 'user_message'
    ? t('exec.yielded_short', { taskId })
    : reason === 'pattern'
      ? t('exec.pattern_matched_short', { taskId })
      : t('exec.still_running_short', { taskId })

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
