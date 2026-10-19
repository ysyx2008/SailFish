import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { AgentRecord } from '@shared/types'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  }
}))

import { HistoryService } from '../history.service'

function makeRecord(overrides: Partial<AgentRecord> & { id: string; timestamp: number; duration: number; userTask: string }): AgentRecord {
  return {
    terminalId: 'pty-1',
    terminalType: 'local',
    steps: [],
    status: 'completed',
    ...overrides,
  }
}

/** 索引是追加日志（agent-index.jsonl / watch-index.jsonl），见 history/agent-index-log.ts */
const indexPathOf = (tree: 'agent' | 'watch') =>
  path.join(tmpDir, 'history', `${tree}-index.jsonl`)

/** 把日志归约成最终条目：同 id 后写的胜出，墓碑删除 */
function readIndex(tree: 'agent' | 'watch'): Array<Record<string, any>> {
  const file = indexPathOf(tree)
  if (!fs.existsSync(file)) return []
  const map = new Map<string, Record<string, any>>()
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    const op = JSON.parse(line)
    if (op.op === 'put') map.set(op.e.id, op.e)
    else if (op.op === 'del') map.delete(op.id)
  }
  return [...map.values()]
}

/** 直接改写索引（模拟错位/损坏），写成无冗余日志 */
function writeIndex(tree: 'agent' | 'watch', entries: Array<Record<string, any>>): void {
  const text = entries.map(e => JSON.stringify({ op: 'put', e })).join('\n')
  fs.writeFileSync(indexPathOf(tree), text ? text + '\n' : '')
}

describe('HistoryService - getRecentAgentRecords', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('按最后更新时间（timestamp + duration）排序', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    // A: lastUpdated = 11:00
    svc.saveAgentRecord(makeRecord({
      id: 'a', timestamp: baseTime, duration: 3600_000, userTask: 'task A'
    }))
    // B: lastUpdated = 10:40
    svc.saveAgentRecord(makeRecord({
      id: 'b', timestamp: baseTime + 1800_000, duration: 600_000, userTask: 'task B'
    }))
    // C: lastUpdated = 12:00（最老开始但最后更新最晚）
    svc.saveAgentRecord(makeRecord({
      id: 'c', timestamp: baseTime - 3600_000, duration: 10800_000, userTask: 'task C'
    }))

    const results = svc.getRecentAgentRecords(3)
    expect(results.map(r => r.id)).toEqual(['c', 'a', 'b'])
  })

  it('跨天更新的对话不被遗漏', () => {
    const svc = new HistoryService()
    const day1 = new Date('2026-03-10T14:00:00').getTime()
    const day2 = new Date('2026-03-17T09:00:00').getTime()
    const day3 = new Date('2026-03-18T10:00:00').getTime()

    // 3月10号开始，持续 9 天 → lastUpdated ≈ 3月19号
    svc.saveAgentRecord(makeRecord({
      id: 'old-but-active', timestamp: day1, duration: 9 * 86400_000, userTask: 'long session'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'mid', timestamp: day2, duration: 3600_000, userTask: 'mid session'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'recent', timestamp: day3, duration: 600_000, userTask: 'recent session'
    }))

    const results = svc.getRecentAgentRecords(3)
    expect(results[0].id).toBe('old-but-active')
    expect(results.map(r => r.id)).toEqual(['old-but-active', 'recent', 'mid'])
  })

  it('filter 在索引条目上正确工作', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'normal', timestamp: baseTime, duration: 100, userTask: '正常任务'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'wakeup', timestamp: baseTime + 1000, duration: 200,
      userTask: '[当前时间：2026-03-18] 触发事件：定时'
    }))

    const filter = (r: AgentRecord) =>
      !(r.userTask.startsWith('[当前时间：') && r.userTask.includes('触发事件'))

    const results = svc.getRecentAgentRecords(10, filter)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('normal')
  })

  it('索引不存在时自动从日期文件重建', () => {
    const svc1 = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc1.saveAgentRecord(makeRecord({
      id: 'r1', timestamp: baseTime, duration: 1000, userTask: 'task 1'
    }))
    svc1.saveAgentRecord(makeRecord({
      id: 'r2', timestamp: baseTime + 5000, duration: 500, userTask: 'task 2'
    }))

    // 删除索引文件，模拟老版本升级
    const indexPath = indexPathOf('agent')
    expect(fs.existsSync(indexPath)).toBe(true)
    fs.unlinkSync(indexPath)

    // 新实例（_indexCache 为 null）应自动重建
    const svc2 = new HistoryService()
    const results = svc2.getRecentAgentRecords(10)
    expect(results).toHaveLength(2)
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  it('更新已有记录时索引同步更新、无重复', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'r1', timestamp: baseTime, duration: 1000, userTask: 'task 1'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'r2', timestamp: baseTime + 5000, duration: 500, userTask: 'task 2'
    }))

    // 更新 r1：duration 大增，应排到第一
    svc.saveAgentRecord(makeRecord({
      id: 'r1', timestamp: baseTime, duration: 100_000, userTask: 'task 1 updated'
    }))

    const results = svc.getRecentAgentRecords(2)
    expect(results[0].id).toBe('r1')
    expect(results[0].userTask).toBe('task 1 updated')

    expect(readIndex('agent')).toHaveLength(2)
  })

  it('cleanupOldRecords 后索引同步重建', () => {
    const svc = new HistoryService()
    const oldTime = new Date('2025-01-01T10:00:00').getTime()
    // 用相对当前时间的日期，避免硬编码日期随时间流逝变"旧"
    const recentTime = Date.now() - 24 * 60 * 60 * 1000 // 1 天前

    svc.saveAgentRecord(makeRecord({
      id: 'old', timestamp: oldTime, duration: 100, userTask: 'old task'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'new', timestamp: recentTime, duration: 100, userTask: 'new task'
    }))

    expect(svc.getRecentAgentRecords(10)).toHaveLength(2)

    svc.cleanupOldRecords(30)

    const results = svc.getRecentAgentRecords(10)
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('new')
  })

  it('无记录时返回空数组', () => {
    const svc = new HistoryService()
    expect(svc.getRecentAgentRecords(5)).toEqual([])
  })

  it('limit 小于总记录数时只返回 top N', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    for (let i = 0; i < 10; i++) {
      svc.saveAgentRecord(makeRecord({
        id: `r${i}`, timestamp: baseTime + i * 1000, duration: i * 100, userTask: `task ${i}`
      }))
    }

    const results = svc.getRecentAgentRecords(3)
    expect(results).toHaveLength(3)
  })
})

describe('HistoryService - deleteAgentRecord', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('只删出身是联络的那场，同一任务下的会话都删，用户自己的留下', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'mine', timestamp: baseTime, duration: 100, userTask: 'mine', agentKey: 'tab-1',
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'theirs', timestamp: baseTime + 1000, duration: 100, userTask: 'theirs',
      agentKey: 'assistant-1', assignedBy: 'companion',
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'also', timestamp: baseTime + 2000, duration: 100, userTask: 'also',
      agentKey: 'assistant-1', assignedBy: 'companion',
    }))

    expect(svc.deleteCompanionTaskRecords('assistant-1').sort()).toEqual(['also', 'theirs'])
    expect(svc.getAgentRecordById('theirs')).toBeUndefined()
    expect(svc.getAgentRecordById('also')).toBeUndefined()
    expect(svc.getAgentRecordById('mine')?.id).toBe('mine')
    expect(svc.deleteCompanionTaskRecords('tab-1')).toEqual([])
  })

  it('删除指定记录并同步更新索引', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'keep', timestamp: baseTime, duration: 100, userTask: 'keep'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'remove', timestamp: baseTime + 1000, duration: 200, userTask: 'remove'
    }))

    expect(svc.deleteAgentRecord('remove')).toBe(true)
    expect(svc.deleteAgentRecord('missing')).toBe(false)
    expect(svc.getAgentRecordById('remove')).toBeUndefined()
    expect(svc.getRecentAgentRecords(10).map(r => r.id)).toEqual(['keep'])

    const indexContent = readIndex('agent')
    expect(indexContent).toHaveLength(1)
    expect(indexContent[0].id).toBe('keep')
  })

  it('saveAgentRecord 写入按会话目录（meta + jsonl）', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'session-1', timestamp: baseTime, duration: 100, userTask: 'single file'
    }))

    const sessionDir = path.join(tmpDir, 'history', 'agent', '2026-03-18', 'session-1')
    const metaFile = path.join(sessionDir, 'meta.json')
    const legacyFile = path.join(tmpDir, 'history', 'agent', '2026-03-18.json')
    const legacySessionFile = path.join(tmpDir, 'history', 'agent', '2026-03-18', 'session-1.json')
    expect(fs.existsSync(metaFile)).toBe(true)
    expect(fs.existsSync(legacyFile)).toBe(false)
    expect(fs.existsSync(legacySessionFile)).toBe(false)

    const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf-8'))
    expect(parsed.id).toBe('session-1')
    expect(Array.isArray(parsed)).toBe(false)
  })

  it('删除日文件中最后一条记录时移除该日目录', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'only', timestamp: baseTime, duration: 100, userTask: 'only'
    }))

    const sessionDir = path.join(tmpDir, 'history', 'agent', '2026-03-18', 'only')
    expect(fs.existsSync(path.join(sessionDir, 'meta.json'))).toBe(true)

    expect(svc.deleteAgentRecord('only')).toBe(true)
    expect(fs.existsSync(sessionDir)).toBe(false)
  })
})

describe('HistoryService - multi-process index safety', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('进程 A 写索引后，进程 B 再保存不会抹掉 A 的条目', () => {
    const baseTime = new Date('2026-03-18T10:00:00').getTime()
    const desktop = new HistoryService()
    desktop.saveAgentRecord(makeRecord({
      id: 'desktop-sess', timestamp: baseTime, duration: 100, userTask: 'from desktop'
    }))

    // 模拟 CLI 新进程写入
    const cli = new HistoryService()
    cli.saveAgentRecord(makeRecord({
      id: 'cli-sess', timestamp: baseTime + 1000, duration: 200, userTask: 'from cli', title: '问候'
    }))

    // 桌面进程再保存：追加写只动自己那一条，不会盖掉 CLI 刚写的条目
    desktop.saveAgentRecord(makeRecord({
      id: 'desktop-sess', timestamp: baseTime, duration: 150, userTask: 'from desktop updated'
    }))

    expect(readIndex('agent').map(e => e.id).sort()).toEqual(['cli-sess', 'desktop-sess'])
    expect(desktop.getAgentRecordById('cli-sess')?.title).toBe('问候')
  })

  it('索引 dateStr 错位时 getAgentRecordById 仍能读到正文', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()
    svc.saveAgentRecord(makeRecord({
      id: 'orphan-body', timestamp: baseTime, duration: 100, userTask: 'hello', title: '问候'
    }))

    const index = readIndex('agent')
    const entry = index.find(e => e.id === 'orphan-body')
    expect(entry).toBeTruthy()
    entry!.dateStr = '2099-01-01'
    writeIndex('agent', index)

    // 新实例强制从盘读错位索引
    const fresh = new HistoryService()
    const record = fresh.getAgentRecordById('orphan-body')
    expect(record?.title).toBe('问候')
    expect(record?.userTask).toBe('hello')
  })

  it('索引被抹掉后仍可按正文删除孤儿会话', () => {
    const svc = new HistoryService()
    const baseTime = new Date('2026-03-18T10:00:00').getTime()
    svc.saveAgentRecord(makeRecord({
      id: 'orphan-del', timestamp: baseTime, duration: 100, userTask: 'bye'
    }))

    writeIndex('agent', [])

    const fresh = new HistoryService()
    expect(fresh.deleteAgentRecord('orphan-del')).toBe(true)
    expect(fresh.getAgentRecordById('orphan-del')).toBeUndefined()

    const dateDir = path.join(tmpDir, 'history', 'agent', '2026-03-18')
    const stillThere = fs.existsSync(dateDir) &&
      fs.readdirSync(dateDir).some(name => name.includes('orphan-del'))
    expect(stillThere).toBe(false)
  })
})

describe('HistoryService - searchAgentRecordsAdvanced', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('无关键字且无时间范围时返回空', async () => {
    const svc = new HistoryService()
    svc.saveAgentRecord(makeRecord({ id: 'a', timestamp: Date.now(), duration: 1, userTask: '随便' }))
    const res = await svc.searchAgentRecordsAdvanced({})
    expect(res).toEqual({ records: [], totalMatched: 0, hasMore: false })
  })

  it('full 模式命中 userTask / finalResult / steps 正文', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'by-title', timestamp: t, duration: 1, userTask: '部署 nginx 服务'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'by-result', timestamp: t + 1000, duration: 1, userTask: '查日志',
      finalResult: '发现 nginx 配置错误已修复'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'by-step', timestamp: t + 2000, duration: 1, userTask: '看看进程',
      steps: [{ type: 'user_supplement', content: '顺便重启 nginx', timestamp: t } as any]
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'no-match', timestamp: t + 3000, duration: 1, userTask: '完全无关'
    }))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: 'nginx', limit: 10 })
    expect(res.totalMatched).toBe(3)
    expect(new Set(res.records.map(r => r.id))).toEqual(new Set(['by-title', 'by-result', 'by-step']))
  })

  it('full 模式命中用户消息和追加消息上的附件标题', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'by-task-attachment', timestamp: t, duration: 1, userTask: '帮我看看',
      steps: [{
        type: 'user_task', content: '帮我看看', timestamp: t,
        attachments: [{ filename: 'Q3财务报告.xlsx', fileSize: 12, fileType: 'xlsx' }]
      } as any]
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'by-supplement-attachment', timestamp: t + 1000, duration: 1, userTask: '继续',
      steps: [{
        type: 'user_supplement', content: '再看这个', timestamp: t,
        attachments: [{ filename: '财务预测草案.pdf', fileSize: 8, fileType: 'pdf' }]
      } as any]
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'no-match', timestamp: t + 2000, duration: 1, userTask: '完全无关',
      steps: [{
        type: 'user_task', content: '完全无关', timestamp: t,
        attachments: [{ filename: '会议纪要.docx', fileSize: 4, fileType: 'docx' }]
      } as any]
    }))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: '财务', limit: 10 })
    expect(res.totalMatched).toBe(2)
    expect(new Set(res.records.map(r => r.id))).toEqual(new Set(['by-task-attachment', 'by-supplement-attachment']))
  })

  it('titleOnly 模式只匹配 userTask，不扫描正文', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'title-hit', timestamp: t, duration: 1, userTask: 'nginx 部署'
    }))
    svc.saveAgentRecord(makeRecord({
      id: 'body-only', timestamp: t + 1000, duration: 1, userTask: '查日志',
      finalResult: 'nginx 配置错误'
    }))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: 'nginx', titleOnly: true, limit: 10 })
    expect(res.totalMatched).toBe(1)
    expect(res.records.map(r => r.id)).toEqual(['title-hit'])
  })

  it('结果按最近优先排序', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({ id: 'old', timestamp: t, duration: 1, userTask: '任务 x' }))
    svc.saveAgentRecord(makeRecord({ id: 'mid', timestamp: t + 1000, duration: 1, userTask: '任务 x' }))
    svc.saveAgentRecord(makeRecord({ id: 'new', timestamp: t + 2000, duration: 1, userTask: '任务 x' }))

    const hits: string[] = []
    const res = await svc.searchAgentRecordsAdvanced({
      keyword: '任务',
      limit: 10,
      onMatch: (r) => hits.push(r.id),
    })
    expect(res.records.map(r => r.id)).toEqual(['new', 'mid', 'old'])
    expect(hits).toEqual(['new', 'mid', 'old'])
  })

  it('跨天命中不遗漏', async () => {
    const svc = new HistoryService()
    const day1 = new Date('2026-03-10T14:00:00').getTime()
    const day2 = new Date('2026-03-18T09:00:00').getTime()

    svc.saveAgentRecord(makeRecord({ id: 'd1', timestamp: day1, duration: 1, userTask: 'redis 调优' }))
    svc.saveAgentRecord(makeRecord({ id: 'd2', timestamp: day2, duration: 1, userTask: 'redis 重启' }))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: 'redis', limit: 10 })
    expect(res.records.map(r => r.id)).toEqual(['d2', 'd1'])
  })

  it('时间范围过滤', async () => {
    const svc = new HistoryService()
    const mar10 = new Date('2026-03-10T10:00:00').getTime()
    const mar18 = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({ id: 'early', timestamp: mar10, duration: 1, userTask: 'redis' }))
    svc.saveAgentRecord(makeRecord({ id: 'late', timestamp: mar18, duration: 1, userTask: 'redis' }))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: 'redis', startDate: '2026-03-15' })
    expect(res.records.map(r => r.id)).toEqual(['late'])
  })

  it('filter 在索引条目上正确工作（excludeWakeup）', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({ id: 'normal', timestamp: t, duration: 1, userTask: '部署任务' }))
    svc.saveAgentRecord(makeRecord({
      id: 'wakeup', timestamp: t + 1000, duration: 1,
      userTask: '[当前时间：2026-03-18] 触发事件：部署定时'
    }))

    const filter = (r: AgentRecord) =>
      !(r.userTask.startsWith('[当前时间：') && r.userTask.includes('触发事件'))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: '部署', filter, limit: 10 })
    expect(res.records.map(r => r.id)).toEqual(['normal'])
  })

  it('limit 截断时 totalMatched 与 hasMore 正确', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    for (let i = 0; i < 5; i++) {
      svc.saveAgentRecord(makeRecord({
        id: `r${i}`, timestamp: t + i * 1000, duration: 1, userTask: '批量任务'
      }))
    }

    const res = await svc.searchAgentRecordsAdvanced({ keyword: '批量', limit: 2 })
    expect(res.records).toHaveLength(2)
    expect(res.totalMatched).toBe(5)
    expect(res.hasMore).toBe(true)
  })

  it('已中止的 signal 立刻停，不扫完全部候选', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    for (let i = 0; i < 3; i++) {
      svc.saveAgentRecord(makeRecord({
        id: `r${i}`, timestamp: t + i * 1000, duration: 1, userTask: '可中止任务'
      }))
    }

    const ac = new AbortController()
    ac.abort()
    await expect(svc.searchAgentRecordsAdvanced({
      keyword: '可中止',
      limit: 10,
      signal: ac.signal
    })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('扫描中途 abort 不再继续读后续记录', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    for (let i = 0; i < 5; i++) {
      svc.saveAgentRecord(makeRecord({
        id: `abort-mid-${i}`, timestamp: t + i * 1000, duration: 1, userTask: '可中止任务'
      }))
    }

    const ac = new AbortController()
    const hits: string[] = []
    await expect(svc.searchAgentRecordsAdvanced({
      keyword: '可中止',
      limit: 10,
      signal: ac.signal,
      onMatch: (r) => {
        hits.push(r.id)
        ac.abort()
      }
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(hits).toHaveLength(1)
  })

  it('全文搜索不把 canvasData 装进结果，点开查看仍完整', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    svc.saveAgentRecord(makeRecord({
      id: 'canvas-search',
      timestamp: t,
      duration: 1,
      userTask: '改论文',
      steps: [{
        id: 's1',
        type: 'tool_result',
        content: '已替换',
        timestamp: t,
        toolName: 'word_replace',
        canvasData: { action: 'update', renderer: 'document', content: '<p>整篇</p>' },
      } as AgentRecord['steps'][number]],
    }))

    const res = await svc.searchAgentRecordsAdvanced({ keyword: '改论文', limit: 10 })
    expect(res.records[0].steps[0].canvasData).toBeUndefined()

    const viewed = svc.getAgentRecordById('canvas-search')
    expect(viewed?.steps[0].canvasData?.content).toBe('<p>整篇</p>')

    const slim = svc.getAgentRecordById('canvas-search', { omitCanvasData: true })
    expect(slim?.steps[0].canvasData).toBeUndefined()
    expect(svc.getAgentRecordById('canvas-search')?.steps[0].canvasData?.content).toBe('<p>整篇</p>')
  })

  it('旧日文件按 id 取记录时也能丢掉 canvasData', () => {
    const agentDir = path.join(tmpDir, 'history', 'agent')
    fs.mkdirSync(agentDir, { recursive: true })
    const t = new Date('2026-03-18T10:00:00').getTime()
    const record = makeRecord({
      id: 'legacy-canvas',
      timestamp: t,
      duration: 1,
      userTask: '旧格式',
      steps: [{
        id: 's1',
        type: 'tool_result',
        content: 'ok',
        timestamp: t,
        canvasData: { action: 'update', renderer: 'document', content: '<p>大</p>' },
      } as AgentRecord['steps'][number]],
    })
    fs.writeFileSync(path.join(agentDir, '2026-03-18.json'), JSON.stringify([record]))

    const svc = new HistoryService()
    expect(svc.getAgentRecordById('legacy-canvas')?.steps[0].canvasData?.content).toBe('<p>大</p>')
    expect(svc.getAgentRecordById('legacy-canvas', { omitCanvasData: true })?.steps[0].canvasData).toBeUndefined()
  })
})

describe('HistoryService - watch 历史隔离', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('agentKey=__watch__ 的记录存到独立 watch 树/索引，不进主索引', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({ id: 'user-1', timestamp: t, duration: 1, userTask: '用户任务' }))
    svc.saveAgentRecord(makeRecord({
      id: 'watch-1', timestamp: t + 1000, duration: 1, userTask: '心跳触发', agentKey: '__watch__'
    }))

    // 正文落到 watch 树，不在 agent 树（目录格式：meta.json）
    expect(fs.existsSync(path.join(tmpDir, 'history', 'watch', '2026-03-18', 'watch-1', 'meta.json'))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'history', 'agent', '2026-03-18', 'watch-1'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'history', 'agent', '2026-03-18', 'watch-1.json'))).toBe(false)

    // 两套独立索引
    expect(fs.existsSync(indexPathOf('agent'))).toBe(true)
    expect(fs.existsSync(indexPathOf('watch'))).toBe(true)

    // 主历史接口不含 watch
    expect(svc.getRecentAgentRecords(10).map(r => r.id)).toEqual(['user-1'])
    expect(svc.listAgentHistorySummaries(true).map(s => s.id)).toEqual(['user-1'])
    // by-id 两树通吃
    expect(svc.getAgentRecordById('watch-1')?.id).toBe('watch-1')
    // watch 专用读取
    expect(svc.getRecentWatchRecords(10).map(r => r.id)).toEqual(['watch-1'])
  })

  it('agentKey=__watch__:watchId 的记录同样进独立 watch 树', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()

    svc.saveAgentRecord(makeRecord({
      id: 'watch-2', timestamp: t, duration: 1, userTask: '关切执行', agentKey: '__watch__:abc'
    }))

    expect(fs.existsSync(path.join(tmpDir, 'history', 'watch', '2026-03-18', 'watch-2', 'meta.json'))).toBe(true)
    expect(svc.listAgentHistorySummaries(true).map(s => s.id)).not.toContain('watch-2')
    expect(svc.getRecentWatchRecords(10).map(r => r.id)).toEqual(['watch-2'])
  })

  it('getTokenUsageStats 合并主 + watch 索引（watch 成本不漏算）', () => {
    const svc = new HistoryService()
    const t = Date.now()
    const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cache_hit_tokens: 0, cache_miss_tokens: 0 }

    svc.saveAgentRecord(makeRecord({ id: 'u', timestamp: t, duration: 1, userTask: '任务', tokenUsage: usage }))
    svc.saveAgentRecord(makeRecord({ id: 'w', timestamp: t, duration: 1, userTask: '心跳', agentKey: '__watch__', tokenUsage: usage }))

    const stats = svc.getTokenUsageStats()
    expect(stats.total.total_tokens).toBe(300)
    expect(stats.total.taskCount).toBe(2)
  })

  it('deleteAgentRecord 能删除 watch 记录（文件 + watch 索引）', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    svc.saveAgentRecord(makeRecord({ id: 'w', timestamp: t, duration: 1, userTask: '心跳', agentKey: '__watch__' }))

    expect(fs.existsSync(path.join(tmpDir, 'history', 'watch', '2026-03-18', 'w', 'meta.json'))).toBe(true)
    expect(svc.deleteAgentRecord('w')).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'history', 'watch', '2026-03-18', 'w'))).toBe(false)
    expect(svc.getRecentWatchRecords(10)).toHaveLength(0)
    expect(readIndex('watch')).toHaveLength(0)
  })

  it('rebuildAgentIndex 后两套索引各自一致', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    svc.saveAgentRecord(makeRecord({ id: 'u', timestamp: t, duration: 1, userTask: '用户' }))
    svc.saveAgentRecord(makeRecord({ id: 'w', timestamp: t, duration: 1, userTask: '心跳', agentKey: '__watch__' }))

    // 删索引文件模拟损坏/老版本，强制从磁盘重建两套
    fs.unlinkSync(indexPathOf('agent'))
    fs.unlinkSync(indexPathOf('watch'))
    svc.rebuildAgentIndex()

    expect(svc.getRecentAgentRecords(10).map(r => r.id)).toEqual(['u'])
    expect(svc.getRecentWatchRecords(10).map(r => r.id)).toEqual(['w'])
  })

  it('watch 索引 userTask 截断、正文完整保留', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    const longTask = '[当前时间：x] 触发事件：' + 'a'.repeat(1000)

    svc.saveAgentRecord(makeRecord({ id: 'w', timestamp: t, duration: 1, userTask: longTask, agentKey: '__watch__' }))

    const idx = readIndex('watch')
    expect(idx[0].userTask.length).toBe(200)
    // 正文未截断
    expect(svc.getRecentWatchRecords(1)[0].userTask).toBe(longTask)
  })
})

describe('HistoryService - 旧索引（单个 JSON 数组）自动转成追加日志', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 造出「旧版本留下的状态」：正文树 + 单个 JSON 数组索引，没有 jsonl */
  function seedLegacy(records: AgentRecord[]): void {
    const svc = new HistoryService()
    for (const r of records) svc.saveAgentRecord(r)
    for (const tree of ['agent', 'watch'] as const) {
      const jsonl = indexPathOf(tree)
      if (!fs.existsSync(jsonl)) continue
      const legacy = path.join(tmpDir, 'history', `${tree}-index.json`)
      fs.writeFileSync(legacy, JSON.stringify(readIndex(tree)))
      fs.unlinkSync(jsonl)
    }
  }

  it('首次访问就转换：条目一一对应，旧文件留档不再参与', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    seedLegacy([
      makeRecord({ id: 'a', timestamp: t, duration: 100, userTask: '任务 A', title: '标题 A' }),
      makeRecord({ id: 'b', timestamp: t + 1000, duration: 200, userTask: '任务 B' }),
      makeRecord({ id: 'w', timestamp: t, duration: 1, userTask: '心跳', agentKey: '__watch__' }),
    ])

    const legacyAgent = path.join(tmpDir, 'history', 'agent-index.json')
    expect(fs.existsSync(legacyAgent)).toBe(true)
    expect(fs.existsSync(indexPathOf('agent'))).toBe(false)

    const svc = new HistoryService()
    expect(svc.getRecentAgentRecords(10).map(r => r.id).sort()).toEqual(['a', 'b'])
    expect(svc.getRecentWatchRecords(10).map(r => r.id)).toEqual(['w'])

    // 转换后旧文件改名留档，不再被当成索引
    expect(fs.existsSync(indexPathOf('agent'))).toBe(true)
    expect(fs.existsSync(legacyAgent)).toBe(false)
    expect(fs.existsSync(`${legacyAgent}.migrated`)).toBe(true)

    // 标题等字段完整搬过来，没有在转换中丢失
    expect(svc.listAgentHistorySummaries().find(s => s.id === 'a')?.title).toBe('标题 A')
  })

  it('转换后照常增删：新写的进日志，旧条目仍在', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    seedLegacy([makeRecord({ id: 'old', timestamp: t, duration: 100, userTask: '旧任务' })])

    const svc = new HistoryService()
    svc.saveAgentRecord(makeRecord({ id: 'new', timestamp: t + 1000, duration: 100, userTask: '新任务' }))
    expect(svc.getRecentAgentRecords(10).map(r => r.id).sort()).toEqual(['new', 'old'])

    expect(svc.deleteAgentRecord('old')).toBe(true)
    expect(new HistoryService().getRecentAgentRecords(10).map(r => r.id)).toEqual(['new'])
  })

  it('旧索引损坏时不卡住：从正文重建，记录照样读得到', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    seedLegacy([makeRecord({ id: 'a', timestamp: t, duration: 100, userTask: '任务 A' })])
    fs.writeFileSync(path.join(tmpDir, 'history', 'agent-index.json'), '{截断的坏文件')

    const svc = new HistoryService()
    expect(svc.getRecentAgentRecords(10).map(r => r.id)).toEqual(['a'])
  })

  it('旧索引损坏且第一个动作是写：不会建出只剩新记录的索引，老记录仍在', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    seedLegacy([
      makeRecord({ id: 'old1', timestamp: t, duration: 100, userTask: '老任务 1' }),
      makeRecord({ id: 'old2', timestamp: t + 1, duration: 100, userTask: '老任务 2' }),
    ])
    fs.writeFileSync(path.join(tmpDir, 'history', 'agent-index.json'), '{截断的坏文件')

    // 新进程上来就写（CLI 只跑任务、不读历史列表，就是这个顺序）。
    // 记录自带 title，好让保存过程不去查已有标题——否则那一步会顺带把索引补出来，
    // 就测不到写入本身该有的兜底了
    const svc = new HistoryService()
    svc.saveAgentRecord(makeRecord({
      id: 'fresh', timestamp: t + 2000, duration: 100, userTask: '新任务', title: '新任务'
    }))

    expect(new HistoryService().getRecentAgentRecords(10).map(r => r.id).sort())
      .toEqual(['fresh', 'old1', 'old2'])
  })

  it('索引整个丢失且第一个动作是写：同样从正文补回来', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    const seed = new HistoryService()
    seed.saveAgentRecord(makeRecord({ id: 'old', timestamp: t, duration: 100, userTask: '老任务' }))
    fs.unlinkSync(indexPathOf('agent'))

    const svc = new HistoryService()
    svc.saveAgentRecord(makeRecord({
      id: 'fresh', timestamp: t + 2000, duration: 100, userTask: '新任务', title: '新任务'
    }))

    expect(new HistoryService().getRecentAgentRecords(10).map(r => r.id).sort())
      .toEqual(['fresh', 'old'])
  })

  it('索引丢失时保标题也要走重建，不该把已有标题弄丢', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    const seed = new HistoryService()
    seed.saveAgentRecord(makeRecord({ id: 's', timestamp: t, duration: 100, userTask: '任务', title: '原标题' }))
    fs.unlinkSync(indexPathOf('agent'))

    // checkpoint 不带 title：应从重建出的索引里把原标题捞回来
    const svc = new HistoryService()
    svc.saveAgentRecord(makeRecord({ id: 's', timestamp: t, duration: 200, userTask: '任务' }))

    expect(new HistoryService().listAgentHistorySummaries().find(x => x.id === 's')?.title).toBe('原标题')
  })

  it('已经是日志格式时，残留的旧 JSON 文件不会把它顶掉', () => {
    const t = new Date('2026-03-18T10:00:00').getTime()
    const svc = new HistoryService()
    svc.saveAgentRecord(makeRecord({ id: 'current', timestamp: t, duration: 100, userTask: '当前' }))

    // 残留一份内容不同的旧索引（例如回滚过版本）
    fs.writeFileSync(
      path.join(tmpDir, 'history', 'agent-index.json'),
      JSON.stringify([{ id: 'stale', timestamp: t, duration: 1, dateStr: '2026-03-18', userTask: '陈旧', terminalType: 'local', status: 'completed' }])
    )

    expect(new HistoryService().getRecentAgentRecords(10).map(r => r.id)).toEqual(['current'])
  })
})

describe('HistoryService - Canvas content 外化', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('contentFromFile 的 canvasData 存盘时剥离 content，可重生类不变', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    const record = makeRecord({
      id: 'canvas-1', timestamp: t, duration: 1, userTask: '生成 dashboard',
      steps: [
        {
          id: 's1', type: 'tool_result', content: 'ok', timestamp: t,
          // md/html：content 即磁盘文件内容 → 应被剥离
          canvasData: { action: 'open', renderer: 'html', title: 'a.html', filePath: '/tmp/a.html', content: '<html>巨大内容</html>', contentFromFile: true },
        },
        {
          id: 's2', type: 'tool_result', content: 'ok', timestamp: t,
          // Word 预览：content 是派生 HTML（非文件本体）→ 应保留
          canvasData: { action: 'open', renderer: 'document', title: 'b.docx', filePath: '/tmp/b.docx', content: '<p>预览</p>' },
        },
      ],
    })

    svc.saveAgentRecord(record)
    const loaded = svc.getAgentRecordById('canvas-1')!
    expect(loaded.steps[0].canvasData?.content).toBeUndefined()
    expect(loaded.steps[0].canvasData?.filePath).toBe('/tmp/a.html')
    expect(loaded.steps[0].canvasData?.contentFromFile).toBe(true)
    expect(loaded.steps[1].canvasData?.content).toBe('<p>预览</p>')
  })

  it('不改动调用方持有的实时 canvasData 对象（克隆后删）', () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    const liveCanvas = { action: 'open' as const, renderer: 'markdown' as const, title: 'x.md', filePath: '/tmp/x.md', content: '# 实时内容', contentFromFile: true }
    const record = makeRecord({
      id: 'canvas-2', timestamp: t, duration: 1, userTask: 't',
      steps: [{ id: 's1', type: 'tool_result', content: 'ok', timestamp: t, canvasData: liveCanvas }],
    })

    svc.saveAgentRecord(record)
    // 实时会话仍持有完整 content
    expect(liveCanvas.content).toBe('# 实时内容')
  })
})

describe('HistoryService - searchAgentHistorySummaries', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('关键字也认侧栏标题，命中全部交回摘要', async () => {
    const svc = new HistoryService()
    const t = new Date('2026-03-18T10:00:00').getTime()
    for (let i = 0; i < 12; i++) {
      svc.saveAgentRecord(makeRecord({ id: `r${i}`, timestamp: t + i * 1000, duration: 1, userTask: '帮我看看', title: `输入法死机 ${i}` }))
    }
    svc.saveAgentRecord(makeRecord({ id: 'other', timestamp: t, duration: 1, userTask: '无关', title: '无关' }))

    const hits = await svc.searchAgentHistorySummaries({ keyword: '输入法' })
    expect(hits).toHaveLength(12)
    expect(hits[0]?.id).toBe('r11')
    expect(hits[0]).not.toHaveProperty('steps')
  })

  it('dateBy=lastActive 按最后活跃那天筛，与侧栏分组一致', async () => {
    const svc = new HistoryService()
    const oct1 = new Date('2026-10-01T10:00:00').getTime()
    const nineDays = 9 * 24 * 3600_000
    svc.saveAgentRecord(makeRecord({ id: 'long', timestamp: oct1, duration: nineDays, userTask: '一直在做' }))
    svc.saveAgentRecord(makeRecord({ id: 'short', timestamp: oct1, duration: 1000, userTask: '当天做完' }))

    const byActive = await svc.searchAgentHistorySummaries({ startDate: '2026-10-10', endDate: '2026-10-10', dateBy: 'lastActive' })
    expect(byActive.map(s => s.id)).toEqual(['long'])
    const byStart = await svc.searchAgentHistorySummaries({ startDate: '2026-10-10', endDate: '2026-10-10' })
    expect(byStart).toEqual([])
  })
})
