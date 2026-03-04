/**
 * 文档解析服务
 * 用于解析用户上传的文档（PDF、Word、文本等），提取文本内容作为 AI 对话的上下文
 */

import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../utils/logger'

const log = createLogger('DocumentParser')

// 文档解析结果接口
export interface ParsedDocument {
  /** 原始文件名 */
  filename: string
  /** 原始文件完整路径 */
  filePath?: string
  /** 文件类型 */
  fileType: DocumentType
  /** 解析后的文本内容 */
  content: string
  /** 文件大小（字节） */
  fileSize: number
  /** 解析时间（毫秒） */
  parseTime: number
  /** 页数（如果适用） */
  pageCount?: number
  /** 总页数（PDF 渲染时使用，含未渲染的页） */
  totalPages?: number
  /** 渲染的页面图片（扫描件 PDF 用，JPEG data URL） */
  images?: string[]
  /** 元数据 */
  metadata?: Record<string, string>
  /** 错误信息（如果解析失败） */
  error?: string
}

// PDF 页面渲染选项
export interface PdfRenderOptions {
  /** 渲染 DPI，默认 200 */
  dpi?: number
  /** JPEG 质量 0-100，默认 85 */
  quality?: number
}

// 支持的文档类型
export type DocumentType = 
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'xlsx'
  | 'xls'
  | 'txt'
  | 'md'
  | 'json'
  | 'xml'
  | 'html'
  | 'csv'
  | 'unknown'

// 上传的文件信息
export interface UploadedFile {
  /** 文件名 */
  name: string
  /** 文件路径（临时路径或完整路径） */
  path: string
  /** 文件大小 */
  size: number
  /** MIME 类型 */
  mimeType?: string
}

// 文档解析选项
export interface ParseOptions {
  /** 最大文件大小（字节），默认 10MB */
  maxFileSize?: number
  /** 最大提取文本长度（字符），默认 100000 */
  maxTextLength?: number
  /** 是否提取元数据，默认 true */
  extractMetadata?: boolean
  /** 是否提取文档中的嵌入图片（需要视觉模型支持），默认 false */
  extractImages?: boolean
}

// 默认选项
const DEFAULT_OPTIONS: Required<ParseOptions> = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxTextLength: 100000, // 100K 字符
  extractMetadata: true,
  extractImages: false
}

export class DocumentParserService {
  private PDFParser: typeof import('pdf2json').default | null = null
  private mammoth: typeof import('mammoth') | null = null
  private WordExtractor: typeof import('word-extractor').default | null = null
  private ExcelJS: typeof import('exceljs') | null = null
  private isInitialized = false

  constructor() {
    // 延迟加载解析库
  }

  /**
   * 初始化解析器（延迟加载依赖）
   */
  private async init(): Promise<void> {
    if (this.isInitialized) return

    try {
      // 动态导入 pdf2json（纯 Node.js 实现，不依赖浏览器 API）
      const pdf2jsonModule = await import('pdf2json')
      this.PDFParser = pdf2jsonModule.default
    } catch (e) {
      log.warn('pdf2json 未安装，PDF 解析将不可用:', e)
    }

    try {
      // 动态导入 mammoth
      this.mammoth = await import('mammoth')
    } catch (e) {
      log.warn('mammoth 未安装，.docx 解析将不可用:', e)
    }

    try {
      // 动态导入 word-extractor（用于 .doc 格式）
      const wordExtractorModule = await import('word-extractor')
      this.WordExtractor = wordExtractorModule.default
    } catch (e) {
      log.warn('word-extractor 未安装，.doc 解析将不可用:', e)
    }

    try {
      // 动态导入 exceljs（用于 .xlsx/.xls 格式）
      this.ExcelJS = await import('exceljs')
    } catch (e) {
      log.warn('exceljs 未安装，Excel 解析将不可用:', e)
    }

    this.isInitialized = true
  }

  /**
   * 检测文件类型
   */
  detectFileType(filename: string, mimeType?: string): DocumentType {
    const ext = path.extname(filename).toLowerCase()
    
    // 根据扩展名判断
    switch (ext) {
      case '.pdf':
        return 'pdf'
      case '.docx':
        return 'docx'
      case '.doc':
        return 'doc'
      case '.xlsx':
        return 'xlsx'
      case '.xls':
        return 'xls'
      case '.txt':
        return 'txt'
      case '.md':
      case '.markdown':
        return 'md'
      case '.json':
        return 'json'
      case '.xml':
        return 'xml'
      case '.html':
      case '.htm':
        return 'html'
      case '.csv':
        return 'csv'
      default:
        break
    }

    // 根据 MIME 类型判断
    if (mimeType) {
      if (mimeType === 'application/pdf') return 'pdf'
      if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
      if (mimeType === 'application/msword') return 'doc'
      if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
      if (mimeType === 'application/vnd.ms-excel') return 'xls'
      if (mimeType.startsWith('text/')) return 'txt'
      if (mimeType === 'application/json') return 'json'
      if (mimeType === 'application/xml' || mimeType === 'text/xml') return 'xml'
      if (mimeType === 'text/html') return 'html'
      if (mimeType === 'text/csv') return 'csv'
    }

    return 'unknown'
  }

  /**
   * 解析单个文档
   */
  async parseDocument(file: UploadedFile, options?: ParseOptions): Promise<ParsedDocument> {
    await this.init()
    
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const startTime = Date.now()
    const fileType = this.detectFileType(file.name, file.mimeType)

    // 基础结果对象
    const result: ParsedDocument = {
      filename: file.name,
      filePath: file.path,
      fileType,
      content: '',
      fileSize: file.size,
      parseTime: 0
    }

    try {
      // 检查文件大小
      if (file.size > opts.maxFileSize) {
        throw new Error(`文件大小 ${this.formatFileSize(file.size)} 超过限制 ${this.formatFileSize(opts.maxFileSize)}`)
      }

      // 检查文件是否存在
      if (!fs.existsSync(file.path)) {
        throw new Error(`文件不存在: ${file.path}`)
      }

      // 根据文件类型选择解析方法
      switch (fileType) {
        case 'pdf':
          await this.parsePdf(file.path, result, opts)
          break
        case 'docx':
          await this.parseDocx(file.path, result, opts)
          break
        case 'doc':
          await this.parseDoc(file.path, result, opts)
          break
        case 'xlsx':
        case 'xls':
          await this.parseExcel(file.path, result, opts)
          break
        case 'txt':
        case 'md':
        case 'json':
        case 'xml':
        case 'html':
          await this.parseTextFile(file.path, result, opts)
          break
        case 'csv':
          await this.parseCsv(file.path, result, opts)
          break
        default:
          // 尝试作为文本解析
          try {
            await this.parseTextFile(file.path, result, opts)
          } catch {
            result.error = `不支持的文件类型: ${fileType}`
          }
      }

      // 截断过长的内容
      if (result.content.length > opts.maxTextLength) {
        result.content = result.content.substring(0, opts.maxTextLength)
        result.content += `\n\n... [内容已截断，原文共 ${result.content.length} 字符]`
      }

    } catch (error) {
      result.error = error instanceof Error ? error.message : '解析失败'
    }

    result.parseTime = Date.now() - startTime
    return result
  }

  /**
   * 批量解析文档
   */
  async parseDocuments(files: UploadedFile[], options?: ParseOptions): Promise<ParsedDocument[]> {
    const results: ParsedDocument[] = []
    
    for (const file of files) {
      const result = await this.parseDocument(file, options)
      results.push(result)
    }
    
    return results
  }

  /**
   * 解析 PDF 文件
   */
  private async parsePdf(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    if (!this.PDFParser) {
      throw new Error('PDF 解析库未安装，请运行: npm install pdf2json')
    }

    return new Promise((resolve, reject) => {
      const pdfParser = new this.PDFParser!(null, true)  // null = no password, true = return raw text
      
      // 设置超时（30秒）
      const timeout = setTimeout(() => {
        reject(new Error('PDF 解析超时，文件可能过大或格式不支持'))
      }, 30000)
      
      pdfParser.on('pdfParser_dataError', (errData: Error | { parserError: Error }) => {
        clearTimeout(timeout)
        const message = 'parserError' in errData ? errData.parserError.message : errData.message
        reject(new Error(`PDF 解析错误: ${message}`))
      })
      
      pdfParser.on('pdfParser_dataReady', async (pdfData: { Pages: Array<{ Texts: Array<{ R: Array<{ T: string }> }> }> }) => {
        clearTimeout(timeout)
        try {
          // 提取所有文本
          const textContent: string[] = []
          let pageCount = 0
          
          if (pdfData.Pages) {
            pageCount = pdfData.Pages.length
            for (const page of pdfData.Pages) {
              const pageTexts: string[] = []
              if (page.Texts) {
                for (const text of page.Texts) {
                  if (text.R) {
                    for (const r of text.R) {
                      if (r.T) {
                        // 解码 URL 编码的文本
                        try {
                          pageTexts.push(decodeURIComponent(r.T))
                        } catch {
                          // 如果解码失败，使用原始文本
                          pageTexts.push(r.T)
                        }
                      }
                    }
                  }
                }
              }
              textContent.push(pageTexts.join(' '))
            }
          }
          
          result.content = textContent.join('\n\n').trim()
          result.pageCount = pageCount
          
          // 检查是否成功提取到内容
          if (!result.content || result.content.length === 0) {
            if (pageCount > 0) {
              // 扫描件/图片型 PDF：预渲染前 5 页，页数少的可直接处理
              const PREVIEW_PAGES = 5
              const pagesToRender = Array.from({ length: Math.min(pageCount, PREVIEW_PAGES) }, (_, i) => i + 1)
              try {
                const renderResult = await this.renderPdfPages(filePath, pagesToRender)
                result.images = renderResult.images
                result.totalPages = renderResult.totalPages
                result.error = undefined
                log.info(`Scanned PDF detected: ${pageCount} pages, rendered ${renderResult.images.length} preview pages`)
              } catch (renderErr) {
                log.warn('Failed to render scanned PDF page:', renderErr)
                result.error = `PDF 共 ${pageCount} 页，但未能提取到文本内容。该文件可能是扫描件或图片型 PDF。`
              }
            } else {
              result.error = 'PDF 文件为空或格式不支持'
            }
          }
          
          resolve()
        } catch (e) {
          reject(new Error(`PDF 文本提取失败: ${e instanceof Error ? e.message : '未知错误'}`))
        }
      })
      
      pdfParser.loadPDF(filePath)
    })
  }

  /**
   * 解析 Word 文档 (.docx)
   */
  private async parseDocx(filePath: string, result: ParsedDocument, opts: Required<ParseOptions>): Promise<void> {
    if (!this.mammoth) {
      throw new Error('Word 解析库未安装，请运行: npm install mammoth')
    }

    if (opts.extractImages) {
      await this.parseDocxWithImages(filePath, result)
    } else {
      // convertToHtml → Markdown，保留表格等结构信息
      try {
        const htmlResult = await this.mammoth.convertToHtml({ path: filePath })
        result.content = this.mammothHtmlToMarkdown(htmlResult.value)
        this.collectDocxWarnings(htmlResult.messages, result)
      } catch {
        const docxResult = await this.mammoth.extractRawText({ path: filePath })
        result.content = docxResult.value
        this.collectDocxWarnings(docxResult.messages, result)
      }
    }
  }

  /**
   * 从 .docx 一次性提取文本 + 正文嵌入图片 + 表格统计
   * mammoth.convertToHtml 只处理文档正文，页眉/页脚中的图片不会被提取
   */
  private async parseDocxWithImages(filePath: string, result: ParsedDocument): Promise<void> {
    const MAX_IMAGES = 10
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 单张原始大小上限 5MB
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024 // 总图片原始大小上限 20MB
    const images: string[] = []
    let totalBytes = 0

    try {
      const htmlResult = await this.mammoth!.convertToHtml({ path: filePath }, {
        convertImage: this.mammoth!.images.imgElement(
          (image: { contentType: string; read: (encoding: string) => Promise<string> }) => {
            return image.read('base64').then((b64: string) => {
              const rawBytes = b64.length * 3 / 4
              if (images.length < MAX_IMAGES && rawBytes < MAX_IMAGE_BYTES && totalBytes + rawBytes < MAX_TOTAL_BYTES) {
                images.push(`data:${image.contentType};base64,${b64}`)
                totalBytes += rawBytes
              }
              return { src: '' }
            })
          }
        )
      })

      result.content = this.mammothHtmlToMarkdown(htmlResult.value)

      this.collectDocxWarnings(htmlResult.messages, result)

      const tableMatches = htmlResult.value.match(/<table\b[^>]*>/g)
      const tableCount = tableMatches ? tableMatches.length : 0

      if (images.length > 0) {
        result.images = images
        log.info(`Docx images extracted: ${images.length} images, ${tableCount} tables from ${result.filename}`)
      }
      if (tableCount > 0) {
        result.metadata = { ...result.metadata, tableCount: String(tableCount) }
      }
    } catch (err) {
      log.warn('Failed to parse docx with images, falling back to text-only:', err instanceof Error ? err.message : err)
      const docxResult = await this.mammoth!.extractRawText({ path: filePath })
      result.content = docxResult.value
      this.collectDocxWarnings(docxResult.messages, result)
    }
  }

  /**
   * 将 mammoth 输出的语义 HTML 转为 Markdown，保留表格结构且更省 token
   * mammoth 的 HTML 元素集有限：h1-h6, p, table/tr/th/td, strong, em, ul, ol, li, a, br, sup, sub, img
   */
  private mammothHtmlToMarkdown(html: string): string {
    let md = html
      // 移除空 img 占位符（图片提取后的残留）
      .replace(/<img[^>]*src\s*=\s*["']\s*["'][^>]*\/?>/g, '')

    // 1) 表格：先提取并转换，避免后续替换破坏结构
    md = md.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (_match, tableBody: string) => {
      const rows: string[][] = []
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g
      let rowMatch
      while ((rowMatch = rowRegex.exec(tableBody)) !== null) {
        const cells: string[] = []
        const cellRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g
        let cellMatch
        while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
          const text = cellMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          cells.push(text)
        }
        if (cells.length > 0) rows.push(cells)
      }
      if (rows.length === 0) return ''
      const colCount = Math.max(...rows.map(r => r.length))
      const normalize = (row: string[]) => Array.from({ length: colCount }, (_, i) => row[i] ?? '')
      const lines: string[] = []
      lines.push('| ' + normalize(rows[0]).join(' | ') + ' |')
      lines.push('| ' + normalize(rows[0]).map(() => '---').join(' | ') + ' |')
      for (let i = 1; i < rows.length; i++) {
        lines.push('| ' + normalize(rows[i]).join(' | ') + ' |')
      }
      return '\n\n' + lines.join('\n') + '\n\n'
    })

    // 2) 标题
    md = md.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g, (_m, level: string, content: string) => {
      const text = content.replace(/<[^>]+>/g, '').trim()
      return '\n\n' + '#'.repeat(Number(level)) + ' ' + text + '\n\n'
    })

    // 3) 列表（不处理嵌套，mammoth 很少产生深层嵌套）
    md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/g, (_m, items: string) => {
      let idx = 0
      return '\n\n' + items.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_lm: string, content: string) => {
        idx++
        return idx + '. ' + content.replace(/<[^>]+>/g, '').trim() + '\n'
      }).trim() + '\n\n'
    })
    md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/g, (_m, items: string) => {
      return '\n\n' + items.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, (_lm: string, content: string) => {
        return '- ' + content.replace(/<[^>]+>/g, '').trim() + '\n'
      }).trim() + '\n\n'
    })

    // 4) 内联元素
    md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/g, '**$1**')
    md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/g, '*$1*')
    md = md.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
    md = md.replace(/<br\s*\/?>/g, '\n')
    md = md.replace(/<sup[^>]*>([\s\S]*?)<\/sup>/g, '^$1^')

    // 5) 段落
    md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, (_m, content: string) => {
      const text = content.trim()
      return text ? text + '\n\n' : ''
    })

    // 6) 清理残余标签和多余空行
    md = md.replace(/<[^>]+>/g, '')
    md = md.replace(/&nbsp;/g, ' ')
    md = md.replace(/&amp;/g, '&')
    md = md.replace(/&lt;/g, '<')
    md = md.replace(/&gt;/g, '>')
    md = md.replace(/&quot;/g, '"')
    md = md.replace(/\n{3,}/g, '\n\n')

    return md.trim()
  }

  private collectDocxWarnings(messages: Array<{ type: string; message: string }> | undefined, result: ParsedDocument): void {
    if (!messages || messages.length === 0) return
    const warnings = messages
      .filter((m) => m.type === 'warning')
      .map((m) => m.message)
      .join('; ')
    if (warnings) {
      result.metadata = { ...result.metadata, warnings }
    }
  }

  /**
   * 解析 Word 文档 (.doc - 旧版格式)
   */
  private async parseDoc(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    if (!this.WordExtractor) {
      throw new Error('Word (.doc) 解析库未安装，请运行: npm install word-extractor')
    }

    const extractor = new this.WordExtractor()
    const doc = await extractor.extract(filePath)
    
    // 获取文档正文
    result.content = doc.getBody()
    
    // 提取元数据（如果有）
    const headers = doc.getHeaders()
    const footers = doc.getFooters()
    
    if (headers || footers) {
      result.metadata = {}
      if (headers) result.metadata.headers = headers
      if (footers) result.metadata.footers = footers
    }
  }

  /**
   * 解析 Excel 文件 (.xlsx/.xls)
   */
  private async parseExcel(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    if (!this.ExcelJS) {
      throw new Error('Excel 解析库未安装，请运行: npm install exceljs')
    }

    const workbook = new this.ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const parts: string[] = []
    let sheetCount = 0
    let totalRows = 0

    // 遍历所有工作表
    workbook.eachSheet((worksheet) => {
      sheetCount++
      const sheetRows = worksheet.rowCount
      totalRows += sheetRows

      parts.push(`## 工作表: ${worksheet.name}`)
      parts.push(`(${sheetRows} 行 x ${worksheet.columnCount} 列)\n`)

      // 限制每个工作表的行数
      const maxRowsPerSheet = 200
      const maxCols = 20
      const truncatedRows = sheetRows > maxRowsPerSheet
      
      if (truncatedRows) {
        parts.push(`⚠️ 内容已截断（显示前 ${maxRowsPerSheet} 行）\n`)
      }

      // 收集数据行
      const rows: string[][] = []
      let rowIndex = 0
      
      worksheet.eachRow({ includeEmpty: false }, (row, _rowNumber) => {
        if (rowIndex >= maxRowsPerSheet) return
        rowIndex++

        const cells: string[] = []
        
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
          if (colNumber > maxCols) return
          
          // 获取单元格显示值
          let cellValue = ''
          if (cell.value === null || cell.value === undefined) {
            cellValue = ''
          } else if (typeof cell.value === 'object') {
            // 处理富文本、公式结果等
            if ('result' in cell.value) {
              // 公式单元格，获取计算结果
              cellValue = String(cell.value.result ?? '')
            } else if ('richText' in cell.value) {
              // 富文本
              cellValue = (cell.value.richText as Array<{ text: string }>)
                .map(rt => rt.text)
                .join('')
            } else if (cell.value instanceof Date) {
              cellValue = cell.value.toLocaleDateString()
            } else {
              cellValue = String(cell.value)
            }
          } else {
            cellValue = String(cell.value)
          }
          
          cells.push(cellValue)
        })
        
        // 确保有足够的列
        while (cells.length < Math.min(maxCols, worksheet.columnCount)) {
          cells.push('')
        }
        
        rows.push(cells)
      })

      // 生成 Markdown 表格
      if (rows.length > 0) {
        const escapeCell = (cell: string) => 
          cell.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()

        // 如果第一行看起来像表头（通常第一行是表头）
        const headerRow = rows[0]
        parts.push('| ' + headerRow.map(escapeCell).join(' | ') + ' |')
        parts.push('| ' + headerRow.map(() => '---').join(' | ') + ' |')
        
        // 数据行
        for (let i = 1; i < rows.length; i++) {
          parts.push('| ' + rows[i].map(escapeCell).join(' | ') + ' |')
        }
      } else {
        parts.push('（空工作表）')
      }

      parts.push('\n')
    })

    // 添加概览信息
    const summary = `📊 Excel 文件概览：${sheetCount} 个工作表，共 ${totalRows} 行数据\n\n`
    result.content = summary + parts.join('\n')
    result.pageCount = sheetCount
    result.metadata = {
      sheetCount: String(sheetCount),
      totalRows: String(totalRows)
    }
  }

  /**
   * 解析文本文件
   */
  private async parseTextFile(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    // 尝试检测编码并读取
    const content = fs.readFileSync(filePath, 'utf-8')
    result.content = content
  }

  /**
   * 解析 CSV 文件，转换为 Markdown 表格格式
   */
  private async parseCsv(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>): Promise<void> {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())
    
    if (lines.length === 0) {
      result.content = ''
      return
    }

    // 解析 CSV（简单实现，处理基本逗号分隔）
    const parseRow = (line: string): string[] => {
      const cells: string[] = []
      let current = ''
      let inQuotes = false
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i]
        if (char === '"') {
          inQuotes = !inQuotes
        } else if (char === ',' && !inQuotes) {
          cells.push(current.trim())
          current = ''
        } else {
          current += char
        }
      }
      cells.push(current.trim())
      return cells
    }

    const rows = lines.map(parseRow)
    
    // 限制行列数
    const maxRows = 500
    const maxCols = 20
    const truncatedRows = rows.length > maxRows
    const truncatedCols = rows[0] && rows[0].length > maxCols
    
    const displayRows = rows.slice(0, maxRows).map(row => row.slice(0, maxCols))
    
    // 生成 Markdown 表格
    let markdown = ''
    
    if (truncatedRows || truncatedCols) {
      markdown += `⚠️ 表格已截断（共 ${rows.length} 行 x ${rows[0]?.length || 0} 列，显示 ${displayRows.length} 行 x ${displayRows[0]?.length || 0} 列）\n\n`
    }

    if (displayRows.length > 0) {
      // 转义特殊字符
      const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ')
      
      // 表头
      markdown += '| ' + displayRows[0].map(escapeCell).join(' | ') + ' |\n'
      markdown += '| ' + displayRows[0].map(() => '---').join(' | ') + ' |\n'
      
      // 数据行
      for (let i = 1; i < displayRows.length; i++) {
        markdown += '| ' + displayRows[i].map(escapeCell).join(' | ') + ' |\n'
      }
    }

    result.content = markdown
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /**
   * 生成文档摘要（用于显示给用户）
   */
  generateSummary(doc: ParsedDocument): string {
    const lines: string[] = []
    
    lines.push(`📄 **${doc.filename}**`)
    lines.push(`- 类型: ${doc.fileType.toUpperCase()}`)
    lines.push(`- 大小: ${this.formatFileSize(doc.fileSize)}`)
    
    if (doc.pageCount) {
      lines.push(`- 页数: ${doc.pageCount}`)
    }
    
    lines.push(`- 内容长度: ${doc.content.length} 字符`)
    
    if (doc.error) {
      lines.push(`- ⚠️ 错误: ${doc.error}`)
    }
    
    return lines.join('\n')
  }

  /**
   * 将解析结果格式化为 AI 上下文
   * 这一批文档是用户本次上传的，代表最新的参考资料
   */
  formatAsContext(docs: ParsedDocument[]): string {
    if (docs.length === 0) return ''

    const parts: string[] = []
    
    parts.push('<sf_uploaded_docs>\n')
    
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i]
      
      if (doc.error) {
        parts.push(`<sf_doc name="${doc.filename}" error="${doc.error}" />\n`)
        continue
      }
      
      const attrs = doc.pageCount ? ` pages="${doc.pageCount}"` : ''
      parts.push(`<sf_doc name="${doc.filename}"${attrs}>\n`)
      parts.push(doc.content)
      parts.push('\n</sf_doc>\n')
      
      if (i < docs.length - 1) {
        parts.push('\n')
      }
    }
    
    parts.push('</sf_uploaded_docs>')
    
    return parts.join('')
  }

  /**
   * 获取支持的文件类型列表
   */
  getSupportedTypes(): { extension: string; description: string; available: boolean }[] {
    return [
      { extension: '.pdf', description: 'PDF 文档', available: !!this.PDFParser },
      { extension: '.docx', description: 'Word 文档 (2007+)', available: !!this.mammoth },
      { extension: '.doc', description: 'Word 文档 (97-2003)', available: !!this.WordExtractor },
      { extension: '.xlsx', description: 'Excel 表格 (2007+)', available: !!this.ExcelJS },
      { extension: '.xls', description: 'Excel 表格 (97-2003)', available: !!this.ExcelJS },
      { extension: '.txt', description: '纯文本', available: true },
      { extension: '.md', description: 'Markdown', available: true },
      { extension: '.json', description: 'JSON', available: true },
      { extension: '.xml', description: 'XML', available: true },
      { extension: '.html', description: 'HTML', available: true },
      { extension: '.csv', description: 'CSV', available: true }
    ]
  }

  /**
   * 检查解析能力
   */
  async checkCapabilities(): Promise<{
    pdf: boolean
    docx: boolean
    doc: boolean
    xlsx: boolean
    text: boolean
  }> {
    await this.init()
    
    return {
      pdf: !!this.PDFParser,
      docx: !!this.mammoth,
      doc: !!this.WordExtractor,
      xlsx: !!this.ExcelJS,
      text: true
    }
  }

  private pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null
  private napiCanvas: typeof import('@napi-rs/canvas') | null = null

  private static readonly PDF_POINTS_PER_INCH = 72
  private static readonly MAX_RENDER_PAGES = 10
  private static readonly MAX_PDF_FILE_SIZE = 50 * 1024 * 1024 // 50MB

  /**
   * 将 PDF 指定页面渲染为 JPEG 图片
   * 用于扫描件/图片型 PDF 的视觉模型处理
   */
  async renderPdfPages(
    filePath: string,
    pageNumbers: number[],
    options?: PdfRenderOptions
  ): Promise<{ images: string[]; totalPages: number }> {
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`PDF file not found: ${filePath}`)
    }

    const fileSize = fs.statSync(filePath).size
    if (fileSize > DocumentParserService.MAX_PDF_FILE_SIZE) {
      throw new Error(`PDF file too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB (max ${DocumentParserService.MAX_PDF_FILE_SIZE / 1024 / 1024}MB)`)
    }

    if (!pageNumbers || pageNumbers.length === 0) {
      throw new Error('pageNumbers must be a non-empty array')
    }

    const pagesToRender = pageNumbers.slice(0, DocumentParserService.MAX_RENDER_PAGES)

    const dpi = options?.dpi ?? 200
    const quality = options?.quality ?? 85
    const scale = dpi / DocumentParserService.PDF_POINTS_PER_INCH

    if (!this.pdfjsLib) {
      this.pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
    }
    if (!this.napiCanvas) {
      this.napiCanvas = await import('@napi-rs/canvas')
    }

    const data = new Uint8Array(await fs.promises.readFile(filePath))
    const doc = await this.pdfjsLib.getDocument({
      data,
      useSystemFonts: true,
      isEvalSupported: false,
    }).promise

    const totalPages = doc.numPages
    const images: string[] = []
    const { createCanvas } = this.napiCanvas

    const canvasFactory = {
      create(w: number, h: number) {
        const c = createCanvas(w, h)
        return { canvas: c, context: c.getContext('2d') }
      },
      reset(pair: { canvas: ReturnType<typeof createCanvas>; context: unknown }, w: number, h: number) {
        pair.canvas.width = w
        pair.canvas.height = h
      },
      destroy(pair: { canvas: ReturnType<typeof createCanvas> }) {
        pair.canvas.width = 0
        pair.canvas.height = 0
      }
    }

    for (const pageNum of pagesToRender) {
      if (pageNum < 1 || pageNum > totalPages) {
        log.warn(`Page ${pageNum} out of range (1-${totalPages}), skipping`)
        continue
      }

      const page = await doc.getPage(pageNum)
      const viewport = page.getViewport({ scale })
      const width = Math.floor(viewport.width)
      const height = Math.floor(viewport.height)

      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).render({ canvasContext: ctx, viewport, canvasFactory }).promise

      const jpegBuffer = canvas.toBuffer('image/jpeg', quality)
      images.push(`data:image/jpeg;base64,${jpegBuffer.toString('base64')}`)

      log.info(`Rendered page ${pageNum}/${totalPages}: ${width}x${height}, ${(jpegBuffer.length / 1024).toFixed(0)}KB`)
    }

    doc.destroy()
    return { images, totalPages }
  }
}

// 导出单例
let documentParserService: DocumentParserService | null = null

export function getDocumentParserService(): DocumentParserService {
  if (!documentParserService) {
    documentParserService = new DocumentParserService()
  }
  return documentParserService
}
