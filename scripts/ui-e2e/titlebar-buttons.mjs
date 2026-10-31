/** 顶栏按钮：隔离真实窗口验证跨面板/主题、焦点、导航豁免和操作可用。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { launchApp } from './launch.mjs'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-titlebar-'))
const app = await launchApp(dir)
const page = await app.firstWindow()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (label, passed, detail = '') => { assert.ok(passed, `${label}: ${detail}`); console.log('OK '+label) }
async function buttons(label, selector) {
  const controls = page.locator(selector)
  check(`${label}入口存在`, await controls.count() > 0)
  const metrics = await controls.evaluateAll(elements => elements.map(el => {
    const css = getComputedStyle(el), rect = el.getBoundingClientRect()
    return { width: rect.width, height: rect.height, radius: css.borderTopLeftRadius, border: css.borderTopWidth, style: css.borderTopStyle, region: css.webkitAppRegion, transform: css.transform, iconWidth: el.querySelector('svg')?.getBoundingClientRect().width }
  }))
  check(`${label}按钮遵循共同外观且可点击`, metrics.every(m => m.width === 22 && m.height === 22 && m.radius === '5px' && m.border === '1px' && m.style === 'solid' && m.region === 'no-drag' && m.transform === 'none' && m.iconWidth === 16), JSON.stringify(metrics))
}
async function dismissDialogs() {
  for (let i = 0; i < 5; i++) {
    const ok = page.locator('.confirm-overlay button:visible').last()
    if (!await ok.count()) return
    await ok.click({force:true}); await pause(200)
  }
}
async function menu(text) {
  await dismissDialogs()
  // 底部启动状态条可能遮住菜单入口；这里只准备被测面板，顶栏仍用真实点击验证。
  await page.locator('.secretary-btn').dispatchEvent('click')
  await page.locator('.secretary-menu .menu-item').filter({hasText:text}).dispatchEvent('click')
  await dismissDialogs()
}
try {
  await page.waitForFunction(() => !!window.electronAPI?.config)
  await page.evaluate(async () => {
    await window.electronAPI.config.setSetupCompleted(true)
    await window.electronAPI.config.setAiProfiles([{id:'e2e',name:'e2e',apiUrl:'http://127.0.0.1:1/v1',apiKey:'x',model:'e2e'}])
    await window.electronAPI.config.setActiveAiProfile('e2e')
  })
  await page.reload()
  await page.locator('.secretary-btn').waitFor()
  await dismissDialogs()
  await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    window.__tbStore = pinia._s.get('terminal')
    window.__tbConfig = pinia._s.get('config')
    window.__tbTab = window.__tbStore.createAssistantTab({title:'顶栏一致性'})
    window.__tbStore.markAssistantSkipOnboarding(window.__tbTab)
    window.__tbStore.focusHubConversation(window.__tbTab)
  })
  await page.locator('.assistant-workbench').waitFor()
  await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    pinia._s.get('assistantArtifact').open(window.__tbTab,{renderer:'markdown',artifactId:'titlebar-file',title:'验收稿',content:'这是隔离数据里的顶栏验收稿。',activate:true})
  })
  await page.locator('.canvas-panel').waitFor()
  for (const theme of ['dark','light','blue']) {
    await page.evaluate(async value => { await window.__tbConfig.setUiThemeMode('manual'); await window.__tbConfig.setUiTheme(value) },theme)
    await pause(200)
    await buttons(`${theme} 壳层侧栏`,'.sidebar-toggle-btn')
    await buttons(`${theme} 产出物操作`,'.canvas-header .canvas-icon-btn')
    await buttons(`${theme} 面板收起`,'.artifact-chrome--fold > button')
    const nav = await page.locator('.shell-nav-btn').evaluateAll(els => els.map(el => ({border:getComputedStyle(el).borderTopWidth,common:el.classList.contains('btn-icon-header')})))
    check(`${theme} 前进后退保持导航原样`, nav.length === 2 && nav.every(m => m.border === '0px' && !m.common),JSON.stringify(nav))
  }
  if (process.env.E2E_SHOT) { fs.mkdirSync(process.env.E2E_SHOT,{recursive:true}); await page.screenshot({path:path.join(process.env.E2E_SHOT,'titlebar-artifact.png')}) }
  const focus = page.locator('.canvas-header .canvas-icon-btn').last()
  await focus.hover(); await pause(160)
  check('悬停不放大不发光', await focus.evaluate(el => getComputedStyle(el).transform === 'none' && getComputedStyle(el.querySelector('svg')).filter === 'none'))
  await page.keyboard.press('Tab'); await focus.focus()
  check('键盘焦点可见', await focus.evaluate(el => getComputedStyle(el).outlineStyle === 'solid' && getComputedStyle(el).outlineWidth === '2px'))
  const save = page.locator('.canvas-save-text-btn')
  check('未修改时保存仍禁用', await save.isDisabled())
  await page.locator('.artifact-chrome--fold > button').click()
  await page.locator('.artifact-chrome--cluster > button[aria-expanded="false"]').click()
  check('描边按钮仍可收起再展开产出物', await page.locator('.canvas-panel').isVisible())
  await menu(/控制面板|设置/)
  await page.locator('.settings-header').waitFor()
  await buttons('设置顶栏','.settings-header .btn-icon-header')
  await page.locator('.settings-header button').click()
  await menu(/^关切$/)
  await page.locator('.watch-panel .panel-header').waitFor()
  await buttons('关切顶栏','.watch-panel .panel-header .btn-icon-header')
  await page.locator('.watch-panel .panel-header button').click()
  await menu(/^觉醒$/)
  await page.locator('.watch-panel .panel-header').waitFor()
  await buttons('觉醒顶栏','.watch-panel .panel-header .btn-icon-header')
  await page.locator('.watch-panel .panel-header button').click()
  await page.evaluate(async () => { window.__tbTerminal = await window.__tbStore.createTab('local') })
  await page.locator('.tab-bar--terminal .btn-new-tab').waitFor()
  await buttons('终端新建及工具','.tab-bar--terminal .btn-new-tab, .tab-bar--terminal .btn-new-tab-dropdown')
  await buttons('终端对话开关','.ai-panel-toggle-btn')
  await page.locator('.btn-new-tab-dropdown').click()
  check('终端下拉仍可打开', await page.locator('.shell-menu').isVisible())
  await page.keyboard.press('Escape')
  const shot = process.env.E2E_SHOT
  if (shot) { fs.mkdirSync(shot,{recursive:true}); await page.screenshot({path:path.join(shot,'titlebar-terminal.png')}) }
  check('页面没有运行时异常', errors.length === 0, errors.join('\n'))
  console.log('RESULT PASS')
} finally {
  // 本用例真实创建了临时终端；清理时直接退出隔离测试实例，避免关闭终端确认阻塞。
  await app.evaluate(({ app }) => { app.exit(0) }).catch(() => undefined)
  await app.close().catch(() => undefined)
  if (!process.env.E2E_KEEP) fs.rmSync(dir,{recursive:true,force:true})
}
