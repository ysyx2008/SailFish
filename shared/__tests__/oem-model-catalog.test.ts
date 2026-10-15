import { describe, expect, it } from 'vitest'
import type { AiProfile } from '@shared/types'
import {
  applyOemCatalog,
  bundledRequestAuth,
  parseOemCatalogDocument,
  profileIdForCatalog,
} from '../oem-model-catalog'

const document = {
  models: [
    {
      id: 'chat',
      name: '公司对话',
      apiUrl: 'https://llm.example/v1/chat/completions',
      model: 'corp-chat',
      kind: 'text',
      vision: 'see',
    },
    {
      id: 'see',
      name: '公司视觉',
      apiUrl: 'https://llm.example/v1/chat/completions',
      model: 'corp-vision',
      kind: 'vision',
    },
    { id: 'bad', name: '', apiUrl: 'https://llm.example/v1', model: 'x', kind: 'text' },
  ],
}

function userProfile(): AiProfile {
  return {
    id: 'user-1',
    name: '我自己的',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    apiKey: 'sk-user',
    model: 'gpt-4o',
  }
}

describe('parseOemCatalogDocument', () => {
  it('收下能用的条目，丢掉写坏的，文本模型记下该用哪条视觉', () => {
    const items = parseOemCatalogDocument(document)
    expect(items.map(item => item.id)).toEqual(['chat', 'see'])
    expect(items[0].vision).toBe('see')
    expect(items[0].kind).toBe('text')
  })

  it('一条都没有就当作没取到', () => {
    expect(() => parseOemCatalogDocument({ models: [] })).toThrow()
    expect(() => parseOemCatalogDocument({ models: [{ id: 'x' }] })).toThrow()
  })

  it('视觉编号对不上文本模型时，这条仍留下，只是不切换', () => {
    const items = parseOemCatalogDocument({
      models: [{
        id: 'chat',
        name: '公司对话',
        apiUrl: 'https://llm.example/v1/chat/completions',
        model: 'corp-chat',
        kind: 'text',
        vision: 'missing',
      }],
    })
    expect(items[0].vision).toBeUndefined()
  })
})

describe('applyOemCatalog', () => {
  it('从没配过时放进去，第一条文本模型当作当前默认', () => {
    const result = applyOemCatalog([], '', parseOemCatalogDocument(document))
    expect(result.profiles.map(profile => profile.id)).toEqual(['oem:chat', 'oem:see'])
    expect(result.activeId).toBe('oem:chat')
    expect(result.profiles[0].modelType).toBe('general')
    expect(result.profiles[0].visionProfileId).toBe(profileIdForCatalog('see'))
    expect(result.profiles[0].apiKey).toBe('')
    expect(result.profiles[1].modelType).toBe('vision')
  })

  it('已经有自己的模型时，公司的照样放进来，不改他选中的，也不动他自己的', () => {
    const mine = userProfile()
    const first = applyOemCatalog([mine], 'user-1', parseOemCatalogDocument(document))
    expect(first.profiles.map(profile => profile.id)).toEqual(['oem:chat', 'oem:see', 'user-1'])
    expect(first.activeId).toBe('user-1')
    expect(first.profiles[2]).toEqual(mine)
    const again = applyOemCatalog(first.profiles, first.activeId, parseOemCatalogDocument({
      models: [
        ...document.models,
        { id: 'new', name: '新的', apiUrl: 'https://llm.example/v1/chat/completions', model: 'new', kind: 'text' },
      ],
    }))
    expect(again.profiles.map(profile => profile.id)).toEqual(['oem:chat', 'oem:see', 'oem:new', 'user-1'])
    expect(again.activeId).toBe('user-1')
    expect(again.profiles[3]).toEqual(mine)
  })

  it('公司模型跟着清单变，自己的模型保持原样', () => {
    const seeded = applyOemCatalog([userProfile()], 'user-1', parseOemCatalogDocument(document))
    const renamed = parseOemCatalogDocument(document)
    renamed[0] = { ...renamed[0], name: '公司对话（新）' }
    const again = applyOemCatalog(seeded.profiles, seeded.activeId, renamed)
    expect(again.profiles[0].name).toBe('公司对话（新）')
    expect(again.profiles[2].name).toBe('我自己的')
    expect(again.activeId).toBe('user-1')
  })

  it('清单里拿掉的公司模型会去掉，自己的还在', () => {
    const seeded = applyOemCatalog([userProfile()], 'user-1', parseOemCatalogDocument(document))
    const onlyChat = parseOemCatalogDocument({
      models: [{
        id: 'chat',
        name: '公司对话',
        apiUrl: 'https://llm.example/v1/chat/completions',
        model: 'corp-chat',
        kind: 'text',
      }],
    })
    const again = applyOemCatalog(seeded.profiles, 'oem:see', onlyChat)
    expect(again.profiles.map(profile => profile.id)).toEqual(['oem:chat', 'user-1'])
    expect(again.profiles[0].visionProfileId).toBeUndefined()
    expect(again.activeId).toBe('oem:chat')
  })
})

describe('bundledRequestAuth', () => {
  it('没填钥匙且清单要求登录时带上这个人的令牌', () => {
    expect(bundledRequestAuth({ oemCatalogId: 'chat', apiKey: '' }, 'login', 'token-1')).toEqual({
      type: 'bearer',
      token: 'token-1',
    })
  })

  it('不验钥匙就不带凭证；用户自己填了钥匙就仍走原来的请求', () => {
    expect(bundledRequestAuth({ oemCatalogId: 'chat', apiKey: '' }, 'none', null)).toEqual({ type: 'omit' })
    expect(bundledRequestAuth({ oemCatalogId: 'chat', apiKey: 'sk' }, 'login', 'token-1')).toEqual({ type: 'passthrough' })
    expect(bundledRequestAuth({ apiKey: '' }, 'login', 'token-1')).toEqual({ type: 'passthrough' })
  })
})
