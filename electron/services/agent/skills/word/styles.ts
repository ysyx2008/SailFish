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
  convertInchesToTwip
} from 'docx'
import { marked, Token, Tokens } from 'marked'

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
    size?: number
    bold?: boolean
    italic?: boolean
    center?: boolean
    /** 首行缩进（字符数，0 表示顶格） */
    indent?: number
  }
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
    /** 正文字体 */
    font?: string
    /** 正文字号（磅） */
    fontSize?: number
    /** 行距倍数 */
    lineSpacing?: number
    /** 首行缩进 */
    firstLineIndent?: boolean
    /** 首行缩进字符数（默认 2） */
    firstLineIndentChars?: number
    /** 标题样式（用于 Markdown # 标题） */
    headings?: {
      [level: number]: {
        font?: string
        size?: number
        bold?: boolean
        center?: boolean
      }
    }
    /** 编号层级规则（按优先级排序，先匹配的优先） */
    numberingRules?: NumberingRule[]
  }
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
      }
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
      headings: {
        1: { font: '黑体', size: 22, bold: true, center: true },
        2: { font: '黑体', size: 16, bold: true },
        3: { font: '黑体', size: 14, bold: true },
        4: { font: '宋体', size: 12, bold: true },
        5: { font: '宋体', size: 12, bold: true },
        6: { font: '宋体', size: 12, bold: true }
      }
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
      }
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
        1: { font: 'Times New Roman', size: 16, bold: true, center: true },
        2: { font: 'Times New Roman', size: 14, bold: true },
        3: { font: 'Times New Roman', size: 12, bold: true },
        4: { font: 'Times New Roman', size: 12, bold: true },
        5: { font: 'Times New Roman', size: 12, bold: true },
        6: { font: 'Times New Roman', size: 12, bold: true }
      }
    }
  },
  // 中国党政机关公文格式 (GB/T 9704-2012)
  official: {
    name: '公文格式',
    sourceType: 'preset',
    config: {
      font: '仿宋',
      fontSize: 16,  // 三号字
      lineSpacing: 1.5,
      firstLineIndent: true,
      firstLineIndentChars: 2,
      headings: {
        // 公文标题：二号小标宋体，居中
        1: { font: '小标宋体', size: 22, bold: false, center: true }
      },
      numberingRules: [
        // 一级标题：一、二、三、... 黑体
        {
          pattern: '^[一二三四五六七八九十]+、',
          style: { font: '黑体', size: 16, bold: false, indent: 0 }
        },
        // 二级标题：（一）（二）... 楷体加粗
        {
          pattern: '^（[一二三四五六七八九十]+）',
          style: { font: '楷体', size: 16, bold: true, indent: 0 }
        },
        // 三级标题：1. 2. 3. ... 仿宋加粗
        {
          pattern: '^\\d+\\.',
          style: { font: '仿宋', size: 16, bold: true, indent: 0 }
        },
        // 四级标题：（1）（2）... 仿宋
        {
          pattern: '^（\\d+）',
          style: { font: '仿宋', size: 16, bold: false, indent: 0 }
        }
      ]
    }
  },
  // 证券公司公文格式
  securities: {
    name: '证券公文',
    sourceType: 'preset',
    config: {
      font: '仿宋_GB2312',
      fontSize: 16,  // 三号字
      lineSpacing: 1.5,
      firstLineIndent: true,
      firstLineIndentChars: 2,
      headings: {
        // 公文标题：二号小标宋体，居中
        1: { font: '方正小标宋简体', size: 22, bold: false, center: true }
      },
      numberingRules: [
        // 一级标题：一、二、三、... 黑体
        {
          pattern: '^[一二三四五六七八九十]+、',
          style: { font: '黑体', size: 16, bold: false, indent: 0 }
        },
        // 二级标题：（一）（二）... 楷体_GB2312 加粗
        {
          pattern: '^（[一二三四五六七八九十]+）',
          style: { font: '楷体_GB2312', size: 16, bold: true, indent: 0 }
        },
        // 三级标题：1. 2. 3. ... 仿宋_GB2312 加粗
        {
          pattern: '^\\d+\\.',
          style: { font: '仿宋_GB2312', size: 16, bold: true, indent: 0 }
        },
        // 四级标题：（1）（2）... 仿宋_GB2312
        {
          pattern: '^（\\d+）',
          style: { font: '仿宋_GB2312', size: 16, bold: false, indent: 0 }
        }
      ]
    }
  }
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
 * 将 Markdown 转换为 Word 文档
 */
export async function markdownToDocx(
  markdown: string,
  style?: string | WordStyleConfig
): Promise<Buffer> {
  // 获取样式配置
  const styleConfig = typeof style === 'string' 
    ? getStyleConfig(style) 
    : (style || getStyleConfig())
  
  // 解析 Markdown
  const tokens = marked.lexer(markdown)
  
  // 转换为 docx 元素
  const children = tokensToDocxElements(tokens, styleConfig)
  
  // 创建文档
  const doc = new Document({
    sections: [{
      properties: {},
      children: children.length > 0 ? children : [new Paragraph({ children: [] })]
    }]
  })
  
  // 导出为 Buffer
  return await Packer.toBuffer(doc)
}

/**
 * 将 Markdown tokens 转换为 docx 元素
 */
function tokensToDocxElements(
  tokens: Token[],
  style: WordStyleConfig
): (Paragraph | Table)[] {
  const elements: (Paragraph | Table)[] = []
  
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        elements.push(createHeading(token as Tokens.Heading, style))
        break
        
      case 'paragraph':
        // 使用 token.tokens（已解析的内联格式），而不是 token.text（原始文本）
        const paragraphToken = token as Tokens.Paragraph
        if (paragraphToken.tokens && paragraphToken.tokens.length > 0) {
          elements.push(createParagraphFromTokens(paragraphToken.tokens, style))
        } else {
          elements.push(createParagraph(paragraphToken.text, style))
        }
        break
        
      case 'list':
        elements.push(...createList(token as Tokens.List, style))
        break
        
      case 'table':
        elements.push(createTable(token as Tokens.Table))
        break
        
      case 'code':
        elements.push(createCodeBlock(token as Tokens.Code))
        break
        
      case 'blockquote':
        elements.push(createBlockquote(token as Tokens.Blockquote, style))
        break
        
      case 'hr':
        elements.push(createHorizontalRule())
        break
        
      case 'space':
        // 空行，跳过
        break
        
      default:
        // 其他类型尝试作为段落处理
        if ('text' in token && token.text) {
          elements.push(createParagraph(decodeHtmlEntities(token.text), style))
        }
    }
  }
  
  return elements
}

/**
 * 创建标题
 */
function createHeading(token: Tokens.Heading, style: WordStyleConfig): Paragraph {
  const level = token.depth
  const headingStyle = style.config.headings?.[level] || {}
  
  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  }
  
  return new Paragraph({
    heading: headingMap[level] || HeadingLevel.HEADING_1,
    alignment: headingStyle.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: parseInlineTokens(token.tokens || [], {
      font: headingStyle.font || style.config.font,
      size: headingStyle.size,
      bold: headingStyle.bold ?? true
    })
  })
}

/**
 * 从已解析的 tokens 创建段落（用于正确处理粗体、斜体等内联格式）
 */
function createParagraphFromTokens(tokens: Token[], style: WordStyleConfig): Paragraph {
  // 获取原始文本用于检测编号规则
  const rawText = tokens.map(t => 'text' in t ? t.text : '').join('')
  const decodedText = decodeHtmlEntities(rawText)
  
  // 检查是否匹配编号规则
  const matchedRule = matchNumberingRule(decodedText, style)
  
  if (matchedRule) {
    // 编号规则优先，使用规则样式
    const ruleStyle = matchedRule.style
    const indentChars = ruleStyle.indent ?? 0
    const indentTwip = indentChars > 0 ? convertInchesToTwip(indentChars * 0.35) : undefined
    
    return new Paragraph({
      alignment: ruleStyle.center ? AlignmentType.CENTER : AlignmentType.LEFT,
      indent: indentTwip ? { firstLine: indentTwip } : undefined,
      spacing: {
        line: (style.config.lineSpacing || 1.15) * 240
      },
      children: parseInlineTokens(tokens, {
        font: ruleStyle.font || style.config.font,
        size: ruleStyle.size || style.config.fontSize,
        bold: ruleStyle.bold,
        italic: ruleStyle.italic
      })
    })
  }
  
  // 普通段落
  const indentChars = style.config.firstLineIndentChars ?? 2
  const firstLineIndent = style.config.firstLineIndent 
    ? convertInchesToTwip(indentChars * 0.35)
    : undefined
  
  return new Paragraph({
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
    spacing: {
      line: (style.config.lineSpacing || 1.15) * 240
    },
    children: parseInlineTokens(tokens, {
      font: style.config.font,
      size: style.config.fontSize
    })
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
 * 创建段落
 */
function createParagraph(text: string, style: WordStyleConfig): Paragraph {
  const decodedText = decodeHtmlEntities(text)
  
  // 检查是否匹配编号规则
  const matchedRule = matchNumberingRule(decodedText, style)
  
  if (matchedRule) {
    // 应用编号规则的样式
    const ruleStyle = matchedRule.style
    const indentChars = ruleStyle.indent ?? 0
    // 一个中文字符约等于 0.35 英寸
    const indentTwip = indentChars > 0 ? convertInchesToTwip(indentChars * 0.35) : undefined
    
    return new Paragraph({
      alignment: ruleStyle.center ? AlignmentType.CENTER : AlignmentType.LEFT,
      indent: indentTwip ? { firstLine: indentTwip } : undefined,
      spacing: {
        line: (style.config.lineSpacing || 1.15) * 240
      },
      children: [new TextRun({
        text: decodedText,
        font: ruleStyle.font || style.config.font,
        size: (ruleStyle.size || style.config.fontSize || 12) * 2,
        bold: ruleStyle.bold,
        italics: ruleStyle.italic
      })]
    })
  }
  
  // 普通段落：解析内联 Markdown（加粗、斜体等）
  const inlineTokens = marked.lexer(text)[0]
  const tokens = inlineTokens && 'tokens' in inlineTokens ? inlineTokens.tokens : undefined
  
  // 计算首行缩进
  const indentChars = style.config.firstLineIndentChars ?? 2
  const firstLineIndent = style.config.firstLineIndent 
    ? convertInchesToTwip(indentChars * 0.35)  // 中文字符宽度
    : undefined
  
  return new Paragraph({
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
    spacing: {
      line: (style.config.lineSpacing || 1.15) * 240
    },
    children: tokens 
      ? parseInlineTokens(tokens, {
          font: style.config.font,
          size: style.config.fontSize
        })
      : [new TextRun({
          text: decodedText,
          font: style.config.font,
          size: style.config.fontSize ? style.config.fontSize * 2 : undefined
        })]
  })
}

/**
 * 解析内联 tokens（加粗、斜体、链接等）
 */
function parseInlineTokens(
  tokens: Token[],
  baseStyle: { font?: string; size?: number; bold?: boolean; italic?: boolean }
): TextRun[] {
  const runs: TextRun[] = []
  
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        runs.push(new TextRun({
          text: decodeHtmlEntities(token.text),
          font: baseStyle.font,
          size: baseStyle.size ? baseStyle.size * 2 : undefined,
          bold: baseStyle.bold,
          italics: baseStyle.italic
        }))
        break
        
      case 'strong':
        if ('tokens' in token && token.tokens) {
          runs.push(...parseInlineTokens(token.tokens, { ...baseStyle, bold: true }))
        }
        break
        
      case 'em':
        if ('tokens' in token && token.tokens) {
          runs.push(...parseInlineTokens(token.tokens, { ...baseStyle, italic: true }))
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
        
      case 'link':
        // 链接显示为带下划线的蓝色文本
        if ('tokens' in token && token.tokens) {
          for (const t of token.tokens) {
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
        }
        break
        
      default:
        if ('text' in token && token.text) {
          runs.push(new TextRun({
            text: decodeHtmlEntities(token.text),
            font: baseStyle.font,
            size: baseStyle.size ? baseStyle.size * 2 : undefined,
            bold: baseStyle.bold,
            italics: baseStyle.italic
          }))
        }
    }
  }
  
  return runs
}

/**
 * 创建列表
 */
function createList(token: Tokens.List, style: WordStyleConfig): Paragraph[] {
  const paragraphs: Paragraph[] = []
  
  for (const item of token.items) {
    // 使用 item.tokens（已解析的内联格式）而不是 item.text
    const children = item.tokens && item.tokens.length > 0
      ? parseInlineTokens(item.tokens, {
          font: style.config.font,
          size: style.config.fontSize
        })
      : [new TextRun({
          text: decodeHtmlEntities(item.text || ''),
          font: style.config.font,
          size: style.config.fontSize ? style.config.fontSize * 2 : undefined
        })]
    
    paragraphs.push(new Paragraph({
      bullet: { level: 0 },
      children
    }))
  }
  
  return paragraphs
}

/**
 * 创建表格
 */
function createTable(token: Tokens.Table): Table {
  const rows: TableRow[] = []
  
  // 表头 - 使用 cell.tokens 支持内联格式
  if (token.header && token.header.length > 0) {
    rows.push(new TableRow({
      children: token.header.map(cell => {
        const children = cell.tokens && cell.tokens.length > 0
          ? parseInlineTokens(cell.tokens, { bold: true })
          : [new TextRun({ text: decodeHtmlEntities(cell.text), bold: true })]
        
        return new TableCell({
          children: [new Paragraph({ children })],
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1 },
            bottom: { style: BorderStyle.SINGLE, size: 1 },
            left: { style: BorderStyle.SINGLE, size: 1 },
            right: { style: BorderStyle.SINGLE, size: 1 }
          }
        })
      })
    }))
  }
  
  // 数据行 - 使用 cell.tokens 支持内联格式
  for (const row of token.rows) {
    rows.push(new TableRow({
      children: row.map(cell => {
        const children = cell.tokens && cell.tokens.length > 0
          ? parseInlineTokens(cell.tokens, {})
          : [new TextRun({ text: decodeHtmlEntities(cell.text) })]
        
        return new TableCell({
          children: [new Paragraph({ children })],
          borders: {
            top: { style: BorderStyle.SINGLE, size: 1 },
            bottom: { style: BorderStyle.SINGLE, size: 1 },
            left: { style: BorderStyle.SINGLE, size: 1 },
            right: { style: BorderStyle.SINGLE, size: 1 }
          }
        })
      })
    }))
  }
  
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows
  })
}

/**
 * 创建代码块
 */
function createCodeBlock(token: Tokens.Code): Paragraph {
  return new Paragraph({
    shading: { fill: 'F5F5F5' },
    spacing: { before: 200, after: 200 },
    children: [new TextRun({
      text: decodeHtmlEntities(token.text),
      font: 'Courier New',
      size: 20 // 10pt
    })]
  })
}

/**
 * 创建引用块
 */
function createBlockquote(token: Tokens.Blockquote, style: WordStyleConfig): Paragraph {
  // 使用 token.tokens 支持内联格式
  const children = token.tokens && token.tokens.length > 0
    ? parseInlineTokens(token.tokens, {
        font: style.config.font,
        size: style.config.fontSize,
        italic: true
      })
    : [new TextRun({
        text: decodeHtmlEntities(token.text || ''),
        font: style.config.font,
        size: style.config.fontSize ? style.config.fontSize * 2 : undefined,
        italics: true,
        color: '666666'
      })]
  
  return new Paragraph({
    indent: { left: convertInchesToTwip(0.5) },
    border: {
      left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC' }
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
 * 解析样板文档中的样式（从 .docx 文件提取）
 * TODO: 实现从 styles.xml 提取样式
 */
export async function extractStyleFromTemplate(docxPath: string): Promise<WordStyleConfig> {
  // 这里需要解析 docx 文件的 styles.xml
  // 暂时返回默认样式
  return {
    name: '自定义样式',
    source: docxPath,
    sourceType: 'template',
    config: PRESET_STYLES.simple.config
  }
}

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
  "font": "正文字体名称",
  "fontSize": 正文字号（数字，单位磅）,
  "lineSpacing": 行距倍数（如 1.5）,
  "firstLineIndent": 是否首行缩进（true/false）,
  "headings": {
    "1": { "font": "字体", "size": 字号, "bold": true/false, "center": true/false },
    "2": { ... },
    ...
  }
}

只返回 JSON，不要其他内容。`
}

