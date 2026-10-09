/**
 * 把没有磁盘路径的用户图片落到历史目录，让 Agent 能像用本地文件一样引用。
 * 跟对话一起留着，不进 scratch，也不按临时区过期。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

const GENERIC_STEM = /^(image|img|photo|picture|screenshot|pasted-image|blob|untitled)(-\d+)?$/i

/** 直接拿去看的单张上限。原样留下的图可以更大，由调用方单独放宽。 */
export const MAX_PASTED_IMAGE_BYTES = 5 * 1024 * 1024
/** 原样另存时的体积上限，避免一次塞进过大的内容 */
export const MAX_KEPT_PASTED_IMAGE_BYTES = 50 * 1024 * 1024

export function getPastedImageDir(): string {
  return path.join(app.getPath('userData'), 'history', 'images', 'pasted')
}

export function isPastedImagePath(filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const dir = path.resolve(getPastedImageDir())
  return resolved === dir || resolved.startsWith(dir + path.sep)
}

export function parseImageDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(dataUrl.trim())
  if (!match) return null
  const mime = match[1].trim().toLowerCase()
  if (!MIME_EXT[mime]) return null
  if (!match[2]) return null
  const data = match[3].replace(/\s+/g, '')
  if (!data) return null
  const buffer = Buffer.from(data, 'base64')
  if (buffer.length === 0) return null
  return { mime, buffer }
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function sanitizeStem(name: string): string {
  const stem = path.basename(name, path.extname(name)).trim()
  if (!stem || GENERIC_STEM.test(stem)) return ''
  return stem.replace(/[^\w\u4e00-\u9fff.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/**
 * 将 data URL 写入历史图片目录，返回绝对路径。
 * 已有真实路径的调用方不应走这里。
 */
export function savePastedImage(
  dataUrl: string,
  suggestedName?: string,
  maxBytes = MAX_PASTED_IMAGE_BYTES,
): string {
  const parsed = parseImageDataUrl(dataUrl)
  if (!parsed) throw new Error('invalid image data url')
  const limit = Math.min(Math.max(1, maxBytes), MAX_KEPT_PASTED_IMAGE_BYTES)
  if (parsed.buffer.length > limit) throw new Error('image too large')
  const ext = MIME_EXT[parsed.mime]
  const dir = getPastedImageDir()
  fs.mkdirSync(dir, { recursive: true })

  const stamp = formatStamp(new Date())
  const stem = suggestedName ? sanitizeStem(suggestedName) : ''
  const base = stem ? `${stem}-${stamp}` : `pasted-${stamp}`

  let filePath = path.join(dir, `${base}.${ext}`)
  let n = 2
  while (fs.existsSync(filePath)) {
    filePath = path.join(dir, `${base}-${n}.${ext}`)
    n++
  }
  fs.writeFileSync(filePath, parsed.buffer)
  return filePath
}

/** 只删我们落下的粘贴图，不动用户本机图。 */
export function deletePastedImage(filePath: string): boolean {
  if (typeof filePath !== 'string' || !filePath || !isPastedImagePath(filePath)) return false
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) return false
    fs.unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
