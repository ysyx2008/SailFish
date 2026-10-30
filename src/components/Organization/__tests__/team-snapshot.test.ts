import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, reactive } from 'vue'
import type { OrganizationView } from '@shared/types'
import { useTeamSnapshot } from '../team-snapshot'

const view = (name: string): OrganizationView => ({ sessionId: name, total: 1, live: 1, teams: [], members: [{ id: name, name, status: 'running', description: '核对', activity: { tool: 'read_file', args: '第一份', status: 'running' } }] })
afterEach(() => vi.useRealTimers())
describe('团队显示快照', () => {
  it('同一窗口内合并更新，未刷新前不会因原对象变化而泄漏半份状态', async () => {
    vi.useFakeTimers()
    const state = reactive({ view: view('甲'), key: '甲' })
    const scope = effectScope()
    const snapshot = scope.run(() => useTeamSnapshot(() => state.view, () => state.key))!
    state.view.members[0].activity!.args = '第二份'
    await nextTick()
    state.view.members[0].status = 'completed'
    state.view.members[0].activity!.args = '第三份'
    await nextTick()
    expect(snapshot.value!.members[0].activity!.args).toBe('第一份')
    expect(snapshot.value!.members[0].status).toBe('running')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(snapshot.value!.members[0].activity!.args).toBe('第三份')
    expect(snapshot.value!.members[0].status).toBe('completed')
    scope.stop()
  })
  it('换任务立即切换，旧任务的待刷新数据不能回写，卸载清理定时器', async () => {
    vi.useFakeTimers()
    const state = reactive({ view: view('甲'), key: '甲' })
    const scope = effectScope()
    const snapshot = scope.run(() => useTeamSnapshot(() => state.view, () => state.key))!
    state.view.live = 0
    await nextTick()
    state.key = '乙'; state.view = view('乙')
    await nextTick()
    expect(snapshot.value!.sessionId).toBe('乙')
    await vi.advanceTimersByTimeAsync(100)
    expect(snapshot.value!.sessionId).toBe('乙')
    state.view.live = 0
    await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    scope.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
