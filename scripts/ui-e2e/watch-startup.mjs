/** 桌面启动冒烟：真实 Electron、临时数据、主窗口与关切各页，默认不抢前台。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launchApp } from './launch.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-watch-startup-'))
const screenshot = path.join(dataDir, 'watch-panel.png')
fs.writeFileSync(path.join(dataDir, 'qiyu-terminal-config.json'), JSON.stringify({
  setupCompleted: true, agentOnboardingCompleted: true, agentOnboardingShown: true,
  agentAwakened: false, language: 'zh-CN',
}))
const errors = []
let stderr = ''
let app
let page
const check = (label, pass) => { assert.ok(pass, label); console.log(`OK ${label}`) }
try {
  app = await launchApp(dataDir)
  app.process().stderr?.on('data', chunk => { stderr += chunk })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => !!window.electronAPI?.watch && !!document.querySelector('.app-container'), undefined, { timeout: 90000 })
  check('当前分支真实 Electron 主窗口已打开', !page.isClosed())
  const isolated = await app.evaluate(({ app, BrowserWindow }) => ({
    data: app.getPath('userData'), appData: app.getPath('appData'),
    muted: BrowserWindow.getAllWindows().every(window => window.webContents.isAudioMuted()),
  }))
  check('测试数据与音频均已隔离', isolated.data === dataDir && isolated.appData === path.join(dataDir, 'app-data') && isolated.muted)
  const fixture = await page.evaluate(() => window.electronAPI.watch.create({
    name: '启动验收专用关切', prompt: '仅用于界面验收，不执行', enabled: false,
    triggers: [{ type: 'manual' }], execution: { type: 'local' }, output: { type: 'silent' },
    state: { fingerprint: 'x'.repeat(1437), nested: { value: true } },
  }))
  check('窗口通过真实 IPC 创建隔离关切', !!fixture?.id)
  await page.locator('.action-card').filter({ has: page.locator('.card-icon.watch') }).click({ timeout: 30000 })
  const panel = page.locator('.watch-panel')
  await panel.waitFor({ state: 'visible' })
  check('关切总览页面能正常打开', await panel.locator('.panel-nav .nav-item').nth(0).evaluate(el => el.classList.contains('active')))
  await panel.locator('.panel-nav .nav-item').nth(1).click()
  await panel.getByText('启动验收专用关切', { exact: true }).first().waitFor()
  check('关切列表通过真实后端加载并显示测试关切', true)
  const loaded = await page.evaluate(id => window.electronAPI.watch.get(id), fixture.id)
  check('桌面 IPC 读回完整 1437 字符状态及嵌套对象', loaded.state.fingerprint.length === 1437 && loaded.state.nested.value === true)
  await panel.locator('.panel-nav .nav-item').nth(2).click()
  const templates = await page.evaluate(() => window.electronAPI.watch.getTemplates())
  check('模板页能打开且后端返回模板', await panel.locator('.panel-nav .nav-item').nth(2).evaluate(el => el.classList.contains('active')) && templates.length > 0)
  await panel.locator('.panel-nav .nav-item').nth(3).click()
  check('运行历史页能打开', await panel.locator('.panel-nav .nav-item').nth(3).evaluate(el => el.classList.contains('active')))
  await panel.locator('.panel-nav .nav-item').nth(1).click()
  await panel.locator('.panel-nav .nav-item').nth(1).evaluate(el => { if (!el.classList.contains('active')) throw new Error('关切列表未激活') })
  await page.waitForTimeout(300)
  await page.screenshot({ path: screenshot })
  await page.waitForTimeout(1000)
  check('主窗口没有渲染器未捕获异常', errors.length === 0)
  check('没有主进程崩溃或未处理异常', !/Uncaught Exception|UnhandledPromiseRejection|A JavaScript error occurred in the main process/.test(stderr))
  console.log('SCREENSHOT', screenshot)
  console.log('DATA_DIR', dataDir)
  console.log('全部通过')
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(dataDir, 'failure.png') }).catch(() => {})
  console.error('DATA_DIR', dataDir)
  console.error('PAGE_ERRORS', JSON.stringify(errors))
  throw error
} finally {
  fs.writeFileSync(path.join(dataDir, 'electron-stderr.log'), stderr)
  if (app) await app.close()
}
