import { describe, it, expect } from 'vitest'
import { AI_TEMPLATES, isProfileOfTemplate } from '../ai-templates'

const tpl = (name: string) => {
  const found = AI_TEMPLATES.find(t => t.name === name)
  if (!found) throw new Error(`没有模板 ${name}`)
  return found
}

describe('isProfileOfTemplate：按服务地址判断某个配置属于哪个模板', () => {
  it('同一家服务，地址里带不带 /v1 都算', () => {
    expect(isProfileOfTemplate({ apiUrl: 'https://api.deepseek.com/v1/chat/completions' }, tpl('DeepSeek'))).toBe(true)
    expect(isProfileOfTemplate({ apiUrl: 'https://api.deepseek.com/chat/completions' }, tpl('DeepSeek'))).toBe(true)
  })

  it('配置改了名、换了模型，仍然认得出是哪家', () => {
    // 判断只看地址：名字和模型不在入参里，传了也不影响
    expect(isProfileOfTemplate({ apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' }, tpl('Zhipu'))).toBe(true)
    expect(isProfileOfTemplate({ apiUrl: 'https://api.moonshot.cn/v1/chat/completions' }, tpl('Kimi'))).toBe(true)
  })

  it('Anthropic 原生接口也认', () => {
    expect(isProfileOfTemplate({ apiUrl: 'https://api.anthropic.com/v1/messages' }, tpl('Claude'))).toBe(true)
  })

  it('同一个平台下不同的接口路径不混为一谈（火山的通用接口 vs 套餐接口）', () => {
    const plan = { apiUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions' }
    expect(isProfileOfTemplate(plan, tpl('Doubao'))).toBe(false)
    expect(isProfileOfTemplate({ apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions' }, tpl('Doubao'))).toBe(true)
  })

  it('尾部斜杠和主机名大小写不影响', () => {
    expect(isProfileOfTemplate({ apiUrl: 'https://API.DeepSeek.com/v1/chat/completions/' }, tpl('DeepSeek'))).toBe(true)
  })

  it('私有部署、别家服务不算', () => {
    expect(isProfileOfTemplate({ apiUrl: 'http://60.166.4.238:16147/v1/chat/completions' }, tpl('DeepSeek'))).toBe(false)
    expect(isProfileOfTemplate({ apiUrl: 'https://api.openai.com/v1/chat/completions' }, tpl('DeepSeek'))).toBe(false)
  })

  it('没有地址的（自定义项、空配置）永远不算已配置', () => {
    expect(isProfileOfTemplate({ apiUrl: '' }, { apiUrl: '' })).toBe(false)
    expect(isProfileOfTemplate({ apiUrl: 'https://api.deepseek.com/chat/completions' }, { apiUrl: '' })).toBe(false)
    expect(isProfileOfTemplate({ apiUrl: '' }, tpl('DeepSeek'))).toBe(false)
  })

  it('预设模板彼此的地址互不相同，不会一个配置同时算作两家', () => {
    for (const a of AI_TEMPLATES) {
      const hits = AI_TEMPLATES.filter(b => isProfileOfTemplate(a, b)).map(b => b.name)
      expect(hits).toEqual([a.name])
    }
  })
})
