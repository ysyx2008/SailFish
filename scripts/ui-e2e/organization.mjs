/**
 * 项目组织的界面——桌面应用里的真窗口端到端。
 * 临时数据目录，窗口不抢前台。往一个助手页里直接灌「派出组长」那一步（带整个组织的全貌），看卡片、顶部一行、组织图、团的群聊。
 *
 *   npx vite build && node scripts/ui-e2e/organization.mjs
 *   E2E_SHOT=/tmp/shots node scripts/ui-e2e/organization.mjs   # 顺便存几张截图
 *   E2E_THEME=light …                                          # 换主题截图（dark/light/blue）
 *   E2E_KEEP=1 …                                               # 保留临时目录
 *
 * 1. 对话里那一步下面有组织小卡片：几个人、几个团、几个在干
 * 2. 顶部挂着的一行按全组织计数，有「看组织图」的入口
 * 3. 组织图：秘书在最上面，组长名下按团分组，组长名下的组长再往下长一层；团是纵向列、散人和团平级；团头上有验收状态
 * 4. 点团的「群聊」打开那个团的完整群聊（从群聊文件读），成员栏是这个团的人，组长一栏写着是哪位组长，秘书的话显示为「秘书」
 * 4b. 两个组长名下各有一个同名团：点开哪个看哪个的成员
 * 5. 返回后回到组织图，再返回回到对话
 * 6. 组织里的人都干完了：顶部写「都干完了」
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-organization-ui-'))
const shotDir = process.env.E2E_SHOT
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
const uiTheme = process.env.E2E_THEME

// 项目团的群聊全文：组长说一句、前端点名秘书、秘书回应
const chatRel = '2026-10-26/sess-org/team-项目团.jsonl'
const now = Date.now()
const chatLines = [
  { seq: 1, from: '组长', to: ['前端', '后端'], text: '先把登录页拆成两块：界面和接口，各做各的。', at: now - 60_000 },
  { seq: 2, from: '前端', to: ['秘书'], text: '需求里没写第三方登录要不要做，请秘书定一下。', at: now - 40_000 },
  { seq: 3, from: '秘书', to: ['前端'], text: '这一版只做账号密码登录，第三方登录不做。', at: now - 30_000 },
  { seq: 4, from: '后端', to: ['前端'], text: '接口好了，请验收。', at: now - 10_000 },
]
const chatAbs = path.join(dataDir, 'history', 'expert-teams', chatRel)
fs.mkdirSync(path.dirname(chatAbs), { recursive: true })
fs.writeFileSync(chatAbs, chatLines.map((m) => JSON.stringify(m)).join('\n') + '\n')

const app = await launchApp(dataDir)
const page = await app.firstWindow()
const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) }) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ready() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      await page.evaluate(async ([theme]) => {
        if (!window.electronAPI?.config) throw new Error('接口还没出现')
        await window.electronAPI.config.setSetupCompleted(true)
        await window.electronAPI.config.setAiProfiles([{ id: 'e2e', name: 'e2e', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'e2e' }])
        await window.electronAPI.config.setActiveAiProfile?.('e2e')
        if (theme) {
          await window.electronAPI.config.setUiThemeMode?.('manual')
          await window.electronAPI.config.setUiTheme?.(theme)
        }
      }, [uiTheme])
      await page.reload()
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error('应用没起来')
}

async function openAssistant() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      return await page.evaluate(() => {
        const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia
        const store = pinia?._s.get('terminal')
        if (!store) throw new Error('store 还没出现')
        const id = store.createAssistantTab({ title: '测试对话' })
        store.focusHubConversation(id)
        window.__e2eStore = store
        window.__e2eTab = id
        return id
      })
    } catch {
      await sleep(500)
    }
  }
  throw new Error('开不出助手页')
}

const member = (name, status, extra = {}) => ({ id: name, name, description: `${name}负责的事`, status, ...extra })

const organization = (done) => {
  const s = (running) => (done ? 'completed' : running)
  const members = [
    member('研发组', s('running'), { lead: true, role: '研发组长' }),
    member('运营组', s('running'), { lead: true, role: '运营组长' }),
    member('前端', s('running'), { parent: '研发组', team: '项目团', role: '前端专家' }),
    member('后端', 'completed', { parent: '研发组', team: '项目团', role: '后端专家', reviewer: true }),
    member('文档', s('running'), { parent: '研发组' }),
    member('投放组', s('running'), { parent: '运营组', lead: true, role: '投放组长' }),
    member('小投', s('running'), { parent: '投放组' }),
    member('小营', s('running'), { parent: '运营组', team: '项目团', role: '运营专家' }),
  ]
  return {
    members,
    teams: [
      { name: '项目团', owner: '研发组', review: done ? 'pass' : 'pending', reviewers: ['后端'], messageCount: chatLines.length, waitingLeader: false, wakeLimit: 30, chatFile: chatRel },
      { name: '项目团', owner: '运营组', review: 'none', messageCount: 0, waitingLeader: false, wakeLimit: 30 },
    ],
    live: members.filter((m) => m.status !== 'completed').length,
    total: members.length,
    boardPath: '/tmp/org/board.md',
  }
}

const dispatchStep = (done) => ({
  id: 'org-1',
  type: 'tool_call',
  content: '派出 2 位组长',
  toolName: 'dispatch_agents',
  timestamp: Date.now(),
  success: true,
  subAgents: [
    { id: '研发组', name: '研发组', role: '研发组长', description: '带研发组做事', status: done ? 'completed' : 'running', steps: [] },
    { id: '运营组', name: '运营组', role: '运营组长', description: '带运营组做事', status: done ? 'completed' : 'running', steps: [] },
  ],
  organization: organization(done),
})

const pushStep = (step) => page.evaluate(([s]) => window.__e2eStore.addAgentStep(window.__e2eTab, s), [step])
const updateStep = (step) => page.evaluate(([s]) => {
  const tab = window.__e2eStore.tabs.find((t) => t.id === window.__e2eTab)
  const target = tab.agentState.steps.find((x) => x.id === s.id)
  Object.assign(target, s)
}, [step])
/** 机器上另有一份旗鱼占着浏览器助手时会弹提示，挡住点击；与本测试无关，关掉 */
const dismissDialogs = async () => {
  for (let i = 0; i < 5; i++) {
    const ok = page.locator('.confirm-overlay button:visible').last()
    if (await ok.count() === 0) return
    await ok.click({ force: true }).catch(() => undefined)
    await sleep(300)
  }
}
const text = (selector) => page.locator(selector).first().innerText().catch(() => '')

try {
  await ready()
  const tabId = await openAssistant()
  console.log(`\n助手页 ${tabId}`)
  await page.locator('.ai-messages-wrapper:visible').first().waitFor({ state: 'attached', timeout: 30_000 })
  await sleep(500)

  await pushStep({ id: 'u1', type: 'user_task', content: '帮我把上线前的事分给研发和运营', timestamp: Date.now() })
  await pushStep({ id: 'm0', type: 'message', content: '我来搭一个小组织，分头做。', timestamp: Date.now() })
  await pushStep(dispatchStep(false))
  await sleep(800)
  await dismissDialogs()

  console.log('\n[1] 对话里的组织小卡片')
  const card = page.locator('.ai-messages:visible .organization-card')
  check('对话里有组织小卡片', await card.count() === 1, await card.count())
  const cardText = await card.first().innerText().catch(() => '')
  check('写着 8 人、2 个团、7 在干、1 干完', /8 人/.test(cardText) && /2 个团/.test(cardText) && /7 在干/.test(cardText) && /1 干完/.test(cardText), cardText)
  await shot('1-card')

  console.log('\n[2] 顶部一行按全组织计数')
  const dockText = await text('.sub-agent-dock')
  check('顶部写着组织：7 人在干，共 8 人', /组织/.test(dockText) && /7 人在干/.test(dockText) && /共 8 人/.test(dockText), dockText)
  check('顶部有「看组织图」入口', await page.locator('.sub-agent-dock .dock-team', { hasText: '看组织图' }).count() === 1)

  console.log('\n[3] 组织图')
  await sleep(1500)
  await dismissDialogs()
  await page.locator('.sub-agent-dock .dock-team', { hasText: '看组织图' }).click()
  await page.locator('.organization-chart').waitFor({ state: 'visible', timeout: 10_000 })
  const chart = await text('.organization-chart')
  check('秘书在最上面', chart.includes('秘书'), chart)
  check('两位组长都在', chart.includes('研发组') && chart.includes('运营组'), chart)
  check('组长名下的人都在，组长的组长也在', ['前端', '后端', '文档', '投放组', '小投', '小营'].every((n) => chart.includes(n)), chart)
  check('团头：团名和验收状态', chart.includes('团「项目团」') && chart.includes('待验收'), chart)
  check('验收人有标记', await page.locator('.organization-chart .org-reviewer').count() === 1)
  check('标题写着共 8 人、7 人没做完、2 个团', /共 8 人/.test(chart) && /7 人没做完/.test(chart) && /2 个团/.test(chart), chart)
  const nested = await page.locator('.organization-chart .org-children[data-depth="2"]').count()
  check('组长名下的组长再往下长一层', nested >= 1, nested)
  const teamMembers = await page.locator('.organization-chart .org-team').first().locator('.org-team-members > .org-member').count()
  check('团里的人纵向排在团卡片里', teamMembers === 2, teamMembers)
  const teamCells = await page.locator('.organization-chart .org-cell.is-team').count()
  const looseDoc = await page.locator('.organization-chart .org-cell:not(.is-team) > .org-branch > .org-node', { hasText: '文档' }).count()
  check('散人和团是平级分支', teamCells === 2 && looseDoc === 1, `team=${teamCells} looseDoc=${looseDoc}`)
  // 版式的几何断言：同一行、总线中点落在行中心、父节点压在总线中点
  const layout = await page.evaluate(() => {
    const row = document.querySelector('.organization-chart .org-children[data-depth="1"]')
    if (!row) return null
    const cells = Array.from(row.children)
    const rowBox = row.getBoundingClientRect()
    const first = cells[0].firstElementChild.getBoundingClientRect()
    const last = cells[cells.length - 1].firstElementChild.getBoundingClientRect()
    const busCenter = (first.left + first.width / 2 + last.left + last.width / 2) / 2
    const parentEl = row.parentElement?.querySelector(':scope > .org-node')
    if (!parentEl) return null
    const parent = parentEl.getBoundingClientRect()
    return {
      sameRow: cells.some((cell) => cell.classList.contains('is-team')) && cells.some((cell) => cell.textContent?.includes('文档')),
      busCentered: Math.abs(busCenter - (rowBox.left + rowBox.width / 2)) <= 1,
      parentCentered: Math.abs((parent.left + parent.width / 2) - busCenter) <= 1,
    }
  })
  check('散人和团在同一行', layout?.sameRow === true, JSON.stringify(layout))
  check('两端不等宽时总线仍落在行中心', layout?.busCentered === true, JSON.stringify(layout))
  check('父节点压在两端中心连线的中点', layout?.parentCentered === true, JSON.stringify(layout))
  // 组织图和团聊一样坐右侧面板；等抽屉动画走完再截图
  await sleep(450)
  const seated = await page.evaluate(() => {
    const region = document.querySelector('.assistant-shell .workbench-region')
    const chart = document.querySelector('.organization-chart')
    return {
      inRegion: !!(region && chart && region.contains(chart)),
      width: region?.getBoundingClientRect().width ?? 0,
    }
  })
  check('组织图在右侧面板里，不是盖在对话上', seated.inRegion === true, JSON.stringify(seated))
  await shot('3-chart')

  console.log('\n[4] 团的完整群聊')
  await page.locator('.organization-chart .org-team-chat').first().click()
  await page.locator('.expert-team-chat').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.expert-team-chat .etc-message').first().waitFor({ state: 'visible', timeout: 10_000 })
  const chatText = await text('.expert-team-chat')
  check('标题是专家团「项目团」', chatText.includes('专家团「项目团」'), chatText)
  check('群聊全文是从文件里读来的 4 条', await page.locator('.expert-team-chat .etc-message').count() === 4, await page.locator('.expert-team-chat .etc-message').count())
  check('成员栏是这个团的两位，组长一栏写着是研发组的', chatText.includes('前端') && chatText.includes('后端') && chatText.includes('组长·研发组'), chatText)
  check('秘书的话显示为「秘书」', chatText.includes('这一版只做账号密码登录') && /秘书/.test(chatText), chatText)
  check('不会混进别的团的人', !chatText.includes('小投') && !chatText.includes('文档'))
  await shot('4-team-chat')

  console.log('\n[4b] 两个组长名下各有一个同名团')
  await page.locator('.expert-team-chat .etc-icon-btn').first().click()
  await sleep(300)
  check('团框画出了两个', await page.locator('.organization-chart .org-team').count() === 2)
  const opsTeam = page.locator('.organization-chart .org-team').filter({ hasText: '组长·运营组' })
  check('团框里写着各自的组长', await opsTeam.count() === 1)
  await opsTeam.click()
  await page.locator('.expert-team-chat').waitFor({ state: 'visible', timeout: 10_000 })
  const opsMembers = await page.locator('.expert-team-chat .etc-member').evaluateAll((items) => items.map((el) => el.getAttribute('aria-label') ?? ''))
  check('点开的是运营组的项目团，成员不串',
    opsMembers.some((label) => label.includes('小营')) && !opsMembers.some((label) => label.includes('前端')),
    JSON.stringify(opsMembers))
  await shot('4b-same-name-team')

  console.log('\n[5] 返回')
  await page.locator('.expert-team-chat .etc-icon-btn').first().click()
  await sleep(300)
  check('回到组织图', await page.locator('.expert-team-chat').count() === 0 && await page.locator('.organization-chart').isVisible())
  await page.locator('.organization-chart .oc-icon-btn').first().click()
  await sleep(300)
  check('再返回回到对话', await page.locator('.organization-chart').count() === 0)

  console.log('\n[6] 都干完了')
  await updateStep(dispatchStep(true))
  await sleep(600)
  const doneDock = await text('.sub-agent-dock')
  check('顶部写着组织 8 人都干完了', /组织 8 人都干完了/.test(doneDock), doneDock)
  const doneCard = await page.locator('.ai-messages:visible .organization-card').first().innerText().catch(() => '')
  check('卡片写着都干完了', /都干完了/.test(doneCard), doneCard)
  await shot('6-done')

  console.log('\n[7] 同一份组织挂在两个派出步骤上')
  // 第二批的快照故意停在「还有 1 人在干」：顶部要认最早那份新鲜快照，不能跟着旧快照转圈
  const staleOrg = organization(true)
  staleOrg.live = 1
  staleOrg.members = staleOrg.members.map((m, i) => (i === 0 ? { ...m, status: 'running' } : m))
  await pushStep({
    ...dispatchStep(true),
    id: 'org-2',
    content: '又派出第二批',
    subAgents: [{ id: '第二批收尾', name: '第二批收尾', description: '收尾', status: 'completed', steps: [] }],
    organization: staleOrg,
  })
  await sleep(800)
  check('同一份组织只挂一张卡片', await page.locator('.ai-messages:visible .organization-card').count() === 1)
  check('顶部也只有一个组织入口', await page.locator('.sub-agent-dock .dock-team', { hasText: '看组织图' }).count() === 1)
  const dedupeDock = await text('.sub-agent-dock')
  check('顶部按最早那份快照显示，不再转圈', /组织 8 人都干完了/.test(dedupeDock) && !/人在干/.test(dedupeDock), dedupeDock)
  await shot('7-dedupe')
} catch (error) {
  failures.push(`脚本出错：${error?.stack || error}`)
  console.error(`  FAIL 脚本出错：${error?.stack || error}`)
  await shot('error')
} finally {
  await app.close().catch(() => undefined)
  if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length ? `\nRESULT FAIL (${failures.length})\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nRESULT PASS')
process.exit(failures.length ? 1 : 0)
