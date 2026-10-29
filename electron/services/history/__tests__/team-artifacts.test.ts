import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentRecord, CanvasData } from '@shared/types'
import { SubAgentRecordStore, type ChildStateInput } from '../sub-agent-record-store'
import { readTeamArtifacts } from '../team-artifacts'

let dir: string
let store: SubAgentRecordStore
const at = Date.UTC(2026, 9, 29)
function save(name: string, owner: string | undefined, team: string, data: Array<CanvasData & { failed?: boolean }>, result?: string, sessionId = 'session') {
  const recorder = store.recorderFor({ sessionId, startedAt: at, name })!
  recorder.saveState({ name, parent: owner, team, description: 'fixture', prompt: 'fixture', status: 'completed', result } satisfies ChildStateInput)
  recorder.saveRecord({ id: name, timestamp: at, steps: data.map(({ failed, ...canvasData }, i) => ({ id: `${name}-${i}`, type: 'tool_result', timestamp: at + i, canvasData, ...(failed ? { success: false } : {}) })), messages: [], status: 'completed' } as unknown as AgentRecord)
}
const file = (filePath: string, extra: Partial<CanvasData> = {}): CanvasData => ({ action: 'open', renderer: 'markdown', filePath, contentFromFile: true, ...extra })
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-artifacts-')); store = new SubAgentRecordStore(dir) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('团队成果读取', () => {
  it('同名团按负责人隔离，其他会话与下级团不混入', () => {
    save('甲员', '甲', '项目团', [file('/tmp/a.md')], '甲的结果')
    save('乙员', '乙', '项目团', [file('/tmp/b.md')])
    save('子员', '子组长', '项目团', [file('/tmp/nested.md')])
    save('别人', '甲', '项目团', [file('/tmp/other-session.md')], undefined, 'other')
    const artifacts = readTeamArtifacts(store, 'session', { name: '项目团', owner: '甲' })
    expect(artifacts.map(a => a.member)).toEqual(['甲员', '甲员'])
    expect(artifacts[0].data.filePath).toBe('/tmp/a.md')
    expect(artifacts[1]).toMatchObject({ kind: 'result', data: { content: '甲的结果' } })
    expect(readTeamArtifacts(store, 'session', { name: '项目团' })).toEqual([])
  })
  it('同一文件更新合并，关闭预览保留成果，失败步骤不登记，文件内容不重复传输', () => {
    save('甲员', '甲', '团', [
      file('/tmp/a.md', { title: '第一版', content: 'huge', sourceStepId: 'child-step' }),
      file('/tmp/a.md', { action: 'update', title: '第二版' }),
      file('/tmp/a.md', { action: 'close' }),
      { ...file('/tmp/failed.md'), failed: true },
    ])
    const artifacts = readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].data).toMatchObject({ action: 'open', title: '第二版', filePath: '/tmp/a.md', artifactId: 'file:/tmp/a.md', activate: false })
    expect(artifacts[0].data.content).toBeUndefined()
    expect(artifacts[0].data.sourceStepId).toBeUndefined()
  })
  it('成员局部 ID 和同名内嵌稿不互相覆盖，更新仍跟到原文件', () => {
    save('甲员', '甲', '团', [
      file('/tmp/a.md', { artifactId: 'report' }),
      { action: 'update', renderer: 'markdown', artifactId: 'report', title: '更新标题' },
      { action: 'open', renderer: 'markdown', title: '同名内嵌稿', content: '甲的稿' },
    ])
    save('乙员', '甲', '团', [file('/tmp/b.md', { artifactId: 'report' }), { action: 'open', renderer: 'markdown', title: '同名内嵌稿', content: '乙的稿' }])
    const artifacts = readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts).toHaveLength(4)
    expect(artifacts.find(item => item.data.filePath === '/tmp/a.md')?.data.title).toBe('更新标题')
    expect(new Set(artifacts.map(item => item.data.artifactId)).size).toBe(4)
    expect(new Set(artifacts.filter(item => !item.data.filePath).map(item => item.data.content))).toEqual(new Set(['甲的稿', '乙的稿']))
  })
  it('负责人本人的汇总单列共享，不冒充团员或其他枝负责人', () => {
    save('甲员', '甲', '团', [file('/tmp/member.md')])
    save('甲', undefined, '上级团', [file('/tmp/lead.md')], '负责人汇总')
    const persisted = store.list('session').find(child => child.state.name === '甲')!
    const saved = JSON.parse(fs.readFileSync(path.join(persisted.dir, 'state.json'), 'utf8'))
    fs.writeFileSync(path.join(persisted.dir, 'state.json'), JSON.stringify({ ...saved, lead: true }))
    const artifacts = readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts.filter(item => item.producerRole === 'lead').map(item => item.member)).toEqual(['甲', '甲'])
    expect(artifacts.find(item => item.data.filePath === '/tmp/member.md')?.producerRole).toBeUndefined()
    expect(readTeamArtifacts(store, 'session', { name: '不存在的团', owner: '甲' })).toEqual([])
  })
  it('重建存储实例后仍读得到成果，空团与非法会话路径安全返回空', () => {
    save('甲员', '甲', '团', [file('/tmp/a.md')])
    const reopened = new SubAgentRecordStore(dir)
    expect(readTeamArtifacts(reopened, 'session', { name: '团', owner: '甲' })).toHaveLength(1)
    expect(readTeamArtifacts(reopened, 'session', { name: '空团', owner: '甲' })).toEqual([])
    expect(readTeamArtifacts(reopened, '../session', { name: '团', owner: '甲' })).toEqual([])
  })
})
