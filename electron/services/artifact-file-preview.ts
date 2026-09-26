/**
 * 按磁盘文件重建产出物预览 HTML（不依赖 Electron）。
 * 历史恢复与「打开到面板」共用这一条路径。
 */
import * as fs from 'fs'
import type { CanvasRendererType } from '@shared/types'
import { createLogger } from '../utils/logger'
import { renderExcelWorkbookPreviewHtml, type PreviewWorksheet } from './agent/skills/excel/preview-html'
import { enrichHtmlFonts } from './agent/skills/word/preview-fonts'

const log = createLogger('ArtifactFilePreview')

const MAMMOTH_STYLE_MAP = [
  "p[style-name='Title'] => h1.document-title:fresh",
  'p.Title => h1.document-title:fresh',
  "p[style-name='Subtitle'] => h2.document-subtitle:fresh",
]

async function previewDocxHtml(filePath: string): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToHtml(
    { path: filePath },
    { styleMap: MAMMOTH_STYLE_MAP }
  )
  return enrichHtmlFonts(result.value, filePath)
}

async function previewXlsxHtml(filePath: string): Promise<string> {
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)
  return renderExcelWorkbookPreviewHtml(workbook.worksheets as unknown as readonly PreviewWorksheet[])
}

/** 按 renderer 从磁盘文件重建产出物 preview content */
export async function previewArtifactFromFile(
  filePath: string,
  renderer: CanvasRendererType
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  switch (renderer) {
    case 'markdown':
    case 'html':
      return fs.readFileSync(filePath, 'utf-8')
    case 'document':
      return previewDocxHtml(filePath)
    case 'spreadsheet':
      return previewXlsxHtml(filePath)
    default:
      throw new Error(`Unsupported artifact preview renderer: ${renderer}`)
  }
}

export async function tryPreviewArtifactFromFile(
  filePath: string,
  renderer: CanvasRendererType
): Promise<string | null> {
  try {
    return await previewArtifactFromFile(filePath, renderer)
  } catch (err) {
    log.warn(`Failed to preview ${renderer} from ${filePath}:`, err)
    return null
  }
}
