/**
 * 编程技能 - 执行器
 */
import * as path from 'path'
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../tools/types'
import { resolveToolLocalPath } from '../../tools/file'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'
import { CodingProject, ProjectOpenError, type ProjectOverview, type TreeEntry, type ProjectOpenErrorCode } from './project'
import { Ripgrep, RipgrepError, RipgrepNotFoundError, type RipgrepFileMatches, type RipgrepFilters } from './ripgrep'
import { CodingState } from './state'

const log = createLogger('CodingExecutor')

const DEFAULT_MAX_MATCHES = 100
const DEFAULT_MAX_FILES = 200
const DEFAULT_MAX_FOUND = 100
const MAX_RESULTS_CAP = 1000
const MAX_CONTEXT_LINES = 10
const LINE_MAX_CHARS = 300

const OPEN_ERROR_KEYS: Record<ProjectOpenErrorCode, 'coding.open_not_found' | 'coding.open_not_directory' | 'coding.open_too_broad'> = {
  not_found: 'coding.open_not_found',
  not_directory: 'coding.open_not_directory',
  too_broad: 'coding.open_too_broad',
}

export async function executeCodingTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
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
      default:
        return fail(t('coding.unknown_tool', { name: toolName }))
    }
  } catch (e) {
    if (e instanceof RipgrepNotFoundError) return fail(t('coding.rg_not_found'))
    if (e instanceof RipgrepError) return fail(t('coding.search_error', { error: e.message }))
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

  CodingState.setRoot(executor, project.root)
  const rg = Ripgrep.locate() ? Ripgrep.create() : undefined
  const output = formatOverview(await project.overview(rg))
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

function filtersFrom(root: string, args: Record<string, unknown>): RipgrepFilters {
  const sub = stringArg(args.path)
  const glob = stringArg(args.glob)
  const fileType = stringArg(args.type)
  return {
    cwd: root,
    paths: sub ? [path.relative(root, path.resolve(root, sub)) || '.'] : undefined,
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
