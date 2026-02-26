/**
 * Excel 样式系统
 * 提供预设样式模板和样式应用功能
 */

import type { Worksheet, Cell, Style as ExcelJSStyle, Fill, Font, Border, Borders, Alignment } from 'exceljs'

/**
 * 边框配置
 */
export interface ExcelBorderConfig {
  style?: 'thin' | 'medium' | 'thick' | 'none'
  color?: string
}

/**
 * 单元格样式（用于 excel_modify 的 styles 参数）
 */
export interface ExcelCellStyle {
  font?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  background?: string
  align?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  wrapText?: boolean
  numberFormat?: string
  border?: ExcelBorderConfig | 'thin' | 'medium' | 'thick' | 'none' | 'all'
}

/**
 * 主题配置接口
 */
export interface ExcelStyleConfig {
  name: string
  sourceType: 'preset' | 'custom'
  isDefault?: boolean
  config: {
    header?: {
      font?: string
      fontSize?: number
      bold?: boolean
      color?: string
      background?: string
      align?: 'left' | 'center' | 'right'
      border?: ExcelBorderConfig
    }
    data?: {
      font?: string
      fontSize?: number
      color?: string
      align?: 'left' | 'center' | 'right'
      border?: ExcelBorderConfig
      /** [奇数行背景, 偶数行背景] */
      alternatingColors?: [string, string]
    }
    /** 自动调整列宽（默认 true） */
    autoWidth?: boolean
    /** 冻结表头行（默认 false） */
    freezeHeader?: boolean
  }
}

/**
 * 预设样式模板
 */
export const PRESET_STYLES: Record<string, ExcelStyleConfig> = {
  simple: {
    name: '简洁',
    sourceType: 'preset',
    config: {
      header: {
        bold: true,
        color: 'FFFFFF',
        background: '4472C4',
        align: 'center',
        border: { style: 'thin', color: '4472C4' }
      },
      data: {
        border: { style: 'thin', color: 'D9D9D9' }
      },
      autoWidth: true,
      freezeHeader: true
    }
  },
  business: {
    name: '商务蓝',
    sourceType: 'preset',
    config: {
      header: {
        font: '微软雅黑',
        bold: true,
        color: 'FFFFFF',
        background: '2B579A',
        align: 'center',
        border: { style: 'thin', color: '2B579A' }
      },
      data: {
        font: '微软雅黑',
        border: { style: 'thin', color: 'B4C6E7' },
        alternatingColors: ['FFFFFF', 'D6E4F0']
      },
      autoWidth: true,
      freezeHeader: true
    }
  },
  dark: {
    name: '深色',
    sourceType: 'preset',
    config: {
      header: {
        bold: true,
        color: 'FFFFFF',
        background: '333333',
        align: 'center',
        border: { style: 'thin', color: '333333' }
      },
      data: {
        border: { style: 'thin', color: 'CCCCCC' },
        alternatingColors: ['FFFFFF', 'F2F2F2']
      },
      autoWidth: true,
      freezeHeader: true
    }
  },
  colorful: {
    name: '彩色',
    sourceType: 'preset',
    config: {
      header: {
        bold: true,
        color: 'FFFFFF',
        background: '70AD47',
        align: 'center',
        border: { style: 'thin', color: '70AD47' }
      },
      data: {
        border: { style: 'thin', color: 'C5E0B4' },
        alternatingColors: ['FFFFFF', 'E2EFDA']
      },
      autoWidth: true,
      freezeHeader: true
    }
  },
  minimal: {
    name: '极简',
    sourceType: 'preset',
    config: {
      header: {
        bold: true,
        background: 'F8F8F8',
        align: 'center',
        border: { style: 'thin', color: 'E0E0E0' }
      },
      data: {
        border: { style: 'thin', color: 'E0E0E0' }
      },
      autoWidth: true
    }
  },
  finance: {
    name: '财务',
    sourceType: 'preset',
    config: {
      header: {
        bold: true,
        color: 'FFFFFF',
        background: '1F3864',
        align: 'center',
        border: { style: 'medium', color: '1F3864' }
      },
      data: {
        border: { style: 'thin', color: '8EAADB' },
        alternatingColors: ['FFFFFF', 'D9E2F3']
      },
      autoWidth: true,
      freezeHeader: true
    }
  }
}

/**
 * 获取样式配置
 */
export function getStyleConfig(styleName?: string): ExcelStyleConfig {
  if (!styleName) return PRESET_STYLES.simple
  return PRESET_STYLES[styleName] || PRESET_STYLES.simple
}

// ============ 样式应用 ============

function toArgb(hex: string): string {
  hex = hex.replace(/^#/, '')
  if (hex.length === 6) return `FF${hex.toUpperCase()}`
  if (hex.length === 8) return hex.toUpperCase()
  return `FF${hex.toUpperCase()}`
}

function buildFill(background: string): Fill {
  return {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: toArgb(background) }
  }
}

function buildFont(opts: {
  font?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
}): Partial<Font> {
  const f: Partial<Font> = {}
  if (opts.font) f.name = opts.font
  if (opts.fontSize) f.size = opts.fontSize
  if (opts.bold !== undefined) f.bold = opts.bold
  if (opts.italic !== undefined) f.italic = opts.italic
  if (opts.underline !== undefined) f.underline = opts.underline
  if (opts.color) f.color = { argb: toArgb(opts.color) }
  return f
}

function buildBorderSide(config: ExcelBorderConfig): Partial<Border> {
  const result: Partial<Border> = {}
  const style = config.style === 'none' ? undefined : (config.style || 'thin')
  if (style) result.style = style
  if (config.color) result.color = { argb: toArgb(config.color) }
  return result
}

function buildBorders(config: ExcelBorderConfig): Partial<Borders> {
  if (config.style === 'none') return {}
  const side = buildBorderSide(config)
  return { top: side, bottom: side, left: side, right: side }
}

function buildAlignment(opts: {
  align?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  wrapText?: boolean
}): Partial<Alignment> {
  const a: Partial<Alignment> = { vertical: 'middle' }
  if (opts.align) a.horizontal = opts.align
  if (opts.verticalAlign) a.vertical = opts.verticalAlign
  if (opts.wrapText) a.wrapText = opts.wrapText
  return a
}

/**
 * 将样式配置应用到表头行
 */
export function applyHeaderStyle(cell: Cell, style: ExcelStyleConfig): void {
  const h = style.config.header
  if (!h) return

  const fontOpts: Parameters<typeof buildFont>[0] = {}
  if (h.font) fontOpts.font = h.font
  if (h.fontSize) fontOpts.fontSize = h.fontSize
  if (h.bold !== undefined) fontOpts.bold = h.bold
  if (h.color) fontOpts.color = h.color

  if (Object.keys(fontOpts).length > 0) cell.font = buildFont(fontOpts) as Font
  if (h.background) cell.fill = buildFill(h.background)
  cell.alignment = buildAlignment({ align: h.align || 'center' })
  if (h.border) cell.border = buildBorders(h.border) as Borders
}

/**
 * 将样式配置应用到数据行
 */
export function applyDataStyle(cell: Cell, style: ExcelStyleConfig, rowIndex: number): void {
  const d = style.config.data
  if (!d) return

  const fontOpts: Parameters<typeof buildFont>[0] = {}
  if (d.font) fontOpts.font = d.font
  if (d.fontSize) fontOpts.fontSize = d.fontSize
  if (d.color) fontOpts.color = d.color

  if (Object.keys(fontOpts).length > 0) cell.font = buildFont(fontOpts) as Font
  if (d.align) cell.alignment = buildAlignment({ align: d.align })
  else cell.alignment = { vertical: 'middle' }

  if (d.alternatingColors) {
    const colorIdx = rowIndex % 2
    cell.fill = buildFill(d.alternatingColors[colorIdx])
  }

  if (d.border) cell.border = buildBorders(d.border) as Borders
}

/**
 * 冻结表头行
 */
export function applyFreezeHeader(worksheet: Worksheet): void {
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
}

/**
 * 自动调整列宽（基于内容长度）
 */
export function autoFitColumns(worksheet: Worksheet): void {
  worksheet.columns.forEach((column) => {
    let maxLen = 8
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      const visualLen = [...String(cell.value ?? '')].reduce((len, ch) => {
        return len + (ch.charCodeAt(0) > 0x7F ? 2 : 1)
      }, 0)
      maxLen = Math.max(maxLen, visualLen)
    })
    column.width = Math.min(maxLen + 3, 50)
  })
}

/**
 * 将 ExcelCellStyle 应用到单元格
 */
export function applyCellStyle(cell: Cell, style: ExcelCellStyle): void {
  const fontOpts: Parameters<typeof buildFont>[0] = {}
  if (style.font) fontOpts.font = style.font
  if (style.fontSize) fontOpts.fontSize = style.fontSize
  if (style.bold !== undefined) fontOpts.bold = style.bold
  if (style.italic !== undefined) fontOpts.italic = style.italic
  if (style.underline !== undefined) fontOpts.underline = style.underline
  if (style.color) fontOpts.color = style.color

  if (Object.keys(fontOpts).length > 0) {
    cell.font = { ...cell.font, ...buildFont(fontOpts) } as Font
  }

  if (style.background) {
    cell.fill = buildFill(style.background)
  }

  if (style.align || style.verticalAlign || style.wrapText) {
    cell.alignment = {
      ...cell.alignment,
      ...buildAlignment({
        align: style.align,
        verticalAlign: style.verticalAlign,
        wrapText: style.wrapText
      })
    }
  }

  if (style.numberFormat) {
    cell.numFmt = style.numberFormat
  }

  if (style.border) {
    if (typeof style.border === 'string') {
      if (style.border === 'none') {
        cell.border = {}
      } else if (style.border === 'all') {
        cell.border = buildBorders({ style: 'thin' }) as Borders
      } else {
        cell.border = buildBorders({ style: style.border }) as Borders
      }
    } else {
      cell.border = buildBorders(style.border) as Borders
    }
  }
}
