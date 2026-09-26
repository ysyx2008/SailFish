/**
 * Word 样式系统
 * 提供预设样式模板和 Markdown 转 docx 功能
 */

import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  LineRuleType,
  VerticalAlignTable,
  ShadingType,
  convertInchesToTwip,
  LevelFormat,
  LevelSuffix,
  ImageRun,
  FootnoteReferenceRun,
  InternalHyperlink,
  Bookmark
} from 'docx'
import { marked, Token, Tokens } from 'marked'
import JSZip from 'jszip'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

/**
 * 脚注 token 类型（自定义 marked 扩展产生）
 * 不复用 marked-footnote 第三方包，因为它在文档没有任何脚注定义时会崩
 * （tokenizer 假设 lexer.tokens[0] 是 footnotes block）
 */
interface FootnoteDefToken extends Tokens.Generic {
  type: 'footnoteDef'
  label: string
  text: string
}

interface FootnoteRefToken extends Tokens.Generic {
  type: 'footnoteRef'
  label: string
}

/**
 * marked.use 是全局的且会叠加扩展，需要确保只注册一次
 * 注册两个扩展：
 * - block 级 [^label]: 内容（脚注定义）
 * - inline 级 [^label]（脚注引用）
 */
let footnoteExtensionRegistered = false
function ensureFootnoteExtension(): void {
  if (footnoteExtensionRegistered) return
  marked.use({
    extensions: [
      {
        name: 'footnoteDef',
        level: 'block',
        start(src: string) {
          const m = src.match(/^[ \t]*\[\^[^\]\n]+\]:/m)
          return m?.index
        },
        tokenizer(src: string) {
          // [^label]: 内容（可跨行，后续行需缩进或不以新定义/空行开头）
          const match = /^[ \t]*\[\^([^\]\n]+)\]:[ \t]*([^\n]+(?:\n[ \t]+[^\n]+)*)/.exec(src)
          if (!match) return undefined
          const token: FootnoteDefToken = {
            type: 'footnoteDef',
            raw: match[0],
            label: match[1].trim(),
            text: match[2].replace(/\n[ \t]+/g, '\n').trim()
          }
          return token
        }
      },
      {
        name: 'footnoteRef',
        level: 'inline',
        start(src: string) {
          // 必须排除 [^label]: 这种定义形式（定义会被 block 扩展先吃掉，但 inline 阶段也要避开）
          const m = src.match(/\[\^[^\]\n]+\](?!:)/)
          return m?.index
        },
        tokenizer(src: string) {
          const match = /^\[\^([^\]\n]+)\](?!:)/.exec(src)
          if (!match) return undefined
          const token: FootnoteRefToken = {
            type: 'footnoteRef',
            raw: match[0],
            label: match[1].trim()
          }
          return token
        }
      }
    ]
  })
  footnoteExtensionRegistered = true
}

/**
 * HTML 实体解码
 * 将 &quot; &amp; &lt; &gt; 等转换回原始字符
 */
function decodeHtmlEntities(text: string): string {
  if (!text) return text
  
  const entities: Record<string, string> = {
    '&quot;': '"',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
    '&ldquo;': '\u201C',  // "
    '&rdquo;': '\u201D',  // "
    '&lsquo;': '\u2018',  // '
    '&rsquo;': '\u2019',  // '
    '&mdash;': '\u2014',  // —
    '&ndash;': '\u2013',  // –
    '&hellip;': '\u2026'  // …
  }
  
  let result = text
  for (const [entity, char] of Object.entries(entities)) {
    result = result.split(entity).join(char)
  }
  
  // 处理数字实体 &#xxx;
  result = result.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)))
  // 处理十六进制实体 &#xXXX;
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  
  return result
}

/**
 * 编号模式规则
 */
export interface NumberingRule {
  /** 匹配模式（正则表达式字符串） */
  pattern: string
  /** 样式 */
  style: {
    font?: string
    /** 西文字体（阿拉伯数字和英文），不设置则继承全局 fontAscii */
    fontAscii?: string
    size?: number
    bold?: boolean
    italic?: boolean
    align?: 'left' | 'center' | 'right' | 'justify'
    /** 首行缩进（字符数，0 表示顶格） */
    indent?: number
    /** 对应的 Word Heading 级别（1-6）。设置后使用文档级别的 Heading 样式，而非内联格式 */
    headingLevel?: number
    /** 多级编号层级（0-based）。设置后去除文本中的编号前缀，改用 Word 原生自动编号 */
    numberingLevel?: number
  }
}

/**
 * 页面配置
 * 纸张大小使用 DXA 单位（1440 DXA = 1 inch = 25.4mm）
 */
export interface PageConfig {
  /** 纸张大小：a4（默认）、letter */
  size?: 'a4' | 'letter'
  /** 自定义宽度（DXA），设置后覆盖 size */
  width?: number
  /** 自定义高度（DXA），设置后覆盖 size */
  height?: number
  /** 上页边距（DXA，默认 1440 = 1 inch） */
  marginTop?: number
  /** 下页边距（DXA） */
  marginBottom?: number
  /** 左页边距（DXA） */
  marginLeft?: number
  /** 右页边距（DXA） */
  marginRight?: number
}

/** A4 纸张尺寸（DXA） */
export const PAGE_A4 = { width: 11906, height: 16838 }
/** US Letter 纸张尺寸（DXA） */
export const PAGE_LETTER = { width: 12240, height: 15840 }
/** 默认页边距 1 inch = 1440 DXA */
const DEFAULT_MARGIN = 1440
/**
 * 根据页面配置计算实际尺寸
 */
export function resolvePageConfig(page?: PageConfig): {
  width: number; height: number
  marginTop: number; marginBottom: number; marginLeft: number; marginRight: number
  contentWidth: number
} {
  const sizeMap = { a4: PAGE_A4, letter: PAGE_LETTER }
  const base = (page?.size && sizeMap[page.size]) || PAGE_A4
  const width = page?.width || base.width
  const height = page?.height || base.height
  const marginTop = page?.marginTop ?? DEFAULT_MARGIN
  const marginBottom = page?.marginBottom ?? DEFAULT_MARGIN
  const marginLeft = page?.marginLeft ?? DEFAULT_MARGIN
  const marginRight = page?.marginRight ?? DEFAULT_MARGIN
  return { width, height, marginTop, marginBottom, marginLeft, marginRight, contentWidth: width - marginLeft - marginRight }
}

/**
 * 样式配置接口
 */
export interface WordStyleConfig {
  /** 样式名称 */
  name: string
  /** 来源文件名 */
  source?: string
  /** 来源类型 */
  sourceType: 'preset' | 'template' | 'description'
  /** 是否为默认样式 */
  isDefault?: boolean
  /** 样式配置 */
  config: {
    /** 页面配置（纸张大小、页边距） */
    page?: PageConfig
    /** 正文字体（中文/东亚字体） */
    font?: string
    /** 西文字体（阿拉伯数字和英文），如 'Times New Roman' */
    fontAscii?: string
    /** 正文字号（磅） */
    fontSize?: number
    /** 行距倍数（与 lineSpacingFixed 二选一） */
    lineSpacing?: number
    /** 固定行距（磅），如 28.5。与 lineSpacing 二选一，优先使用 */
    lineSpacingFixed?: number
    /** 正文对齐方式（默认 left，公文建议 justify） */
    textAlign?: 'left' | 'center' | 'right' | 'justify'
    /** 首行缩进 */
    firstLineIndent?: boolean
    /** 首行缩进字符数（默认 2） */
    firstLineIndentChars?: number
    /** 文档标题样式（对应 Word 的 Title 样式）
     * 通过 Markdown YAML front matter 的 title 字段指定：---\ntitle: 标题文字\n---
     * 独立于 Heading 层级，不影响 # ## ### 的映射 */
    title?: {
      font?: string
      fontAscii?: string
      size?: number
      bold?: boolean
      align?: 'left' | 'center' | 'right' | 'justify'
    }
    /** 标题样式（用于 Markdown # 标题） */
    headings?: {
      [level: number]: {
        font?: string
        /** 西文字体，不设置则继承全局 fontAscii */
        fontAscii?: string
        size?: number
        bold?: boolean
        align?: 'left' | 'center' | 'right' | 'justify'
        /** 首行缩进（字符数）。用于制度文件的"条"级标题等需要缩进的 Heading */
        indent?: number
        /** 段前间距（twips，默认 240 = 12pt）。设为 0 可让标题与正文间距一致 */
        spacingBefore?: number
        /** 段后间距（twips，默认 120 = 6pt） */
        spacingAfter?: number
      }
    }
    /** 编号层级规则（按优先级排序，先匹配的优先） */
    numberingRules?: NumberingRule[]
    /** 多级自动编号定义（如 章→节→条→款）。
     * 生成 Word 原生多级列表，增删段落时编号自动调整 */
    multiLevelNumbering?: {
      levels: {
        /** 编号格式（OpenXML numFmt 值，如 'chineseCounting'、'decimal'） */
        format: string
        /** 显示文本，含层级占位符（%1, %2, ...），如 '第%1章\u3000' */
        text: string
        /** 编号对齐方式 */
        alignment?: 'left' | 'center' | 'right'
        /** 编号后的分隔符。默认 'nothing'（分隔符已含在 text 中） */
        suffix?: 'nothing' | 'tab' | 'space'
        /** 重启行为：undefined = 上级变化时重启（默认），0 = 永不重启（如"条"跨章连续编号） */
        restart?: number
        /** 段落缩进（twips） */
        indent?: { left?: number; hanging?: number; firstLine?: number }
        /** 编号前缀的字符格式（如加粗），独立于段落正文格式 */
        run?: { bold?: boolean; font?: string; fontAscii?: string; size?: number }
      }[]
    }
    /** 表格样式 */
    table?: {
      /** 表头底色（十六进制，如 "4472C4"） */
      headerBackground?: string
      /** 表头文字颜色（十六进制，如 "FFFFFF"） */
      headerTextColor?: string
      /** 表头是否加粗（默认 true） */
      headerBold?: boolean
      /** 表头对齐方式（默认 center） */
      headerAlign?: 'left' | 'center' | 'right'
      /** 数据行交替底色 [第1/3/5行, 第2/4/6行]（如 ["FFFFFF", "F2F2F2"]），表头底色独立控制 */
      alternatingColors?: [string, string]
      /** 边框颜色（十六进制，默认 "000000"） */
      borderColor?: string
      /** 边框粗细（half-point，默认 4 = 0.5pt） */
      borderSize?: number
      /** 表格字号（磅），不设置则取正文字号的 75% */
      fontSize?: number
      /** 表格字体，不设置则继承正文字体 */
      font?: string
      /** 表格西文字体，不设置则继承正文 fontAscii */
      fontAscii?: string
      /** 单元格内边距（twips，默认 { top: 30, bottom: 30, left: 80, right: 80 }） */
      cellPadding?: { top?: number; bottom?: number; left?: number; right?: number }
    }
    /** 代码块样式 */
    codeBlock?: {
      /** 字体（默认 "Courier New"） */
      font?: string
      /** 字号（磅，默认 10） */
      fontSize?: number
      /** 背景色（十六进制，默认 "F5F5F5"） */
      background?: string
      /** 文字颜色 */
      color?: string
    }
    /** 引用块样式 */
    blockquote?: {
      /** 左侧竖线颜色（十六进制，默认 "CCCCCC"） */
      borderColor?: string
      /** 是否斜体（默认 true） */
      italic?: boolean
      /** 文字颜色（默认 "666666"） */
      color?: string
    }
    /** 是否渲染 Markdown 水平线（---/***）。
     * 默认 true；公文类样式（official/securities/regulation/meeting）默认 false，
     * 因为公文中 --- 多为 AI 误用作章节分隔，而非真实需要的分割线 */
    renderHr?: boolean
  }
}

/**
 * Markdown → docx 转换过程中的累积上下文
 * 用于收集有序列表的编号定义，最终传递给 Document 构造器
 */
interface DocxBuildContext {
  numberingConfigs: {
    reference: string
    levels: {
      level: number
      format: (typeof LevelFormat)[keyof typeof LevelFormat]
      text: string
      alignment: (typeof AlignmentType)[keyof typeof AlignmentType]
      start?: number
      suffix?: (typeof LevelSuffix)[keyof typeof LevelSuffix]
      style?: {
        run?: Record<string, unknown>
        paragraph?: { indent: Record<string, unknown> }
      }
    }[]
  }[]
  orderedListCounter: number
  /** 多级自动编号的引用名称（由 multiLevelNumbering 生成） */
  multiLevelRef?: string
  /** 图片相对路径解析的基准目录（通常是 markdown 源文件所在目录或 cwd） */
  mediaBaseDir?: string
  /**
   * 图片显示宽度上限（像素），按当前样式的页面 contentWidth 算出。
   * createImageRunOrFallback 在最终决定 width/height 时若超出此值会按比例等比缩，
   * 防止 AI 显式给大尺寸（或图片本身分辨率高被 AI 误填）撑爆 A4 版面。
   */
  maxImageWidthPx?: number
  /**
   * 脚注 label → docx 中的数字 ID 映射
   * marked-footnote 用字符串 label 标识脚注（[^foo]），但 docx 库要数字 ID
   */
  footnoteIdByLabel?: Map<string, number>
  /**
   * 标题 anchor 已去重集合：记录本文档中所有最终的 heading slug
   * 用于校验 [文](#anchor) 跳转目标是否存在
   */
  headingAnchors?: Set<string>
  /**
   * 标题 anchor 按出现顺序的去重列表（同 collectHeadingAnchors 返回顺序）
   * 配合 headingAnchorCursor 在 createHeading 里按序消费
   */
  headingAnchorList?: string[]
  /**
   * 当前 heading 取用的下标（mutable wrapper 让多个嵌套调用能共享）
   * 用对象包装是因为 cursor 需要在调用栈中递增
   */
  headingAnchorCursor?: { value: number }
}

/**
 * 把任意字符串转为合法 anchor / bookmark name
 * - 字母数字/汉字/CJK 扩展/假名/韩文等所有 Unicode Letter+Number 保留
 * - 标点空白替换为连字符
 * - 多余连字符压缩
 * - docx Bookmark name 限制 40 字符以内、不能以数字开头
 */
function slugify(text: string): string {
  let s = text.trim().toLowerCase()
  // 去除 Markdown 内联标记
  s = s.replace(/[*_`~]/g, '')
  // 仅保留 Unicode Letter / Number / 连字符 / 下划线，其余统统压成 -
  s = s.replace(/[^\p{L}\p{N}_-]+/gu, '-')
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '')
  // docx Bookmark name 不能以数字开头
  if (/^\d/.test(s)) s = 'a-' + s
  if (!s) s = 'section'
  // 截断
  return s.slice(0, 40)
}

/** 图片元素允许的扩展名 → ImageRun 类型映射 */
const IMAGE_EXT_TO_TYPE: Record<string, 'png' | 'jpg' | 'jpeg' | 'gif' | 'bmp' | 'svg'> = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpeg',
  gif: 'gif',
  bmp: 'bmp',
  svg: 'svg'
}

/** 图片默认显示宽度（像素，约等于 5 英寸 / 12.7cm） */
const IMAGE_DEFAULT_WIDTH = 480
/**
 * 图片最大宽度兜底值（像素）
 * A4 默认 1in 边距下正文宽度 ≈ 6.27in ≈ 602px；公文样式 28/26mm 边距下 ≈ 589px。
 * 取保守值 580 作为没有 ctx.maxImageWidthPx 时的兜底，避免大尺寸图片把版面撑爆。
 */
const IMAGE_MAX_WIDTH_FALLBACK = 580
/** 1px ≈ 15 DXA（twips），96 DPI 约定 */
const PX_TO_DXA = 15

/**
 * 解析 Markdown 图片的尺寸信息
 * 支持两种约定：
 * - alt 后跟 |WIDTHxHEIGHT，例如 ![描述|640x480](path)
 * - title 设为 WIDTHxHEIGHT，例如 ![描述](path "640x480")
 * 返回 { width, height, cleanAlt }，其中 cleanAlt 是去掉尺寸标记后的纯描述文字
 */
function parseImageSize(alt: string, title?: string): { width?: number; height?: number; cleanAlt: string } {
  const sizeRegex = /^(\d+)\s*[x×]\s*(\d+)$/i
  let cleanAlt = alt || ''
  let width: number | undefined
  let height: number | undefined

  // 优先尝试 alt 后缀 |WIDTHxHEIGHT
  const pipeIdx = cleanAlt.lastIndexOf('|')
  if (pipeIdx >= 0) {
    const sizePart = cleanAlt.slice(pipeIdx + 1).trim()
    const m = sizePart.match(sizeRegex)
    if (m) {
      width = parseInt(m[1], 10)
      height = parseInt(m[2], 10)
      cleanAlt = cleanAlt.slice(0, pipeIdx).trim()
    }
  }

  // 其次尝试 title
  if (width == null && title) {
    const m = title.trim().match(sizeRegex)
    if (m) {
      width = parseInt(m[1], 10)
      height = parseInt(m[2], 10)
    }
  }

  return { width, height, cleanAlt }
}

/**
 * 将 Markdown 图片 href 解析为本地文件路径
 * - 绝对路径直接返回
 * - 相对路径基于 baseDir 解析（无 baseDir → null，走文字降级）
 * - file:// URL 用 fileURLToPath 提取本地路径（兼容 Windows 盘符）
 * - http(s):// / data: 等远程 URL 返回 null
 */
function resolveMediaPath(href: string, baseDir?: string): string | null {
  if (!href) return null
  const trimmed = href.trim()

  // 远程 URL 不支持
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) {
    return null
  }

  // file:// URL（Windows 上 .pathname 会带前导斜杠 /C:/...，必须用 fileURLToPath）
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return fileURLToPath(trimmed)
    } catch {
      return null
    }
  }

  // 绝对路径
  if (path.isAbsolute(trimmed)) return trimmed

  // 相对路径必须有 baseDir，否则 fs 会按 Node 进程 cwd 解析（可能与终端 cwd 不一致），
  // 不如显式失败让上层走文字降级
  if (!baseDir) return null
  return path.resolve(baseDir, trimmed)
}

/**
 * 由扩展名推断 ImageRun.type
 * 不在登记表内（如 .webp/.tif/.heic）返回 null，让调用方走文字降级，
 * 避免把陌生格式硬塞成 png 产出 Word 打不开的坏图
 */
function detectImageType(filePath: string): 'png' | 'jpg' | 'jpeg' | 'gif' | 'bmp' | 'svg' | null {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  return IMAGE_EXT_TO_TYPE[ext] || null
}

/**
 * 创建 ImageRun 或文字降级 TextRun
 * 文件不存在/远程 URL/读取失败时返回 [图片缺失: alt] 的 TextRun
 * SVG 在 docx 库下需要 fallback PNG，目前未提供，做文字降级
 */
function createImageRunOrFallback(
  imageToken: Tokens.Image,
  baseStyle: InlineBaseStyle,
  ctx?: DocxBuildContext
): TextRun | ImageRun {
  const alt = imageToken.text || ''
  const title = imageToken.title || undefined
  const { width, height, cleanAlt } = parseImageSize(alt, title)

  const localPath = resolveMediaPath(imageToken.href, ctx?.mediaBaseDir)
  if (!localPath) {
    return new TextRun({
      text: `[图片: ${cleanAlt || imageToken.href}]`,
      ...baseStyle as Record<string, unknown>
    })
  }

  let buffer: Buffer
  try {
    buffer = fs.readFileSync(localPath)
  } catch {
    return new TextRun({
      text: `[图片缺失: ${cleanAlt || path.basename(localPath)}]`,
      ...baseStyle as Record<string, unknown>
    })
  }

  const type = detectImageType(localPath)
  if (type === null) {
    // 未登记的扩展名（webp/tif/heic 等）→ 文字降级，避免产出坏图
    return new TextRun({
      text: `[图片(格式不支持): ${cleanAlt || path.basename(localPath)}]`,
      ...baseStyle as Record<string, unknown>
    })
  }
  if (type === 'svg') {
    // docx 库要求 SVG 必须配 PNG fallback，没有就退到文字
    return new TextRun({
      text: `[图片(SVG): ${cleanAlt || path.basename(localPath)}]`,
      ...baseStyle as Record<string, unknown>
    })
  }

  const requestedWidth = width || IMAGE_DEFAULT_WIDTH
  const requestedHeight = height || Math.round(requestedWidth * 0.75)

  // 按页面正文宽度做硬上限：避免 AI 显式给大尺寸（如 |2400x1800）或图片源分辨率
  // 巨大被无脑使用，导致图片溢出页面。等比缩放，不会放大小图。
  const maxWidth = ctx?.maxImageWidthPx ?? IMAGE_MAX_WIDTH_FALLBACK
  let finalWidth = requestedWidth
  let finalHeight = requestedHeight
  if (finalWidth > maxWidth) {
    const ratio = maxWidth / finalWidth
    finalWidth = maxWidth
    finalHeight = Math.round(requestedHeight * ratio)
  }

  return new ImageRun({
    data: buffer,
    transformation: { width: finalWidth, height: finalHeight },
    type: type === 'jpeg' ? 'jpg' : type
  })
}

/**
 * 检测段落是否为"图片独占"段落
 * 允许内联格式中夹杂仅含空白的 text 节点；返回所有有效 image token
 * 段落里只要有任何带文字的节点（包括 strong/em/link/codespan 等），就视为"段落里有图"，不做块级处理
 */
function extractBlockLevelImages(tokens: Token[]): Tokens.Image[] {
  const images: Tokens.Image[] = []
  for (const token of tokens) {
    if (token.type === 'image') {
      images.push(token as Tokens.Image)
    } else if (token.type === 'text') {
      const text = (token as Tokens.Text).text || ''
      if (text.trim()) return [] // 有非空白文字 → 不算块级
    } else if (token.type === 'br' || token.type === 'space') {
      // 允许换行/空白
    } else {
      return [] // 出现其他类型节点 → 不算块级
    }
  }
  return images
}

/**
 * 创建块级图片段落（居中、无首行缩进）
 *
 * spacing 必须显式覆盖：公文类样式（official/securities/regulation/meeting）的 Normal
 * 段落用 lineRule:EXACT 固定 28.5 磅行距，图片段落如继承该设置会被压成一条线（图片只
 * 能显示 28.5pt ≈ 1cm 高度）。这里改为 lineRule:AUTO 让 Word 按图片实际高度撑开段落，
 * 同时段前段后留 120 twips (6pt) 与上下正文透气。
 */
function createBlockImageParagraph(imageToken: Tokens.Image, ctx?: DocxBuildContext): Paragraph {
  const run = createImageRunOrFallback(imageToken, {}, ctx)
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: 120,
      after: 120,
      line: 240,
      lineRule: LineRuleType.AUTO
    },
    children: [run]
  })
}

/**
 * 预设样式模板
 */
export const PRESET_STYLES: Record<string, WordStyleConfig> = {
  simple: {
    name: '简洁风格',
    sourceType: 'preset',
    config: {
      font: 'Arial',
      fontSize: 11,
      lineSpacing: 1.15,
      firstLineIndent: false,
      headings: {
        1: { size: 24, bold: true },
        2: { size: 18, bold: true },
        3: { size: 14, bold: true },
        4: { size: 12, bold: true },
        5: { size: 11, bold: true },
        6: { size: 11, bold: true }
      },
      table: {
        headerBackground: 'F2F2F2',
        headerBold: true,
        headerAlign: 'center',
        borderColor: 'D9D9D9',
        borderSize: 4
      },
      codeBlock: { font: 'Courier New', fontSize: 10, background: 'F5F5F5' },
      blockquote: { borderColor: 'CCCCCC', italic: true, color: '666666' }
    }
  },
  formal: {
    name: '正式报告',
    sourceType: 'preset',
    config: {
      font: '宋体',
      fontSize: 12,
      lineSpacing: 1.5,
      firstLineIndent: true,
      renderHr: false,
      headings: {
        1: { font: '黑体', size: 22, bold: true, align: 'center' },
        2: { font: '黑体', size: 16, bold: true },
        3: { font: '黑体', size: 14, bold: true },
        4: { font: '宋体', size: 12, bold: true },
        5: { font: '宋体', size: 12, bold: true },
        6: { font: '宋体', size: 12, bold: true }
      },
      table: {
        headerBackground: '4472C4',
        headerTextColor: 'FFFFFF',
        headerBold: true,
        headerAlign: 'center',
        alternatingColors: ['FFFFFF', 'D9E2F3'],
        borderColor: '8EAADB',
        borderSize: 4
      },
      codeBlock: { font: 'Courier New', fontSize: 10, background: 'F5F5F5' },
      blockquote: { borderColor: '4472C4', italic: true, color: '404040' }
    }
  },
  tech: {
    name: '技术文档',
    sourceType: 'preset',
    config: {
      font: '微软雅黑',
      fontSize: 11,
      lineSpacing: 1.25,
      firstLineIndent: false,
      headings: {
        1: { font: '微软雅黑', size: 20, bold: true },
        2: { font: '微软雅黑', size: 16, bold: true },
        3: { font: '微软雅黑', size: 13, bold: true },
        4: { font: '微软雅黑', size: 11, bold: true },
        5: { font: '微软雅黑', size: 11, bold: true },
        6: { font: '微软雅黑', size: 11, bold: true }
      },
      table: {
        headerBackground: '2B579A',
        headerTextColor: 'FFFFFF',
        headerBold: true,
        headerAlign: 'center',
        alternatingColors: ['FFFFFF', 'F0F4FA'],
        borderColor: 'B4C6E7',
        borderSize: 4,
        font: '微软雅黑'
      },
      codeBlock: { font: 'Consolas', fontSize: 9.5, background: 'F0F0F0', color: '333333' },
      blockquote: { borderColor: '2B579A', italic: false, color: '555555' }
    }
  },
  academic: {
    name: '学术论文',
    sourceType: 'preset',
    config: {
      font: 'Times New Roman',
      fontSize: 12,
      lineSpacing: 2.0,
      firstLineIndent: true,
      headings: {
        1: { font: 'Times New Roman', size: 16, bold: true, align: 'center' },
        2: { font: 'Times New Roman', size: 14, bold: true },
        3: { font: 'Times New Roman', size: 12, bold: true },
        4: { font: 'Times New Roman', size: 12, bold: true },
        5: { font: 'Times New Roman', size: 12, bold: true },
        6: { font: 'Times New Roman', size: 12, bold: true }
      },
      table: {
        headerBackground: 'F2F2F2',
        headerBold: true,
        headerAlign: 'center',
        borderColor: '000000',
        borderSize: 4
      },
      codeBlock: { font: 'Courier New', fontSize: 10, background: 'F8F8F8' },
      blockquote: { borderColor: 'AAAAAA', italic: true, color: '555555' }
    }
  },
}

/**
 * 注册外部技能贡献的样式预设
 *
 * 用途：拆分后 word 技能只保留通用预设（simple/formal/tech/academic）；
 * 公文（official/securities/meeting）和制度（regulation）等中文场景专属预设
 * 由独立技能在加载时通过本函数注册到共享注册表，机制（解析引擎）保持单一来源。
 *
 * 注意：name 重复注册时静默覆盖，与历史 PRESET_STYLES 字面量同名覆盖语义一致。
 */
export function registerStylePreset(name: string, config: WordStyleConfig): void {
  PRESET_STYLES[name] = config
}

/**
 * 获取样式配置
 */
export function getStyleConfig(styleName?: string): WordStyleConfig {
  if (!styleName) {
    return PRESET_STYLES.simple
  }
  return PRESET_STYLES[styleName] || PRESET_STYLES.simple
}

/**
 * 将对齐字符串转换为 AlignmentType
 */
function getAlignment(align?: string): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (align) {
    case 'center': return AlignmentType.CENTER
    case 'right': return AlignmentType.RIGHT
    case 'justify': return AlignmentType.JUSTIFIED
    default: return AlignmentType.LEFT
  }
}

/**
 * 构建字体配置：支持中西文分别设置
 * 当同时指定 eastAsia 和 ascii 字体时，返回 { ascii, eastAsia, hAnsi } 对象
 * 否则返回单个字体字符串
 */
function buildFontConfig(
  eastAsiaFont?: string,
  asciiFont?: string
): string | { ascii: string; eastAsia: string; hAnsi: string } | undefined {
  if (!eastAsiaFont && !asciiFont) return undefined
  if (!asciiFont) return eastAsiaFont
  if (!eastAsiaFont) return asciiFont
  return {
    ascii: asciiFont,
    eastAsia: eastAsiaFont,
    hAnsi: asciiFont
  }
}

/**
 * 行距配置类型
 */
type LineSpacingConfig = {
  line: number
  lineRule?: (typeof LineRuleType)[keyof typeof LineRuleType]
}

/**
 * 构建行距配置：支持倍数行距和固定行距
 * 固定行距（lineSpacingFixed）优先于倍数行距（lineSpacing）
 */
function buildLineSpacing(config: WordStyleConfig['config']): LineSpacingConfig {
  if (config.lineSpacingFixed) {
    // 固定行距：值为磅数 * 20（twips），lineRule 为 EXACT
    return { line: Math.round(config.lineSpacingFixed * 20), lineRule: LineRuleType.EXACT }
  }
  // 倍数行距：值为倍数 * 240
  return { line: (config.lineSpacing || 1.15) * 240 }
}

/**
 * 计算首行缩进（twips）
 * 基于字号精确计算：缩进量 = 缩进字符数 × 字号(pt) × 20(twips/pt)
 */
function calcFirstLineIndent(config: WordStyleConfig['config']): number | undefined {
  if (!config.firstLineIndent) return undefined
  const indentChars = config.firstLineIndentChars ?? 2
  const charWidthTwips = (config.fontSize || 12) * 20  // 1pt = 20 twips
  return indentChars * charWidthTwips
}

/**
 * 根据样式配置构建文档级别的样式定义
 * 在 Word 中定义 Normal、Heading 1-6 等样式，使用户可以直接通过修改样式来批量调整格式
 */
function buildDocumentStyles(style: WordStyleConfig): { default: Record<string, unknown> } {
  const config = style.config
  const lineSpacing = buildLineSpacing(config)

  // 默认（Normal）样式：正文字体、字号、行距
  const defaultStyles: Record<string, unknown> = {
    document: {
      run: {
        font: buildFontConfig(config.font, config.fontAscii),
        size: config.fontSize ? config.fontSize * 2 : undefined,
        color: '000000'
      },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        spacing: lineSpacing
      }
    },
    listParagraph: {
      run: {
        font: buildFontConfig(config.font, config.fontAscii),
        size: config.fontSize ? config.fontSize * 2 : undefined
      }
    }
  }

  // Title 样式（文档标题，独立于 Heading 层级）
  if (config.title) {
    const tc = config.title
    defaultStyles['title'] = {
      run: {
        font: buildFontConfig(
          tc.font || config.font,
          tc.fontAscii || config.fontAscii
        ),
        size: (tc.size || config.fontSize || 12) * 2,
        bold: tc.bold ?? false,
        color: '000000'
      },
      paragraph: {
        alignment: getAlignment(tc.align),
        spacing: { before: 240, after: 120, ...lineSpacing }
      }
    }
  }

  // 标题样式 Heading 1-6
  const headingKeys = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6']

  for (let level = 1; level <= 6; level++) {
    const hConfig = config.headings?.[level]
    const key = headingKeys[level - 1]

    if (hConfig) {
      const hFontSize = hConfig.size || config.fontSize || 12
      const hIndent = hConfig.indent != null
        ? { firstLine: hConfig.indent * hFontSize * 20 }
        : undefined
      defaultStyles[key] = {
        run: {
          font: buildFontConfig(
            hConfig.font || config.font,
            hConfig.fontAscii || config.fontAscii
          ),
          size: hFontSize * 2,
          bold: hConfig.bold ?? true,
          color: '000000'
        },
        paragraph: {
          alignment: getAlignment(hConfig.align),
          spacing: { before: hConfig.spacingBefore ?? 240, after: hConfig.spacingAfter ?? 120, ...lineSpacing },
          indent: hIndent
        }
      }
    } else {
      // 未定义的标题级别：使用正文字体、加粗、黑色
      defaultStyles[key] = {
        run: {
          font: buildFontConfig(config.font, config.fontAscii),
          size: config.fontSize ? config.fontSize * 2 : undefined,
          bold: true,
          color: '000000'
        },
        paragraph: {
          spacing: { before: 240, after: 120, ...lineSpacing }
        }
      }
    }
  }

  return { default: defaultStyles }
}

/**
 * 生成文档主题 XML
 * 将主题颜色全部设为黑色，防止 Word 内置标题样式引用主题色（蓝色）覆盖自定义样式
 * 同时设置主题字体，使样式面板预览正确显示
 */
function buildThemeXml(config: WordStyleConfig['config']): string {
  // 标题字体（majorFont）取 H1 配置，正文字体（minorFont）取全局配置
  const h1Font = config.headings?.[1]?.font || config.font || ''
  const bodyFont = config.font || ''
  const asciiFont = config.fontAscii || config.headings?.[1]?.fontAscii || ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
  <a:themeElements>
    <a:clrScheme name="Office">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="000000"/></a:dk2>
      <a:lt2><a:srgbClr val="FFFFFF"/></a:lt2>
      <a:accent1><a:srgbClr val="000000"/></a:accent1>
      <a:accent2><a:srgbClr val="000000"/></a:accent2>
      <a:accent3><a:srgbClr val="000000"/></a:accent3>
      <a:accent4><a:srgbClr val="000000"/></a:accent4>
      <a:accent5><a:srgbClr val="000000"/></a:accent5>
      <a:accent6><a:srgbClr val="000000"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="${asciiFont || h1Font}"/>
        <a:ea typeface="${h1Font}"/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="${config.fontAscii || bodyFont}"/>
        <a:ea typeface="${bodyFont}"/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
      <a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
      <a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
      <a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
</a:theme>`
}

/**
 * 向 docx buffer 注入主题文件
 * docx 库不支持自定义主题，需要在打包后手动注入 theme1.xml 并更新关系文件
 */
async function injectTheme(buffer: Buffer, config: WordStyleConfig['config']): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer)

  // 已有 theme 则跳过
  if (zip.file('word/theme/theme1.xml')) {
    return buffer
  }

  // 注入 theme 文件
  zip.file('word/theme/theme1.xml', buildThemeXml(config))

  // 更新 document.xml.rels，添加 theme 关系
  const relsPath = 'word/_rels/document.xml.rels'
  const relsFile = zip.file(relsPath)
  if (relsFile) {
    let relsContent = await relsFile.async('string')
    if (!relsContent.includes('relationships/theme')) {
      const themeRel = '<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
      relsContent = relsContent.replace('</Relationships>', themeRel + '</Relationships>')
      zip.file(relsPath, relsContent)
    }
  }

  // 更新 [Content_Types].xml，添加 theme 内容类型
  const ctPath = '[Content_Types].xml'
  const ctFile = zip.file(ctPath)
  if (ctFile) {
    let ctContent = await ctFile.async('string')
    if (!ctContent.includes('theme+xml')) {
      const themeType = '<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      ctContent = ctContent.replace('</Types>', themeType + '</Types>')
      zip.file(ctPath, ctContent)
    }
  }

  return await zip.generateAsync({ type: 'nodebuffer' }) as Buffer
}

/**
 * 向 docx buffer 注入 lvlRestart 属性，控制多级编号的重启行为
 * docx 库不支持 lvlRestart，需在打包后通过 XML 修补
 * restart=0 表示永不重启（如"条"跨章连续编号）
 */
async function patchNumberingRestart(
  buffer: Buffer,
  mlConfig: NonNullable<WordStyleConfig['config']['multiLevelNumbering']>
): Promise<Buffer> {
  const restartLevels = mlConfig.levels
    .map((lvl, idx) => ({ idx, restart: lvl.restart }))
    .filter(l => l.restart != null)
  if (restartLevels.length === 0) return buffer

  const zip = await JSZip.loadAsync(buffer)
  const numFile = zip.file('word/numbering.xml')
  if (!numFile) return buffer

  let numXml = await numFile.async('string')

  // 找到包含我们多级编号的 abstractNum 块（通过 chineseCounting 格式识别）
  const abstractBlocks = numXml.match(/<w:abstractNum[\s\S]*?<\/w:abstractNum>/g) || []
  for (const block of abstractBlocks) {
    if (!block.includes('w:val="chineseCounting"')) continue

    let patched = block
    for (const { idx, restart } of restartLevels) {
      const lvlPattern = new RegExp(`(<w:lvl w:ilvl="${idx}"[^>]*>)`)
      patched = patched.replace(lvlPattern, `$1<w:lvlRestart w:val="${restart}"/>`)
    }
    numXml = numXml.replace(block, patched)
    break
  }

  zip.file('word/numbering.xml', numXml)
  return await zip.generateAsync({ type: 'nodebuffer' }) as Buffer
}

/**
 * 将 Heading 样式绑定到多级编号定义，使用户在 Word 中切换标题级别时编号自动跟随。
 * 通过向 styles.xml 的 Heading pPr 中注入 numPr（numId + ilvl）实现。
 */
async function linkHeadingStylesToNumbering(
  buffer: Buffer,
  config: WordStyleConfig['config']
): Promise<Buffer> {
  const rules = config.numberingRules
  if (!rules || !config.multiLevelNumbering) return buffer

  const headingToLevel = new Map<number, number>()
  for (const rule of rules) {
    if (rule.style.headingLevel && rule.style.numberingLevel != null) {
      headingToLevel.set(rule.style.headingLevel, rule.style.numberingLevel)
    }
  }
  if (headingToLevel.size === 0) return buffer

  const zip = await JSZip.loadAsync(buffer)

  const numFile = zip.file('word/numbering.xml')
  if (!numFile) return buffer
  let numXml = await numFile.async('string')

  // 逐块匹配 abstractNum，找到包含 chineseCounting 的那个（与 patchNumberingRestart 同策略）
  const abstractBlocks = numXml.match(/<w:abstractNum[\s\S]*?<\/w:abstractNum>/g) || []
  let abstractNumId: string | null = null
  for (const block of abstractBlocks) {
    if (!block.includes('w:val="chineseCounting"')) continue
    const idMatch = block.match(/w:abstractNumId="(\d+)"/)
    if (idMatch) { abstractNumId = idMatch[1]; break }
  }
  if (!abstractNumId) return buffer

  // 查找或创建 num 元素（当所有编号级别都由 heading 样式携带时，可能无段落引用，docx 库不生成 num）
  // ⚠️ 正则必须限定在单个 <w:num> 块内，不能用 [\s\S]*? 跨越 </w:num> 边界，
  // 否则在存在其他 <w:num>（如 bullet 列表）时会错误捕获前一个 num 的 numId。
  let numId: string
  const numIdMatch = numXml.match(new RegExp(
    `<w:num w:numId="(\\d+)"[^>]*>\\s*<w:abstractNumId w:val="${abstractNumId}"`
  ))
  if (numIdMatch) {
    numId = numIdMatch[1]
  } else {
    const existingIds = [...numXml.matchAll(/w:numId="(\d+)"/g)].map(m => parseInt(m[1]))
    numId = String(existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1)
    numXml = numXml.replace(
      '</w:numbering>',
      `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractNumId}"/></w:num></w:numbering>`
    )
    zip.file('word/numbering.xml', numXml)
  }

  const stylesFile = zip.file('word/styles.xml')
  if (!stylesFile) return buffer
  let stylesXml = await stylesFile.async('string')

  for (const [headingLevel, numLevel] of headingToLevel) {
    const headingId = `Heading${headingLevel}`
    const numPr = `<w:numPr><w:ilvl w:val="${numLevel}"/><w:numId w:val="${numId}"/></w:numPr>`
    const pprPattern = new RegExp(
      `(<w:style[^>]*w:styleId="${headingId}"[\\s\\S]*?<w:pPr>)`
    )
    if (pprPattern.test(stylesXml)) {
      stylesXml = stylesXml.replace(pprPattern, `$1${numPr}`)
    }
  }

  zip.file('word/styles.xml', stylesXml)
  return await zip.generateAsync({ type: 'nodebuffer' }) as Buffer
}

/**
 * 从 markdown 开头提取文档标题，剥离对应行后返回剩余内容。
 *
 * 支持两种写法：
 * 1. 标准 YAML front matter：`---\n...\n---\n`
 * 2. 无围栏的开头 title 行（AI 经常忘记加 ---）：
 *    - 首个非空行形如 `title: xxx`、`**title:** xxx`、`title：xxx` 等
 *    - 必须独占一行（行尾即段落边界），避免误吞正文中含 "title:" 的句子
 */
function extractDocumentTitle(markdown: string): { title?: string; content: string } {
  // 所有匹配都跳过开头空白：AI 生成的 markdown 参数经常带前导换行（如 '\n---\ntitle: ...'），
  // 若锚死在第 0 个字符，围栏会漏匹配，title 行漏进正文还会被 --- 误判成 setext 标题
  const leadingWhitespace = markdown.match(/^\s*/)?.[0] ?? ''
  const rest = markdown.slice(leadingWhitespace.length)

  // 标准围栏 frontmatter
  const frontMatterMatch = rest.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (frontMatterMatch) {
    const titleMatch = frontMatterMatch[1].match(/^title\s*[:：]\s*(.+)$/im)
    const title = titleMatch
      ? titleMatch[1].trim().replace(/^["'\u201C\u2018]|["'\u201D\u2019]$/g, '')
      : undefined
    return { title, content: rest.slice(frontMatterMatch[0].length) }
  }

  // 第一行（到首个换行符为止）
  const firstNewlineIdx = rest.indexOf('\n')
  const firstLine = firstNewlineIdx >= 0 ? rest.slice(0, firstNewlineIdx) : rest
  // 模式：可选的 ** 包裹 + title + 半角/全角冒号 + 内容
  // 例：title: xxx / **title:** xxx / **title：** xxx / title：xxx
  const looseTitleMatch = firstLine.match(/^\s*(?:\*\*\s*)?title\s*(?:\*\*\s*)?[:：]\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*$/i)
  if (looseTitleMatch) {
    const title = looseTitleMatch[1].trim().replace(/^["'\u201C\u2018]|["'\u201D\u2019]$/g, '')
    if (title) {
      const content = firstNewlineIdx >= 0 ? rest.slice(firstNewlineIdx + 1) : ''
      return { title, content }
    }
  }

  // AI 误用 Markdown 标题写文档标题：`## title: xxx` / `# title：xxx`
  const hashTitleMatch = rest.match(
    /^#{1,6}\s+(?:\*\*\s*)?title\s*(?:\*\*\s*)?[:：]\s*(?:\*\*\s*)?(.+?)(?:\s*\*\*)?\s*(?:\r?\n|$)/i
  )
  if (hashTitleMatch) {
    const title = hashTitleMatch[1].trim().replace(/^["'\u201C\u2018]|["'\u201D\u2019]$/g, '')
    if (title) {
      let content = rest.slice(hashTitleMatch[0].length)
      if (content.startsWith('\r\n')) content = content.slice(2)
      else if (content.startsWith('\n')) content = content.slice(1)
      return { title, content: leadingWhitespace + content }
    }
  }

  return { content: markdown }
}

/**
 * markdownToDocx 的可选参数
 */
export interface MarkdownToDocxOptions {
  /** 图片相对路径解析的基准目录。通常是 markdown 源文件所在目录或当前工作目录 */
  mediaBaseDir?: string
}

/**
 * 将 Markdown 转换为 Word 文档
 */
export async function markdownToDocx(
  markdown: string,
  style?: string | WordStyleConfig,
  options?: MarkdownToDocxOptions
): Promise<Buffer> {
  // 获取样式配置
  const styleConfig = typeof style === 'string' 
    ? getStyleConfig(style) 
    : (style || getStyleConfig())
  
  // 提取文档标题
  // 1) 标准 YAML front matter：--- ... ---
  // 2) 容错：文档开头第一段（首个空行前）独占一行的 title 写法，常见 AI 笔误：
  //    - title: xxx
  //    - **title:** xxx / **title：** xxx
  //    - title：xxx（中文冒号）
  //    这种写法本意是 frontmatter，但缺少围栏，原本会被当成普通段落输出
  const { title: documentTitle, content: contentMarkdown } = extractDocumentTitle(markdown)

  // 注册脚注扩展（GFM [^id] / [^id]: ... 语法）
  ensureFootnoteExtension()

  // 解析 Markdown
  const tokens = marked.lexer(contentMarkdown)

  // 收集脚注定义（block 级 'footnotes' token），构建 label → 数字 ID 映射
  const footnoteIdByLabel = new Map<string, number>()
  const footnoteDefinitions = collectFootnoteDefinitions(tokens, footnoteIdByLabel)

  // 收集所有标题 anchor（处理同名冲突），供 [文](#xxx) 跳转校验和给 heading 段落自动包 Bookmark
  const { ordered: headingAnchorList, set: headingAnchors } = collectHeadingAnchors(tokens)

  // 计算当前样式下的页面正文宽度（像素），用作图片 cap
  const pageMetrics = resolvePageConfig(styleConfig.config?.page)
  const maxImageWidthPx = Math.floor(pageMetrics.contentWidth / PX_TO_DXA)

  // 构建上下文（收集有序列表编号定义）
  const ctx: DocxBuildContext = {
    numberingConfigs: [],
    orderedListCounter: 0,
    mediaBaseDir: options?.mediaBaseDir,
    maxImageWidthPx,
    footnoteIdByLabel,
    headingAnchors,
    headingAnchorList,
    headingAnchorCursor: { value: 0 }
  }

  // 注册多级自动编号（如制度文件的 章→节→条→款 体系）
  if (styleConfig.config.multiLevelNumbering) {
    const mlConfig = styleConfig.config.multiLevelNumbering
    ctx.multiLevelRef = 'multi-level-auto'
    const formatMap: Record<string, (typeof LevelFormat)[keyof typeof LevelFormat]> = {
      chineseCounting: LevelFormat.CHINESE_COUNTING,
      chineseCountingThousand: LevelFormat.CHINESE_COUNTING_THOUSAND,
      decimal: LevelFormat.DECIMAL,
      upperRoman: LevelFormat.UPPER_ROMAN,
      lowerRoman: LevelFormat.LOWER_ROMAN,
      none: LevelFormat.NONE
    }
    const suffixMap: Record<string, (typeof LevelSuffix)[keyof typeof LevelSuffix]> = {
      nothing: LevelSuffix.NOTHING,
      tab: LevelSuffix.TAB,
      space: LevelSuffix.SPACE
    }
    ctx.numberingConfigs.push({
      reference: ctx.multiLevelRef,
      levels: mlConfig.levels.map((lvl, idx) => ({
        level: idx,
        format: formatMap[lvl.format] || LevelFormat.DECIMAL,
        text: lvl.text,
        alignment: getAlignment(lvl.alignment),
        suffix: suffixMap[lvl.suffix || 'nothing'] || LevelSuffix.NOTHING,
        start: 1,
        style: (lvl.indent || lvl.run) ? {
          paragraph: lvl.indent ? { indent: lvl.indent } : undefined,
          run: lvl.run ? {
            bold: lvl.run.bold,
            font: lvl.run.font || lvl.run.fontAscii
              ? buildFontConfig(lvl.run.font, lvl.run.fontAscii)
              : undefined,
            size: lvl.run.size ? lvl.run.size * 2 : undefined
          } : undefined
        } : undefined
      }))
    })
  }
  
  // 转换为 docx 元素
  const children = tokensToDocxElements(tokens, styleConfig, ctx)
  
  // 如果有文档标题，插入到最前面（使用 Title 样式）
  if (documentTitle) {
    children.unshift(createDocumentTitle(documentTitle, styleConfig))
  }
  
  // 解析页面配置
  const pageResolved = resolvePageConfig(styleConfig.config.page)

  // 构建脚注 docx 表示：{ id: { children: [Paragraph...] } }
  let docxFootnotes: Record<number, { children: Paragraph[] }> | undefined
  if (footnoteDefinitions.length > 0) {
    docxFootnotes = {}
    // 脚注内容用独立子上下文：禁用 heading anchor 跟踪（避免脚注里的标题侵占主文档 cursor），
    // 但保留 footnoteIdByLabel 让脚注内可以引用其他脚注（仅引用，不再收集新定义）
    const footnoteCtx: DocxBuildContext = {
      ...ctx,
      headingAnchors: undefined,
      headingAnchorList: undefined,
      headingAnchorCursor: undefined
    }
    for (const def of footnoteDefinitions) {
      const id = footnoteIdByLabel.get(def.label)
      if (id == null) continue
      // 脚注内容是纯字符串（可能含内联 markdown），用 lexer 解析后转成段落
      const innerTokens = marked.lexer(def.text)
      const footnoteElements = tokensToDocxElements(innerTokens, styleConfig, footnoteCtx)
      // 表格等非 Paragraph 元素退化为纯文本段落，避免静默丢失（Word 脚注通常只支持段落级内容）
      const footnoteChildren: Paragraph[] = footnoteElements.map(el =>
        el instanceof Paragraph
          ? el
          : new Paragraph({ children: [new TextRun({ text: '[非段落内容已省略]' })] })
      )
      docxFootnotes[id] = {
        children: footnoteChildren.length > 0
          ? footnoteChildren
          : [new Paragraph({ children: [new TextRun(def.text)] })]
      }
    }
  }

  // 创建文档（包含文档级别的样式定义 + 有序列表编号定义 + 页面配置 + 脚注）
  const doc = new Document({
    styles: buildDocumentStyles(styleConfig),
    numbering: ctx.numberingConfigs.length > 0 ? { config: ctx.numberingConfigs } : undefined,
    footnotes: docxFootnotes,
    sections: [{
      properties: {
        page: {
          size: { width: pageResolved.width, height: pageResolved.height },
          margin: {
            top: pageResolved.marginTop,
            bottom: pageResolved.marginBottom,
            left: pageResolved.marginLeft,
            right: pageResolved.marginRight
          }
        }
      },
      children: children.length > 0 ? children : [new Paragraph({ children: [] })]
    }]
  })
  
  // 导出为 Buffer
  let buffer = await Packer.toBuffer(doc)

  // 注入自定义主题，确保 Word 不会用默认主题颜色/字体覆盖自定义样式
  buffer = await injectTheme(buffer, styleConfig.config)

  // 修补多级编号的重启行为（docx 库不支持 lvlRestart，需后处理）
  if (styleConfig.config.multiLevelNumbering) {
    buffer = await patchNumberingRestart(buffer, styleConfig.config.multiLevelNumbering)
    // 将编号定义绑定到 Heading 样式，使用户在 Word 中切换标题级别时编号自动跟随
    buffer = await linkHeadingStylesToNumbering(buffer, styleConfig.config)
  }

  return buffer
}

/**
 * 递归从 token 树收集脚注定义（marked 会把 footnoteDef 挂到 blockquote/list/table 等子 tokens 里）
 * 按出现顺序往 idMap 分配数字 ID（docx FootnoteReferenceRun 要求数字）
 * 重复 label 仅保留首个定义
 */
function collectFootnoteDefinitions(tokens: Token[], idMap: Map<string, number>): FootnoteDefToken[] {
  const result: FootnoteDefToken[] = []

  const walk = (nodes: Token[] | undefined): void => {
    if (!nodes) return
    for (const t of nodes) {
      if (t.type === 'footnoteDef') {
        const def = t as FootnoteDefToken
        if (!idMap.has(def.label)) {
          idMap.set(def.label, idMap.size + 1)
          result.push(def)
        }
      }
      // 递归子结构
      const children = (t as { tokens?: Token[]; items?: { tokens?: Token[] }[] })
      walk(children.tokens)
      if (Array.isArray(children.items)) {
        for (const item of children.items) walk(item.tokens)
      }
    }
  }

  walk(tokens)
  return result
}

/**
 * 收集所有 heading 文本对应的 anchor slug，处理冲突自动加 -2/-3 后缀
 * 返回按出现顺序的去重列表 + 集合（用于 InternalHyperlink 校验）
 * - 同名标题（"附录""附录"）→ 第二个变成"附录-2"
 * - 空/超长标题截断后冲突也走同样路径
 */
function collectHeadingAnchors(tokens: Token[]): { ordered: string[]; set: Set<string> } {
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    if (t.type === 'heading') {
      const heading = t as Tokens.Heading
      const base = slugify(heading.text)
      let final = base
      let suffix = 2
      while (seen.has(final)) {
        final = `${base}-${suffix}`
        suffix++
      }
      seen.add(final)
      ordered.push(final)
    }
  }
  return { ordered, set: seen }
}

/**
 * 将 Markdown tokens 转换为 docx 元素
 */
function tokensToDocxElements(
  tokens: Token[],
  style: WordStyleConfig,
  ctx: DocxBuildContext
): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = []
  // 跟踪上一个元素的对齐方式，用于判断落款前是否需要空行
  let lastAlign: string | undefined
  
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        elements.push(createHeading(token as Tokens.Heading, style, ctx))
        lastAlign = undefined
        break
        
      case 'paragraph': {
        // 使用 token.tokens（已解析的内联格式），而不是 token.text（原始文本）
        const paragraphToken = token as Tokens.Paragraph
        if (paragraphToken.tokens && paragraphToken.tokens.length > 0) {
          // 块级图片：段落只包含图片（允许夹杂空白文本节点），居中独占一段
          const blockImages = extractBlockLevelImages(paragraphToken.tokens)
          if (blockImages.length > 0) {
            elements.push(...blockImages.map(img => createBlockImageParagraph(img, ctx)))
          } else {
            elements.push(createParagraphFromTokens(paragraphToken.tokens, style, ctx))
          }
        } else {
          elements.push(createParagraph(paragraphToken.text, style, ctx))
        }
        lastAlign = undefined
        break
      }
        
      case 'list':
        elements.push(...createList(token as Tokens.List, style, ctx))
        lastAlign = undefined
        break
        
      case 'table':
        elements.push(createTable(token as Tokens.Table, style, ctx))
        lastAlign = undefined
        break
        
      case 'code':
        elements.push(createCodeBlock(token as Tokens.Code, style))
        lastAlign = undefined
        break
        
      case 'blockquote':
        elements.push(createBlockquote(token as Tokens.Blockquote, style))
        lastAlign = undefined
        break
        
      case 'hr':
        // 公文类样式默认不渲染水平线（renderHr === false 时跳过）
        if (style.config.renderHr !== false) {
          elements.push(createHorizontalRule())
        }
        lastAlign = undefined
        break
        
      case 'html': {
        // 支持 HTML 标签：
        // - <p>文本</p> — 无缩进段落（主送机关等顶格行）
        // - <p align="right">文本</p> — 对齐段落（落款等）
        const htmlResult = createParagraphFromHtml(token as Tokens.HTML, style)
        if (htmlResult) {
          // 落款前空行：右对齐段落前面不是右对齐内容时，插入一个空段落
          if (htmlResult.align === 'right' && lastAlign !== 'right') {
            elements.push(new Paragraph({ children: [] }))
          }
          elements.push(...htmlResult.paragraphs)
          lastAlign = htmlResult.align
        }
        break
      }
        
      case 'space':
        // 空行，跳过
        break

      case 'footnoteDef':
        // 脚注定义已由 collectFootnoteDefinitions 在 markdownToDocx 收集，
        // 这里跳过，避免脚注定义文字出现在正文里（docx footnotes 会渲染到页脚）
        break

      default:
        // 其他类型尝试作为段落处理
        if ('text' in token && token.text) {
          elements.push(createParagraph(decodeHtmlEntities(token.text), style))
        }
        lastAlign = undefined
    }
  }
  
  return elements
}

const HEADING_LEVEL_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6
}

/**
 * 创建文档标题（Word Title 样式）
 */
function createDocumentTitle(text: string, _style: WordStyleConfig): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text })]
  })
}

/**
 * 创建标题
 * 不设置内联格式，完全依赖文档级别的 Heading 样式定义
 * 这样用户在 Word 中修改标题样式即可批量更新所有同级标题
 */
function createHeading(token: Tokens.Heading, _style: WordStyleConfig, ctx?: DocxBuildContext): Paragraph {
  const level = token.depth
  const inlineChildren = parseInlineTokens(token.tokens || [], {}, ctx)

  // 仅在主文档上下文（ctx 提供了 cursor 和 list）里包 Bookmark
  // 子上下文（如脚注内容）不包，避免 anchor 重复 / cursor 错位
  let anchor: string | undefined
  if (ctx?.headingAnchorCursor && ctx.headingAnchorList) {
    const idx = ctx.headingAnchorCursor.value
    anchor = ctx.headingAnchorList[idx]
    ctx.headingAnchorCursor.value = idx + 1
  }

  return new Paragraph({
    heading: HEADING_LEVEL_MAP[level] || HeadingLevel.HEADING_1,
    children: anchor
      ? [new Bookmark({ id: anchor, children: inlineChildren }) as unknown as TextRun]
      : inlineChildren
  })
}

/**
 * 从已解析的 tokens 创建段落（用于正确处理粗体、斜体等内联格式）
 */
function createParagraphFromTokens(tokens: Token[], style: WordStyleConfig, ctx?: DocxBuildContext): Paragraph {
  // 获取原始文本用于检测编号规则
  const rawText = tokens.map(t => 'text' in t ? t.text : '').join('')
  const decodedText = decodeHtmlEntities(rawText)
  
  // 检查是否匹配编号规则
  const matchedRule = matchNumberingRule(decodedText, style)
  
  if (matchedRule) {
    const ruleStyle = matchedRule.style

    // 原生自动编号：去除文本中的编号前缀，改用 Word 多级列表自动生成
    if (ruleStyle.numberingLevel != null && ctx?.multiLevelRef) {
      const strippedTokens = stripNumberingPrefix(tokens, matchedRule.pattern)
      return new Paragraph({
        heading: ruleStyle.headingLevel ? HEADING_LEVEL_MAP[ruleStyle.headingLevel] : undefined,
        // 有 headingLevel 时编号由样式定义携带（linkHeadingStylesToNumbering 注入），
        // 切换 Heading 级别时编号自动跟随；无 headingLevel 的级别（如项）仍用段落级编号
        numbering: ruleStyle.headingLevel ? undefined : { reference: ctx.multiLevelRef, level: ruleStyle.numberingLevel },
        children: parseInlineTokens(strippedTokens, {}, ctx)
      })
    }

    // 指定了 headingLevel → 使用文档级别的 Heading 样式，格式由样式定义控制
    if (ruleStyle.headingLevel && HEADING_LEVEL_MAP[ruleStyle.headingLevel]) {
      return new Paragraph({
        heading: HEADING_LEVEL_MAP[ruleStyle.headingLevel],
        children: parseInlineTokens(tokens, {}, ctx)
      })
    }

    // 未指定 headingLevel → 使用内联格式覆盖 Normal 样式
    const indentChars = ruleStyle.indent ?? 0
    const charWidthTwips = (ruleStyle.size || style.config.fontSize || 12) * 20
    const indentTwip = indentChars > 0 ? indentChars * charWidthTwips : undefined
    
    return new Paragraph({
      alignment: getAlignment(ruleStyle.align),
      indent: indentTwip ? { firstLine: indentTwip } : undefined,
      spacing: buildLineSpacing(style.config),
      children: parseInlineTokens(tokens, {
        font: buildFontConfig(
          ruleStyle.font || style.config.font,
          ruleStyle.fontAscii || style.config.fontAscii
        ),
        size: ruleStyle.size || style.config.fontSize,
        bold: ruleStyle.bold,
        italic: ruleStyle.italic
      }, ctx)
    })
  }
  
  // 普通段落：字体和字号由文档 Normal 样式控制，行距由样式控制
  // 仅保留首行缩进为内联设置（因为列表、代码块等不需要缩进）
  const firstLineIndent = calcFirstLineIndent(style.config)
  
  return new Paragraph({
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
    children: parseInlineTokens(tokens, {}, ctx)
  })
}

/**
 * 检测文本是否匹配编号规则
 */
function matchNumberingRule(text: string, style: WordStyleConfig): NumberingRule | null {
  if (!style.config.numberingRules) return null
  
  const trimmedText = text.trim()
  for (const rule of style.config.numberingRules) {
    const regex = new RegExp(rule.pattern)
    if (regex.test(trimmedText)) {
      return rule
    }
  }
  return null
}

/**
 * 去除 Token 列表开头的编号前缀（如"第一章"、"（一）"），用于 Word 原生编号替换
 * 匹配 pattern 及其后的空白字符，从 tokens 文本的开头剥离
 */
function stripNumberingPrefix(tokens: Token[], pattern: string): Token[] {
  const rawText = tokens.map(t => 'text' in t ? t.text : '').join('')
  const decoded = decodeHtmlEntities(rawText)
  const regex = new RegExp(pattern + '[\\s\\u3000]*')
  const match = regex.exec(decoded.trim())
  if (!match) return tokens

  const leadingSpaces = decoded.length - decoded.trimStart().length
  let remaining = leadingSpaces + match[0].length

  const result: Token[] = []
  for (const token of tokens) {
    if (remaining <= 0) {
      result.push(token)
      continue
    }
    if (token.type === 'text' && 'text' in token) {
      const text = decodeHtmlEntities(token.text)
      if (text.length <= remaining) {
        remaining -= text.length
      } else {
        result.push({ ...token, text: text.slice(remaining) } as Token)
        remaining = 0
      }
    } else {
      result.push(token)
    }
  }
  return result
}

/**
 * 创建段落
 */
function createParagraph(text: string, style: WordStyleConfig, ctx?: DocxBuildContext): Paragraph {
  const decodedText = decodeHtmlEntities(text)
  
  // 检查是否匹配编号规则
  const matchedRule = matchNumberingRule(decodedText, style)
  
  if (matchedRule) {
    const ruleStyle = matchedRule.style

    // 原生自动编号：去除编号前缀，改用 Word 多级列表
    if (ruleStyle.numberingLevel != null && ctx?.multiLevelRef) {
      const regex = new RegExp(matchedRule.pattern + '[\\s\\u3000]*')
      const strippedText = decodedText.trim().replace(regex, '')
      return new Paragraph({
        heading: ruleStyle.headingLevel ? HEADING_LEVEL_MAP[ruleStyle.headingLevel] : undefined,
        numbering: ruleStyle.headingLevel ? undefined : { reference: ctx.multiLevelRef, level: ruleStyle.numberingLevel },
        children: [new TextRun({ text: strippedText })]
      })
    }

    // 指定了 headingLevel → 使用文档级别的 Heading 样式
    if (ruleStyle.headingLevel && HEADING_LEVEL_MAP[ruleStyle.headingLevel]) {
      return new Paragraph({
        heading: HEADING_LEVEL_MAP[ruleStyle.headingLevel],
        children: [new TextRun({ text: decodedText })]
      })
    }

    // 未指定 headingLevel → 使用内联格式
    const indentChars = ruleStyle.indent ?? 0
    const charWidthTwips = (ruleStyle.size || style.config.fontSize || 12) * 20
    const indentTwip = indentChars > 0 ? indentChars * charWidthTwips : undefined
    
    return new Paragraph({
      alignment: getAlignment(ruleStyle.align),
      indent: indentTwip ? { firstLine: indentTwip } : undefined,
      spacing: buildLineSpacing(style.config),
      children: [new TextRun({
        text: decodedText,
        font: buildFontConfig(
          ruleStyle.font || style.config.font,
          ruleStyle.fontAscii || style.config.fontAscii
        ),
        size: (ruleStyle.size || style.config.fontSize || 12) * 2,
        bold: ruleStyle.bold,
        italics: ruleStyle.italic
      })]
    })
  }
  
  // 普通段落：字体和字号由文档 Normal 样式控制
  // 解析内联 Markdown（加粗、斜体等）
  const inlineTokens = marked.lexer(text)[0]
  const tokens = inlineTokens && 'tokens' in inlineTokens ? inlineTokens.tokens : undefined
  
  // 仅保留首行缩进为内联设置
  const firstLineIndent = calcFirstLineIndent(style.config)
  
  return new Paragraph({
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
    children: tokens 
      ? parseInlineTokens(tokens, {}, ctx)
      : [new TextRun({
          text: decodedText
        })]
  })
}

/**
 * 内联样式基础类型
 * font 可以是字符串或 { ascii, eastAsia, hAnsi } 对象（由 buildFontConfig 生成）
 */
type InlineBaseStyle = {
  font?: string | { ascii: string; eastAsia: string; hAnsi: string }
  size?: number
  bold?: boolean
  italic?: boolean
  color?: string
}

/**
 * 将含 <br> 的纯文本拆分为 TextRun[]，<br> 转为 Word 换行
 */
function textWithBreaks(text: string, style: Record<string, unknown>): TextRun[] {
  const parts = text.split(/<br\s*\/?>/i)
  const runs: TextRun[] = []
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) runs.push(new TextRun({ break: 1 }))
    if (parts[i]) runs.push(new TextRun({ text: decodeHtmlEntities(parts[i]), ...style }))
  }
  return runs
}

/**
 * 解析内联 tokens（加粗、斜体、链接、图片等）
 * 可选传入 ctx，主要用于解析图片相对路径
 * 返回值可能混合 TextRun 与 ImageRun，两者都是 docx 的 ParagraphChild
 */
function parseInlineTokens(
  tokens: Token[],
  baseStyle: InlineBaseStyle,
  ctx?: DocxBuildContext
): (TextRun | ImageRun)[] {
  const runs: (TextRun | ImageRun)[] = []
  
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        // escape token 用于 \[ \] \\ 等反斜杠转义，文本字段已是去转义后的字面量
        runs.push(new TextRun({
          text: decodeHtmlEntities(token.text),
          font: baseStyle.font,
          size: baseStyle.size ? baseStyle.size * 2 : undefined,
          bold: baseStyle.bold,
          italics: baseStyle.italic,
          color: baseStyle.color
        }))
        break

      case 'strong':
        if ('tokens' in token && token.tokens) {
          runs.push(...parseInlineTokens(token.tokens, { ...baseStyle, bold: true }, ctx))
        }
        break
        
      case 'em':
        if ('tokens' in token && token.tokens) {
          runs.push(...parseInlineTokens(token.tokens, { ...baseStyle, italic: true }, ctx))
        }
        break
        
      case 'codespan':
        runs.push(new TextRun({
          text: decodeHtmlEntities(token.text),
          font: 'Courier New',
          size: baseStyle.size ? baseStyle.size * 2 : undefined,
          shading: { fill: 'F0F0F0' }
        }))
        break
        
      case 'br':
        runs.push(new TextRun({ break: 1 }))
        break

      case 'html': {
        const raw = ((token as { raw?: string; text?: string }).raw || (token as { text?: string }).text || '').trim().toLowerCase()
        if (raw === '<br>' || raw === '<br/>' || raw === '<br />') {
          runs.push(new TextRun({ break: 1 }))
        }
        break
      }

      case 'link': {
        const linkToken = token as Tokens.Link
        const href = linkToken.href || ''
        const label = parseInlineTokens(linkToken.tokens || [], { ...baseStyle, color: '0066CC' }, ctx)

        // 文档内跳转：href 以 # 开头，渲染为 InternalHyperlink
        if (href.startsWith('#')) {
          const anchor = slugify(href.slice(1))
          // 如果目标不存在，仍然渲染为蓝色下划线（等同已知 anchor 的样式），不报错——降级体验
          // docx InternalHyperlink 在 Word 打开时若 anchor 不存在会显示"未找到"
          const linkRun = new InternalHyperlink({
            anchor,
            children: label.length > 0 ? label : [new TextRun({
              text: href,
              color: '0066CC',
              underline: {}
            })]
          })
          // InternalHyperlink 是 ParagraphChild，复用 TextRun 占位
          runs.push(linkRun as unknown as TextRun)
          break
        }

        // 外部链接：保留之前的渲染（仅文字蓝下划线，不挂真实超链）
        for (const t of linkToken.tokens || []) {
          if (t.type === 'text') {
            runs.push(new TextRun({
              text: decodeHtmlEntities(t.text),
              font: baseStyle.font,
              size: baseStyle.size ? baseStyle.size * 2 : undefined,
              color: '0066CC',
              underline: {}
            }))
          }
        }
        break
      }

      case 'image': {
        // 内联图片：默认尺寸略小，便于嵌入文字流
        const imageToken = token as Tokens.Image
        runs.push(createImageRunOrFallback(imageToken, baseStyle, ctx))
        break
      }

      case 'footnoteRef': {
        // 自定义 footnote 扩展的 inline 节点：根据 label 找到 docx 数字 ID
        const ref = token as FootnoteRefToken
        const id = ctx?.footnoteIdByLabel?.get(ref.label)
        if (id != null) {
          runs.push(new FootnoteReferenceRun(id) as unknown as TextRun)
        } else {
          // 引用了未定义的脚注 → 退化为 [^label] 文字
          runs.push(new TextRun({
            text: `[^${ref.label}]`,
            font: baseStyle.font,
            size: baseStyle.size ? baseStyle.size * 2 : undefined,
            color: 'CC0000'
          }))
        }
        break
      }

      default:
        if ('text' in token && token.text) {
          runs.push(new TextRun({
            text: decodeHtmlEntities(token.text),
            font: baseStyle.font,
            size: baseStyle.size ? baseStyle.size * 2 : undefined,
            bold: baseStyle.bold,
            italics: baseStyle.italic,
            color: baseStyle.color
          }))
        }
    }
  }
  
  return runs
}

/**
 * 解析列表项的文本内容（提取内联格式：加粗、斜体等）
 */
function parseListItemContent(item: Tokens.ListItem, ctx?: DocxBuildContext): (TextRun | ImageRun)[] {
  if (item.tokens && item.tokens.length > 0) {
    // item.tokens[0] 通常是 'text' 类型，其 tokens 属性包含真正的内联格式
    const firstToken = item.tokens[0]

    if (firstToken.type === 'text' && 'tokens' in firstToken && firstToken.tokens) {
      const runs = parseInlineTokens(firstToken.tokens, {}, ctx)
      if (runs.length > 0) return runs
    } else if (firstToken.type !== 'list') {
      const inlineTokens = item.tokens.filter(t => t.type !== 'list')
      if (inlineTokens.length > 0) {
        const runs = parseInlineTokens(inlineTokens, {}, ctx)
        if (runs.length > 0) return runs
      }
    }
  }

  return [new TextRun({ text: decodeHtmlEntities(item.text || '') })]
}

/**
 * 创建列表（支持有序/无序，递归处理嵌套）
 */
function createList(token: Tokens.List, style: WordStyleConfig, ctx: DocxBuildContext, parentLevel = 0): Paragraph[] {
  const paragraphs: Paragraph[] = []

  let numberingRef: string | undefined
  if (token.ordered) {
    numberingRef = `ordered-list-${ctx.orderedListCounter++}`
    const cfg = style.config
    const baseIndent = convertInchesToTwip(0.25)
    ctx.numberingConfigs.push({
      reference: numberingRef,
      levels: [{
        level: 0,
        format: LevelFormat.DECIMAL,
        text: '%1.',
        alignment: AlignmentType.START,
        start: typeof token.start === 'number' && token.start > 0 ? token.start : 1,
        style: {
          run: {
            font: buildFontConfig(cfg.font, cfg.fontAscii),
            size: cfg.fontSize ? cfg.fontSize * 2 : undefined
          },
          paragraph: {
            indent: {
              left: baseIndent + parentLevel * baseIndent,
              hanging: baseIndent
            }
          }
        }
      }]
    })
  }

  for (const item of token.items) {
    const children = parseListItemContent(item, ctx)

    if (token.ordered && numberingRef) {
      paragraphs.push(new Paragraph({
        numbering: { reference: numberingRef, level: 0 },
        children
      }))
    } else {
      paragraphs.push(new Paragraph({
        bullet: { level: parentLevel },
        children
      }))
    }

    // 递归处理嵌套列表
    if (item.tokens) {
      for (const sub of item.tokens) {
        if (sub.type === 'list') {
          paragraphs.push(...createList(sub as Tokens.List, style, ctx, parentLevel + 1))
        }
      }
    }
  }

  return paragraphs
}

/**
 * 默认表格单元格内边距（twips，1pt = 20twips）
 */
const DEFAULT_CELL_MARGINS = {
  top: 30,      // 1.5pt
  bottom: 30,   // 1.5pt
  left: 80,     // 4pt
  right: 80     // 4pt
}

/**
 * 创建表格
 * 使用 DXA 单位设置表格宽度（WidthType.PERCENTAGE 在 WPS 和 Google Docs 中渲染异常）
 * 同时设置 columnWidths 和单元格 width 双重宽度（Claude 最佳实践：Tables need dual widths）
 */
function createTable(token: Tokens.Table, style: WordStyleConfig, ctx?: DocxBuildContext): Table {
  const rows: TableRow[] = []
  const config = style.config
  const tc = config.table || {}

  const tableFontSize = tc.fontSize
    ?? (config.fontSize ? Math.max(Math.round(config.fontSize * 0.75), 9) : 10.5)
  const tableFontSizeHalf = tableFontSize * 2

  const tableFont = buildFontConfig(
    tc.font || config.font,
    tc.fontAscii || config.fontAscii
  )

  const border = {
    style: BorderStyle.SINGLE,
    size: tc.borderSize ?? 4,
    color: tc.borderColor || '000000'
  }
  const cellBorders = { top: border, bottom: border, left: border, right: border }

  const cellMargins = tc.cellPadding
    ? { top: tc.cellPadding.top ?? 30, bottom: tc.cellPadding.bottom ?? 30, left: tc.cellPadding.left ?? 80, right: tc.cellPadding.right ?? 80 }
    : DEFAULT_CELL_MARGINS

  const tableCellSpacing = { before: 0, after: 0, line: 240 }

  const headerBold = tc.headerBold !== false
  const headerBg = tc.headerBackground || 'F2F2F2'
  const headerTextColor = tc.headerTextColor
  const headerAlignDefault = tc.headerAlign || 'center'
  const altColors = tc.alternatingColors

  // 计算表格宽度（DXA）：使用页面内容宽度
  const pageResolved = resolvePageConfig(config.page)
  const tableWidthDxa = pageResolved.contentWidth

  // 计算列数和每列等宽（DXA）
  const colCount = token.header?.length || (token.rows[0]?.length ?? 1)
  const colWidthDxa = Math.floor(tableWidthDxa / colCount)
  const columnWidths = Array(colCount).fill(colWidthDxa)
  // 将余数分配给最后一列
  columnWidths[colCount - 1] = tableWidthDxa - colWidthDxa * (colCount - 1)

  if (token.header && token.header.length > 0) {
    rows.push(new TableRow({
      tableHeader: true,
      children: token.header.map((cell, colIdx) => {
        const headerBaseStyle: InlineBaseStyle = {
          font: tableFont,
          size: tableFontSize,
          bold: headerBold,
          color: headerTextColor
        }
        const children = cell.tokens && cell.tokens.length > 0
          ? parseInlineTokens(cell.tokens, headerBaseStyle, ctx)
          : textWithBreaks(cell.text, { font: tableFont, size: tableFontSizeHalf, bold: headerBold, color: headerTextColor })

        const align = token.align?.[colIdx]
        const alignment = align === 'center' ? AlignmentType.CENTER
          : align === 'right' ? AlignmentType.RIGHT
          : getAlignment(headerAlignDefault)

        return new TableCell({
          width: { size: columnWidths[colIdx], type: WidthType.DXA },
          children: [new Paragraph({ children, alignment, spacing: tableCellSpacing })],
          borders: cellBorders,
          verticalAlign: VerticalAlignTable.CENTER,
          margins: cellMargins,
          shading: { type: ShadingType.CLEAR, fill: headerBg, color: 'auto' }
        })
      })
    }))
  }

  for (let rowIdx = 0; rowIdx < token.rows.length; rowIdx++) {
    const row = token.rows[rowIdx]

    const rowShading = altColors
      ? { type: ShadingType.CLEAR, fill: altColors[rowIdx % 2], color: 'auto' }
      : undefined

    rows.push(new TableRow({
      children: row.map((cell, colIdx) => {
        const children = cell.tokens && cell.tokens.length > 0
          ? parseInlineTokens(cell.tokens, { font: tableFont, size: tableFontSize }, ctx)
          : textWithBreaks(cell.text, { font: tableFont, size: tableFontSizeHalf })

        const align = token.align?.[colIdx]
        const alignment = align === 'center' ? AlignmentType.CENTER
          : align === 'right' ? AlignmentType.RIGHT
          : AlignmentType.LEFT

        return new TableCell({
          width: { size: columnWidths[colIdx] ?? colWidthDxa, type: WidthType.DXA },
          children: [new Paragraph({ children, alignment, spacing: tableCellSpacing })],
          borders: cellBorders,
          verticalAlign: VerticalAlignTable.CENTER,
          margins: cellMargins,
          shading: rowShading
        })
      })
    }))
  }

  return new Table({
    width: { size: tableWidthDxa, type: WidthType.DXA },
    columnWidths,
    rows
  })
}

/**
 * 创建代码块
 */
function createCodeBlock(token: Tokens.Code, style: WordStyleConfig): Paragraph {
  const cb = style.config.codeBlock || {}
  return new Paragraph({
    shading: { fill: cb.background || 'F5F5F5' },
    spacing: { before: 200, after: 200 },
    children: [new TextRun({
      text: decodeHtmlEntities(token.text),
      font: cb.font || 'Courier New',
      size: (cb.fontSize || 10) * 2,
      color: cb.color
    })]
  })
}

/**
 * 创建引用块
 */
function createBlockquote(token: Tokens.Blockquote, style: WordStyleConfig): Paragraph {
  const bq = style.config.blockquote || {}
  const useItalic = bq.italic !== false
  const textColor = bq.color || '666666'
  const borderClr = bq.borderColor || 'CCCCCC'

  let children: (TextRun | ImageRun)[] = []
  const baseStyle: InlineBaseStyle = { italic: useItalic, color: textColor }

  if (token.tokens && token.tokens.length > 0) {
    const firstToken = token.tokens[0]

    if ((firstToken.type === 'paragraph' || firstToken.type === 'text') &&
        'tokens' in firstToken && firstToken.tokens) {
      children = parseInlineTokens(firstToken.tokens, baseStyle)
    } else {
      children = parseInlineTokens(token.tokens, baseStyle)
    }
  }

  if (children.length === 0) {
    children = [new TextRun({
      text: decodeHtmlEntities(token.text || ''),
      italics: useItalic,
      color: textColor
    })]
  }

  return new Paragraph({
    indent: { left: convertInchesToTwip(0.5) },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: borderClr }
    },
    children
  })
}

/**
 * 创建水平分割线
 */
function createHorizontalRule(): Paragraph {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' }
    },
    spacing: { before: 200, after: 200 },
    children: []
  })
}

/**
 * HTML 段落解析结果
 */
type HtmlParagraphResult = {
  paragraphs: Paragraph[]
  /** 对齐方式，用于上层判断是否需要插入空行（如落款前空行） */
  align?: string
}

/**
 * 从 HTML 标签创建段落
 * 支持：
 * - <p>内容</p> — 无缩进段落（用于主送机关等需要顶格的行）
 * - <p align="left|center|right|justify">内容</p>
 * - <div style="text-align: left|center|right|justify">内容</div>
 * - <center>内容</center>
 */
function createParagraphFromHtml(
  token: Tokens.HTML,
  _style: WordStyleConfig
): HtmlParagraphResult | null {
  const html = token.text || token.raw || ''
  
  // 提取对齐方式
  let align: string | undefined
  
  // 匹配 align="..." 属性
  const alignMatch = html.match(/align\s*=\s*["']?(left|center|right|justify)["']?/i)
  if (alignMatch) {
    align = alignMatch[1].toLowerCase()
  }
  
  // 匹配 style="text-align: ..." 
  const styleMatch = html.match(/text-align\s*:\s*(left|center|right|justify)/i)
  if (styleMatch) {
    align = styleMatch[1].toLowerCase()
  }
  
  // 匹配 <center> 标签
  if (/<center>/i.test(html)) {
    align = 'center'
  }
  
  // 检测是否为无 align 属性的 <p> 标签（用于主送机关等顶格段落）
  const isPlainPTag = !align && /^<p\s*>/i.test(html.trim())
  
  // 既没有对齐方式，也不是 <p> 标签，返回 null
  if (!align && !isPlainPTag) {
    return null
  }
  
  // 提取内容（先安全移除危险标签，再去除 HTML 标签）
  let content = html
  // 移除 HTML 注释
  content = content.replace(/<!--[\s\S]*?-->/g, '')
  // 循环移除危险标签块直到稳定（防嵌套绕过）
  const _dangerous = ['script', 'style', 'noscript', 'iframe', 'svg', 'object', 'embed']
  for (let _s = 0; _s < 10; _s++) {
    const _before = content
    for (const tag of _dangerous) {
      content = content.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ')
    }
    for (const tag of _dangerous) {
      content = content.replace(new RegExp(`<${tag}(\\s[^>]*)?>`, 'gi'), ' ')
      content = content.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), ' ')
    }
    if (content === _before) break
  }
  content = content
    .replace(/<[^>]+>/g, '')  // 移除所有 HTML 标签
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim()
  
  if (!content) {
    return null
  }
  
  // 按换行分割内容，每行创建一个段落
  const lines = content.split(/\n/).filter(line => line.trim())
  
  const paragraphs = lines.map(line => {
    const trimmedLine = line.trim()
    
    // 使用 marked 解析内联 Markdown 格式（粗体、斜体等）
    // 字体和字号由 Normal 样式控制
    const tokens = marked.lexer(trimmedLine)
    let children: (TextRun | ImageRun)[]
    
    if (tokens.length > 0 && tokens[0].type === 'paragraph' && 'tokens' in tokens[0] && tokens[0].tokens) {
      children = parseInlineTokens(tokens[0].tokens, {})
    } else if (tokens.length > 0 && tokens[0].type === 'text' && 'tokens' in tokens[0] && tokens[0].tokens) {
      children = parseInlineTokens(tokens[0].tokens, {})
    } else {
      children = [new TextRun({
        text: decodeHtmlEntities(trimmedLine)
      })]
    }
    
    return new Paragraph({
      alignment: align ? getAlignment(align) : undefined,
      children
    })
  })

  return { paragraphs, align }
}

export { extractStyleFromTemplate, summarizeExtractedConfig } from './style-extract'

/**
 * 从格式说明文本生成样式配置（AI 辅助）
 * 这个函数返回提示词，让 AI 解析后调用
 */
export function getStyleExtractionPrompt(description: string): string {
  return `请分析以下格式规范说明，提取出文档样式配置。

格式说明：
${description}

请以 JSON 格式返回样式配置，包含以下字段：
{
  "font": "正文字体名称（中文/东亚字体）",
  "fontAscii": "西文字体名称（阿拉伯数字和英文），如 Times New Roman",
  "fontSize": 正文字号（数字，单位磅，如三号字为 16）,
  "lineSpacing": 行距倍数（如 1.5），与 lineSpacingFixed 二选一,
  "lineSpacingFixed": 固定行距（磅），与 lineSpacing 二选一,
  "firstLineIndent": 是否首行缩进（true/false）,
  "firstLineIndentChars": 首行缩进字符数（默认 2）,
  "headings": {
    "1": { "font": "字体", "size": 字号, "bold": true/false, "align": "center/left" },
    "2": { ... },
    ...
  }
}

只返回 JSON，不要其他内容。`
}

