/** 千人界面性能与视口完整性：只用临时模拟成员，不调用模型。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { launchApp } from './launch.mjs'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-team-performance-'))
// 真实历史记录包含长结果，验证重新加载时展开卡片不先缩成一行。
for (const shape of ['flat','grouped']) {
  const name='成员999'
  const folder=path.join(directory,'history/sub-agents/2026-10-30',`perf-${shape}`,`${name}-${createHash('sha1').update(name).digest('hex').slice(0,8)}`)
  fs.mkdirSync(folder,{recursive:true})
  fs.writeFileSync(path.join(folder,'state.json'),JSON.stringify({name,description:'核对第999份资料',prompt:'核对文件',status:'completed',result:Array.from({length:40},(_,i)=>`真实长结果第${i}行`).join('\n'),updatedAt:Date.now()}))
  fs.writeFileSync(path.join(folder,'meta.json'),JSON.stringify({id:name,timestamp:Date.now(),status:'completed',duration:1}))
  fs.writeFileSync(path.join(folder,'steps.jsonl'),'')
}
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
      const step={id:`perf-${shape}`,sourceSessionId:`perf-${shape}`,type:'tool_call',toolName:'dispatch_agents',content:'千人夹具',timestamp:Date.now(),success:true}
      const members=Array.from({length:1000},(_,i)=>({teamId:`perf-${shape}`,id:`成员${i}`,name:`成员${i}`,description:`核对第${i}份资料`,status:'running',activity:{tool:'read_file',args:'初始活动',status:'running'}}))
      if(shape==='flat')step.subAgents=members.map(({activity,...m})=>({...m,steps:[activity]}))
      else step.organization={teamId:`perf-${shape}`,total:1000,live:1000,members:members.map((m,i)=>({...m,...(i===0?{lead:true,role:'负责人'}:{parent:'成员0',team:`小组${i%101}`} )})),teams:Array.from({length:101},(_,i)=>({name:`小组${i}`,owner:'成员0',review:'none',messageCount:0}))}
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
      const showsTick=k=>k%2===1 ? tail.querySelector('.org-node-activity')?.textContent.includes(`tick-${k}`) : tail.dataset.status==='completed'&&!tail.querySelector('.org-node-activity')
      for(let k=0;k<10;k++){const start=performance.now();update(k);await until(()=>showsTick(k));await frame();delays.push(performance.now()-start);await new Promise(resolve=>setTimeout(resolve,150))}
      // 多次短间隔通知最后仍显示末条，而不是积压旧帧。
      for(let k=10;k<30;k++){update(k);await new Promise(resolve=>setTimeout(resolve,10))}
      await until(()=>tail.querySelector('.org-node-activity')?.textContent.includes('tick-29'))
      // 屏外成员收工也必须更新占位高度，滚回后才不会突然缩一截。
      const offscreen=document.querySelector('[data-member="成员1"]')
      const complete=(m,i)=>i===1?{...m,status:'completed'}:m
      target.snapshotAt=Date.now()+40
      if(shape==='flat')target.subAgents=target.subAgents.map(complete)
      else target.organization={...target.organization,members:target.organization.members.map(complete)}
      await new Promise(resolve=>setTimeout(resolve,180));await settle()
      const reservedHeight=offscreen.offsetHeight
      offscreen.scrollIntoView({block:'center'});await until(()=>offscreen.querySelector('.org-node-name-text'));await settle()
      const offscreenStable=reservedHeight===offscreen.offsetHeight
      tail.scrollIntoView({block:'center'});await until(()=>tail.querySelector('.org-node-name-text'));await settle()
      const p95=a=>[...a].sort((x,y)=>x-y)[Math.ceil(a.length*.95)-1]
      return {shape,openMs:Math.round(openMs),slots:document.querySelectorAll('.organization-chart .org-node').length,painted,firstContentPeak,domNodes:document.querySelector('.organization-chart').querySelectorAll('*').length,scrollP95Ms:Math.round(p95(frames)),updateVisibleP95Ms:Math.round(p95(delays)),delays:delays.map(Math.round),stableLayout:before.join()===after.join(),offscreenStable,tailLoaded:tail.textContent.includes('成员999')}
    },shape)
    console.log('PERF '+JSON.stringify(result))
    check(`${shape}：保留1000个完整槽位，实际绘制内容少于200`,result.slots===1000&&result.painted>0&&result.painted<200&&result.firstContentPeak<200)
    check(`${shape}：双向滚动访问末尾成员，不改变结构尺寸`,result.tailLoaded&&result.stableLayout)
    check(`${shape}：屏外成员收工后滚回，占位与实际卡片等高`,result.offscreenStable)
    check(`${shape}：持续更新包含合并等待仍在500ms内显示最新状态`,result.updateVisibleP95Ms<500)
    if(process.env.E2E_SHOT){fs.mkdirSync(process.env.E2E_SHOT,{recursive:true});await page.screenshot({path:path.join(process.env.E2E_SHOT,`team-performance-${shape}-chart.png`)})}
    // 点击虚拟化后重新绘制的末尾节点，确实进入相应成员详情。
    await page.locator('[data-member="成员999"]').click()
    await page.locator('.oc-detail .od-header').waitFor()
    check(`${shape}：末尾成员可点击查看详情`,(await page.locator('.od-header .tph-title').innerText()).includes('成员999'))
    await page.locator('.od-header .tph-close').click()
    await page.locator('.oc-header .tph-close').click()
    await page.evaluate(()=>{window.__listContentPeak=0;window.__listObserver=new MutationObserver(()=>{window.__listContentPeak=Math.max(window.__listContentPeak,document.querySelectorAll('.dock-panel .sub-agent-card').length)});window.__listObserver.observe(document.body,{childList:true,subtree:true})})
    await page.locator('.dock-toggle').click()
    await pause(250)
    const listFirstContentPeak=await page.evaluate(()=>{window.__listObserver.disconnect();return window.__listContentPeak})
    check(`${shape}：快捷名单首次只显示40人，并提示剩余960人`,await page.locator('.dock-panel .tmt-member').count()===40 && (await page.locator('.dock-more').innerText()).includes('960'))
    for(let pageIndex=1;pageIndex<25;pageIndex++)await page.locator('.dock-more').click()
    check(`${shape}：显示更多后全部1000人可达`,await page.locator('.dock-panel .tmt-member').count()===1000 && await page.locator('.dock-more').count()===0)
    // 已恢复自然行高；未知行的初始估计值不能当作展开占位基准。
    // 像实际阅读一样滚过已加载名单，收集行高，再验证展开/回收的稳定性。
    const visited=await page.locator('.dock-panel').evaluate(async panel=>{
      const seen=new Set();const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));panel.scrollTop=0
      for(let i=0;i<500;i++){
        await frame();await frame()
        panel.querySelectorAll('.tmt-content').forEach(el=>seen.add(el.parentElement.dataset.member))
        if(panel.scrollTop+panel.clientHeight>=panel.scrollHeight-1)break
        panel.scrollTop=Math.min(panel.scrollHeight-panel.clientHeight,panel.scrollTop+panel.clientHeight*.6)
      }
      return seen.size
    })
    check(`${shape}：滚过各段后1000人成员内容均可实际访问`,visited===1000)


    const list=await page.locator('.dock-panel').evaluate(async panel=>{
      panel.querySelector('[data-member="成员999"]').scrollIntoView({block:"center"})
      await new Promise(resolve=>setTimeout(resolve,100))
      return {slots:panel.querySelectorAll('.tmt-member').length,painted:panel.querySelectorAll('.sub-agent-card').length,tail:panel.textContent.includes('成员999')}
    })
    check(`${shape}：完整加载的快捷名单按视口绘制且末尾可见`,list.slots===1000&&list.painted>0&&list.painted<200&&list.tail&&listFirstContentPeak<200)
    const lastCard=page.locator('.dock-panel [data-member="成员999"]')
    await lastCard.locator('.sub-agent-header').click()
    await lastCard.locator('.sub-agent-detail').waitFor()
    await lastCard.getByText('真实长结果第39行',{exact:false}).waitFor()
    await pause(100)
    const expandedHeight=await lastCard.evaluate(el=>el.getBoundingClientRect().height)
    await page.locator('.dock-toggle').focus()
    const listHeight=await page.locator('.dock-panel').evaluate(el=>{const height=el.scrollHeight;el.scrollTop=0;return height})
    await pause(150)
    await page.waitForFunction(()=>!document.querySelector('.dock-panel [data-member="成员999"] .sub-agent-card'))
    const hiddenHeight=await lastCard.evaluate(el=>el.getBoundingClientRect().height)
    check(`${shape}：展开卡片离开视口保留占位高度`,expandedHeight>56&&Math.abs(hiddenHeight-expandedHeight)<2)
    await lastCard.evaluate(el=>el.scrollIntoView({block:'center'}))
    await lastCard.locator('.sub-agent-card').waitFor()
    const minimumReturnHeight=await lastCard.evaluate(async el=>{let min=Infinity;for(let i=0;i<12;i++){await new Promise(resolve=>requestAnimationFrame(resolve));min=Math.min(min,el.getBoundingClientRect().height)}return min})
    check(`${shape}：长结果重新读取期间也不缩小占位`,minimumReturnHeight>=expandedHeight-2)
    await lastCard.locator('.sub-agent-detail').waitFor()
    check(`${shape}：滚回后保留原地展开及列表总高度`,Math.abs((await page.locator('.dock-panel').evaluate(el=>el.scrollHeight))-listHeight)<2)
    await page.keyboard.press('Escape')
    await page.locator('.dock-toggle').click()
    await pause(150)
    check(`${shape}：关闭再开也保留离屏展开占位`,Math.abs((await lastCard.evaluate(el=>el.getBoundingClientRect().height))-expandedHeight)<2&&Math.abs((await page.locator('.dock-panel').evaluate(el=>el.scrollHeight))-listHeight)<2)
    await lastCard.evaluate(el=>el.scrollIntoView({block:'center'}))
    await lastCard.locator('.sub-agent-detail').waitFor()
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
