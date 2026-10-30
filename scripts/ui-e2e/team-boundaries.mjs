/** 团队归属的真实窗口验证：仅隔离临时数据，不调用模型。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-team-boundaries-ui-'))
const app = await launchApp(directory)
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const failures = []
const check = (name, pass, detail = '') => { console.log(`${pass ? 'OK' : 'FAIL'} ${name} ${detail}`); if (!pass) failures.push(name) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = Date.now()
const members = (prefix, count, teamId) => Array.from({length: count}, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix}${i + 1}`, description: `${prefix}职责${i + 1}`, role: '校对专家', status: 'completed', ...(teamId ? {teamId} : {}) }))
const old = members('历史',100)
const a = members('新甲',3,'team-a').map(m=>({...m,status:'running'}))
const b = members('新乙',3,'team-b').map(m=>({...m,status:'running'}))
const steps = []
const task = id => ({id, type:'user_task', content:id, timestamp:stamp + steps.length})
const dispatch = (id, list, teamId) => ({id,type:'tool_call',content:'派出专家',toolName:'dispatch_agents',timestamp:stamp+steps.length,sourceSessionId:'boundary-source',subAgents:list.map(member=>({...member, steps:[]})),organization:{...(teamId?{teamId}:{}),sessionId:'boundary-source',members:list,teams:[],total:list.length,live:list.filter(m=>m.status==='running').length,updatedAt:stamp+steps.length}})
try {
  await page.waitForFunction(() => window.electronAPI?.config)
  await page.evaluate(async () => { await window.electronAPI.config.setSetupCompleted(true); await window.electronAPI.config.setAiProfiles([{ id: 'fixture', name: 'fixture', apiUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'fixture' }]); await window.electronAPI.config.setActiveAiProfile('fixture') })
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
  await page.evaluate(() => { const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal'); const id = store.createAssistantTab({ title: '独立团队验证' }); store.markAssistantSkipOnboarding(id); store.focusHubConversation(id); window.__boundaryFixture = {store,id} })
  await pause(1500)
  for (let i=0;i<4;i++) { const dialog=page.locator('.confirm-overlay button:visible').last(); if(await dialog.count()) await dialog.click({force:true,timeout:1000}).catch(()=>{}); await pause(100) }
  const add = async step => { steps.push(step); await page.evaluate(s=>{const {store,id}=window.__boundaryFixture;store.addAgentStep(id,s)},step) }
  await add(task('旧测试'))
  await add(dispatch('old',old))
  await add(task('这次派3人'))
  await add(dispatch('new-a',a,'team-a'))
  await pause(500)
  check('当前横幅仅新团队3人',await page.locator('.sub-agent-dock .dock-row').count()===1 && /3/.test(await page.locator('.dock-headline').innerText()) && !/100|103/.test(await page.locator('.dock-headline').innerText()))
  await page.locator('.dock-toggle').click()
  check('快捷名单只含3人',await page.locator('.dock-panel .tmt-member').count()===3 && !(await page.locator('.dock-panel').innerText()).includes('历史'))
  await page.keyboard.press('Escape')
  await page.locator('.dock-team').click()
  await page.locator('.organization-chart .org-node').nth(2).waitFor()
  check('组织图只含新队3人',await page.locator('.organization-chart .org-node').count()===3 && !(await page.locator('.organization-chart').innerText()).includes('历史职责'))
  await page.locator('.oc-header .tph-close').click()
  await add(dispatch('new-b',b,'team-b'))
  await pause(300)
  check('同轮再次派出显示两个独立入口',await page.locator('.sub-agent-dock .dock-row').count()===2)
  await page.locator('.dock-team').nth(1).click()
  await page.locator('.organization-chart .org-node').nth(2).waitFor()
  check('第二队图不混入第一队',await page.locator('.organization-chart .org-node').count()===3 && !(await page.locator('.organization-chart').innerText()).includes('新甲职责'))
  await page.locator('.oc-header .tph-close').click()
  await page.evaluate(()=>{const {store,id}=window.__boundaryFixture;for(const step of store.tabs.find(t=>t.id===id).agentState.steps){if(step.organization)step.organization.live=0;for(const member of step.subAgents??[])member.status='completed'}})
  await pause(300)
  await add(task('明确给新甲团队追加'))
  await add(dispatch('continue-a',members('新甲',4,'team-a').map(m=>({...m,status:'running'})),'team-a'))
  await pause(300)
  check('跨轮续派只保留原团队一处横幅',await page.locator('.sub-agent-dock .dock-row').count()===1 && /4/.test(await page.locator('.dock-headline').innerText()))
  await page.locator('.dock-team').click()
  await page.locator('.organization-chart .org-node').nth(3).waitFor()
  check('原入口读取续派后4人全貌',await page.locator('.organization-chart .org-node').count()===4)
  await page.locator('.oc-header .tph-close').click()
  // 通过真实历史恢复入口恢复同一组步骤，检验前端转换没有丢归属。
  await page.evaluate(({steps,stamp})=>{const {store,id}=window.__boundaryFixture;store.restoreAgentHistory(id,{id:'boundary-source',timestamp:stamp,userTask:'独立团队验证',steps,duration:10,status:'completed'})},{steps,stamp})
  await pause(600)
  const card=page.locator('.organization-card').filter({hasText:'4'}).first()
  await card.waitFor()
  check('历史恢复保留原团队4人入口',await card.count()===1)
  await card.click()
  await page.locator('.organization-chart .org-node').nth(3).waitFor()
  check('重开历史后组织图归属不变',await page.locator('.organization-chart .org-node').count()===4)
  if(process.env.E2E_SHOT){fs.mkdirSync(process.env.E2E_SHOT,{recursive:true});await page.screenshot({path:path.join(process.env.E2E_SHOT,'team-boundaries.png')})}
} catch(error){failures.push(String(error));console.error(error)}
finally { const timer=setTimeout(()=>app.process()?.kill('SIGKILL'),5000);try{await app.close().catch(()=>{})}finally{clearTimeout(timer)};fs.rmSync(directory,{recursive:true,force:true}) }
console.log(failures.length ? `RESULT FAIL ${failures.join('\n')}` : 'RESULT PASS')
process.exit(failures.length?1:0)
