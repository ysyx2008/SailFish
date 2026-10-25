/**
 * 主机管理列表：名字用满整行，操作按钮只在悬停时浮出来——桌面应用里的真窗口端到端。
 * 临时数据目录，窗口不抢前台。主导航宽度设成 283（用户常见的宽度）。
 *
 *   npx vite build && node scripts/ui-e2e/host-list-names.mjs
 *   E2E_SHOT=/tmp/shots node scripts/ui-e2e/host-list-names.mjs   # 顺便存截图
 *
 * 1. 名字很长的主机在 283 宽下完整显示，不被省略号截断
 * 2. 平时看不见操作按钮、点不到；悬停那一行才出现
 * 3. 悬停时按钮浮在右侧，不把名字往左挤（名字宽度不变）
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

const NAMES = ['MacBook Air Server', '192.168.230.130', 'Jump Server', '绿联4600NAS']
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-host-list-'))
fs.writeFileSync(path.join(dataDir, 'qiyu-terminal-config.json'), JSON.stringify({
  setupCompleted: true,
  recallSidebarWidth: 283,
  sshSessions: NAMES.map((name, i) => ({
    id: `s${i}`, name, host: `10.0.0.${i + 1}`, port: 22, username: 'yushen', authType: 'password', encoding: 'utf-8', createdAt: i,
  })),
}, null, '\t'))

const shotDir = process.env.E2E_SHOT
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })
const app = await launchApp(dataDir)
const page = await app.firstWindow()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}.png`) }) }

try {
  await sleep(3000)
  // 本机另有旗鱼在跑时会弹「浏览器助手没连上」，与本检查无关，点掉
  await page.getByRole('button', { name: '确定' }).click({ timeout: 2000 }).catch(() => {})
  // 进「终端」页，再点「连接远程主机」打开主机管理侧栏
  await page.getByText('终端', { exact: true }).first().click({ timeout: 90_000 })
  await sleep(800); await shot('terminal-page')
  await page.getByText('连接远程主机').first().click({ timeout: 30_000 })
  let found = false
  for (let i = 0; i < 40 && !found; i++) {
    found = await page.evaluate(() => (document.querySelector('.sidebar--hosts')?.getBoundingClientRect().width ?? 0) > 100 && !!document.querySelector('.session-name')).catch(() => false)
    if (!found) await sleep(250)
  }
  check('主机管理侧栏打开、列表出现了', found)

  const measure = () => page.evaluate((names) => {
    const rows = [...document.querySelectorAll('.session-item')]
    return names.map((name) => {
      const row = rows.find((r) => r.querySelector('.session-name')?.textContent === name)
      if (!row) return null
      const nameEl = row.querySelector('.session-name')
      const actions = row.querySelector('.session-actions')
      const style = getComputedStyle(actions)
      return {
        name,
        truncated: nameEl.scrollWidth > nameEl.clientWidth,
        nameWidth: nameEl.clientWidth,
        actionsOpacity: Number(style.opacity),
        actionsPointer: style.pointerEvents,
      }
    })
  }, NAMES)

  await sleep(400)
  await shot('idle')
  const idle = await measure()
  const sidebarWidth = await page.evaluate(() => document.querySelector('.sidebar--hosts')?.getBoundingClientRect().width)
  console.log(`  主机管理侧栏宽 ${sidebarWidth}px`)
  check('四个名字都在列表里', idle.every(Boolean))
  check('名字都完整显示，没有被省略号截断', idle.every((r) => r && !r.truncated), JSON.stringify(idle.filter((r) => r?.truncated)))
  check('平时操作按钮看不见、点不到', idle.every((r) => r && r.actionsOpacity === 0 && r.actionsPointer === 'none'))

  // 悬停第一行
  const row = page.locator('.session-item', { hasText: NAMES[0] }).first()
  await row.hover({ force: true })
  await sleep(400)
  await shot('hover')
  const hovered = (await measure())[0]
  check('悬停那一行，按钮出现并可点', hovered.actionsOpacity === 1 && hovered.actionsPointer === 'auto', JSON.stringify(hovered))
  check('按钮浮在右侧，没有把名字挤窄', hovered.nameWidth === idle[0].nameWidth, `${idle[0].nameWidth} -> ${hovered.nameWidth}`)
  const others = (await measure()).slice(1)
  check('没悬停的行按钮仍然隐藏', others.every((r) => r.actionsOpacity === 0))
} finally {
  await app.close().catch(() => {})
  if (!process.env.E2E_KEEP) fs.rmSync(dataDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项没过：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\n全部通过')
process.exit(0)
