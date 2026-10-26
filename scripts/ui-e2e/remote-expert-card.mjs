/**
 * 派伙计连远程主机的确认卡——运维专家的话在卡前面那一行里，卡上不再重复。
 * 临时数据目录，窗口不抢前台。往一个助手页里直接放一张确认卡，量卡的样子并截图。
 *
 *   npx vite build && node scripts/ui-e2e/remote-expert-card.mjs
 *   E2E_SHOT=/tmp/shots node scripts/ui-e2e/remote-expert-card.mjs
 *
 * 1. 请求带着专家的话：卡上也没有这一栏，只有命令与主机
 * 2. 请求没带：同上
 * 3. 伙计的命令清单不一样：按块分开
 */
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-remote-expert-card-'))
const shotDir = process.env.E2E_SHOT
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
const app = await launchApp(dataDir)
const page = await app.firstWindow()
const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) }) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ready() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      await page.evaluate(async () => {
        if (!window.electronAPI?.config) throw new Error('接口还没出现')
        await window.electronAPI.config.setSetupCompleted(true)
        // 界面要有一个模型配置才显示对话面板；这里一次都不会真的调用
        await window.electronAPI.config.setAiProfiles([{ id: 'e2e', name: 'e2e', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'e2e' }])
        await window.electronAPI.config.setActiveAiProfile?.('e2e')
      })
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


const confirmation = (expert) => ({
  toolName: 'dispatch_agents',
  displayName: '派出伙计连接远程主机',
  riskLevel: 'moderate',
  toolArgs: {},
  remoteAccess: {
    workerCount: 2,
    commands: ['systemctl restart nginx', 'df -h'],
    hosts: [
      { id: 'a1', name: 'web-01', address: 'deploy@10.0.0.11:22', group: '生产' },
      { id: 'a2', name: 'lab', address: 'root@10.0.1.5:22' },
    ],
  },
})

const setConfirm = (value) => page.evaluate(([v]) => window.__e2eStore.setAgentPendingConfirm(window.__e2eTab, v), [value])
const pushStep = (step) => page.evaluate(([s]) => window.__e2eStore.addAgentStep(window.__e2eTab, s), [step])

try {
  await ready()
  const tabId = await openAssistant()
  console.log(`\n助手页 ${tabId}`)
  await page.locator('.ai-messages-wrapper:visible').first().waitFor({ state: 'attached', timeout: 30_000 })
  await pushStep({ id: 'u1', type: 'user_task', content: '帮我看看生产机的磁盘', timestamp: Date.now() })

  console.log('\n[1] 请求里带着专家的话（给命令行、IM 用）：桌面确认卡不重复写')
  await setConfirm(confirmation('其中 systemctl restart nginx 会让生产站点短暂中断，你原话只让我看磁盘。\n是否仍要批准？'))
  await page.locator('.remote-access').first().waitFor({ state: 'visible', timeout: 15_000 })
  const card = page.locator('.remote-access').first()
  const text = await card.innerText()
  check('卡上没有「运维专家的话」', !/运维专家/.test(text) && !/短暂中断/.test(text), text)
  check('命令与主机照常显示', /df -h/.test(text) && /web-01/.test(text) && /未分组/.test(text), text)
  const box = await card.boundingBox()
  check('卡没有被撑出屏幕', box && box.width > 100 && box.width < 1600, JSON.stringify(box))
  await shot('1-with-expert')

  console.log('\n[2] 专家没写话')
  await setConfirm(confirmation(undefined))
  await sleep(300)
  const plain = await page.locator('.remote-access').first().innerText()
  check('没有专家这一栏', !/运维专家/.test(plain), plain)
  check('命令与主机照常显示', /systemctl restart nginx/.test(plain) && /web-01/.test(plain), plain)
  await shot('2-without-expert')

  console.log('\n[3] 伙计的命令清单不一样：按块分开，每块写自己的命令和主机')
  const web = { id: 'a1', name: 'web-01', address: 'deploy@10.0.0.11:22', group: '生产' }
  const lab = { id: 'a2', name: 'lab', address: 'root@10.0.1.5:22' }
  const split = confirmation(undefined)
  split.remoteAccess.assignments = [
    { workerCount: 1, hosts: [web], commands: ['df -h'] },
    { workerCount: 1, hosts: [lab], commands: ['uptime'] },
  ]
  await setConfirm(split)
  await sleep(300)
  const blocksText = await page.locator('.remote-access').first().innerText()
  check('分成两块，各有标题', /第 1 块/.test(blocksText) && /第 2 块/.test(blocksText), blocksText)
  check('第一块是 web-01 和 df，第二块是 lab 和 uptime',
    blocksText.indexOf('df -h') < blocksText.indexOf('web-01') && blocksText.indexOf('web-01') < blocksText.indexOf('第 2 块') &&
    blocksText.indexOf('第 2 块') < blocksText.indexOf('uptime') && blocksText.indexOf('uptime') < blocksText.indexOf('lab'), blocksText)
  const blockBox = await page.locator('.remote-access').first().boundingBox()
  check('分块的卡没有被撑出屏幕', blockBox && blockBox.width > 100 && blockBox.width < 1600, JSON.stringify(blockBox))
  await shot('3-blocks')
} catch (error) {
  failures.push(`脚本出错：${error instanceof Error ? error.message : error}`)
  console.error(error)
} finally {
  await app.close().catch(() => undefined)
  if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
