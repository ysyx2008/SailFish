/* eslint-env node */
/**
 * 探测原生 onnxruntime-node 能否加载。
 * 失败时把同名模块指到 onnxruntime-web，让 transformers.js 的静态 import 不再踩原生 DLL。
 *
 * 不解析错误文案：只看 require 成不成功。
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { pathToFileURL, fileURLToPath } = require('url')
const Module = require('module')

/** @typedef {'native' | 'wasm'} OrtBackend */

/** @type {OrtBackend | null} */
let resolvedBackend = null
/** @type {typeof Module._load | null} */
let originalLoad = null
/** @type {Error | null} */
let lastNativeError = null
/** @type {string | null} */
let nativeMainPath = null
/** @type {string | null} */
let webMainPath = null

function resolvePkg(name) {
  try {
    return require.resolve(name)
  } catch {
    return null
  }
}

function tryRequireNativeOrt() {
  require('onnxruntime-node')
}

function toFsPath(request) {
  if (typeof request === 'string' && request.startsWith('file:')) {
    return fileURLToPath(request)
  }
  return request
}

function isOnnxRuntimeNodeRequest(request) {
  if (request === 'onnxruntime-node') return true
  if (!nativeMainPath) return false
  try {
    return path.resolve(toFsPath(request)) === path.resolve(nativeMainPath)
  } catch {
    return request === nativeMainPath
  }
}

/**
 * @returns {OrtBackend}
 */
function ensureOnnxRuntimeBackend() {
  if (resolvedBackend) return resolvedBackend

  try {
    tryRequireNativeOrt()
    resolvedBackend = 'native'
    return resolvedBackend
  } catch (err) {
    lastNativeError = err instanceof Error ? err : new Error(String(err))
    console.warn(
      '[ort-native] onnxruntime-node 加载失败，改用 WASM:',
      lastNativeError.message,
    )
    installOnnxNodeWebAlias()
    resolvedBackend = 'wasm'
    return resolvedBackend
  }
}

function installOnnxNodeWebAlias() {
  if (originalLoad) return

  nativeMainPath = resolvePkg('onnxruntime-node')
  webMainPath = resolvePkg('onnxruntime-web')
  if (!webMainPath) {
    throw new Error('onnxruntime-web 不可用，无法回退 WASM')
  }

  originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (isOnnxRuntimeNodeRequest(request)) {
      return originalLoad.call(this, webMainPath, parent, isMain)
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  // 在 import transformers 之前就把本地路径写进真正被会话读取的那份配置。
  // 有的运行时不会把这份配置抄到 transformers.env 上，导入之后再改就来不及。
  applyLocalWasmPaths(null)
}

function localWasmFileUrls() {
  const webMain = webMainPath || resolvePkg('onnxruntime-web')
  if (!webMain) {
    throw new Error('onnxruntime-web 不可用，无法设置本地 WASM 路径')
  }
  const distDir = path.dirname(webMain)
  const mjs = path.join(distDir, 'ort-wasm-simd-threaded.asyncify.mjs')
  const wasm = path.join(distDir, 'ort-wasm-simd-threaded.asyncify.wasm')
  if (!fs.existsSync(mjs) || !fs.existsSync(wasm)) {
    throw new Error(`本地 WASM 文件缺失: ${mjs}`)
  }
  return {
    mjs: pathToFileURL(mjs).href,
    wasm: pathToFileURL(wasm).href,
  }
}

/**
 * transformers 在 Node 里会把 wasmPaths 指到 jsDelivr，Node 不能 import https。
 * 路径必须写在 onnxruntime-web 自己的 env 上（会话实际读的那份）。
 * transformers.env 上若没有这份配置，就把同一份挂过去，而不是因此失败。
 */
function applyLocalWasmPaths(transformersEnv) {
  const webMain = webMainPath || resolvePkg('onnxruntime-web')
  if (!webMain) {
    throw new Error('onnxruntime-web 不可用，无法设置本地 WASM 路径')
  }
  const web = require(webMain)
  const liveWasm = web?.env?.wasm
  if (!liveWasm) {
    throw new Error('onnxruntime-web 未提供 WASM 配置，无法改回本地路径')
  }
  const wasmPaths = localWasmFileUrls()
  liveWasm.wasmPaths = wasmPaths
  installWasmExternalDataLoader(web)

  if (!transformersEnv) return
  // 预加载会用 fetch 去读 file: 地址，Node 做不到，失败也只是警告。
  // 真正加载走上面写好的本地路径，不需要这一步。
  transformersEnv.useWasmCache = false
  if (!transformersEnv.backends) transformersEnv.backends = {}
  if (!transformersEnv.backends.onnx) transformersEnv.backends.onnx = {}
  const copied = transformersEnv.backends.onnx.wasm
  if (!copied) {
    transformersEnv.backends.onnx.wasm = liveWasm
  } else if (copied !== liveWasm) {
    copied.wasmPaths = wasmPaths
  }
}

/**
 * 原生库会按路径自己去读旁边的权重文件。WASM 只吃内存，不会读磁盘，
 * 所以要在创建会话时把同目录的 `.onnx_data` 一并交进去。
 */
function installWasmExternalDataLoader(web) {
  const Session = web?.InferenceSession
  if (!Session || typeof Session.create !== 'function' || Session.create.__sailfishExternalData) {
    return
  }
  const original = Session.create.bind(Session)
  const patched = async function (model, options, ...rest) {
    return original(model, withSiblingExternalData(model, options), ...rest)
  }
  patched.__sailfishExternalData = true
  Session.create = patched
}

function withSiblingExternalData(model, options) {
  if (typeof model !== 'string') return options
  const dataPath = model + '_data'
  if (!fs.existsSync(dataPath)) return options
  const name = path.basename(dataPath)
  const already = Array.isArray(options?.externalData) && options.externalData.some((item) => {
    if (typeof item === 'string') return path.basename(item) === name
    return item && item.path === name
  })
  if (already) return options
  const data = new Uint8Array(fs.readFileSync(dataPath))
  return {
    ...options,
    externalData: [...(options?.externalData || []), { path: name, data }],
  }
}

function resetOrtNativeForTest() {
  if (originalLoad) {
    Module._load = originalLoad
    originalLoad = null
  }
  resolvedBackend = null
  lastNativeError = null
  nativeMainPath = null
  webMainPath = null
}

module.exports = {
  applyLocalWasmPaths,
  ensureOnnxRuntimeBackend,
  withSiblingExternalData,
  installOnnxNodeWebAlias,
  isOnnxRuntimeNodeRequest,
  lastNativeError: () => lastNativeError,
  resetOrtNativeForTest,
  tryRequireNativeOrt,
}
