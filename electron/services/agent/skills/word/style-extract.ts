/**
 * 从 .docx 样板文件提取 WordStyleConfig（解析 styles.xml + document.xml 节属性）
 * 供 word_create_style(from_template=...) 使用
 */

import JSZip from 'jszip'
import * as fs from 'fs'
import type { WordStyleConfig } from './styles'
import { PRESET_STYLES } from './styles'

/** OOXML 半磅 → 磅 */
function halfPointsToPt(half: string | undefined): number | undefined {
  if (!half) return undefined
  const n = parseInt(half, 10)
  return Number.isFinite(n) ? n / 2 : undefined
}

/** twips → 磅（固定行距） */
function twipsToPt(twips: string | undefined): number | undefined {
  if (!twips) return undefined
  const n = parseInt(twips, 10)
  return Number.isFinite(n) ? n / 20 : undefined
}

const ALIGN_MAP: Record<string, 'left' | 'center' | 'right' | 'justify'> = {
  left: 'left',
  center: 'center',
  right: 'right',
  both: 'justify',
  justify: 'justify',
  distribute: 'justify'
}

interface RawParagraphStyle {
  styleId: string
  name: string
  basedOnId?: string
  blockXml: string
}

interface ResolvedRunStyle {
  font?: string
  fontAscii?: string
  size?: number
  bold?: boolean
}

interface ResolvedParagraphStyle extends ResolvedRunStyle {
  align?: 'left' | 'center' | 'right' | 'justify'
  lineSpacingFixed?: number
  lineSpacing?: number
  firstLineIndent?: boolean
  firstLineIndentChars?: number
  outlineLevel?: number
}

function extractAttr(tag: string, attr: string): string | undefined {
  const re = new RegExp(`${attr}="([^"]*)"`)
  return re.exec(tag)?.[1]
}

function extractBlock(xml: string, tag: 'w:rPr' | 'w:pPr'): string {
  const open = `<${tag}`
  const start = xml.indexOf(open)
  if (start < 0) return ''
  const close = `</${tag}>`
  const end = xml.indexOf(close, start)
  if (end < 0) {
    const self = new RegExp(`<${tag}[^>]*/>`).exec(xml.slice(start))
    return self ? self[0] : ''
  }
  return xml.slice(start, end + close.length)
}

function parseRunStyle(rPrXml: string): ResolvedRunStyle {
  const result: ResolvedRunStyle = {}
  const fontsTag = rPrXml.match(/<w:rFonts[^>]*>/)?.[0] ?? rPrXml
  const eastAsia = extractAttr(fontsTag, 'w:eastAsia')
  const ascii = extractAttr(fontsTag, 'w:ascii') || extractAttr(fontsTag, 'w:hAnsi')
  if (eastAsia && !eastAsia.includes('Theme') && eastAsia !== 'zh-CN') {
    result.font = eastAsia
  }
  if (ascii && !ascii.includes('Theme')) {
    result.fontAscii = ascii
  }
  const szTag = rPrXml.match(/<w:sz[^>]*\/?>/)?.[0] ?? ''
  const szCsTag = rPrXml.match(/<w:szCs[^>]*\/?>/)?.[0] ?? ''
  const sz = extractAttr(szTag, 'w:val') ?? extractAttr(szCsTag, 'w:val')
  const size = halfPointsToPt(sz)
  if (size) result.size = size
  if (/<w:b\s*\/>|<w:b\s/.test(rPrXml)) result.bold = true
  if (/<w:b w:val="0"/.test(rPrXml)) result.bold = false
  return result
}

function parseParagraphStyle(pPrXml: string, rPrXml: string, bodyFontSize?: number): ResolvedParagraphStyle {
  const run = parseRunStyle(rPrXml)
  const result: ResolvedParagraphStyle = { ...run }

  const jcTag = pPrXml.match(/<w:jc[^>]*\/?>/)?.[0] ?? ''
  const jc = jcTag ? extractAttr(jcTag, 'w:val') : undefined
  if (jc && ALIGN_MAP[jc]) result.align = ALIGN_MAP[jc]

  const spacingTag = pPrXml.match(/<w:spacing[^>]*>/)?.[0] ?? ''
  const line = extractAttr(spacingTag, 'w:line')
  const lineRule = extractAttr(spacingTag, 'w:lineRule')
  if (line) {
    if (lineRule === 'exact' || lineRule === 'atLeast') {
      const pt = twipsToPt(line)
      if (pt) result.lineSpacingFixed = Math.round(pt * 10) / 10
    } else {
      const mult = parseInt(line, 10) / 240
      if (Number.isFinite(mult) && mult > 0) result.lineSpacing = Math.round(mult * 100) / 100
    }
  }

  const indTag = pPrXml.match(/<w:ind[^>]*>/)?.[0] ?? ''
  const firstLine = extractAttr(indTag, 'w:firstLine')
  const firstLineChars = extractAttr(indTag, 'w:firstLineChars')
  if (firstLineChars) {
    const chars = parseInt(firstLineChars, 10)
    if (chars > 0) {
      result.firstLineIndent = true
      result.firstLineIndentChars = Math.round(chars / 100)
    }
  } else if (firstLine) {
    const twips = parseInt(firstLine, 10)
    const fs = bodyFontSize || run.size || 12
    if (twips > 0 && fs > 0) {
      result.firstLineIndent = true
      result.firstLineIndentChars = Math.max(1, Math.round(twips / (fs * 20)))
    }
  }

  const outline = extractAttr(pPrXml, 'w:val') && pPrXml.includes('<w:outlineLvl')
    ? extractAttr(pPrXml.match(/<w:outlineLvl[^>]*>/)?.[0] ?? '', 'w:val')
    : undefined
  if (outline !== undefined) {
    const lvl = parseInt(outline, 10)
    if (Number.isFinite(lvl)) result.outlineLevel = lvl + 1
  }

  return result
}

function mergeResolved(base: ResolvedParagraphStyle, overlay: ResolvedParagraphStyle): ResolvedParagraphStyle {
  return {
    font: overlay.font ?? base.font,
    fontAscii: overlay.fontAscii ?? base.fontAscii,
    size: overlay.size ?? base.size,
    bold: overlay.bold !== undefined ? overlay.bold : base.bold,
    align: overlay.align ?? base.align,
    lineSpacingFixed: overlay.lineSpacingFixed ?? base.lineSpacingFixed,
    lineSpacing: overlay.lineSpacing ?? base.lineSpacing,
    firstLineIndent: overlay.firstLineIndent ?? base.firstLineIndent,
    firstLineIndentChars: overlay.firstLineIndentChars ?? base.firstLineIndentChars,
    outlineLevel: overlay.outlineLevel ?? base.outlineLevel
  }
}

function resolveStyle(
  raw: RawParagraphStyle,
  byId: Map<string, RawParagraphStyle>,
  cache: Map<string, ResolvedParagraphStyle>
): ResolvedParagraphStyle {
  const cached = cache.get(raw.styleId)
  if (cached) return cached

  const rPr = extractBlock(raw.blockXml, 'w:rPr')
  const pPr = extractBlock(raw.blockXml, 'w:pPr')
  let resolved = parseParagraphStyle(pPr, rPr)

  if (raw.basedOnId) {
    const parent = byId.get(raw.basedOnId)
    if (parent) {
      const parentResolved = resolveStyle(parent, byId, cache)
      resolved = mergeResolved(parentResolved, resolved)
    }
  }

  cache.set(raw.styleId, resolved)
  return resolved
}

function parseParagraphStyles(stylesXml: string): { byId: Map<string, RawParagraphStyle>; byName: Map<string, ResolvedParagraphStyle> } {
  const byId = new Map<string, RawParagraphStyle>()
  const blocks = stylesXml.match(/<w:style w:type="paragraph"[\s\S]*?<\/w:style>/g) ?? []

  for (const block of blocks) {
    const styleId = extractAttr(block, 'w:styleId')
    const nameMatch = block.match(/<w:name w:val="([^"]+)"/)
    if (!styleId || !nameMatch) continue
    const basedOnId = block.match(/<w:basedOn w:val="([^"]+)"/)?.[1]
    byId.set(styleId, {
      styleId,
      name: nameMatch[1],
      basedOnId,
      blockXml: block
    })
  }

  const cache = new Map<string, ResolvedParagraphStyle>()
  const byName = new Map<string, ResolvedParagraphStyle>()
  for (const raw of byId.values()) {
    const resolved = resolveStyle(raw, byId, cache)
    byName.set(raw.name.toLowerCase(), resolved)
    byName.set(raw.name, resolved)
  }
  return { byId, byName }
}

function parseDocDefaults(stylesXml: string): ResolvedParagraphStyle {
  const docDefaults = stylesXml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0] ?? ''
  const rPr = extractBlock(docDefaults, 'w:rPr')
  return parseRunStyle(rPr)
}

function parsePageFromDocument(documentXml: string): WordStyleConfig['config']['page'] {
  const sectPr = documentXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)?.pop() ?? ''
  const pgMar = sectPr.match(/<w:pgMar[^>]*>/)?.[0] ?? ''
  const pgSz = sectPr.match(/<w:pgSz[^>]*>/)?.[0] ?? ''

  const top = extractAttr(pgMar, 'w:top')
  const bottom = extractAttr(pgMar, 'w:bottom')
  const left = extractAttr(pgMar, 'w:left')
  const right = extractAttr(pgMar, 'w:right')
  const width = extractAttr(pgSz, 'w:w')
  const height = extractAttr(pgSz, 'w:h')

  const page: NonNullable<WordStyleConfig['config']['page']> = { size: 'a4' }
  if (top) page.marginTop = parseInt(top, 10)
  if (bottom) page.marginBottom = parseInt(bottom, 10)
  if (left) page.marginLeft = parseInt(left, 10)
  if (right) page.marginRight = parseInt(right, 10)
  if (width) page.width = parseInt(width, 10)
  if (height) page.height = parseInt(height, 10)

  // A4: 11906 x 16838 DXA
  if (width === '11906' && height === '16838') page.size = 'a4'
  else if (width === '12240' && height === '15840') page.size = 'letter'

  return page
}

const TITLE_NAME_HINTS = [
  'title',
  '标题',
  '主标题',
  '公文标题',
  '文档标题',
  '中心组',
  '中心组标题'
]

function isTitleStyleName(name: string): boolean {
  const lower = name.toLowerCase()
  return TITLE_NAME_HINTS.some(h => lower === h.toLowerCase() || lower.includes(h.toLowerCase()))
}

function headingLevelFromName(name: string): number | undefined {
  const m1 = /^heading\s*(\d)$/i.exec(name) || /^标题\s*(\d+)$/.exec(name)
  if (m1) {
    const n = parseInt(m1[1], 10)
    return n >= 1 && n <= 6 ? n : undefined
  }
  const cn = /^([一二三四五六])级标题$/.exec(name)
  if (cn) {
    const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
    return map[cn[1]]
  }
  return undefined
}

type HeadingStyleEntry = NonNullable<WordStyleConfig['config']['headings']>[number]

function resolvedToHeadingEntry(r: ResolvedParagraphStyle): HeadingStyleEntry {
  return {
    font: r.font,
    fontAscii: r.fontAscii,
    size: r.size,
    bold: r.bold,
    align: r.align
  }
}

function pickTitleStyle(byName: Map<string, ResolvedParagraphStyle>, byId: Map<string, RawParagraphStyle>): ResolvedParagraphStyle | undefined {
  const explicit = byName.get('title')
  if (explicit) return explicit

  let best: ResolvedParagraphStyle | undefined
  for (const raw of byId.values()) {
    if (!isTitleStyleName(raw.name)) continue
    const r = byName.get(raw.name)!
    if (!best || (r.size ?? 0) > (best.size ?? 0)) best = r
  }
  return best
}

function buildConfigFromDocx(stylesXml: string, documentXml: string): WordStyleConfig['config'] {
  const base = { ...PRESET_STYLES.simple.config }
  const { byId, byName } = parseParagraphStyles(stylesXml)
  const docDefaults = parseDocDefaults(stylesXml)

  const normal =
    byName.get('normal') ??
    byName.get('Normal') ??
    mergeResolved(docDefaults, docDefaults)

  const body: WordStyleConfig['config'] = {
    ...base,
    page: parsePageFromDocument(documentXml),
    font: normal.font ?? base.font,
    fontAscii: normal.fontAscii ?? base.fontAscii,
    fontSize: normal.size ?? base.fontSize,
    textAlign: normal.align ?? base.textAlign,
    lineSpacingFixed: normal.lineSpacingFixed ?? base.lineSpacingFixed,
    lineSpacing: normal.lineSpacing ?? base.lineSpacing,
    firstLineIndent: normal.firstLineIndent ?? base.firstLineIndent,
    firstLineIndentChars: normal.firstLineIndentChars ?? base.firstLineIndentChars
  }

  const titleResolved = pickTitleStyle(byName, byId)
  if (titleResolved) {
    body.title = {
      font: titleResolved.font,
      fontAscii: titleResolved.fontAscii,
      size: titleResolved.size,
      bold: titleResolved.bold,
      align: titleResolved.align ?? 'center'
    }
  }

  const headings: NonNullable<WordStyleConfig['config']['headings']> = { ...base.headings }
  for (const raw of byId.values()) {
    const level = headingLevelFromName(raw.name) ?? (byName.get(raw.name)?.outlineLevel)
    if (!level || level < 1 || level > 6) continue
    const r = byName.get(raw.name)!
    headings[level] = resolvedToHeadingEntry(r)
  }

  if (Object.keys(headings).length > 0) {
    body.headings = headings
  }

  // 公文类常见：固定行距 + 首行缩进 → 抑制误用 ---
  if (body.lineSpacingFixed && body.lineSpacingFixed >= 27) {
    body.renderHr = false
  }

  return body
}

/**
 * 从 .docx 样板提取样式配置
 */
export async function extractStyleFromTemplate(docxPath: string): Promise<WordStyleConfig> {
  const data = fs.readFileSync(docxPath)
  const zip = await JSZip.loadAsync(data)

  const stylesFile = zip.file('word/styles.xml')
  const docFile = zip.file('word/document.xml')
  if (!stylesFile || !docFile) {
    throw new Error('无效的 docx：缺少 styles.xml 或 document.xml')
  }

  const stylesXml = await stylesFile.async('string')
  const documentXml = await docFile.async('string')
  const config = buildConfigFromDocx(stylesXml, documentXml)

  return {
    name: '从样板提取',
    source: docxPath,
    sourceType: 'template',
    config
  }
}

/** 供测试与工具输出：格式化提取摘要 */
export function summarizeExtractedConfig(config: WordStyleConfig['config']): string {
  const lines: string[] = []
  if (config.page) {
    const p = config.page
    lines.push(`页面: ${p.size ?? 'a4'}，边距 top=${p.marginTop} bottom=${p.marginBottom} left=${p.marginLeft} right=${p.marginRight} (DXA)`)
  }
  if (config.font) lines.push(`正文: ${config.font}${config.fontSize ? ` ${config.fontSize}pt` : ''}`)
  if (config.fontAscii) lines.push(`西文: ${config.fontAscii}`)
  if (config.lineSpacingFixed) lines.push(`行距: 固定 ${config.lineSpacingFixed}磅`)
  else if (config.lineSpacing) lines.push(`行距: ${config.lineSpacing}倍`)
  if (config.firstLineIndent) lines.push(`首行缩进: ${config.firstLineIndentChars ?? 2}字符`)
  if (config.title) {
    const t = config.title
    lines.push(`标题: ${t.font ?? '-'} ${t.size ?? '-'}pt ${t.align ?? ''} ${t.bold ? '加粗' : ''}`.trim())
  }
  if (config.headings) {
    for (const [lvl, h] of Object.entries(config.headings).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      lines.push(`标题${lvl}: ${h.font ?? '-'} ${h.size ?? '-'}pt ${h.bold ? '加粗' : ''}`.trim())
    }
  }
  return lines.join('\n')
}
