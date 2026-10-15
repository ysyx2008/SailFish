export interface PdfTextExtractResult {
  content: string
  pageCount: number
  totalPages: number
  pdfType?: 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed'
  pagesNeedingOcr?: number[]
  /** 正文来源。坐标还原是唯一一条，结构化抽取件不再供正文 */
  extractor?: 'layout'
  /** 类型判别来源；缺原生组件时没有判别结果 */
  classifier?: 'inspector'
  /** 说有文字层却抽不出一个字（字体缺编码表这类），该照扫描件处理 */
  textLayerMissing?: boolean
  /** 当成页眉页脚去掉的行数，排查「少了几个字」时用 */
  strippedLines?: number
}

/** 入参为 classifyPdf 的 0-indexed 页号，返回 1-indexed */
export function normalizeOcrPages(pages: unknown, totalPages: number): number[]

export function extractPdfText(
  filePath: string,
  opts?: {
    maxTextLength?: number
    onProgress?: (current: number, total: number) => void
  }
): Promise<PdfTextExtractResult>

export function extractPdfTextWithPdfjs(
  filePath: string,
  opts?: {
    maxTextLength?: number
    onProgress?: (current: number, total: number) => void
  }
): Promise<PdfTextExtractResult>
