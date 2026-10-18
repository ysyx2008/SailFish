/**
 * 文档解析服务
 * 用于解析用户上传的文档（PDF、Word、文本等），提取文本内容作为 AI 对话的上下文
 */

import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { createLogger } from '../utils/logger'
import { VisionImageConverter } from '../utils/vision-image'
import { buildPdfDocumentInit } from './pdfjs-config.mjs'
import { extractPdfText } from './pdf-text-extract.mjs'
import { t } from './document-parser.i18n'
import type { DocumentParsePhase, DocumentParseProgress } from '@shared/types'

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
  /** 文件因大小超限被主动跳过（非解析错误） */
  skipped?: boolean
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
  | 'wps'
  | 'et'
  | 'txt'
  | 'md'
  | 'json'
  | 'xml'
  | 'html'
  | 'csv'
  | 'folder'
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
  /** 最大文件大小（字节），默认 10MB。PDF 不看此项，走渲图硬上限。 */
  maxFileSize?: number
  /** 最大提取文本长度（字符），默认 100000 */
  maxTextLength?: number
  /** 是否提取元数据，默认 true */
  extractMetadata?: boolean
  /** 是否提取 Word 等文档的嵌入图片（需要视觉模型支持），默认 false。PDF 是否渲页只看分类，不看此项。 */
  extractImages?: boolean
  /** 本次解析请求 ID（用于前端进度事件关联） */
  requestId?: string
}

type ProgressReporter = (progress: Omit<DocumentParseProgress, 'requestId' | 'fileIndex' | 'fileCount' | 'filename' | 'fileSize'>) => void

interface InternalParseOptions extends ParseOptions {
  onProgress?: ProgressReporter
}

interface BatchParseOptions extends ParseOptions {
  onProgress?: (progress: DocumentParseProgress) => void
}

/** PDF worker → main 进度消息 payload（与 pdf-worker.js 中 sendProgress 对齐） */
interface PdfWorkerProgress {
  phase?: string
  percent?: number
  current?: number
  total?: number
  message?: string
}

type PdfExtractType = 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed'

interface PdfExtractResult {
  content: string
  pageCount: number
  totalPages: number
  pdfType?: PdfExtractType
  pagesNeedingOcr?: number[]
  extractor?: 'layout'
  classifier?: 'inspector'
  textLayerMissing?: boolean
  strippedLines?: number
}

// 默认选项
const DEFAULT_OPTIONS: Required<ParseOptions> = {
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxTextLength: 100000, // 100K 字符
  extractMetadata: true,
  extractImages: false,
  requestId: ''
}

export class DocumentParserService {
  private mammoth: typeof import('mammoth') | null = null
  private WordExtractor: typeof import('word-extractor').default | null = null
  private ExcelJS: typeof import('exceljs') | null = null
  private isInitialized = false

  // PDF worker (utilityProcess) — Electron 环境用子进程隔离 pdfjs-dist
  private pdfWorker: UtilityProcess | null = null
  private pdfWorkerCallbacks = new Map<string, {
    resolve: (v: any) => void
    reject: (e: Error) => void
    onProgress?: (progress: PdfWorkerProgress) => void
  }>()
  private pdfWorkerMsgId = 0
  private readonly visionImages = new VisionImageConverter()

  constructor() {
    // 延迟加载解析库
  }

  /**
   * 初始化解析器（延迟加载依赖）
   */
  private async init(): Promise<void> {
    if (this.isInitialized) return

    try {
      this.mammoth = await import('mammoth')
    } catch (e) {
      log.warn('mammoth 未安装，.docx 解析将不可用:', e)
    }

    try {
      const wordExtractorModule = await import('word-extractor')
      this.WordExtractor = wordExtractorModule.default
    } catch (e) {
      log.warn('word-extractor 未安装，.doc 解析将不可用:', e)
    }

    try {
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
      case '.wps':
      case '.wpt':
        return 'wps'
      case '.et':
      case '.ett':
        return 'et'
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
      if (mimeType === 'application/wps-office.wps' || mimeType === 'application/wps-office.wpt' || mimeType === 'application/kswps') return 'wps'
      if (mimeType === 'application/wps-office.et' || mimeType === 'application/wps-office.ett' || mimeType === 'application/kset') return 'et'
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
  async parseDocument(file: UploadedFile, options?: InternalParseOptions): Promise<ParsedDocument> {
    await this.init()
    
    const opts = { ...DEFAULT_OPTIONS, ...options }
    const report = options?.onProgress
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
      report?.({ status: 'parsing', phase: 'loading', percent: 3 })
      if (!fs.existsSync(file.path)) {
        throw new Error(t('doc.file_not_found', { path: file.path }))
      }

      // 文件夹不读内容、也没有有意义的大小（系统记的是目录项自己的字节数）
      if ((await fs.promises.stat(file.path)).isDirectory()) {
        result.fileType = 'folder'
        result.fileSize = 0
        report?.({ status: 'parsing', phase: 'formatting', percent: 98 })
        result.parseTime = Date.now() - startTime
        return result
      }

      switch (fileType) {
        case 'pdf':
        case 'docx':
        case 'doc':
        case 'xlsx':
        case 'xls':
        case 'wps':
        case 'et':
        case 'txt':
        case 'md':
        case 'json':
        case 'xml':
        case 'html':
        case 'csv': {
          const sizeLimit = fileType === 'pdf'
            ? DocumentParserService.MAX_PDF_FILE_SIZE
            : opts.maxFileSize
          if (file.size > sizeLimit) {
            result.skipped = true
            result.content = t('doc.file_too_large', { name: file.name, size: this.formatFileSize(file.size) })
            break
          }
          if (fileType === 'pdf') await this.parsePdf(file.path, result, opts, report)
          else if (fileType === 'docx') await this.parseDocx(file.path, result, opts, report)
          else if (fileType === 'doc') await this.parseDoc(file.path, result, opts, report)
          else if (fileType === 'xlsx' || fileType === 'xls') await this.parseExcel(file.path, result, opts, report)
          else if (fileType === 'wps') await this.parseWpsWriter(file.path, result, opts, report)
          else if (fileType === 'et') await this.parseWpsSpreadsheet(file.path, result, opts, report)
          else if (fileType === 'csv') await this.parseCsv(file.path, result, opts, report)
          else await this.parseTextFile(file.path, result, opts, report)
          break
        }
        default: {
          if (this.isLikelyBinary(file.path)) {
            result.content = ''
            break
          }
          if (file.size > opts.maxFileSize) {
            result.skipped = true
            result.content = t('doc.file_too_large', { name: file.name, size: this.formatFileSize(file.size) })
            break
          }
          await this.parseTextFile(file.path, result, opts, report)
          break
        }
      }

      // 截断过长的内容
      if (result.content.length > opts.maxTextLength) {
        result.content = result.content.substring(0, opts.maxTextLength)
        result.content += t('doc.content_truncated', { length: result.content.length })
      }
      report?.({ status: 'parsing', phase: 'formatting', percent: 98 })

    } catch (error) {
      result.error = error instanceof Error ? error.message : t('doc.parse_failed')
      report?.({ status: 'failed', phase: 'failed', percent: 100, error: result.error })
    }

    result.parseTime = Date.now() - startTime
    return result
  }

  /**
   * 批量解析文档
   */
  async parseDocuments(files: UploadedFile[], options?: BatchParseOptions): Promise<ParsedDocument[]> {
    const results: ParsedDocument[] = []
    const requestId = options?.requestId || `doc_parse_${Date.now()}`
    const onProgress = options?.onProgress

    const emitFileProgress = (file: UploadedFile, fileIndex: number, progress: Parameters<ProgressReporter>[0]) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent)))
      this.emitDocumentProgress(onProgress, {
        requestId,
        fileIndex,
        fileCount: files.length,
        filename: file.name,
        fileSize: file.size,
        ...progress,
        percent
      })
    }

    files.forEach((file, fileIndex) => {
      this.emitDocumentProgress(onProgress, {
        requestId,
        fileIndex,
        fileCount: files.length,
        filename: file.name,
        fileSize: file.size,
        status: 'queued',
        phase: 'queued',
        percent: 0
      })
    })
    
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]
      const result = await this.parseDocument(file, {
        ...options,
        onProgress: (progress) => emitFileProgress(file, fileIndex, progress)
      })
      results.push(result)
      this.emitDocumentProgress(onProgress, {
        requestId,
        fileIndex,
        fileCount: files.length,
        filename: file.name,
        fileSize: file.size,
        status: result.error ? 'failed' : 'completed',
        phase: result.error ? 'failed' : 'completed',
        percent: 100,
        error: result.error
      })
    }
    
    return results
  }

  private emitDocumentProgress(
    onProgress: ((progress: DocumentParseProgress) => void) | undefined,
    progress: DocumentParseProgress
  ): void {
    onProgress?.(progress)
  }

  private reportProgress(
    report: ProgressReporter | undefined,
    phase: DocumentParsePhase,
    percent: number,
    current?: number,
    total?: number,
    message?: string
  ): void {
    report?.({
      status: 'parsing',
      phase,
      percent,
      current,
      total,
      message
    })
  }

  // ── PDF worker lifecycle ──────────────────────────────────────

  private getPdfWorkerPath(): string {
    if (typeof app?.isPackaged === 'boolean' && app.isPackaged) {
      return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'services', 'pdf-worker.js')
    }
    return path.join(process.cwd(), 'electron', 'services', 'pdf-worker.js')
  }

  private ensurePdfWorker(): UtilityProcess | null {
    if (this.pdfWorker) return this.pdfWorker

    // CLI shim returns null — fall through to direct parsing
    const workerPath = this.getPdfWorkerPath()
    if (!fs.existsSync(workerPath)) {
      log.warn('PDF worker not found:', workerPath)
      return null
    }

    let proc: UtilityProcess | null = null
    try {
      proc = utilityProcess.fork(workerPath, [], { stdio: 'pipe' })
    } catch {
      return null
    }
    if (!proc) return null

    proc.on('message', (message: {
      id: string
      type?: 'progress'
      success?: boolean
      result?: any
      error?: string
      progress?: PdfWorkerProgress
    }) => {
      const cb = this.pdfWorkerCallbacks.get(message.id)
      if (!cb) return
      if (message.type === 'progress') {
        if (message.progress) cb.onProgress?.(message.progress)
        return
      }
      this.pdfWorkerCallbacks.delete(message.id)
      if (message.success) {
        cb.resolve(message.result)
      } else {
        cb.reject(new Error(message.error ?? 'PDF worker error'))
      }
    })

    proc.on('exit', (code) => {
      if (code !== 0) log.warn('PDF worker exited with code', code)
      this.pdfWorker = null
      for (const [id, cb] of this.pdfWorkerCallbacks) {
        cb.reject(new Error(`PDF worker exited unexpectedly (code ${code})`))
        this.pdfWorkerCallbacks.delete(id)
      }
    })

    this.pdfWorker = proc
    return proc
  }

  private sendToPdfWorker<T>(
    type: string,
    data: Record<string, unknown>,
    onProgress?: (progress: PdfWorkerProgress) => void
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = this.ensurePdfWorker()
      if (!worker) {
        reject(new Error('__NO_WORKER__'))
        return
      }
      const id = `pdf_${++this.pdfWorkerMsgId}`
      this.pdfWorkerCallbacks.set(id, { resolve, reject, onProgress })

      worker.postMessage({ type, data, id })

      setTimeout(() => {
        if (this.pdfWorkerCallbacks.has(id)) {
          this.pdfWorkerCallbacks.delete(id)
          reject(new Error('PDF worker response timeout (120s)'))
        }
      }, 120_000)
    })
  }

  /**
   * 关闭 PDF worker（可在服务销毁时调用）
   */
  destroyPdfWorker(): void {
    if (this.pdfWorker) {
      this.pdfWorker.kill()
      this.pdfWorker = null
    }
  }

  // ── PDF parsing (delegates to worker, falls back to direct in CLI) ──

  private async parsePdf(
    filePath: string,
    result: ParsedDocument,
    opts: Required<ParseOptions>,
    report?: ProgressReporter
  ): Promise<void> {
    let parsed: PdfExtractResult
    try {
      parsed = await this.sendToPdfWorker('parsePdf', { filePath, maxTextLength: opts.maxTextLength }, (progress) => {
        this.reportProgress(
          report,
          'extracting-text',
          10 + ((progress.percent ?? 0) * 0.6),
          progress.current,
          progress.total,
          progress.message
        )
      })
    } catch (err: any) {
      if (err?.message === '__NO_WORKER__') {
        parsed = await this.parsePdfDirect(filePath, opts.maxTextLength, (current, total) => {
          this.reportProgress(report, 'extracting-text', 10 + (current / Math.max(total, 1)) * 60, current, total)
        })
      } else {
        throw err
      }
    }

    result.content = parsed.content
    result.pageCount = parsed.pageCount
    result.totalPages = parsed.totalPages
    if (parsed.pdfType) {
      result.metadata = { ...result.metadata, pdfType: parsed.pdfType }
    }
    if (parsed.pdfType) {
      const ocrNote = parsed.pagesNeedingOcr?.length
        ? `, ocr-flagged ${parsed.pagesNeedingOcr.join(',')}`
        : ''
      const stripNote = parsed.strippedLines ? `, stripped ${parsed.strippedLines} head/foot lines` : ''
      const missNote = parsed.textLayerMissing ? ', text layer unreadable' : ''
      log.info(
        `PDF ${parsed.pdfType}: layout reflow, ${parsed.totalPages} pages${ocrNote}${stripNote}${missNote}`
      )
    }

    const PREVIEW_PAGES = 5
    const hasText = result.content.length > 0
    const pdfType = parsed.pdfType
    const ocrPages = (parsed.pagesNeedingOcr ?? []).filter(
      (p) => Number.isInteger(p) && p >= 1 && p <= parsed.totalPages
    )
    const isVisual = pdfType === 'Scanned' || pdfType === 'ImageBased'
    const mixedNeedsOcr = pdfType === 'Mixed' && ocrPages.length > 0
    // 说有文字层却抽不出字（字体缺编码表这类），和没有类型信息又没文字一样，
    // 都只能按图看
    const unreadableText = (!pdfType || parsed.textLayerMissing) && !hasText && parsed.totalPages > 0

    if ((isVisual || mixedNeedsOcr || unreadableText) && parsed.totalPages > 0) {
      const pagesToRender = (ocrPages.length > 0
        ? ocrPages
        : Array.from({ length: Math.min(parsed.totalPages, PREVIEW_PAGES) }, (_, i) => i + 1)
      ).slice(0, PREVIEW_PAGES)
      try {
        const renderResult = await this.renderPdfPages(filePath, pagesToRender, undefined, (current, total) => {
          this.reportProgress(report, 'rendering-preview', 75 + (current / Math.max(total, 1)) * 20, current, total)
        })
        result.images = renderResult.images
        result.totalPages = renderResult.totalPages
        result.error = undefined
        log.info(
          `PDF vision pages: ${parsed.totalPages} total, rendered ${renderResult.images.length} ` +
          `(${pagesToRender.join(',')})`
        )
      } catch (renderErr) {
        log.warn('Failed to render scanned PDF page:', renderErr)
        if (!hasText) {
          result.error = t('doc.scan_pdf_error', { pages: parsed.totalPages })
        }
      }
      if (isVisual || unreadableText) return
    }

    if (!hasText && parsed.totalPages === 0) {
      result.error = t('doc.empty_pdf_error')
      return
    }

    if (parsed.pageCount < parsed.totalPages) {
      log.info(`PDF parsed: ${parsed.pageCount}/${parsed.totalPages} pages extracted`)
    }
  }

  // ── Direct (in-process) fallbacks for CLI mode ──────────────

  private async parsePdfDirect(
    filePath: string,
    maxTextLength: number,
    onPage?: (current: number, total: number) => void
  ): Promise<PdfExtractResult> {
    return extractPdfText(filePath, { maxTextLength, onProgress: onPage })
  }

  /**
   * 解析 Word 文档 (.docx)
   */
  private async parseDocx(filePath: string, result: ParsedDocument, opts: Required<ParseOptions>, report?: ProgressReporter): Promise<void> {
    if (!this.mammoth) {
      throw new Error(t('doc.mammoth_not_installed'))
    }

    this.reportProgress(report, 'converting', 20)
    if (opts.extractImages) {
      await this.parseDocxWithImages(filePath, result)
    } else {
      // convertToHtml → Markdown，保留表格等结构信息
      try {
        this.reportProgress(report, 'converting', 45)
        const htmlResult = await this.mammoth.convertToHtml({ path: filePath })
        this.reportProgress(report, 'formatting', 80)
        result.content = this.mammothHtmlToMarkdown(htmlResult.value)
        this.collectDocxWarnings(htmlResult.messages, result)
      } catch {
        this.reportProgress(report, 'extracting-text', 55)
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
    let skippedUnconverted = 0

    try {
      const htmlResult = await this.mammoth!.convertToHtml({ path: filePath }, {
        convertImage: this.mammoth!.images.imgElement(
          async (image: { contentType: string; read: (encoding: string) => Promise<string> }) => {
            const b64 = await image.read('base64')
            const rawBytes = b64.length * 3 / 4
            if (images.length < MAX_IMAGES && rawBytes < MAX_IMAGE_BYTES && totalBytes + rawBytes < MAX_TOTAL_BYTES) {
              const dataUrl = await this.visionImages.convertToDataUrl(image.contentType, b64)
              if (dataUrl) {
                images.push(dataUrl)
                totalBytes += rawBytes
              } else {
                skippedUnconverted++
              }
            }
            return { src: '' }
          }
        )
      })

      result.content = this.mammothHtmlToMarkdown(htmlResult.value)

      this.collectDocxWarnings(htmlResult.messages, result)

      const tableMatches = htmlResult.value.match(/<table\b[^>]*>/g)
      const tableCount = tableMatches ? tableMatches.length : 0

      if (images.length > 0) {
        result.images = images
      }
      if (images.length > 0 || skippedUnconverted > 0) {
        log.info(
          `Docx images extracted: ${images.length} images` +
          (skippedUnconverted > 0 ? ` (${skippedUnconverted} skipped, conversion failed)` : '') +
          `, ${tableCount} tables from ${result.filename}`
        )
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
   * 新版 WPS 文字/表格常是换后缀的 Office 包；老格式或加密则明确提示另存。
   */
  private sniffOfficeContainer(filePath: string): 'ooxml' | 'ole' | 'unknown' {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(8)
      const n = fs.readSync(fd, buf, 0, 8, 0)
      if (n >= 4 && buf[0] === 0x50 && buf[1] === 0x4B && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
        return 'ooxml'
      }
      if (n >= 4 && buf[0] === 0xD0 && buf[1] === 0xCF && buf[2] === 0x11 && buf[3] === 0xE0) {
        return 'ole'
      }
      return 'unknown'
    } finally {
      fs.closeSync(fd)
    }
  }

  private markWpsUnreadable(result: ParsedDocument, kind: 'writer' | 'sheet'): void {
    result.content = ''
    result.images = undefined
    result.error = t(kind === 'writer' ? 'doc.wps_legacy_unsupported' : 'doc.et_legacy_unsupported')
  }

  private async parseWpsWriter(
    filePath: string,
    result: ParsedDocument,
    opts: Required<ParseOptions>,
    report?: ProgressReporter
  ): Promise<void> {
    if (this.sniffOfficeContainer(filePath) !== 'ooxml') {
      this.markWpsUnreadable(result, 'writer')
      return
    }
    try {
      await this.parseDocx(filePath, result, opts, report)
      if (!result.content?.trim() && !result.images?.length) {
        this.markWpsUnreadable(result, 'writer')
      }
    } catch (err) {
      log.warn('WPS writer parse failed:', err instanceof Error ? err.message : err)
      if (this.isParserLibraryMissing(err)) {
        result.content = ''
        result.images = undefined
        result.error = err instanceof Error ? err.message : t('doc.parse_failed')
        return
      }
      this.markWpsUnreadable(result, 'writer')
    }
  }

  private async parseWpsSpreadsheet(
    filePath: string,
    result: ParsedDocument,
    opts: Required<ParseOptions>,
    report?: ProgressReporter
  ): Promise<void> {
    if (this.sniffOfficeContainer(filePath) !== 'ooxml') {
      this.markWpsUnreadable(result, 'sheet')
      return
    }
    try {
      await this.parseExcel(filePath, result, opts, report)
      if (!result.content?.trim()) {
        this.markWpsUnreadable(result, 'sheet')
      }
    } catch (err) {
      log.warn('WPS spreadsheet parse failed:', err instanceof Error ? err.message : err)
      if (this.isParserLibraryMissing(err)) {
        result.content = ''
        result.images = undefined
        result.error = err instanceof Error ? err.message : t('doc.parse_failed')
        return
      }
      this.markWpsUnreadable(result, 'sheet')
    }
  }

  private isParserLibraryMissing(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err)
    return message === t('doc.mammoth_not_installed') || message === t('doc.exceljs_not_installed')
  }

  /**
   * 解析 Word 文档 (.doc - 旧版格式)
   */
  private async parseDoc(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>, report?: ProgressReporter): Promise<void> {
    if (!this.WordExtractor) {
      throw new Error(t('doc.word_extractor_not_installed'))
    }

    this.reportProgress(report, 'converting', 25)
    const extractor = new this.WordExtractor()
    const doc = await extractor.extract(filePath)
    
    // 获取文档正文
    this.reportProgress(report, 'extracting-text', 75)
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
  private async parseExcel(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>, report?: ProgressReporter): Promise<void> {
    if (!this.ExcelJS) {
      throw new Error(t('doc.exceljs_not_installed'))
    }

    this.reportProgress(report, 'loading', 15)
    const workbook = new this.ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const parts: string[] = []
    let sheetCount = 0
    let totalRows = 0

    const worksheets = workbook.worksheets
    const totalSheets = Math.max(worksheets.length, 1)

    // 遍历所有工作表
    workbook.eachSheet((worksheet) => {
      sheetCount++
      this.reportProgress(report, 'extracting-text', 25 + (sheetCount / totalSheets) * 55, sheetCount, totalSheets)
      const sheetRows = worksheet.rowCount
      totalRows += sheetRows

      parts.push(t('doc.excel_sheet', { name: worksheet.name }))
      parts.push(t('doc.excel_sheet_size', { rows: sheetRows, cols: worksheet.columnCount }) + '\n')

      // 限制每个工作表的行数
      const maxRowsPerSheet = 200
      const maxCols = 20
      const truncatedRows = sheetRows > maxRowsPerSheet
      
      if (truncatedRows) {
        parts.push(t('doc.excel_sheet_truncated', { maxRows: maxRowsPerSheet }) + '\n')
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
            if ('result' in cell.value) {
              cellValue = String(cell.value.result ?? '')
            } else if ('richText' in cell.value) {
              cellValue = (cell.value.richText as Array<{ text: string }>)
                .map(rt => rt.text)
                .join('')
            } else if (cell.value instanceof Date) {
              cellValue = cell.value.toLocaleDateString()
            } else if ('text' in cell.value) {
              cellValue = String((cell.value as { text: string }).text)
            } else if ('error' in cell.value) {
              cellValue = String((cell.value as { error: string }).error)
            } else {
              try { cellValue = JSON.stringify(cell.value) } catch { cellValue = '' }
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
          // 先转义反斜杠，再转义管道符，防止输入中已有的 \ 导致转义失效
          cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()

        // 如果第一行看起来像表头（通常第一行是表头）
        const headerRow = rows[0]
        parts.push('| ' + headerRow.map(escapeCell).join(' | ') + ' |')
        parts.push('| ' + headerRow.map(() => '---').join(' | ') + ' |')
        
        // 数据行
        for (let i = 1; i < rows.length; i++) {
          parts.push('| ' + rows[i].map(escapeCell).join(' | ') + ' |')
        }
      } else {
        parts.push(t('doc.excel_sheet_empty'))
      }

      parts.push('\n')
    })

    // 添加概览信息
    const summary = t('doc.excel_summary', { sheets: sheetCount, rows: totalRows }) + '\n\n'
    result.content = summary + parts.join('\n')
    result.pageCount = sheetCount
    result.metadata = {
      sheetCount: String(sheetCount),
      totalRows: String(totalRows)
    }
  }

  /**
   * 读取文件头部字节，通过 null byte 检测判断是否为二进制文件（与 git 同一策略）
   */
  private isLikelyBinary(filePath: string): boolean {
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const stats = fs.fstatSync(fd)
        if (stats.size < 4) return false
        const buf = Buffer.alloc(Math.min(8000, stats.size))
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0) return true
        }
        return false
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return true
    }
  }

  /**
   * 解析文本文件
   */
  private async parseTextFile(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>, report?: ProgressReporter): Promise<void> {
    // 尝试检测编码并读取
    this.reportProgress(report, 'loading', 25)
    const content = fs.readFileSync(filePath, 'utf-8')
    this.reportProgress(report, 'extracting-text', 85)
    result.content = content
  }

  /**
   * 解析 CSV 文件，转换为 Markdown 表格格式
   */
  private async parseCsv(filePath: string, result: ParsedDocument, _opts: Required<ParseOptions>, report?: ProgressReporter): Promise<void> {
    this.reportProgress(report, 'loading', 20)
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n').filter(line => line.trim())
    
    if (lines.length === 0) {
      result.content = ''
      return
    }

    this.reportProgress(report, 'converting', 45, 0, lines.length)

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

    const rows = lines.map((line, index) => {
      if (index % 200 === 0 || index === lines.length - 1) {
        this.reportProgress(report, 'converting', 45 + (index / Math.max(lines.length, 1)) * 35, index + 1, lines.length)
      }
      return parseRow(line)
    })
    
    // 限制行列数
    const maxRows = 500
    const maxCols = 20
    const truncatedRows = rows.length > maxRows
    const truncatedCols = rows[0] && rows[0].length > maxCols
    
    const displayRows = rows.slice(0, maxRows).map(row => row.slice(0, maxCols))
    
    // 生成 Markdown 表格
    let markdown = ''
    
    if (truncatedRows || truncatedCols) {
      markdown += t('doc.csv_truncated', {
        rows: rows.length,
        cols: rows[0]?.length || 0,
        dispRows: displayRows.length,
        dispCols: displayRows[0]?.length || 0,
      }) + '\n\n'
    }

    if (displayRows.length > 0) {
      // 转义特殊字符（先转义反斜杠，再转义管道符）
      const escapeCell = (cell: string) => cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      
      // 表头
      markdown += '| ' + displayRows[0].map(escapeCell).join(' | ') + ' |\n'
      markdown += '| ' + displayRows[0].map(() => '---').join(' | ') + ' |\n'
      
      // 数据行
      for (let i = 1; i < displayRows.length; i++) {
        markdown += '| ' + displayRows[i].map(escapeCell).join(' | ') + ' |\n'
      }
    }

    this.reportProgress(report, 'formatting', 88, displayRows.length, rows.length)
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
    lines.push(t('doc.summary_type', { type: doc.fileType.toUpperCase() }))
    lines.push(t('doc.summary_size', { size: this.formatFileSize(doc.fileSize) }))

    if (doc.pageCount) {
      lines.push(t('doc.summary_pages', { pages: doc.pageCount }))
    }

    lines.push(t('doc.summary_length', { length: doc.content.length }))

    if (doc.error) {
      lines.push(t('doc.summary_error', { error: doc.error }))
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
      
      const pathAttr = doc.filePath ? ` path="${doc.filePath}"` : ''

      if (doc.error) {
        parts.push(`<sf_doc name="${doc.filename}"${pathAttr} error="${doc.error}">\n`)
        if (doc.filePath) parts.push(`file_path: ${doc.filePath}\n`)
        parts.push('</sf_doc>\n')
        continue
      }
      
      const pagesAttr = doc.pageCount ? ` pages="${doc.pageCount}"` : ''
      
      if (doc.fileType === 'folder' && doc.filePath) {
        parts.push(`<sf_doc name="${doc.filename}"${pathAttr} type="folder" mode="metadata">\n`)
        parts.push(`file_path: ${doc.filePath}\n`)
        parts.push('</sf_doc>\n')
      } else if (!doc.content && doc.filePath) {
        const sizeAttr = doc.fileSize ? ` size="${this.formatFileSize(doc.fileSize)}"` : ''
        parts.push(`<sf_doc name="${doc.filename}"${pathAttr}${sizeAttr} mode="metadata">\n`)
        parts.push(`file_path: ${doc.filePath}\n`)
        parts.push('</sf_doc>\n')
      } else {
        parts.push(`<sf_doc name="${doc.filename}"${pathAttr}${pagesAttr}>\n`)
        parts.push(doc.content)
        parts.push('\n</sf_doc>\n')
      }
      
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
      { extension: '.pdf', description: t('doc.type_pdf'), available: true },
      { extension: '.docx', description: t('doc.type_docx'), available: !!this.mammoth },
      { extension: '.doc', description: t('doc.type_doc'), available: !!this.WordExtractor },
      { extension: '.xlsx', description: t('doc.type_xlsx'), available: !!this.ExcelJS },
      { extension: '.xls', description: t('doc.type_xls'), available: !!this.ExcelJS },
      { extension: '.wps', description: t('doc.type_wps'), available: !!this.mammoth },
      { extension: '.wpt', description: t('doc.type_wpt'), available: !!this.mammoth },
      { extension: '.et', description: t('doc.type_et'), available: !!this.ExcelJS },
      { extension: '.ett', description: t('doc.type_ett'), available: !!this.ExcelJS },
      { extension: '.txt', description: t('doc.type_txt'), available: true },
      { extension: '.md', description: t('doc.type_md'), available: true },
      { extension: '.json', description: t('doc.type_json'), available: true },
      { extension: '.xml', description: t('doc.type_xml'), available: true },
      { extension: '.html', description: t('doc.type_html'), available: true },
      { extension: '.csv', description: t('doc.type_csv'), available: true }
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
      pdf: true,
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
  private static readonly MAX_PDF_FILE_SIZE = 1000 * 1024 * 1024 // 1GB

  /**
   * 加载 pdfjs-dist 并配置 workerSrc。
   * pdfjs-dist 通过 `import(workerSrc)` 加载 fake worker，必须传 file:// URL，
   * 否则 Windows 上原始绝对路径 `C:\\...` 会被 Node ESM 当协议 `c:` 解析而报错。
   */
  private async loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
    if (this.pdfjsLib) return this.pdfjsLib
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
    try {
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
      mod.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
    } catch {
      // 解析不到 worker 文件时，让 pdfjs 走默认行为
    }
    this.pdfjsLib = mod
    return mod
  }

  /**
   * 将 PDF 指定页面渲染为 JPEG 图片
   * 用于扫描件/图片型 PDF 的视觉模型处理
   */
  async renderPdfPages(
    filePath: string,
    pageNumbers: number[],
    options?: PdfRenderOptions,
    onPage?: (current: number, total: number) => void
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

    try {
      return await this.sendToPdfWorker<{ images: string[]; totalPages: number }>('renderPdfPages', {
        filePath, pageNumbers: pagesToRender, dpi, quality,
      }, (progress) => {
        if (progress.current && progress.total) onPage?.(progress.current, progress.total)
      })
    } catch (err: any) {
      if (err?.message === '__NO_WORKER__') {
        return this.renderPdfPagesDirect(filePath, pagesToRender, dpi, quality, onPage)
      }
      throw err
    }
  }

  private async renderPdfPagesDirect(
    filePath: string,
    pagesToRender: number[],
    dpi: number,
    quality: number,
    onPage?: (current: number, total: number) => void
  ): Promise<{ images: string[]; totalPages: number }> {
    const scale = dpi / DocumentParserService.PDF_POINTS_PER_INCH

    const pdfjs = await this.loadPdfjs()
    if (!this.napiCanvas) {
      this.napiCanvas = await import('@napi-rs/canvas')
    }

    const data = new Uint8Array(fs.readFileSync(filePath))
    const doc = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise
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

    for (let index = 0; index < pagesToRender.length; index++) {
      const pageNum = pagesToRender[index]
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
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).render({ canvasContext: ctx, viewport, canvasFactory }).promise
      const jpegBuffer = canvas.toBuffer('image/jpeg', quality)
      images.push(`data:image/jpeg;base64,${jpegBuffer.toString('base64')}`)
      onPage?.(index + 1, pagesToRender.length)
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
