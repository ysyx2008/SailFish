/** 真CLI进程/存盘/恢复，脚本模型验证派工参数与用户上下文来源，不读取桌面数据。 */
import fs from 'node:fs'
import path from 'node:path'
import { callTool, say, startMockLlm } from './mock-llm.mjs'
import { ROOT, runPlain, sandbox } from './harness.mjs'
const directories=[]
const env=sandbox(0,'sft-dispatch-contract',directories)
let stage=0, phase='initial', resumed=false, supplementSent=false, finalSent=false
const ORIGINAL='SECRET_USER_TASK'
const NOTICE='NOTICE_ONLY_SENTINEL'
const RESUME='RESUME_USER_TASK'
const SUPPLEMENT='SUPPLEMENT_REAL_INPUT'
const FINAL='FINAL_USER_TASK'
const task=(name,extra={})=>({name,description:`核对${name}`,prompt:`TASK_WORKER:${name} 只返回完成`,...extra})
const text=message=>typeof message?.content==='string'?message.content:JSON.stringify(message?.content??'')
const check=(name,ok,detail='')=>{if(!ok)throw Error(`${name}: ${detail}`);console.log('OK '+name)}
const llm=await startMockLlm({respond:(body,entry)=>{
 const main=(body.tools??[]).some(tool=>tool.function?.name==='dispatch_agents')
 const lastUser=[...body.messages].reverse().find(message=>message.role==='user')
 if(!main){
  const name=text(lastUser).match(/TASK_WORKER:([a-z]+)/)?.[1]
  entry.who=name
  if(name==='review'&&body.messages.at(-1)?.role!=='tool')return callTool('team_say',{to:['组长'],message:'核对完成',verdict:'pass'})
  return say(name==='seed'?NOTICE:'完成')
 }
 entry.who='main'
 if(phase==='resume'){
  if(!resumed){resumed=true;return callTool('dispatch_agents',{tasks:[task('restored',{fork_turns:'2'})]})}
  if(!supplementSent&&text(lastUser).includes(SUPPLEMENT)){supplementSent=true;return callTool('dispatch_agents',{tasks:[task('supplement',{fork_turns:'1'})]})}
  return say('恢复完成')
 }
 if(phase==='final'){
  if(!finalSent){finalSent=true;return callTool('dispatch_agents',{tasks:[task('afterrestore',{fork_turns:'2'})]})}
  return say('最终恢复完成')
 }
 if(stage===0){stage++;return callTool('dispatch_agents',{fork_turns:'none',tasks:[task('forbiddenroot')]})}
 if(stage===1){stage++;return callTool('dispatch_agents',{team:'不应派团',tasks:[task('forbiddenteam',{role:'甲'}),task('forbiddenteamb',{role:'乙'})],batch:{instruction:'批量',items:[{input:'条目'}]}})}
 if(stage===2){stage++;return callTool('dispatch_agents',{batch:{instruction:'批量',items:[{name:'forbiddenitem',input:'条目',fork_turns:'none'}]}})}
 if(stage===3){stage++;return callTool('dispatch_agents',{tasks:[task('seed',{fork_turns:'none'})]})}
 if(stage===4){
  if(body.messages.at(-1)?.role!=='user'||!text(lastUser).includes(NOTICE))return say('等待首位成员交回')
  stage++;return callTool('dispatch_agents',{tasks:[task('last',{fork_turns:'1'}),task('none',{fork_turns:'none'}),task('all')]})
 }
 if(stage===5){stage++;return callTool('dispatch_agents',{team:'核对组',tasks:[task('builder',{role:'实施',fork_turns:'none'}),task('review',{role:'复核',reviewer:true,fork_turns:'none'})]})}
 return say('全部完成')
}})
env.env.SFT_API_URL=`http://127.0.0.1:${llm.port}/v1`
const opening=name=>llm.requests.find(entry=>entry.who===name)?.body.messages??[]
const userText=name=>opening(name).filter(message=>message.role==='user').map(text).join('\n')
function files(dir,filename){const found=[];for(const item of fs.existsSync(dir)?fs.readdirSync(dir,{withFileTypes:true}):[]){const file=path.join(dir,item.name);if(item.isDirectory())found.push(...files(file,filename));else if(item.name.endsWith(filename))found.push(file)}return found}
const readLines=file=>fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
try{
 const result=await runPlain([`${ORIGINAL}：执行派工参数回归`,'--free'],env,90000)
 check('真CLI进程正常结束',result.code===0,result.err.slice(-1200))
 const workers=new Set(llm.requests.map(entry=>entry.who).filter(name=>name&&name!=='main'))
 check('错位参数和不兼容组合均零派出，合法6人到岗',workers.size===6&&['seed','last','none','all','builder','review'].every(name=>workers.has(name)),JSON.stringify([...workers]))
 check('最近1轮仍带原用户交代',userText('last').includes(ORIGINAL),userText('last'))
 check('敲门不冒充最近一轮用户消息',!userText('last').includes(NOTICE),userText('last'))
 check('none不带原任务，默认all带原任务',!userText('none').includes(ORIGINAL)&&userText('all').includes(ORIGINAL))
 const toolTexts=llm.requests.filter(entry=>entry.who==='main').flatMap(entry=>entry.body.messages.filter(message=>message.role==='tool').map(text))
 check('错误明确指出字段位置及team/batch冲突',toolTexts.some(s=>s.includes('不能放在顶层'))&&toolTexts.some(s=>s.includes('不能用 batch'))&&toolTexts.some(s=>s.includes('batch.fork_turns')))
 check('回执标明实际上下文档位',toolTexts.some(s=>s.includes('上下文：最近 1 轮用户交代')&&s.includes('上下文：不带')&&s.includes('上下文：全带')))
 check('回执明确标验收人',toolTexts.some(s=>s.split('\n').some(line=>line.startsWith('- review')&&line.includes('（验收人）'))))
 const stateFiles=files(path.join(env.dataDir,'history/sub-agents'),'state.json')
 check('实际登记的验收人只有review',stateFiles.map(file=>JSON.parse(fs.readFileSync(file,'utf8'))).filter(state=>state.reviewer).map(state=>state.name).join()==='review')
 const histories=files(path.join(env.dataDir,'history/agent'),'messages.jsonl')
 const messages=histories.flatMap(readLines)
 check('敲门来源随主会话落盘，用户部分为空',messages.some(message=>text(message).includes(NOTICE)&&message._systemInjected&&Array.isArray(message._userContextParts)&&message._userContextParts.length===0))
 check('来源元数据不发给模型API',llm.requests.every(entry=>entry.body.messages.every(message=>!Object.hasOwn(message,'_userContextParts'))))
 check('验收结论真实进入群聊',files(path.join(env.dataDir,'history/expert-teams'),'team-核对组.jsonl').some(file=>readLines(file).some(message=>message.verdict==='pass')))
 const session=path.basename(path.dirname(histories[0]))
 phase='resume'
 const second=await runPlain([],{cwd:env.cwd,env:{...env.env,RESUME_SESSION:session,RESUME_LINE:`${RESUME}：接着核对上下文`,RESUME_SUPPLEMENT:SUPPLEMENT}},90000,path.join(ROOT,'scripts/cli-e2e/resume-runner.cjs'))
 check('新进程重开同会话正常结束',second.code===0,second.err.slice(-1200))
 check('重开后最近2轮包含两次真实交代',userText('restored').includes(ORIGINAL)&&userText('restored').includes(RESUME),userText('restored'))
 check('重开后系统回执仍不冒充用户消息',!userText('restored').includes(NOTICE),userText('restored'))
 check('真实运行中插话成为最近一轮，不混入更早交代',userText('supplement').includes(SUPPLEMENT)&&!userText('supplement').includes(ORIGINAL)&&!userText('supplement').includes(RESUME),userText('supplement'))
 check('真实用户插话来源片段随检查点落盘',files(path.join(env.dataDir,'history/agent'),'messages.jsonl').flatMap(readLines).some(message=>message._systemInjected&&message._userContextParts?.some(part=>message.content.slice(part.start,part.end).includes(SUPPLEMENT))))
 phase='final'
 const third=await runPlain([],{cwd:env.cwd,env:{...env.env,RESUME_SESSION:session,RESUME_LINE:FINAL}},90000,path.join(ROOT,'scripts/cli-e2e/resume-runner.cjs'))
 check('再次重启后正常结束',third.code===0,third.err.slice(-1200))
 check('再次重启最近2轮保留上次插话和本次交代',userText('afterrestore').includes(SUPPLEMENT)&&userText('afterrestore').includes(FINAL)&&!userText('afterrestore').includes(RESUME),userText('afterrestore'))
 console.log('RESULT PASS')
}finally{await llm.close();if(!process.env.E2E_KEEP)for(const directory of directories)fs.rmSync(directory,{recursive:true,force:true});else console.log('KEEP '+JSON.stringify(directories))}
