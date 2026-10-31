/** 十层负责人和末层执行成员完整展示：静默隔离窗口，不调用模型。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-team-deep-tree-'))
const app = await launchApp(directory)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const check = (label, ok) => { if (!ok) throw Error(label); console.log(`OK ${label}`) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  await page.waitForFunction(() => window.electronAPI?.config)
  await page.evaluate(async () => {
    await window.electronAPI.config.setSetupCompleted(true)
    await window.electronAPI.config.setAiProfiles([{ id: 'fixture', name: 'fixture', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'fixture' }])
    await window.electronAPI.config.setActiveAiProfile('fixture')
  })
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal')
    const id = store.createAssistantTab({ title: '十层完整展示验证' })
    store.markAssistantSkipOnboarding(id); store.focusHubConversation(id)
    const members = Array.from({ length: 10 }, (_, i) => ({ id: `负责人${i + 1}`, name: `负责人${i + 1}`, description: `管理第${i + 1}层`, status: 'running', lead: true, ...(i ? { parent: `负责人${i}` } : {}) }))
    members.push({ id: '末层成员', name: '末层成员', description: '第十层负责人派出的执行成员', status: 'running', parent: '负责人10' })
    store.addAgentStep(id, { id: 'request', type: 'user_task', content: '十层完整展示', timestamp: Date.now() })
    store.addAgentStep(id, { id: 'deep', type: 'tool_call', toolName: 'dispatch_agents', content: '十层夹具', timestamp: Date.now(), success: true,
      organization: { teamId: 'deep-team', total: 11, live: 11, teams: [], members: members.map(member => ({ ...member, teamId: 'deep-team' })) } })
  })
  await pause(1500)
  for (let i = 0; i < 8; i++) {
    const dialog = page.locator('.confirm-overlay button:visible').last()
    if (await dialog.count()) await dialog.click({ force: true, timeout: 1000 }).catch(() => {})
    await pause(200)
  }
  await page.locator('.dock-team').click()
  await page.locator('.org-node[data-member="末层成员"]').waitFor({ state: 'attached' })
  check('十层负责人和末层执行成员全部有槽位', await page.locator('.org-node').count() === 11)
  check('绘制深度包含最末一层，不在第八层截断', await page.locator('.org-node[data-member="末层成员"]').getAttribute('data-depth') === '10')
  const leaf = page.locator('.org-node[data-member="末层成员"]')
  await leaf.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
  await leaf.locator('.org-node-name-text').waitFor()
  check('横向滚动后最末成员可实际阅读', (await leaf.innerText()).includes('第十层负责人派出的执行成员'))
  await leaf.click()
  await page.locator('.od-header .tph-title').getByText('末层成员', { exact: true }).waitFor()
  check('最末成员仍可打开右侧详情', await page.locator('.oc-detail').count() === 1)
  await page.locator('.od-header .tph-close').click()
  const lastLead = page.locator('.org-node[data-member="负责人10"]')
  await lastLead.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
  await lastLead.locator('.org-node-name-text').waitFor()
  check('无role的负责人仍显示负责人标记', await lastLead.locator('.org-node-rank').count() === 1)
  await lastLead.click()
  await page.locator('.od-header .tph-title').getByText('负责人10', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  check('深层详情关闭后仍保留整棵树', await page.locator('.oc-detail').count() === 0 && await page.locator('.org-node').count() === 11)
  if (process.env.E2E_SHOT) {
    fs.mkdirSync(process.env.E2E_SHOT, { recursive: true })
    await page.screenshot({ path: path.join(process.env.E2E_SHOT, 'team-deep-tree.png') })
  }
  console.log('RESULT PASS')
} finally {
  const timeout = setTimeout(() => app.process()?.kill('SIGKILL'), 5000)
  try { await app.close().catch(() => {}) } finally { clearTimeout(timeout); fs.rmSync(directory, { recursive: true, force: true }) }
}
