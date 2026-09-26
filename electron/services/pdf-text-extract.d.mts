export interface PdfTextExtractResult {
  content: string
  pageCount: number
  totalPages: number
  pdfType?: 'TextBased' | 'Scanned' | 'ImageBased' | 'Mixed'
  pagesNeedingOcr?: number[]
  extractor?: 'inspector' | 'pdfjs'
}

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
