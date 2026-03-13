/**
 * Excel 技能执行器
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t } from '../../i18n'
import { getTerminalStateService } from '../../../terminal-state.service'
import {
  isSessionOpen,
  getSession,
  createSession,
  markDirty,
  closeSession
} from './session'
import {
  PRESET_STYLES,
  getStyleConfig,
  applyHeaderStyle,
  applyDataStyle,
  applyFreezeHeader,
  autoFitColumns,
  applyCellStyle,
  type ExcelStyleConfig,
  type ExcelCellStyle
} from './styles'
import { app } from 'electron'
import { getKnowledgeService } from '../../../knowledge'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ExcelExecutor')

// ==================== 样式管理基础设施 ====================

function getStylesFilePath(): string {
  return path.join(app.getPath('userData'), 'excel-styles.json')
}
const EXCEL_STYLE_TAG = 'excel_style'

const customStyles = new Map<string, ExcelStyleConfig>()
const styleDocIds = new Map<string, string>()
let defaultStyleName: string | null = null
let stylesLoaded = false

function loadCustomStyles(): void {
  if (stylesLoaded) return

  try {
    const knowledgeService = getKnowledgeService()

    if (knowledgeService && knowledgeService.isEnabled()) {
      const docs = knowledgeService.getDocuments()
      const styleDocs = docs.filter(doc => doc.tags.includes(EXCEL_STYLE_TAG))

      for (const doc of styleDocs) {
        try {
          const styleData = JSON.parse(doc.content)
          customStyles.set(styleData.name, styleData as ExcelStyleConfig)
          styleDocIds.set(styleData.name, doc.id)
          if (styleData.isDefault) {
            defaultStyleName = styleData.name
          }
        } catch (e) {
          log.error(`Failed to parse excel style doc ${doc.id}:`, e)
        }
      }
      log.info(`Loaded ${customStyles.size} custom excel styles from knowledge base`)
    } else {
      if (fs.existsSync(getStylesFilePath())) {
        const data = JSON.parse(fs.readFileSync(getStylesFilePath(), 'utf-8'))
        if (data.styles) {
          for (const [name, style] of Object.entries(data.styles)) {
            customStyles.set(name, style as ExcelStyleConfig)
          }
        }
        if (data.defaultStyle) {
          defaultStyleName = data.defaultStyle
        }
        log.info(`Loaded ${customStyles.size} custom excel styles from local file`)
      }
    }
  } catch (e) {
    log.error('Failed to load custom excel styles:', e)
  }

  stylesLoaded = true
}

async function saveStyleToKnowledge(style: ExcelStyleConfig): Promise<string | null> {
  try {
    const knowledgeService = getKnowledgeService()
    if (!knowledgeService || !knowledgeService.isEnabled()) return null

    const existingDocId = styleDocIds.get(style.name)
    if (existingDocId) {
      await knowledgeService.removeDocument(existingDocId)
    }

    const styleContent = JSON.stringify(style, null, 2)
    const docId = await knowledgeService.addDocument({
      filename: `excel-style-${style.name}.json`,
      fileType: 'json',
      content: styleContent,
      fileSize: Buffer.from(styleContent).length,
      parseTime: 0
    }, {
      tags: [EXCEL_STYLE_TAG, style.name]
    })

    styleDocIds.set(style.name, docId)
    log.info(`Saved excel style "${style.name}" to knowledge base (doc: ${docId})`)
    return docId
  } catch (e) {
    log.error('Failed to save excel style to knowledge:', e)
    return null
  }
}

async function saveDefaultStyleSetting(): Promise<void> {
  const entries = Array.from(customStyles.entries())
  for (const [name, style] of entries) {
    const isDefault = name === defaultStyleName
    if (style.isDefault !== isDefault) {
      style.isDefault = isDefault
      await saveStyleToKnowledge(style)
    }
  }
}

function saveCustomStylesToFile(): void {
  try {
    const data = {
      styles: Object.fromEntries(customStyles),
      defaultStyle: defaultStyleName
    }
    const filePath = getStylesFilePath()
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    log.info(`Saved ${customStyles.size} custom excel styles to local file`)
  } catch (e) {
    log.error('Failed to save custom excel styles to file:', e)
  }
}

/**
 * 解析样式名称 → ExcelStyleConfig
 */
function resolveStyle(styleName?: string): ExcelStyleConfig {
  loadCustomStyles()

  if (!styleName) {
    if (defaultStyleName) {
      return customStyles.get(defaultStyleName) || PRESET_STYLES[defaultStyleName] || getStyleConfig()
    }
    return getStyleConfig()
  }

  return customStyles.get(styleName) || getStyleConfig(styleName)
}

/**
 * 执行 Excel 技能工具
 */
export async function executeExcelTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'excel_open':
      return await excelOpen(ptyId, args, executor)
    case 'excel_read':
      return await excelRead(ptyId, args, executor)
    case 'excel_modify':
      return await excelModify(ptyId, args, toolCallId, config, executor)
    case 'excel_save':
      return await excelSave(ptyId, args, toolCallId, config, executor)
    case 'excel_close':
      return await excelClose(ptyId, args, executor)
    case 'excel_from_markdown':
      return await excelFromMarkdown(ptyId, args, toolCallId, config, executor)
    case 'excel_analyze':
      return await excelAnalyze(ptyId, args, executor)
    case 'excel_create_style':
      return await excelCreateStyle(args, executor)
    case 'excel_edit_style':
      return await excelEditStyle(args, executor)
    case 'excel_delete_style':
      return await excelDeleteStyle(args, executor)
    case 'excel_list_styles':
      return await excelListStyles(executor)
    case 'excel_set_default_style':
      return await excelSetDefaultStyle(args, executor)
    default:
      return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
  }
}

/**
 * 解析文件路径
 */
function resolvePath(ptyId: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath
  }
  const terminalStateService = getTerminalStateService()
  const cwd = terminalStateService.getCwd(ptyId)
  return path.resolve(cwd, filePath)
}

/**
 * 打开 Excel 文件
 */
async function excelOpen(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const createIfNotExists = args.create_if_not_exists === true

  // 检查是否已打开
  if (isSessionOpen(filePath)) {
    return { success: false, output: '', error: t('excel.already_open', { path: filePath }) }
  }

  // 检查文件是否存在
  const fileExists = fs.existsSync(filePath)
  if (!fileExists && !createIfNotExists) {
    return { success: false, output: '', error: t('error.file_not_found', { path: filePath }) }
  }

  try {
    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()

    if (fileExists) {
      await workbook.xlsx.readFile(filePath)
    }
    
    // 设置公式计算属性，确保 Excel 打开时自动重新计算所有公式
    workbook.calcProperties = {
      fullCalcOnLoad: true
    }

    createSession(filePath, workbook)

    // 返回工作簿概览
    const sheets: string[] = []
    workbook.eachSheet((worksheet) => {
      sheets.push(`- **${worksheet.name}**: ${worksheet.rowCount} ${t('excel.rows')} x ${worksheet.columnCount} ${t('excel.columns')}`)
    })

    const output = fileExists
      ? t('excel.opened', { path: filePath, sheets: sheets.length }) + '\n\n' + sheets.join('\n')
      : t('excel.created_new', { path: filePath })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_open',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('excel.open_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 读取 Excel 数据
 */
async function excelRead(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const sheetName = args.sheet as string | undefined
  const range = args.range as string | undefined
  const includeStyles = args.include_styles === true

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('excel.not_open', { path: filePath }) }
  }

  const workbook = session.workbook

  // 如果没有指定 sheet，返回概览
  if (!sheetName) {
    const sheets: string[] = []
    workbook.eachSheet((worksheet) => {
      sheets.push(`- **${worksheet.name}**: ${worksheet.rowCount} ${t('excel.rows')} x ${worksheet.columnCount} ${t('excel.columns')}`)
    })

    const output = `## ${t('excel.workbook_overview')}\n\n${t('excel.file')}: ${path.basename(filePath)}\n${t('excel.sheet_count')}: ${workbook.worksheets.length}\n\n${sheets.join('\n')}\n\n💡 ${t('excel.read_hint')}`

    executor.addStep({
      type: 'tool_result',
      content: `${t('excel.read_success')}: ${workbook.worksheets.length} sheets`,
      toolName: 'excel_read',
      toolResult: truncateFromEnd(output, 500)
    })

    return { success: true, output }
  }

  // 读取指定 sheet
  const worksheet = workbook.getWorksheet(sheetName)
  if (!worksheet) {
    return { success: false, output: '', error: t('excel.sheet_not_found', { name: sheetName }) }
  }

  // 解析范围
  let startRow = 1, endRow = worksheet.rowCount
  let startCol = 1, endCol = worksheet.columnCount

  if (range) {
    const rangeMatch = range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i)
    if (rangeMatch) {
      startCol = columnLetterToNumber(rangeMatch[1])
      startRow = parseInt(rangeMatch[2])
      endCol = columnLetterToNumber(rangeMatch[3])
      endRow = parseInt(rangeMatch[4])
    }
  }

  // 应用限制（默认 50 行，上限 500 行）
  const userMaxRows = args.max_rows as number | undefined
  const maxRows = Math.min(Math.max(1, userMaxRows || 50), 500)
  const maxCols = 20
  const actualEndRow = Math.min(endRow, startRow + maxRows - 1)
  const actualEndCol = Math.min(endCol, startCol + maxCols - 1)
  const truncatedRows = endRow > actualEndRow
  const truncatedCols = endCol > actualEndCol

  // 读取数据
  const rows: string[][] = []
  for (let r = startRow; r <= actualEndRow; r++) {
    const row = worksheet.getRow(r)
    const cells: string[] = []
    for (let c = startCol; c <= actualEndCol; c++) {
      const cell = row.getCell(c)
      const val = formatCellValue(cell.value)
      if (includeStyles) {
        cells.push(val + formatCellStyle(cell))
      } else {
        cells.push(val)
      }
    }
    rows.push(cells)
  }

  // 生成 Markdown 表格
  let markdown = `## ${sheetName}\n\n`

  if (truncatedRows || truncatedCols) {
    markdown += `⚠️ ${t('excel.truncated', {
      totalRows: endRow - startRow + 1,
      totalCols: endCol - startCol + 1,
      showRows: actualEndRow - startRow + 1,
      showCols: actualEndCol - startCol + 1
    })}\n\n`
  }

  if (rows.length > 0) {
    markdown += '| ' + rows[0].join(' | ') + ' |\n'
    markdown += '| ' + rows[0].map(() => '---').join(' | ') + ' |\n'
    for (let i = 1; i < rows.length; i++) {
      markdown += '| ' + rows[i].join(' | ') + ' |\n'
    }
  }

  executor.addStep({
    type: 'tool_result',
    content: `${t('excel.read_success')}: ${sheetName} (${rows.length} ${t('excel.rows')})`,
    toolName: 'excel_read',
    toolResult: truncateFromEnd(markdown, 500)
  })

  return { success: true, output: markdown }
}

/**
 * 修改 Excel 数据
 */
async function excelModify(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const sheetName = args.sheet as string | undefined
  const cells = args.cells as Record<string, unknown> | undefined
  const addSheet = args.add_sheet as string | undefined
  const deleteSheet = args.delete_sheet as string | undefined

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('excel.not_open', { path: filePath }) }
  }

  const workbook = session.workbook
  const results: string[] = []

  // 添加新 Sheet
  if (addSheet) {
    if (workbook.getWorksheet(addSheet)) {
      return { success: false, output: '', error: t('excel.sheet_exists', { name: addSheet }) }
    }
    workbook.addWorksheet(addSheet)
    results.push(t('excel.sheet_added', { name: addSheet }))
    markDirty(filePath)
  }

  // 删除 Sheet
  if (deleteSheet) {
    const ws = workbook.getWorksheet(deleteSheet)
    if (!ws) {
      return { success: false, output: '', error: t('excel.sheet_not_found', { name: deleteSheet }) }
    }
    workbook.removeWorksheet(ws.id)
    results.push(t('excel.sheet_deleted', { name: deleteSheet }))
    markDirty(filePath)
  }

  // 修改单元格值
  if (cells && sheetName) {
    let worksheet = workbook.getWorksheet(sheetName)
    if (!worksheet) {
      worksheet = workbook.addWorksheet(sheetName)
      results.push(t('excel.sheet_added', { name: sheetName }))
    }

    let modCount = 0
    for (const [cellRef, value] of Object.entries(cells)) {
      const cell = worksheet.getCell(cellRef)

      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>
        if ('formula' in obj) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cell.value = { formula: String(obj.formula), result: obj.result as any }
        } else if ('text' in obj) {
          cell.value = String(obj.text)
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cell.value = value as any
        }
      } else if (typeof value === 'string' && value.startsWith('=')) {
        cell.value = { formula: value.slice(1) }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cell.value = value as any
      }
      modCount++
    }
    results.push(t('excel.cells_modified', { count: modCount, sheet: sheetName }))
    markDirty(filePath)
  }

  // 应用单元格样式
  const styles = args.styles as Record<string, unknown> | undefined
  if (styles && sheetName) {
    let worksheet = workbook.getWorksheet(sheetName)
    if (!worksheet) {
      worksheet = workbook.addWorksheet(sheetName)
      results.push(t('excel.sheet_added', { name: sheetName }))
    }

    // 按范围大小排序：大范围先应用，小范围/单个单元格后应用
    // 这样单个单元格的样式可以覆盖范围样式，不受 JSON 键序影响
    const entries = Object.entries(styles)
    entries.sort((a, b) => {
      const sizeA = calcRefCellCount(a[0])
      const sizeB = calcRefCellCount(b[0])
      return sizeB - sizeA
    })

    let styleCount = 0
    for (const [ref, styleObj] of entries) {
      const cellStyle = styleObj as ExcelCellStyle
      styleCount += applyStyleToRef(worksheet, ref, cellStyle)
    }
    results.push(t('excel.styles_applied', { count: styleCount, sheet: sheetName }))
    markDirty(filePath)
  }

  // 合并单元格
  const mergeCells = args.merge_cells as string | undefined
  if (mergeCells && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      worksheet.mergeCells(mergeCells)
      results.push(`已合并单元格 ${mergeCells}`)
      markDirty(filePath)
    }
  }

  // 取消合并单元格
  const unmergeCells = args.unmerge_cells as string | undefined
  if (unmergeCells && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      worksheet.unMergeCells(unmergeCells)
      results.push(`已取消合并 ${unmergeCells}`)
      markDirty(filePath)
    }
  }

  // 插入行
  const insertRows = args.insert_rows as { at: number; count?: number } | undefined
  if (insertRows && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      const count = insertRows.count || 1
      worksheet.spliceRows(insertRows.at, 0, ...Array.from({ length: count }, () => []))
      results.push(`在第 ${insertRows.at} 行前插入了 ${count} 行`)
      markDirty(filePath)
    }
  }

  // 删除行
  const deleteRows = args.delete_rows as { from: number; to: number } | undefined
  if (deleteRows && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      if (deleteRows.from < 1 || deleteRows.to < deleteRows.from) {
        return { success: false, output: '', error: `删除行失败：无效的范围 ${deleteRows.from}-${deleteRows.to}` }
      }
      const count = deleteRows.to - deleteRows.from + 1
      worksheet.spliceRows(deleteRows.from, count)
      results.push(`删除了第 ${deleteRows.from}-${deleteRows.to} 行（共 ${count} 行）`)
      markDirty(filePath)
    }
  }

  // 排序
  const sortArgs = args.sort as { range: string; column: string; order?: string; has_header?: boolean } | undefined
  if (sortArgs && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      const sortResult = applySortToRange(worksheet, sortArgs)
      results.push(sortResult)
      markDirty(filePath)
    }
  }

  // 自动筛选
  const autoFilter = args.auto_filter as string | undefined
  if (autoFilter && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      if (autoFilter === 'remove') {
        // exceljs 接受 null 来移除 autoFilter
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(worksheet as any).autoFilter = null
        results.push('已移除自动筛选')
      } else {
        worksheet.autoFilter = autoFilter
        results.push(`已设置自动筛选：${autoFilter}`)
      }
      markDirty(filePath)
    }
  }

  // 数据验证
  const dataValidation = args.data_validation as {
    cells: string; type: string; values?: string[]
    min?: number; max?: number; formula?: string
    prompt?: string; error_message?: string
  } | undefined
  if (dataValidation && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      const dvResult = applyDataValidation(worksheet, dataValidation)
      results.push(dvResult)
      markDirty(filePath)
    }
  }

  // 条件格式
  const conditionalFormat = args.conditional_format as {
    range: string; type: string; operator?: string
    value?: unknown; style?: Record<string, unknown>; priority?: number
  } | undefined
  if (conditionalFormat && sheetName) {
    const worksheet = workbook.getWorksheet(sheetName)
    if (worksheet) {
      const cfResult = applyConditionalFormat(worksheet, conditionalFormat)
      results.push(cfResult)
      markDirty(filePath)
    }
  }

  if (results.length === 0) {
    return { success: false, output: '', error: t('excel.no_operation') }
  }

  const output = results.join('\n') + '\n\n💡 ' + t('excel.save_reminder')

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'excel_modify',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 保存 Excel 文件
 */
async function excelSave(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('excel.not_open', { path: filePath }) }
  }

  if (!session.dirty) {
    const output = t('excel.no_changes')
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_save',
      toolResult: output
    })
    return { success: true, output }
  }

  // 需要用户确认
  executor.addStep({
    type: 'tool_call',
    content: t('excel.confirm_save', { path: filePath }),
    toolName: 'excel_save',
    toolArgs: args,
    riskLevel: 'moderate'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'excel_save',
    { path: filePath },
    'moderate'
  )

  if (!approved) {
    return { success: false, output: '', error: t('excel.user_rejected') }
  }

  try {
    // 创建备份（带本地时间戳，重名时自动加序号）
    if (fs.existsSync(filePath)) {
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
      const ext = path.extname(filePath)
      const baseName = filePath.slice(0, -ext.length)
      
      // 查找不重名的备份路径
      let backupPath = `${baseName}_${timestamp}${ext}.bak`
      let counter = 2
      while (fs.existsSync(backupPath)) {
        backupPath = `${baseName}_${timestamp}_${counter}${ext}.bak`
        counter++
      }
      fs.copyFileSync(filePath, backupPath)
    }

    await session.workbook.xlsx.writeFile(filePath)
    session.dirty = false

    const output = t('excel.saved', { path: filePath })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_save',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('excel.save_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 关闭 Excel 文件
 */
async function excelClose(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const discardChanges = args.discard_changes === true

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('excel.not_open', { path: filePath }) }
  }

  if (session.dirty && !discardChanges) {
    return { success: false, output: '', error: t('excel.unsaved_changes', { path: filePath }) }
  }

  const wasDirty = closeSession(filePath, false)
  
  const output = wasDirty
    ? t('excel.closed_discarded', { path: filePath })
    : t('excel.closed', { path: filePath })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'excel_close',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 从 Markdown 直接生成 Excel 文件（快速模式）
 */
async function excelFromMarkdown(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  const markdownArg = typeof args.markdown === 'string' && args.markdown.trim()
    ? args.markdown
    : undefined
  const markdownPathArg = typeof args.markdown_path === 'string' && args.markdown_path.trim()
    ? args.markdown_path.trim()
    : undefined

  if (!markdownArg && !markdownPathArg) {
    return { success: false, output: '', error: t('excel.markdown_input_required') }
  }
  if (markdownArg && markdownPathArg) {
    return { success: false, output: '', error: t('excel.markdown_input_conflict') }
  }

  let filePath = resolvePath(ptyId, args.path as string)
  const defaultSheetName = (args.sheet_name as string) || 'Sheet1'
  const styleName = args.style as string | undefined

  if (!filePath.toLowerCase().endsWith('.xlsx')) {
    filePath += '.xlsx'
  }

  let markdown = markdownArg
  if (markdownPathArg) {
    const markdownPath = resolvePath(ptyId, markdownPathArg)
    if (!fs.existsSync(markdownPath)) {
      return { success: false, output: '', error: t('error.file_not_found', { path: markdownPath }) }
    }

    try {
      markdown = fs.readFileSync(markdownPath, 'utf-8')
      if (!markdown.trim()) {
        return { success: false, output: '', error: t('excel.markdown_empty', { path: markdownPath }) }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : t('excel.from_md_failed')
      return {
        success: false,
        output: '',
        error: t('excel.markdown_read_failed', { path: markdownPath, detail })
      }
    }
  }

  // 解析 Markdown 表格
  const sheets = parseMarkdownTables(markdown, defaultSheetName)
  if (sheets.length === 0) {
    return { success: false, output: '', error: t('excel.no_tables_found') }
  }

  // 解析样式
  const styleConfig = resolveStyle(styleName)

  // 用户确认
  executor.addStep({
    type: 'tool_call',
    content: t('excel.confirm_from_md', { path: filePath, sheets: sheets.length }),
    toolName: 'excel_from_markdown',
    toolArgs: { path: filePath, sheets: sheets.length },
    riskLevel: 'moderate'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'excel_from_markdown',
    { path: filePath },
    'moderate'
  )

  if (!approved) {
    return { success: false, output: '', error: t('excel.user_rejected') }
  }

  try {
    if (isSessionOpen(filePath)) {
      const session = getSession(filePath)
      if (session?.dirty) {
        return { success: false, output: '', error: t('excel.unsaved_changes', { path: filePath }) }
      }
      closeSession(filePath, false)
    }

    // 已存在文件则备份
    if (fs.existsSync(filePath)) {
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
      const ext = path.extname(filePath)
      const baseName = filePath.slice(0, -ext.length)
      let backupPath = `${baseName}_${timestamp}${ext}.bak`
      let counter = 2
      while (fs.existsSync(backupPath)) {
        backupPath = `${baseName}_${timestamp}_${counter}${ext}.bak`
        counter++
      }
      fs.copyFileSync(filePath, backupPath)
    }

    const ExcelJS = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    workbook.calcProperties = { fullCalcOnLoad: true }

    const sheetSummaries: string[] = []

    for (const sheet of sheets) {
      const worksheet = workbook.addWorksheet(sheet.name)

      // 写入表头 + 应用主题样式
      if (sheet.headers.length > 0) {
        const headerRow = worksheet.addRow(sheet.headers)
        headerRow.eachCell((cell) => {
          applyHeaderStyle(cell, styleConfig)
        })
      }

      // 写入数据行 + 应用主题样式
      for (let i = 0; i < sheet.rows.length; i++) {
        const dataRow = worksheet.addRow(sheet.rows[i].map(parseSmartValue))
        dataRow.eachCell((cell) => {
          applyDataStyle(cell, styleConfig, i)
        })
      }

      // 自动调整列宽
      if (styleConfig.config.autoWidth !== false) {
        autoFitColumns(worksheet)
      }

      // 冻结表头
      if (styleConfig.config.freezeHeader) {
        applyFreezeHeader(worksheet)
      }

      sheetSummaries.push(`- **${sheet.name}**: ${sheet.rows.length} ${t('excel.rows')}`)
    }

    // 确保目录存在
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    await workbook.xlsx.writeFile(filePath)

    const output = t('excel.created_from_md', { path: filePath, sheets: sheets.length }) + '\n\n' + sheetSummaries.join('\n')

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_from_markdown',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('excel.from_md_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

// ============ 工作簿分析 ============

type AnalysisCheck = 'errors' | 'formulas' | 'summary' | 'duplicates' | 'structure'
const ALL_CHECKS: AnalysisCheck[] = ['errors', 'formulas', 'summary', 'duplicates', 'structure']

async function excelAnalyze(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  const filePath = resolvePath(ptyId, args.path as string)
  const sheetName = args.sheet as string | undefined
  const checks = (args.checks as string[] | undefined)?.filter(c => ALL_CHECKS.includes(c as AnalysisCheck)) as AnalysisCheck[] || ALL_CHECKS

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('excel.not_open', { path: filePath }) }
  }

  const workbook = session.workbook
  const worksheets = sheetName
    ? [workbook.getWorksheet(sheetName)].filter(Boolean) as import('exceljs').Worksheet[]
    : workbook.worksheets

  if (worksheets.length === 0) {
    return { success: false, output: '', error: sheetName ? t('excel.sheet_not_found', { name: sheetName }) : 'No worksheets found' }
  }

  const sections: string[] = [`## 工作簿分析报告\n\n文件：${path.basename(filePath)}\n`]
  let totalIssues = 0

  for (const ws of worksheets) {
    sections.push(`### Sheet: ${ws.name} (${ws.rowCount} 行 × ${ws.columnCount} 列)\n`)

    try {

    if (checks.includes('errors')) {
      const errorCells = findErrorCells(ws)
      if (errorCells.length > 0) {
        totalIssues += errorCells.length
        sections.push(`#### 🔴 错误单元格 (${errorCells.length} 个)\n`)
        const displayErrors = errorCells.slice(0, 50)
        sections.push('| 单元格 | 错误类型 | 公式 |')
        sections.push('|--------|----------|------|')
        for (const e of displayErrors) {
          sections.push(`| ${e.ref} | ${e.errorType} | ${e.formula || '-'} |`)
        }
        if (errorCells.length > 50) {
          sections.push(`\n... 还有 ${errorCells.length - 50} 个错误`)
        }
        sections.push('')
      } else {
        sections.push('#### ✅ 未发现错误单元格\n')
      }
    }

    if (checks.includes('formulas')) {
      const formulaStats = analyzeFormulas(ws)
      sections.push('#### 📊 公式分析\n')
      sections.push(`- 公式单元格：${formulaStats.formulaCount} 个`)
      sections.push(`- 硬编码值：${formulaStats.hardcodedCount} 个`)
      sections.push(`- 空单元格：${formulaStats.emptyCount} 个`)
      if (formulaStats.totalNonEmpty > 0) {
        sections.push(`- 公式占比：${(formulaStats.formulaCount / formulaStats.totalNonEmpty * 100).toFixed(1)}%`)
      }
      if (formulaStats.uniqueFormulas.length > 0) {
        sections.push(`- 常见公式模式 (前 10)：`)
        for (const f of formulaStats.uniqueFormulas.slice(0, 10)) {
          sections.push(`  - \`${f.pattern}\` × ${f.count}`)
        }
      }
      sections.push('')
    }

    if (checks.includes('summary')) {
      const dataSummary = analyzeDataSummary(ws)
      if (dataSummary.columns.length > 0) {
        sections.push('#### 📋 数据摘要\n')
        sections.push('| 列 | 数据类型 | 非空 | 空值率 | 最小值 | 最大值 | 平均值 |')
        sections.push('|-----|---------|------|--------|--------|--------|--------|')
        for (const col of dataSummary.columns.slice(0, 30)) {
          const emptyRate = col.totalRows > 0 ? ((col.emptyCount / col.totalRows) * 100).toFixed(0) + '%' : '-'
          sections.push(`| ${col.letter}: ${col.header} | ${col.dominantType} | ${col.nonEmptyCount} | ${emptyRate} | ${col.min ?? '-'} | ${col.max ?? '-'} | ${col.avg ?? '-'} |`)
        }
        sections.push('')
      }
    }

    if (checks.includes('duplicates')) {
      const dupes = findDuplicateRows(ws)
      if (dupes.length > 0) {
        totalIssues += dupes.length
        sections.push(`#### ⚠️ 重复行 (${dupes.length} 组)\n`)
        const displayDupes = dupes.slice(0, 20)
        for (const d of displayDupes) {
          sections.push(`- 行 ${d.rows.join(', ')}：\`${d.preview}\``)
        }
        if (dupes.length > 20) {
          sections.push(`\n... 还有 ${dupes.length - 20} 组重复`)
        }
        sections.push('')
      } else {
        sections.push('#### ✅ 未发现重复行\n')
      }
    }

    if (checks.includes('structure')) {
      const structIssues = analyzeStructure(ws)
      if (structIssues.length > 0) {
        totalIssues += structIssues.length
        sections.push(`#### ⚠️ 结构问题 (${structIssues.length} 个)\n`)
        for (const issue of structIssues.slice(0, 20)) {
          sections.push(`- ${issue}`)
        }
        sections.push('')
      } else {
        sections.push('#### ✅ 结构正常\n')
      }
    }

    } catch (e) {
      sections.push(`\n⚠️ 分析 Sheet "${ws.name}" 时出错：${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  sections.push(`---\n**总计问题数**：${totalIssues}`)

  const output = sections.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: `分析完成：${worksheets.length} 个 Sheet，发现 ${totalIssues} 个问题`,
    toolName: 'excel_analyze',
    toolResult: truncateFromEnd(output, 800)
  })

  return { success: true, output }
}

interface ErrorCellInfo {
  ref: string
  errorType: string
  formula?: string
}

function findErrorCells(ws: import('exceljs').Worksheet): ErrorCellInfo[] {
  const errors: ErrorCellInfo[] = []
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      const val = cell.value
      if (val && typeof val === 'object') {
        const obj = val as Record<string, unknown>
        if ('error' in obj) {
          errors.push({
            ref: `${numberToColumnLetter(colNum)}${rowNum}`,
            errorType: String(obj.error),
            formula: 'formula' in obj ? String(obj.formula) : undefined
          })
        }
        if ('result' in obj && typeof obj.result === 'object' && obj.result !== null && 'error' in (obj.result as Record<string, unknown>)) {
          errors.push({
            ref: `${numberToColumnLetter(colNum)}${rowNum}`,
            errorType: String((obj.result as Record<string, unknown>).error),
            formula: 'formula' in obj ? String(obj.formula) : undefined
          })
        }
      }
    })
  })
  return errors
}

interface FormulaStats {
  formulaCount: number
  hardcodedCount: number
  emptyCount: number
  totalNonEmpty: number
  uniqueFormulas: { pattern: string; count: number }[]
}

function analyzeFormulas(ws: import('exceljs').Worksheet): FormulaStats {
  let formulaCount = 0
  let hardcodedCount = 0
  let emptyCount = 0
  const formulaPatterns = new Map<string, number>()

  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const val = cell.value
      if (val === null || val === undefined || val === '') {
        emptyCount++
        return
      }
      if (typeof val === 'object' && val !== null && 'formula' in (val as Record<string, unknown>)) {
        formulaCount++
        const formula = String((val as Record<string, unknown>).formula)
        const pattern = formula.replace(/[A-Z]+\d+/g, '_REF_').replace(/\d+/g, 'N')
        formulaPatterns.set(pattern, (formulaPatterns.get(pattern) || 0) + 1)
      } else {
        hardcodedCount++
      }
    })
  })

  const uniqueFormulas = Array.from(formulaPatterns.entries())
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count)

  return {
    formulaCount,
    hardcodedCount,
    emptyCount,
    totalNonEmpty: formulaCount + hardcodedCount,
    uniqueFormulas
  }
}

interface ColumnSummary {
  letter: string
  header: string
  dominantType: string
  totalRows: number
  nonEmptyCount: number
  emptyCount: number
  min?: string
  max?: string
  avg?: string
}

function analyzeDataSummary(ws: import('exceljs').Worksheet): { columns: ColumnSummary[] } {
  const columns: ColumnSummary[] = []
  if (ws.rowCount < 1 || ws.columnCount < 1) return { columns }

  const headerRow = ws.getRow(1)

  for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) {
    const header = formatCellValue(headerRow.getCell(c).value)
    const typeCounts = new Map<string, number>()
    let nonEmpty = 0
    let empty = 0
    const numericValues: number[] = []

    for (let r = 2; r <= ws.rowCount; r++) {
      const cell = ws.getRow(r).getCell(c)
      const val = cell.value
      if (val === null || val === undefined || val === '') {
        empty++
        continue
      }
      nonEmpty++
      const cellType = typeof val === 'number' ? 'number'
        : typeof val === 'boolean' ? 'boolean'
        : (val instanceof Date) ? 'date'
        : (typeof val === 'object' && 'formula' in (val as Record<string, unknown>)) ? 'formula'
        : 'text'
      typeCounts.set(cellType, (typeCounts.get(cellType) || 0) + 1)

      if (typeof val === 'number') {
        numericValues.push(val)
      } else if (typeof val === 'object' && val !== null && 'result' in (val as Record<string, unknown>)) {
        const result = (val as Record<string, unknown>).result
        if (typeof result === 'number') numericValues.push(result)
      }
    }

    let dominantType = '-'
    let maxCount = 0
    for (const [type, count] of typeCounts) {
      if (count > maxCount) { dominantType = type; maxCount = count }
    }

    const col: ColumnSummary = {
      letter: numberToColumnLetter(c),
      header: header.slice(0, 20) || `(col ${c})`,
      dominantType,
      totalRows: ws.rowCount - 1,
      nonEmptyCount: nonEmpty,
      emptyCount: empty
    }

    if (numericValues.length > 0) {
      col.min = Math.min(...numericValues).toFixed(2)
      col.max = Math.max(...numericValues).toFixed(2)
      col.avg = (numericValues.reduce((a, b) => a + b, 0) / numericValues.length).toFixed(2)
    }

    columns.push(col)
  }

  return { columns }
}

function findDuplicateRows(ws: import('exceljs').Worksheet): { rows: number[]; preview: string }[] {
  const rowHashes = new Map<string, { rows: number[]; display: string }>()

  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return
    const values: string[] = []
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(formatCellValue(cell.value))
    })
    const hash = JSON.stringify(values)
    const display = values.join(' | ')
    if (!rowHashes.has(hash)) rowHashes.set(hash, { rows: [], display })
    rowHashes.get(hash)!.rows.push(rowNum)
  })

  return Array.from(rowHashes.values())
    .filter(entry => entry.rows.length > 1)
    .map(entry => ({
      rows: entry.rows,
      preview: entry.display.length > 80 ? entry.display.slice(0, 80) + '...' : entry.display
    }))
}

function analyzeStructure(ws: import('exceljs').Worksheet): string[] {
  const issues: string[] = []
  if (ws.rowCount === 0) {
    issues.push('Sheet 为空')
    return issues
  }

  const headerColCount = ws.getRow(1).cellCount

  // 空行检测（数据区域中间的空行）
  let lastNonEmptyRow = 0
  const emptyRowsInMiddle: number[] = []
  ws.eachRow({ includeEmpty: true }, (row, rowNum) => {
    let hasValue = false
    row.eachCell({ includeEmpty: false }, () => { hasValue = true })
    if (hasValue) {
      if (lastNonEmptyRow > 0 && rowNum - lastNonEmptyRow > 1) {
        for (let r = lastNonEmptyRow + 1; r < rowNum; r++) {
          emptyRowsInMiddle.push(r)
        }
      }
      lastNonEmptyRow = rowNum
    }
  })
  if (emptyRowsInMiddle.length > 0 && emptyRowsInMiddle.length <= 10) {
    issues.push(`数据中间有空行：${emptyRowsInMiddle.join(', ')}`)
  } else if (emptyRowsInMiddle.length > 10) {
    issues.push(`数据中间有 ${emptyRowsInMiddle.length} 个空行`)
  }

  // 不规则行检测
  const irregularRows: number[] = []
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return
    if (row.cellCount !== headerColCount && row.cellCount > 0 && headerColCount > 0) {
      irregularRows.push(rowNum)
    }
  })
  if (irregularRows.length > 0 && irregularRows.length <= 10) {
    issues.push(`列数不一致的行（表头 ${headerColCount} 列）：行 ${irregularRows.join(', ')}`)
  } else if (irregularRows.length > 10) {
    issues.push(`${irregularRows.length} 行的列数与表头 (${headerColCount} 列) 不一致`)
  }

  return issues
}

function numberToColumnLetter(num: number): string {
  let result = ''
  while (num > 0) {
    num--
    result = String.fromCharCode(65 + (num % 26)) + result
    num = Math.floor(num / 26)
  }
  return result
}

// ============ Markdown 解析 ============

interface ParsedSheet {
  name: string
  headers: string[]
  rows: string[][]
}

/**
 * 清理 Sheet 名称，确保符合 Excel 限制（31 字符，禁止 \/*?:[]）
 */
function sanitizeSheetName(name: string): string {
  let cleaned = name.replace(/[\\/*?:[\]]/g, '_')
  if (cleaned.length > 31) {
    cleaned = cleaned.slice(0, 31)
  }
  return cleaned || 'Sheet'
}

/**
 * 从 Markdown 提取所有表格，按 ## 标题分成多个 Sheet
 */
function parseMarkdownTables(markdown: string, defaultSheetName: string): ParsedSheet[] {
  const sheets: ParsedSheet[] = []
  const lines = markdown.split('\n')

  let currentTitle = ''
  let tableLines: string[] = []
  let sheetIndex = 0

  const flushTable = () => {
    if (tableLines.length === 0) return

    const parsed = parseTableLines(tableLines)
    if (parsed) {
      const rawName = currentTitle || (sheetIndex === 0 ? defaultSheetName : `Sheet${sheetIndex + 1}`)
      const name = sanitizeSheetName(rawName)
      let finalName = name
      let dupIdx = 2
      while (sheets.some(s => s.name === finalName)) {
        finalName = sanitizeSheetName(`${name} (${dupIdx++})`)
      }
      sheets.push({ name: finalName, headers: parsed.headers, rows: parsed.rows })
      sheetIndex++
    }
    tableLines = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    // 检测 ## 标题
    const headingMatch = trimmed.match(/^#{1,3}\s+(.+)$/)
    if (headingMatch) {
      flushTable()
      currentTitle = headingMatch[1].trim()
      continue
    }

    // 检测表格行（以 | 开头或包含 |）
    if (trimmed.startsWith('|') || (trimmed.includes('|') && tableLines.length > 0)) {
      tableLines.push(trimmed)
    } else if (tableLines.length > 0 && trimmed === '') {
      // 空行结束当前表格
      flushTable()
    } else if (tableLines.length > 0) {
      // 非表格行结束当前表格
      flushTable()
    }
  }

  flushTable()
  return sheets
}

/**
 * 解析表格行（含分隔符行）
 */
function parseTableLines(lines: string[]): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null

  const parseRow = (line: string): string[] => {
    let trimmed = line.trim()
    if (trimmed.startsWith('|')) trimmed = trimmed.slice(1)
    if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1)
    return trimmed.split('|').map(cell => cell.trim())
  }

  const headers = parseRow(lines[0])

  // 找到分隔符行（---）并跳过
  let dataStart = 1
  if (lines.length > 1) {
    const possibleSep = lines[1].trim()
    if (/^[\s|:-]+$/.test(possibleSep)) {
      dataStart = 2
    }
  }

  const rows: string[][] = []
  for (let i = dataStart; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!trimmed || /^[\s|:-]+$/.test(trimmed)) continue
    rows.push(parseRow(trimmed))
  }

  if (headers.length === 0) return null
  return { headers, rows }
}

/**
 * 智能解析单元格值：数字、百分比、布尔值等
 */
function parseSmartValue(value: string): string | number | boolean {
  if (value === '') return ''

  // 布尔
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false

  // 纯数字（含负数、小数）
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value)
  }

  // 千分位数字（如 1,234 或 1,234.56）
  if (/^-?\d{1,3}(,\d{3})*(\.\d+)?$/.test(value)) {
    return Number(value.replace(/,/g, ''))
  }

  return value
}

// ============ 辅助函数 ============

/**
 * 对指定范围的数据排序
 */
function applySortToRange(
  worksheet: import('exceljs').Worksheet,
  args: { range: string; column: string; order?: string; has_header?: boolean }
): string {
  const rangeMatch = args.range.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i)
  if (!rangeMatch) return '排序失败：无效的范围格式'

  const startCol = columnLetterToNumber(rangeMatch[1])
  const startRow = parseInt(rangeMatch[2])
  const endCol = columnLetterToNumber(rangeMatch[3])
  const endRow = parseInt(rangeMatch[4])
  const sortColNum = columnLetterToNumber(args.column)
  if (sortColNum < startCol || sortColNum > endCol) {
    return `排序失败：排序列 ${args.column} 不在范围 ${args.range} 内`
  }
  const ascending = args.order !== 'desc'
  const hasHeader = args.has_header !== false

  const dataStartRow = hasHeader ? startRow + 1 : startRow

  // 收集所有行数据
  const rows: { sortVal: unknown; rowData: unknown[][] }[] = []
  for (let r = dataStartRow; r <= endRow; r++) {
    const row = worksheet.getRow(r)
    const rowData: unknown[][] = []
    for (let c = startCol; c <= endCol; c++) {
      const cell = row.getCell(c)
      rowData.push([cell.value, cell.style ? JSON.parse(JSON.stringify(cell.style)) : {}])
    }
    const sortCell = row.getCell(sortColNum)
    let sortVal = sortCell.value
    if (typeof sortVal === 'object' && sortVal !== null) {
      const obj = sortVal as Record<string, unknown>
      if ('result' in obj) sortVal = obj.result
      else if ('text' in obj) sortVal = obj.text
    }
    rows.push({ sortVal, rowData })
  }

  // 排序
  rows.sort((a, b) => {
    const va = a.sortVal
    const vb = b.sortVal
    if (va === null || va === undefined) return 1
    if (vb === null || vb === undefined) return -1
    if (typeof va === 'number' && typeof vb === 'number') {
      return ascending ? va - vb : vb - va
    }
    const sa = String(va)
    const sb = String(vb)
    return ascending ? sa.localeCompare(sb) : sb.localeCompare(sa)
  })

  // 回写排序后的数据
  for (let i = 0; i < rows.length; i++) {
    const r = dataStartRow + i
    const row = worksheet.getRow(r)
    for (let j = 0; j < rows[i].rowData.length; j++) {
      const c = startCol + j
      const cell = row.getCell(c)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cell.value = rows[i].rowData[j][0] as any
      if (rows[i].rowData[j][1]) {
        Object.assign(cell, { style: rows[i].rowData[j][1] })
      }
    }
  }

  return `已按列 ${args.column} ${ascending ? '升序' : '降序'}排序（${rows.length} 行数据）`
}

/**
 * 应用数据验证规则
 */
function applyDataValidation(
  worksheet: import('exceljs').Worksheet,
  args: {
    cells: string; type: string; values?: string[]
    min?: number; max?: number; formula?: string
    prompt?: string; error_message?: string
  }
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const validation: any = { showErrorMessage: true }

  if (args.error_message) validation.error = args.error_message
  if (args.prompt) {
    validation.showInputMessage = true
    validation.promptTitle = '输入提示'
    validation.prompt = args.prompt
  }

  switch (args.type) {
    case 'list':
      if (!args.values || args.values.length === 0) return '数据验证失败：list 类型需要 values 参数'
      validation.type = 'list'
      validation.allowBlank = true
      validation.formulae = [`"${args.values.map(v => v.replace(/"/g, '""')).join(',')}"`]
      break
    case 'number':
    case 'decimal':
      validation.type = args.type === 'number' ? 'whole' : 'decimal'
      validation.allowBlank = true
      if (args.min !== undefined && args.max !== undefined) {
        validation.operator = 'between'
        validation.formulae = [args.min, args.max]
      } else if (args.min !== undefined) {
        validation.operator = 'greaterThanOrEqual'
        validation.formulae = [args.min]
      } else if (args.max !== undefined) {
        validation.operator = 'lessThanOrEqual'
        validation.formulae = [args.max]
      }
      break
    case 'textLength':
      validation.type = 'textLength'
      validation.allowBlank = true
      if (args.min !== undefined && args.max !== undefined) {
        validation.operator = 'between'
        validation.formulae = [args.min, args.max]
      } else if (args.max !== undefined) {
        validation.operator = 'lessThanOrEqual'
        validation.formulae = [args.max]
      }
      break
    case 'custom':
      if (!args.formula) return '数据验证失败：custom 类型需要 formula 参数'
      validation.type = 'custom'
      validation.formulae = [args.formula]
      break
    default:
      return `数据验证失败：不支持的类型 "${args.type}"`
  }

  // 应用到范围内的每个单元格
  const rangeMatch = args.cells.match(/([A-Z]+)(\d+):([A-Z]+)(\d+)/i)
  if (rangeMatch) {
    const sc = columnLetterToNumber(rangeMatch[1])
    const sr = parseInt(rangeMatch[2])
    const ec = columnLetterToNumber(rangeMatch[3])
    const er = parseInt(rangeMatch[4])
    for (let r = sr; r <= er; r++) {
      for (let c = sc; c <= ec; c++) {
        worksheet.getRow(r).getCell(c).dataValidation = validation
      }
    }
    return `已为 ${args.cells} 设置数据验证（${args.type}）`
  }

  // 单个单元格
  worksheet.getCell(args.cells).dataValidation = validation
  return `已为 ${args.cells} 设置数据验证（${args.type}）`
}

/**
 * 应用条件格式
 */
function applyConditionalFormat(
  worksheet: import('exceljs').Worksheet,
  args: {
    range: string; type: string; operator?: string
    value?: unknown; style?: Record<string, unknown>; priority?: number
  }
): string {
  const rules = worksheet.conditionalFormattings.getRules(args.range)

  switch (args.type) {
    case 'highlight': {
      if (!args.operator) return '条件格式失败：highlight 类型需要 operator 参数'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rule: any = {
        type: 'cellIs',
        operator: args.operator,
        priority: args.priority || (rules.length + 1),
        style: buildConditionalStyle(args.style)
      }
      if (args.operator === 'between' && Array.isArray(args.value)) {
        rule.formulae = args.value.map(v => typeof v === 'string' ? v : Number(v))
      } else if (args.operator === 'containsText') {
        rule.type = 'containsText'
        rule.operator = 'containsText'
        rule.text = String(args.value)
      } else if (args.value !== undefined) {
        rule.formulae = [typeof args.value === 'string' ? args.value : Number(args.value)]
      }
      worksheet.conditionalFormattings.addRules(args.range, [rule])
      return `已为 ${args.range} 添加条件格式（${args.operator}）`
    }
    case 'colorScale': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rule: any = {
        type: 'colorScale',
        priority: args.priority || (rules.length + 1),
        cfvo: [
          { type: 'min' },
          { type: 'max' }
        ],
        color: [
          { argb: 'FFF8696B' },
          { argb: 'FF63BE7B' }
        ]
      }
      worksheet.conditionalFormattings.addRules(args.range, [rule])
      return `已为 ${args.range} 添加色阶条件格式`
    }
    case 'dataBar': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rule: any = {
        type: 'dataBar',
        priority: args.priority || (rules.length + 1),
        minLength: 0,
        maxLength: 100,
        cfvo: [
          { type: 'min' },
          { type: 'max' }
        ],
        color: { argb: 'FF638EC6' }
      }
      worksheet.conditionalFormattings.addRules(args.range, [rule])
      return `已为 ${args.range} 添加数据条条件格式`
    }
    case 'duplicates': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rule: any = {
        type: 'expression',
        priority: args.priority || (rules.length + 1),
        formulae: [`COUNTIF(${args.range},${args.range.split(':')[0]})>1`],
        style: buildConditionalStyle(args.style || { background: 'FFC7CE', color: '9C0006' })
      }
      worksheet.conditionalFormattings.addRules(args.range, [rule])
      return `已为 ${args.range} 添加重复值高亮`
    }
    case 'topN': {
      const n = typeof args.value === 'number' ? args.value : 10
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rule: any = {
        type: 'top10',
        priority: args.priority || (rules.length + 1),
        rank: n,
        percent: false,
        bottom: false,
        style: buildConditionalStyle(args.style || { background: 'C6EFCE', color: '006100' })
      }
      worksheet.conditionalFormattings.addRules(args.range, [rule])
      return `已为 ${args.range} 添加 Top ${n} 条件格式`
    }
    default:
      return `条件格式失败：不支持的类型 "${args.type}"`
  }
}

function buildConditionalStyle(style?: Record<string, unknown>): Partial<import('exceljs').Style> {
  if (!style) return {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {}

  if (style.background) {
    result.fill = {
      type: 'pattern',
      pattern: 'solid',
      bgColor: { argb: `FF${String(style.background).replace(/^#/, '')}` }
    }
  }

  const fontProps: Record<string, unknown> = {}
  if (style.color) fontProps.color = { argb: `FF${String(style.color).replace(/^#/, '')}` }
  if (style.bold) fontProps.bold = true
  if (style.italic) fontProps.italic = true
  if (Object.keys(fontProps).length > 0) result.font = fontProps

  return result
}

/**
 * 解析引用并应用样式到对应单元格
 * 支持单个单元格 "A1"、范围 "A1:C3"、整列 "A:A"、整行 "1:1"
 */
function applyStyleToRef(
  worksheet: import('exceljs').Worksheet,
  ref: string,
  cellStyle: ExcelCellStyle
): number {
  let count = 0

  // 范围格式 "A1:C3"
  const rangeMatch = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i)
  if (rangeMatch) {
    const startCol = columnLetterToNumber(rangeMatch[1])
    const startRow = parseInt(rangeMatch[2])
    const endCol = columnLetterToNumber(rangeMatch[3])
    const endRow = parseInt(rangeMatch[4])
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        applyCellStyle(worksheet.getRow(r).getCell(c), cellStyle)
        count++
      }
    }
    return count
  }

  // 整列格式 "A:A" 或 "A:C"
  const colMatch = ref.match(/^([A-Z]+):([A-Z]+)$/i)
  if (colMatch) {
    const startCol = columnLetterToNumber(colMatch[1])
    const endCol = columnLetterToNumber(colMatch[2])
    const maxRow = Math.max(worksheet.rowCount, 1)
    for (let r = 1; r <= maxRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        applyCellStyle(worksheet.getRow(r).getCell(c), cellStyle)
        count++
      }
    }
    return count
  }

  // 整行格式 "1:1" 或 "1:3"
  const rowMatch = ref.match(/^(\d+):(\d+)$/)
  if (rowMatch) {
    const startRow = parseInt(rowMatch[1])
    const endRow = parseInt(rowMatch[2])
    const maxCol = Math.max(worksheet.columnCount, 1)
    for (let r = startRow; r <= endRow; r++) {
      for (let c = 1; c <= maxCol; c++) {
        applyCellStyle(worksheet.getRow(r).getCell(c), cellStyle)
        count++
      }
    }
    return count
  }

  // 单个单元格 "A1"
  applyCellStyle(worksheet.getCell(ref), cellStyle)
  return 1
}

/**
 * 计算引用覆盖的单元格数量（用于排序，大范围先应用）
 */
function calcRefCellCount(ref: string): number {
  const rangeMatch = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i)
  if (rangeMatch) {
    const cols = columnLetterToNumber(rangeMatch[3]) - columnLetterToNumber(rangeMatch[1]) + 1
    const rows = parseInt(rangeMatch[4]) - parseInt(rangeMatch[2]) + 1
    return cols * rows
  }
  // 整列/整行视为非常大的范围
  if (/^[A-Z]+:[A-Z]+$/i.test(ref)) return 100000
  if (/^\d+:\d+$/.test(ref)) return 100000
  // 单个单元格
  return 1
}

function columnLetterToNumber(letter: string): number {
  let result = 0
  for (let i = 0; i < letter.length; i++) {
    result = result * 26 + (letter.toUpperCase().charCodeAt(i) - 64)
  }
  return result
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    
    // 公式单元格：优先显示计算结果，如果没有结果则显示公式
    if ('formula' in obj) {
      if ('result' in obj && obj.result !== undefined && obj.result !== null) {
        // 有计算结果，显示结果
        return formatCellValue(obj.result)
      }
      // 没有计算结果，显示公式（带 = 前缀提示这是公式）
      return `=${obj.formula}`
    }
    
    // 普通对象的 result 属性（如错误值）
    if ('result' in obj) {
      return String(obj.result)
    }
    
    // 共享字符串（text 属性）
    if ('text' in obj) {
      return String(obj.text)
    }
    
    // 富文本
    if ('richText' in obj) {
      return ((obj.richText as { text: string }[]) || [])
        .map(rt => rt.text)
        .join('')
    }
    
    // 其他对象类型
    return JSON.stringify(value)
  }
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * 提取单元格的非默认样式，返回紧凑标注（如 `[bg:#4472C4 bold color:#FFF]`）
 * 仅在 include_styles=true 时调用
 */
function formatCellStyle(cell: import('exceljs').Cell): string {
  const parts: string[] = []

  // 背景色
  const fill = cell.fill
  if (fill && 'fgColor' in fill && fill.fgColor) {
    const argb = fill.fgColor.argb
    if (argb && argb !== 'FF000000' && argb !== '00000000') {
      // 去掉 alpha 前缀 FF，只保留 RGB
      const rgb = argb.length === 8 ? argb.slice(2) : argb
      parts.push(`bg:#${rgb}`)
    }
  }

  // 字体颜色
  const fontColor = cell.font?.color
  if (fontColor?.argb) {
    const argb = fontColor.argb
    if (argb !== 'FF000000') {
      const rgb = argb.length === 8 ? argb.slice(2) : argb
      parts.push(`color:#${rgb}`)
    }
  }

  // 加粗
  if (cell.font?.bold) parts.push('bold')

  // 斜体
  if (cell.font?.italic) parts.push('italic')

  // 字体名（非默认时）
  if (cell.font?.name && !['Calibri', '等线'].includes(cell.font.name)) {
    parts.push(`font:${cell.font.name}`)
  }

  // 字号（非默认 11 时）
  if (cell.font?.size && cell.font.size !== 11) {
    parts.push(`size:${cell.font.size}`)
  }

  // 对齐
  if (cell.alignment?.horizontal && cell.alignment.horizontal !== 'general') {
    parts.push(`align:${cell.alignment.horizontal}`)
  }

  // 数字格式
  if (cell.numFmt && cell.numFmt !== 'General') {
    parts.push(`fmt:${cell.numFmt}`)
  }

  if (parts.length === 0) return ''
  return `[${parts.join(' ')}]`
}

function truncateFromEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return '...' + text.slice(-maxLength + 3)
}

// ============ 样式管理工具 ============

function sanitizeStyleName(name: unknown): string {
  if (!name || typeof name !== 'string') return ''
  return name.trim().replace(/[^\w\u4e00-\u9fff\u3000-\u303f\s-]/g, '').slice(0, 50)
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>)
    } else {
      result[key] = source[key]
    }
  }
  return result
}

async function excelCreateStyle(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  loadCustomStyles()

  const name = sanitizeStyleName(args.name as string)
  if (!name) {
    return { success: false, output: '', error: t('excel.style_name_required') }
  }

  const configInput = args.config as Record<string, unknown> | undefined
  const baseStyle = args.base as string | undefined
  const setAsDefault = args.set_as_default === true

  try {
    // 构建基础配置
    let baseConfig: Record<string, unknown> = {}
    if (baseStyle) {
      const basePreset = PRESET_STYLES[baseStyle]
      if (basePreset) {
        baseConfig = JSON.parse(JSON.stringify(basePreset.config))
      } else if (customStyles.has(baseStyle)) {
        baseConfig = JSON.parse(JSON.stringify(customStyles.get(baseStyle)!.config))
      }
    }

    const mergedConfig = configInput
      ? deepMerge(baseConfig, configInput)
      : baseConfig

    const styleConfig: ExcelStyleConfig = {
      name,
      sourceType: 'custom',
      isDefault: setAsDefault,
      config: mergedConfig as ExcelStyleConfig['config']
    }

    if (setAsDefault) {
      defaultStyleName = name
    }

    customStyles.set(name, styleConfig)

    const docId = await saveStyleToKnowledge(styleConfig)
    if (!docId) {
      saveCustomStylesToFile()
    }

    const output = t('excel.style_created', { name }) +
      (setAsDefault ? '\n' + t('excel.style_set_as_default', { name }) : '')

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_create_style',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('excel.style_create_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

async function excelEditStyle(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  loadCustomStyles()

  const name = args.name as string
  const configPatch = args.config as Record<string, unknown> | undefined
  const newName = args.new_name as string | undefined

  if (!name) {
    return { success: false, output: '', error: t('excel.style_name_required') }
  }

  try {
    let existing: ExcelStyleConfig | undefined = customStyles.get(name)
    let isPreset = false

    if (!existing) {
      if (PRESET_STYLES[name]) {
        isPreset = true
        existing = JSON.parse(JSON.stringify(PRESET_STYLES[name]))
        existing!.sourceType = 'custom'
      } else {
        return { success: false, output: '', error: t('excel.style_not_found', { name }) }
      }
    }

    if (configPatch) {
      existing!.config = deepMerge(
        existing!.config as unknown as Record<string, unknown>,
        configPatch
      ) as ExcelStyleConfig['config']
    }

    const finalName = newName || (isPreset ? `${name}-custom` : name)
    existing!.name = finalName

    if (newName && newName !== name && !isPreset) {
      customStyles.delete(name)
      const oldDocId = styleDocIds.get(name)
      if (oldDocId) {
        try {
          const knowledgeService = getKnowledgeService()
          if (knowledgeService && knowledgeService.isEnabled()) {
            await knowledgeService.removeDocument(oldDocId)
          }
        } catch (e) { log.warn('Failed to remove old style doc:', e) }
        styleDocIds.delete(name)
      }
    }

    customStyles.set(finalName, existing!)

    const docId = await saveStyleToKnowledge(existing!)
    if (!docId) {
      saveCustomStylesToFile()
    }

    const output = isPreset
      ? t('excel.style_copied_and_edited', { from: name, to: finalName })
      : t('excel.style_edited', { name: finalName })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_edit_style',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return { success: false, output: '', error: errorMsg }
  }
}

async function excelDeleteStyle(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  loadCustomStyles()

  const name = args.name as string
  if (!name) {
    return { success: false, output: '', error: t('excel.style_name_required') }
  }

  if (PRESET_STYLES[name] && !customStyles.has(name)) {
    return { success: false, output: '', error: t('excel.style_preset_cannot_delete', { name }) }
  }

  if (!customStyles.has(name)) {
    return { success: false, output: '', error: t('excel.style_not_found', { name }) }
  }

  try {
    customStyles.delete(name)

    const docId = styleDocIds.get(name)
    if (docId) {
      try {
        const knowledgeService = getKnowledgeService()
        if (knowledgeService && knowledgeService.isEnabled()) {
          await knowledgeService.removeDocument(docId)
        }
      } catch { /* ignore */ }
      styleDocIds.delete(name)
    }

    if (defaultStyleName === name) {
      defaultStyleName = null
    }

    saveCustomStylesToFile()

    const output = t('excel.style_deleted', { name })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'excel_delete_style',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return { success: false, output: '', error: errorMsg }
  }
}

async function excelListStyles(
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  loadCustomStyles()

  const lines: string[] = ['## Excel 预设样式\n']

  for (const [key, style] of Object.entries(PRESET_STYLES)) {
    const isDefault = defaultStyleName === key
    const hBg = style.config.header?.background ? ` 表头#${style.config.header.background}` : ''
    const alt = style.config.data?.alternatingColors ? ' 交替行色' : ''
    const freeze = style.config.freezeHeader ? ' 冻结表头' : ''
    lines.push(`- **${key}**：${style.name}${hBg}${alt}${freeze}${isDefault ? ' ⭐默认' : ''}`)
  }

  if (customStyles.size > 0) {
    lines.push('\n## 自定义样式\n')
    for (const [name, style] of customStyles.entries()) {
      const isDefault = defaultStyleName === name
      lines.push(`- **${name}**${isDefault ? ' ⭐默认' : ''}`)
    }
  }

  const output = lines.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'excel_list_styles',
    toolResult: output
  })

  return { success: true, output }
}

async function excelSetDefaultStyle(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  loadCustomStyles()

  const name = args.name as string
  if (!name) {
    return { success: false, output: '', error: t('excel.style_name_required') }
  }

  if (!PRESET_STYLES[name] && !customStyles.has(name)) {
    return { success: false, output: '', error: t('excel.style_not_found', { name }) }
  }

  defaultStyleName = name

  const knowledgeService = getKnowledgeService()
  if (knowledgeService && knowledgeService.isEnabled()) {
    await saveDefaultStyleSetting()
  } else {
    saveCustomStylesToFile()
  }

  const output = t('excel.style_set_as_default', { name })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'excel_set_default_style',
    toolResult: output
  })

  return { success: true, output }
}

