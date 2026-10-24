#!/usr/bin/env node
/* eslint-env node */
/**
 * Embedding 性能基准测试
 *
 * 对比四种调用模式：
 *   - A 单条 baseline:     embed([1 条])    × 1
 *   - B 模拟旧实现:         embed([1 条])    × N    （等价于"1 doc 1 chunk"逐条）
 *   - C 新实现单大批:       embed([N 条])    × 1
 *   - D 新实现真实场景:      embed([64 条])   × ⌈N/64⌉   （EMBED_BATCH_SIZE）
 *
 * 用法:
 *   node scripts/bench-embedding.cjs [count]    # count 默认 200
 */
'use strict'

const Module = require('module')
const path = require('path')
const fs = require('fs')
const os = require('os')

// 复用 CLI 的 electron shim，避免触发真实 electron 加载
const shimPath = path.join(__dirname, '..', 'electron', 'cli', 'electron-shim.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron' || request === 'electron-updater') return shimPath
  return origResolve.call(this, request, parent, isMain, options)
}

// 关键：把 userData 重定向到一个临时目录，避免污染真实知识库
// electron-shim 支持 SFT_DATA_DIR 环境变量
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-bench-'))
process.env.SFT_DATA_DIR = tmpUserData
console.log(`[bench] tmp userData: ${tmpUserData}`)

process.env.SFT_CLI_MODE = '1'

// 注册 TS 支持（同 cli/main.js）
try {
  require('tsx/cjs')
} catch {
  require('ts-node/register/transpile-only')
}

const N = Number(process.argv[2] || 200)
const BATCH = 64

function makeTexts(count) {
  const texts = []
  for (let i = 0; i < count; i++) {
    texts.push(
      `测试 #${i}：用户询问了关于 Kubernetes 在生产环境的部署方案，` +
      `特别是 helm chart 的版本管理与 ConfigMap 注入实践。` +
      `回答中提到了 helm secrets / sops 加密、values.yaml 分层结构、` +
      `以及 GitOps（ArgoCD/Flux）下的同步策略。`
    )
  }
  return texts
}

async function timeit(label, fn) {
  // 预热一次（消除 JIT/IO 抖动）
  // 对 case A 来说也跑了一遍预热即测试本身
  const t0 = Date.now()
  await fn()
  const dt = Date.now() - t0
  console.log(`  ${label.padEnd(36)} ${dt}ms`)
  return dt
}

;(async () => {
  const { initLogging, setLogLevel } = require('../electron/utils/logger')
  initLogging()
  setLogLevel('error')  // benchmark 期间静音 info/warn，避免干扰

  const { getEmbeddingService } = require('../electron/services/knowledge/embedding')
  const svc = getEmbeddingService()

  console.log('Loading embedding model...')
  const tLoad = Date.now()
  await svc.initialize()
  console.log(`Model loaded in ${Date.now() - tLoad}ms`)
  const dim = svc.getDimensions ? svc.getDimensions() : 'unknown'
  console.log(`Dimensions: ${dim}\n`)

  const texts = makeTexts(N)

  // 推理预热（首次 ONNX 推理会触发 JIT，独立排除）
  console.log('Warmup...')
  await svc.embed(['warmup'])

  console.log(`\n=== 基准测试 (N=${N}, batch=${BATCH}) ===\n`)

  // A: 单条 baseline
  const tA = await timeit('A 单条 baseline embed([1])      ', async () => {
    await svc.embed([texts[0]])
  })

  // B: 模拟旧实现（N 次单条调用）
  const tB = await timeit(`B 旧实现模拟 ${N}× embed([1])    `, async () => {
    for (let i = 0; i < N; i++) {
      await svc.embed([texts[i]])
    }
  })

  // C: 新实现 - 单次大 batch
  const tC = await timeit(`C 新实现 1× embed([${N}])         `, async () => {
    await svc.embed(texts)
  })

  // D: 新实现真实场景 - batch=64
  const numBatches = Math.ceil(N / BATCH)
  const tD = await timeit(`D 真实场景 ${numBatches}× embed([${BATCH}])    `, async () => {
    for (let i = 0; i < N; i += BATCH) {
      await svc.embed(texts.slice(i, i + BATCH))
    }
  })

  console.log('\n=== 加速比 ===\n')
  console.log(`  D vs B (新实现 vs 旧实现)        ${(tB / tD).toFixed(2)}x`)
  console.log(`  C vs B (理论上限 vs 旧实现)      ${(tB / tC).toFixed(2)}x`)
  console.log(`  D 单条平均                       ${(tD / N).toFixed(2)} ms/条`)
  console.log(`  B 单条平均                       ${(tB / N).toFixed(2)} ms/条`)

  // 正确性快速校验：单条 vs batch 第一条向量应该相同
  console.log(`\n=== 正确性 ===\n`)

  // 直接调底层 extractor 看输出形状
  const extractor = svc.extractor
  const rawSingle = await extractor([texts[0]], { pooling: 'mean', normalize: true })
  const rawBatch = await extractor([texts[0], texts[1], texts[2]], { pooling: 'mean', normalize: true })
  console.log(`  extractor([1]) dims=${JSON.stringify(rawSingle.dims)} data.length=${rawSingle.data.length}`)
  console.log(`  extractor([3]) dims=${JSON.stringify(rawBatch.dims)} data.length=${rawBatch.data.length}`)

  const single = await svc.embed([texts[0]])
  const batched = await svc.embed([texts[0], texts[1], texts[2]])
  console.log(`  svc.embed([1])[0].length = ${single[0].length}`)
  console.log(`  svc.embed([3])[0].length = ${batched[0].length}, batched.length = ${batched.length}`)

  const diff = single[0].reduce(
    (acc, v, i) => acc + Math.abs(v - batched[0][i]),
    0
  )
  // 单条 vs batch 内同一文本的向量 L1
  console.log(`  L1(svc.embed([t])[0] − svc.embed([t,t1,t2])[0]) = ${diff.toExponential(2)}`)

  // 余弦相似度
  const dot = single[0].reduce((s, v, i) => s + v * batched[0][i], 0)
  const n1 = Math.sqrt(single[0].reduce((s, v) => s + v * v, 0))
  const n2 = Math.sqrt(batched[0].reduce((s, v) => s + v * v, 0))
  console.log(`  cosine = ${(dot / (n1 * n2)).toFixed(6)} (应非常接近 1)`)

  process.exit(0)
})().catch((err) => {
  console.error('Bench failed:', err)
  process.exit(1)
})
