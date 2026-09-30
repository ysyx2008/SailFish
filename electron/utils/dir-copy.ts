/**
 * 可取消的目录复制（按字节进度）
 *
 * 供数据目录迁移、完整备份/恢复复用。跳过符号链接与指定文件名。
 *
 * 实现约束：不得在主进程长时间同步阻塞（copyFileSync / readdirSync 扫全树），
 * 否则 Electron UI 冻结、进度 IPC 无法送达、取消无法响应。
 */
import * as fs from 'fs'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { createReadStream, createWriteStream } from 'fs'

export interface FileEntry {
  abs: string
  rel: string
  size: number
}

export interface CopyProgress {
  pct: number
  file: string
  bytes: number
  totalBytes: number
}

export class CopyCanceledError extends Error {
  readonly code = 'canceled' as const
  constructor() {
    super('canceled')
    this.name = 'CopyCanceledError'
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

/** 让出事件循环，使 IPC / UI / 取消请求得以处理 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export interface CollectFilesOptions {
  /** 按文件名跳过（任意深度） */
  skipNames?: string[]
  /** 按绝对路径跳过（目录则跳过整棵子树） */
  skipAbsPaths?: string[]
  /**
   * 按相对路径跳过。目录命中则整棵子树不再进入。
   * rel 与 `path.relative` 一致（Windows 上为反斜杠）。
   */
  shouldSkipRel?: (rel: string) => boolean
  shouldCancel?: () => boolean
}

/**
 * 递归收集 source 下所有普通文件（同步，仅供小目录 / 单测）。
 * 跳过符号链接；skipAbsPaths 中的路径及其内部一律跳过。
 */
export function collectFiles(
  source: string,
  options: CollectFilesOptions = {},
): { files: FileEntry[]; totalBytes: number } {
  const skipNames = new Set(options.skipNames ?? [])
  const skipAbs = (options.skipAbsPaths ?? []).map((p) => path.resolve(p))
  const skipRel = options.shouldSkipRel
  const files: FileEntry[] = []
  let totalBytes = 0
  const root = path.resolve(source)

  const shouldSkipAbs = (abs: string): boolean => {
    const resolved = path.resolve(abs)
    return skipAbs.some((s) => samePath(resolved, s) || resolved.startsWith(s + path.sep))
  }

  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (shouldSkipAbs(abs)) continue
      const rel = path.relative(root, abs)
      if (skipRel?.(rel)) continue
      if (entry.isDirectory()) {
        walk(abs)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = fs.statSync(abs).size
        } catch {
          /* ignore */
        }
        files.push({ abs, rel, size })
        totalBytes += size
      }
    }
  }

  walk(root)
  return { files, totalBytes }
}

/** 异步收集；定期让出事件循环并检查取消 */
export async function collectFilesAsync(
  source: string,
  options: CollectFilesOptions = {},
): Promise<{ files: FileEntry[]; totalBytes: number }> {
  const skipNames = new Set(options.skipNames ?? [])
  const skipAbs = (options.skipAbsPaths ?? []).map((p) => path.resolve(p))
  const skipRel = options.shouldSkipRel
  const files: FileEntry[] = []
  let totalBytes = 0
  const root = path.resolve(source)
  let sinceYield = 0

  const shouldSkipAbs = (abs: string): boolean => {
    const resolved = path.resolve(abs)
    return skipAbs.some((s) => samePath(resolved, s) || resolved.startsWith(s + path.sep))
  }

  const maybeYield = async () => {
    if (options.shouldCancel?.()) throw new CopyCanceledError()
    if (++sinceYield < 48) return
    sinceYield = 0
    await yieldToEventLoop()
  }

  const walk = async (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      await maybeYield()
      if (skipNames.has(entry.name)) continue
      if (entry.isSymbolicLink()) continue
      const abs = path.join(dir, entry.name)
      if (shouldSkipAbs(abs)) continue
      const rel = path.relative(root, abs)
      if (skipRel?.(rel)) continue
      if (entry.isDirectory()) {
        await walk(abs)
      } else if (entry.isFile()) {
        let size = 0
        try {
          size = (await fs.promises.stat(abs)).size
        } catch {
          /* ignore */
        }
        files.push({ abs, rel, size })
        totalBytes += size
      }
    }
  }

  await walk(root)
  return { files, totalBytes }
}

export interface CopyDirectoryOptions extends CollectFilesOptions {
  source: string
  target: string
  onProgress?: (p: CopyProgress) => void | Promise<void>
  shouldCancel?: () => boolean
  /** 单文件复制失败时回调；默认打 warn 并跳过 */
  onFileError?: (rel: string, err: unknown) => void
  /** 进度节流毫秒，默认 80 */
  progressIntervalMs?: number
  /** 超过此大小用流式复制以便中途报进度，默认 1MiB */
  streamThresholdBytes?: number
}

const DEFAULT_STREAM_THRESHOLD = 1024 * 1024

async function copyFileStreaming(
  src: string,
  dest: string,
  opts: {
    shouldCancel?: () => boolean
    onBytes?: (copiedInFile: number) => void | Promise<void>
  },
): Promise<void> {
  const read = createReadStream(src)
  const write = createWriteStream(dest)
  let copiedInFile = 0
  let lastReport = 0
  let canceled = false

  read.on('data', (chunk: string | Buffer) => {
    if (canceled) return
    if (opts.shouldCancel?.()) {
      canceled = true
      read.destroy()
      write.destroy()
      return
    }
    const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    copiedInFile += n
    const now = Date.now()
    if (now - lastReport >= 80) {
      lastReport = now
      // 暂停读流，等进度回调与事件循环让出后再继续，避免主进程被 data 事件打满
      read.pause()
      Promise.resolve(opts.onBytes?.(copiedInFile))
        .then(() => yieldToEventLoop())
        .then(() => {
          if (!canceled && !read.destroyed) read.resume()
        })
        .catch(() => {
          canceled = true
          read.destroy()
          write.destroy()
        })
    }
  })

  try {
    await pipeline(read, write)
  } catch (e) {
    if (canceled || (e as Error)?.name === 'CopyCanceledError' || (e as Error)?.message === 'canceled') {
      throw new CopyCanceledError()
    }
    // destroy() 无 error 时 pipeline 可能以 ERR_STREAM_PREMATURE_CLOSE 结束
    if (canceled || (e as NodeJS.ErrnoException)?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      if (opts.shouldCancel?.() || canceled) throw new CopyCanceledError()
    }
    throw e
  }
  if (canceled || opts.shouldCancel?.()) {
    throw new CopyCanceledError()
  }
}

/**
 * 将 source 复制到 target（可取消、不阻塞主进程事件循环）。
 * 取消时抛 {@link CopyCanceledError}；调用方负责清理半成品目录。
 */
export async function copyDirectoryWithProgress(opts: CopyDirectoryOptions): Promise<{
  files: number
  totalBytes: number
}> {
  const {
    source,
    target,
    onProgress,
    shouldCancel,
    onFileError,
    progressIntervalMs = 80,
    streamThresholdBytes = DEFAULT_STREAM_THRESHOLD,
    skipNames,
    skipAbsPaths,
  } = opts

  const skip = [...(skipAbsPaths ?? [])]
  // 防止把目标目录自身再拷进去
  skip.push(path.resolve(target))

  // 扫描阶段也要让 UI 能动：先报 0%
  if (onProgress) {
    await onProgress({ pct: 0, file: '', bytes: 0, totalBytes: 0 })
    await yieldToEventLoop()
  }

  const { files, totalBytes } = await collectFilesAsync(source, {
    skipNames,
    skipAbsPaths: skip,
    shouldCancel,
  })
  await fs.promises.mkdir(target, { recursive: true })

  let copied = 0
  let lastTick = 0
  let pendingEmit: Promise<void> = Promise.resolve()

  const emit = (pct: number, file: string, bytes: number) => {
    if (!onProgress) return
    // 串行化 progress 回调，避免乱序；不阻塞拷贝过久则由 throttle 控制频率
    pendingEmit = pendingEmit.then(async () => {
      await onProgress({ pct, file, bytes, totalBytes })
    })
  }

  const maybeEmit = (file: string, bytes: number, force = false) => {
    const pct = totalBytes > 0 ? Math.min(100, Math.floor((bytes / totalBytes) * 100)) : 100
    const now = Date.now()
    if (force || now - lastTick >= progressIntervalMs || pct === 100) {
      lastTick = now
      emit(pct, file, bytes)
    }
  }

  for (let i = 0; i < files.length; i++) {
    if (shouldCancel?.()) {
      throw new CopyCanceledError()
    }
    const file = files[i]
    const dest = path.join(target, file.rel)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })

    try {
      if (file.size >= streamThresholdBytes) {
        await copyFileStreaming(file.abs, dest, {
          shouldCancel,
          onBytes: (inFile) => {
            maybeEmit(file.rel, copied + inFile)
          },
        })
      } else {
        await fs.promises.copyFile(file.abs, dest)
      }
    } catch (e) {
      if (e instanceof CopyCanceledError) throw e
      if (onFileError) {
        onFileError(file.rel, e)
      } else {
        console.warn('[dir-copy] 复制文件失败，跳过:', file.rel, e)
      }
    }

    copied += file.size
    maybeEmit(file.rel, copied)

    // 定期让出，保证进度 IPC / 取消请求能被处理
    if (i % 4 === 0 || file.size >= streamThresholdBytes) {
      await pendingEmit
      await yieldToEventLoop()
    }
  }

  if (shouldCancel?.()) {
    throw new CopyCanceledError()
  }
  maybeEmit('', copied, true)
  await pendingEmit
  return { files: files.length, totalBytes }
}
