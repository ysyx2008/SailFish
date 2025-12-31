/**
 * Excel 技能执行器
 */

import * as fs from 'fs'
import * as path from 'path'
import type { ToolResult, AgentConfig, RiskLevel } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t } from '../../i18n'
import { getTerminalStateService } from '../../../terminal-state.service'
import {
  isSessionOpen,
  getSession,
  createSession,
  markDirty,
  closeSession,
  getSessionsSummary
} from './session'

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

  // 应用限制
  const maxRows = 500
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
      cells.push(formatCellValue(cell.value))
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

  // 修改单元格
  if (cells && sheetName) {
    let worksheet = workbook.getWorksheet(sheetName)
    if (!worksheet) {
      // 自动创建不存在的 Sheet
      worksheet = workbook.addWorksheet(sheetName)
      results.push(t('excel.sheet_added', { name: sheetName }))
    }

    let modCount = 0
    for (const [cellRef, value] of Object.entries(cells)) {
      const cell = worksheet.getCell(cellRef)
      
      // 支持多种格式：
      // 1. 对象格式 { formula: "SUM(A1:A10)" } - 明确指定公式
      // 2. 对象格式 { text: "=这是文本" } - 明确指定文本
      // 3. 字符串 "=SUM(...)" - 自动识别公式
      // 4. 其他值 - 直接写入
      
      if (typeof value === 'object' && value !== null) {
        const obj = value as Record<string, unknown>
        if ('formula' in obj) {
          // 明确的公式格式，直接使用 exceljs 原生格式
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cell.value = { formula: String(obj.formula), result: obj.result as any }
        } else if ('text' in obj) {
          // 明确的文本格式
          cell.value = String(obj.text)
        } else {
          // 其他对象格式，直接写入
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cell.value = value as any
        }
      } else if (typeof value === 'string' && value.startsWith('=')) {
        // 字符串公式语法糖：=SUM(...) 自动转为公式
        cell.value = { formula: value.slice(1) }
      } else {
        // 其他值直接写入
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cell.value = value as any
      }
      modCount++
    }
    results.push(t('excel.cells_modified', { count: modCount, sheet: sheetName }))
    markDirty(filePath)
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
    // 创建备份（带时间戳）
    if (fs.existsSync(filePath)) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const ext = path.extname(filePath)
      const baseName = filePath.slice(0, -ext.length)
      const backupPath = `${baseName}_${timestamp}${ext}.bak`
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

// ============ 辅助函数 ============

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

function truncateFromEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return '...' + text.slice(-maxLength + 3)
}

