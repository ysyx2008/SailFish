import { describe, it, expect } from 'vitest'
import type { ExpertTeamChatCursor, ExpertTeamChatPage, ExpertTeamMessageView } from '@shared/types'
import { ExpertTeamChatPages } from './expert-team-chat-pages'

/** 假文件：位置就是条数，一页 size 条 */
function fakeFile(size = 3) {
  const lines: ExpertTeamMessageView[] = []
  const reads: ExpertTeamChatCursor[] = []
  const add = (count: number) => {
    for (let i = 0; i < count; i++) {
      const seq = lines.length + 1
      lines.push({ seq, from: '写需求', to: ['写代码'], text: `第 ${seq} 条`, at: seq })
    }
  }
  const read = async (_file: string, cursor: ExpertTeamChatCursor): Promise<ExpertTeamChatPage | null> => {
    reads.push(cursor)
    const page = (start: number, end: number): ExpertTeamChatPage => ({
      messages: lines.slice(start, end), start, end,
      hasEarlier: start > 0, hasLater: end < lines.length, path: '/data/team.jsonl',
    })
    if (cursor.after !== undefined) return page(cursor.after, Math.min(lines.length, cursor.after + size))
    const end = cursor.before ?? lines.length
    return page(Math.max(0, end - size), end)
  }
  return { add, read, reads }
}

const seqs = (p: ExpertTeamChatPages) => p.messages.map(m => m.seq)

describe('群聊全文翻页', () => {
  it('先读末尾一页，往前翻接到开头', async () => {
    const file = fakeFile()
    file.add(7)
    const pages = new ExpertTeamChatPages('f.jsonl', file.read)
    await pages.loadLatest()
    expect(seqs(pages)).toEqual([5, 6, 7])
    expect(pages.hasEarlier).toBe(true)
    expect(pages.path).toBe('/data/team.jsonl')

    expect(await pages.loadEarlier()).toBe(3)
    expect(await pages.loadEarlier()).toBe(1)
    expect(seqs(pages)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(pages.hasEarlier).toBe(false)
    expect(await pages.loadEarlier()).toBe(0)
  })

  it('有新消息往后补，一页装不下接着读', async () => {
    const file = fakeFile()
    file.add(2)
    const pages = new ExpertTeamChatPages('f.jsonl', file.read)
    await pages.loadLatest()
    file.add(5)
    expect(await pages.loadNewer()).toBe(5)
    expect(seqs(pages)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(await pages.loadNewer()).toBe(0)
  })

  it('同时发起的读取按先后排队，不重不漏', async () => {
    const file = fakeFile()
    file.add(6)
    const pages = new ExpertTeamChatPages('f.jsonl', file.read)
    const latest = pages.loadLatest()
    file.add(1)
    const [, , older] = await Promise.all([latest, pages.loadNewer(), pages.loadEarlier()])
    expect(older).toBe(3)
    expect(seqs(pages)).toEqual([2, 3, 4, 5, 6, 7])
    expect(file.reads).toEqual([{}, { after: 7 }, { before: 4 }])
  })

  it('正在往前读时再触发一次不重复读', async () => {
    const file = fakeFile()
    file.add(9)
    const pages = new ExpertTeamChatPages('f.jsonl', file.read)
    await pages.loadLatest()
    const [a, b] = await Promise.all([pages.loadEarlier(), pages.loadEarlier()])
    expect([a, b]).toEqual([3, 0])
    expect(file.reads).toEqual([{}, { before: 6 }])
  })

  it('打开时读不到就算失败，之后补读失败不影响', async () => {
    const broken = new ExpertTeamChatPages('f.jsonl', async () => null)
    await broken.loadLatest()
    expect(broken.failed).toBe(true)
    expect(broken.loaded).toBe(false)

    const file = fakeFile()
    file.add(2)
    let fail = false
    const pages = new ExpertTeamChatPages('f.jsonl', async (f, c) => {
      if (fail) throw new Error('ipc')
      return file.read(f, c)
    })
    await pages.loadLatest()
    fail = true
    expect(await pages.loadNewer()).toBe(0)
    expect(pages.failed).toBe(false)
    expect(seqs(pages)).toEqual([1, 2])
  })
})
