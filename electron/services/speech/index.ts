/**
 * 语音识别服务
 * 使用 utilityProcess 运行 sherpa-onnx-node + Paraformer 模型
 */
import * as path from 'path'
import * as fs from 'fs'
import { app, utilityProcess, UtilityProcess } from 'electron'
import { createLogger } from '../../utils/logger'

const log = createLogger('Speech')

const MODEL_NAME = 'sherpa-onnx-paraformer-zh-2024-03-09'
const PUNCT_MODEL_NAME = 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8'

// Worker 进程
let worker: UtilityProcess | null = null
let isInitialized = false
const pendingCallbacks: Map<string, { resolve: Function; reject: Function }> = new Map()
let messageId = 0

/**
 * 获取模型目录
 */
function getModelDirectory(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'speech', 'paraformer', MODEL_NAME)
  } else {
    return path.join(process.cwd(), 'resources', 'models', 'speech', 'paraformer', MODEL_NAME)
  }
}

/**
 * 获取标点模型目录
 */
function getPunctModelDirectory(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'speech', 'punctuation', PUNCT_MODEL_NAME)
  } else {
    return path.join(process.cwd(), 'resources', 'models', 'speech', 'punctuation', PUNCT_MODEL_NAME)
  }
}

/**
 * 检查标点模型是否可用
 */
export function isPunctModelAvailable(): boolean {
  const punctDir = getPunctModelDirectory()
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

/**
 * 获取 sherpa-onnx 平台原生库目录（用于设置动态库搜索路径）
 */
function getSherpaLibPath(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const platformPkg: Record<string, string> = {
    darwin: `sherpa-onnx-darwin-${arch}`,
    win32: `sherpa-onnx-win-${arch}`,
    linux: `sherpa-onnx-linux-${arch}`,
  }
  const pkg = platformPkg[process.platform] || `sherpa-onnx-${process.platform}-${arch}`
  return path.join(getUnpackedNodeModules(), pkg)
}

/**
 * 检查模型是否可用
 */
export function isModelAvailable(): boolean {
  const modelDir = getModelDirectory()
  const modelPath = path.join(modelDir, 'model.int8.onnx')
  const tokensPath = path.join(modelDir, 'tokens.txt')
  return fs.existsSync(modelPath) && fs.existsSync(tokensPath)
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
  const unpackedNM = getUnpackedNodeModules()
  const sherpaLib = getSherpaLibPath()

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

  // 处理 Worker 输出
  worker.stdout?.on('data', (data) => {
    log.info('[Worker]', data.toString().trim())
  })

  worker.stderr?.on('data', (data) => {
    log.error('[Worker]', data.toString().trim())
  })

  // 处理 Worker 退出
  worker.on('exit', (code) => {
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
    return { success: false, error: '语音模型未安装' }
  }

  try {
    startWorker()

    const modelDir = getModelDirectory()
    const modelPath = path.join(modelDir, 'model.int8.onnx')
    const tokensPath = path.join(modelDir, 'tokens.txt')

    // 标点模型路径（可选）
    const punctDir = getPunctModelDirectory()
    const punctModelPath = path.join(punctDir, 'model.int8.onnx')
    const hasPunctModel = fs.existsSync(punctModelPath)

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
  return {
    id: 'paraformer-zh-2024',
    name: 'Paraformer 中文模型',
    description: 'FunASR Paraformer 中文语音识别模型 (2024版)，支持普通话、英文和方言',
    languages: ['中文', '英文', '四川话', '河南话', '天津话'],
    sampleRate: 16000,
    available: isModelAvailable(),
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
    modelId: isInitialized ? 'paraformer-zh-small' : null
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
