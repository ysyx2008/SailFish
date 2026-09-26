#!/usr/bin/env node
/* eslint-env node */
/**
 * 替我审批评审员的真模型评测：把造好的请求直接交给评审员，不经过干活的助手。
 * 数据目录与命令行一致（默认沙箱，借用桌面的模型配置）；会花真 token。
 *
 *   node scripts/eval-auto-review.cjs            # 全部场景
 *   node scripts/eval-auto-review.cjs inject     # 只跑名字含 inject 的场景
 *   node scripts/eval-auto-review.cjs --profile=deepseek-v4-pro   # 指定模型（配置名、id 或模型名）
 */
'use strict'

const Module = require('module')
const path = require('path')

const cliDir = path.join(__dirname, '..', 'electron', 'cli')
const shimPath = path.join(cliDir, 'electron-shim.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'electron' || request === 'electron-updater') return shimPath
  return origResolve.call(this, request, parent, isMain, options)
}

process.env.SFT_CLI_MODE = '1'
require(path.join(cliDir, 'cli-data.js')).setupCliDataDir({ defaultSandbox: true })
require('tsx/cjs')

require('./eval-auto-review.ts')
  .main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
