/**
 * 联络派的任务带出身：侧栏列表读的是历史索引的摘要，不读每条会话的正文，
 * 所以出身得在摘要里直接带着；索引丢了重建后也得还在。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentRecordStore } from '../agent-record-store'
import type { AgentRecord } from '@shared/types'

function makeRecord(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    timestamp: Date.now(),
    terminalId: '',
    agentKey: `assistant-${id}`,
    terminalType: 'assistant',
    userTask: '整理一下日志',
    steps: [
      { id: `${id}-u`, type: 'user_task', content: '整理一下日志', timestamp: Date.now() },
      { id: `${id}-f`, type: 'final_result', content: '好了', timestamp: Date.now() },
    ],
    duration: 1,
    status: 'completed',
    ...extra,
  }
}

describe('AgentRecordStore 出身（谁派的）', () => {
  let dir: string
  let store: AgentRecordStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-record-assigned-'))
    store = new AgentRecordStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('列表摘要带出身；用户自己开的没有这一项', () => {
    store.saveAgentRecord(makeRecord('assigned', { assignedBy: 'companion' }))
    store.saveAgentRecord(makeRecord('mine'))

    const summaries = store.listAgentHistorySummaries(true)
    expect(summaries.find(s => s.id === 'assigned')?.assignedBy).toBe('companion')
    expect(summaries.find(s => s.id === 'mine')?.assignedBy).toBeUndefined()
  })

  it('索引重建后出身还在（索引只是缓存，真相在会话记录上）', () => {
    store.saveAgentRecord(makeRecord('assigned', { assignedBy: 'companion' }))
    store.saveAgentRecord(makeRecord('mine'))

    store.rebuildAgentIndex()

    const summaries = store.listAgentHistorySummaries(true)
    expect(summaries.find(s => s.id === 'assigned')?.assignedBy).toBe('companion')
    expect(summaries.find(s => s.id === 'mine')?.assignedBy).toBeUndefined()
  })

  it('按 id 读回的完整记录带出身', () => {
    store.saveAgentRecord(makeRecord('assigned', { assignedBy: 'companion' }))
    expect(store.getAgentRecordById('assigned')?.assignedBy).toBe('companion')
  })
})
