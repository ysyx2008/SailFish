/**
 * 完整数据备份 / 恢复：.zip 压缩包 + 标记校验
 *
 * 备份格式：ZIP，根目录含 sfterm-backup.json。
 * 恢复由 bootstrap.runStartupRestoreIfNeeded 在启动早期解压到 staging 后替换。
 */
import * as fs from 'fs'
import * as path from 'path'
import { createWriteStream } from 'fs'
import { ZipArchive, type ZipEntryData } from 'archiver'
import yauzl from 'yauzl'
import { app } from 'electron'
import { collectFilesAsync, CopyCanceledError, type CopyProgress } from './dir-copy'
import { resolveSafeExtractPath } from './zip-extract'

export const BACKUP_MARKER_FILENAME = 'sfterm-backup.json'
export const BACKUP_ARCHIVE_SUFFIX = '.zip'
export const RESTORE_STAGING_DIRNAME = '.restore-staging'
/** 恢复替换时暂存旧内容；成功后删除；崩溃残留可供下次启动回滚 */
export const RESTORE_OLD_DIRNAME = '.restore-old'
/** 与 bootstrap 指针文件名一致，备份时跳过 */
export const DATA_LOCATION_FILENAME = 'data-location.json'

export const BACKUP_MARKER_VERSION = 1

const SKIP_ON_BACKUP = new Set([
  DATA_LOCATION_FILENAME,
  RESTORE_STAGING_DIRNAME,
  RESTORE_OLD_DIRNAME,
])

/**
 * 已压缩/二进制扩展名：ZIP STORE 直存，避免无意义的二次压缩拖慢备份。
 * 文本类（json/txt/md/log 等）始终 DEFLATE，即使体积较大。
 */
const STORE_EXTENSIONS = new Set([
  '.zip', '.gz', '.tgz', '.7z', '.rar', '.xz', '.bz2', '.br',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp',
  '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.webm', '.flac',
  '.onnx', '.bin', '.pt', '.pth', '.safetensors', '.gguf', '.npy',
  '.wasm', '.node', '.dylib', '.so', '.dll', '.exe',
  '.woff', '.woff2', '.ttf', '.otf',
  '.pdf', '.docx', '.xlsx', '.pptx',
  '.lance', '.arrow', '.parquet',
])

function shouldStoreEntry(relPath: string): boolean {
  return STORE_EXTENSIONS.has(path.extname(relPath).toLowerCase())
}

export interface BackupMarker {
  version: number
  createdAt: string
  appVersion: string
  /** 备份时的 userData 路径（仅供参考） */
  sourcePath?: string
}

export function isBackupMarker(data: unknown): data is BackupMarker {
  if (!data || typeof data !== 'object') return false
  const m = data as BackupMarker
  return typeof m.version === 'number' && typeof m.createdAt === 'string' && typeof m.appVersion === 'string'
}

export function createBackupMarker(sourcePath?: string): BackupMarker {
  return {
    version: BACKUP_MARKER_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    sourcePath,
  }
}

export function writeBackupMarker(backupDir: string, sourcePath?: string): void {
  const marker = createBackupMarker(sourcePath)
  fs.writeFileSync(path.join(backupDir, BACKUP_MARKER_FILENAME), JSON.stringify(marker, null, 2), 'utf-8')
}

export function readBackupMarker(backupDir: string): BackupMarker | null {
  const markerPath = path.join(backupDir, BACKUP_MARKER_FILENAME)
  if (!fs.existsSync(markerPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    return isBackupMarker(raw) ? raw : null
  } catch {
    return null
  }
}

export type ValidateBackupResult =
  | { ok: true; marker: BackupMarker }
  | { ok: false; error: 'not_found' | 'not_archive' | 'invalid_marker' }

function normalizeArchiveEntryPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

function shouldSkipBackupPath(relPath: string): boolean {
  const parts = normalizeArchiveEntryPath(relPath).split('/').filter(Boolean)
  return parts.some((part) => SKIP_ON_BACKUP.has(part))
}

export function isBackupArchivePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.zip')
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function openZip(filePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('Failed to open zip'))
      else resolve(zip)
    })
  })
}

function readZipEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error('Failed to read zip entry'))
        return
      }
      const chunks: Buffer[] = []
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  })
}

/** 校验路径是否为旗鱼完整备份 zip */
export async function validateBackupArchive(backupPath: string): Promise<ValidateBackupResult> {
  if (!backupPath || !fs.existsSync(backupPath)) {
    return { ok: false, error: 'not_found' }
  }
  let st: fs.Stats
  try {
    st = fs.statSync(backupPath)
  } catch {
    return { ok: false, error: 'not_found' }
  }
  if (!st.isFile() || !isBackupArchivePath(backupPath)) {
    return { ok: false, error: 'not_archive' }
  }

  try {
    const zip = await openZip(backupPath)
    return await new Promise<ValidateBackupResult>((resolve) => {
      let settled = false
      const done = (result: ValidateBackupResult) => {
        if (settled) return
        settled = true
        try { zip.close() } catch { /* ignore */ }
        resolve(result)
      }

      zip.on('error', () => done({ ok: false, error: 'invalid_marker' }))
      zip.on('end', () => done({ ok: false, error: 'invalid_marker' }))
      zip.on('entry', async (entry: yauzl.Entry) => {
        const name = normalizeArchiveEntryPath(entry.fileName)
        if (name === BACKUP_MARKER_FILENAME) {
          try {
            const buf = await readZipEntryBuffer(zip, entry)
            const raw = JSON.parse(buf.toString('utf-8'))
            if (isBackupMarker(raw)) {
              done({ ok: true, marker: raw })
              return
            }
          } catch {
            /* fall through */
          }
          done({ ok: false, error: 'invalid_marker' })
          return
        }
        zip.readEntry()
      })
      zip.readEntry()
    })
  } catch {
    return { ok: false, error: 'invalid_marker' }
  }
}

export interface ExportUserDataOptions {
  source: string
  /** 目标 .zip 文件路径 */
  target: string
  onProgress?: (p: CopyProgress) => void | Promise<void>
  shouldCancel?: () => boolean
}

/**
 * 将 userData 打包为 .zip（含标记文件）。
 * 取消时抛 CopyCanceledError，并删除半成品压缩包。
 *
 * 进度按 archiver 实际读入/压缩的字节（progress 事件），不是入队速度。
 * 先写到 `*.sft-partial`，成功后再 rename 到目标——取消时只删半成品，不毁掉已有备份。
 */
export async function exportUserData(opts: ExportUserDataOptions): Promise<{ files: number; totalBytes: number }> {
  const { source, target, onProgress, shouldCancel } = opts
  fs.mkdirSync(path.dirname(target), { recursive: true })

  const partialPath = `${target}.sft-partial`
  let archive: InstanceType<typeof ZipArchive> | null = null
  let output: fs.WriteStream | null = null

  const cleanupPartial = async () => {
    try { archive?.abort() } catch { /* ignore */ }
    archive = null
    if (output) {
      const stream = output
      output = null
      await new Promise<void>((resolve) => {
        if (stream.destroyed || (stream as fs.WriteStream & { closed?: boolean }).closed) {
          resolve()
          return
        }
        const done = () => resolve()
        stream.once('close', done)
        stream.once('error', done)
        try { stream.destroy() } catch { done() }
      })
    }
    for (let i = 0; i < 8; i++) {
      try {
        if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true })
        if (!fs.existsSync(partialPath)) return
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 40 * (i + 1)))
    }
  }

  try {
    try {
      if (fs.existsSync(partialPath)) fs.rmSync(partialPath, { force: true })
    } catch { /* ignore */ }

    if (onProgress) {
      await onProgress({ pct: 0, file: '', bytes: 0, totalBytes: 0 })
      await yieldToEventLoop()
    }

    const { files, totalBytes } = await collectFilesAsync(source, {
      skipNames: [...SKIP_ON_BACKUP, BACKUP_MARKER_FILENAME],
      shouldCancel,
    })

    const marker = createBackupMarker(source)
    const markerBuf = Buffer.from(JSON.stringify(marker, null, 2), 'utf-8')
    const grandTotal = totalBytes > 0 ? totalBytes : markerBuf.length

    let lastTick = 0
    let currentFile = ''
    const emit = async (file: string, bytes: number, force = false) => {
      if (!onProgress) return
      const now = Date.now()
      if (!force && now - lastTick < 80) return
      lastTick = now
      const capped = Math.min(Math.max(0, bytes), grandTotal)
      const pct = force
        ? 100
        : grandTotal > 0
          ? Math.min(99, Math.floor((capped / grandTotal) * 100))
          : 0
      await onProgress({ pct, file, bytes: capped, totalBytes: grandTotal })
      await yieldToEventLoop()
    }

    if (shouldCancel?.()) throw new CopyCanceledError()

    output = createWriteStream(partialPath)
    archive = new ZipArchive({ zlib: { level: 1 } })

    let rejectCanceled: ((err: Error) => void) | null = null
    const canceled = new Promise<never>((_, reject) => {
      rejectCanceled = reject
    })

    const abortIfCanceled = (): boolean => {
      if (!shouldCancel?.()) return false
      try { archive?.abort() } catch { /* ignore */ }
      rejectCanceled?.(new CopyCanceledError())
      return true
    }

    archive.on('error', (err: Error) => { rejectCanceled?.(err) })
    archive.on('warning', (err: Error & { code?: string }) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') rejectCanceled?.(err)
    })
    archive.on('entry', (entry: { name?: string }) => {
      if (entry?.name) currentFile = entry.name
    })
    archive.on('progress', (p: { fs: { processedBytes: number } }) => {
      if (abortIfCanceled()) return
      void emit(currentFile, p.fs.processedBytes)
    })

    const closed = new Promise<void>((resolve, reject) => {
      output!.on('close', () => resolve())
      output!.on('error', reject)
    })

    archive.pipe(output)
    archive.append(markerBuf, { name: BACKUP_MARKER_FILENAME })

    const pack = (async () => {
      for (let i = 0; i < files.length; i++) {
        if (abortIfCanceled()) throw new CopyCanceledError()
        const file = files[i]
        const zipName = normalizeArchiveEntryPath(file.rel)
        archive!.file(file.abs, {
          name: zipName,
          // 已压缩/大文件直存，显著缩短备份时间（体积接近）
          store: shouldStoreEntry(zipName),
        } as ZipEntryData)
        if (i % 64 === 0) await yieldToEventLoop()
      }
      if (abortIfCanceled()) throw new CopyCanceledError()
      await archive!.finalize()
      await closed
    })()

    await Promise.race([pack, canceled])

    if (shouldCancel?.()) throw new CopyCanceledError()

    // 成功后再替换最终路径，避免覆盖中途取消毁掉旧备份
    try {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true })
    } catch { /* ignore */ }
    fs.renameSync(partialPath, target)
    output = null
    archive = null

    await emit('', grandTotal, true)
    return { files: files.length + 1, totalBytes: grandTotal }
  } catch (e) {
    await cleanupPartial()
    if (e instanceof CopyCanceledError) throw e
    if (shouldCancel?.()) throw new CopyCanceledError()
    throw e
  }
}

export interface ExtractBackupOptions {
  archive: string
  staging: string
  onProgress?: (p: CopyProgress) => void | Promise<void>
  shouldCancel?: () => boolean
}

/**
 * 将备份 zip 解压到 staging（跳过 data-location 等）。
 */
export async function extractBackupToStaging(opts: ExtractBackupOptions): Promise<{ files: number; totalBytes: number }> {
  const { archive, staging, onProgress, shouldCancel } = opts
  fs.mkdirSync(staging, { recursive: true })

  const zip = await openZip(archive)

  // 先扫一遍总量
  let totalBytes = 0
  let fileCount = 0
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', () => resolve())
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = normalizeArchiveEntryPath(entry.fileName)
      if (!shouldSkipBackupPath(name) && !/\/$/.test(entry.fileName)) {
        totalBytes += entry.uncompressedSize || 0
        fileCount += 1
      }
      zip.readEntry()
    })
    zip.readEntry()
  })

  // lazyEntries + autoClose 在 end 后已关闭；重新打开做解压
  const zip2 = await openZip(archive)

  let extracted = 0
  let lastTick = 0
  const emit = async (file: string, bytes: number, force = false) => {
    if (!onProgress) return
    const now = Date.now()
    const pct = totalBytes > 0 ? Math.min(100, Math.floor((bytes / totalBytes) * 100)) : 100
    if (!force && now - lastTick < 80 && pct < 100) return
    lastTick = now
    await onProgress({ pct, file, bytes, totalBytes })
    await yieldToEventLoop()
  }

  await emit('', 0, true)

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      try { zip2.close() } catch { /* ignore */ }
      reject(err)
    }
    const ok = () => {
      if (settled) return
      settled = true
      resolve()
    }

    zip2.on('error', fail)
    zip2.on('end', () => ok())
    zip2.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          if (shouldCancel?.()) throw new CopyCanceledError()
          const name = normalizeArchiveEntryPath(entry.fileName)
          if (shouldSkipBackupPath(name) || /\/$/.test(entry.fileName)) {
            zip2.readEntry()
            return
          }

          const targetPath = resolveSafeExtractPath(staging, name)
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })

          await new Promise<void>((res, rej) => {
            zip2.openReadStream(entry, (err, readStream) => {
              if (err || !readStream) {
                rej(err ?? new Error('Failed to open entry stream'))
                return
              }
              const writeStream = createWriteStream(targetPath)
              readStream.on('error', rej)
              writeStream.on('error', rej)
              writeStream.on('finish', res)
              readStream.pipe(writeStream)
            })
          })

          extracted += entry.uncompressedSize || 0
          await emit(name, extracted)
          zip2.readEntry()
        } catch (e) {
          fail(e)
        }
      })()
    })
    zip2.readEntry()
  })

  if (shouldCancel?.()) throw new CopyCanceledError()
  await emit('', extracted, true)
  return { files: fileCount, totalBytes }
}

/**
 * 用 staging 内容替换 userData（两阶段，尽量可回滚）。
 */
export function replaceUserDataFromStaging(
  userData: string,
  staging: string,
  options?: { keepNames?: string[] },
): void {
  const keepNames = new Set(
    options?.keepNames ?? [
      DATA_LOCATION_FILENAME,
      RESTORE_STAGING_DIRNAME,
      RESTORE_OLD_DIRNAME,
    ],
  )
  const oldDir = path.join(userData, RESTORE_OLD_DIRNAME)
  if (fs.existsSync(oldDir)) {
    fs.rmSync(oldDir, { recursive: true, force: true })
  }
  fs.mkdirSync(oldDir, { recursive: true })

  try {
    for (const entry of fs.readdirSync(userData)) {
      if (keepNames.has(entry) || entry === RESTORE_OLD_DIRNAME) continue
      fs.renameSync(path.join(userData, entry), path.join(oldDir, entry))
    }
    for (const entry of fs.readdirSync(staging)) {
      if (entry === BACKUP_MARKER_FILENAME) continue
      fs.renameSync(path.join(staging, entry), path.join(userData, entry))
    }
  } catch (e) {
    try {
      if (fs.existsSync(oldDir)) {
        for (const entry of fs.readdirSync(oldDir)) {
          const dest = path.join(userData, entry)
          if (!fs.existsSync(dest)) {
            fs.renameSync(path.join(oldDir, entry), dest)
          }
        }
      }
    } catch {
      /* ignore secondary failure */
    }
    throw e
  }

  try {
    fs.rmSync(staging, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(oldDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/**
 * 启动时清理上次崩溃残留的恢复目录（若仍有 .restore-old，优先迁回）。
 */
export function recoverInterruptedRestore(userData: string): boolean {
  const oldDir = path.join(userData, RESTORE_OLD_DIRNAME)
  const staging = path.join(userData, RESTORE_STAGING_DIRNAME)
  let recovered = false
  if (fs.existsSync(oldDir)) {
    try {
      for (const entry of fs.readdirSync(oldDir)) {
        const dest = path.join(userData, entry)
        if (!fs.existsSync(dest)) {
          fs.renameSync(path.join(oldDir, entry), dest)
          recovered = true
        }
      }
      fs.rmSync(oldDir, { recursive: true, force: true })
    } catch (e) {
      console.error('[data-backup] 回滚 .restore-old 失败:', e)
    }
  }
  if (fs.existsSync(staging)) {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
  return recovered
}

export { CopyCanceledError }
export type { CopyProgress }
