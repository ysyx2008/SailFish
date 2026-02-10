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
  convertInchesToTwip
} from 'docx'
import { marked, Token, Tokens } from 'marked'
import JSZip from 'jszip'

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
    /** 首行缩进 */
    firstLineIndent?: boolean
    /** 首行缩进字符数（默认 2） */
    firstLineIndentChars?: number
    /** 标题样式（用于 Markdown # 标题） */
    headings?: {
      [level: number]: {
        font?: string
        /** 西文字体，不设置则继承全局 fontAscii */
        fontAscii?: string
        size?: number
        bold?: boolean
        align?: 'left' | 'center' | 'right' | 'justify'
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
        1: { font: '黑体', size: 22, bold: true, align: 'center' },
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
        1: { font: 'Times New Roman', size: 16, bold: true, align: 'center' },
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
      fontAscii: 'Times New Roman',  // 阿拉伯数字和英文
      fontSize: 16,  // 三号字
      lineSpacingFixed: 28.5,  // 固定行距 27-30 磅
      firstLineIndent: true,
      firstLineIndentChars: 2,
      headings: {
        // 公文标题：二号小标宋体，居中
        1: { font: '小标宋体', size: 22, bold: false, align: 'center' },
        // 一级标题：三号黑体
        2: { font: '黑体', size: 16, bold: false },
        // 二级标题：三号楷体，加粗
        3: { font: '楷体', size: 16, bold: true },
        // 三级标题：三号仿宋，加粗
        4: { font: '仿宋', size: 16, bold: true },
        // 四级标题：三号仿宋
        5: { font: '仿宋', size: 16, bold: false },
        6: { font: '仿宋', size: 16, bold: false }
      },
      numberingRules: [
        // 一级编号：一、二、三、... 与正文同字体，不加粗，顶格
        {
          pattern: '^[一二三四五六七八九十]+、',
          style: { font: '仿宋', size: 16, bold: false, indent: 0 }
        },
        // 二级编号：（一）（二）... 与正文同字体，不加粗，顶格
        {
          pattern: '^（[一二三四五六七八九十]+）',
          style: { font: '仿宋', size: 16, bold: false, indent: 0 }
        },
        // 三级编号：1. 2. 3. ... 与正文同字体，不加粗，顶格
        {
          pattern: '^\\d+[.．]',
          style: { font: '仿宋', size: 16, bold: false, indent: 0 }
        },
        // 四级编号：（1）（2）... 与正文同字体，不加粗，顶格
        {
          pattern: '^（\\d+）',
          style: { font: '仿宋', size: 16, bold: false, indent: 0 }
        }
      ]
    }
  },
  // 证券公司公文格式（参照 GB/T 9704-2012 及国元证券公文处理规范）
  securities: {
    name: '证券公文',
    sourceType: 'preset',
    config: {
      font: '仿宋_GB2312',
      fontAscii: 'Times New Roman',  // 阿拉伯数字和英文使用 Times New Roman
      fontSize: 16,  // 三号字
      lineSpacingFixed: 28.5,  // 固定行距 27-30 磅（取中间值）
      firstLineIndent: true,
      firstLineIndentChars: 2,
      headings: {
        // 公文标题：二号方正小标宋简体，居中
        1: { font: '方正小标宋简体', size: 22, bold: false, align: 'center' },
        // 一级标题：三号黑体
        2: { font: '黑体', size: 16, bold: false },
        // 二级标题：三号楷体_GB2312，加粗
        3: { font: '楷体_GB2312', size: 16, bold: true },
        // 三级标题：三号仿宋_GB2312，加粗
        4: { font: '仿宋_GB2312', size: 16, bold: true },
        // 四级标题：三号仿宋_GB2312
        5: { font: '仿宋_GB2312', size: 16, bold: false },
        6: { font: '仿宋_GB2312', size: 16, bold: false }
      },
      numberingRules: [
        // 一级编号：一、二、三、... 与正文同字体，不加粗，顶格
        {
          pattern: '^[一二三四五六七八九十]+、',
          style: { font: '仿宋_GB2312', size: 16, bold: false, indent: 0 }
        },
        // 二级编号：（一）（二）... 与正文同字体，不加粗，顶格
        {
          pattern: '^（[一二三四五六七八九十]+）',
          style: { font: '仿宋_GB2312', size: 16, bold: false, indent: 0 }
        },
        // 三级编号：1. 2. 3. ... 与正文同字体，不加粗，顶格
        {
          pattern: '^\\d+[.．]',
          style: { font: '仿宋_GB2312', size: 16, bold: false, indent: 0 }
        },
        // 四级编号：（1）（2）... 与正文同字体，不加粗，顶格
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

  // 标题样式 Heading 1-6
  const headingKeys = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6']

  for (let level = 1; level <= 6; level++) {
    const hConfig = config.headings?.[level]
    const key = headingKeys[level - 1]

    if (hConfig) {
      defaultStyles[key] = {
        run: {
          font: buildFontConfig(
            hConfig.font || config.font,
            hConfig.fontAscii || config.fontAscii
          ),
          size: (hConfig.size || config.fontSize || 12) * 2,
          bold: hConfig.bold ?? true,
          color: '000000'
        },
        paragraph: {
          alignment: getAlignment(hConfig.align),
          spacing: { before: 240, after: 120, ...lineSpacing }
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
  
  // 创建文档（包含文档级别的样式定义）
  const doc = new Document({
    styles: buildDocumentStyles(styleConfig),
    sections: [{
      properties: {},
      children: children.length > 0 ? children : [new Paragraph({ children: [] })]
    }]
  })
  
  // 导出为 Buffer
  let buffer = await Packer.toBuffer(doc)

  // 注入自定义主题，确保 Word 不会用默认主题颜色/字体覆盖自定义样式
  buffer = await injectTheme(buffer, styleConfig.config)

  return buffer
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
        
      case 'paragraph': {
        // 使用 token.tokens（已解析的内联格式），而不是 token.text（原始文本）
        const paragraphToken = token as Tokens.Paragraph
        if (paragraphToken.tokens && paragraphToken.tokens.length > 0) {
          elements.push(createParagraphFromTokens(paragraphToken.tokens, style))
        } else {
          elements.push(createParagraph(paragraphToken.text, style))
        }
        break
      }
        
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
        
      case 'html': {
        // 支持 HTML 对齐标签：<p align="right">, <div style="text-align: center"> 等
        const htmlResult = createAlignedParagraphFromHtml(token as Tokens.HTML, style)
        if (htmlResult) {
          elements.push(...htmlResult)
        }
        break
      }
        
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
 * 不设置内联格式，完全依赖文档级别的 Heading 样式定义
 * 这样用户在 Word 中修改标题样式即可批量更新所有同级标题
 */
function createHeading(token: Tokens.Heading, style: WordStyleConfig): Paragraph {
  const level = token.depth
  
  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  }
  
  // 标题的字体、字号、加粗、对齐等均由文档级别的 Heading 样式控制
  // 此处不设置内联格式，仅传递空的 baseStyle，让 TextRun 继承样式
  // Markdown 内联格式（如 **加粗**、*斜体*）仍会被正确处理
  return new Paragraph({
    heading: headingMap[level] || HeadingLevel.HEADING_1,
    children: parseInlineTokens(token.tokens || [], {})
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
    // 编号规则优先，使用规则样式（编号段落需要内联格式覆盖 Normal 样式）
    const ruleStyle = matchedRule.style
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
      })
    })
  }
  
  // 普通段落：字体和字号由文档 Normal 样式控制，行距由样式控制
  // 仅保留首行缩进为内联设置（因为列表、代码块等不需要缩进）
  const firstLineIndent = calcFirstLineIndent(style.config)
  
  return new Paragraph({
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
    children: parseInlineTokens(tokens, {})
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
    // 应用编号规则的样式（编号段落需要内联格式覆盖 Normal 样式）
    const ruleStyle = matchedRule.style
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
      ? parseInlineTokens(tokens, {})
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
 * 解析内联 tokens（加粗、斜体、链接等）
 */
function parseInlineTokens(
  tokens: Token[],
  baseStyle: InlineBaseStyle
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
          italics: baseStyle.italic,
          color: baseStyle.color
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
            italics: baseStyle.italic,
            color: baseStyle.color
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
    let children: TextRun[] = []
    
    if (item.tokens && item.tokens.length > 0) {
      // 列表项的 tokens 结构：item.tokens[0] 是 'text' 类型，其 tokens 属性才是真正的内联格式
      // 例如：item.tokens = [{ type: 'text', text: '**粗体**', tokens: [{ type: 'strong', ... }] }]
      const firstToken = item.tokens[0]
      
      if (firstToken.type === 'text' && 'tokens' in firstToken && firstToken.tokens) {
        // 使用内部的 tokens 数组（包含 strong、em 等内联格式）
        // 字体和字号由文档 listParagraph 样式控制
        children = parseInlineTokens(firstToken.tokens, {})
      } else {
        // 其他情况：直接使用 item.tokens
        children = parseInlineTokens(item.tokens, {})
      }
    }
    
    // 如果没有解析到任何内容，使用原始文本（字体字号由样式控制）
    if (children.length === 0) {
      children = [new TextRun({
        text: decodeHtmlEntities(item.text || '')
      })]
    }
    
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
 * 字体和字号由 Normal 样式控制，仅添加斜体标记
 */
function createBlockquote(token: Tokens.Blockquote, _style: WordStyleConfig): Paragraph {
  let children: TextRun[] = []
  
  if (token.tokens && token.tokens.length > 0) {
    // blockquote.tokens 结构：[{ type: 'paragraph', tokens: [...内联格式...] }]
    const firstToken = token.tokens[0]
    
    if ((firstToken.type === 'paragraph' || firstToken.type === 'text') && 
        'tokens' in firstToken && firstToken.tokens) {
      children = parseInlineTokens(firstToken.tokens, { italic: true })
    } else {
      children = parseInlineTokens(token.tokens, { italic: true })
    }
  }
  
  // 如果没有解析到任何内容，使用原始文本
  if (children.length === 0) {
    children = [new TextRun({
      text: decodeHtmlEntities(token.text || ''),
      italics: true,
      color: '666666'
    })]
  }
  
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
 * 从 HTML 标签创建对齐段落
 * 支持：
 * - <p align="left|center|right|justify">内容</p>
 * - <div style="text-align: left|center|right|justify">内容</div>
 * - <center>内容</center>
 */
function createAlignedParagraphFromHtml(
  token: Tokens.HTML,
  _style: WordStyleConfig
): Paragraph[] | null {
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
  
  // 如果没有识别到对齐方式，返回 null（让 default 处理）
  if (!align) {
    return null
  }
  
  // 提取内容（去除 HTML 标签）
  const content = html
    .replace(/<[^>]+>/g, '')  // 移除所有 HTML 标签
    .trim()
  
  if (!content) {
    return null
  }
  
  // 按换行分割内容，每行创建一个段落
  const lines = content.split(/\n/).filter(line => line.trim())
  
  return lines.map(line => {
    const trimmedLine = line.trim()
    
    // 使用 marked 解析内联 Markdown 格式（粗体、斜体等）
    // 字体和字号由 Normal 样式控制
    const tokens = marked.lexer(trimmedLine)
    let children: TextRun[]
    
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
      alignment: getAlignment(align),
      children
    })
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

