/** 真实CLI进程与历史文件；模型为本地脚本，不调用外部模型。 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, runPlain, sandbox } from './harness.mjs'
const dirs=[]
const env=sandbox(0,'sft-team-boundaries',dirs)
let phase='first'
let dispatched=false
const workers=['旧甲','旧乙','新甲','新乙','新丙','追加','旧版追加']
const textOf=m=>m.role==='user'?(typeof m.content==='string'?m.content:JSON.stringify(m.content)):''
const who=entry=>{for(const m of [...entry.body.messages].reverse()){const t=textOf(m);for(const name of workers)if(t.includes(`我是${name}，`))return name}return 'main'}
const tasks=names=>names.map(name=>({name,role:'专家',description:`${name}核对`,prompt:`我是${name}，只交回核对完成`}))
const llm=await startMockLlm({
  onUser:(_text,_n,entry)=>{
    entry.who=who(entry)
    if(entry.who!=='main')return say(`${entry.who}完成`)
    if(dispatched)return say('本轮完成')
    dispatched=true
    if(phase==='first')return callTool('dispatch_agents',{tasks:tasks(['旧甲','旧乙'])})
    if(phase==='new')return callTool('dispatch_agents',{tasks:tasks(['新甲','新乙','新丙'])})
    if(phase==='continue')return callTool('dispatch_agents',{tasks:tasks(['追加']),continue_team:'旧甲'})
    if(phase==='legacy')return callTool('dispatch_agents',{tasks:tasks(['旧版追加']),continue_team:'旧甲'})
    return callTool('followup_agent',{name:'新乙',message:'再核对一次'})
  },
  afterTool:(_last,entry)=>{entry.who=who(entry);return say('已交代，等结果')},
})
env.env.SFT_API_URL=`http://127.0.0.1:${llm.port}/v1`
const check=(label,ok,detail='')=>{if(!ok)throw Error(`${label}: ${detail}`);console.log('OK '+label)}
function records(){
 const root=path.join(env.dataDir,'history/sub-agents');const states=[];let session
 for(const date of fs.existsSync(root)?fs.readdirSync(root):[])for(const id of fs.readdirSync(path.join(root,date))){session=id;for(const item of fs.readdirSync(path.join(root,date,id),{withFileTypes:true})){const file=path.join(root,date,id,item.name,'state.json');if(item.isDirectory()&&fs.existsSync(file))states.push(JSON.parse(fs.readFileSync(file,'utf8')))}}
 return {states,session}
}
function views(session){
 const root=path.join(env.dataDir,'history/agent')
 for(const date of fs.readdirSync(root)){const file=path.join(root,date,session,'meta.json');if(fs.existsSync(file))return Object.values(JSON.parse(fs.readFileSync(file,'utf8')).organizations??{})}
 return []
}
async function run(next,session){
 phase=next;dispatched=false
 const result=session?await runPlain([], {env:{...env.env,RESUME_SESSION:session,RESUME_LINE:`执行阶段${next}`},cwd:env.cwd},60000,path.join(ROOT,'scripts/cli-e2e/resume-runner.cjs')):await runPlain(['建立第一支团队','--free'],env,60000)
 check(`${next} 真进程正常结束`,result.code===0,result.err.slice(-1200))
 return records()
}
try{
 const first=await run('first')
 check('首批2人保存了同一个团队标识',first.states.length===2&&first.states[0].teamId&&first.states.every(s=>s.teamId===first.states[0].teamId))
 const oldId=first.states[0].teamId
 const second=await run('new',first.session)
 const newStates=second.states.filter(s=>s.name.startsWith('新'))
 const newId=newStates[0]?.teamId
 check('同会话冷恢复后默认新建，3人与历史2人隔离',second.states.length===5&&newStates.length===3&&newId&&newId!==oldId&&newStates.every(s=>s.teamId===newId))
 check('新团队快照只显示3人',views(first.session).some(v=>v.teamId===newId&&v.total===3&&v.members.every(m=>m.name.startsWith('新'))))
 const third=await run('continue',first.session)
 check('明确指定旧成员续派，归属保持旧团队',third.states.find(s=>s.name==='追加')?.teamId===oldId)
 check('旧团队新快照含原成员和追加，新团队保持3人',views(first.session).some(v=>v.teamId===oldId&&v.total===3&&v.members.some(m=>m.name==='追加'))&&views(first.session).filter(v=>v.teamId===newId).every(v=>v.total===3),JSON.stringify(views(first.session).map(v=>({teamId:v.teamId,total:v.total,names:v.members.map(m=>m.name)}))))
 const fourth=await run('followup',first.session)
 check('续交代已有成员不另开团队',fourth.states.length===6&&fourth.states.find(s=>s.name==='新乙')?.teamId===newId)
 const latest=views(first.session).filter(v=>v.teamId===newId).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0))[0]
 check('续跑后的图仍只属于原来的3人团队',latest?.total===3&&latest.members.every(m=>m.teamId===newId))
 // 模拟升级前没有归属字段的历史；只改本测试的临时文件。
 const strip=value=>{if(Array.isArray(value))return value.map(strip);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='teamId').map(([key,item])=>[key,strip(item)]));return value}
 const downgrade=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())downgrade(file);else if(/\.jsonl?$/.test(item.name)){const lines=fs.readFileSync(file,'utf8').split('\n');fs.writeFileSync(file,lines.map(line=>{try{return JSON.stringify(strip(JSON.parse(line)))}catch{return line}}).join('\n'))}}}
 downgrade(path.join(env.dataDir,'history'))
 const legacy=await run('legacy',first.session)
 check('旧版成员明确续派可用，不会另建未知团队',legacy.states.find(s=>s.name==='旧版追加')?.teamId==='legacy')
 check('旧版已有组织与续派成员共用legacy全貌，不猜测拆队',views(first.session).some(v=>v.teamId==='legacy'&&v.total===7&&v.members.some(m=>m.name==='旧甲')&&v.members.some(m=>m.name==='旧版追加')))
 console.log('RESULT PASS')
}finally{
 await llm.close()
 if(!process.env.E2E_KEEP)for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true})
 else console.log('KEEP '+JSON.stringify(dirs))
}
