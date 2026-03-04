import * as path from 'path'
import * as fs from 'fs'
import { getDocumentParserService } from '../../../document-parser.service'
import { t } from '../../i18n'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('PdfSkill')

export async function executePdfTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'pdf_view_page':
      return viewPdfPage(args, executor)
    default:
      return { success: false, output: '', error: t('pdf.unknown_tool', { name: toolName }) }
  }
}

async function viewPdfPage(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = args.path as string
  const pages = args.pages as number[]

  if (!filePath) {
    return { success: false, output: '', error: t('pdf.path_required') }
  }

  if (!pages || !Array.isArray(pages) || pages.length === 0) {
    return { success: false, output: '', error: t('pdf.pages_required') }
  }

  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath)

  if (!fs.existsSync(absPath)) {
    return { success: false, output: '', error: t('pdf.file_not_found', { path: absPath }) }
  }

  const MAX_PAGES_PER_CALL = 5
  const requestedPages = pages.slice(0, MAX_PAGES_PER_CALL)
  if (pages.length > MAX_PAGES_PER_CALL) {
    log.warn(`Requested ${pages.length} pages, limiting to ${MAX_PAGES_PER_CALL}`)
  }

  executor.addStep({
    type: 'tool_call',
    content: t('pdf.rendering_pages', { pages: requestedPages.join(', '), file: path.basename(absPath) }),
    toolName: 'pdf_view_page',
    toolArgs: { path: absPath, pages: requestedPages },
    riskLevel: 'safe'
  })

  try {
    const parser = getDocumentParserService()
    const result = await parser.renderPdfPages(absPath, requestedPages)

    const imageMapping = requestedPages
      .slice(0, result.images.length)
      .map((pageNum, i) => `Image ${i + 1} = Page ${pageNum}`)
      .join(', ')

    const output = t('pdf.render_result', {
      rendered: result.images.length,
      total: result.totalPages,
      imageMapping
    })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'pdf_view_page',
      toolResult: output
    })

    return {
      success: true,
      output,
      images: result.images
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    log.error('Failed to render PDF pages:', errorMsg)

    executor.addStep({
      type: 'tool_result',
      content: t('pdf.render_failed'),
      toolName: 'pdf_view_page',
      toolResult: errorMsg
    })

    return { success: false, output: '', error: t('pdf.render_failed_detail', { error: errorMsg }) }
  }
}
