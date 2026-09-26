/**
 * 编程技能 - 执行器
 */
import * as path from 'path'
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../tools/types'
import { multiEditFile, resolveToolLocalPath } from '../../tools/file'
import { riskNeedsConfirm } from '../../command-audit/confirm-policy'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'
import { CodingProject, ProjectOpenError, type ProjectOverview, type TreeEntry, type ProjectOpenErrorCode } from './project'
import { Ripgrep, RipgrepError, RipgrepNotFoundError, type RipgrepFileMatches, type RipgrepFilters } from './ripgrep'
import { CodingState } from './state'
import { CheckpointError, CheckpointStore, type Checkpoint, type CheckpointKind, type RestorePlan } from './checkpoint'
import { checkpointKeeper, type TakeResult } from './checkpoint-keeper'

const log = createLogger('CodingExecutor')

const DEFAULT_MAX_MATCHES = 100
const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_FOUND = 100
const MAX_RESULTS_CAP = 1000
const MAX_CONTEXT_LINES = 10
const LINE_MAX_CHARS = 300
const CHECKPOINT_LIST_LIMIT = 20
const CONFIRM_FILE_LIMIT = 20
const RESTORE_FILE_LIMIT = 30
const MAX_RESTORE_ATTEMPTS = 3

const KIND_KEYS: Record<CheckpointKind, 'coding.rewind_kind_open' | 'coding.rewind_kind_turn' | 'coding.rewind_kind_before_restore'> = {
  open: 'coding.rewind_kind_open',
  turn: 'coding.rewind_kind_turn',
  before_restore: 'coding.rewind_kind_before_restore',
}

const OPEN_ERROR_KEYS: Record<ProjectOpenErrorCode, 'coding.open_not_found' | 'coding.open_not_directory' | 'coding.open_too_broad'> = {
  not_found: 'coding.open_not_found',
  not_directory: 'coding.open_not_directory',
  too_broad: 'coding.open_too_broad',
}

export async function executeCodingTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'code_open_project':
        return await openProject(ptyId, args, executor)
      case 'code_search':
        return await search(args, executor)
      case 'code_find_files':
        return await findFiles(args, executor)
      case 'code_multi_edit':
        return await multiEditFile(ptyId, args, toolCallId, config, executor, toolName)
      case 'code_rewind':
        return await rewind(args, toolCallId, config, executor)
      default:
        return fail(t('coding.unknown_tool', { name: toolName }))
    }
  } catch (e) {
    if (e instanceof RipgrepNotFoundError) return fail(t('coding.rg_not_found'))
    if (e instanceof RipgrepError) return fail(t('coding.search_error', { error: e.message }))
    if (e instanceof CheckpointError) return fail(checkpointErrorMessage(e))
    if (e instanceof OutsideProjectError) return fail(t('coding.path_outside', { path: e.message }))
    log.error(`coding tool failed: ${toolName}`, e)
    return fail(e instanceof Error ? e.message : String(e))
  }
}

async function openProject(ptyId: string, args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const raw = stringArg(args.path)
  if (!raw) return fail(t('coding.path_required'))
  const target = resolveToolLocalPath(raw, ptyId, executor)
  executor.addStep({
    type: 'tool_call',
    content: t('coding.step_open', { path: target }),
    toolName: 'code_open_project',
    toolArgs: args,
    riskLevel: 'safe',
  })

  let project: CodingProject
  try {
    project = await CodingProject.open(target)
  } catch (e) {
    if (e instanceof ProjectOpenError) return fail(t(OPEN_ERROR_KEYS[e.code], { path: e.target }))
    throw e
  }

  const state = CodingState.setRoot(executor, project.root)
  const rg = Ripgrep.locate() ? Ripgrep.create() : undefined
  const [overview, checkpoint] = await Promise.all([
    project.overview(rg),
    executor.isSubAgent ? Promise.resolve(undefined) : checkpointKeeper.take(state, 'open'),
  ])
  const output = joinSections([formatOverview(overview), checkpoint ? formatCheckpointStatus(checkpoint) : ''])
  executor.addStep({
    type: 'tool_result',
    content: t('coding.step_opened', { name: path.basename(project.root) }),
    toolName: 'code_open_project',
    toolResult: output,
  })
  return { success: true, output }
}

async function search(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const root = CodingState.of(executor).root
  if (!root) return fail(t('coding.no_project'))
  const pattern = stringArg(args.pattern)
  if (!pattern) return fail(t('coding.pattern_required'))
  const mode = args.output === 'files' || args.output === 'count' ? args.output : 'content'

  executor.addStep({
    type: 'tool_call',
    content: t('coding.step_search', { pattern }),
    toolName: 'code_search',
    toolArgs: args,
    riskLevel: 'safe',
  })

  const rg = Ripgrep.create()
  const query = {
    ...filtersFrom(root, args),
    pattern,
    fixedStrings: args.literal === true,
    caseSensitive: typeof args.case_sensitive === 'boolean' ? args.case_sensitive : undefined,
    multiline: args.multiline === true,
  }

  let output: string
  let summary: string
  if (mode === 'content') {
    const max = limitArg(args.max_results, DEFAULT_MAX_MATCHES)
    const context = Math.min(Math.max(0, Math.floor(numberArg(args.context) ?? 0)), MAX_CONTEXT_LINES)
    const result = await rg.searchContent({ ...query, contextLines: context, maxMatches: max })
    summary = t('coding.search_summary_content', { matches: result.matchCount, files: result.files.length })
    output = result.files.length === 0
      ? t('coding.search_none')
      : joinSections([
        summary,
        result.files.map(formatFileMatches).join('\n\n'),
        result.truncated ? t('coding.search_truncated', { max }) : '',
        result.timedOut ? t('coding.search_timeout') : '',
      ])
  } else if (mode === 'files') {
    const max = limitArg(args.max_results, DEFAULT_MAX_FILES)
    const result = await rg.filesWithMatches(query, max)
    summary = t('coding.search_summary_files', { shown: result.paths.length, total: result.total })
    output = result.paths.length === 0
      ? t('coding.search_none')
      : joinSections([
        summary,
        result.paths.join('\n'),
        result.truncated ? t('coding.search_truncated', { max }) : '',
        result.timedOut ? t('coding.search_timeout') : '',
      ])
  } else {
    const max = limitArg(args.max_results, DEFAULT_MAX_FILES)
    const result = await rg.countMatches(query, max)
    summary = t('coding.search_summary_files', { shown: result.counts.length, total: result.total })
    output = result.counts.length === 0
      ? t('coding.search_none')
      : joinSections([
        summary,
        result.counts.map(c => `${c.path}: ${c.count}`).join('\n'),
        result.truncated ? t('coding.search_truncated', { max }) : '',
        result.timedOut ? t('coding.search_timeout') : '',
      ])
  }

  executor.addStep({
    type: 'tool_result',
    content: summary,
    toolName: 'code_search',
    toolResult: output,
  })
  return { success: true, output }
}

async function findFiles(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const root = CodingState.of(executor).root
  if (!root) return fail(t('coding.no_project'))
  const pattern = stringArg(args.pattern)
  if (!pattern) return fail(t('coding.pattern_required'))

  executor.addStep({
    type: 'tool_call',
    content: t('coding.step_find', { pattern }),
    toolName: 'code_find_files',
    toolArgs: args,
    riskLevel: 'safe',
  })

  const max = limitArg(args.max_results, DEFAULT_MAX_FOUND)
  const result = await Ripgrep.create().listFiles({ ...filtersFrom(root, args), globs: [pattern] }, max)
  const summary = t('coding.find_summary', { shown: result.paths.length, total: result.total })
  const output = result.paths.length === 0
    ? t('coding.find_none')
    : joinSections([
      summary,
      result.paths.join('\n'),
      result.truncated ? t('coding.search_truncated', { max }) : '',
      result.timedOut ? t('coding.search_timeout') : '',
    ])

  executor.addStep({
    type: 'tool_result',
    content: summary,
    toolName: 'code_find_files',
    toolResult: output,
  })
  return { success: true, output }
}

async function rewind(
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const state = CodingState.of(executor)
  const root = state.root
  if (!root) return fail(t('coding.no_project'))
  if (args.action !== 'list' && args.action !== 'restore') return fail(t('coding.rewind_action_required'))
  if (!(await CheckpointStore.isAvailable())) return fail(t('coding.rewind_unavailable'))
  const store = checkpointKeeper.storeFor(root)
  return args.action === 'list'
    ? listCheckpoints(store, state, args, executor)
    : restoreCheckpoint(store, state, args, toolCallId, config, executor)
}

async function listCheckpoints(
  store: CheckpointStore,
  state: CodingState,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: t('coding.step_rewind_list'),
    toolName: 'code_rewind',
    toolArgs: args,
    riskLevel: 'safe',
  })
  const items = await store.list(CHECKPOINT_LIST_LIMIT)
  let output: string
  if (items.length === 0) {
    output = t('coding.rewind_list_empty')
  } else {
    const lines = [t('coding.rewind_list_heading')]
    for (const [i, cp] of items.entries()) {
      const newer = i > 0 ? items[i - 1] : undefined
      const count = newer ? await store.changedFileCount(cp, newer) : undefined
      lines.push(t('coding.rewind_item', {
        id: shortId(cp),
        time: formatTime(cp.createdAt),
        kind: t(KIND_KEYS[cp.kind]),
        mine: state.isFromThisConversation(cp.id) ? t('coding.rewind_mine') : '',
        changes: count === undefined ? '' : count === 0 ? t('coding.rewind_no_changes') : t('coding.rewind_changes', { count }),
      }))
    }
    lines.push('', t('coding.rewind_list_hint'))
    output = lines.join('\n')
  }
  executor.addStep({
    type: 'tool_result',
    content: t('coding.step_rewind_listed', { count: items.length }),
    toolName: 'code_rewind',
    toolResult: output,
  })
  return { success: true, output }
}

async function restoreCheckpoint(
  store: CheckpointStore,
  state: CodingState,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const ref = stringArg(args.checkpoint) || undefined
  executor.addStep({
    type: 'tool_call',
    content: t('coding.step_rewind'),
    toolName: 'code_rewind',
    toolArgs: args,
    riskLevel: 'dangerous',
  })

  let plan = await store.prepareRestore(ref)
  state.recordCheckpoint(plan.saved.id)
  const needConfirm = riskNeedsConfirm('dangerous', config.executionMode, config.commandRiskPolicy)

  for (let attempt = 0; ; attempt++) {
    if (plan.target.tree === plan.saved.tree) {
      return { success: true, output: t('coding.rewind_nothing', { time: formatTime(plan.target.createdAt) }) }
    }
    if (needConfirm && !(await executor.waitForConfirmation(toolCallId, 'code_rewind', confirmArgs(plan), 'dangerous'))) {
      return fail(t('coding.rewind_rejected'))
    }
    const outcome = await store.applyRestore(plan)
    if (outcome.applied) {
      const output = formatRestore(outcome.plan, outcome.failedRemovals)
      executor.addStep({
        type: 'tool_result',
        content: t('coding.step_rewound', { time: formatTime(plan.target.createdAt) }),
        toolName: 'code_rewind',
        toolResult: output,
      })
      return { success: true, output }
    }
    plan = outcome.plan
    state.recordCheckpoint(plan.saved.id)
    if (attempt + 1 >= MAX_RESTORE_ATTEMPTS) return fail(t('coding.rewind_keeps_changing'))
  }
}

function confirmArgs(plan: RestorePlan): Record<string, unknown> {
  return {
    action: 'restore',
    checkpoint: shortId(plan.target),
    target_time: formatTime(plan.target.createdAt),
    restore_files: plan.restored.slice(0, CONFIRM_FILE_LIMIT),
    delete_files: plan.removed.slice(0, CONFIRM_FILE_LIMIT),
    total_restore: plan.restored.length,
    total_delete: plan.removed.length,
  }
}

function formatRestore(plan: RestorePlan, failedRemovals: string[]): string {
  const sections = [t('coding.rewind_done', {
    time: formatTime(plan.target.createdAt),
    kind: t(KIND_KEYS[plan.target.kind]),
    id: shortId(plan.target),
    restored: plan.restored.length,
    removed: plan.removed.length,
  })]
  if (plan.restored.length > 0) sections.push(`${t('coding.rewind_restored_files')}\n${listPaths(plan.restored)}`)
  if (plan.removed.length > 0) sections.push(`${t('coding.rewind_removed_files')}\n${listPaths(plan.removed)}`)
  if (failedRemovals.length > 0) sections.push(`${t('coding.rewind_remove_failed')}\n${listPaths(failedRemovals)}`)
  if (plan.skippedNested.length > 0) sections.push(t('coding.rewind_nested', { paths: plan.skippedNested.join(', ') }))
  sections.push(t('coding.rewind_saved', { id: shortId(plan.saved) }))
  return sections.join('\n\n')
}

function formatCheckpointStatus(result: TakeResult): string {
  const body = result.ok
    ? t('coding.ov_checkpoint_ready')
    : result.reason === 'unavailable'
      ? t('coding.ov_checkpoint_unavailable')
      : result.reason === 'timeout'
        ? t('coding.ov_checkpoint_timeout')
        : t('coding.ov_checkpoint_failed', { error: result.detail })
  return `${t('coding.ov_checkpoint')}\n${body}`
}

function checkpointErrorMessage(e: CheckpointError): string {
  switch (e.code) {
    case 'snapshot_failed': return t('coding.rewind_snapshot_failed', { error: e.message })
    case 'not_found': return t('coding.rewind_not_found', { id: e.message })
    case 'no_target': return t('coding.rewind_no_target')
    default: return e.saved
      ? t('coding.rewind_failed_midway', { error: e.message, id: shortId(e.saved) })
      : t('coding.rewind_failed', { error: e.message })
  }
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, RESTORE_FILE_LIMIT).map(p => `  ${p}`)
  if (paths.length > RESTORE_FILE_LIMIT) shown.push(`  ${t('coding.ov_more_entries', { count: paths.length - RESTORE_FILE_LIMIT })}`)
  return shown.join('\n')
}

function shortId(cp: Checkpoint): string {
  return cp.id.slice(0, 10)
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  return d.toDateString() === new Date().toDateString() ? clock : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`
}

class OutsideProjectError extends Error {}

function filtersFrom(root: string, args: Record<string, unknown>): RipgrepFilters {
  const sub = stringArg(args.path)
  const rel = sub ? path.relative(root, path.resolve(root, sub)) : ''
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new OutsideProjectError(sub)
  const glob = stringArg(args.glob)
  const fileType = stringArg(args.type)
  return {
    cwd: root,
    paths: sub ? [rel || '.'] : undefined,
    globs: glob ? [glob] : undefined,
    fileType: fileType || undefined,
  }
}

function formatFileMatches(file: RipgrepFileMatches): string {
  const out = [file.path]
  let prev: number | undefined
  for (const line of file.lines) {
    if (prev !== undefined && line.line > prev + 1) out.push('  ...')
    out.push(`  ${line.line}${line.isMatch ? ':' : '-'} ${clip(line.text, LINE_MAX_CHARS)}`)
    prev = line.line
  }
  return out.join('\n')
}

function formatOverview(ov: ProjectOverview): string {
  const sections: string[] = [t('coding.ov_opened', { root: ov.root })]

  const tree = ov.tree
  const treeHeading = !tree.ignoreAware
    ? t('coding.ov_tree_shallow')
    : tree.partial
      ? t('coding.ov_tree_partial', { count: tree.fileCount })
      : t('coding.ov_tree', { count: tree.fileCount })
  const treeLines = tree.entries.length === 0 ? [t('coding.ov_tree_empty')] : tree.entries.flatMap(e => formatTreeEntry(e, ''))
  if (tree.hiddenEntries > 0) treeLines.push(t('coding.ov_more_entries', { count: tree.hiddenEntries }))
  sections.push(`${treeHeading}\n${treeLines.join('\n')}`)

  const git = ov.git
  const gitLines: string[] = [t('coding.ov_git')]
  if (git.kind === 'unavailable') gitLines.push(t('coding.ov_git_unavailable'))
  else if (git.kind === 'not_repo') gitLines.push(t('coding.ov_git_not_repo'))
  else if (git.kind === 'timeout') gitLines.push(t('coding.ov_git_timeout'))
  else {
    if (git.branchLine) gitLines.push(t('coding.ov_git_branch', { branch: git.branchLine }))
    if (path.normalize(git.topLevel) !== path.normalize(ov.root)) gitLines.push(t('coding.ov_git_toplevel', { path: git.topLevel }))
    if (git.changeCount === 0) gitLines.push(t('coding.ov_git_clean'))
    else {
      gitLines.push(t('coding.ov_git_changes', { count: git.changeCount }))
      gitLines.push(...git.changes.map(c => `  ${c}`))
      if (git.changeCount > git.changes.length) gitLines.push(`  ${t('coding.ov_more_entries', { count: git.changeCount - git.changes.length })}`)
    }
  }
  sections.push(gitLines.join('\n'))

  const toolLines: string[] = [t('coding.ov_toolchains')]
  if (ov.toolchains.length === 0) toolLines.push(t('coding.ov_toolchains_none'))
  for (const tc of ov.toolchains) {
    toolLines.push(`- ${tc.label}（${tc.manifest}）`)
    for (const cmd of tc.commands) toolLines.push(cmd.name ? `  - ${cmd.name}: ${cmd.command}` : `  - ${cmd.command}`)
    if (tc.hiddenCommands > 0) toolLines.push(`  ${t('coding.ov_more_entries', { count: tc.hiddenCommands })}`)
  }
  sections.push(toolLines.join('\n'))

  if (ov.conventions.length > 0) {
    const parts = [t('coding.ov_conventions')]
    for (const c of ov.conventions) {
      const note = c.truncated ? `\n${t('coding.ov_convention_truncated', { total: c.totalChars, path: c.path })}` : ''
      parts.push(`### ${c.path}\n${c.content}${note}`)
    }
    sections.push(parts.join('\n\n'))
  }

  return sections.join('\n\n')
}

function formatTreeEntry(entry: TreeEntry, indent: string): string[] {
  if (!entry.isDir) return [`${indent}${entry.name}`]
  const label = entry.fileCount !== undefined ? `${indent}${entry.name}/ (${entry.fileCount})` : `${indent}${entry.name}/`
  const lines = [label]
  for (const child of entry.children ?? []) lines.push(...formatTreeEntry(child, `${indent}  `))
  if (entry.hiddenDirs) lines.push(`${indent}  ${t('coding.ov_more_dirs', { count: entry.hiddenDirs })}`)
  if (entry.hiddenFiles) lines.push(`${indent}  ${t('coding.ov_more_files', { count: entry.hiddenFiles })}`)
  return lines
}

function joinSections(parts: string[]): string {
  return parts.filter(Boolean).join('\n\n')
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberArg(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function limitArg(value: unknown, fallback: number): number {
  const n = numberArg(value)
  if (n === undefined || n <= 0) return fallback
  return Math.min(Math.floor(n), MAX_RESULTS_CAP)
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}
