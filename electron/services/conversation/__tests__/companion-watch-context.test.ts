/**
 * Companion.formatRecentTurnsForWatchPrompt —— 心跳/Watch 注入联络上下文的单测。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import { HistoryService } from '../../history.service'
import { Companion } from '../companion'
import { readTeamArtifacts } from '../../history/team-artifacts'
import type { AgentRecord } from '@shared/types'

function companionRec(
  id: string,
  overrides?: Partial<AgentRecord>
): AgentRecord {
  return {
    id,
    kind: 'companion',
    timestamp: Date.now(),
    terminalId: '',
    agentKey: '__companion__',
    terminalType: 'assistant',
    userTask: `联络 ${id}`,
    steps: [],
    messages: [],
    duration: 0,
    status: 'completed',
    ...overrides
  } as AgentRecord
}

describe('Companion.formatRecentTurnsForWatchPrompt', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-companion-watch-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('合并多条 companion record，输出 L4 一句话概要', () => {
    const hs = new HistoryService()
    const t0 = Date.now() - 60_000
    const t1 = Date.now()

    hs.saveAgentRecord(companionRec('sess_old', {
      timestamp: t0,
      messages: [
        { role: 'user', content: '胡宇明天来实习' },
        { role: 'assistant', content: '好的，我会提醒你' }
      ]
    }))
    hs.saveAgentRecord(companionRec('sess_new', {
      timestamp: t1,
      messages: [
        { role: 'user', content: '你提醒了我几次，你可知道' },
        { role: 'assistant', content: '我提醒了你 3 次，以后只提醒一次' },
        { role: 'user', content: '我怀疑你在心跳的时候看不到这些历史记录' }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('# 联络摘要')
    expect(text).toContain('L4')
    expect(text).toContain('你提醒了我几次')
    expect(text).toContain('我提醒了你 3 次')
    expect(text).toContain('我怀疑你在心跳的时候看不到这些历史记录')
    // L4 行形态：状态图标 + 请求 → 回复
    expect(text).toMatch(/✓.*→/)
  })

  it('有历史 messages record 时仍能看到 __proactive__ 主动通知', () => {
    const hs = new HistoryService()
    const t0 = Date.now() - 120_000
    const t1 = Date.now() - 60_000
    const t2 = Date.now()

    hs.saveAgentRecord(companionRec('sess_old', {
      timestamp: t0,
      messages: [
        { role: 'user', content: '帮我查一下 A 股' },
        { role: 'assistant', content: '好的，已整理报告' }
      ],
      steps: [
        { id: 'ut0', type: 'user_task', content: '帮我查一下 A 股', timestamp: t0 },
        { id: 'fr0', type: 'final_result', content: '好的，已整理报告', timestamp: t0 + 1 }
      ]
    }))
    hs.saveAgentRecord(companionRec('proactive_5000', {
      timestamp: t1,
      userTask: '__proactive__',
      messages: [],
      steps: [
        { id: 'pn5000', type: 'proactive_notice', content: '恭喜我们第 5000 次对话！', timestamp: t1 }
      ]
    }))
    hs.saveAgentRecord(companionRec('sess_new', {
      timestamp: t2,
      messages: [
        { role: 'user', content: '今天继续测工具' },
        { role: 'assistant', content: '收到，有需要叫我' }
      ],
      steps: [
        { id: 'ut1', type: 'user_task', content: '今天继续测工具', timestamp: t2 },
        { id: 'fr1', type: 'final_result', content: '收到，有需要叫我', timestamp: t2 + 1 }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('恭喜我们第 5000 次对话')
    expect(text).toContain('今天继续测工具')
  })

  it('proactive_notice 作为主动消息进入 L4', () => {
    const hs = new HistoryService()
    hs.saveAgentRecord(companionRec('sess_pro', {
      userTask: '__proactive__',
      messages: [],
      steps: [
        { id: 'pn1', type: 'proactive_notice', content: '胡宇明天 10:30 报到', timestamp: Date.now() },
        { id: 'ut1', type: 'user_task', content: '知道了别重复说', timestamp: Date.now() + 1 },
        { id: 'fr1', type: 'final_result', content: '收到，以后只提醒一次', timestamp: Date.now() + 2 }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('胡宇明天 10:30 报到')
    expect(text).toContain('知道了别重复说')
  })

  it('不灌 message 内心独白，只保留 final_result', () => {
    const hs = new HistoryService()
    const t = Date.now()
    hs.saveAgentRecord(companionRec('sess_msg', {
      messages: [],
      steps: [
        { id: 'ut1', type: 'user_task', content: '提醒我开会', timestamp: t },
        {
          id: 'msg1',
          type: 'message',
          content: '<details><summary>思考</summary>很长的内心独白</details>中间稿',
          timestamp: t + 1
        },
        { id: 'fr1', type: 'final_result', content: '好的，到点提醒你', timestamp: t + 2 }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('提醒我开会')
    expect(text).toContain('好的，到点提醒你')
    expect(text).not.toContain('内心独白')
    expect(text).not.toContain('中间稿')
  })

  it('长文压成 L4 一行概要，不保留全文；剥离 details', () => {
    const hs = new HistoryService()
    const longUser = '请帮我分析这份很长的材料' + '细节'.repeat(200)
    const longAsst = '分析结论是一切正常。' + '补充'.repeat(200)
    hs.saveAgentRecord(companionRec('sess_long', {
      messages: [
        { role: 'user', content: `<details><summary>x</summary>hide</details>${longUser}` },
        { role: 'assistant', content: longAsst }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).not.toContain('hide')
    expect(text).not.toContain('细节'.repeat(50))
    expect(text).toContain('请帮我分析这份很长的材料')
    expect(text).toContain('分析结论是一切正常')
    // 整段摘要远小于原文
    expect(text.length).toBeLessThan(longUser.length)
  })

  it('不把 message.images 带进摘要文本', () => {
    const hs = new HistoryService()
    hs.saveAgentRecord(companionRec('sess_img', {
      messages: [
        {
          role: 'user',
          content: '看看这张图',
          images: ['data:image/png;base64,AAAA_VERY_LONG_BASE64_SHOULD_NOT_APPEAR']
        } as AgentRecord['messages'] extends (infer M)[] | undefined ? M : never,
        { role: 'assistant', content: '图里是一只猫' }
      ]
    }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('看看这张图')
    expect(text).not.toContain('base64')
    expect(text).not.toContain('AAAA_VERY_LONG')
  })

  it('默认取最近 12 次互动，更早的丢掉', () => {
    const hs = new HistoryService()
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (let i = 0; i < 20; i++) {
      messages.push({ role: 'user', content: `用户消息 ${i}` })
      messages.push({ role: 'assistant', content: `回复 ${i}` })
    }
    hs.saveAgentRecord(companionRec('sess_many', { messages }))

    const text = new Companion(hs).formatRecentTurnsForWatchPrompt()
    expect(text).toContain('用户消息 19')
    expect(text).not.toContain('用户消息 0')
    expect(text).not.toContain('用户消息 7')
    expect(text).toContain('用户消息 8')
  })
})

describe('Companion.getMergedViewRecord', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-companion-merge-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('主动提醒再多也不挤掉最近的真对话', () => {
    const hs = new HistoryService()
    const t0 = Date.now() - 200_000
    hs.saveAgentRecord(companionRec('real_old', {
      timestamp: t0,
      userTask: '昨天那句还在吗',
      steps: [
        { id: 'ut-old', type: 'user_task', content: '昨天那句还在吗', timestamp: t0 },
        { id: 'fr-old', type: 'final_result', content: '在', timestamp: t0 + 1 }
      ]
    }))
    for (let i = 0; i < 12; i++) {
      const ts = t0 + 10_000 + i * 1000
      hs.saveAgentRecord(companionRec(`proactive_${i}`, {
        timestamp: ts,
        userTask: '__proactive__',
        steps: [
          { id: `pn-${i}`, type: 'proactive_notice', content: `提醒 ${i}`, timestamp: ts }
        ]
      }))
    }

    const merged = new Companion(hs).getMergedViewRecord()
    expect(merged).not.toBeNull()
    const contents = (merged!.steps ?? []).map(s => s.content)
    expect(contents).toContain('昨天那句还在吗')
    expect(contents).toContain('提醒 11')
  })

  it('旧组织合入联络历史后仍按原物理会话读取成果，不串最新会话同名团', async () => {
    const hs = new HistoryService()
    const at = Date.now() - 10_000
    hs.saveAgentRecord(companionRec('old-org', { timestamp: at, steps: [{
      id: 'old-dispatch', type: 'tool_call', content: '组织', timestamp: at,
      organization: { members: [], teams: [], live: 0, total: 0 },
    }] }))
    hs.saveAgentRecord(companionRec('latest-org', { timestamp: at + 1000, steps: [] }))
    const store = hs.getAgentRecordStore().subAgents
    for (const [sessionId, result] of [['old-org', 'A的成果'], ['latest-org', 'B的成果']]) {
      store.recorderFor({ sessionId, startedAt: at, name: '甲员' })!.saveState({ name: '甲员', parent: '甲', team: '团', description: 'fixture', prompt: 'fixture', status: 'completed', result })
    }
    const merged = new Companion(hs).getMergedViewRecord()!
    expect(merged.id).toBe('latest-org')
    const org = merged.steps.find(step => step.id === 'old-dispatch')!.organization!
    expect(org.sessionId).toBe('old-org')
    const artifacts = await readTeamArtifacts(store, org.sessionId!, { name: '团', owner: '甲' })
    expect(artifacts.map(item => item.data.content)).toEqual(['A的成果'])
  })
  it('真对话超过名额时只留最近一段窗口', () => {
    const hs = new HistoryService()
    const t0 = Date.now() - 1_000_000
    for (let i = 0; i < 12; i++) {
      const ts = t0 + i * 10_000
      hs.saveAgentRecord(companionRec(`real_${i}`, {
        timestamp: ts,
        userTask: `真对话 ${i}`,
        steps: [
          { id: `ut-${i}`, type: 'user_task', content: `真对话 ${i}`, timestamp: ts }
        ]
      }))
    }

    const merged = new Companion(hs).getMergedViewRecord()
    expect(merged).not.toBeNull()
    const contents = (merged!.steps ?? []).map(s => s.content)
    expect(contents).not.toContain('真对话 0')
    expect(contents).not.toContain('真对话 1')
    expect(contents).toContain('真对话 2')
    expect(contents).toContain('真对话 11')
  })
})
