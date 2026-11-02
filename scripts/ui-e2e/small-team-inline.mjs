/** 隔离真实窗口：小团队直接展示、人数边界和续派。模型不调用。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sft-small-team-'))
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
 const add=async(count, omitted=0)=>page.evaluate(({count,omitted})=>{
  const {store,id}=window.__listFixture
  store.tabs.find(t=>t.id===id).agentState.steps=[]
  store.addAgentStep(id,{id:'request',type:'user_task',content:'核对监管要求',timestamp:Date.now()})
  const members=Array.from({length:count-omitted},(_,i)=>({id:`成员${i}`,name:`成员${i}`,description:`核对第${i+1}项要求`,role:'核对专家',teamId:'small',status:'running',steps:[{tool:'read_file',args:`资料${i}`,status:'running'}],result:`成员${i}核对结果`}))
  store.addAgentStep(id,{id:'small',type:'tool_call',toolName:'dispatch_agents',content:`派出${count}位专家`,success:true,timestamp:Date.now(),subAgents:members,organization:{teamId:'small',members,teams:[],total:count,live:count,omitted}})
 },{count,omitted})
 const rows=()=>page.locator('.team-dispatch-card > .team-member-tree .tmt-member')
 for(const count of [1,2,5,6]){
  await add(count);await pause(250)
  check(`${count}人时直接列出的成员数正确`,await rows().count()===(count<=5?count:0))
  check(`${count}人时保留团队入口`,await page.locator('.team-dispatch-card .organization-card').count()===1)
 }
 await add(2);await pause(250)
 check('角色、职责和当前活动直接可见',(await rows().first().innerText()).includes('核对专家')&&(await rows().first().innerText()).includes('核对第1项要求')&&(await rows().first().innerText()).includes('资料0'))
 await rows().first().locator('.sub-agent-header').click()
 check('点击成员原地展开结果',(await rows().first().innerText()).includes('成员0核对结果'))
 await rows().first().locator('.tmt-details').click()
 await page.locator('.organization-chart').waitFor()
 check('成员详情入口可打开团队视图',await page.locator('.organization-chart').count()===1)
 await page.locator('.oc-header .tph-close').click()
 await add(5);await pause(250)
 await page.evaluate(()=>{const{store,id}=window.__listFixture;const org=store.tabs.find(t=>t.id===id).agentState.steps.find(s=>s.id==='small').organization;org.members.push({id:'成员5',name:'成员5',description:'补充核对',teamId:'small',status:'pending'});org.total=6;org.live=6;store.addAgentStep(id,{id:'continued',type:'tool_call',toolName:'dispatch_agents',content:'再派一位',success:true,timestamp:Date.now()+1,subAgents:[{id:'成员5',name:'成员5',description:'补充核对',teamId:'small',status:'pending',steps:[]}]})})
 await pause(250)
 check('同队续派到6人自动收成一个入口',await rows().count()===0&&await page.locator('.team-dispatch-card').count()===1)
 await add(5,1);await pause(250)
 check('缺失历史名单保留紧凑入口',await rows().count()===0)
 await add(2);await pause(250)
 await page.evaluate(()=>{const{store,id}=window.__listFixture;const step=store.tabs.find(t=>t.id===id).agentState.steps.find(s=>s.id==='small');step.subAgents[1].status='completed';step.organization.members[1].status='completed';step.organization.live=1})
 await pause(250)
 check('成员状态实时更新',await rows().last().locator('.sub-agent-card.completed').count()===1)
 if(process.env.E2E_SHOT){fs.mkdirSync(process.env.E2E_SHOT,{recursive:true});await page.screenshot({path:path.join(process.env.E2E_SHOT,'small-team-inline.png')})}
 console.log('RESULT PASS')
}finally{const timer=setTimeout(()=>app.process()?.kill('SIGKILL'),5000);try{await app.close().catch(()=>{})}finally{clearTimeout(timer)};fs.rmSync(directory,{recursive:true,force:true})}
