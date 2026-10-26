/**
 * 派出去的伙计 / 专家挂在对话顶部——桌面应用里的真窗口端到端。
 * 临时数据目录，窗口不抢前台。往一个助手页里直接灌「派出」那一步，看顶部那一行的样子。
 *
 *   npx vite build && node scripts/ui-e2e/pinned-dispatch.mjs
 *   E2E_SHOT=/tmp/shots node scripts/ui-e2e/pinned-dispatch.mjs   # 顺便存几张截图
 *   E2E_KEEP=1 …                                                   # 保留临时目录
 *
 * 1. 在干：对话滚走后顶部仍挂着一行，写着几位专家几个在干；专家团有打开群聊的入口
 * 2. 点开：展开的就是对话里那一处同样的内容；点别处 / Esc 收起；展开不把对话往下挤
 * 3. 干完：变成「8 位专家都干完了」，不立刻消失；你再说话后收起
 * 4. 被再叫起来：重新挂上
 * 5. 干活期间你插了话：干完那一刻仍然挂着，干完之后再说话才收起
 * 6. 有人失败：如实写出来，不写「都干完了」
 * 7. 打开时就已干完的旧事不挂
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-pinned-dispatch-'))
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

const agent = (i, status, extra = {}) => ({
  id: `a${i}`,
  name: `审核员${i}`,
  role: `专家${i}`,
  description: `核对第 ${i} 章`,
  prompt: `请核对第 ${i} 章`,
  status,
  steps: status === 'running' ? [{ tool: 'read_file', args: `/tmp/ch${i}.txt`, status: 'running' }] : [],
  ...extra,
})

const dispatchStep = (statuses, withTeam) => ({
  id: 'dispatch-1',
  type: 'tool_call',
  content: `派出 ${statuses.length} 位专家`,
  toolName: 'dispatch_agents',
  timestamp: Date.now(),
  success: true,
  subAgents: statuses.map((s, i) => agent(i + 1, s)),
  ...(withTeam ? {
    expertTeam: {
      name: '核查组',
      messages: [{ seq: 1, from: '审核员1', to: ['组长'], text: '第 2 章没有问题', at: Date.now() }],
    },
  } : {}),
})

const pushStep = (step) => page.evaluate(([s]) => window.__e2eStore.addAgentStep(window.__e2eTab, s), [step])

/** 机器上另有一份旗鱼占着浏览器助手时会弹提示，挡住点击；与本测试无关，关掉 */
const dismissDialogs = async () => {
  for (let i = 0; i < 5; i++) {
    const ok = page.locator('.confirm-overlay button:visible').last()
    if (await ok.count() === 0) return
    await ok.click({ force: true }).catch(() => undefined)
    await sleep(300)
  }
}

const dock = () => page.locator('.sub-agent-dock')
const dockText = () => dock().innerText().catch(() => '')

try {
  await ready()
  const tabId = await openAssistant()
  console.log(`\n助手页 ${tabId}`)
  await page.locator('.ai-messages-wrapper:visible').first().waitFor({ state: 'attached', timeout: 30_000 })
  await sleep(500)

  // 一场对话：用户一句话 + 秘书一段话 + 派出 8 位专家（组了团）+ 一大堆后续消息把派出那一处顶出屏幕
  await pushStep({ id: 'u1', type: 'user_task', content: '帮我核查募集说明书', timestamp: Date.now() })
  await pushStep({ id: 'm0', type: 'message', content: '我来分头核查。', timestamp: Date.now() })
  const eight = Array(8).fill('running')
  await pushStep(dispatchStep(eight, true))
  for (let i = 0; i < 40; i++) {
    await pushStep({ id: `f${i}`, type: 'message', content: `秘书接着干活的第 ${i} 段话，把派出那一处顶上去。`.repeat(3), timestamp: Date.now() })
  }
  await sleep(800)

  console.log('\n[1] 在干：顶部挂着一行')
  check('顶部有挂着的一行', await dock().count() === 1, await dock().count())
  const running = await dockText()
  check('写着 8 位专家、在干', /8 位专家/.test(running) && /8 在干/.test(running), running)
  check('专家团有打开群聊的入口', await page.locator('.sub-agent-dock .dock-team').count() === 1)
  const inChatVisible = await page.locator('.ai-messages:visible .sub-agents-group').count()
  check('对话里那一处被顶出屏幕了（挂在顶上才有意义）', inChatVisible === 0, `对话里还看得到 ${inChatVisible} 处`)
  await shot('1-working')

  console.log('\n[2] 点开 / 收起')
  await dismissDialogs()
  const msgBox = await page.locator('.ai-messages-wrapper:visible').first().boundingBox()
  await page.locator('.dock-bar').first().click()
  await sleep(300)
  check('展开后有 8 张专家卡', await page.locator('.dock-panel .sub-agent-card').count() === 8, await page.locator('.dock-panel .sub-agent-card').count())
  check('卡上有角色和在干什么', /专家1/.test(await page.locator('.dock-panel').innerText()) && /读取|read_file/.test(await page.locator('.dock-panel').innerText()))
  const msgBoxOpen = await page.locator('.ai-messages-wrapper:visible').first().boundingBox()
  check('展开不把对话往下挤', msgBox && msgBoxOpen && Math.abs(msgBox.y - msgBoxOpen.y) < 1 && Math.abs(msgBox.height - msgBoxOpen.height) < 1, JSON.stringify({ msgBox, msgBoxOpen }))
  await shot('2-open')
  await page.locator('.dock-panel .sub-agent-header').first().click()
  await sleep(200)
  check('点开一位看过程', await page.locator('.dock-panel .sub-agent-detail').count() === 1)
  await page.keyboard.press('Escape')
  await sleep(200)
  check('Esc 收起', await page.locator('.dock-panel').count() === 0)
  await page.locator('.dock-bar').first().click()
  await sleep(200)
  // 8 张卡的面板几乎盖满对话区，点面板之外：侧栏空白处
  await page.mouse.click(100, 400)
  await sleep(200)
  check('点别处收起', await page.locator('.dock-panel').count() === 0)

  console.log('\n[2b] 群聊按钮：点一下打开，再点一下收起')
  const teamBtn = page.locator('.sub-agent-dock .dock-team')
  await teamBtn.click()
  await sleep(500)
  check('点一下打开群聊', await page.locator('.expert-team-chat').count() === 1)
  const region = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region'))
  check('群聊标题栏能拖动窗口', await region('.expert-team-chat .etc-header') === 'drag', await region('.expert-team-chat .etc-header'))
  check('标题栏上的关闭按钮不被当成拖动区', await region('.expert-team-chat .etc-icon-btn') === 'no-drag', await region('.expert-team-chat .etc-icon-btn'))
  const sameColor = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.style.background = 'var(--bg-tertiary)'
    document.body.appendChild(probe)
    const expected = getComputedStyle(probe).backgroundColor
    probe.remove()
    return [getComputedStyle(document.querySelector('.expert-team-chat .etc-header')).backgroundColor, expected]
  })
  check('群聊标题栏底色和其他面板顶栏一致', sameColor[0] === sameColor[1], sameColor.join(' vs '))
  await shot('2b-team-chat')
  check('按钮亮着，表示群聊开着', /active/.test(await teamBtn.getAttribute('class') ?? ''))
  await teamBtn.click()
  await sleep(500)
  check('再点一下收起群聊', await page.locator('.expert-team-chat').count() === 0)
  check('按钮不再亮着', !/active/.test(await teamBtn.getAttribute('class') ?? ''))

  console.log('\n[2c] 有计划卡时，两块合成一块')
  const plan = (steps) => ({
    id: 'plan-1', type: 'plan_created', content: '计划', timestamp: Date.now(),
    plan: { id: 'p1', title: '六维专家团审阅文档', createdAt: 0, updatedAt: 0, steps },
  })
  await pushStep(plan([
    { id: 's1', title: '选定主审文档与分工', status: 'completed' },
    { id: 's2', title: '收齐六份审阅意见', status: 'in_progress' },
    { id: 's3', title: '汇总成最终意见', status: 'pending' },
  ]))
  await sleep(500)
  check('计划卡和顶部这一行都在', await page.locator('.plan-sticky-header').count() === 1 && await dock().count() === 1)
  const cardBox = await page.locator('.plan-sticky-header .agent-plan').boundingBox()
  const barBox = await page.locator('.sub-agent-dock .dock-bar').first().boundingBox()
  const gap = barBox.y - (cardBox.y + cardBox.height)
  check('计划卡和这一行之间留有空隙（6～12 像素），不顶在一起', gap >= 6 && gap <= 12, `空隙 ${gap}`)
  await shot('2c-with-plan')
  await page.locator('.dock-bar').first().click()
  await sleep(300)
  await shot('2d-open-with-plan')
  await page.keyboard.press('Escape')
  await sleep(200)

  console.log('\n[3] 干完：不立刻消失，你再说话后收起')
  await pushStep(dispatchStep(Array(8).fill('completed'), true))
  await sleep(500)
  const done = await dockText()
  check('变成「8 位专家都干完了」', /8 位专家都干完了/.test(done), done)
  await shot('3-done')
  await pushStep({ id: 'u2', type: 'user_supplement', content: '好的，谢谢', timestamp: Date.now() })
  await sleep(500)
  check('你说话后收起', await dock().count() === 0, await dockText())

  console.log('\n[4] 被再叫起来：重新挂上')
  await pushStep(dispatchStep(['running', ...Array(7).fill('completed')], true))
  await sleep(500)
  const again = await dockText()
  check('重新挂上', /8 位专家/.test(again) && /1 在干/.test(again), again)
  await shot('4-again')

  console.log('\n[5] 干活期间你插了话，干完的那一刻仍然挂着')
  await pushStep(dispatchStep(Array(8).fill('completed'), true))
  await sleep(400)
  await pushStep({ id: 'u2b', type: 'user_supplement', content: '收到', timestamp: Date.now() })
  await sleep(400)
  await pushStep({ ...dispatchStep(Array(3).fill('running'), false), id: 'dispatch-2' })
  await sleep(400)
  await pushStep({ id: 'u3', type: 'user_supplement', content: '顺便再看看附录', timestamp: Date.now() })
  await sleep(400)
  await pushStep({ ...dispatchStep(Array(3).fill('completed'), false), id: 'dispatch-2' })
  await sleep(500)
  const interjected = await dockText()
  check('你中途插过话，干完仍显示「都干完了」', /3 位专家都干完了/.test(interjected), interjected)
  check('没组团的没有群聊入口', await page.locator('.sub-agent-dock .dock-team').count() === 0)
  await pushStep({ id: 'u4', type: 'user_supplement', content: '收到', timestamp: Date.now() })
  await sleep(400)
  check('干完之后你再说话，收起', await dock().count() === 0, await dockText())

  console.log('\n[6] 有人失败：如实写出来')
  await pushStep({ ...dispatchStep(['running', 'running', 'running'], false), id: 'dispatch-3' })
  await sleep(400)
  await pushStep({ ...dispatchStep(['failed', 'completed', 'completed'], false), id: 'dispatch-3' })
  await sleep(500)
  const failed = await dockText()
  check('不写「都干完了」，写出失败', !/都干完了/.test(failed) && /1 失败/.test(failed), failed)
  await shot('5-failed')

  console.log('\n[7] 打开时就已经是干完的旧事：不挂')
  await pushStep({ id: 'u5', type: 'user_supplement', content: '好', timestamp: Date.now() })
  await sleep(400)
  await pushStep({ ...dispatchStep(Array(2).fill('completed'), false), id: 'dispatch-old' })
  await sleep(500)
  check('没亲眼看着干完的不挂', await dock().count() === 0, await dockText())

  console.log('\n[8] 同时挂着好几批：展开哪一行都不盖住别的行')
  for (const n of [1, 2, 3]) {
    await pushStep({ ...dispatchStep(Array(n + 1).fill('running'), false), id: `dispatch-m${n}`, content: `第 ${n} 批` })
  }
  await sleep(500)
  check('三批各挂一行', await page.locator('.sub-agent-dock .dock-bar').count() === 3, await page.locator('.sub-agent-dock .dock-bar').count())
  for (const index of [0, 1, 2]) {
    await page.locator('.dock-bar').nth(index).click()
    await sleep(300)
    const bars = await page.locator('.dock-bar').evaluateAll(els => els.map(el => el.getBoundingClientRect()))
    const panel = await page.locator('.dock-panel').boundingBox()
    const lastBottom = Math.max(...bars.map(b => b.bottom))
    check(`展开第 ${index + 1} 行：面板在所有行下面，不遮挡`, panel && panel.y >= lastBottom, JSON.stringify({ panelTop: panel?.y, lastBottom }))
    if (index === 0) await shot('8-multi-open')
    await page.keyboard.press('Escape')
    await sleep(200)
  }

  console.log('\n[9] 读回旧会话：上个进程留下的「在干」不挂，显示为已打断')
  await page.evaluate(([id]) => {
    const old = (n, status) => ({
      id: `old-${n}`, type: 'tool_call', content: '派出', toolName: 'dispatch_agents', timestamp: 2, success: true,
      subAgents: [{ id: `w${n}`, name: `伙计${n}`, description: '巡检', status }],
    })
    window.__e2eStore.restoreAgentHistory(id, {
      id: 'restored-1', timestamp: 1, userTask: '巡检', status: 'completed', duration: 1,
      steps: [{ id: 'ru', type: 'user_task', content: '巡检', timestamp: 1 }, old(1, 'running'), old(2, 'pending'), old(3, 'completed')],
    })
  }, [tabId])
  await sleep(500)
  check('没有伙计挂在顶上', await dock().count() === 0, await dockText())
  await shot('9-restored')
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
