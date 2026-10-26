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
  if (usage) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

/** 脚本里每一步的写法 */
/** finish 默认 stop；传 'length' 模拟回答停在输出额度上 */
export const say = (content, finish = 'stop') => ({ kind: 'text', content, finish })
/** content：同一条消息里调工具之前先说的话（可不给） */
export const callTool = (name, args, content) => ({ kind: 'tool', name, args, content })
/** 接口直接报错（400，不会被自动重试） */
export const fail = (message = 'mock failure') => ({ kind: 'fail', message })
/** 接上了但一直不回，直到对方断开（用来按 Ctrl+C） */
export const hang = () => ({ kind: 'hang' })

/**
 * @param script.onUser    用户（含命令行里敲的话）开头的一轮：(text, n, entry) => 动作；entry 是这次请求的全部内容
 * @param script.onContinue 目标续跑的一轮：(n) => 动作
 * @param script.respond   给了就整个接管：(整份请求体, 记录) => 动作；主人和并行的伙计共用同一个假模型时用它
 * 工具返回后的那一次请求默认回一句话；要换脚本，给 afterTool。
 * script.side：没有工具的旁路请求：(整份请求体, 记录) => 回一段文字；不给或回 undefined 就回「好」。
 * script.jsonForNonStream：非流式调用（写交接小结之类）回一整份 JSON；不开就和以前一样一律回事件流。
 * script.usage：(entry, action) => { prompt_tokens, completion_tokens }，要模拟「接口报多少真实用量」时给；
 *   返回 null = 这次不报用量（有的服务商就是不报），返回 undefined = 用默认值。
 */
export function startMockLlm(script) {
  const requests = []
  let userTurns = 0
  let continuations = 0
  const server = http.createServer((req, res) => {
    // 按字节收齐再解码：汉字落在两段数据的交界上时，逐段转字符串会把它拆坏
    const chunks = []
    req.on('data', (chunk) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
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
        // 要自己写旁路回答（比如让运维专家给出结论）：script.side 回一段文字；回 undefined 就还是「好」
        const sideText = script.side?.(body, entry)
        entry.sideReply = sideText
        if (typeof sideText === 'string') {
          if (body.stream !== true) {
            res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
            res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: sideText }, finish_reason: 'stop' }], usage: { ...USAGE.side, total_tokens: 320 } }))
          } else {
            sse(res, USAGE.side, { role: 'assistant', content: sideText }, 'stop')
          }
          return
        }
        if (body.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
          res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }], usage: { ...USAGE.side, total_tokens: 320 } }))
        } else {
          sse(res, USAGE.side, { role: 'assistant', content: '好' }, 'stop')
        }
        return
      }

      let action
      if (script.respond) {
        // 要看整份请求才能决定怎么回的场景（并行的主人和伙计各走各的）
        action = script.respond(body, entry)
        entry.phase = 'respond'
      } else if (last?.role === 'tool') {
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
      const custom = script.usage?.(entry, action)
      const usageFor = (kind) => (custom === undefined ? USAGE[kind] : custom)

      if (action.kind === 'fail') {
        res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify({ error: { message: action.message, type: 'invalid_request_error' } }))
        return
      }

      // 非流式调用（写交接小结之类）要的是一整份 JSON，不是事件流
      if (script.jsonForNonStream && body.stream !== true && (action.kind === 'tool' || action.kind === 'text')) {
        const usage = usageFor(action.kind)
        const message = action.kind === 'tool'
          ? { role: 'assistant', content: action.content ?? null, tool_calls: [{ id: `call_${requests.length}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] }
          : { role: 'assistant', content: action.content }
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        res.end(JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: action.kind === 'tool' ? 'tool_calls' : (action.finish ?? 'stop') }],
          ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}),
        }))
        return
      }

      if (action.kind === 'tool') {
        sse(res, usageFor('tool'), { role: 'assistant', ...(action.content ? { content: action.content } : {}), tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: action.name, arguments: JSON.stringify(action.args) } }] }, 'tool_calls')
      } else if (action.kind === 'hang') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        const timer = setTimeout(() => res.end(), 120_000)
        req.on('close', () => clearTimeout(timer))
      } else {
        sse(res, usageFor('text'), { role: 'assistant', content: action.content }, action.finish ?? 'stop')
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
