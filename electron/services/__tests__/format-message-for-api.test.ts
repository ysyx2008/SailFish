import { describe, expect, it, vi } from 'vitest'

vi.mock('../config.service', () => ({
  getConfigService: () => ({
    get: () => undefined,
    set: () => {}
  }),
  ConfigService: class {}
}))

vi.mock('../ai-debug.service', () => ({
  getAiDebugService: () => ({
    logRequestStart: () => {},
    logResponseChunk: () => {},
    logResponseDone: () => {},
    logResponseError: () => {}
  })
}))

vi.mock('../agent/i18n', () => ({
  t: (key: string) => key
}))

vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  })
}))

import { AiService, formatMessageForApi, type AiMessage } from '../ai.service'

/**
 * DeepSeek V3.2+/V4 思考模式合规性回归测试。
 *
 * 关键要求：所有 assistant 消息（无论是否带 tool_calls）都必须携带 reasoning_content
 * 字段，缺一即被服务端拒绝（400 "The reasoning_content in the thinking mode must
 * be passed back to the API"）。该字段是否带值不重要，但字段本身必须存在。
 *
 * 这些测试覆盖容易漏字段的场景，包括 TaskMemory 压缩重建、跨会话恢复的老 record、
 * 模型切换前后等历史死角，确保 formatMessageForApi 是统一兜底点。
 */
describe('formatMessageForApi - DeepSeek thinking mode compliance', () => {
  describe('assistant 消息（纯文本）', () => {
    it('缺失 reasoning_content 时应补空串（TaskMemory L1/L2 压缩消息场景）', () => {
      const msg: AiMessage = { role: 'assistant', content: '已完成' }
      const out = formatMessageForApi(msg)
      expect(out).toMatchObject({ role: 'assistant', content: '已完成' })
      expect(out.reasoning_content).toBe('')
    })

    it('reasoning_content 为空串时应原样透传', () => {
      const msg: AiMessage = { role: 'assistant', content: '已完成', reasoning_content: '' }
      const out = formatMessageForApi(msg)
      expect(out.reasoning_content).toBe('')
    })

    it('reasoning_content 有值时应原样透传', () => {
      const msg: AiMessage = {
        role: 'assistant',
        content: '答案是 4',
        reasoning_content: '让我想想…1+1=2，再加 2…'
      }
      const out = formatMessageForApi(msg)
      expect(out.reasoning_content).toBe('让我想想…1+1=2，再加 2…')
    })

    it('content 为空时也应补 reasoning_content（防止 vLLM/思考模式联合误伤）', () => {
      const msg: AiMessage = { role: 'assistant', content: '' }
      const out = formatMessageForApi(msg)
      expect(out.content).toBe('[no response]')
      expect(out.reasoning_content).toBe('')
    })
  })

  describe('assistant 消息（带 tool_calls）', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }
    ]

    it('缺失 reasoning_content 时应补空串', () => {
      const msg: AiMessage = { role: 'assistant', content: '', tool_calls: toolCalls }
      const out = formatMessageForApi(msg)
      expect(out.tool_calls).toEqual(toolCalls)
      expect(out.reasoning_content).toBe('')
    })

    it('reasoning_content 为空串时应原样透传（避免 || 转 undefined 后字段丢失）', () => {
      const msg: AiMessage = {
        role: 'assistant',
        content: '',
        tool_calls: toolCalls,
        reasoning_content: ''
      }
      const out = formatMessageForApi(msg)
      expect(out.reasoning_content).toBe('')
    })

    it('reasoning_content 有值时应原样透传', () => {
      const msg: AiMessage = {
        role: 'assistant',
        content: '',
        tool_calls: toolCalls,
        reasoning_content: '我应该先看下文件'
      }
      const out = formatMessageForApi(msg)
      expect(out.reasoning_content).toBe('我应该先看下文件')
    })
  })

  describe('其他角色不应携带 reasoning_content', () => {
    it('user 消息不应有 reasoning_content', () => {
      const msg: AiMessage = { role: 'user', content: 'hi' }
      const out = formatMessageForApi(msg)
      expect(out).not.toHaveProperty('reasoning_content')
    })

    it('system 消息不应有 reasoning_content', () => {
      const msg: AiMessage = { role: 'system', content: 'You are a helpful assistant.' }
      const out = formatMessageForApi(msg)
      expect(out).not.toHaveProperty('reasoning_content')
    })

    it('system 消息应 strip 上下文组成归因标记', () => {
      const msg: AiMessage = {
        role: 'system',
        content: '<!--sf-ctx:identity-->\nHello\n\n<!--sf-ctx:rules-->\nRule',
      }
      const out = formatMessageForApi(msg)
      expect(out.content).toBe('Hello\n\nRule')
    })

    it('tool 消息不应有 reasoning_content', () => {
      const msg: AiMessage = {
        role: 'tool',
        content: 'tool output',
        tool_call_id: 'call_1'
      }
      const out = formatMessageForApi(msg)
      expect(out).toEqual({
        role: 'tool',
        content: 'tool output',
        tool_call_id: 'call_1'
      })
      expect(out).not.toHaveProperty('reasoning_content')
    })
  })

  describe('多模态 user 消息（视觉）', () => {
    const imgUrl = 'data:image/png;base64,iVBORw0KGgo='

    it('图片应转换为多模态 content 数组', () => {
      const msg: AiMessage = { role: 'user', content: '看下这张图', images: [imgUrl] }
      const out = formatMessageForApi(msg)
      expect(Array.isArray(out.content)).toBe(true)
      expect(out).not.toHaveProperty('reasoning_content')
    })

    it('stripImages=true 时应剥离图片走纯文本路径', () => {
      const msg: AiMessage = { role: 'user', content: '看下这张图', images: [imgUrl] }
      const out = formatMessageForApi(msg, true)
      expect(out.content).toBe('看下这张图')
    })

    it('不支持的图片格式应丢掉，走纯文本', () => {
      const msg: AiMessage = {
        role: 'user',
        content: '看图',
        images: ['data:image/x-emf;base64,AAAA']
      }
      const out = formatMessageForApi(msg)
      expect(out.content).toBe('看图')
    })

    it('混有合格与不合格图片时只发出合格的', () => {
      const msg: AiMessage = {
        role: 'user',
        content: '看图',
        images: ['data:image/x-emf;base64,AAAA', imgUrl]
      }
      const out = formatMessageForApi(msg)
      expect(Array.isArray(out.content)).toBe(true)
      const parts = out.content as Array<{ type: string; image_url?: { url: string } }>
      expect(parts.filter(p => p.type === 'image_url')).toHaveLength(1)
      expect(parts.find(p => p.type === 'image_url')?.image_url?.url).toBe(imgUrl)
    })
  })

  describe('回归场景：TaskMemory 压缩重建的纯文本 assistant 消息', () => {
    it('Level 1 压缩生成的消息（context-builder.getCompressedMessages）应被兜底补字段', () => {
      // 模拟 getCompressedMessages 的输出结构（仅 role+content，无 reasoning_content）
      const compressedMsg: AiMessage = {
        role: 'assistant',
        content: '**执行摘要:**\n[read_file] /tmp/foo\n→ ...内容...\n\n已读取完毕'
      }
      const out = formatMessageForApi(compressedMsg)
      expect(out.reasoning_content).toBe('')
    })

    it('Level 2 简化消息（context-builder.getSimplifiedMessages）应被兜底补字段', () => {
      const simplifiedMsg: AiMessage = {
        role: 'assistant',
        content: '已完成检查，没有发现问题'
      }
      const out = formatMessageForApi(simplifiedMsg)
      expect(out.reasoning_content).toBe('')
    })
  })
})


it('内部用户上下文来源片段不发给模型API，主消息正文保持原样',()=>{
  const out=formatMessageForApi({role:'user',content:'主模型完整正文',_systemInjected:true,_userContextParts:[{start:0,end:3}]})
  expect(out).toEqual({role:'user',content:'主模型完整正文'})
})


it('插件provider也不接收本地来源元数据，正文和图片保持，原消息不被改写',async()=>{
  const profile={id:'fixture',name:'fixture',apiUrl:'http://fixture',apiKey:'x',model:'fixture'}
  const ai=new AiService({getAiProfiles:()=>[profile],getActiveAiProfile:()=>profile.id} as never)
  const provider=vi.fn(async(_params:unknown)=>({content:'ok'}))
  ai.setPluginProviders([{id:'fixture',name:'fixture',match:()=>true,chatWithTools:provider}])
  const original:AiMessage={role:'user',content:'完整正文',images:['image-original'],_systemInjected:true,_userContextParts:[{start:0,end:3}]}
  await ai.chatWithTools([original],[])
  expect(provider).toHaveBeenCalledWith(expect.objectContaining({messages:[{role:'user',content:'完整正文',images:['image-original'],_systemInjected:true}]}))
  expect(original._userContextParts).toEqual([{start:0,end:3}])
})
