/** 隔离真实窗口：旧名单排序/40人分页、层级与记忆。模型不调用。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sft-team-list-'))
const app=await launchApp(directory)
const page=await app.firstWindow()
page.setDefaultTimeout(15000)
const check=(name,ok)=>{if(!ok)throw Error(name);console.log('OK '+name)}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
try{
 await page.waitForFunction(()=>window.electronAPI?.config)
 await page.evaluate(async()=>{await window.electronAPI.config.setSetupCompleted(true);await window.electronAPI.config.setAiProfiles([{id:'fixture',name:'fixture',apiUrl:'http://127.0.0.1:1/v1',apiKey:'x',model:'fixture'}]);await window.electronAPI.config.setActiveAiProfile('fixture')})
 await page.reload()
 await page.waitForFunction(()=>document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
 await page.evaluate(()=>{const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal');const id=store.createAssistantTab({title:'名单完整还原'});store.markAssistantSkipOnboarding(id);store.focusHubConversation(id);window.__listFixture={store,id}})
 await pause(1500)
 for(let i=0;i<4;i++){const dialog=page.locator('.confirm-overlay button:visible').last();if(await dialog.count())await dialog.click({force:true,timeout:1000}).catch(()=>{});await pause(100)}
 const add=async(shape,source='list-source')=>page.evaluate(({shape,source})=>{
  const {store,id}=window.__listFixture
  store.addAgentStep(id,{id:`task-${shape}`,type:'user_task',content:'名单验证',timestamp:Date.now()})
  const grouped=shape==='grouped'
  const members=Array.from({length:grouped?1000:100},(_,i)=>({id:`成员${i}`,name:`成员${i}`,description:`职责${i}`,role:'核对专家',teamId:shape,status:'completed',...(grouped?i<2?{name:i?'负责人乙':'负责人甲',id:i?'负责人乙':'负责人甲',lead:true}:{parent:i%2?'负责人乙':'负责人甲',team:'同名组'}:{})}))
  if(grouped)members[999].status='running'
  else{members[94].status='running';members[99].status='running';members[95].status='running';members[95].waitingForModel=true;members[98].status='pending';members[97].status='failed';members[96].status='interrupted'}
  store.addAgentStep(id,{id:shape,sourceSessionId:source,type:'tool_call',toolName:'dispatch_agents',content:'派出成员',timestamp:Date.now(),subAgents:members.filter(m=>!m.parent).map(m=>({...m,steps:[]})),organization:{teamId:shape,sessionId:source,members,teams:grouped?['负责人甲','负责人乙'].map(owner=>({owner,name:'同名组',review:'none',messageCount:0})):[],total:members.length,live:members.filter(m=>m.status==='running'||m.status==='pending').length,updatedAt:Date.now()}})
 },{shape,source})
 await add('flat')
 const closedHint=await page.locator('.dock-toggle').getAttribute('title')
 await page.locator('.dock-toggle').click()
 const openedHint=await page.locator('.dock-toggle').getAttribute('title')
 check('展开收起保留原来的悬停提示',!!closedHint && !!openedHint && closedHint!==openedHint)
 await pause(200)
 const names=()=>page.locator('.dock-panel .tmt-member').evaluateAll(nodes=>nodes.map(node=>node.dataset.member))
 check('首批40人，尾部活跃者排在完成者之前',await page.locator('.dock-panel .tmt-member').count()===40 && (await names()).slice(0,6).join()===['成员94','成员99','成员95','成员98','成员97','成员96'].join())
 check('显示更多标出剩余60人',(await page.locator('.dock-more').innerText()).includes('60'))
 await page.locator('.dock-more').click()
 check('再显示40人，原成员不丢',await page.locator('.dock-panel .tmt-member').count()===80 && (await names())[0]==='成员94')
 await page.keyboard.press('Escape');await page.locator('.dock-toggle').click()
 check('关闭重开仍保留80人',await page.locator('.dock-panel .tmt-member').count()===80)
 await page.evaluate(()=>{const{store,id}=window.__listFixture;const step=store.tabs.find(t=>t.id===id).agentState.steps.find(s=>s.id==='flat');step.organization.members[0].status='running';step.organization.members[99].status='completed';step.organization.updatedAt=Date.now()})
 await pause(250)
 check('状态更新后新活跃者前移',(await names())[0]==='成员0')
 await page.locator('.dock-team').click()
 await page.locator('.organization-chart .org-node').nth(99).waitFor()
 check('完整图仍全量100人，不受快捷名单分页限制',await page.locator('.organization-chart .org-node').count()===100)
 await page.locator('.oc-header .tph-close').click()
 await add('grouped')
 await page.locator('.dock-toggle').last().click();await pause(200)
 check('另一个团队首次仍40人，不借用前队页数',await page.locator('.dock-panel .tmt-member').count()===40)
 check('深层尾部活跃成员与其负责人优先出现',(await names()).slice(0,2).join()===['负责人乙','成员999'].join())
 const owner=page.locator('.dock-panel [data-member="负责人乙"]').locator('..')
 check('活跃成员仍在自己上级的同名小组下面',await owner.locator('.team-member-tree [data-member="成员999"]').count()===1)
 const other=page.locator('.dock-panel [data-member="负责人甲"]').locator('..')
 check('另一个上级同名小组不混入该成员',await other.locator('.team-member-tree [data-member="成员999"]').count()===0)
 await page.locator('.dock-more').click()
 check('层级分页累计80人，祖先计入人数',await page.locator('.dock-panel .tmt-member').count()===80)
 await page.keyboard.press('Escape');await page.locator('.dock-toggle').first().click()
 check('切回前队保留自己的80人范围',await page.locator('.dock-panel .tmt-member').count()===80 && !(await names()).includes('成员999'))
 await page.keyboard.press('Escape');await page.locator('.dock-toggle').last().click()
 await page.evaluate(()=>{const{store,id}=window.__listFixture;const org=store.tabs.find(t=>t.id===id).agentState.steps.find(s=>s.id==='grouped').organization;org.total=1010;org.omitted=10;org.updatedAt=Date.now()})
 await pause(250)
 check('旧历史缺失资料另列10人，不混入可加载的剩余920人',(await page.locator('.dock-unavailable').innerText()).includes('10') && (await page.locator('.dock-more').innerText()).includes('920'))
 if(process.env.E2E_SHOT){fs.mkdirSync(process.env.E2E_SHOT,{recursive:true});await page.locator('.dock-panel').screenshot({path:path.join(process.env.E2E_SHOT,'team-list-pages.png')})}
 console.log('RESULT PASS')
}finally{const timer=setTimeout(()=>app.process()?.kill('SIGKILL'),5000);try{await app.close().catch(()=>{})}finally{clearTimeout(timer)};fs.rmSync(directory,{recursive:true,force:true})}
