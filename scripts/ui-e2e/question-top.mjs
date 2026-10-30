/** 新一轮提问置顶：隔离数据、真实窗口，沿用现有暂停和恢复跟随。 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'

const failures = []
const check = (label, pass, detail) => {
  if (pass) console.log(`  OK   ${label}`)
  else {
    failures.push(label)
    console.error(`  FAIL ${label}${detail ? ` — ${String(detail).slice(0, 500)}` : ''}`)
  }
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-question-top-'))
const shotDir = process.env.E2E_SHOT
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
let streamNext = false
let finishStream = null
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    if (streamNext) {
      streamNext = false
      const packet = content => 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\n\n'
      res.write(packet('面板重排测试，模型正在输出'))
      const timer = setInterval(() => res.write(packet('。')), 120)
      finishStream = () => {
        clearInterval(timer)
        res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
        finishStream = null
      }
      res.once('close', () => clearInterval(timer))
      return
    }
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '测试回答。' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`
const app = await launchApp(dataDir)
const page = await app.firstWindow()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))
const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) }) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ready() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      await page.evaluate(async modelUrl => {
        if (!window.electronAPI?.config) throw new Error('接口还没出现')
        await window.electronAPI.config.setSetupCompleted(true)
        await window.electronAPI.config.set('agentOnboardingCompleted', true)
        await window.electronAPI.config.set('agentOnboardingShown', true)
        await window.electronAPI.config.set('foldAgentProcess', false)
        // 使用本地固定响应，不访问真实模型或用户数据
        await window.electronAPI.config.setAiProfiles([{ id: 'e2e', name: 'e2e', apiUrl: modelUrl, apiKey: 'x', model: 'e2e' }])
        await window.electronAPI.config.setActiveAiProfile?.('e2e')
      }, modelUrl)
      await page.reload()
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error('应用没起来')
}

/** 在页面里拿到终端 store，开一个助手页并让它显示在前面 */
async function openAssistant() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const tabId = await page.evaluate(() => {
        const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia
        const store = pinia?._s.get('terminal')
        if (!store) throw new Error('store 还没出现')
        const id = store.createAssistantTab({ title: '测试对话' })
        store.focusHubConversation(id)
        window.__e2eStore = store
        window.__e2eTab = id
        return id
      })
      return tabId
    } catch {
      await sleep(500)
    }
  }
  throw new Error('开不出助手页')
}


const box = () => page.locator('.ai-messages:visible').first()
async function send(text) {
  const input = page.locator('[contenteditable="true"]:visible').first()
  await input.fill(text)
  await input.press('Enter')
  await page.waitForFunction(() => {
    const tab = window.__e2eStore.tabs.find(t => t.id === window.__e2eTab)
    return !tab.agentState.isRunning && tab.agentState.steps.some(step => step.type === 'message' && step.content.includes('测试回答。'))
  }, undefined, { timeout: 15000 })
  await sleep(300)
}
async function measure() {
  return box().evaluate(el => {
    const bubbles = el.querySelectorAll('.message.user')
    const last = bubbles[bubbles.length - 1]
    return { top: last ? last.getBoundingClientRect().top - el.getBoundingClientRect().top : null,
      scroll: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      height: el.clientHeight, min: el.lastElementChild?.style.minHeight }
  })
}
async function grow(text) {
  const payload = await page.evaluate(text => {
    const tab = window.__e2eStore.tabs.find(t => t.id === window.__e2eTab)
    const message = [...tab.agentState.steps].reverse().find(s => s.type === 'message')
    if (!message) throw new Error('模型回答未出现')
    return { agentId: tab.agentId || tab.id, step: { ...message, content: message.content + '\n\n' + text } }
  }, text)
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send('agent:step', payload)
  }, payload)
}

try {
  const isolated = await app.evaluate(({ app, BrowserWindow }) => ({
    data: app.getPath('userData'), appData: app.getPath('appData'),
    muted: BrowserWindow.getAllWindows().every(window => window.webContents.isAudioMuted()),
  }))
  if (isolated.data !== dataDir || isolated.appData !== path.join(dataDir, 'app-data')) throw new Error('测试资料未隔离')
  check('用户数据及迁移指针均已隔离', true)
  check('测试窗口已静音', isolated.muted)
  await ready()
  await page.evaluate(() => {
    window.__flightCount = 0
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.message-send-transition')) window.__flightCount++
      }
    }).observe(document.body, { childList: true })
  })
  await openAssistant()
  await sleep(700)
  for (const button of await page.locator('.confirm-overlay button:visible').all()) await button.dispatchEvent('click')
  await box().waitFor({ state: 'attached', timeout: 30000 })
  await send('第一轮提问置顶测试')
  let m = await measure()
  check('首轮提问置顶', m.top !== null && Math.abs(m.top - 12) < 5, JSON.stringify(m))
  await shot('first-turn')
  const before = m.scroll
  await grow('短内容自然展开。')
  await sleep(500)
  m = await measure()
  check('短内容不推动视口', Math.abs(m.scroll - before) < 5, JSON.stringify(m))
  await grow(Array.from({ length: 65 }, (_, i) => `第 ${i + 1} 行，验证长输出跟随。`).join('\n\n'))
  await sleep(1400)
  m = await measure()
  check('长输出继续跟底', m.gap < 5 && m.scroll > 300, JSON.stringify(m))
  await box().evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }))
    el.scrollTop -= 400
  })
  await sleep(250)
  const reading = (await measure()).scroll
  await grow('用户阅读旧内容时，新消息不能抢位置。\n\n'.repeat(10))
  await sleep(600)
  m = await measure()
  check('上翻后暂停跟随', Math.abs(m.scroll - reading) < 5 && m.gap > 100, JSON.stringify(m))
  const button = page.locator('.new-message-indicator:visible').first()
  await button.dispatchEvent('click')
  await sleep(600)
  check('回到最新恢复跟随', (await measure()).gap < 5, JSON.stringify(await measure()))
  await send('已有长历史时的新一轮提问')
  m = await measure()
  check('追问置顶', m.top !== null && Math.abs(m.top - 12) < 5, JSON.stringify(m))
  await shot('follow-up')
  await send('下一次追问仍置顶')
  m = await measure()
  check('连续追问置顶', m.top !== null && Math.abs(m.top - 12) < 5, JSON.stringify(m))
  // 置顶后仍有一屏留白：离开滚动条底部不代表最新正文已经离开视口。
  await box().evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -140 }))
    el.scrollTop -= 140
  })
  await sleep(250)
  const visibleReading = (await measure()).scroll
  await page.evaluate(() => {
    window.__hintCount = 0
    new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.new-message-indicator')) window.__hintCount++
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await grow('仍在可见范围内的新增回复。')
  await sleep(1100)
  const visibleLatest = await box().evaluate(el => {
    const rows = el.querySelectorAll('[data-index]')
    const last = rows[rows.length - 1]
    return !!last && last.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom
  })
  check('置顶留白下离开滚动条底部但回复仍可见', visibleLatest && (await measure()).gap > 100)
  check('可见回复增长不弹出新消息提示', await page.evaluate(() => window.__hintCount === 0)
    && await page.locator('.new-message-indicator:visible').count() === 0)
  check('可见回复增长不抢阅读位置', Math.abs((await measure()).scroll - visibleReading) < 5)
  await grow('新增回复确实超出视口时应提示。\n\n'.repeat(65))
  await sleep(1100)
  check('新增正文超出视口才提示且不抢位置', await page.locator('.new-message-indicator:visible').count() === 1
    && Math.abs((await measure()).scroll - visibleReading) < 5)
  await page.locator('.new-message-indicator:visible').first().dispatchEvent('click')
  await sleep(600)
  check('点击提示后清除提示并恢复跟随', await page.locator('.new-message-indicator:visible').count() === 0
    && (await measure()).gap < 5)
  { // 产出物面板开合与持续输出的真实重排回归
    await grow('这段历史内容用于触发窄栏与宽栏之间明显的换行高度差。'.repeat(100))
    await sleep(500)
    await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const artifacts = pinia._s.get('assistantArtifact')
      artifacts.open(window.__e2eTab, { renderer: 'markdown', title: '重排测试', content: '# 临时产出物\n只用于隔离界面测试。' })
    })
    await page.locator('.canvas-panel:visible').waitFor({ state: 'visible' })
    await sleep(800)
    streamNext = true
    const input = page.locator('[contenteditable="true"]:visible').first()
    await input.fill('关闭产出物面板时，这条用户消息应该保持原来的可视高度。'.repeat(3))
    await input.press('Enter')
    await page.waitForFunction(() => {
      const tab = window.__e2eStore.tabs.find(t => t.id === window.__e2eTab)
      return tab.agentState.isRunning && tab.agentState.steps.some(s => s.type === 'message' && s.content.includes('面板重排测试'))
    })
    await sleep(500)
    const position = () => box().evaluate(el => {
      const rows = el.querySelectorAll('.message.user')
      const rect = rows[rows.length - 1]?.getBoundingClientRect()
      return { top: rect ? rect.top - el.getBoundingClientRect().top : null, right: rect?.right, width: el.clientWidth, scroll: el.scrollTop, min: el.lastElementChild?.style.minHeight }
    })
    const narrow = await position()
    await box().evaluate(el => {
      window.__reflowPositions = []
      const start = performance.now()
      const tick = () => {
        const rows = el.querySelectorAll('.message.user')
        const rect = rows[rows.length - 1]?.getBoundingClientRect()
        window.__reflowPositions.push(rect ? rect.top - el.getBoundingClientRect().top : null)
        if (performance.now() - start < 700) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await page.locator('.artifact-chrome-btn[aria-expanded="true"]:visible').first().dispatchEvent('click')
    await sleep(800)
    const wide = await position()
    check('流式输出中关闭产出物面板只拓宽对话', wide.width > narrow.width + 100 && wide.right > narrow.right, JSON.stringify({ narrow, wide }))
    check('关闭面板后用户消息保持原来高度', narrow.top !== null && wide.top !== null && Math.abs(wide.top - narrow.top) < 5, JSON.stringify({ narrow, wide }))
    const reflowPositions = await page.evaluate(() => window.__reflowPositions)
    check('关闭过程中用户消息不发生纵向跳动', reflowPositions.length > 2 && reflowPositions.every(y => y !== null && Math.abs(y - narrow.top) < 5), JSON.stringify(reflowPositions))
    await page.locator('.artifact-chrome-btn:has(.lucide-panel-right-open):visible').first().dispatchEvent('click')
    await sleep(800)
    await page.locator('.canvas-panel:visible').waitFor({ state: 'visible' })
    const reopened = await position()
    check('重新展开面板也保持用户消息高度', reopened.width < wide.width - 100 && Math.abs(reopened.top - narrow.top) < 5, JSON.stringify({ narrow, reopened }))
    await box().evaluate(el => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -140 }))
      el.scrollTop -= 140
    })
    await sleep(250)
    const readingBeforeClose = await position()
    await page.locator('.artifact-chrome-btn:has(.lucide-panel-right-close):visible').first().dispatchEvent('click')
    await sleep(800)
    const readingAfterClose = await position()
    check('上翻阅读时关闭面板也保持用户消息高度', readingBeforeClose.top > 20 && Math.abs(readingAfterClose.top - readingBeforeClose.top) < 5, JSON.stringify({ readingBeforeClose, readingAfterClose }))
    check('重排后可见的回复不误弹新消息提示', await page.locator('.new-message-indicator:visible').count() === 0)
    check('关闭面板后模型仍在并行输出', await page.evaluate(() => window.__e2eStore.tabs.find(t => t.id === window.__e2eTab).agentState.isRunning))
    finishStream?.()
    await page.waitForFunction(() => !window.__e2eStore.tabs.find(t => t.id === window.__e2eTab).agentState.isRunning)
  }
  check('发送仅置顶，不创建飞行动画', await page.evaluate(() => window.__flightCount === 0))
  check('界面无未捕获异常', pageErrors.length === 0, pageErrors.join('\n'))
  if (failures.length) process.exitCode = 1
} finally {
  finishStream?.()
  try {
    // 产品退出确认可能被失败测试留下的任务拦住；兜底仅作用于本次隔离实例。
    await app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 5000).unref() }).catch(() => {})
    await app.close()
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
  }
}
