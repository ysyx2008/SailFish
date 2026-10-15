/**
 * 语音识别可选模型包（ASR + 标点）生命周期
 * 契约见 SPEC.md
 */
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import { app, BrowserWindow } from 'electron'
import { createLogger } from '../../utils/logger'
import { extractZipFile } from '../../utils/zip-extract'
import { speechPackUrls } from '@shared/oem-resolve'

const log = createLogger('SpeechPack')

export const SPEECH_PACK_ID = 'speech-asr-punct'
export const SUPPORTED_SPEECH_PACK_FORMAT = 1
export const RECOMMENDED_PACK_VERSION = '1.0.0'

export const LEGACY_ASR_DIR_NAME = 'sherpa-onnx-paraformer-zh-2024-03-09'
export const LEGACY_PUNCT_DIR_NAME =
  'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8'

/** 约 290MB；设置页展示用 */
export const SPEECH_PACK_APPROX_BYTES = 305_000_000

function packSourceUrls(): { github: string | null; oss: string | null } {
  return speechPackUrls(RECOMMENDED_PACK_VERSION)
}

export interface SpeechPackModelPaths {
  dir: string
  model: string
  tokens?: string
}

export interface SpeechPackManifest {
  id: string
  format: number
  packVersion: string
  approxSizeBytes?: number
  asr: SpeechPackModelPaths
  punct?: SpeechPackModelPaths
}

export type SpeechPackSource = 'userData' | 'bundled' | 'none'

export interface SpeechPackStatus {
  available: boolean
  source: SpeechPackSource
  packVersion: string | null
  format: number | null
  supportedFormat: number
  recommendedVersion: string
  approxSizeBytes: number
  installRoot: string | null
  error?: string
}

export interface SpeechPackProgress {
  phase: 'download' | 'extract' | 'migrate' | 'done' | 'error'
  percent: number
  downloaded?: number
  total?: number
  /** 瞬时/平滑下载速度（字节/秒），仅 download 阶段有意义 */
  bytesPerSecond?: number
  /** 预计剩余秒数；速度未知或总量未知时省略 */
  etaSeconds?: number
  message?: string
}

export function getPackDownloadUrls(): { github: string; oss: string; version: string } {
  const urls = packSourceUrls()
  return {
    github: urls.github ?? '',
    oss: urls.oss ?? '',
    version: RECOMMENDED_PACK_VERSION,
  }
}

export function getUserDataSpeechRoot(): string {
  return path.join(app.getPath('userData'), 'models', 'speech')
}

/** 用户主动卸载后写入；存在时忽略 resources 内置模型回落 */
function getOptOutPath(): string {
  return path.join(app.getPath('userData'), 'models', 'speech-pack.opt-out')
}

function isOptedOut(): boolean {
  return fs.existsSync(getOptOutPath())
}

function setOptOut(enabled: boolean): void {
  const p = getOptOutPath()
  if (enabled) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `${new Date().toISOString()}\n`, 'utf8')
  } else if (fs.existsSync(p)) {
    fs.unlinkSync(p)
  }
}

function clearOptOut(): void {
  setOptOut(false)
}

function getBundledSpeechRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'speech')
  }
  return path.join(process.cwd(), 'resources', 'models', 'speech')
}

function defaultManifest(): SpeechPackManifest {
  return {
    id: SPEECH_PACK_ID,
    format: SUPPORTED_SPEECH_PACK_FORMAT,
    packVersion: RECOMMENDED_PACK_VERSION,
    approxSizeBytes: SPEECH_PACK_APPROX_BYTES,
    asr: {
      dir: path.join('paraformer', LEGACY_ASR_DIR_NAME),
      model: 'model.int8.onnx',
      tokens: 'tokens.txt',
    },
    punct: {
      dir: path.join('punctuation', LEGACY_PUNCT_DIR_NAME),
      model: 'model.int8.onnx',
    },
  }
}

function readManifest(root: string): SpeechPackManifest | null {
  const manifestPath = path.join(root, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as SpeechPackManifest
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch (err) {
    log.warn('Failed to parse manifest:', err)
    return null
  }
}

function writeManifest(root: string, manifest: SpeechPackManifest): void {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function filesComplete(root: string, manifest: SpeechPackManifest): boolean {
  const asrModel = path.join(root, manifest.asr.dir, manifest.asr.model)
  const asrTokens = manifest.asr.tokens
    ? path.join(root, manifest.asr.dir, manifest.asr.tokens)
    : null
  if (!fs.existsSync(asrModel) || fs.statSync(asrModel).size <= 0) return false
  if (asrTokens && (!fs.existsSync(asrTokens) || fs.statSync(asrTokens).size <= 0)) return false
  if (manifest.punct) {
    const punctModel = path.join(root, manifest.punct.dir, manifest.punct.model)
    if (!fs.existsSync(punctModel) || fs.statSync(punctModel).size <= 0) return false
  }
  return true
}

function validateManifest(manifest: SpeechPackManifest): string | null {
  if (manifest.id !== SPEECH_PACK_ID) {
    return `不支持的语音包 id: ${manifest.id}`
  }
  if (manifest.format !== SUPPORTED_SPEECH_PACK_FORMAT) {
    return `语音包 format=${manifest.format} 与当前应用不兼容（需要 ${SUPPORTED_SPEECH_PACK_FORMAT}）`
  }
  if (!manifest.asr?.dir || !manifest.asr?.model) {
    return '语音包 manifest 缺少 asr 路径'
  }
  return null
}

/** 无 manifest 的旧版 resources 布局是否完整 */
function legacyBundledComplete(root: string): boolean {
  const asr = path.join(root, 'paraformer', LEGACY_ASR_DIR_NAME, 'model.int8.onnx')
  const tokens = path.join(root, 'paraformer', LEGACY_ASR_DIR_NAME, 'tokens.txt')
  return fs.existsSync(asr) && fs.existsSync(tokens) && fs.statSync(asr).size > 0
}

function resolveReadyRoot(): { root: string; manifest: SpeechPackManifest; source: SpeechPackSource } | null {
  // 用户卸载后不再回落到安装目录/开发 resources 里的模型
  if (isOptedOut()) {
    return null
  }

  const userRoot = getUserDataSpeechRoot()
  const userManifest = readManifest(userRoot)
  if (userManifest) {
    const err = validateManifest(userManifest)
    if (!err && filesComplete(userRoot, userManifest)) {
      return { root: userRoot, manifest: userManifest, source: 'userData' }
    }
  }

  const bundledRoot = getBundledSpeechRoot()
  const bundledManifest = readManifest(bundledRoot)
  if (bundledManifest) {
    const err = validateManifest(bundledManifest)
    if (!err && filesComplete(bundledRoot, bundledManifest)) {
      return { root: bundledRoot, manifest: bundledManifest, source: 'bundled' }
    }
  }

  if (legacyBundledComplete(bundledRoot)) {
    return { root: bundledRoot, manifest: defaultManifest(), source: 'bundled' }
  }

  return null
}

export function getResolvedModelPaths(): {
  asrDir: string
  punctDir: string | null
  source: SpeechPackSource
  packVersion: string | null
} | null {
  const ready = resolveReadyRoot()
  if (!ready) return null
  const { root, manifest, source } = ready
  const asrDir = path.join(root, manifest.asr.dir)
  const punctDir = manifest.punct ? path.join(root, manifest.punct.dir) : null
  return {
    asrDir,
    punctDir,
    source,
    packVersion: manifest.packVersion || null,
  }
}

export function isSpeechPackAvailable(): boolean {
  return resolveReadyRoot() !== null
}

export function getPackStatus(): SpeechPackStatus {
  const ready = resolveReadyRoot()
  if (!ready) {
    return {
      available: false,
      source: 'none',
      packVersion: null,
      format: null,
      supportedFormat: SUPPORTED_SPEECH_PACK_FORMAT,
      recommendedVersion: RECOMMENDED_PACK_VERSION,
      approxSizeBytes: SPEECH_PACK_APPROX_BYTES,
      installRoot: getUserDataSpeechRoot(),
    }
  }
  return {
    available: true,
    source: ready.source,
    packVersion: ready.manifest.packVersion,
    format: ready.manifest.format,
    supportedFormat: SUPPORTED_SPEECH_PACK_FORMAT,
    recommendedVersion: RECOMMENDED_PACK_VERSION,
    approxSizeBytes: ready.manifest.approxSizeBytes ?? SPEECH_PACK_APPROX_BYTES,
    installRoot: ready.root,
  }
}

function broadcastProgress(progress: SpeechPackProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('speech:pack-progress', progress)
    }
  }
}

/**
 * 下载进度上报：节流 IPC，并用 EMA 平滑瞬时速度，估算剩余时间。
 */
function createDownloadProgressReporter(): (downloaded: number, total: number) => void {
  const startedAt = Date.now()
  let lastEmitAt = 0
  let lastSampleAt = startedAt
  let lastSampleBytes = 0
  let smoothedBps = 0

  return (downloaded: number, total: number) => {
    const now = Date.now()
    const sampleDt = now - lastSampleAt
    if (sampleDt >= 250 && downloaded >= lastSampleBytes) {
      const instant = ((downloaded - lastSampleBytes) / sampleDt) * 1000
      smoothedBps = smoothedBps > 0 ? smoothedBps * 0.7 + instant * 0.3 : instant
      lastSampleAt = now
      lastSampleBytes = downloaded
    }

    const elapsed = Math.max(1, now - startedAt)
    const avgBps = (downloaded / elapsed) * 1000
    const speed = smoothedBps > 1024 ? smoothedBps : avgBps
    const isDone = total > 0 && downloaded >= total
    if (!isDone && now - lastEmitAt < 200) return
    lastEmitAt = now

    const remaining = total > 0 ? Math.max(0, total - downloaded) : 0
    const etaSeconds =
      speed > 1024 && remaining > 0 ? Math.max(1, Math.ceil(remaining / speed)) : undefined
    const pct = total > 0 ? Math.min(80, Math.floor((downloaded / total) * 80)) : 10
    broadcastProgress({
      phase: 'download',
      percent: pct,
      downloaded,
      total,
      bytesPerSecond: Math.round(speed),
      etaSeconds,
      message: '正在下载语音包…',
    })
  }
}

function measureLatency(url: string, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now()
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'SailFish' } }, (res) => {
      res.resume()
      resolve(Date.now() - start)
    })
    req.on('error', () => resolve(Number.POSITIVE_INFINITY))
    req.on('timeout', () => {
      req.destroy()
      resolve(Number.POSITIVE_INFINITY)
    })
  })
}

async function pickDownloadUrl(): Promise<{ primary: string; fallback: string | null }> {
  const { github, oss } = packSourceUrls()
  const candidates = [oss, github].filter((url): url is string => Boolean(url))
  if (candidates.length === 0) {
    throw new Error('没有可用的语音包下载地址')
  }
  if (candidates.length === 1) {
    return { primary: candidates[0], fallback: null }
  }
  const [ossMs, ghMs] = await Promise.all([
    measureLatency(candidates[0]),
    measureLatency(candidates[1]),
  ])
  log.info(`Speech pack latency — OSS: ${ossMs}ms, GitHub: ${ghMs}ms`)
  if (ossMs === Number.POSITIVE_INFINITY && ghMs === Number.POSITIVE_INFINITY) {
    return { primary: candidates[0], fallback: candidates[1] }
  }
  return ossMs <= ghMs
    ? { primary: candidates[0], fallback: candidates[1] }
    : { primary: candidates[1], fallback: candidates[0] }
}

function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void,
  maxRedirects = 10,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, { headers: { 'User-Agent': 'SailFish-speech-pack/1.0' }, timeout: 600_000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode || 0)) {
        const loc = res.headers.location
        if (!loc) {
          reject(new Error(`Redirect without location: HTTP ${res.statusCode}`))
          return
        }
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href
        res.resume()
        downloadFile(next, destPath, onProgress, maxRedirects - 1).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`))
        return
      }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0
      let downloaded = 0
      fs.mkdirSync(path.dirname(destPath), { recursive: true })
      const file = fs.createWriteStream(destPath)
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        onProgress?.(downloaded, total || SPEECH_PACK_APPROX_BYTES)
      })
      res.pipe(file)
      file.on('finish', () => {
        file.close(() => {
          if (total > 0 && downloaded !== total) {
            fs.unlink(destPath, () => {})
            reject(new Error(`Incomplete download: ${downloaded}/${total}`))
            return
          }
          resolve()
        })
      })
      file.on('error', (err) => {
        fs.unlink(destPath, () => {})
        reject(err)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('下载超时'))
    })
  })
}

function installFromZip(zipPath: string): void {
  const userRoot = getUserDataSpeechRoot()
  const staging = path.join(os.tmpdir(), `sailfish-speech-pack-${Date.now()}`)
  try {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(staging, { recursive: true })
    broadcastProgress({ phase: 'extract', percent: 85, message: '正在解压…' })
    extractZipFile(zipPath, staging)

    // zip 可能多一层 speech-pack-x.y.z/ 目录
    let contentRoot = staging
    const manifestInRoot = path.join(staging, 'manifest.json')
    if (!fs.existsSync(manifestInRoot)) {
      const entries = fs.readdirSync(staging, { withFileTypes: true })
      const dirs = entries.filter((e) => e.isDirectory())
      if (dirs.length === 1) {
        const nested = path.join(staging, dirs[0].name)
        if (fs.existsSync(path.join(nested, 'manifest.json'))) {
          contentRoot = nested
        }
      }
    }

    const manifest = readManifest(contentRoot)
    if (!manifest) {
      throw new Error('语音包缺少 manifest.json')
    }
    const verr = validateManifest(manifest)
    if (verr) throw new Error(verr)
    if (!filesComplete(contentRoot, manifest)) {
      throw new Error('语音包文件不完整')
    }

    if (fs.existsSync(userRoot)) {
      fs.rmSync(userRoot, { recursive: true, force: true })
    }
    fs.mkdirSync(path.dirname(userRoot), { recursive: true })
    fs.cpSync(contentRoot, userRoot, { recursive: true })
    clearOptOut()
    broadcastProgress({ phase: 'done', percent: 100, message: '安装完成' })
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

let installLock: Promise<void> | null = null

export async function installPack(): Promise<SpeechPackStatus> {
  if (installLock) {
    await installLock
    return getPackStatus()
  }
  installLock = (async () => {
    const tmpZip = path.join(os.tmpdir(), `sailfish-speech-pack-${RECOMMENDED_PACK_VERSION}.zip`)
    try {
      broadcastProgress({ phase: 'download', percent: 0, message: '正在选择下载源…' })
      const { primary, fallback } = await pickDownloadUrl()
      try {
        await downloadFile(primary, tmpZip, createDownloadProgressReporter())
      } catch (err) {
        if (!fallback) throw err
        log.warn('Primary download failed, trying fallback:', err)
        broadcastProgress({ phase: 'download', percent: 0, message: '主源失败，切换备用源…' })
        await downloadFile(fallback, tmpZip, createDownloadProgressReporter())
      }
      installFromZip(tmpZip)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      broadcastProgress({ phase: 'error', percent: 0, message })
      throw err
    } finally {
      try {
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip)
      } catch {
        // ignore
      }
    }
  })()
  try {
    await installLock
    return getPackStatus()
  } finally {
    installLock = null
  }
}

export async function importPackFromPath(zipPath: string): Promise<SpeechPackStatus> {
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error('找不到语音包文件')
  }
  if (!/\.zip$/i.test(zipPath)) {
    throw new Error('请选择 .zip 格式的语音包')
  }
  try {
    broadcastProgress({ phase: 'extract', percent: 50, message: '正在导入…' })
    installFromZip(zipPath)
    return getPackStatus()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcastProgress({ phase: 'error', percent: 0, message })
    throw err
  }
}

export async function uninstallPack(): Promise<SpeechPackStatus> {
  // 由 index 侧 dispose；此处删 userData 并写入 opt-out，避免回落到 resources 内置模型
  const userRoot = getUserDataSpeechRoot()
  if (fs.existsSync(userRoot)) {
    fs.rmSync(userRoot, { recursive: true, force: true })
    log.info('Uninstalled speech pack from', userRoot)
  }
  setOptOut(true)
  log.info('Speech pack opted out (bundled models ignored until reinstall)')
  return getPackStatus()
}

/**
 * 若仅 resources 有模型而 userData 没有，拷到 userData 并写 manifest（不阻塞启动，调用方 fire-and-forget 即可）
 */
export async function migrateBundledModelsIfNeeded(): Promise<boolean> {
  if (isOptedOut()) {
    return false
  }

  const userRoot = getUserDataSpeechRoot()
  const userManifest = readManifest(userRoot)
  if (userManifest && filesComplete(userRoot, userManifest) && !validateManifest(userManifest)) {
    return false
  }

  const bundledRoot = getBundledSpeechRoot()
  if (!legacyBundledComplete(bundledRoot) && !readManifest(bundledRoot)) {
    return false
  }

  // 已有可用 userData 则不再迁
  if (resolveReadyRoot()?.source === 'userData') {
    return false
  }

  const ready = resolveReadyRoot()
  if (!ready || ready.source !== 'bundled') return false

  try {
    broadcastProgress({ phase: 'migrate', percent: 10, message: '正在迁移本地语音模型…' })
    const stagingManifest = ready.manifest.id === SPEECH_PACK_ID
      ? ready.manifest
      : defaultManifest()

    if (fs.existsSync(userRoot)) {
      fs.rmSync(userRoot, { recursive: true, force: true })
    }
    fs.mkdirSync(userRoot, { recursive: true })

    const asrSrc = path.join(bundledRoot, stagingManifest.asr.dir)
    const asrDest = path.join(userRoot, stagingManifest.asr.dir)
    fs.mkdirSync(path.dirname(asrDest), { recursive: true })
    fs.cpSync(asrSrc, asrDest, { recursive: true })

    if (stagingManifest.punct) {
      const punctSrc = path.join(bundledRoot, stagingManifest.punct.dir)
      if (fs.existsSync(punctSrc)) {
        const punctDest = path.join(userRoot, stagingManifest.punct.dir)
        fs.mkdirSync(path.dirname(punctDest), { recursive: true })
        fs.cpSync(punctSrc, punctDest, { recursive: true })
      }
    }

    writeManifest(userRoot, {
      ...defaultManifest(),
      packVersion: stagingManifest.packVersion || RECOMMENDED_PACK_VERSION,
    })
    clearOptOut()
    broadcastProgress({ phase: 'done', percent: 100, message: '迁移完成' })
    log.info('Migrated bundled speech models to', userRoot)
    return true
  } catch (err) {
    log.warn('Speech model migration failed:', err)
    broadcastProgress({
      phase: 'error',
      percent: 0,
      message: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
