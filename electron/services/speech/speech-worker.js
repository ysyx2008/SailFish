/**
 * 语音识别 Worker
 * 在 utilityProcess 中运行 sherpa-onnx-node
 */

const path = require('path')
const fs = require('fs')

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
let isInitialized = false
let modelPath = null

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

    console.log('[SpeechWorker] Initializing with model:', modelPath)

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`)
    }

    // 加载 sherpa-onnx-node
    const sherpa = require('sherpa-onnx-node')

    // 创建离线识别器配置
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

    // 创建离线识别器
    recognizer = new sherpa.OfflineRecognizer(config)

    isInitialized = true
    console.log('[SpeechWorker] Initialized successfully')
    sendSuccess(id, { success: true })
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
    const { audioData, sampleRate } = data
    const samples = new Float32Array(audioData)

    console.log(`[SpeechWorker] Transcribing ${samples.length} samples at ${sampleRate}Hz`)

    // 创建离线流
    const stream = recognizer.createStream()

    // 接受音频数据 - API 需要对象 { samples, sampleRate }
    stream.acceptWaveform({ samples, sampleRate })

    // 解码
    recognizer.decode(stream)

    // 获取结果
    const result = recognizer.getResult(stream)
    const text = result.text?.trim() || ''

    console.log(`[SpeechWorker] Result: "${text}"`)

    sendSuccess(id, { text })
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

/**
 * 发送成功响应
 */
function sendSuccess(id, result) {
  process.parentPort.postMessage({
    id,
    success: true,
    result
  })
}

/**
 * 发送错误响应
 */
function sendError(id, error) {
  process.parentPort.postMessage({
    id,
    success: false,
    error
  })
}

console.log('[SpeechWorker] Started')
