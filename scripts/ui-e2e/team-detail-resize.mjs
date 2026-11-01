/** 500人团队：打开/调宽详情不重排，保持阅读位置；隔离数据，不调用模型。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { launchApp } from './launch.mjs'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-team-detail-resize-'))
const stamp = Date.now()
for (let i = 0; i < 500; i++) {
  const name = `成员${i}`
  const folder = path.join(directory, 'history/sub-agents/2026-11-01', 'resize-session', `${name}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'state.json'), JSON.stringify({ name, description: `核对第${i}份资料`, prompt: '核对资料', status: 'completed', result: `${name}已完成核对`, updatedAt: stamp }))
  fs.writeFileSync(path.join(folder, 'meta.json'), JSON.stringify({ id: name, timestamp: stamp, status: 'completed', duration: 1 }))
  fs.writeFileSync(path.join(folder, 'steps.jsonl'), '')
}
const app = await launchApp(directory)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const check = (label, ok, detail = '') => { if (!ok) throw Error(`${label} ${detail}`); console.log(`OK ${label} ${detail}`) }
const positions = () => page.locator('.organization-chart .org-node').evaluateAll(nodes => JSON.stringify(nodes.map(el => [el.dataset.member, el.style.left, el.style.top])))
const geometry = () => page.locator('.oc-body').evaluate(el => {
  const node = el.querySelector('.org-node.is-selected')
  const b = el.getBoundingClientRect(), n = node?.getBoundingClientRect()
  return { top: el.scrollTop, left: el.scrollLeft, width: b.width, height: b.height, selectedVisible: !!n && n.left >= b.left && n.right <= b.right && n.top >= b.top && n.bottom <= b.bottom }
})
const detailWidth = () => page.locator('.oc-detail').evaluate(el => el.getBoundingClientRect().width)
const divider = () => page.locator('.oc-workspace > .workbench-divider').boundingBox()
async function beginDrag() {
  const box = await divider()
  await page.mouse.move(box.x, box.y + 200)
  await page.mouse.down()
  await page.waitForFunction(() => document.querySelector('.oc-workspace').classList.contains('is-resizing'))
  return box
}
async function dragTo(delta) {
  const box = await beginDrag()
  await page.mouse.move(box.x + delta, box.y + 200, { steps: 8 })
  await page.mouse.up()
  await pause(150)
}
try {
  await page.waitForFunction(() => window.electronAPI?.config)
  await page.evaluate(async theme => {
    await window.electronAPI.config.setSetupCompleted(true)
    await window.electronAPI.config.setAiProfiles([{ id: 'fixture', name: 'fixture', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'fixture' }])
    await window.electronAPI.config.setActiveAiProfile('fixture')
    if (theme) { await window.electronAPI.config.setUiThemeMode('manual'); await window.electronAPI.config.setUiTheme(theme) }
  }, process.env.E2E_THEME)
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
  await page.evaluate(() => {
    const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal')
    const id = store.createAssistantTab({ title: '500人详情调宽验证' })
    store.markAssistantSkipOnboarding(id); store.focusHubConversation(id)
    store.addAgentStep(id, { id: 'request', type: 'user_task', content: '核对500份资料', timestamp: Date.now() })
    store.addAgentStep(id, { id: 'resize', type: 'tool_call', toolName: 'dispatch_agents', content: '派出500位', sourceSessionId: 'resize-session', timestamp: Date.now(), success: true,
      subAgents: Array.from({ length: 500 }, (_, i) => ({ teamId: 'resize-team', id: `成员${i}`, name: `成员${i}`, description: `核对第${i}份资料`, status: 'running', steps: [{ tool: 'read_file', args: '核对资料', status: 'running' }] })) })
    window.__resize = { store, id }
  })
  await pause(1500)
  for (let i = 0; i < 4; i++) {
    const dialog = page.locator('.confirm-overlay button:visible').last()
    if (await dialog.count()) await dialog.click({ force: true, timeout: 1000 }).catch(() => {})
    await pause(200)
  }
  await page.locator('.dock-team').click()
  await page.locator('.organization-chart .org-node').nth(499).waitFor({ state: 'attached' })
  await pause(300)
  const original = await positions()
  const cols = await page.locator('.org-node').evaluateAll(nodes => nodes.filter(el => el.style.top === nodes[0].style.top).length)
  const row = Math.floor(500 / cols * 0.65)
  const target = `成员${Math.min(cols * row + cols - 1, 499)}`
  const card = page.locator(`.organization-chart [data-member="${target}"]`)
  await card.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
  await card.locator('.org-node-name-text').waitFor()
  const before = await geometry()
  await card.click()
  await page.locator('.od-header .tph-title').getByText(target, { exact: true }).waitFor()
  await page.locator('.org-member-detail').getByText(`${target}已完成核对`, { exact: false }).waitFor()
  await pause(250)
  let current = await geometry()
  check('点开中后段最右列成员，500人坐标与顺序不变', await positions() === original, `初始${cols}列，选择${target}`)
  check('打开详情保持垂直阅读位置，选中成员可见', Math.abs(current.top - before.top) < 1 && current.selectedVisible, JSON.stringify({ before, current }))
  const initialWidth = await detailWidth()
  await dragTo(-110)
  const wide = await detailWidth()
  check('拖动分隔条可扩大右侧详情', wide > initialWidth + 90, JSON.stringify({ initialWidth, wide }))
  await dragTo(150)
  const narrow = await detailWidth()
  check('反向拖动可收窄详情', narrow < wide - 130, JSON.stringify({ narrow }))
  current = await geometry()
  check('两次调宽不改坐标、垂直位置和缩放，选中成员仍可见', await positions() === original && Math.abs(current.top - before.top) < 1 && current.selectedVisible && await page.locator('.org-map-tools button').nth(1).innerText() === '100%')

  const next = `成员${Math.min(cols * (row + 1) + cols - 1, 499)}`
  const nextCard = page.locator(`.organization-chart [data-member="${next}"]`)
  await nextCard.click()
  await page.locator('.od-header .tph-title').getByText(next, { exact: true }).waitFor()
  check('切换成员保留调好的宽度', Math.abs(await detailWidth() - narrow) < 1)
  await page.locator('.od-header .tph-close').click()
  await pause(200)
  check('关详情回总览，成员坐标和垂直位置不变', await positions() === original && Math.abs((await geometry()).top - before.top) < 1)
  await nextCard.click()
  await page.locator('.oc-detail').waitFor()
  check('重开详情保留本次调宽', Math.abs(await detailWidth() - narrow) < 1)
  await dragTo(-3000)
  check('拖到上界时左侧仍保留至少300px', (await geometry()).width >= 299 && (await geometry()).selectedVisible)
  await dragTo(3000)
  check('拖到下界时右侧仍保留280px', Math.abs(await detailWidth() - 280) < 1)
  check('拖动边界仍不重排，屏外成员继续回收内容', await positions() === original && await page.locator('.org-avatar').count() < 200 && await page.locator('.org-avatar').count() > 0)

  await page.evaluate(() => {
    const { store, id } = window.__resize
    const step = store.tabs.find(t => t.id === id).agentState.steps.find(s => s.id === 'resize')
    step.subAgents = step.subAgents.map((m, i) => ({ ...m, status: i % 2 ? 'completed' : 'running' }))
  })
  await page.waitForFunction(() => document.querySelector('.oc-summary').textContent.includes('250'))
  check('状态更新不重排且不跳动', await positions() === original && Math.abs((await geometry()).top - before.top) < 1)
  await dragTo(-100)
  for (const cancel of ['Escape', 'blur', 'pointercancel']) {
    const box = await beginDrag()
    await page.mouse.move(box.x - 20, box.y + 200)
    if (cancel === 'Escape') await page.keyboard.press('Escape')
    else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    else await page.locator('.oc-workspace > .workbench-divider').evaluate(el => el.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })))
    await page.waitForFunction(() => !document.querySelector('.oc-workspace').classList.contains('is-resizing'))
    check(`${cancel}结束拖动不关闭详情，并恢复光标和文本选择`, await page.locator('.oc-detail').count() === 1 && await page.evaluate(() => !document.body.style.cursor && !document.body.style.userSelect))
    await page.mouse.up()
  }
  const sizeBeforeWindow = await detailWidth()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 760))
  await pause(250)
  check('窗口缩小时详情宽度受边界约束', await detailWidth() >= 279 && (await geometry()).width >= 299)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await pause(250)
  check('窗口恢复空间后仍沿用请求的像素宽度', Math.abs(await detailWidth() - sizeBeforeWindow) < 1)
  if (process.env.E2E_SHOT) { fs.mkdirSync(process.env.E2E_SHOT, { recursive: true }); await page.screenshot({ path: path.join(process.env.E2E_SHOT, 'team-detail-resize.png') }) }
  await beginDrag()
  await page.evaluate(() => { const { store, id } = window.__resize; store.closeTab(id, true) })
  await page.locator('.organization-chart').waitFor({ state: 'detached' })
  check('界面卸载也释放拖动光标和文本选择', await page.evaluate(() => !document.body.style.cursor && !document.body.style.userSelect))
  await page.mouse.up()
  console.log('RESULT PASS')
} finally {
  const timeout = setTimeout(() => app.process()?.kill('SIGKILL'), 5000)
  try { await app.close().catch(() => {}) } finally { clearTimeout(timeout); fs.rmSync(directory, { recursive: true, force: true }) }
}
