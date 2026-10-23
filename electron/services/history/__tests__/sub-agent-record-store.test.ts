/**
 * 伙计和专家的对话记录：存在主会话下面，追加写、崩溃后不重复，不进最近对话和历史搜索，跟着会话删。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AgentRecord } from '@shared/types'
import type { AiMessage } from '../../ai.service'
import { AgentRecordStore } from '../agent-record-store'
import { childDirName, SubAgentRecordStore, type ChildStateInput } from '../sub-agent-record-store'

const AT = Date.UTC(2026, 9, 23, 3)
const DAY = '2026-10-23'

let root: string
let store: SubAgentRecordStore

function state(name: string, extra: Partial<ChildStateInput> = {}): ChildStateInput {
  return { name, description: `${name} 的活`, prompt: `去干 ${name}`, status: 'running', ...extra }
}

function record(id: string, messageCount: number, stepCount = messageCount): AgentRecord {
  return {
    id,
    timestamp: AT,
    terminalId: '',
    agentKey: `parent:sub:${id}`,
    terminalType: 'assistant',
    userTask: '第一句',
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `s${i}`, type: i === 0 ? 'user_task' : 'final_result', content: `步骤 ${i}`, timestamp: AT + i,
    })) as AgentRecord['steps'],
    messages: Array.from({ length: messageCount }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `消息 ${i}`,
    })) as AgentRecord['messages'],
    duration: 1,
    status: 'completed',
  }
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-agent-records-'))
  store = new SubAgentRecordStore(path.join(root, 'sub-agents'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('存放位置', () => {
  it('放在主会话下面，日期是主会话开始那天；会话号或名字不能当路径用时这位就不存', () => {
    const recorder = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    expect(recorder.dir).toBe(path.join(root, 'sub-agents', DAY, 'sess_1', childDirName('alice')))
    expect(store.recorderFor({ sessionId: '../x', startedAt: AT, name: 'alice' })).toBeUndefined()
    expect(store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: '  ' })).toBeUndefined()
  })

  it('只差大小写的两个名字不会落进同一个目录（文件系统可能不分大小写）', () => {
    expect(childDirName('Alice').toLowerCase()).not.toBe(childDirName('alice').toLowerCase())
  })

  it('名字里的中文、符号都能放，目录名只留能当路径用的字', () => {
    const dir = childDirName('读 nginx/配置')
    expect(dir).toMatch(/^[\p{L}\p{N}_-]+$/u)
    expect(dir.startsWith('读nginx配置-')).toBe(true)
  })
})

describe('样子和对话', () => {
  it('存下来的样子（状态、结果、错误）和对话都能读回来', () => {
    const recorder = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    recorder.saveState(state('alice', { status: 'completed', result: '端口是 8848', role: '测试专家' }))
    recorder.saveRecord(record('alice', 4))

    const [child] = store.list('sess_1')
    expect(child.state).toMatchObject({ name: 'alice', status: 'completed', result: '端口是 8848', role: '测试专家', description: 'alice 的活' })
    const restored = store.readRecord(child)!
    expect(restored.messages).toHaveLength(4)
    expect(restored.steps).toHaveLength(4)
  })

  it('每轮检查点只追加新增的，不重复写', () => {
    const recorder = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    recorder.saveRecord(record('alice', 2))
    recorder.saveRecord(record('alice', 4))
    recorder.saveRecord(record('alice', 4))
    recorder.saveRecord(record('alice', 6))
    expect(lines(path.join(recorder.dir, 'messages.jsonl'))).toHaveLength(6)
    expect(lines(path.join(recorder.dir, 'steps.jsonl'))).toHaveLength(6)
  })

  it('写到一半断了（正文追加了、meta 没写）：重开后接着写不重复', () => {
    const recorder = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    recorder.saveState(state('alice'))
    recorder.saveRecord(record('alice', 2))
    fs.appendFileSync(path.join(recorder.dir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: '消息 2' }) + '\n')

    const [child] = store.list('sess_1')
    const reopened = store.recorderForRestored({ sessionId: 'sess_1', startedAt: AT, name: 'alice' }, child.state)!
    reopened.saveRecord(record('alice', 4))
    expect(lines(path.join(reopened.dir, 'messages.jsonl'))).toHaveLength(4)
    expect(store.readRecord(child)!.messages!.map(m => m.content)).toEqual(['消息 0', '消息 1', '消息 2', '消息 3'])
  })

  it('被叫起来接着干的这位有了新的存盘人，旧的不再写', () => {
    const first = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    first.saveState(state('alice'))
    first.saveRecord(record('alice', 2))
    const [child] = store.list('sess_1')
    store.recorderForRestored({ sessionId: 'sess_1', startedAt: AT, name: 'alice' }, child.state)!.saveRecord(record('alice', 4))
    first.saveRecord(record('alice', 6))
    first.saveState(state('alice', { status: 'failed' }))
    expect(store.readRecord(child)!.messages).toHaveLength(4)
    expect(store.list('sess_1')[0].state.status).not.toBe('failed')
  })

  it('一场会话里的几位各存各的', () => {
    for (const name of ['alice', 'bob']) {
      const r = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name })!
      r.saveState(state(name))
      r.saveRecord(record(name, 2))
    }
    store.recorderFor({ sessionId: 'sess_2', startedAt: AT, name: 'carol' })!.saveState(state('carol'))
    expect(store.list('sess_1').map(c => c.state.name).sort()).toEqual(['alice', 'bob'])
    expect(store.list('sess_2').map(c => c.state.name)).toEqual(['carol'])
    expect(store.list('sess_none')).toEqual([])
  })

  it('没记录结果的调用写进样子；再次在干时不再带着', () => {
    const recorder = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    recorder.saveState(state('alice'))
    recorder.noteInterruptedCalls([{ tool: 'write_text_file', target: '/tmp/a.md' }])
    recorder.saveState(state('alice', { status: 'interrupted', error: '已打断' }))
    expect(store.list('sess_1')[0].state.interruptedCalls).toEqual([{ tool: 'write_text_file', target: '/tmp/a.md' }])

    recorder.saveState(state('alice', { status: 'running' }))
    expect(store.list('sess_1')[0].state.interruptedCalls).toBeUndefined()
  })

  it('样子文件损坏的那位跳过，其他照读', () => {
    const good = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    good.saveState(state('alice'))
    const bad = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'bob' })!
    bad.saveState(state('bob'))
    fs.writeFileSync(path.join(bad.dir, 'state.json'), '{坏')
    expect(store.list('sess_1').map(c => c.state.name)).toEqual(['alice'])
  })
})

describe('开局带的主人对话', () => {
  const seed: AiMessage[] = [
    { role: 'user', content: '查 nginx' },
    { role: 'assistant', content: '好' },
  ]

  it('内容相同的只存一份，读得回来', () => {
    const a = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    const b = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'bob' })!
    a.noteOpening(seed)
    b.noteOpening(seed.map(m => ({ ...m })))
    a.saveState(state('alice'))
    b.saveState(state('bob'))
    const dir = path.join(root, 'sub-agents', DAY, 'sess_1', '_openings')
    expect(fs.readdirSync(dir)).toHaveLength(1)
    const [first, second] = store.list('sess_1')
    expect(first.state.opening).toBe(second.state.opening)
    expect(store.readOpening('sess_1', first.state.opening)).toEqual(seed)
  })

  it('内容不同的各存各的；没带对话就没有开局', () => {
    const a = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    const b = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'bob' })!
    a.noteOpening(seed)
    b.noteOpening([...seed, { role: 'user', content: '又问了一句' }])
    expect(fs.readdirSync(path.join(root, 'sub-agents', DAY, 'sess_1', '_openings'))).toHaveLength(2)

    const c = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'carol' })!
    c.noteOpening([])
    c.saveState(state('carol'))
    expect(store.list('sess_1').find(x => x.state.name === 'carol')!.state.opening).toBeUndefined()
  })

  it('开局目录不当成一位伙计列出来；指纹不对或文件不在就读不到', () => {
    const a = store.recorderFor({ sessionId: 'sess_1', startedAt: AT, name: 'alice' })!
    a.noteOpening(seed)
    a.saveState(state('alice'))
    expect(store.list('sess_1')).toHaveLength(1)
    expect(store.readOpening('sess_1', '../etc')).toEqual([])
    expect(store.readOpening('sess_1', 'abcdef')).toEqual([])
    expect(store.readOpening('sess_1', undefined)).toEqual([])
  })
})

describe('跟着会话删、按天过期', () => {
  function seedTwoSessions(): void {
    for (const sessionId of ['sess_1', 'sess_2']) {
      const r = store.recorderFor({ sessionId, startedAt: AT, name: 'alice' })!
      r.saveState(state('alice'))
      r.saveRecord(record('alice', 2))
    }
  }

  it('删掉一场会话，只带走它的', () => {
    seedTwoSessions()
    store.deleteSession('sess_1')
    expect(store.list('sess_1')).toEqual([])
    expect(store.list('sess_2')).toHaveLength(1)
  })

  it('按天清理：日期早于截止日的整天删掉', () => {
    seedTwoSessions()
    store.deleteBefore('2026-10-24')
    expect(store.list('sess_1')).toEqual([])
    expect(store.list('sess_2')).toEqual([])
  })

  it('会话已经不在的清掉，最近还写过的先留着', () => {
    seedTwoSessions()
    store.deleteOrphans(new Set(['sess_2']), Date.now())
    expect(store.list('sess_1')).toHaveLength(1)
    store.deleteOrphans(new Set(['sess_2']), Date.now() + 2 * 24 * 60 * 60 * 1000)
    expect(store.list('sess_1')).toEqual([])
    expect(store.list('sess_2')).toHaveLength(1)
  })
})

describe('不进最近对话和历史搜索，跟着主会话的删除', () => {
  function parentRecord(id: string): AgentRecord {
    return { ...record(id, 2), agentKey: 'assistant-1', timestamp: AT }
  }

  it('存了伙计记录，主历史的索引和最近对话里没有它们', () => {
    const records = new AgentRecordStore(path.join(root, 'history'))
    records.saveAgentRecord(parentRecord('parent_1'))
    const sub = records.subAgents.recorderFor({ sessionId: 'parent_1', startedAt: AT, name: 'alice' })!
    sub.saveState(state('alice'))
    sub.saveRecord(record('sub_assistant-1:sub:alice_1', 4))

    expect(records.getAgentRecordById('sub_assistant-1:sub:alice_1')).toBeUndefined()
    expect(records.getRecentAgentRecords(10).map(r => r.id)).toEqual(['parent_1'])
    expect(records.getAllIndexEntries().map(e => e.id)).toEqual(['parent_1'])
    expect(records.listAgentHistorySummaries().map(e => e.id)).toEqual(['parent_1'])
  })

  it('删主会话时伙计的记录一起删；清空历史时也一起清', () => {
    const records = new AgentRecordStore(path.join(root, 'history'))
    records.saveAgentRecord(parentRecord('parent_1'))
    records.subAgents.recorderFor({ sessionId: 'parent_1', startedAt: AT, name: 'alice' })!.saveState(state('alice'))
    expect(records.subAgents.list('parent_1')).toHaveLength(1)

    records.deleteAgentRecord('parent_1')
    expect(records.subAgents.list('parent_1')).toEqual([])

    records.subAgents.recorderFor({ sessionId: 'parent_2', startedAt: AT, name: 'bob' })!.saveState(state('bob'))
    records.cleanupOldAgentRecords(0)
    expect(records.subAgents.list('parent_2')).toEqual([])
  })
})
