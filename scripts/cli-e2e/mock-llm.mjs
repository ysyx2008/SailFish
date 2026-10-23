/**
 * 命令行端到端用的假模型：OpenAI 兼容的流式接口，按脚本回话。
 * 不碰真实模型，也不吃 token；每一次请求都记下来，供断言看「模型到底收到了什么」。
 */
import http from 'node:http'

const USAGE = {
  tool: { prompt_tokens: 20_000, completion_tokens: 500 },
  text: { prompt_tokens: 21_000, completion_tokens: 200 },
  side: { prompt_tokens: 300, completion_tokens: 20 },
}

const textOf = (message) => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''))

function sse(res, usage, delta, finish) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
  res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 脚本里每一步的写法 */
export const say = (content) => ({ kind: 'text', content })
export const callTool = (name, args) => ({ kind: 'tool', name, args })
/** 接上了但一直不回，直到对方断开（用来按 Ctrl+C） */
export const hang = () => ({ kind: 'hang' })

/**
 * @param script.onUser    用户（含命令行里敲的话）开头的一轮：(text, n, entry) => 动作；entry 是这次请求的全部内容
 * @param script.onContinue 目标续跑的一轮：(n) => 动作
 * 工具返回后的那一次请求默认回一句话；要换脚本，给 afterTool。
 */
export function startMockLlm(script) {
  const requests = []
  let userTurns = 0
  let continuations = 0
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw) } catch { /* 不是 JSON 的请求按没有处理 */ }
      const messages = body.messages ?? []
      const last = messages[messages.length - 1]
      const lastText = textOf(last)
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0
      const entry = { hasTools, lastRole: last?.role, lastText, body, at: Date.now() }
      requests.push(entry)

      // 起标题、整理记忆这类旁路请求：没有工具，随便回一句
      if (!hasTools) {
        if (body.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: { ...USAGE.side, total_tokens: 320 } }))
        } else {
          sse(res, USAGE.side, { role: 'assistant', content: '好' }, 'stop')
        }
        return
      }

      let action
      if (last?.role === 'tool') {
        action = script.afterTool?.(last, entry) ?? say('好的。')
        entry.phase = 'after-tool'
      } else if (last?.role === 'user' && lastText.includes('[系统·目标续跑]')) {
        action = script.onContinue(++continuations)
        entry.phase = `continue-${continuations}`
      } else {
        action = script.onUser(lastText, ++userTurns, entry)
        entry.phase = `user-${userTurns}`
      }
      entry.action = action.kind

      if (action.kind === 'tool') {
        sse(res, USAGE.tool, { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] }, 'tool_calls')
      } else if (action.kind === 'hang') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        const timer = setTimeout(() => res.end(), 120_000)
        req.on('close', () => clearTimeout(timer))
      } else {
        sse(res, USAGE.text, { role: 'assistant', content: action.content }, 'stop')
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    /** 开头那几次是主干对话（有工具），其余是旁路 */
    mainRequests: () => requests.filter((r) => r.hasTools),
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }),
  })))
}
