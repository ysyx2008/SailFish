/** 真CLI、真HTTP与落盘：合成额度错误，不借用真实账户。 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { runPlain, sandbox, makeChecker } from './harness.mjs'
const { check, failures } = makeChecker()
const dirs = []
let requests = 0
let teamScenario = false
let dispatched = false
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!body.tools?.length) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '额度验证' }, finish_reason: 'stop' }] }))
      return
    }
    requests++
    if (teamScenario && !dispatched) {
      dispatched = true
      const tasks = Array.from({ length: 12 }, (_, i) => ({ name: `成员${i+1}`, description: '只回答到', prompt: '只回答到', fork_turns: 'none' }))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const delta = { tool_calls: [{ index: 0, id: 'call-dispatch', type: 'function', function: { name: 'dispatch_agents', arguments: JSON.stringify({tasks}) } }] }
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`)
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Synthetic weekly quota exhausted; reset at 2099-11-02 00:00:00 +0800' } }))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const env = sandbox(server.address().port, 'sft-model-quota', dirs)
  const run = await runPlain(['只回答到', '--free'], env, 30000)
  check('额度耗尽只发一次，不循环重试', requests === 1, String(requests))
  check('CLI显示真实额度错误码和原文', run.out.includes('insufficient_quota') && run.out.includes('Synthetic weekly quota exhausted'), run.out.slice(-1200))
  check('任务结束，没有卡在等待模型', run.signal !== 'SIGKILL', String(run.signal))
  const files = []
  const walk = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, {withFileTypes:true}) : []) { const f = path.join(d,e.name); if(e.isDirectory()) walk(f); else if(e.name.endsWith('.json') || e.name.endsWith('.jsonl')) files.push(f) } }
  walk(path.join(env.dataDir, 'history', 'agent'))
  const saved = files.map(f => fs.readFileSync(f,'utf8')).join('\n')
  check('会话落盘保留API详情及供应商原文', saved.includes('apiError') && saved.includes('insufficient_quota') && saved.includes('2099-11-02'), saved.slice(-600))
  teamScenario = true
  requests = 0
  const teamEnv = sandbox(server.address().port, 'sft-team-quota', dirs)
  const teamRun = await runPlain(['派出12个成员', '--free'], teamEnv, 30000)
  check('多成员额度出错后整场正常结束', teamRun.signal !== 'SIGKILL', String(teamRun.signal))
  const teamFiles = []
  const collect = d => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, {withFileTypes:true}) : []) { const f = path.join(d,e.name); if(e.isDirectory()) collect(f); else if(e.name === 'meta.json') teamFiles.push(f) } }
  collect(path.join(teamEnv.dataDir, 'history', 'agent'))
  const orgs = teamFiles.flatMap(f => Object.values(JSON.parse(fs.readFileSync(f,'utf8')).organizations ?? {}))
  const members = orgs.flatMap(org => org.members ?? [])
  check('12名真实成员均保存且没有遗留等模型或执行中', members.length === 12 && members.every(m => !m.waitingForModel && !m.modelWaitReason && m.status !== 'running' && m.status !== 'pending'), JSON.stringify(members.map(m=>({name:m.name,status:m.status,waiting:m.waitingForModel}))))
  // 主请求失败会沿用级联打断；成员可能是已打断或已失败，不能强行标成全员API失败。
  check('主对话保留组织停止的额度原因', teamRun.out.includes('insufficient_quota') && teamRun.out.includes('Synthetic weekly quota exhausted'), teamRun.out.slice(-600))
  check('额度熔断释放队列，不给12人反复撞接口', requests <= 10, String(requests))
  console.log(`RESULT ${failures.length ? 'FAIL' : 'PASS'} (${8 - failures.length}/8)`)

  if (failures.length) process.exitCode = 1
} finally {
  await new Promise(resolve => server.close(resolve))
  if (process.env.E2E_KEEP) console.log('TEMP_DIRS', JSON.stringify(dirs))
  else dirs.forEach(d => fs.rmSync(d, { recursive:true, force:true }))
}
