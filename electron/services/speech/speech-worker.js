/**
 * 语音识别 Worker
 * 在 utilityProcess 中运行 sherpa-onnx-node
 */
/* eslint-env node */

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
let punctuator = null  // 标点恢复器
let isInitialized = false
let modelPath = null
let punctModelPath = null

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
    punctModelPath = data.punctModelPath  // 标点模型路径（可选）

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

    // 初始化标点恢复器（如果模型存在）
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

    // 创建离线流
    const stream = recognizer.createStream()

    // 接受音频数据 - API 需要对象 { samples, sampleRate }
    stream.acceptWaveform({ samples, sampleRate })

    // 解码
    recognizer.decode(stream)

    // 获取结果
    const result = recognizer.getResult(stream)
    let text = result.text?.trim() || ''

    console.log(`[SpeechWorker] Raw result: "${text}"`)

    // 添加标点（如果启用且有标点恢复器）
    if (addPunctuation && punctuator && text) {
      try {
        const punctuatedText = punctuator.addPunct(text)  // API 是 addPunct 不是 addPunctuation
        console.log(`[SpeechWorker] With punctuation: "${punctuatedText}"`)
        text = punctuatedText
      } catch (punctError) {
        console.warn('[SpeechWorker] Punctuation failed:', punctError.message)
        // 标点失败时使用原始文本
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
