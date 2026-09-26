/**
 * 编程技能 - 改文件后附上「可能新引入的语法错误」
 * 不拦修改，只在工具结果后面提示。
 */
import * as fs from 'fs'
import type { ToolResult } from '../../tools/types'
import type { SkillToolCall, SkillToolCallContext } from '../types'
import { t } from '../../i18n'
import { createLogger } from '../../../../utils/logger'
import { SyntaxChecker, type SyntaxIssue } from './syntax-checker'

const log = createLogger('CodingSyntaxGuard')

/** 改本机文本文件、参数里用 path 指明目标的工具 */
const LOCAL_TEXT_WRITE_TOOLS = new Set(['edit_file', 'write_text_file', 'code_multi_edit'])
const MAX_ISSUES_SHOWN = 10

type FileSnapshot = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'skip' }

export class SyntaxGuard {
  constructor(private readonly checker: SyntaxChecker = SyntaxChecker.shared()) {}

  async wrap(call: SkillToolCall, proceed: () => Promise<ToolResult>, ctx: SkillToolCallContext): Promise<ToolResult> {
    if (!LOCAL_TEXT_WRITE_TOOLS.has(call.name)) return proceed()
    const raw = call.args.path
    if (typeof raw !== 'string' || !raw.trim()) return proceed()
    const filePath = ctx.resolveLocalPath(raw)
    if (!this.checker.supports(filePath)) return proceed()

    const before = await snapshot(filePath)
    const result = await proceed()
    if (!result.success || before.kind === 'skip') return result

    try {
      const after = await snapshot(filePath)
      if (after.kind !== 'text') return result
      const issues = await this.checker.newIssues(filePath, before.kind === 'text' ? before.text : '', after.text)
      if (!issues || issues.length === 0) return result
      return { ...result, output: `${result.output}\n\n${formatIssues(issues)}` }
    } catch (error) {
      log.warn(`syntax check skipped for ${filePath}:`, error)
      return result
    }
  }
}

async function snapshot(filePath: string): Promise<FileSnapshot> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile() || SyntaxChecker.isTooLarge(stat.size)) return { kind: 'skip' }
    return { kind: 'text', text: await fs.promises.readFile(filePath, 'utf8') }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'skip' }
  }
}

function formatIssues(issues: SyntaxIssue[]): string {
  const lines = issues.slice(0, MAX_ISSUES_SHOWN).map(issue => issue.missing
    ? t('coding.syntax_missing', { line: issue.line, column: issue.column, missing: issue.missing, snippet: issue.snippet })
    : t('coding.syntax_error', { line: issue.line, column: issue.column, snippet: issue.snippet }))
  if (issues.length > MAX_ISSUES_SHOWN) lines.push(t('coding.syntax_more', { count: issues.length - MAX_ISSUES_SHOWN }))
  return `${t('coding.syntax_heading')}\n${lines.join('\n')}`
}
