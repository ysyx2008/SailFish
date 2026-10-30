/** 合并用量入口：隔离数据、真实渲染器；固定统计，不访问模型或真实会话。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launchApp } from './launch.mjs'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-context-usage-'))
const app = await launchApp(dataDir)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const check = (label, pass) => { assert.ok(pass, label); console.log(`OK ${label}`) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const chip = () => page.locator('.session-token-chip:visible').first()
const tip = () => page.locator('.session-usage-tip:visible')

async function setContext(percentage, extra = {}) {
  await page.evaluate(({ percentage, extra }) => {
    const tab = window.__usageStore.tabs.find(t => t.id === window.__usageTab)
    tab.agentState.contextBar = {
      contextTokens: Math.round(1280 * percentage), effectiveContextLength: 128000,
      effectiveModel: 'E2E model', cacheHitRate: 75,
      consumedTokens: 128000, consumedPromptTokens: 112000,
      consumedCompletionTokens: 16000, consumedCacheHitTokens: 84000,
      composition: { id: 'root', chars: 100, children: [
        { id: 'system', chars: 26, children: [
          { id: 'identity', chars: 2 }, { id: 'rules', chars: 7 },
          { id: 'skills', chars: 9 }, { id: 'knowledge', chars: 6 }, { id: 'environment', chars: 2 },
        ] },
        { id: 'tools', chars: 14, children: [{ id: 'builtin', chars: 10 }, { id: 'mcp', chars: 4 }] },
        { id: 'messages', chars: 60, children: [
          { id: 'history', chars: 48 }, { id: 'currentUser', chars: 8 }, { id: 'images', chars: 4 },
        ] },
      ] }, ...extra,
    }
  }, { percentage, extra })
  await pause(500)
}

try {
  const isolated = await app.evaluate(({ app, BrowserWindow }) => ({
    data: app.getPath('userData'), appData: app.getPath('appData'),
    muted: BrowserWindow.getAllWindows().every(w => w.webContents.isAudioMuted()),
  }))
  check('测试数据、迁移指针与音频均已隔离', isolated.data === dataDir && isolated.appData === path.join(dataDir, 'app-data') && isolated.muted)
  await page.waitForFunction(() => !!window.electronAPI?.config)
  await page.evaluate(async () => {
    await window.electronAPI.config.setSetupCompleted(true)
    await window.electronAPI.config.set('agentOnboardingCompleted', true)
    await window.electronAPI.config.set('agentOnboardingShown', true)
    await window.electronAPI.config.setAiProfiles([{ id: 'e2e', name: 'E2E', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'e2e' }])
    await window.electronAPI.config.setActiveAiProfile('e2e')
  })
  await page.reload()
  await page.waitForFunction(() => {
    const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia
    return pinia?._s.has('terminal') && pinia?._s.has('config')
  })
  await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    window.__usageConfig = pinia._s.get('config')
    window.__usageStore = pinia._s.get('terminal')
    window.__usageTab = window.__usageStore.createAssistantTab({ title: '用量界面测试' })
    window.__usageStore.focusHubConversation(window.__usageTab)
  })
  await setContext(43)
  check('默认遵循关闭的用量显示开关', await chip().count() === 0)
  await page.evaluate(() => { window.__usageConfig.showSessionTokenUsage = true })
  await chip().waitFor()
  check('上沿进度条已移除', await page.locator('.context-mini').count() === 0)
  const styles = await chip().evaluate(el => {
    const wave = el.querySelector('.session-wave-front')
    return { bg: getComputedStyle(el).backgroundColor, duration: getComputedStyle(wave).animationDuration, opacity: getComputedStyle(wave).opacity }
  })
  check('数字背景透明，波浪周期10秒、浓度20%', styles.bg === 'rgba(0, 0, 0, 0)' && styles.duration === '10s' && styles.opacity === '0.2')
  const beforeWave = await chip().locator('.session-wave-front').evaluate(el => getComputedStyle(el).transform)
  await pause(150)
  check('水面确实持续流动', await chip().locator('.session-wave-front').evaluate(el => getComputedStyle(el).transform) !== beforeWave)
  await chip().hover()
  await tip().waitFor()
  const contextLabels = await tip().locator('.context-usage-section .ctx-usage-name').allTextContents()
  check('完整保留3个一级组成和10个子项', contextLabels.length === 13)
  check('模型、准确占比及缓存统计同时可读', (await tip().textContent()).includes('E2E model') && (await tip().textContent()).includes('43%') && (await tip().textContent()).includes('84,000'))
  await tip().hover()
  await pause(350)
  check('鼠标可从数字移入面板持续阅读', await tip().count() === 1)
  const bounds = await tip().evaluate(el => ({
    top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom,
    left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right,
    vw: innerWidth, vh: innerHeight, scrollable: el.scrollHeight > el.clientHeight,
  }))
  check('完整面板限制在视口内', bounds.top >= 7 && bounds.bottom <= bounds.vh - 7 && bounds.left >= 7 && bounds.right <= bounds.vw - 7)
  await page.mouse.move(1, 1)
  await tip().waitFor({ state: 'hidden' })
  await chip().focus()
  await tip().waitFor()
  await chip().press('Escape')
  await tip().waitFor({ state: 'hidden' })
  check('键盘聚焦可查看，Esc可收起', true)
  await chip().evaluate(el => el.blur())
  for (const [percentage, expected] of [[0, 108], [43, 57], [100, -8]]) {
    await setContext(percentage, percentage === 0 ? { contextTokens: 1 } : {})
    const transform = await chip().locator('.session-water-level').getAttribute('style')
    check(`水位${percentage}%正确映射`, transform.includes(`translateY(${expected}px)`))
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  check('减少动态效果时保持静态水位', await chip().locator('.session-wave-front').evaluate(el => getComputedStyle(el).animationName) === 'none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await setContext(43, { consumedCacheHitTokens: undefined, cacheHitRate: undefined })
  await chip().hover()
  await tip().waitFor()
  check('服务商未报告缓存时不编造缓存明细', await tip().locator('.session-token-tip .ctx-usage-row.child').count() === 0)
  await setContext(0)
  check('没有上下文数据时只保留累计用量', await chip().locator('svg').count() === 0 && await tip().locator('.context-usage-section').count() === 0)
  await setContext(43, { effectiveModel: 'E2E ' + 'long-model-name-'.repeat(20) })
  check('长模型名称换行，不撑破面板', await tip().evaluate(el => el.scrollWidth <= el.clientWidth))
  await setContext(43)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600))
  await pause(400)
  await chip().hover()
  await tip().waitFor()
  const small = await tip().evaluate(el => {
    const box = el.getBoundingClientRect()
    el.scrollTop = el.scrollHeight
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, vw: innerWidth, vh: innerHeight, scrolled: el.scrollTop > 0 }
  })
  check('小窗口面板不越界且明细可滚动', small.left >= 7 && small.right <= small.vw - 7 && small.top >= 7 && small.bottom <= small.vh - 7 && small.scrolled)
  if (process.env.E2E_SHOT) {
    fs.mkdirSync(process.env.E2E_SHOT, { recursive: true })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 900))
    await pause(200)
    await chip().hover()
    await tip().waitFor()
    await tip().hover()
    await tip().evaluate(el => { el.scrollTop = 0 })
    await page.screenshot({ path: path.join(process.env.E2E_SHOT, 'usage-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.evaluate(() => {
      window.__usageConfig.uiThemeMode = 'manual'
      window.__usageConfig.uiTheme = 'light'
    })
    await pause(150)
    check('浅色主题沿用原面板背景', await tip().evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(255, 255, 255)')
    await page.screenshot({ path: path.join(process.env.E2E_SHOT, 'usage-light.png') })
  }
  await page.evaluate(() => {
    const id = window.__usageStore.createAssistantTab({ title: '另一场测试对话' })
    window.__usageStore.focusHubConversation(id)
  })
  await tip().waitFor({ state: 'hidden' })
  check('切换对话不会留下旧用量面板', true)
  await page.evaluate(() => window.__usageStore.focusHubConversation(window.__usageTab))
  await chip().waitFor()
  await chip().hover()
  await tip().waitFor()
  await page.evaluate(() => { window.__usageConfig.showSessionTokenUsage = false })
  await chip().waitFor({ state: 'hidden' })
  check('关闭用量显示时面板也及时消失', await tip().count() === 0)
  check('没有渲染器异常', errors.length === 0)
} finally {
  await app.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
