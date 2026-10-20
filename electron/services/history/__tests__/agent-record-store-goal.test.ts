/**
 * 任务上挂着的目标要跟这场对话一起落盘：重启后还在（连同已经花掉的用量），
 * 清掉之后重启也不能又冒出来。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentRecordStore } from '../agent-record-store'
import type { AgentRecord, GoalContract } from '@shared/types'

function makeRecord(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    timestamp: Date.now(),
    terminalId: '',
    agentKey: `assistant-${id}`,
    terminalType: 'assistant',
    userTask: '全面测试goal功能',
    steps: [
      { id: `${id}-u`, type: 'user_task', content: '全面测试goal功能', timestamp: Date.now() },
      { id: `${id}-f`, type: 'final_result', content: '好了', timestamp: Date.now() },
    ],
    duration: 1,
    status: 'completed',
    ...extra,
  }
}

const GOAL: GoalContract = {
  goalId: 'goal-1',
  objective: '全面测试goal功能',
  status: 'paused',
  tokensUsed: 1_900_000,
  timeUsedSeconds: 191,
  createdAt: 1_000,
  updatedAt: 2_000,
}

describe('AgentRecordStore 目标', () => {
  let dir: string
  let store: AgentRecordStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-record-goal-'))
    store = new AgentRecordStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('存了再按 id 读回来，目标和已花的用量都在', () => {
    store.saveAgentRecord(makeRecord('with-goal', { goal: GOAL }))
    expect(store.getAgentRecordById('with-goal')?.goal).toEqual(GOAL)
  })

  it('没挂过目标的会话读回来也没有目标', () => {
    store.saveAgentRecord(makeRecord('plain'))
    expect(store.getAgentRecordById('plain')?.goal).toBeUndefined()
  })

  it('同一场会话后来把目标清掉，再存就没有了，不会沿用旧的', () => {
    store.saveAgentRecord(makeRecord('cleared', { goal: GOAL }))
    store.saveAgentRecord(makeRecord('cleared'))
    expect(store.getAgentRecordById('cleared')?.goal).toBeUndefined()
  })

  it('改标题只动标题，目标不丢', () => {
    store.saveAgentRecord(makeRecord('renamed', { goal: GOAL }))
    expect(store.updateTitle('renamed', '新标题')).toBe(true)
    const record = store.getAgentRecordById('renamed')
    expect(record?.title).toBe('新标题')
    expect(record?.goal).toEqual(GOAL)
  })
})
