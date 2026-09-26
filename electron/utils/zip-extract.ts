/**
 * ZIP 解压工具（兼容 Windows 中文版 GBK/GB18030 文件名）
 *
 * 国内邮件附件常见由 Windows 压缩，文件名未设置 UTF-8 EFS 标志，
 * 系统 unzip / adm-zip 默认按 UTF-8 解码会导致中文乱码。
 */
import * as fs from 'fs'
import * as path from 'path'
import AdmZip from 'adm-zip'
import iconv from 'iconv-lite'
import { isValidUtf8 } from './encoding'
import { ensureUniquePath } from './unique-path'

export interface ZipExtractResult {
  extractDir: string
  files: string[]
}

/**
 * 解码 ZIP 条目文件名。
 * - EFS 标志位：UTF-8
 * - 合法 UTF-8：UTF-8
 * - 否则：GB18030（覆盖 GBK，适配中文 Windows 压缩包）
 */
export function decodeZipEntryName(rawName: Buffer, useUtf8: boolean): string {
  if (rawName.length === 0) return ''
  if (useUtf8) {
    return rawName.toString('utf8')
  }
  if (isValidUtf8(rawName)) {
    const utf8 = rawName.toString('utf8')
    if (!utf8.includes('\uFFFD')) {
      return utf8
    }
  }
  return iconv.decode(rawName, 'gb18030')
}

/**
 * 将 ZIP 条目安全地映射到目标目录内路径（防 Zip Slip）
 */
export function resolveSafeExtractPath(baseDir: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/')
  const resolved = path.resolve(baseDir, normalized)
  const base = path.resolve(baseDir)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Unsafe zip entry path: ${entryName}`)
  }
  return resolved
}

/**
 * 从 ZIP 文件解压到目标目录，返回已写入的文件路径列表。
 */
export function extractZipFile(zipPath: string, destDir: string): ZipExtractResult {
  const zipBuffer = fs.readFileSync(zipPath)
  return extractZipBuffer(zipBuffer, destDir)
}

/**
 * 从 ZIP Buffer 解压到目标目录。
 */
export function extractZipBuffer(zipBuffer: Buffer, destDir: string): ZipExtractResult {
  const zip = new AdmZip(zipBuffer)
  const files: string[] = []

  fs.mkdirSync(destDir, { recursive: true })

  for (const entry of zip.getEntries()) {
    // ZIP 规范 bit 11：文件名使用 UTF-8。类型定义没暴露 flags_efs，用 flags 位判断
    const utf8Name = (entry.header.flags & 0x800) !== 0
    const entryName = decodeZipEntryName(entry.rawEntryName, utf8Name)
    const targetPath = resolveSafeExtractPath(destDir, entryName)

    if (entry.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true })
      continue
    }

    const uniqueTargetPath = ensureUniquePath(targetPath)
    fs.mkdirSync(path.dirname(uniqueTargetPath), { recursive: true })
    fs.writeFileSync(uniqueTargetPath, entry.getData())
    files.push(uniqueTargetPath)
  }

  return { extractDir: destDir, files }
}

/**
 * 根据 zip 文件路径推导解压目录（去掉 .zip 后缀）
 */
export function defaultExtractDirForZip(zipPath: string): string {
  const parsed = path.parse(zipPath)
  const baseName = parsed.ext.toLowerCase() === '.zip' ? parsed.name : parsed.base
  return path.join(parsed.dir, baseName)
}

/** 推导解压目录，若已存在则自动追加序号避免覆盖 */
export function resolveUniqueExtractDirForZip(zipPath: string): string {
  return ensureUniquePath(defaultExtractDirForZip(zipPath))
}

export function isZipAttachmentFilename(filename: string): boolean {
  return /\.zip$/i.test(filename)
}
