/** API原因和成员等待状态：隔离、透明、静音，不调用真实模型。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-model-failure-'))
const app = await launchApp(dir)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (label, ok) => { if (!ok) throw Error(label); console.log(`OK ${label}`) }
try {
  await page.waitForFunction(() => window.electronAPI?.config)
  await page.evaluate(async () => {
    await window.electronAPI.config.setSetupCompleted(true)
    await window.electronAPI.config.setAiProfiles([{ id: 'fixture', name: 'fixture', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'fixture' }])
    await window.electronAPI.config.setActiveAiProfile('fixture')
  })
  if (process.env.E2E_THEME) await page.evaluate(async theme => { await window.electronAPI.config.setUiThemeMode('manual'); await window.electronAPI.config.setUiTheme(theme) }, process.env.E2E_THEME)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal')
    const id = store.createAssistantTab({ title: 'API错误与调度验收' })
    store.markAssistantSkipOnboarding(id); store.focusHubConversation(id)
    window.__failureFixture = { store, id }
    const add = step => store.addAgentStep(id, { timestamp: Date.now(), ...step })
    add({ id: 'user', type: 'user_task', content: '观察模型调度' })
    add({ id: 'api-error', type: 'message', content: '火山模型：模型额度已耗尽', apiError: { profileName: '火山模型', model: 'provider-model-id', statusCode: 429, code: 'QuotaExceeded', category: 'quota', message: 'You have exceeded the weekly usage quota. Reset at 2099-11-02 00:00:00 +0800. <script>window.__apiInjected=true</script>' } })
    add({ id: 'retry', type: 'waiting', content: '已重试 (1/5) · HTTP 429 · QuotaExceeded', isStreaming: false, apiError: { model: '火山模型', statusCode: 429, code: 'QuotaExceeded', message: 'weekly quota exhausted; 原因保留' } })
    add({ id: 'org', type: 'tool_call', toolName: 'dispatch_agents', content: '团队调度', success: true, organization: { teamId: 'failure', total: 4, live: 3, teams: [], members: [
      { id: '排队成员', name: '排队成员', description: '等待统一名额', status: 'running', waitingForModel: true, modelWaitReason: 'queued' },
      { id: '冷却成员', name: '冷却成员', description: '接口冷却中', status: 'running', waitingForModel: true, modelWaitReason: 'cooldown' },
      { id: '重试成员', name: '重试成员', description: '等待退避计时', status: 'running', waitingForModel: true, modelWaitReason: 'retry' },
      { id: '额度成员', name: '额度成员', description: '额度耗尽后结束等待', status: 'failed', error: '火山模型 (HTTP 429 · QuotaExceeded)：weekly quota exhausted' },
    ] } })
  })
  await pause(1500)
  for (let i = 0; i < 8; i++) {
    const dialog = page.locator('.confirm-overlay button:visible').last()
    if (await dialog.count()) await dialog.click({ force: true, timeout: 1000 }).catch(() => {})
    await pause(150)
  }
  check('错误原因在重试结束后仍有独立记录', (await page.locator('.ai-messages:visible').innerText()).includes('模型额度已耗尽') && (await page.locator('.ai-messages:visible').innerText()).includes('已重试 (1/5)'))
  const details = page.locator('.api-error-details').first()
  await details.locator('summary').click()
  check('可展开供应商原文、恢复时间、错误码和HTTP状态', /2099-11-02/.test(await details.innerText()) && /QuotaExceeded/.test(await details.innerText()) && /HTTP 429/.test(await details.innerText()))
  check('供应商内容按纯文本显示，不执行HTML', await page.evaluate(() => window.__apiInjected !== true) && (await details.locator('pre').innerText()).includes('<script>'))
  check('用户名称优先展示、摘要用冒号，模型ID仍可在详情排查', (await page.locator('.api-error-summary').first().innerText()) === '火山模型：模型额度已耗尽' && (await details.locator('.api-error-meta').innerText()).includes('火山模型') && (await details.locator('.api-error-meta').innerText()).includes('provider-model-id'))
  const geometry = await details.evaluate(el => {
    const rect = node => node.getBoundingClientRect()
    const stack = el.closest('.api-error-stack')
    const title = stack.querySelector('.api-error-summary')
    const summary = el.querySelector('.api-error-toggle')
    const meta = el.querySelector('.api-error-meta')
    const pre = el.querySelector('pre')
    return { titleLeft:rect(title).left, summaryLeft:rect(summary).left, sameRow:Math.abs(rect(summary).top - rect(title).top) < 2, bodyGap:rect(pre).top - rect(meta).bottom, lineHeight:parseFloat(getComputedStyle(pre).lineHeight), fontSize:parseFloat(getComputedStyle(pre).fontSize), overflow:el.scrollWidth > el.clientWidth }
  })
  check('摘要与详情入口同行，入口位于右侧，行距统一无溢出', geometry.summaryLeft > geometry.titleLeft && geometry.sameRow && geometry.bodyGap === 6 && Math.abs(geometry.lineHeight / geometry.fontSize - 1.6) < 0.01 && !geometry.overflow)
  await details.locator('summary').focus()
  await page.keyboard.press('Enter')
  check('详情可用键盘收起', !(await details.getAttribute('open') !== null))
  await page.keyboard.press('Enter')
  const narrow = await details.evaluate(el => {
    const previous = el.style.width
    el.style.width = '210px'
    const title = el.querySelector('.api-error-summary').getBoundingClientRect()
    const toggle = el.querySelector('.api-error-toggle').getBoundingClientRect()
    const result = { wrapped: toggle.top >= title.bottom, overflow: el.scrollWidth > el.clientWidth }
    el.style.width = previous
    return result
  })
  check('窄区域入口自然换行，详情与长文本无横向溢出', narrow.wrapped && !narrow.overflow)
  await page.locator('.api-error-summary').first().click()
  check('点击摘要所在行也可收起详情', await details.getAttribute('open') === null)
  await details.locator('summary').click()
  if (process.env.E2E_SHOT) { fs.mkdirSync(process.env.E2E_SHOT, {recursive:true}); await page.screenshot({path:path.join(process.env.E2E_SHOT,'api-error-details.png')}) }
  await page.locator('.dock-team').first().click()
  check('组织图区分请求排队与接口冷却', (await page.locator('[data-member="排队成员"]').innerText()).includes('等待请求名额') && (await page.locator('[data-member="冷却成员"]').innerText()).includes('接口冷却中'))
  check('退避单独标为等待重试', (await page.locator('[data-member="重试成员"]').innerText()).includes('等待重试'))
  const failed = page.locator('[data-member="额度成员"]')
  check('额度耗尽成员不再显示为等模型，卡片保留错误', await failed.getAttribute('data-status') === 'failed' && (await failed.getAttribute('title')).includes('QuotaExceeded') && (await failed.innerText()).includes('weekly quota exhausted'))
  if (process.env.E2E_SHOT) await page.screenshot({path:path.join(process.env.E2E_SHOT,'team-model-status.png')})
  console.log('RESULT PASS')
} finally { await app.close(); fs.rmSync(dir, {recursive:true,force:true}) }
