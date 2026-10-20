/**
 * 终端里拖进来的文件，走桌面贴文件的同一条路：
 * 文档解析后放进这次要说的话，图片按张数和大小的同一上限送去看。
 */

import fs from 'fs'
import path from 'path'
import type { AttachmentInfo } from '@shared/types/agent'
import { getDocumentParserService } from '../services/document-parser.service'

const IMAGE_EXT = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
])

const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export interface MaterializedFiles {
  attachments: AttachmentInfo[]
  documentContext?: string
  images?: string[]
  previewImages?: string[]
  errors: string[]
}

export async function materializeAttachments(paths: string[]): Promise<MaterializedFiles> {
  const parser = getDocumentParserService()
  const docs = []
  const images: string[] = []
  const attachments: AttachmentInfo[] = []
  const errors: string[] = []

  for (const filePath of paths) {
    const name = path.basename(filePath)
    try {
      const stat = await fs.promises.stat(filePath)
      const ext = path.extname(name).toLowerCase()
      const mime = IMAGE_EXT.get(ext)
      if (mime && stat.isFile()) {
        const pathOnly = stat.size > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES
        attachments.push({
          filename: name,
          filePath,
          fileSize: stat.size,
          fileType: ext.slice(1),
          ...(pathOnly ? { imagePathOnly: true } : {}),
        })
        if (!pathOnly) {
          const bytes = await fs.promises.readFile(filePath)
          images.push(`data:${mime};base64,${bytes.toString('base64')}`)
        }
        continue
      }

      const doc = await parser.parseDocument({
        name,
        path: filePath,
        size: stat.size,
      })
      docs.push(doc)
      attachments.push({
        filename: doc.filename || name,
        filePath,
        fileSize: stat.size,
        fileType: doc.fileType,
        ...(doc.pageCount ? { totalPages: doc.pageCount } : {}),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`没附上 ${name}：${message}`)
    }
  }

  const documentContext = docs.length > 0 ? parser.formatAsContext(docs) : ''
  return {
    attachments,
    documentContext: documentContext || undefined,
    images: images.length > 0 ? images : undefined,
    previewImages: images.length > 0 ? images : undefined,
    errors,
  }
}
