/* eslint-env node */
/** node scripts/cli-e2e/watch-tool-timeout.cjs：真实工具/服务/落盘，临时数据，不调用模型。 */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const Module = require('node:module')
const ROOT = path.resolve(__dirname, '../..')
const dataDir = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'sft-watch-timeout-'))
process.env.SFT_DATA_DIR = dataDir
process.env.SFT_CLI_NO_BORROW = '1'
process.env.SFT_CLI_MODE = '1'
process.env.TSX_TSCONFIG_PATH = path.join(ROOT, 'tsconfig.json')
const resolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-updater') return path.join(ROOT, 'electron/cli/electron-shim.js')
  return resolve.call(this, request, ...rest)
}
require('tsx/cjs')
require(path.join(ROOT, 'electron/cli/cli-data.js')).setupCliDataDir({ defaultSandbox: true })
require(path.join(ROOT, 'electron/utils/logger.ts')).initLogging('warn')
const { executeWatchTool } = require(path.join(ROOT, 'electron/services/agent/skills/watch/executor.ts'))
const { getWatchService } = require(path.join(ROOT, 'electron/services/watch/watch.service.ts'))
const { watchExecutionTimeoutMs } = require(path.join(ROOT, 'electron/services/watch/execution-timeout.ts'))
const service = getWatchService()
const tool = (name, args) => executeWatchTool(name, '', args, 'test', {}, {})
const create = (name, extra = {}) => tool('watch_create', { name, prompt: '只处理合成数据', triggers: [{ type: 'manual' }], enabled: false, ...extra })
let checks = 0
function check(label, condition) { assert.ok(condition, label); checks++; console.log(`OK ${label}`) }
async function main() {
  if (process.argv[2]) {
    const watch = service.getAll().find(w => w.name === 'custom')
    check('新进程读回时长与其它配置', watch.execution.timeout === 1800 && watch.execution.workingDirectory === '/tmp/synthetic')
    check('实际执行时限读取修改后的值', watchExecutionTimeoutMs(watch.execution.timeout) === 1800000)
    return
  }
  try {
    const defaultResult = await create('default')
    check('创建省略默认 15 分钟且回执可见', defaultResult.success && defaultResult.output.includes('15 分钟'))
    check('默认配置不写另一份时长', service.getAll()[0].execution.timeout === undefined)
    for (const minutes of [1, 45, 1440]) {
      const result = await create(`limit-${minutes}`, { timeout_minutes: minutes })
      const watch = service.getAll().find(w => w.name === `limit-${minutes}`)
      check(`创建 ${minutes} 分钟正确换算秒`, result.success && watch.execution.timeout === minutes * 60)
    }
    await create('custom', { timeout_minutes: 30 })
    const watch = service.getAll().find(w => w.name === 'custom')
    service.update(watch.id, { execution: { ...watch.execution, workingDirectory: '/tmp/synthetic', timeout: 2700 } })
    const list = await tool('watch_list', {})
    check('列表读取界面共用字段', list.output.includes('单次最长: 45 分钟'))
    check('列表显示未显式设置的默认值', list.output.includes('单次最长: 15 分钟'))
    for (const minutes of [1, 1440]) {
      const result = await tool('watch_update', { watch_id: watch.id, timeout_minutes: minutes })
      check(`修改允许边界 ${minutes} 分钟`, result.success && service.get(watch.id).execution.timeout === minutes * 60)
    }
    const updated = await tool('watch_update', { watch_id: watch.id, timeout_minutes: 30 })
    check('工具更新实际字段并返回时长', updated.success && service.get(watch.id).execution.timeout === 1800 && updated.output.includes('30 分钟'))
    check('只改时长保留执行环境', service.get(watch.id).execution.workingDirectory === '/tmp/synthetic' && service.get(watch.id).execution.type === 'local')
    await tool('watch_update', { watch_id: watch.id, name: 'custom' })
    check('省略时长保留旧配置', service.get(watch.id).execution.timeout === 1800)
    for (const value of [0, -1, 1441, 1.5, '30', null, true, NaN, Infinity]) {
      const before = JSON.stringify(service.getAll())
      const created = await create('invalid', { timeout_minutes: value })
      const updated = await tool('watch_update', { watch_id: watch.id, name: '不应保存', timeout_minutes: value })
      check(`拒绝非法值 ${String(value)} 且不部分保存`, !created.success && !updated.success && JSON.stringify(service.getAll()) === before)
    }
    const missing = await tool('watch_update', { watch_id: 'missing', timeout_minutes: 30 })
    check('关切不存在明确失败', !missing.success)
    const child = spawnSync(process.execPath, [__filename, dataDir], { cwd: ROOT, encoding: 'utf8', timeout: 30000 })
    assert.equal(child.status, 0, child.stdout + child.stderr)
    console.log(child.stdout)
    console.log(`通过 ${checks} 项工具检查及 2 项新进程检查`)
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
