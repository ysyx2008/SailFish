/* eslint-env node */
/**
 * Embedding Worker（utilityProcess）
 *
 * 使用 @huggingface/transformers v4 + onnxruntime-node（CoreML/CUDA/DML），
 * 在独立 utilityProcess 中跑推理，与主进程内存隔离。
 * 原生 onnxruntime-node 加载失败时改走 onnxruntime-web（WASM）。
 *
 * 通信协议：
 *   ⇢ { id, type: 'initialize', data: { modelDir, modelName, device?, dtype? } }
 *   ⇢ { id, type: 'embed',      data: { texts: string[] } }
 *   ⇢ { id, type: 'dispose' }
 *   ⇠ { id, success, result }   |   { id, success: false, error }
 */
'use strict'

const { applyLocalWasmPaths, ensureOnnxRuntimeBackend } = require('./ort-native')

let pipelineFn = null
let env = null
let extractor = null
let currentModelKey = null
/** @type {'native' | 'wasm' | null} */
let ortBackend = null

async function loadTransformers() {
  if (pipelineFn) return { pipeline: pipelineFn, env, backend: ortBackend }
  ortBackend = ensureOnnxRuntimeBackend()
  if (ortBackend === 'wasm') {
    console.warn('[EmbeddingWorker] 嵌入使用 WASM')
  }
  const transformers = await import('@huggingface/transformers')
  pipelineFn = transformers.pipeline
  env = transformers.env
  env.allowLocalModels = true
  env.allowRemoteModels = false
  if (ortBackend === 'wasm') {
    applyLocalWasmPaths(env)
  }
  return { pipeline: pipelineFn, env, backend: ortBackend }
}

async function handleInitialize(data) {
  const { modelDir, modelName, device, dtype } = data || {}
  if (!modelDir || !modelName) {
    throw new Error('initialize 缺少参数：需要 modelDir 与 modelName')
  }

  const t = await loadTransformers()
  const resolvedDevice = t.backend === 'wasm' ? 'cpu' : (device || 'auto')
  const resolvedDtype = dtype || 'q8'
  const key = `${modelDir}::${modelName}::${resolvedDevice}::${resolvedDtype}::${t.backend}`
  if (extractor && currentModelKey === key) {
    return { already: true, device: resolvedDevice, backend: t.backend }
  }

  if (extractor) {
    try {
      await extractor.dispose()
    } catch { /* ignore */ }
    extractor = null
    currentModelKey = null
  }

  t.env.allowRemoteModels = false
  t.env.localModelPath = modelDir

  try {
    extractor = await t.pipeline('feature-extraction', modelName, {
      local_files_only: true,
      device: resolvedDevice,
      dtype: resolvedDtype,
    })
    // 虚拟显卡上会话能建出来，一算就失败。加载阶段试一次，失败就交给上一层换 CPU。
    const probe = await extractor(['ok'], { pooling: 'mean', normalize: true })
    const probeData = probe && probe.data
    if (!probeData || typeof probeData.length !== 'number' || probeData.length === 0) {
      throw new Error('嵌入模型已加载，但推理没有结果')
    }
  } catch (err) {
    if (extractor) {
      try { await extractor.dispose() } catch { /* ignore */ }
    }
    extractor = null
    currentModelKey = null
    throw err
  }
  currentModelKey = key

  return { loaded: true, modelName, device: resolvedDevice, backend: t.backend }
}

async function handleEmbed(data) {
  if (!extractor) {
    throw new Error('Embedding 模型未加载，请先调用 initialize')
  }

  const { texts } = data || {}
  if (!Array.isArray(texts)) {
    throw new Error('embed 参数 texts 必须为字符串数组')
  }
  if (texts.length === 0) {
    return { vectors: [], dim: 0 }
  }

  const output = await extractor(texts, {
    pooling: 'mean',
    normalize: true,
  })

  const data2 = output.data
  const dims = output.dims
  const dim = (dims && dims.length >= 2)
    ? dims[dims.length - 1]
    : Math.floor(data2.length / texts.length)

  if (!dim || data2.length !== texts.length * dim) {
    const vectors = []
    for (const text of texts) {
      const single = await extractor(text, { pooling: 'mean', normalize: true })
      vectors.push(Array.from(single.data))
    }
    return { vectors, dim: vectors[0]?.length || 0, fallback: true }
  }

  const flat = new Float32Array(data2.length)
  flat.set(data2)
  return { flat, dim, count: texts.length }
}

async function handleDispose() {
  if (extractor) {
    try {
      await extractor.dispose()
    } catch { /* ignore */ }
  }
  extractor = null
  currentModelKey = null
  return { disposed: true }
}

async function dispatch(message) {
  const { id, type, data } = message || {}
  try {
    let result
    switch (type) {
      case 'initialize':
        result = await handleInitialize(data)
        break
      case 'embed':
        result = await handleEmbed(data)
        break
      case 'dispose':
        result = await handleDispose()
        break
      case 'ping':
        result = { ok: true }
        break
      default:
        throw new Error(`未知消息类型：${type}`)
    }
    sendSuccess(id, result)
  } catch (err) {
    sendError(id, err)
  }
}

let queue = Promise.resolve()
process.parentPort.on('message', (e) => {
  queue = queue.then(() => dispatch(e && e.data))
})

function sendSuccess(id, result) {
  process.parentPort.postMessage({ id, success: true, result })
}

function sendError(id, err) {
  const message = err && err.message ? err.message : String(err)
  const stack = err && err.stack ? err.stack : null
  process.parentPort.postMessage({ id, success: false, error: message, stack })
}

console.log('[EmbeddingWorker] started, pid=%d, node=%s', process.pid, process.version)
