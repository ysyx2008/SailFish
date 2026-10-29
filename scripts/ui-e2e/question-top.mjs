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
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '测试回答。' }, finish_reason: null }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const modelUrl = `http://127.0.0.1:${server.address().port}/v1`
const app = await launchApp(dataDir)
const page = await app.firstWindow()
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
  await sleep(1800)
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
  await ready()
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
  if (failures.length) process.exitCode = 1
} finally {
  await app.close()
  server.close()
  if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
}
