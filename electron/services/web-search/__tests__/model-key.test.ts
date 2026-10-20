import { describe, expect, it } from 'vitest'
import { webSearchKeyFromModelProfiles } from '@shared/types'

const zhipu = {
  id: 'z1',
  apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  apiKey: 'zhipu-key',
}
const kimi = {
  id: 'k1',
  apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
  apiKey: 'kimi-key',
}

const deepseek = {
  id: 'd1',
  apiUrl: 'https://api.deepseek.com/chat/completions',
  apiKey: 'deepseek-key',
}

describe('webSearchKeyFromModelProfiles', () => {
  it('reuses the key of a matching model profile', () => {
    expect(webSearchKeyFromModelProfiles('zhipu', [kimi, zhipu], 'k1')).toBe('zhipu-key')
    expect(webSearchKeyFromModelProfiles('kimi', [zhipu, kimi], 'z1')).toBe('kimi-key')
    expect(webSearchKeyFromModelProfiles('deepseek', [zhipu, kimi, deepseek], 'z1')).toBe('deepseek-key')
  })

  it('does not hand a DeepSeek key to other vendors, nor other vendors keys to DeepSeek', () => {
    expect(webSearchKeyFromModelProfiles('zhipu', [deepseek], 'd1')).toBe('')
    expect(webSearchKeyFromModelProfiles('kimi', [deepseek], 'd1')).toBe('')
    expect(webSearchKeyFromModelProfiles('deepseek', [zhipu, kimi], 'z1')).toBe('')
  })

  it('prefers the model that is currently in use when several match', () => {
    const other = { ...zhipu, id: 'z2', apiKey: 'other-zhipu' }
    expect(webSearchKeyFromModelProfiles('zhipu', [zhipu, other], 'z2')).toBe('other-zhipu')
  })

  it('does not guess from the name, and skips vendors that do not share a key', () => {
    const named = { id: 'n', apiUrl: 'https://example.com/v1', apiKey: 'nope', name: 'Zhipu' }
    expect(webSearchKeyFromModelProfiles('zhipu', [named], 'n')).toBe('')
    expect(webSearchKeyFromModelProfiles('bocha', [zhipu], 'z1')).toBe('')
    expect(webSearchKeyFromModelProfiles('zhipu', [{ ...zhipu, apiKey: '  ' }], 'z1')).toBe('')
  })
})
