#!/usr/bin/env node
/* eslint-env node */
/**
 * SailFish CLI Entry Point
 *
 * Data layout (dev entry):
 *   - Default: {desktop}/cli-sandbox + borrow AI Profiles/keys
 *   - --share-desktop or SFT_CLI_SHARE_DESKTOP=1 → real desktop userData
 *   - --sandbox or SFT_CLI_SANDBOX=1 → same as default sandbox
 *   - SFT_DATA_DIR → custom sandbox (tests use a temp dir)
 *
 * Usage:
 *   node electron/cli/main.js <command> [options]
 *   npm run sailfish -- <command> [options]
 */
'use strict'

// Node 自己往 stderr 打 localStorage 实验警告，监听 warning 事件也拦不住默认那一行。
// 只滤掉这一句和紧跟着的 trace 提示，别的警告照旧。
{
  const write = process.stderr.write
  let dropTraceHint = false
  process.stderr.write = function (chunk, encoding, callback) {
    const text = typeof chunk === 'string' ? chunk : (chunk && chunk.toString ? chunk.toString() : '')
    if (dropTraceHint && text.includes('--trace-warnings')) {
      dropTraceHint = false
      if (typeof encoding === 'function') encoding()
      else if (typeof callback === 'function') callback()
      return true
    }
    if (text.includes('localStorage is not available because --localstorage-file')) {
      dropTraceHint = true
      if (typeof encoding === 'function') encoding()
      else if (typeof callback === 'function') callback()
      return true
    }
    return write.call(process.stderr, chunk, encoding, callback)
  }
}

const Module = require('module')
const path = require('path')

// ==================== Step 1: Register Electron Shim ====================

const shimPath = path.join(__dirname, 'electron-shim.js')
const origResolve = Module._resolveFilename

Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'electron') {
    return shimPath
  }
  if (request === 'electron-updater') {
    return shimPath
  }
  return origResolve.call(this, request, parent, isMain, options)
}

// ==================== Step 2: Early flags + data dir ====================

process.env.SFT_CLI_MODE = '1'

// Data-dir flags must be applied before services load (shim freezes userData at require time)
const rawArgv = process.argv.slice(2)
const filtered = []
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i]
  if (a === '--sandbox') {
    process.env.SFT_CLI_SANDBOX = '1'
    continue
  }
  if (a === '--share-desktop') {
    process.env.SFT_CLI_SHARE_DESKTOP = '1'
    continue
  }
  if (a === '--free') {
    // Normalize to --mode free for index.ts; keep a marker flag too
    filtered.push('--mode', 'free')
    continue
  }
  filtered.push(a)
}
process.argv = [process.argv[0], process.argv[1], ...filtered]

// TypeScript 必须先于数据目录：数据目录要读 OEM 配置（.ts）。
try {
  require('tsx/cjs')
} catch (e) {
  try {
    require('ts-node/register/transpile-only')
  } catch (e2) {
    console.error(
      'Error: TypeScript support is required for CLI mode.\n' +
      'Please install tsx: npm install -D tsx\n' +
      'Or ts-node:       npm install -D ts-node'
    )
    process.exit(1)
  }
}

require('./cli-data.js').setupCliDataDir({ defaultSandbox: true })

// ==================== Step 4: Run CLI ====================

const { runCli } = require('./index.ts')
runCli()
  .then(() => {
    // 显式退出：AI keep-alive / 定时器等可能让事件循环空转十几秒
    process.exit(process.exitCode || 0)
  })
  .catch((error) => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
