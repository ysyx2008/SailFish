/**
 * 语音识别 Worker
 * 在 utilityProcess 中运行 sherpa-onnx-node
 */
/* eslint-env node */

const fs = require('fs')
const os = require('os')
const path = require('path')
const _Module = require('module') // eslint-disable-line no-unused-vars

// ── 启动时设置动态库搜索路径（belt-and-suspenders，父进程已通过 env 设置，此处二次保障） ──
const sherpaLibDir = process.env.SHERPA_LIB_DIR
if (sherpaLibDir) {
  if (os.platform() === 'win32') {
    process.env.PATH = sherpaLibDir + path.delimiter + (process.env.PATH || '')
  } else if (os.platform() === 'linux') {
    process.env.LD_LIBRARY_PATH = sherpaLibDir + path.delimiter + (process.env.LD_LIBRARY_PATH || '')
  }
}

// 从 parentPort 接收消息
process.parentPort.on('message', async (e) => {
  const { type, data, id } = e.data

  try {
    switch (type) {
      case 'initialize':
        await handleInitialize(data, id)
        break
      case 'transcribe':
        await handleTranscribe(data, id)
        break
      case 'getStatus':
        handleGetStatus(id)
        break
      default:
        sendError(id, `Unknown message type: ${type}`)
    }
  } catch (error) {
    sendError(id, error.message || String(error))
  }
})

// 识别器实例
let recognizer = null
let punctuator = null
let isInitialized = false
let modelPath = null
let punctModelPath = null

/**
 * 尝试用 process.dlopen 直接加载 .node 文件，绕过 addon.js 的静默错误
 * 成功时返回 native addon exports，失败时抛出携带真实系统错误的异常
 */
function loadNativeAddon(nodeFilePath) {
  const m = { exports: {} }
  process.dlopen(m, nodeFilePath)
  return m.exports
}

/**
 * 加载 sherpa-onnx-node 模块（多级回退）
 *
 * 1. require('sherpa-onnx-node') — 标准方式
 * 2. require(SHERPA_MODULE_PATH)  — 绝对路径回退（跳过 NODE_PATH 问题）
 * 3. dlopen(SHERPA_NODE_FILE) + 手动加载 JS wrapper — 最后手段，捕获真实 DLL 错误
 */
function loadSherpa() {
  // ── 第一级：标准 require ──
  try {
    return require('sherpa-onnx-node')
  } catch (err) {
    console.warn('[SpeechWorker] Standard require failed:', err.message)
  }

  // ── 第二级：绝对路径 require ──
  const modulePath = process.env.SHERPA_MODULE_PATH
  if (modulePath) {
    try {
      console.log('[SpeechWorker] Trying absolute path:', modulePath)
      return require(modulePath)
    } catch (err) {
      console.warn('[SpeechWorker] Absolute path require failed:', err.message)
    }
  }

  // ── 第三级：直接 dlopen .node 文件 + 手动组装 ──
  const nodeFile = process.env.SHERPA_NODE_FILE
  if (!nodeFile) {
    throw new Error('SHERPA_NODE_FILE env not set, cannot attempt direct load')
  }

  if (!fs.existsSync(nodeFile)) {
    throw new Error(`Native addon not found: ${nodeFile}`)
  }

  console.log('[SpeechWorker] Attempting direct dlopen:', nodeFile)
  // process.dlopen 会抛出包含真实系统错误的异常，例如：
  // - "The specified module could not be found" (缺少依赖 DLL)
  // - "A dynamic link library initialization routine failed" (VC++ Runtime 缺失)
  const addon = loadNativeAddon(nodeFile)

  // dlopen 成功，手动加载 JS wrapper 层
  if (!modulePath) {
    throw new Error('SHERPA_MODULE_PATH env not set, cannot load JS wrappers')
  }
  const wrapperDir = modulePath
  const nonStreamAsr = require(path.join(wrapperDir, 'non-streaming-asr.js'))
  const punct = require(path.join(wrapperDir, 'punctuation.js'))

  return {
    OfflineRecognizer: nonStreamAsr.OfflineRecognizer,
    OfflinePunctuation: punct.OfflinePunctuation,
    readWave: addon.readWave,
    writeWave: addon.writeWave,
    version: addon.version,
  }
}

/**
 * 初始化识别器
 */
async function handleInitialize(data, id) {
  if (isInitialized && recognizer) {
    sendSuccess(id, { already: true })
    return
  }

  try {
    modelPath = data.modelPath
    const tokensPath = data.tokensPath
    punctModelPath = data.punctModelPath

    console.log('[SpeechWorker] Initializing with model:', modelPath)

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`)
    }

    const sherpa = loadSherpa()

    const config = {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        paraformer: {
          model: modelPath,
        },
        tokens: tokensPath,
        numThreads: 2,
        debug: false,
        provider: 'cpu',
      },
      decodingMethod: 'greedy_search',
      maxActivePaths: 4,
    }

    recognizer = new sherpa.OfflineRecognizer(config)

    if (punctModelPath && fs.existsSync(punctModelPath)) {
      console.log('[SpeechWorker] Initializing punctuation model:', punctModelPath)
      try {
        const punctConfig = {
          model: {
            ctTransformer: punctModelPath,
            numThreads: 1,
            debug: false,
            provider: 'cpu',
          },
        }
        punctuator = new sherpa.OfflinePunctuation(punctConfig)
        console.log('[SpeechWorker] Punctuation model initialized')
      } catch (punctError) {
        console.warn('[SpeechWorker] Failed to initialize punctuation model:', punctError.message)
        punctuator = null
      }
    } else {
      console.log('[SpeechWorker] Punctuation model not found, skipping')
    }

    isInitialized = true
    console.log('[SpeechWorker] Initialized successfully')
    sendSuccess(id, { success: true, hasPunctuation: punctuator !== null })
  } catch (error) {
    console.error('[SpeechWorker] Initialize error:', error)
    sendError(id, error.message || String(error))
  }
}

/**
 * 转录音频
 */
async function handleTranscribe(data, id) {
  if (!isInitialized || !recognizer) {
    sendError(id, 'Recognizer not initialized')
    return
  }

  try {
    const { audioData, sampleRate, addPunctuation = true } = data
    const samples = new Float32Array(audioData)

    console.log(`[SpeechWorker] Transcribing ${samples.length} samples at ${sampleRate}Hz`)

    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples, sampleRate })
    recognizer.decode(stream)

    const result = recognizer.getResult(stream)
    let text = result.text?.trim() || ''

    console.log(`[SpeechWorker] Raw result: "${text}"`)

    if (addPunctuation && punctuator && text) {
      try {
        const punctuatedText = punctuator.addPunct(text)
        console.log(`[SpeechWorker] With punctuation: "${punctuatedText}"`)
        text = punctuatedText
      } catch (punctError) {
        console.warn('[SpeechWorker] Punctuation failed:', punctError.message)
      }
    }

    sendSuccess(id, { text, hasPunctuation: punctuator !== null })
  } catch (error) {
    console.error('[SpeechWorker] Transcribe error:', error)
    sendError(id, error.message || String(error))
  }
}

/**
 * 获取状态
 */
function handleGetStatus(id) {
  sendSuccess(id, {
    initialized: isInitialized,
    modelLoaded: isInitialized && recognizer !== null
  })
}

function sendSuccess(id, result) {
  process.parentPort.postMessage({
    id,
    success: true,
    result
  })
}

function sendError(id, error) {
  process.parentPort.postMessage({
    id,
    success: false,
    error
  })
}

console.log('[SpeechWorker] Started, platform:', os.platform(), os.arch())
