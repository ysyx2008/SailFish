/**
 * 语音识别服务
 * 使用 utilityProcess 运行 sherpa-onnx-node + Paraformer 模型
 * 模型包按需安装，见 SPEC.md / pack.ts
 */
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { app, utilityProcess, UtilityProcess } from 'electron'
import { createLogger } from '../../utils/logger'
import { ChunkTextDecoder } from '../../utils/encoding'
import {
  getPackStatus,
  getResolvedModelPaths,
  isSpeechPackAvailable,
  migrateBundledModelsIfNeeded,
} from './pack'

export {
  getPackStatus,
  getPackDownloadUrls,
  installPack,
  importPackFromPath,
  uninstallPack,
  migrateBundledModelsIfNeeded,
  SPEECH_PACK_APPROX_BYTES,
  RECOMMENDED_PACK_VERSION,
  SUPPORTED_SPEECH_PACK_FORMAT,
} from './pack'
export type { SpeechPackStatus, SpeechPackProgress } from './pack'

const log = createLogger('Speech')

// Worker 进程
let worker: UtilityProcess | null = null
let isInitialized = false
const pendingCallbacks: Map<string, { resolve: Function; reject: Function }> = new Map()
let messageId = 0

/** 启动时尝试把 bundled 模型迁到 userData（异步，不阻塞） */
export function scheduleSpeechPackMigration(): void {
  void migrateBundledModelsIfNeeded().catch((err) =>
    log.warn('scheduleSpeechPackMigration failed:', err),
  )
}

/**
 * 获取 ASR 模型目录（userData pack 优先，其次 resources）
 */
function getModelDirectory(): string {
  const resolved = getResolvedModelPaths()
  if (resolved) return resolved.asrDir
  // 占位路径：仅供错误信息
  return path.join(app.getPath('userData'), 'models', 'speech', 'paraformer')
}

/**
 * 获取标点模型目录
 */
function getPunctModelDirectory(): string | null {
  return getResolvedModelPaths()?.punctDir ?? null
}

/**
 * 检查标点模型是否可用
 */
export function isPunctModelAvailable(): boolean {
  const punctDir = getPunctModelDirectory()
  if (!punctDir) return false
  const punctPath = path.join(punctDir, 'model.int8.onnx')
  return fs.existsSync(punctPath)
}

/**
 * 获取 unpacked 的 node_modules 绝对路径
 */
function getUnpackedNodeModules(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules')
  } else {
    return path.join(process.cwd(), 'node_modules')
  }
}


// ── Windows Unicode 路径兼容 ──────────────────────────────────
// Windows 原生 DLL 加载器在路径含非 ASCII 字符时可能失败（ERROR_MOD_NOT_FOUND）。
// 当检测到这种情况，创建 NTFS junction 从 ASCII 安全路径指向真实目录，
// junction 零拷贝、不需要管理员权限。

let _resolvedNativePaths: { unpackedNM: string; sherpaLib: string } | null = null

function hasNonAscii(s: string): boolean {
  return /[^\x20-\x7E]/.test(s)
}

function getAsciiSafeBaseDir(): string | null {
  for (const dir of [process.env.PROGRAMDATA, os.tmpdir(), `${process.env.SystemDrive || 'C:'}\\`]) {
    if (dir && !hasNonAscii(dir)) return dir
  }
  return null
}

function ensureAsciiJunction(targetDir: string, tag: string): string {
  if (process.platform !== 'win32' || !hasNonAscii(targetDir) || !fs.existsSync(targetDir)) {
    return targetDir
  }

  const baseDir = getAsciiSafeBaseDir()
  if (!baseDir) {
    log.warn('No ASCII-safe base directory found, using original path')
    return targetDir
  }

  const junctionPath = path.join(baseDir, 'SailFish', 'native-cache', tag)

  try {
    const stat = fs.lstatSync(junctionPath)
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(junctionPath)
      if (path.resolve(target) === path.resolve(targetDir)) {
        return junctionPath
      }
    }
    fs.rmSync(junctionPath, { recursive: true, force: true })
  } catch {
    // doesn't exist yet
  }

  try {
    fs.mkdirSync(path.dirname(junctionPath), { recursive: true })
    fs.symlinkSync(targetDir, junctionPath, 'junction')
    log.info('Created junction: %s → %s', junctionPath, targetDir)
    return junctionPath
  } catch (err) {
    log.warn('Failed to create junction:', err)
    return targetDir
  }
}

function resolveNativePaths(): { unpackedNM: string; sherpaLib: string } {
  if (_resolvedNativePaths) return _resolvedNativePaths

  const rawNM = getUnpackedNodeModules()
  const unpackedNM = ensureAsciiJunction(rawNM, 'node_modules')

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const platformPkg: Record<string, string> = {
    darwin: `sherpa-onnx-darwin-${arch}`,
    win32: `sherpa-onnx-win-${arch}`,
    linux: `sherpa-onnx-linux-${arch}`,
  }
  const pkg = platformPkg[process.platform] || `sherpa-onnx-${process.platform}-${arch}`
  const sherpaLib = path.join(unpackedNM, pkg)

  _resolvedNativePaths = { unpackedNM, sherpaLib }
  return _resolvedNativePaths
}

// ── 模型与状态 ────────────────────────────────────────────────

/**
 * 检查模型是否可用（兼容 format 的 pack 完整）
 */
export function isModelAvailable(): boolean {
  return isSpeechPackAvailable()
}

/**
 * 获取 Worker 脚本路径
 */
function getWorkerPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'services', 'speech', 'speech-worker.js')
  } else {
    // 开发模式下，__dirname 是 dist-electron，源文件在 electron/services/speech/
    return path.join(process.cwd(), 'electron', 'services', 'speech', 'speech-worker.js')
  }
}

/**
 * 发送消息到 Worker 并等待响应
 */
function sendToWorker(type: string, data?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error('Worker not started'))
      return
    }

    const id = `msg_${++messageId}`
    pendingCallbacks.set(id, { resolve, reject })

    worker.postMessage({ type, data, id })

    // 超时处理
    setTimeout(() => {
      if (pendingCallbacks.has(id)) {
        pendingCallbacks.delete(id)
        reject(new Error('Worker response timeout'))
      }
    }, 60000) // 60秒超时
  })
}

/**
 * 启动 Worker
 */
function startWorker(): void {
  if (worker) return

  const workerPath = getWorkerPath()
  log.info('Starting worker from:', workerPath)

  if (!fs.existsSync(workerPath)) {
    log.error('Worker file not found:', workerPath)
    return
  }

  const env = { ...process.env }
  const { unpackedNM, sherpaLib } = resolveNativePaths()

  // 1) NODE_PATH — 确保 utilityProcess 的 require 能找到 unpacked 的 node_modules
  env.NODE_PATH = unpackedNM

  // 2) SHERPA_MODULE_PATH — worker 加载模块的绝对路径后备
  env.SHERPA_MODULE_PATH = path.join(unpackedNM, 'sherpa-onnx-node')

  // 3) SHERPA_LIB_DIR / SHERPA_NODE_FILE — worker 直接加载 .node 的精确路径
  env.SHERPA_LIB_DIR = sherpaLib
  env.SHERPA_NODE_FILE = path.join(sherpaLib, 'sherpa-onnx.node')

  log.info('Worker env: NODE_PATH=%s, SHERPA_LIB_DIR=%s, SHERPA_NODE_FILE=%s', env.NODE_PATH, env.SHERPA_LIB_DIR, env.SHERPA_NODE_FILE)

  // 4) 平台对应的动态库搜索路径，确保 .node 加载时能找到依赖的原生库
  if (fs.existsSync(sherpaLib)) {
    if (process.platform === 'darwin') {
      env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH
        ? `${sherpaLib}:${env.DYLD_LIBRARY_PATH}`
        : sherpaLib
      log.info('DYLD_LIBRARY_PATH:', env.DYLD_LIBRARY_PATH)
    } else if (process.platform === 'win32') {
      env.PATH = env.PATH
        ? `${sherpaLib};${env.PATH}`
        : sherpaLib
      log.info('PATH prepended:', sherpaLib)
    } else if (process.platform === 'linux') {
      env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH
        ? `${sherpaLib}:${env.LD_LIBRARY_PATH}`
        : sherpaLib
      log.info('LD_LIBRARY_PATH:', env.LD_LIBRARY_PATH)
    }
  } else {
    log.warn('Sherpa-onnx native lib directory not found:', sherpaLib)
  }

  worker = utilityProcess.fork(workerPath, [], {
    env,
    stdio: 'pipe'
  })

  // 处理 Worker 消息
  worker.on('message', (message: any) => {
    const { id, success, result, error } = message
    const callback = pendingCallbacks.get(id)
    if (callback) {
      pendingCallbacks.delete(id)
      if (success) {
        callback.resolve(result)
      } else {
        callback.reject(new Error(error))
      }
    }
  })

  // 处理 Worker 输出。一段可能停在字中间。
  const stdoutText = new ChunkTextDecoder('utf-8')
  const stderrText = new ChunkTextDecoder('utf-8')
  worker.stdout?.on('data', (data: Buffer) => {
    const text = stdoutText.push(data).trim()
    if (text) log.info('[Worker]', text)
  })

  worker.stderr?.on('data', (data: Buffer) => {
    const text = stderrText.push(data).trim()
    if (text) log.error('[Worker]', text)
  })

  // 处理 Worker 退出
  worker.on('exit', (code) => {
    const outRest = stdoutText.end().trim()
    const errRest = stderrText.end().trim()
    if (outRest) log.info('[Worker]', outRest)
    if (errRest) log.error('[Worker]', errRest)
    log.info('Worker exited with code:', code)
    worker = null
    isInitialized = false

    // 拒绝所有等待中的回调
    for (const [_id, callback] of pendingCallbacks) {
      callback.reject(new Error(`Worker exited with code ${code}`))
    }
    pendingCallbacks.clear()
  })
}

/**
 * 初始化识别器
 */
export async function initialize(): Promise<{ success: boolean; error?: string; hasPunctuation?: boolean }> {
  if (isInitialized) {
    return { success: true }
  }

  if (!isModelAvailable()) {
    return { success: false, error: 'SPEECH_PACK_NOT_INSTALLED' }
  }

  try {
    startWorker()

    const modelDir = getModelDirectory()
    const modelPath = path.join(modelDir, 'model.int8.onnx')
    const tokensPath = path.join(modelDir, 'tokens.txt')

    // 标点模型路径（可选）
    const punctDir = getPunctModelDirectory()
    const punctModelPath = punctDir ? path.join(punctDir, 'model.int8.onnx') : ''
    const hasPunctModel = Boolean(punctModelPath && fs.existsSync(punctModelPath))

    log.info('Punctuation model available:', hasPunctModel)

    const result = await sendToWorker('initialize', { 
      modelPath, 
      tokensPath,
      punctModelPath: hasPunctModel ? punctModelPath : undefined
    })

    isInitialized = true
    return { success: true, hasPunctuation: result?.hasPunctuation }
  } catch (error) {
    log.error('Initialize error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 转录音频数据
 * @param audioData 音频数据
 * @param sampleRate 采样率，默认 16000
 * @param addPunctuation 是否添加标点，默认 true
 */
export async function transcribe(
  audioData: Float32Array,
  sampleRate: number = 16000,
  addPunctuation: boolean = true
): Promise<{ success: boolean; result?: { text: string; hasPunctuation?: boolean }; error?: string }> {
  if (!isInitialized) {
    const initResult = await initialize()
    if (!initResult.success) {
      return { success: false, error: initResult.error }
    }
  }

  try {
    // 将 Float32Array 转为普通数组传递
    const result = await sendToWorker('transcribe', {
      audioData: Array.from(audioData),
      sampleRate,
      addPunctuation
    })

    return {
      success: true,
      result: { text: result.text, hasPunctuation: result.hasPunctuation }
    }
  } catch (error) {
    log.error('Transcribe error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 获取模型信息
 */
export function getModelInfo() {
  const pack = getPackStatus()
  return {
    id: 'paraformer-zh-2024',
    name: 'Paraformer 中文模型',
    description: 'FunASR Paraformer 中文语音识别模型 (2024版)，支持普通话、英文和方言',
    languages: ['中文', '英文', '四川话', '河南话', '天津话'],
    sampleRate: 16000,
    available: pack.available,
    packVersion: pack.packVersion,
    packSource: pack.source,
    punctuation: {
      id: 'ct-transformer-zh-en',
      name: 'CT-Transformer 标点模型',
      description: '中英文标点恢复模型，自动为识别结果添加标点符号',
      available: isPunctModelAvailable()
    }
  }
}

/**
 * 获取服务状态
 */
export function getStatus() {
  return {
    initialized: isInitialized,
    modelLoaded: isInitialized && worker !== null,
    modelId: isInitialized ? 'paraformer-zh-small' : null,
    packAvailable: isModelAvailable(),
  }
}

/**
 * 检查是否就绪
 */
export function isReady(): boolean {
  return isInitialized && worker !== null
}

/**
 * 释放资源
 */
export function dispose(): void {
  if (worker) {
    worker.kill()
    worker = null
  }
  isInitialized = false
  pendingCallbacks.clear()
  log.info('Disposed')
}
