import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'module'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const require = createRequire(import.meta.url)
const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ort-native.js')

function loadHelper() {
  delete require.cache[require.resolve(helperPath)]
  return require(helperPath) as {
    applyLocalWasmPaths: (env: any) => void
    ensureOnnxRuntimeBackend: () => 'native' | 'wasm'
    withSiblingExternalData: (model: unknown, options?: any) => any
    installOnnxNodeWebAlias: () => void
    isOnnxRuntimeNodeRequest: (request: string) => boolean
    resetOrtNativeForTest: () => void
    tryRequireNativeOrt: () => void
  }
}

describe('ort-native', () => {
  afterEach(() => {
    const helper = require(helperPath)
    helper.resetOrtNativeForTest()
  })

  it('本机若能加载原生 ORT，则判定为 native', () => {
    const helper = loadHelper()
    try {
      helper.tryRequireNativeOrt()
    } catch {
      return
    }
    expect(helper.ensureOnnxRuntimeBackend()).toBe('native')
  })

  it('原生加载失败时改走 wasm，绝对路径请求也被拦截', () => {
    const Module = require('module') as { _load: (...args: any[]) => any }
    const orig = Module._load
    const nativeAbs = require.resolve('onnxruntime-node')
    for (const key of Object.keys(require.cache)) {
      if (key.includes('onnxruntime-node')) delete require.cache[key]
    }
    Module._load = function (request: string, parent: any, isMain: boolean) {
      if (request === 'onnxruntime-node' || request === nativeAbs) {
        throw new Error('simulated native load failure')
      }
      return orig.call(this, request, parent, isMain)
    }

    try {
      const helper = loadHelper()
      expect(helper.ensureOnnxRuntimeBackend()).toBe('wasm')
      expect(helper.isOnnxRuntimeNodeRequest('onnxruntime-node')).toBe(true)
      expect(helper.isOnnxRuntimeNodeRequest(nativeAbs)).toBe(true)
      expect(helper.isOnnxRuntimeNodeRequest(pathToFileURL(nativeAbs).href)).toBe(true)
      const viaAbs = require(nativeAbs) as { env?: { wasm?: unknown; versions?: { web?: string } } }
      expect(viaAbs.env?.wasm || viaAbs.env?.versions?.web).toBeTruthy()
    } finally {
      const helper = require(helperPath)
      helper.resetOrtNativeForTest()
      Module._load = orig
    }
  })

  it('applyLocalWasmPaths 指到本地 file URL，不走 https CDN', () => {
    const helper = loadHelper()
    const fakeEnv = { backends: { onnx: { wasm: { wasmPaths: { mjs: 'https://cdn.example/x.mjs' } } } } }
    helper.applyLocalWasmPaths(fakeEnv)
    const paths = fakeEnv.backends.onnx.wasm.wasmPaths as { mjs?: string; wasm?: string }
    expect(paths.mjs?.startsWith('file:')).toBe(true)
    expect(paths.wasm?.startsWith('file:')).toBe(true)
    expect(paths.mjs?.includes('https:')).toBe(false)
  })

  it('transformers 没挂上 WASM 配置时，补上同一份本地路径，不因此失败', () => {
    const helper = loadHelper()
    const fakeEnv: { backends?: { onnx?: { wasm?: { wasmPaths?: { mjs?: string } } } } } = {}
    helper.applyLocalWasmPaths(fakeEnv)
    const paths = fakeEnv.backends?.onnx?.wasm?.wasmPaths
    expect(paths?.mjs?.startsWith('file:')).toBe(true)
    expect(paths?.mjs?.includes('https:')).toBe(false)
    expect((fakeEnv as { useWasmCache?: boolean }).useWasmCache).toBe(false)
  })

  it('模型旁边有权重文件时，会话创建会带上这份数据', () => {
    const helper = loadHelper()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ort-ext-'))
    const model = path.join(dir, 'model_quantized.onnx')
    fs.writeFileSync(model, 'onnx')
    fs.writeFileSync(model + '_data', Buffer.from([1, 2, 3, 4]))
    const options = helper.withSiblingExternalData(model, { executionProviders: ['cpu'] })
    expect(options.executionProviders).toEqual(['cpu'])
    expect(options.externalData).toHaveLength(1)
    expect(options.externalData[0].path).toBe('model_quantized.onnx_data')
    expect(Array.from(options.externalData[0].data)).toEqual([1, 2, 3, 4])
    expect(helper.withSiblingExternalData(model + '.missing', {})).toEqual({})
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('第二次调用不会重复探测', () => {
    const helper = loadHelper()
    const first = helper.ensureOnnxRuntimeBackend()
    const second = helper.ensureOnnxRuntimeBackend()
    expect(second).toBe(first)
  })
})
