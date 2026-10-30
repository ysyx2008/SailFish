import { describe, it, expect } from 'vitest'
import { applyForkTurns, parseForkTurns, sanitizeParentMessages } from '../sanitize-parent-messages'
import type { AiMessage } from '../../ai.service'

describe('sanitizeParentMessages', () => {
  it('留下用户原话和助手最终答复，剥掉工具调用与结果', () => {
    const messages: AiMessage[] = [
      { role: 'system', content: 'you are an agent' },
      { role: 'user', content: '帮我查一下 nginx' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'dispatch_agents', arguments: '{}' } }]
      },
      { role: 'tool', content: 'spawned', tool_call_id: '1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: '2', type: 'function', function: { name: 'plan', arguments: '{}' } }]
      },
      { role: 'tool', content: 'plan created', tool_call_id: '2' },
      { role: 'assistant', content: '我先派人去看配置。' },
      { role: 'user', content: '上下文已压缩', _systemInjected: true },
    ]

    expect(sanitizeParentMessages(messages)).toEqual([
      { role: 'user', content: '帮我查一下 nginx' },
      { role: 'assistant', content: '我先派人去看配置。' },
    ])
  })

  it('用户原话整段留下，包括还没轮到的后续安排——这就是伙计第一趟可能越界的来源', () => {
    const user = [
      '先派「读包」只报 name 和 version。',
      '都回来后再向「读包」交代：把 scripts 里和 test 相关的脚本名列出来。',
    ].join('\n')
    expect(sanitizeParentMessages([{ role: 'user', content: user }])).toEqual([
      { role: 'user', content: user },
    ])
  })

  it('空答复和纯思考不进开局', () => {
    const messages: AiMessage[] = [
      { role: 'assistant', content: '   ', reasoning_content: 'think' },
      { role: 'user', content: '继续' },
    ]
    expect(sanitizeParentMessages(messages)).toEqual([
      { role: 'user', content: '继续' },
    ])
  })
})

describe('fork_turns', () => {
  it('省略或 all 是全带，none 是不带，数字是最近几轮', () => {
    expect(parseForkTurns(undefined)).toEqual({ kind: 'all' })
    expect(parseForkTurns('all')).toEqual({ kind: 'all' })
    expect(parseForkTurns('none')).toEqual({ kind: 'none' })
    expect(parseForkTurns('2')).toEqual({ kind: 'last', n: 2 })
    expect(parseForkTurns('0')).toMatchObject({ error: expect.any(String) })
    expect(parseForkTurns('banana')).toMatchObject({ error: expect.any(String) })
  })

  it('最近 1 轮只留最后一条用户原话及其后的答复', () => {
    const cleaned: AiMessage[] = [
      { role: 'user', content: '第一轮：先读包' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '第二轮：只报 name' },
      { role: 'assistant', content: '派人了' },
    ]
    expect(applyForkTurns(cleaned, { kind: 'none' })).toEqual([])
    expect(applyForkTurns(cleaned, { kind: 'all' })).toEqual(cleaned)
    expect(applyForkTurns(cleaned, { kind: 'last', n: 1 })).toEqual([
      { role: 'user', content: '第二轮：只报 name' },
      { role: 'assistant', content: '派人了' },
    ])
  })
})

describe('通知不占用户上下文轮次', () => {
  it('只有通知的合并消息不进入用户上下文，也不挤掉最近一次交代', () => {
    const messages: AiMessage[] = [
      {role:'user',content:'用户真正交代'},
      {role:'assistant',content:'已安排'},
      {role:'user',content:'系统敲门与任务回执',_userContextParts:[]},
    ]
    expect(applyForkTurns(sanitizeParentMessages(messages),{kind:'last',n:1})).toEqual(messages.slice(0,2))
  })
  it('同批用户插话和通知只带用户部分，落盘任务边界标记不吞掉插话', () => {
    const combined: AiMessage = {role:'user',content:'通知A 用户一 通知B 用户二',_systemInjected:true,_userContextParts:[{start:4,end:7},{start:12,end:15}]}
    const cleaned=sanitizeParentMessages([{role:'user',content:'旧任务'},combined,{role:'assistant',content:'新答复'}])
    expect(cleaned).toEqual([{role:'user',content:'旧任务'},{role:'user',content:'用户一'},{role:'user',content:'用户二'},{role:'assistant',content:'新答复'}])
    expect(applyForkTurns(cleaned,{kind:'last',n:1})).toEqual([{role:'user',content:'用户二'},{role:'assistant',content:'新答复'}])
    expect(JSON.stringify(cleaned)).not.toContain('通知')
  })
  it('JSON重开后保留来源；旧记录没有新字段时仍按旧标记处理', () => {
    const saved=JSON.parse(JSON.stringify([{role:'user',content:'通知 用户回答',_systemInjected:true,_userContextParts:[{start:3,end:7}]},{role:'user',content:'旧通知',_systemInjected:true},{role:'user',content:'旧用户原话'}]))
    expect(sanitizeParentMessages(saved)).toEqual([{role:'user',content:'用户回答'},{role:'user',content:'旧用户原话'}])
  })
})
