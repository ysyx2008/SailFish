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
  it('同名团按负责人隔离，其他会话与下级团不混入', async () => {
    save('甲员', '甲', '项目团', [file('/tmp/a.md')], '甲的结果')
    save('乙员', '乙', '项目团', [file('/tmp/b.md')])
    save('子员', '子组长', '项目团', [file('/tmp/nested.md')])
    save('别人', '甲', '项目团', [file('/tmp/other-session.md')], undefined, 'other')
    const artifacts = await readTeamArtifacts(store, 'session', { name: '项目团', owner: '甲' })
    expect(artifacts.map(a => a.member)).toEqual(['甲员', '甲员'])
    expect(artifacts[0].data.filePath).toBe('/tmp/a.md')
    expect(artifacts[1]).toMatchObject({ kind: 'result', data: { content: '甲的结果' } })
    expect(await readTeamArtifacts(store, 'session', { name: '项目团' })).toEqual([])
  })
  it('同一文件更新合并，关闭预览保留成果，失败步骤不登记，文件内容不重复传输', async () => {
    save('甲员', '甲', '团', [
      file('/tmp/a.md', { title: '第一版', content: 'huge', sourceStepId: 'child-step' }),
      file('/tmp/a.md', { action: 'update', title: '第二版' }),
      file('/tmp/a.md', { action: 'close' }),
      { ...file('/tmp/failed.md'), failed: true },
    ])
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].data).toMatchObject({ action: 'open', title: '第二版', filePath: '/tmp/a.md', artifactId: 'file:/tmp/a.md', activate: false })
    expect(artifacts[0].data.content).toBeUndefined()
    expect(artifacts[0].data.sourceStepId).toBeUndefined()
  })
  it('成员局部 ID 和同名内嵌稿不互相覆盖，更新仍跟到原文件', async () => {
    save('甲员', '甲', '团', [
      file('/tmp/a.md', { artifactId: 'report' }),
      { action: 'update', renderer: 'markdown', artifactId: 'report', title: '更新标题' },
      { action: 'open', renderer: 'markdown', title: '同名内嵌稿', content: '甲的稿' },
    ])
    save('乙员', '甲', '团', [file('/tmp/b.md', { artifactId: 'report' }), { action: 'open', renderer: 'markdown', title: '同名内嵌稿', content: '乙的稿' }])
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts).toHaveLength(4)
    expect(artifacts.find(item => item.data.filePath === '/tmp/a.md')?.data.title).toBe('更新标题')
    expect(new Set(artifacts.map(item => item.data.artifactId)).size).toBe(4)
    expect(new Set(artifacts.filter(item => !item.data.filePath).map(item => item.data.content))).toEqual(new Set(['甲的稿', '乙的稿']))
  })
  it('共同编辑同一路径时，来源与负责人分组保持最初登记者', async () => {
    save('甲员', '甲', '团', [file('/tmp/member.md'), file('/tmp/lead.md', { action: 'update' })])
    save('甲', undefined, '上级团', [file('/tmp/lead.md'), file('/tmp/member.md', { action: 'update' })])
    const lead = store.list('session').find(child => child.state.name === '甲')!
    const stateFile = path.join(lead.dir, 'state.json')
    fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, 'utf8')), lead: true }))
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts.find(item => item.data.filePath === '/tmp/member.md')).toMatchObject({ member: '甲员' })
    expect(artifacts.find(item => item.data.filePath === '/tmp/member.md')?.producerRole).toBeUndefined()
    expect(artifacts.find(item => item.data.filePath === '/tmp/lead.md')).toMatchObject({ member: '甲', producerRole: 'lead' })
  })
  it('无标识更新按渲染类型寻找最近成果，不把 Markdown 写进 HTML', async () => {
    save('甲员', '甲', '团', [
      { action: 'open', renderer: 'markdown', title: '稿', content: '旧稿' },
      { action: 'open', renderer: 'html', title: '网页', content: '<p>网页</p>' },
      { action: 'update', renderer: 'markdown', content: '新稿' },
    ])
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts.find(item => item.data.title === '稿')?.data.content).toBe('新稿')
    expect(artifacts.find(item => item.data.title === '网页')?.data).toMatchObject({ renderer: 'html', content: '<p>网页</p>' })
  })
  it('带标题但没有定位键的更新仍按同类型最近成果定位', async () => {
    save('甲员', '甲', '团', [
      { action: 'open', renderer: 'markdown', title: '早先稿', content: '保留' },
      { action: 'open', renderer: 'markdown', title: '当前稿', content: '待改' },
      { action: 'update', renderer: 'markdown', title: '早先稿', content: '更新当前稿' },
    ])
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts.map(item => item.data.content)).toEqual(['保留', '更新当前稿'])
  })
  it('成果索引不依赖消息全文可读，只异步读取步骤', async () => {
    save('甲员', '甲', '团', [file('/tmp/a.md')])
    const child = store.list('session')[0]
    const messages = path.join(child.dir, 'messages.jsonl')
    fs.rmSync(messages, { force: true }); fs.mkdirSync(messages)
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].data.filePath).toBe('/tmp/a.md')
  })
  it('负责人本人的汇总单列共享，不冒充团员或其他枝负责人', async () => {
    save('甲员', '甲', '团', [file('/tmp/member.md')])
    save('甲', undefined, '上级团', [file('/tmp/lead.md')], '负责人汇总')
    const persisted = store.list('session').find(child => child.state.name === '甲')!
    const saved = JSON.parse(fs.readFileSync(path.join(persisted.dir, 'state.json'), 'utf8'))
    fs.writeFileSync(path.join(persisted.dir, 'state.json'), JSON.stringify({ ...saved, lead: true }))
    const artifacts = await readTeamArtifacts(store, 'session', { name: '团', owner: '甲' })
    expect(artifacts.filter(item => item.producerRole === 'lead').map(item => item.member)).toEqual(['甲', '甲'])
    expect(artifacts.find(item => item.data.filePath === '/tmp/member.md')?.producerRole).toBeUndefined()
    expect(await readTeamArtifacts(store, 'session', { name: '不存在的团', owner: '甲' })).toEqual([])
  })
  it('重建存储实例后仍读得到成果，空团与非法会话路径安全返回空', async () => {
    save('甲员', '甲', '团', [file('/tmp/a.md')])
    const reopened = new SubAgentRecordStore(dir)
    expect(await readTeamArtifacts(reopened, 'session', { name: '团', owner: '甲' })).toHaveLength(1)
    expect(await readTeamArtifacts(reopened, 'session', { name: '空团', owner: '甲' })).toEqual([])
    expect(await readTeamArtifacts(reopened, '../session', { name: '团', owner: '甲' })).toEqual([])
  })
})
