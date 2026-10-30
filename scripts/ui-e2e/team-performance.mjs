/** 千人界面性能与视口完整性：只用临时模拟成员，不调用模型。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchApp } from './launch.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-team-performance-'))
const app = await launchApp(directory)
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
const check = (label, ok) => { if (!ok) throw Error(label); console.log(`OK ${label}`) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
try {
  await page.waitForFunction(() => window.electronAPI?.config)
  await page.evaluate(async () => { await window.electronAPI.config.setSetupCompleted(true); await window.electronAPI.config.setAiProfiles([{id:'fixture',name:'fixture',apiUrl:'http://127.0.0.1:1/v1',apiKey:'x',model:'fixture'}]); await window.electronAPI.config.setActiveAiProfile('fixture') })
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal'))
  await page.evaluate(() => {const store=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('terminal');const id=store.createAssistantTab({title:'千人性能验证'});store.markAssistantSkipOnboarding(id);store.focusHubConversation(id);window.__perf={store,id}})
  await pause(1500)
  for (let i=0;i<4;i++) {const dialog=page.locator('.confirm-overlay button:visible').last();if(await dialog.count())await dialog.click({force:true,timeout:1000}).catch(()=>{});await pause(200)}
  for (const shape of ['flat','grouped']) {
    await page.evaluate(shape => {
      const {store,id}=window.__perf
      store.addAgentStep(id,{id:`u-${shape}`,type:'user_task',content:'千人性能验证',timestamp:Date.now()})
      const step={id:`perf-${shape}`,type:'tool_call',toolName:'dispatch_agents',content:'千人夹具',timestamp:Date.now(),success:true}
      const members=Array.from({length:1000},(_,i)=>({id:`成员${i}`,name:`成员${i}`,description:`核对第${i}份资料`,status:'running',activity:{tool:'read_file',args:'初始活动',status:'running'}}))
      if(shape==='flat')step.subAgents=members.map(({activity,...m})=>({...m,steps:[activity]}))
      else step.organization={total:1000,live:1000,members:members.map((m,i)=>({...m,...(i===0?{lead:true,role:'负责人'}:{parent:'成员0',team:`小组${i%101}`} )})),teams:Array.from({length:101},(_,i)=>({name:`小组${i}`,owner:'成员0',review:'none',messageCount:0}))}
      store.addAgentStep(id,step)
    },shape)
    await page.locator('.dock-team').waitFor()
    const result=await page.evaluate(async shape => {
      const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve))
      const settle=async()=>{for(let i=0;i<5;i++)await frame()}
      const until=async test=>{const start=performance.now();while(!test()){if(performance.now()-start>10000)throw Error('界面未显示最新状态');await frame()}}
      let firstContentPeak=0
      const firstContentObserver=new MutationObserver(()=>{firstContentPeak=Math.max(firstContentPeak,document.querySelectorAll('.organization-chart .org-avatar').length)})
      firstContentObserver.observe(document.body,{childList:true,subtree:true})
      const started=performance.now();document.querySelector('.dock-team').click()
      await until(()=>document.querySelectorAll('.organization-chart .org-node').length===1000)
      await settle()
      firstContentObserver.disconnect()
      const openMs=performance.now()-started
      // 隐藏滚动根后恢复：IO应重新激活可见内容，不靠超时全量回退。
      const scrollRoot=document.querySelector('.oc-body')
      const display=scrollRoot.style.display
      scrollRoot.style.display='none';await settle()
      scrollRoot.style.display=display;await settle()
      await until(()=>document.querySelector('.organization-chart .org-avatar'))

      const body=document.querySelector('.oc-body')
      const dimensions=()=>[body.scrollWidth,body.scrollHeight]
      const before=dimensions()
      const painted=document.querySelectorAll('.organization-chart .org-avatar').length
      // 访问两个轴的四角，最后将真正的末尾节点滚进视口。
      const frames=[];let prev=performance.now()
      for(let i=0;i<40;i++){body.scrollLeft=(body.scrollWidth-body.clientWidth)*i/39;body.scrollTop=(body.scrollHeight-body.clientHeight)*i/39;await frame();const now=performance.now();frames.push(now-prev);prev=now}
      const tail=document.querySelector('[data-member="成员999"]');tail.scrollIntoView({block:'center',inline:'center'})
      await until(()=>tail.querySelector('.org-node-name-text'))
      await settle()
      const after=dimensions()
      const {store,id}=window.__perf;const target=store.tabs.find(t=>t.id===id).agentState.steps.find(s=>s.id===`perf-${shape}`)
      const update=k=>{
        target.snapshotAt=Date.now()+k
        if(shape==='flat')target.subAgents=target.subAgents.map((m,i)=>({...m,status:i%2===k%2?'running':'completed',steps:[{tool:'read_file',args:`tick-${k}`,status:'running'}]}))
        else target.organization={...target.organization,live:500,members:target.organization.members.map((m,i)=>({...m,status:i%2===k%2?'running':'completed',activity:{tool:'read_file',args:`tick-${k}`,status:'running'}}))}
      }
      const delays=[]
      for(let k=0;k<10;k++){const start=performance.now();update(k);await until(()=>tail.querySelector('.org-node-activity')?.textContent.includes(`tick-${k}`));await frame();delays.push(performance.now()-start);await new Promise(resolve=>setTimeout(resolve,150))}
      // 多次短间隔通知最后仍显示末条，而不是积压旧帧。
      for(let k=10;k<30;k++){update(k);await new Promise(resolve=>setTimeout(resolve,10))}
      await until(()=>tail.querySelector('.org-node-activity')?.textContent.includes('tick-29'))
      const p95=a=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*.95)-1]
      return {shape,openMs:Math.round(openMs),slots:document.querySelectorAll('.organization-chart .org-node').length,painted,firstContentPeak,domNodes:document.querySelector('.organization-chart').querySelectorAll('*').length,scrollP95Ms:Math.round(p95(frames)),updateVisibleP95Ms:Math.round(p95(delays)),delays:delays.map(Math.round),stableLayout:before.join()===after.join(),tailLoaded:tail.textContent.includes('成员999')}
    },shape)
    console.log('PERF '+JSON.stringify(result))
    check(`${shape}：保留1000个完整槽位，实际绘制内容少于200`,result.slots===1000&&result.painted>0&&result.painted<200&&result.firstContentPeak<200)
    check(`${shape}：双向滚动访问末尾成员，不改变结构尺寸`,result.tailLoaded&&result.stableLayout)
    check(`${shape}：持续更新包含合并等待仍在500ms内显示最新状态`,result.updateVisibleP95Ms<500)
    if(process.env.E2E_SHOT){fs.mkdirSync(process.env.E2E_SHOT,{recursive:true});await page.screenshot({path:path.join(process.env.E2E_SHOT,`team-performance-${shape}-chart.png`)})}
    // 点击虚拟化后重新绘制的末尾节点，确实进入相应成员详情。
    await page.locator('[data-member="成员999"]').click()
    await page.locator('.org-member-detail .om-header').waitFor()
    check(`${shape}：末尾成员可点击查看详情`,(await page.locator('.om-header .tph-title').innerText()).includes('成员999'))
    await page.locator('.om-header .tph-back').click()
    await page.locator('.oc-header .tph-close').click()
    await page.evaluate(()=>{window.__listContentPeak=0;window.__listObserver=new MutationObserver(()=>{window.__listContentPeak=Math.max(window.__listContentPeak,document.querySelectorAll('.dock-panel .tmt-name').length)});window.__listObserver.observe(document.body,{childList:true,subtree:true})})
    await page.locator('.dock-toggle').click()
    await pause(250)
    const listFirstContentPeak=await page.evaluate(()=>{window.__listObserver.disconnect();return window.__listContentPeak})
    const list=await page.locator('.dock-panel').evaluate(async panel=>{
      panel.querySelector('[data-member="成员999"]').scrollIntoView({block:"center"})
      await new Promise(resolve=>setTimeout(resolve,100))
      return {slots:panel.querySelectorAll('.tmt-member').length,painted:panel.querySelectorAll('.tmt-name').length,tail:panel.textContent.includes('成员999')}
    })
    check(`${shape}：快捷名单也保留全量、按视口绘制且末尾可见`,list.slots===1000&&list.painted>0&&list.painted<200&&list.tail&&listFirstContentPeak<200)
    if(process.env.E2E_SHOT){fs.mkdirSync(process.env.E2E_SHOT,{recursive:true});await page.screenshot({path:path.join(process.env.E2E_SHOT,`team-performance-${shape}.png`)})}
    await page.keyboard.press('Escape')
    await page.evaluate(shape=>{const{store,id}=window.__perf;const target=store.tabs.find(t=>t.id===id).agentState.steps.find(s=>s.id===`perf-${shape}`);if(target.organization){target.organization.live=0;target.organization.members.forEach(m=>m.status='completed')}else target.subAgents.forEach(m=>m.status='completed')},shape)
    await pause(150)
  }
  console.log('RESULT PASS')
} finally {
  const timeout=setTimeout(()=>app.process()?.kill('SIGKILL'),5000)
  try{await app.close().catch(()=>{})}finally{clearTimeout(timeout);fs.rmSync(directory,{recursive:true,force:true})}
}
