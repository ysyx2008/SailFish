/**
 * 专家团群聊全文：追加、按位置翻页（往前、往后）、路径只认存储里的、跟着会话删。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ExpertTeamMessageView } from '@shared/types'
import { ExpertTeamChatStore } from '../expert-team-chat-store'

let root: string
let store: ExpertTeamChatStore

function message(seq: number, text = `第 ${seq} 条`): ExpertTeamMessageView {
  return { seq, from: seq % 2 ? '写需求' : '写代码', to: ['组长'], text, at: 1000 + seq }
}

/** 从末尾一页一页往前读到头 */
function readAllBackward(file: string): { seqs: number[]; pages: number } {
  const seqs: number[] = []
  let page = store.read(file)!
  let pages = 1
  seqs.unshift(...page.messages.map(m => m.seq))
  while (page.hasEarlier) {
    page = store.read(file, { before: page.start })!
    pages++
    seqs.unshift(...page.messages.map(m => m.seq))
  }
  return { seqs, pages }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-chat-'))
  store = new ExpertTeamChatStore(path.join(root, 'expert-teams'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('专家团群聊全文', () => {
  it('按会话和开团那天放，名字和会话号不能当路径用时不开', () => {
    const at = Date.UTC(2026, 9, 22, 3)
    expect(store.create('sess_1', 'run-team-小工具组', at)).toBe('2026-10-22/sess_1/run-team-小工具组.jsonl')
    expect(store.create('../x', 'team', at)).toBeUndefined()
    expect(store.create('sess_1', 'a/b', at)).toBeUndefined()
  })

  it('文件不在就读不到，界面改用派出那一步里的那一小段', () => {
    expect(store.read(store.create('sess_1', 'team')!)).toBeNull()
  })

  it('上次写到一半断了：先补换行再写；重写的同一批读出来不重复', () => {
    const file = store.create('sess_1', 'team')!
    const abs = path.join(root, 'expert-teams', file)
    store.append(file, [message(1)])
    fs.appendFileSync(abs, JSON.stringify(message(2)) + '\n' + JSON.stringify(message(3)).slice(0, 8))
    store.append(file, [message(2), message(3)])
    store.append(file, [message(4)])

    const latest = store.read(file)!
    expect(latest.messages.map(m => m.seq)).toEqual([1, 2, 3, 4])
    expect(store.read(file, { after: 0 })!.messages.map(m => m.seq)).toEqual([1, 2, 3, 4])
  })

  it('读末尾一页；往前翻一页页接上，不重不漏', () => {
    const file = store.create('sess_1', 'team')!
    const all = Array.from({ length: 130 }, (_, i) => message(i + 1))
    store.append(file, all.slice(0, 70))
    store.append(file, all.slice(70))

    const latest = store.read(file)!
    expect(latest.messages).toHaveLength(50)
    expect(latest.messages.at(-1)!.seq).toBe(130)
    expect(latest.hasEarlier).toBe(true)
    expect(latest.path).toBe(path.join(root, 'expert-teams', file))

    const { seqs, pages } = readAllBackward(file)
    expect(seqs).toEqual(all.map(m => m.seq))
    expect(pages).toBe(3)
  })

  it('跨读块的长消息和多字节字符照样完整', () => {
    const file = store.create('sess_1', 'team')!
    const all = Array.from({ length: 40 }, (_, i) => message(i + 1, `${'需求文档🙂'.repeat(500)}#${i + 1}`))
    store.append(file, all)
    const { seqs } = readAllBackward(file)
    expect(seqs).toEqual(all.map(m => m.seq))
    const page = store.read(file)!
    expect(page.messages.at(-1)!.text).toBe(all.at(-1)!.text)
  })

  it('一页字数满了就停，单条再长也至少给一条', () => {
    const file = store.create('sess_1', 'team')!
    store.append(file, [message(1, 'a'.repeat(40000)), message(2, 'b'.repeat(40000))])
    const latest = store.read(file)!
    expect(latest.messages.map(m => m.seq)).toEqual([2])
    expect(latest.hasEarlier).toBe(true)
    expect(store.read(file, { before: latest.start })!.messages.map(m => m.seq)).toEqual([1])
  })

  it('单条超过 10 万字只给前面一段，记下没给的字数', () => {
    const file = store.create('sess_1', 'team')!
    store.append(file, [message(1, 'x'.repeat(100005))])
    const [m] = store.read(file)!.messages
    expect(m.text).toHaveLength(100000)
    expect(m.omitted).toBe(5)
  })

  it('往后补：从上次读到的位置接着读新写进来的', () => {
    const file = store.create('sess_1', 'team')!
    store.append(file, [message(1), message(2)])
    const first = store.read(file)!
    store.append(file, [message(3)])
    store.append(file, Array.from({ length: 60 }, (_, i) => message(i + 4)))

    const next = store.read(file, { after: first.end })!
    expect(next.messages.map(m => m.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 3))
    expect(next.hasLater).toBe(true)
    const rest = store.read(file, { after: next.end })!
    expect(rest.messages.map(m => m.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 53))
    expect(rest.hasLater).toBe(false)
    expect(store.read(file, { after: rest.end })!.messages).toEqual([])
  })

  it('末尾一行还没写完的不读，写完后往后补能读到', () => {
    const file = store.create('sess_1', 'team')!
    store.append(file, [message(1)])
    const abs = path.join(root, 'expert-teams', file)
    const line = JSON.stringify(message(2))
    fs.appendFileSync(abs, line.slice(0, 10))

    const latest = store.read(file)!
    expect(latest.messages.map(m => m.seq)).toEqual([1])
    expect(store.read(file, { after: latest.end })!.messages).toEqual([])

    fs.appendFileSync(abs, line.slice(10) + '\n')
    expect(store.read(file, { after: latest.end })!.messages.map(m => m.seq)).toEqual([2])
  })

  it('只认存储里的群聊文件', () => {
    store.append(store.create('sess_1', 'team')!, [message(1)])
    expect(store.read('../../etc/passwd')).toBeNull()
    expect(store.read('2026-10-22/sess_1/../../../x.jsonl')).toBeNull()
    expect(store.read('2026-10-22/sess_1/team.md')).toBeNull()
    expect(store.append('../x.jsonl', [message(1)])).toBe(false)
  })

  it('删会话删它的群聊；按天清理删开团日期早于期限的；清空全删', () => {
    const old = store.create('sess_old', 'team', Date.UTC(2026, 0, 1))!
    const keep = store.create('sess_keep', 'team', Date.UTC(2026, 9, 22))!
    const gone = store.create('sess_gone', 'team', Date.UTC(2026, 9, 22))!
    for (const f of [old, keep, gone]) store.append(f, [message(1)])

    store.deleteSession('sess_gone')
    expect(store.read(gone)).toBeNull()
    expect(store.read(keep)!.messages).toHaveLength(1)

    store.deleteBefore('2026-06-01')
    expect(store.read(old)).toBeNull()
    expect(store.read(keep)!.messages).toHaveLength(1)

    store.deleteAll()
    expect(store.read(keep)).toBeNull()
  })

  it('会话已经不在的群聊删掉；最近还写过的先留着', () => {
    const orphan = store.create('sess_orphan', 'team', Date.UTC(2026, 9, 20))!
    const fresh = store.create('sess_fresh', 'team', Date.UTC(2026, 9, 22))!
    const live = store.create('sess_live', 'team', Date.UTC(2026, 9, 20))!
    for (const f of [orphan, fresh, live]) store.append(f, [message(1)])
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    for (const id of ['sess_orphan', 'sess_live']) fs.utimesSync(path.join(root, 'expert-teams', '2026-10-20', id), old, old)

    store.deleteOrphans(new Set(['sess_live']))
    expect(store.read(orphan)).toBeNull()
    expect(store.read(fresh)!.messages).toHaveLength(1)
    expect(store.read(live)!.messages).toHaveLength(1)
  })
})
