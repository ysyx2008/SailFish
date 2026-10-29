import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentRecord } from '@shared/types'
import { SubAgentRecordStore } from '../sub-agent-record-store'
import { readTeamMember } from '../team-member'
import { readTeamArtifacts } from '../team-artifacts'
let directory: string
let store: SubAgentRecordStore
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-member-')); store = new SubAgentRecordStore(directory) })
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))
it('按选中成员异步读过程与产出，不扫描所有成员，不读取模型对话', async () => {
  const recorder = store.recorderFor({ sessionId: 'session', startedAt: Date.now(), name: '甲' })!
  recorder.saveState({ name: '甲', description: '核对职责', prompt: '核对文件', status: 'completed', role: '测试', result: '核对通过' })
  recorder.saveRecord({ id: '甲', timestamp: Date.now(), messages: [], steps: [{ id: 'tool', type: 'tool_call', timestamp: 1, content: '', toolName: 'read_file', toolArgs: { path: '/tmp/report.md' }, success: true }], status: 'completed' } as unknown as AgentRecord)
  const list = vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('不应扫描其他成员') })
  const full = vi.spyOn(store, 'readRecord').mockImplementation(() => { throw new Error('不应读模型对话') })
  expect(await readTeamMember(store, 'session', '甲')).toMatchObject({ name: '甲', role: '测试', result: '核对通过', steps: [{ tool: 'read_file', status: 'completed' }] })
  expect(await readTeamArtifacts(store, 'session', { member: '甲' })).toMatchObject([{ member: '甲', kind: 'result', data: { content: '核对通过' } }])
  expect(list).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled()
  expect(await readTeamMember(store, '../session', '甲')).toBeUndefined()
  expect(await readTeamMember(store, 'session', '别人')).toBeUndefined()
  expect(await readTeamArtifacts(store, 'session', { member: '别人' })).toEqual([])
})
