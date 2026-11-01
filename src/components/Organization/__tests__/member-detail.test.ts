// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { SubAgentResult } from '@shared/types'
import OrganizationMemberDetail from '../OrganizationMemberDetail.vue'
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
afterEach(() => { delete (window as unknown as { electronAPI?: unknown }).electronAPI })
it('切换成员后，旧请求返回不会把别人的结果写入新成员面板', async () => {
  let resolve!: (member: SubAgentResult) => void
  const old = new Promise<SubAgentResult>(done => { resolve = done })
  const read = vi.fn().mockReturnValueOnce(old).mockResolvedValue({ id: '乙', name: '乙', description: '乙职责', status: 'completed', result: '乙的真实结果' })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { history: { readTeamMember: read } } })
  const selected = ref('甲')
  const container = document.createElement('div')
  const app = createApp({ setup: () => () => h(OrganizationMemberDetail, { sessionId: 'original', member: { id: selected.value, name: selected.value, description: `${selected.value}职责`, status: 'completed' }, focusActive: false }) })
  try {
    app.mount(container)
    selected.value = '乙'; await nextTick(); await Promise.resolve(); await nextTick()
    resolve({ id: '甲', name: '甲', description: '甲职责', status: 'completed', result: '甲的旧结果' })
    await Promise.resolve(); await nextTick()
    expect(container.textContent).toContain('乙的真实结果')
    expect(container.textContent).not.toContain('甲的旧结果')
    expect(read).toHaveBeenLastCalledWith('original', '乙')
  } finally { app.unmount() }
})

it.each(['running', 'completed'] as const)('成员%s时，完整过程不被最近两步的快照覆盖', async status => {
  const saved = Array.from({ length: 30 }, (_, i) => ({ id: `step${i}`, tool: 'read_file', args: `文件${i}`, status: 'completed' as const }))
  const read = vi.fn().mockResolvedValue({ id: '甲', name: '甲', description: '甲职责', status, steps: saved })
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { history: { readTeamMember: read } } })
  const container = document.createElement('div')
  const app = createApp({ render: () => h(OrganizationMemberDetail, { sessionId: 'original', member: { id: '甲', name: '甲', description: '甲职责', status }, snapshot: { id: '甲', description: '甲职责', status, steps: [{ ...saved[28] }, { ...saved[29], status: 'running' }] }, focusActive: false }) })
  try {
    app.mount(container); await Promise.resolve(); await nextTick()
    expect(container.querySelectorAll('.sa-step')).toHaveLength(30)
    expect(container.textContent).toContain('文件0')
    expect(container.querySelectorAll('.sa-step.running')).toHaveLength(status === 'running' ? 1 : 0)
  } finally { app.unmount() }
})
