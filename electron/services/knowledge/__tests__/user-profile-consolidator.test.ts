import { describe, expect, it } from 'vitest'
import { UserProfileConsolidator, stripOuterFence } from '../user-profile-consolidator'

function setup(opts: { legacy?: string; current?: string; max?: number; replies?: Array<string | Error | { text: string; complete: false }>; outputLimit?: number; onChat?: () => void; diskFails?: boolean }) {
  const docs = new Map<string, string>()
  const disk = new Map<string, string>()
  if (opts.current) { docs.set('personal', opts.current); disk.set('personal', opts.current) }
  const backups: Array<[string, string]> = []
  const state = { archived: false, chats: 0, prompts: [] as string[], tokens: [] as number[] }
  const replies = [...(opts.replies ?? [])]
  const consolidator = new UserProfileConsolidator({
    readLegacyProfile: () => (state.archived ? '' : opts.legacy ?? ''),
    archiveLegacyProfile: () => { state.archived = true },
    saveBackup: (name, content) => { backups.push([name, content]) },
    memory: {
      getDocument: id => docs.get(id) ?? '',
      setDocument: (id, content) => { docs.set(id, content); if (!opts.diskFails) disk.set(id, content) },
      getPersistedDocument: id => disk.get(id) ?? null,
      getMaxDocChars: () => opts.max ?? 100,
    },
    getOutputLimit: () => opts.outputLimit ?? 100000,
    chat: async (messages, maxOutputTokens) => {
      state.tokens.push(maxOutputTokens)
      state.chats++
      opts.onChat?.()
      state.prompts.push(messages[0].content)
      const next = replies.shift()
      if (next instanceof Error) throw next
      if (typeof next === 'string' || next === undefined) return { text: next ?? '', complete: true }
      return next
    },
  })
  return { consolidator, docs, backups, state }
}

describe('旧用户画像并入记忆', () => {
  it('没有旧画像就什么都不做', async () => {
    const { consolidator, state } = setup({ legacy: '  ' })
    expect(await consolidator.run()).toBe('none')
    expect(state.chats).toBe(0)
  })

  it('记忆里还没有用户这一份：旧画像直接成为它，不问模型', async () => {
    const { consolidator, docs, state, backups } = setup({ legacy: '他叫小王' })
    expect(await consolidator.run()).toBe('merged')
    expect(docs.get('personal')).toBe('他叫小王')
    expect(state.chats).toBe(0)
    expect(state.archived).toBe(true)
    expect(backups).toEqual([['USER.md', '他叫小王']])
  })

  it('两份都有：让模型整合，成功后两份原文留底、旧文件收起', async () => {
    const { consolidator, docs, state, backups } = setup({
      legacy: '旧画像', current: '现有记忆', replies: ['## 身份\n他叫小王'],
    })
    expect(await consolidator.run()).toBe('merged')
    expect(docs.get('personal')).toBe('## 身份\n他叫小王')
    expect(state.archived).toBe(true)
    expect(backups).toEqual([['USER.md', '旧画像'], ['personal.md', '现有记忆']])
    expect(state.prompts[0]).toContain('现有记忆')
    expect(state.tokens[0]).toBeGreaterThan(100)
    expect(state.prompts[0]).toContain('旧画像')
  })

  it('第一次超限，第二次带上超出的字数重来', async () => {
    const { consolidator, docs, state } = setup({
      legacy: 'a', current: 'b', max: 10, replies: ['x'.repeat(15), 'ok'],
    })
    expect(await consolidator.run()).toBe('merged')
    expect(docs.get('personal')).toBe('ok')
    expect(state.prompts[1]).toContain('超出上限 5 字')
  })

  it('两次都超限：什么都不动', async () => {
    const { consolidator, docs, state, backups } = setup({
      legacy: 'a', current: 'b', max: 10, replies: ['x'.repeat(15), 'y'.repeat(20)],
    })
    expect(await consolidator.run()).toBe('failed')
    expect(docs.get('personal')).toBe('b')
    expect(state.archived).toBe(false)
    expect(backups).toEqual([])
  })

  it('回复被截断：即使没超限也不能当结果', async () => {
    const { consolidator, docs, state } = setup({
      legacy: 'a', current: 'b', max: 100,
      replies: [{ text: '只有前半', complete: false }, { text: '还是前半', complete: false }],
    })
    expect(await consolidator.run()).toBe('failed')
    expect(docs.get('personal')).toBe('b')
    expect(state.archived).toBe(false)
  })

  it('模型出错：什么都不动，下次还能再来', async () => {
    const { consolidator, docs, state } = setup({
      legacy: 'a', current: 'b', replies: [new Error('没有可用模型')],
    })
    expect(await consolidator.run()).toBe('failed')
    expect(docs.get('personal')).toBe('b')
    expect(state.archived).toBe(false)
  })

  it('成功后再跑不会重复并入', async () => {
    const { consolidator, state } = setup({ legacy: 'a', current: 'b', replies: ['合成'] })
    expect(await consolidator.run()).toBe('merged')
    expect(await consolidator.run()).toBe('none')
    expect(state.chats).toBe(1)
  })

  it('整合期间记忆被更新过：结果作废，不覆盖', async () => {
    let docsRef: Map<string, string> | undefined
    const { consolidator, docs, state } = setup({
      legacy: 'a', current: 'b', replies: ['合成'],
      onChat: () => { docsRef?.set('personal', '对话后刚更新的记忆') },
    })
    docsRef = docs
    expect(await consolidator.run()).toBe('failed')
    expect(docs.get('personal')).toBe('对话后刚更新的记忆')
    expect(state.archived).toBe(false)
  })

  it('结果没能写到磁盘：旧画像不收起来，留到下次', async () => {
    const { consolidator, state } = setup({ legacy: 'a', current: 'b', replies: ['合成'], diskFails: true })
    expect(await consolidator.run()).toBe('failed')
    expect(state.archived).toBe(false)
  })

  it('记忆里没有用户这一份、旧画像又超上限：照样让模型压缩', async () => {
    const { consolidator, docs, state } = setup({ legacy: 'x'.repeat(30), max: 10, replies: ['压缩后'] })
    expect(await consolidator.run()).toBe('merged')
    expect(docs.get('personal')).toBe('压缩后')
    expect(state.chats).toBe(1)
  })

  it('要的输出额度不超过模型上限', async () => {
    const { consolidator, state } = setup({ legacy: 'a', current: 'b', replies: ['ok'], outputLimit: 3000 })
    await consolidator.run()
    expect(state.tokens[0]).toBe(3000)
  })

  it('只剥最外层代码块', () => {
    expect(stripOuterFence('```markdown\n## 标题\n正文\n```')).toBe('## 标题\n正文')
    expect(stripOuterFence('## 标题\n```js\nx\n```')).toBe('## 标题\n```js\nx\n```')
  })
})
