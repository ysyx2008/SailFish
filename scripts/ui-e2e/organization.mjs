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
 * 2. 顶部挂着的一行按全组织计数，有「查看团队」的入口
 * 3. 组织图：直属成员自动换行，组长名下按真实归属分区，组长名下的组长再往下长一层；团头上有验收状态
 * 4. 点团的「群聊」打开那个团的完整群聊（从群聊文件读），成员栏是这个团的人，组长一栏写着是哪位组长，秘书的话显示为「秘书」
 * 4b. 两个组长名下各有一个同名团：点开哪个看哪个的成员
 * 5. 返回后回到组织图，再返回回到对话
 * 6. 组织里的人都干完了：顶部写「都干完了」
 * 6b. 都做完后的组织图：顶部概览、每个人和每个团都变成做完的样子
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'
import { checkTeamHeader } from './team-header-checks.mjs'

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

// 团队成果来自隔离的真实成员落盘记录，经主进程 IPC 读取，不 mock 查询接口。
const artifactSession = 'sess-org-artifacts'
const artifactPath = path.join(dataDir, '研发交付.md')
fs.writeFileSync(artifactPath, '# 研发交付\n\n团队成果正文：账号密码登录已经完成。\n')
function saveArtifactMember(name, owner, file, result) {
  const dir = path.join(dataDir, 'history', 'sub-agents', '2026-10-29', artifactSession, `${name}-${createHash('sha1').update(name).digest('hex').slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ name, parent: owner, team: '项目团', description: 'fixture', prompt: 'fixture', status: 'completed', result, updatedAt: now }))
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id: name, timestamp: now, status: 'completed', duration: 1 }))
  fs.writeFileSync(path.join(dir, 'steps.jsonl'), JSON.stringify({ id: `artifact-${name}`, type: 'tool_result', timestamp: now, canvasData: { action: 'open', renderer: 'markdown', title: `${owner}交付`, filePath: file, contentFromFile: true } }) + '\n')
}
saveArtifactMember('前端', '研发组', artifactPath, '成员交回的核对结果。')
const opsPath = path.join(dataDir, '运营交付.md')
fs.writeFileSync(opsPath, '# 运营交付\n运营团队的独立文件。\n')
saveArtifactMember('小营', '运营组', opsPath)

const app = await launchApp(dataDir)
const page = await app.firstWindow()
const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) }) }
// 布局随视口自适应，截图不改变视口，避免重排干扰后续几何检查。
async function shotChart(name) {
  if (!shotDir) return
  await page.locator('.organization-chart').screenshot({ path: path.join(shotDir, `${name}.png`), animations: 'disabled' })
}
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
        store.markAssistantSkipOnboarding(id)
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
  check('写着 8 人、2 个团、7 在干、1 干完', /8 人/.test(cardText) && /2 个小组/.test(cardText) && /7 在干/.test(cardText) && /1 干完/.test(cardText), cardText)
  await shot('1-card')

  console.log('\n[2] 顶部一行按全组织计数')
  const dockText = await text('.sub-agent-dock')
  check('顶部写着组织：7 人在干，共 8 人', /团队/.test(dockText) && /7 人在干/.test(dockText) && /共 8 人/.test(dockText), dockText)
  check('顶部有「查看团队」入口', await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).count() === 1)

  await sleep(1500)
  await dismissDialogs()
  await page.locator('.dock-toggle').click()
  await page.locator('.dock-panel .tmt-member').nth(7).waitFor()
  check('快速名单默认完整展示八位成员', await page.locator('.dock-panel .tmt-member').count() === 8)
  check('树状名单保留三层负责人关系', await page.locator('.dock-panel .tmt-node > .team-member-tree .tmt-node > .team-member-tree .tmt-member').count() > 0)
  const leadTree = page.locator('.dock-panel .tmt-node').filter({ has: page.locator(':scope > .tmt-member .sub-agent-desc', { hasText: '研发组' }) }).first()
  check('成员置于所属负责人下面', (await leadTree.innerText()).includes('前端') && !(await leadTree.innerText()).includes('小营'))
  if (process.env.E2E_SHOT) await shot('2-tree-list')
  await page.keyboard.press('Escape')

  console.log('\n[3] 组织图')
  await sleep(1500)
  await dismissDialogs()
  const conversationInput = page.locator('.assistant-chat [contenteditable="true"]').first()
  await conversationInput.fill('进入团队前未发送的草稿')
  await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).click()
  await page.locator('.organization-chart').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.assistant-focus-doc .organization-chart.is-focus').waitFor({ state: 'visible' })
  check('查看团队默认直接铺满工作区', true)
  await page.locator('.org-node[data-member="研发组"]').click()
  await page.locator('.oc-detail .od-header').waitFor()
  const masterDetail = await page.evaluate(() => {
    const overview = document.querySelector('.oc-overview').getBoundingClientRect()
    const detail = document.querySelector('.oc-detail').getBoundingClientRect()
    window.__overviewBody = document.querySelector('.oc-body')
    return overview.width > 280 && detail.width > 280 && overview.right <= detail.left + 1
  })
  check('点成员后左侧保留团队图、右侧打开详情且不重叠', masterDetail)
  await page.locator('.org-node[data-member="运营组"]').click()
  check('连续点选直接切换右侧成员', (await text('.od-header')).includes('运营组'))
  check('成员详情固定右侧，没有单独铺满按钮', await page.locator('.od-header .tph-focus').count() === 0 && await page.locator('.oc-detail.is-focus').count() === 0)
  const detailPadding = await page.locator('.oc-detail').evaluate(el => ({ outer: parseFloat(getComputedStyle(el).paddingBottom), inner: parseFloat(getComputedStyle(el.querySelector('.od-content')).paddingBottom), overlay: parseFloat(getComputedStyle(el).getPropertyValue('--assistant-focus-overlay')) }))
  check('团队详情不预留浮动输入空间', detailPadding.outer === 0 && detailPadding.inner === 0 && detailPadding.overlay === 0, JSON.stringify(detailPadding))
  await page.locator('.od-header .tph-close').click()
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-member') === '运营组')
  check('关闭详情后键盘焦点回到原成员卡片', true)
  check('关闭详情后同一团队图仍在', await page.locator('.oc-body').evaluate(el => el === window.__overviewBody) && await page.locator('.oc-detail').count() === 0)
  const chart = await text('.organization-chart')
  const compactCards = await page.locator('.org-node').evaluateAll(nodes => nodes.map(node => ({ height: node.offsetHeight, width: node.offsetWidth, aligned: Math.abs(node.querySelector('.org-node-name').getBoundingClientRect().top - node.querySelector('.org-status-badge').getBoundingClientRect().top) < 5 })))
  check('成员和负责人卡片同为紧凑76px高度，姓名状态同行', compactCards.every(card => card.height === 76 && card.width <= 280 && card.aligned), JSON.stringify(compactCards))
  check('角色不再单占卡片一行，悬停仍保留完整信息', await page.locator('.org-node-sub').count() === 0 && (await page.locator('[data-member="前端"]').getAttribute('title')).includes('前端专家'))
  check('图从真实成员分区开始，没有额外根节点', await page.locator('.oc-tree > *').count() === 1 && await page.locator('.oc-tree > .org-children').count() === 1 && await page.locator('.oc-tree .org-node').count() === 8)
  check('两位组长都在', chart.includes('研发组') && chart.includes('运营组'), chart)
  check('组长名下的人都在，组长的组长也在', ['前端', '后端', '文档', '投放组', '小投', '小营'].every((n) => chart.includes(n)), chart)
  check('团头：团名和验收状态', chart.includes('小组「项目团」') && chart.includes('待验收'), chart)
  check('验收人有标记', await page.locator('.organization-chart .org-reviewer').count() === 1)
  check('标题写着共 8 人 · 2 个团', /共 8 人/.test(chart) && /2 个小组/.test(chart), chart)
  check('顶部概览写着 7 人在干、1 人做完', /7 人在干/.test(chart) && /1 人做完/.test(chart), chart)
  check('在干的人都有醒目的状态标签', await page.locator('.organization-chart .org-node.is-running').count() === 7)
  check('做完的人也有醒目的状态标签', await page.locator('.organization-chart .org-node.is-completed').count() === 1)
  check('两个团框都标记了执行状态', await page.locator('.organization-chart .org-team.is-running').count() === 2)
  check('团框里写着还有人在干', chart.includes('1 人在干'), chart)
  check('团框有做完与在干两段进度', await page.locator('.organization-chart .org-meter-part.is-completed').count() === 1
    && await page.locator('.organization-chart .org-meter-part.is-running').count() === 2)
  const nested = await page.locator('.organization-chart .org-children[data-depth="2"]').count()
  check('组长名下的组长再往下长一层', nested >= 1, nested)
  const teamMembers = await page.locator('.organization-chart .org-team').first().locator('.org-team-members > .org-member').count()
  check('本团成员完整保留在自己的团分区里', teamMembers === 2, teamMembers)
  const teamCells = await page.locator('.organization-chart .org-cell.is-team').count()
  const looseDoc = await page.locator('.organization-chart .org-cell:not(.is-team) > .org-branch > .org-node', { hasText: '文档' }).count()
  check('散人和团是平级分支', teamCells === 2 && looseDoc === 1, `team=${teamCells} looseDoc=${looseDoc}`)
  // 窄面板不再横向拉长；归属由负责人分区表达。
  const layout = await page.evaluate(() => {
    const row = document.querySelector('.organization-chart .org-children[data-depth="1"]')
    if (!row) return null
    const parentEl = row.parentElement?.querySelector(':scope > .org-node')
    if (!parentEl) return null
    const branch = row.parentElement.getBoundingClientRect()
    const child = row.getBoundingClientRect()
    const body = document.querySelector('.oc-body')
    return {
      contained: child.left >= branch.left && child.right <= branch.right + 1,
      parentAbove: parentEl.getBoundingClientRect().bottom < child.top,
      fits: body.scrollWidth <= body.clientWidth + 1,
    }
  })
  check('下级位于所属负责人的分区内', layout?.contained === true && layout?.parentAbove === true, JSON.stringify(layout))
  check('分层组织适配侧栏宽度', layout?.fits === true, JSON.stringify(layout))
  // 组织图和团聊一样坐右侧面板；等抽屉动画走完再截图
  await sleep(450)
  const seated = await page.evaluate(() => {
    const region = document.querySelector('.assistant-focus-doc')
    const chart = document.querySelector('.organization-chart')
    return {
      inRegion: !!(region && chart && region.contains(chart)),
      width: region?.getBoundingClientRect().width ?? 0,
    }
  })
  check('组织图固定在铺满的工作区内', seated.inRegion === true, JSON.stringify(seated))
  await shot('3-chart')
  await shotChart('3-chart-full')

  console.log('\n[3b] 固定铺满与标题栏')
  await checkTeamHeader(page, '.oc-header', '团队图铺满', check)
  check('组织图不再提供切回分栏按钮', await page.locator('.oc-header .tph-focus').count() === 0)
  check('组织图使用现有铺满工作区', await page.locator('.assistant-focus-doc .organization-chart.is-focus').isVisible())
  check('团队观察界面不显示对话或浮动输入', await page.locator('.assistant-chat:visible').count() === 0 && await page.locator('.assistant-focus-chat .assistant-chat').count() === 0)
  check('总览底部只保留正常内容边距', await page.locator('.oc-body').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)) === 22)
  const insets = await page.locator('.organization-chart').evaluate(el => {
    el.style.setProperty('--shell-inset-left', '140px')
    el.style.setProperty('--shell-inset-right', '180px')
    const headerElement = el.querySelector('.oc-header')
    const originalStyle = headerElement.getAttribute('style')
    headerElement.style.transition = 'none'
    const header = getComputedStyle(headerElement)
    const result = { left: parseFloat(header.paddingLeft), right: parseFloat(header.paddingRight) }
    if (originalStyle === null) headerElement.removeAttribute('style')
    else headerElement.setAttribute('style', originalStyle)
    el.style.removeProperty('--shell-inset-left')
    el.style.removeProperty('--shell-inset-right')
    return result
  })
  check('标题栏为窗口控件预留左右安全距离', insets.left >= 140 && insets.right >= 210, JSON.stringify(insets))
  await shot('3b-focus')
  await page.locator('.organization-chart .org-team-chat').first().click()
  await page.locator('.assistant-focus-doc .expert-team-chat').waitFor({ state: 'visible' })
  await checkTeamHeader(page, '.od-header', '右侧群聊', check)
  check('右侧群聊没有单独铺满入口', await page.locator('.od-header .tph-focus').count() === 0)
  check('右侧群聊不额外预留底部空间', await page.locator('.od-content').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)) === 0)
  check('群聊在右侧打开时团队图仍然可见', await page.locator('.oc-overview .oc-body').isVisible())
  await page.locator('.od-header .tph-close').first().click()
  await page.locator('.assistant-focus-doc .organization-chart.is-focus').waitFor({ state: 'visible' })
  check('群聊返回仍在铺满组织图', await page.locator('.assistant-focus-doc .organization-chart.is-focus').isVisible())
  await page.locator('.oc-header .tph-close').click()
  check('退出团队恢复原对话及未发送草稿', await conversationInput.isVisible() && await conversationInput.innerText() === '进入团队前未发送的草稿')
  await conversationInput.fill('')
  await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).click()
  await page.locator('.organization-chart.is-focus').waitFor({ state: 'visible' })
  check('关闭再打开仍固定铺满且无还原入口', await page.locator('.oc-header .tph-focus').count() === 0)

  console.log('\n[3b] 对象成果页签与内嵌文件预览')
  await page.evaluate(session => {
    window.__e2eStore.setAgentSession(window.__e2eTab, 'sess-current-other', Date.now())
    window.__e2eStore.tabs.find(tab => tab.id === window.__e2eTab).agentState.steps.find(step => step.id === 'org-1').organization.sessionId = session
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    window.__e2eArtifactStore = pinia._s.get('assistantArtifact')
    window.__e2eArtifactStore.open(window.__e2eTab, { renderer: 'markdown', artifactId: 'unrelated-artifact', title: '其他任务稿', content: '用户原有草稿', activate: true })
  }, artifactSession)
  check('团队界面不显示会话产出物清单', await page.locator('.artifact-list-slot:visible').count() === 0)
  const devTeam = page.locator('.organization-chart .org-team').filter({ has: page.locator('.org-team-owner', { hasText: '研发组' }) })
  await devTeam.locator('.org-team-artifacts').click()
  await page.locator('.oa-item').first().waitFor({ state: 'visible' })
  const objectTitle = await text('.od-header')
  check('成果页签选中且对象标题只显示一次', await page.getByRole('tab', { name: '成果', exact: true }).getAttribute('aria-selected') === 'true' && await page.locator('.oc-detail .team-panel-header').count() === 1)
  check('研发团列出真实来源文件与工作结果，不混同名运营团', await page.locator('.oa-item').count() === 2 && (await text('.oa-list')).includes('来自 前端') && !(await text('.oa-list')).includes('运营交付'))
  await page.locator('.oa-item').filter({ hasText: '研发组交付' }).click()
  await page.waitForFunction(() => document.querySelector('.org-artifacts .canvas-panel')?.innerText.includes('团队成果正文'))
  check('内嵌预览没有会话文件页签和重复铺满按钮', await page.locator('.org-artifacts .artifact-tab').count() === 0 && await page.locator('.canvas-panel button[aria-pressed]').count() === 0)
  check('文件有返回成果列表，关闭按钮仍属于当前小组', await page.locator('.oa-preview-back').isVisible() && await text('.od-header') === objectTitle && await page.locator('.oc-detail .tph-close').count() === 1)
  const editor = page.locator('.org-artifacts .canvas-panel [contenteditable="true"]').first()
  await editor.fill('团队文件的用户未保存修改')
  await page.locator('.md-dirty-hint').waitFor()
  check('文件预览仍在固定右侧详情且左图保留', await page.locator('.oc-detail .canvas-panel').isVisible() && await page.locator('.oc-overview .oc-body').isVisible() && await page.locator('.od-header .tph-focus').count() === 0 && await text('.od-header') === objectTitle)
  await page.getByRole('tab', { name: '群聊', exact: true }).click()
  check('切回群聊仍是同一小组，文件预览没有卸载', await text('.od-header') === objectTitle && await page.locator('.org-artifacts .canvas-panel').count() === 1 && !await page.locator('.org-artifacts .canvas-panel').isVisible())
  await page.getByRole('tab', { name: '成果', exact: true }).click()
  check('再看成果保留原文件与未保存内容', (await text('.org-artifacts .canvas-panel')).includes('用户未保存修改'))
  await shot('object-file-preview')
  await editor.focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w')
  await page.locator('.oa-list').waitFor({ state: 'visible' })
  check('关闭文件快捷键只回成果列表，不关闭对象或团队', await text('.od-header') === objectTitle && await page.locator('.organization-chart').isVisible())
  check('预览关闭不会遗留团队临时文件页签', await page.evaluate(() => window.__e2eArtifactStore.getOpenArtifacts(window.__e2eTab).every(file => file.title !== '研发组交付')))
  await page.locator('.oa-item').filter({ hasText: '研发组交付' }).click()
  await page.waitForFunction(() => document.querySelector('.canvas-panel')?.innerText.includes('用户未保存修改'))
  await page.locator('.canvas-save-text-btn').click()
  await page.locator('.md-dirty-hint').waitFor({ state: 'hidden' })
  check('内嵌预览仍可保存到原文件', fs.readFileSync(artifactPath, 'utf8').includes('用户未保存修改'))
  await page.locator('.oa-preview-back').click()
  check('文件返回成果列表后仍保留右侧小组', await text('.od-header') === objectTitle && await page.locator('.oa-item').count() === 2)
  await shot('organization-artifacts-tabs')
  const opsArtifactTeam = page.locator('.org-team').filter({ has: page.locator('.org-team-owner', { hasText: '运营组' }) })
  await opsArtifactTeam.locator('.org-team-artifacts').click()
  await page.locator('.oa-item').first().waitFor({ state: 'visible' })
  check('同名小组切换保持真实归属隔离', await page.locator('.oa-item').count() === 1 && (await text('.oa-list')).includes('运营组交付') && !(await text('.oa-list')).includes('研发组交付'))
  fs.unlinkSync(opsPath)
  await page.locator('.oa-item').click()
  await page.locator('.oa-error').waitFor()
  check('成果丢失时提示错误，仍留在本组成果列表', (await text('.oa-error')).includes('文件不在原位置') && await page.locator('.od-header').isVisible())
  await page.locator('.od-header .tph-close').click()
  await page.locator('.oc-header .tph-close').click()
  check('退出团队后恢复会话产出物清单', await page.locator('.artifact-list-slot:visible').count() > 0)
  await page.locator('.artifact-list-slot:visible .artifact-chrome-btn').first().hover()
  await page.locator('.artifact-list-pop-item', { hasText: '其他任务稿' }).click()
  await page.locator('.sub-agent-dock .dock-team').click()
  await devTeam.locator('.org-team-artifacts').click()
  await page.locator('.oa-item').first().waitFor()
  await page.locator('.od-header .tph-close').click()
  await page.locator('.oc-header .tph-close').click()
  check('关闭团队恢复进入前的主文档', await page.evaluate(() => window.__e2eArtifactStore.getActiveArtifact(window.__e2eTab)?.id === 'unrelated-artifact'))
  await page.locator('.canvas-panel button[aria-pressed]').click()
  const artifactInput = page.locator('.assistant-focus-chat [contenteditable="true"]').first()
  await artifactInput.waitFor({ state: 'visible' })
  await artifactInput.fill('普通产出物全屏仍能对话')
  check('会话产出物全屏仍保留可编辑浮动对话', await artifactInput.innerText() === '普通产出物全屏仍能对话')
  await artifactInput.fill('')
  await page.locator('.canvas-panel button[aria-pressed]').click()
  await page.locator('.sub-agent-dock .dock-team').click()
  await page.evaluate(() => {
    delete window.__e2eStore.tabs.find(tab => tab.id === window.__e2eTab).agentState.steps.find(step => step.id === 'org-1').organization.sessionId
    window.__e2eStore.setAgentSession(window.__e2eTab, 'sess-no-artifacts', Date.now())
  })
  await page.locator('.org-team-artifacts').first().click()
  await page.locator('.oa-empty', { hasText: '暂无成果' }).waitFor()
  check('无成果时显示空状态且不改变对象标题', (await text('.oa-list')).includes('暂无成果') && await page.locator('.od-header').isVisible())
  await page.locator('.od-header .tph-close').click()

  console.log('\n[4] 团的完整群聊')
  await page.locator('.organization-chart .org-team-chat').first().click()
  await page.locator('.expert-team-chat').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.expert-team-chat .etc-message').first().waitFor({ state: 'visible', timeout: 10_000 })
  const chatText = await text('.expert-team-chat')
  check('固定对象标题是小组「项目团」', (await text('.od-header')).includes('小组「项目团」'), await text('.od-header'))
  await checkTeamHeader(page, '.od-header', '群聊分栏', check)
  check('群聊全文是从文件里读来的 4 条', await page.locator('.expert-team-chat .etc-message').count() === 4, await page.locator('.expert-team-chat .etc-message').count())
  check('成员栏是这个团的两位，组长一栏写着是研发组的', chatText.includes('前端') && chatText.includes('后端') && chatText.includes('负责人·研发组'), chatText)
  check('秘书的话显示为「秘书」', chatText.includes('这一版只做账号密码登录') && /秘书/.test(chatText), chatText)
  check('不会混进别的团的人', !chatText.includes('小投') && !chatText.includes('文档'))
  await shot('4-team-chat')

  console.log('\n[4b] 两个组长名下各有一个同名团')
  await page.locator('.od-header .tph-close').first().click()
  await sleep(300)
  check('团框画出了两个', await page.locator('.organization-chart .org-team').count() === 2)
  const opsTeam = page.locator('.organization-chart .org-team').filter({ hasText: '负责人·运营组' })
  check('团框里写着各自的组长', await opsTeam.count() === 1)
  await opsTeam.locator('.org-team-chat').click()
  await page.locator('.expert-team-chat').waitFor({ state: 'visible', timeout: 10_000 })
  const opsMembers = await page.locator('.expert-team-chat .etc-member').evaluateAll((items) => items.map((el) => el.getAttribute('aria-label') ?? ''))
  check('点开的是运营组的项目团，成员不串',
    opsMembers.some((label) => label.includes('小营')) && !opsMembers.some((label) => label.includes('前端')),
    JSON.stringify(opsMembers))
  await shot('4b-same-name-team')

  console.log('\n[5] 返回')
  await page.locator('.od-header .tph-close').first().click()
  await sleep(300)
  check('回到组织图', await page.locator('.expert-team-chat').count() === 0 && await page.locator('.organization-chart').isVisible())
  await page.locator('.organization-chart .oc-header .tph-close').first().click()
  await sleep(300)
  check('再返回回到对话', await page.locator('.organization-chart').count() === 0)

  console.log('\n[6] 都干完了')
  await updateStep(dispatchStep(true))
  await sleep(600)
  const doneDock = await text('.sub-agent-dock')
  check('顶部写着组织 8 人都干完了', /团队 8 人已收工/.test(doneDock), doneDock)
  const doneCard = await page.locator('.ai-messages:visible .organization-card').first().innerText().catch(() => '')
  check('卡片写着都干完了', /成员已收工/.test(doneCard), doneCard)
  await shot('6-done')

  console.log('\n[6b] 都做完后的组织图')
  await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).click()
  await page.locator('.organization-chart').waitFor({ state: 'visible', timeout: 10_000 })
  const doneChart = await text('.organization-chart')
  check('顶部概览写着 8 人做完', /8 人做完/.test(doneChart) && !/人在干/.test(doneChart), doneChart)
  check('所有人都是做完状态', await page.locator('.organization-chart .org-node.is-completed').count() === 8)
  check('两个团框都变成全组做完', await page.locator('.organization-chart .org-team.is-completed').count() === 2 && doneChart.includes('全组做完'), doneChart)
  await shot('6b-done-chart')
  await shotChart('6b-done-chart-full')
  await page.locator('.organization-chart .oc-header .tph-close').first().click()
  await sleep(300)

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
  check('顶部也只有一个组织入口', await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).count() === 1)
  const dedupeDock = await text('.sub-agent-dock')
  check('顶部按最早那份快照显示，不再转圈', /团队 8 人已收工/.test(dedupeDock) && !/人在干/.test(dedupeDock), dedupeDock)
  await shot('7-dedupe')

  console.log('\n[8] 五种节点状态与独立的验收结论')
  const mixed = dispatchStep(false)
  const statuses = ['running', 'completed', 'running', 'completed', 'pending', 'failed', 'interrupted', 'completed']
  mixed.organization.members.forEach((m, i) => { m.status = statuses[i] })
  mixed.organization.live = 3
  mixed.organization.problems = 2
  mixed.organization.teams[0].review = 'reject'
  await updateStep(mixed)
  await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).click()
  await page.locator('.organization-chart').waitFor({ state: 'visible' })
  for (const status of ['running', 'waiting', 'completed', 'failed', 'interrupted']) {
    check(`展示 ${status} 节点`, await page.locator(`.organization-chart .org-node.is-${status}`).count() > 0)
  }
  check('组长有固定身份栏，完成后身份仍在', await page.locator('.org-node.is-lead.is-completed .org-node-rank').count() === 1)
  check('执行完成时仍能看见验收打回', await page.locator('.org-review.is-reject').innerText() === '验收打回')
  check('打断节点使用虚线边框', await page.locator('.org-node.is-interrupted').evaluate(el => getComputedStyle(el).borderTopStyle) === 'dashed')
  const colors = await page.locator('.organization-chart .org-node').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).borderTopColor))
  check('五种状态的边框颜色不同', new Set(colors).size === 5, colors.join(', '))
  check('仅执行状态点有呼吸动画', await page.locator('.org-node.is-running .org-status-dot').first().evaluate(el => getComputedStyle(el).animationName) !== 'none')
  check('执行卡片本身不闪烁', await page.locator('.org-node.is-running').first().evaluate(el => getComputedStyle(el).animationName) === 'none')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  check('减少动态效果时执行状态点静止', await page.locator('.org-node.is-running .org-status-dot').first().evaluate(el => getComputedStyle(el).animationName) === 'none')
  await shot('8-mixed-status')
  await shotChart('8-mixed-status-full')
  await page.locator('.oc-header .tph-close').click()
  await pushStep({ id: 'plan-spacing', type: 'plan_created', timestamp: Date.now(), content: '验证顶部间距', plan: {
    id: 'plan-spacing', title: '组织架构派工测试', createdAt: Date.now(), updatedAt: Date.now(),
    steps: [{ id: 'p1', title: '检查组织进展', status: 'in_progress' }],
  } })
  await pushStep({ id: 'loose-spacing', type: 'tool_call', toolName: 'dispatch_agents', timestamp: Date.now(), content: '派出独立伙计', success: true,
    subAgents: [{ id: '独立伙计', name: '独立伙计', description: '检查文档', status: 'running', steps: [] }],
  })
  check('分层团队与独立成员仍只有一个团队入口', await page.locator('.sub-agent-dock .dock-row').count() === 1)
  const gap = await page.evaluate(() => {
    const dock = document.querySelector('.sub-agent-dock')
    const plan = dock.previousElementSibling?.querySelector('.agent-plan')
    return plan ? dock.getBoundingClientRect().top - plan.getBoundingClientRect().bottom : null
  })
  check('团队入口沿用与计划之间的间距', gap !== null && Math.abs(gap) < 16, String(gap))
  await shot('9-spacing')

  console.log('\n[9a] 12位直属成员按宽度换行，铺满重新排布')
  await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).click()
  await page.locator('.organization-chart').waitFor({ state: 'visible' })
  // 复现实际验收：一个13人专家团，成员带职责、角色和当前活动。
  const thirteen = dispatchStep(false)
  thirteen.organization = { total: 13, live: 11, teams: [{ name: '知识库测绘团', review: 'pending', messageCount: 5 }], members: Array.from({ length: 13 }, (_, i) => member(`目录测绘${i + 1}`, i < 11 ? 'running' : 'completed', { team: '知识库测绘团', role: '知识库编目专家', description: `测绘第${i + 1}个目录并交回内容地图`, activity: { tool: 'write_file', args: '编目结果.md', status: 'running' } })) }
  await updateStep(thirteen)
  await page.waitForFunction(() => document.querySelectorAll('.organization-chart .org-node').length === 13)
  const thirteenGrid = await page.locator('.org-team-members').evaluate(el => {
    const nodes = [...el.querySelectorAll('.org-node')].map(node => node.getBoundingClientRect())
    return { columns: nodes.filter(node => Math.abs(node.top - nodes[0].top) < 1).length, fits: el.scrollWidth <= el.clientWidth + 1 }
  })
  check('实际13人专家团默认铺满后至少三列，不再侧栏单列长排', thirteenGrid.columns >= 3 && thirteenGrid.fits, JSON.stringify(thirteenGrid))
  const runningCardHeight = await page.locator('[data-member="目录测绘1"]').evaluate(node => node.offsetHeight)
  const doneCardHeight = await page.locator('[data-member="目录测绘13"]').evaluate(node => node.offsetHeight)
  check('运行与完成卡片保持相同76px高度，仅运行时显示活动', runningCardHeight === 76 && doneCardHeight === 76 && await page.locator('[data-member="目录测绘1"] .org-node-activity').count() === 1 && await page.locator('[data-member="目录测绘13"] .org-node-activity').count() === 0, JSON.stringify({ runningCardHeight, doneCardHeight }))
  await shot('13-team-overview')
  await page.locator('[data-member="目录测绘1"]').click()
  await page.locator('.oc-detail .od-header').waitFor()
  check('13人团点成员后图和详情同时可见', await page.locator('.oc-overview .org-team').isVisible() && (await text('.od-header')).includes('目录测绘1'))
  await shot('13-team-member')
  await page.locator('.oc-overview .org-team-chat').click()
  await page.locator('.oc-detail .od-header').waitFor()
  check('不关成员详情也能直接改看群聊', await page.locator('.oc-detail .org-member-detail').count() === 0 && (await text('.od-header')).includes('知识库测绘团'))
  await page.locator('.od-header .tph-close').click()
  await page.locator('[data-member="目录测绘1"]').click()
  await page.locator('.oc-detail .od-header').waitFor()
  await page.evaluate(() => {
    const org = window.__e2eStore.tabs.find(tab => tab.id === window.__e2eTab).agentState.steps.find(step => step.id === 'org-1').organization
    org.members = org.members.filter(member => member.name !== '目录测绘1')
    org.total--; org.live--
  })
  await page.locator('.oc-detail').waitFor({ state: 'detached' })
  check('选中成员从数据消失时关闭详情，不留空白侧栏', true)
  await sleep(350)
  const flat = dispatchStep(true)
  flat.organization = { total: 12, live: 0, teams: [], members: Array.from({ length: 12 }, (_, i) => member(`直属成员${i + 1}`, 'completed')) }
  await updateStep(flat)
  await page.waitForFunction(() => document.querySelectorAll('.organization-chart .org-node').length === 12)
  const gridBounds = () => page.locator('.oc-body').evaluate(body => {
    body.scrollTop = 0
    const nodes = [...body.querySelectorAll('.org-node')].map(node => node.getBoundingClientRect())
    const box = body.getBoundingClientRect()
    return { fits: body.scrollWidth <= body.clientWidth + 1, columns: nodes.filter(node => Math.abs(node.top - nodes[0].top) < 1).length, rows: new Set(nodes.map(node => Math.round(node.top))).size, allVisible: nodes.every(node => node.left >= box.left && node.right <= box.right && node.top >= box.top && node.bottom <= box.bottom) }
  })
  const fullGrid = await gridBounds()
  check('直属12人按工作区宽度多列排列且一屏可见', fullGrid.fits && fullGrid.columns >= 3 && fullGrid.allVisible, JSON.stringify(fullGrid))
  await shot('9a-direct-focus')

  const mixedRoots = dispatchStep(false)
  mixedRoots.organization.members.push(member('直属顾问', 'running'))
  mixedRoots.organization.total++
  mixedRoots.organization.live++
  await updateStep(mixedRoots)
  await page.waitForFunction(() => document.querySelectorAll('.organization-chart .org-node').length === 9)
  check('负责人和直属成员混排时，直属成员仍在根层', await page.locator('.oc-tree > .org-children > .org-cell > .org-branch > [data-member="直属顾问"]').count() === 1)
  check('直属顾问没有误入任一负责人的下级分区', await page.locator('.org-cell.has-children [data-member="直属顾问"]').count() === 0)
  await shot('9a-mixed-roots')

  console.log('\n[9b] 完整展示 1000 人、101 团与异常汇总')
  const large = dispatchStep(true)
  large.organization.members = Array.from({ length: 1000 }, (_, i) => member(`大组织成员${i}`, i === 0 ? 'failed' : 'completed', i === 0 ? { lead: true, role: '负责人' } : { parent: '大组织成员0', team: `大团${i % 101}` }))
  large.organization.teams = Array.from({ length: 101 }, (_, i) => ({ name: `大团${i}`, owner: '大组织成员0', review: i === 100 ? 'reject' : i === 99 ? 'pending' : 'none', messageCount: 0, waitingLeader: i === 100, wakeLimit: 30 }))
  Object.assign(large.organization, { total: 1000, live: 0, problems: 1 })
  const recovering = { ...large, subAgents: [], organization: { ...large.organization, live: 1,
    members: large.organization.members.map((m, i) => i === 999 ? { ...m, status: 'running' } : m),
  } }
  await updateStep(recovering)
  await page.locator('.oc-summary').filter({ hasText: '1 人在干' }).waitFor({ state: 'visible' })
  await page.locator('.oc-header').filter({ hasText: /共\s*1000\s*人/ }).waitFor({ state: 'visible' })
  check('没有直属运行成员时仍展示深层成员的组织进度', true)
  await updateStep(large)
  await page.locator('.organization-chart .org-node').nth(999).waitFor({ state: 'attached', timeout: 15000 })
  check('1000 人全部展开在图上', await page.locator('.organization-chart .org-node').count() === 1000)
  check('101 个团队全部展示', await page.locator('.organization-chart .org-team').count() === 101)
  const summary = await text('.oc-summary')
  check('汇总同时列出执行异常、打回、待验收、等负责人', /1 人出问题/.test(summary) && /1 个小组验收打回/.test(summary) && /1 个小组待验收/.test(summary) && /1 个小组等负责人/.test(summary), summary)
  const scroll = await page.locator('.oc-body').evaluate(el => ({ width: el.scrollWidth, clientWidth: el.clientWidth, height: el.scrollHeight, clientHeight: el.clientHeight }))
  check('大组织按面板宽度换行并保留纵向滚动空间', scroll.width <= scroll.clientWidth + 1 && scroll.height > scroll.clientHeight, JSON.stringify(scroll))
  await page.locator('.oc-header .tph-close').click()
  await updateStep(mixed)

  console.log('\n[10] 没有助手面板宿主的对话覆盖层')
  // 隔离夹具撤掉助手专属宿主回调，走 AiPanel 为终端/联络保留的真实覆盖层入口。
  await page.evaluate(() => {
    const seen = new Set()
    const findPanel = vnode => {
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return null
      seen.add(vnode)
      const component = vnode.component
      if (component?.props?.tabId === window.__e2eTab && Object.hasOwn(component.props, 'openOrganizationSeat')) return component
      const nested = component && findPanel(component.subTree)
      if (nested) return nested
      for (const child of Array.isArray(vnode.children) ? vnode.children : []) {
        const match = findPanel(child)
        if (match) return match
      }
      return null
    }
    const vm = findPanel(document.querySelector('#app')._vnode)
    if (!vm) throw new Error('覆盖层测试找不到当前对话组件')
    window.__e2eOrgHost = { vm, open: vm.props.openOrganizationSeat }
    vm.props.openOrganizationSeat = undefined
  })
  await page.locator('.sub-agent-dock .dock-team', { hasText: '查看团队' }).click()
  await page.locator('.organization-chart.is-overlay').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.querySelector('.organization-chart.is-overlay.is-focus'))
  const overlayBounds = await page.locator('.organization-chart').evaluate(el => {
    const chart = el.getBoundingClientRect()
    const tab = el.closest('.tab-view').getBoundingClientRect()
    return { position: getComputedStyle(el).position, width: chart.width - tab.width, left: chart.left - tab.left }
  })
  check('覆盖层铺满本工作台而不覆盖侧栏', overlayBounds.position === 'fixed' && Math.abs(overlayBounds.width) < 2 && Math.abs(overlayBounds.left) < 2, JSON.stringify(overlayBounds))
  check('终端覆盖层同样没有还原组织图的入口', await page.locator('.oc-header .tph-focus').count() === 0)
  await page.locator('.organization-chart .org-node').first().click()
  await page.locator('.oc-detail .om-body').waitFor()
  check('覆盖层成员详情只保留正常14px内边距，没有对话占位', await page.locator('.oc-detail .om-body').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)) === 14 && await page.locator('.od-header .tph-focus').count() === 0)
  await page.locator('.od-header .tph-close').click()
  await page.evaluate(session => window.__e2eStore.setAgentSession(window.__e2eTab, session, Date.now()), artifactSession)
  await page.locator('.org-team-artifacts').first().click()
  await page.locator('.oa-item').first().waitFor({ state: 'visible' })
  check('对话覆盖层也能查看团队成果', (await text('.oa-list')).includes('研发组交付'))
  check('终端覆盖层成果固定右侧且没有浮动输入占位', await page.locator('.od-header .tph-focus').count() === 0 && await page.locator('.od-content').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)) === 0)
  await page.locator('.od-header .tph-close').first().click()
  await page.locator('.oc-header .tph-close').click()
  await page.evaluate(() => { window.__e2eOrgHost.vm.props.openOrganizationSeat = window.__e2eOrgHost.open })


} catch (error) {
  failures.push(`脚本出错：${error?.stack || error}`)
  console.error(`  FAIL 脚本出错：${error?.stack || error}`)
  await shot('error')
} finally {
  // 应用可能因隔离夹具中的运行状态/未保存草稿拦关闭；仅清理 launchApp 返回的测试进程。
  const closeTimeout = setTimeout(() => app.process()?.kill('SIGKILL'), 5000)
  try { await app.close().catch(() => undefined) } finally { clearTimeout(closeTimeout) }
  if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures.length ? `\nRESULT FAIL (${failures.length})\n${failures.map((f) => `  - ${f}`).join('\n')}` : '\nRESULT PASS')
process.exit(failures.length ? 1 : 0)
