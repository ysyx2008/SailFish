/**
 * Excel 工作簿 → 产出物面板预览 HTML（只读，含全部 sheet 供切表）
 */
import { formatCellValue } from './cell-value'

export interface PreviewHighlights {
  modified?: Set<string>
  deleting?: Set<string>
  /** 删除行后上移的单元格 */
  shifted?: Set<string>
  /** 删除列后左移的单元格 */
  shiftedCol?: Set<string>
}

interface PreviewCell {
  value: unknown
  font?: unknown
  fill?: unknown
  alignment?: unknown
  numFmt?: unknown
  type?: unknown
  formula?: unknown
  style?: { quotePrefix?: unknown }
}

interface PreviewRow {
  eachCell: (
    options: { includeEmpty: boolean },
    cb: (cell: PreviewCell, colNum: number) => void
  ) => void
}

export interface PreviewMerge {
  top: number
  left: number
  bottom: number
  right: number
}

export interface PreviewWorksheet {
  name: string
  rowCount: number
  columnCount: number
  /** 合并区（1-based）。缺省时从 ExcelJS 工作表上的合并记录读取。 */
  merges?: readonly PreviewMerge[] | readonly string[]
  eachRow: (
    options: { includeEmpty: boolean },
    cb: (row: PreviewRow, rowNum: number) => void
  ) => void
}

/** 普通表整张画；超过这些上限才截，避免 DOM 卡死。 */
const PREVIEW_MAX_CELLS = 80_000
const PREVIEW_MAX_ROWS = 5_000
const PREVIEW_MAX_COLS = 150

/** 预览画多少行/列：先按表的实际大小，再套卡顿上限。 */
export function previewTableExtent(rowCount: number, colCount: number): { rows: number; cols: number } {
  const rows = Math.min(Math.max(0, rowCount), PREVIEW_MAX_ROWS)
  const cols = Math.min(Math.max(0, colCount), PREVIEW_MAX_COLS)
  if (rows === 0 || cols === 0) return { rows, cols }
  if (rows * cols <= PREVIEW_MAX_CELLS) return { rows, cols }
  return { rows: Math.min(rows, Math.max(1, Math.floor(PREVIEW_MAX_CELLS / cols))), cols }
}

export function escapePreviewHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function numberToColumnLetter(num: number): string {
  let result = ''
  let n = num
  while (n > 0) {
    n--
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

function isNumericCellValue(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (typeof value === 'object' && value !== null && 'result' in value) {
    return typeof (value as { result: unknown }).result === 'number'
  }
  return false
}

function letterToColumnNumber(letter: string): number {
  let n = 0
  for (let i = 0; i < letter.length; i++) {
    const code = letter.charCodeAt(i)
    const digit = code >= 97 ? code - 96 : code - 64
    if (digit < 1 || digit > 26) return 0
    n = n * 26 + digit
  }
  return n
}

function isMergeRect(value: unknown): value is PreviewMerge {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return (
    typeof o.top === 'number' &&
    typeof o.left === 'number' &&
    typeof o.bottom === 'number' &&
    typeof o.right === 'number'
  )
}

function parseA1MergeRange(range: string): PreviewMerge | null {
  const bang = range.lastIndexOf('!')
  const bare = bang >= 0 ? range.slice(bang + 1) : range
  const m = /^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/.exec(bare)
  if (!m) return null
  const left = letterToColumnNumber(m[1])
  const right = letterToColumnNumber(m[3])
  const top = Number(m[2])
  const bottom = Number(m[4])
  if (!left || !right || !top || !bottom) return null
  return {
    top: Math.min(top, bottom),
    left: Math.min(left, right),
    bottom: Math.max(top, bottom),
    right: Math.max(left, right)
  }
}

function addMerge(out: PreviewMerge[], seen: Set<string>, rect: PreviewMerge): void {
  const key = `${rect.top},${rect.left},${rect.bottom},${rect.right}`
  if (seen.has(key)) return
  seen.add(key)
  out.push(rect)
}

/**
 * 合并区来源：测试桩的 merges，或 ExcelJS 工作表上的 _merges（避免走 model getter 扫全表）。
 * _merges 的 Range 坐标是 1-based；ExcelJS 大版本升级时需核对。
 */
function collectMerges(sheet: PreviewWorksheet): PreviewMerge[] {
  const out: PreviewMerge[] = []
  const seen = new Set<string>()

  if (sheet.merges) {
    for (const item of sheet.merges) {
      if (typeof item === 'string') {
        const rect = parseA1MergeRange(item)
        if (rect) addMerge(out, seen, rect)
      } else if (isMergeRect(item)) {
        addMerge(out, seen, item)
      }
    }
  }

  const excelMerges = (sheet as { _merges?: Record<string, unknown> })._merges
  if (excelMerges && typeof excelMerges === 'object') {
    for (const item of Object.values(excelMerges)) {
      if (isMergeRect(item)) addMerge(out, seen, item)
    }
  }

  return out
}

function findMergeAt(merges: PreviewMerge[], row: number, col: number): PreviewMerge | undefined {
  return merges.find(m => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right)
}

/**
 * Excel 格子上的 theme 编号是「背景1 / 文字1 / 背景2 / 文字2 / 强调色」，
 * 不是 clrScheme 里 dk1、lt1 那个顺序。theme=1 是默认黑字。
 */
const OFFICE_THEME_RGB = [
  'FFFFFF',
  '000000',
  'E7E6E6',
  '44546A',
  '4472C4',
  'ED7D31',
  'A5A5A5',
  'FFC000',
  '5B9BD5',
  '70AD47'
]

function applyTint(hex: string, tint: number): string {
  const channel = (c: number): number => {
    if (tint < 0) return Math.round(c * (1 + tint))
    return Math.round(c + (255 - c) * tint)
  }
  const r = channel(parseInt(hex.slice(0, 2), 16))
  const g = channel(parseInt(hex.slice(2, 4), 16))
  const b = channel(parseInt(hex.slice(4, 6), 16))
  return [r, g, b].map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')
}

function resolveColor(color: unknown): string | null {
  if (!color || typeof color !== 'object') return null
  const c = color as { argb?: unknown; theme?: unknown; tint?: unknown }
  let hex: string | null = null
  let alpha = 255

  if (typeof c.argb === 'string') {
    const raw = c.argb.replace(/^#/, '')
    if (raw.length === 8 && /^[0-9A-Fa-f]{8}$/.test(raw)) {
      alpha = parseInt(raw.slice(0, 2), 16)
      hex = raw.slice(2)
    } else if (raw.length === 6 && /^[0-9A-Fa-f]{6}$/.test(raw)) {
      hex = raw
    }
  } else if (typeof c.theme === 'number' && c.theme >= 0 && c.theme < OFFICE_THEME_RGB.length) {
    hex = OFFICE_THEME_RGB[c.theme]
  }
  if (!hex || alpha === 0) return null
  if (typeof c.tint === 'number' && c.tint !== 0) hex = applyTint(hex, c.tint)
  hex = hex.toUpperCase()
  if (alpha < 255) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${Math.round((alpha / 255) * 1000) / 1000})`
  }
  return `#${hex}`
}

function safeFontFamily(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const cleaned = name.replace(/["';<>\\]/g, '').trim()
  return cleaned ? `'${cleaned}'` : null
}

function fontFromCell(cell: PreviewCell): Record<string, unknown> | null {
  if (cell.font && typeof cell.font === 'object') return cell.font as Record<string, unknown>
  const value = cell.value
  if (value && typeof value === 'object' && 'richText' in value) {
    const first = (value as { richText?: { font?: unknown }[] }).richText?.[0]?.font
    if (first && typeof first === 'object') return first as Record<string, unknown>
  }
  return null
}

function fillColorFromCell(cell: PreviewCell): string | null {
  const fill = cell.fill
  if (!fill || typeof fill !== 'object') return null
  const f = fill as { type?: unknown; pattern?: unknown; fgColor?: unknown; bgColor?: unknown }
  if (f.pattern === 'none') return null
  return resolveColor(f.fgColor) ?? resolveColor(f.bgColor)
}

/** 把格子上的字体、颜色、底色、对齐转成内联 CSS。只输出我们自己拼的值，不回写用户原文。 */
export function previewCellCss(cell: PreviewCell): string {
  const parts: string[] = []
  const font = fontFromCell(cell)
  if (font) {
    const family = safeFontFamily(font.name)
    if (family) parts.push(`font-family:${family}`)
    if (typeof font.size === 'number' && font.size > 0 && font.size <= 200) {
      parts.push(`font-size:${font.size}pt`)
    }
    if (font.bold) parts.push('font-weight:700')
    if (font.italic) parts.push('font-style:italic')
    if (font.underline) parts.push('text-decoration:underline')
    const color = resolveColor(font.color)
    if (color) parts.push(`color:${color}`)
  }

  const bg = fillColorFromCell(cell)
  if (bg) parts.push(`background-color:${bg}`)

  const alignment = cell.alignment
  if (alignment && typeof alignment === 'object') {
    const a = alignment as { horizontal?: unknown; vertical?: unknown; wrapText?: unknown }
    if (a.horizontal === 'left' || a.horizontal === 'center' || a.horizontal === 'right') {
      parts.push(`text-align:${a.horizontal}`)
    } else if (a.horizontal === 'justify' || a.horizontal === 'distributed') {
      parts.push('text-align:justify')
    } else if (a.horizontal === 'centerContinuous') {
      parts.push('text-align:center')
    }
    if (a.vertical === 'top' || a.vertical === 'middle' || a.vertical === 'bottom') {
      parts.push(`vertical-align:${a.vertical}`)
    }
    if (a.wrapText) {
      parts.push('white-space:pre-wrap')
    }
  }

  // 预览格子默认 20px 高，约等于 11pt；更大字号或换行时放开，避免裁切
  const fontSize = typeof font?.size === 'number' ? font.size : 0
  const wrap = alignment && typeof alignment === 'object' && (alignment as { wrapText?: unknown }).wrapText
  if (fontSize > 11 || wrap) parts.push('height:auto')

  return parts.join(';')
}

function isExcelTextNumberFormat(numFmt: unknown): boolean {
  return numFmt === '@' || (typeof numFmt === 'string' && numFmt.toLowerCase() === 'text')
}

function formulaAsText(formula: unknown): string {
  const f = String(formula)
  return f.startsWith('=') ? f : `=${f}`
}

/** 预览给人看：跟 Excel 打开一样。文字公式 / 文本格式的公式显示原文，正在算的公式显示值。 */
export function formatPreviewCellValue(cell: PreviewCell): string {
  const value = cell.value
  const showFormulaText = isExcelTextNumberFormat(cell.numFmt) || !!cell.style?.quotePrefix

  if (value && typeof value === 'object' && 'formula' in value) {
    const formula = (value as { formula?: unknown }).formula
    if (showFormulaText && formula != null && String(formula) !== '') {
      return formulaAsText(formula)
    }
  } else if (showFormulaText && cell.formula != null && String(cell.formula) !== '') {
    return formulaAsText(cell.formula)
  }

  if (typeof value === 'string') return value
  return formatCellValue(value)
}

function highlightClass(key: string, highlights?: PreviewHighlights): string | undefined {
  if (!highlights) return undefined
  if (highlights.deleting?.has(key)) return 'deleting'
  if (highlights.shifted?.has(key)) return 'shifted'
  if (highlights.shiftedCol?.has(key)) return 'shifted-col'
  if (highlights.modified?.has(key)) return 'modified'
  return undefined
}

function renderEmptySheet(): string {
  return '<div class="sheet-empty">这张表是空的</div>'
}

type PreviewCellData = { val: string; isNum: boolean; css: string }

function sheetHasVisibleContent(
  dataRows: Map<number, Map<number, PreviewCellData>>,
  merges: PreviewMerge[]
): boolean {
  if (merges.length > 0) return true
  for (const row of dataRows.values()) {
    for (const cell of row.values()) {
      if (cell.val !== '' || cell.css) return true
    }
  }
  return false
}

function renderSheetTable(
  sheet: PreviewWorksheet,
  highlights?: PreviewHighlights
): string {
  const merges = collectMerges(sheet)
  const mergeMaxRow = merges.reduce((acc, m) => Math.max(acc, m.bottom), 0)
  const mergeMaxCol = merges.reduce((acc, m) => Math.max(acc, m.right), 0)

  if (sheet.rowCount === 0 && mergeMaxRow === 0) {
    return renderEmptySheet()
  }

  const extent = previewTableExtent(
    Math.max(sheet.rowCount, mergeMaxRow),
    Math.max(sheet.columnCount, mergeMaxCol)
  )
  const maxRows = extent.rows
  const maxCols = extent.cols

  // 只读遍历已有数据，避免 getRow/getCell 创建空对象污染 workbook
  const dataRows: Map<number, Map<number, PreviewCellData>> = new Map()
  let actualMaxCol = 0

  sheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum > maxRows) return
    const cellMap = new Map<number, PreviewCellData>()
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      if (colNum > maxCols) return
      const css = previewCellCss(cell)
      const val = formatPreviewCellValue(cell)
      cellMap.set(colNum, {
        val,
        isNum: !val.startsWith('=') && isNumericCellValue(cell.value),
        css
      })
      if (colNum > actualMaxCol) actualMaxCol = colNum
    })
    dataRows.set(rowNum, cellMap)
  })

  for (const merge of merges) {
    if (merge.top <= maxRows && merge.left <= maxCols) {
      actualMaxCol = Math.max(actualMaxCol, Math.min(merge.right, maxCols))
    }
  }

  if (!sheetHasVisibleContent(dataRows, merges)) {
    return renderEmptySheet()
  }

  const colCount = Math.min(actualMaxCol, maxCols) || 1
  const htmlRows: string[] = []

  const colHeaders = ['<th class="corner"></th>']
  for (let c = 1; c <= colCount; c++) {
    colHeaders.push(`<th>${numberToColumnLetter(c)}</th>`)
  }
  htmlRows.push(`<tr>${colHeaders.join('')}</tr>`)

  for (let r = 1; r <= maxRows; r++) {
    const cellMap = dataRows.get(r)
    const cells = [`<td class="row-header">${r}</td>`]
    for (let c = 1; c <= colCount; c++) {
      const merge = findMergeAt(merges, r, c)
      if (merge && (r !== merge.top || c !== merge.left)) continue

      const data = cellMap?.get(c)
      const key = `${r},${c}`
      const classes: string[] = []
      if (data?.isNum) classes.push('num')
      const hl = highlightClass(key, highlights)
      if (hl) classes.push(hl)

      const colspan = merge ? Math.max(1, Math.min(merge.right, colCount) - merge.left + 1) : 1
      const rowspan = merge ? Math.max(1, Math.min(merge.bottom, maxRows) - merge.top + 1) : 1
      if (colspan > 1 || rowspan > 1) classes.push('merged')

      const classAttr = classes.length > 0 ? ` class="${classes.join(' ')}"` : ''
      const spanAttr = `${colspan > 1 ? ` colspan="${colspan}"` : ''}${rowspan > 1 ? ` rowspan="${rowspan}"` : ''}`
      const styleAttr = data?.css ? ` style="${data.css}"` : ''
      cells.push(`<td${classAttr}${spanAttr}${styleAttr} data-r="${r}" data-c="${c}">${data ? escapePreviewHtml(data.val) : ''}</td>`)
    }
    htmlRows.push(`<tr>${cells.join('')}</tr>`)
  }

  const parts = [`<table>${htmlRows.join('')}</table>`]
  const trunc: string[] = []
  if (sheet.rowCount > maxRows) trunc.push(`${maxRows}/${sheet.rowCount} 行`)
  if (sheet.columnCount > maxCols) trunc.push(`${maxCols}/${sheet.columnCount} 列`)
  if (trunc.length > 0) {
    parts.push(`<div class="sheet-truncated">只预览了 ${trunc.join('、')}，后面没有画出来</div>`)
  }
  return parts.join('\n')
}

/**
 * 生成含全部工作表的只读预览 HTML。
 * 多表时底部带可点标签；默认展示 activeSheet（缺省为第一张）。
 */
export function renderExcelWorkbookPreviewHtml(
  worksheets: readonly PreviewWorksheet[],
  options?: { activeSheet?: string; highlights?: PreviewHighlights }
): string {
  const sheets = worksheets
  if (sheets.length === 0) return '<div class="sheet-empty">这份工作簿是空的</div>'

  const activeName = options?.activeSheet && sheets.some(ws => ws.name === options.activeSheet)
    ? options.activeSheet
    : sheets[0].name

  const parts: string[] = []
  for (const ws of sheets) {
    const isActive = ws.name === activeName
    const hiddenAttr = isActive ? '' : ' hidden'
    const sheetHighlights = isActive ? options?.highlights : undefined
    parts.push(
      `<div class="sheet-pane" data-sheet="${escapePreviewHtml(ws.name)}"${hiddenAttr}>`
    )
    parts.push(renderSheetTable(ws, sheetHighlights))
    parts.push('</div>')
  }

  if (sheets.length > 1) {
    const tabs = sheets.map(ws => {
      const isActive = ws.name === activeName
      return `<span class="sheet-tab${isActive ? ' active' : ''}" data-sheet="${escapePreviewHtml(ws.name)}">${escapePreviewHtml(ws.name)}</span>`
    }).join('')
    parts.push(`<div class="sheet-tabs">${tabs}</div>`)
  }

  return parts.join('\n')
}
