// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrganizationArtifactView } from '@shared/types'
import OrganizationTeamArtifacts from '../OrganizationTeamArtifacts.vue'
import OrganizationChart from '../OrganizationChart.vue'

type TerminalFixture = { tabs: Array<{ id: string; agentState: { sessionId: string; steps: Array<{ id: string; organization: { sessionId: string; teams: []; total: number; live: number; members: Array<{ name: string; parent: string; team: string; status: string }> } }> } }> }
const fixture = vi.hoisted(() => ({ terminal: null as TerminalFixture | null, exists: vi.fn(), open: vi.fn(), persist: vi.fn() }))
vi.mock('../../../stores/terminal', () => ({ useTerminalStore: () => fixture.terminal }))
vi.mock('../OrganizationBranch.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['groups', 'depth'], emits: ['openArtifacts'], setup(_, { emit }) { return () => h('button', { class: 'open-team-artifacts', onClick: () => emit('openArtifacts', { name: '团', owner: '甲' }) }, '产出物') } }) }
})
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@sailfish/workbench-assistant/artifact', () => ({
  checkFilePathExists: (...args: unknown[]) => fixture.exists(...args),
  requireArtifactDesktopHost: () => ({ persistArtifacts: fixture.persist }),
  useAssistantArtifactStore: () => ({
    getArtifactById: () => null, open: fixture.open, setActiveArtifact: vi.fn(),
    getOpenArtifacts: () => [], isVisible: () => true, isArtifactDirty: () => false,
  }),
}))
vi.mock('@sailfish/workbench-assistant/artifact/domain/artifact-content-loader', () => ({ loadArtifactContentFromDisk: vi.fn() }))
vi.mock('@sailfish/workbench-assistant/artifact/components/ArtifactPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ setup(_, { expose }) { expose({ flushDraft: vi.fn() }); return () => h('div', { class: 'artifact-preview-stub' }) } }) }
})
const artifact: OrganizationArtifactView = { member: '甲员', kind: 'file', data: { action: 'open', renderer: 'markdown', title: '成果', filePath: '/tmp/team-result.md' } }
const view = reactive({ stepId: 'dispatch' })
let app: App | undefined
let container: HTMLDivElement
let readArtifacts: ReturnType<typeof vi.fn>
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick() }
function mount(chart = false) {
  container = document.createElement('div'); document.body.append(container)
  app = createApp({ setup: () => () => h(chart ? OrganizationChart : OrganizationTeamArtifacts, { tabId: 'tab', stepId: view.stepId, focusActive: false, ...(chart ? {} : { team: { name: '团', owner: '甲' } }) }) })
  app.mount(container)
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); view.stepId = 'dispatch'
  fixture.exists.mockResolvedValue(true)
  fixture.terminal = reactive({ tabs: [{ id: 'tab', agentState: { sessionId: 'current', steps: [{ id: 'dispatch', organization: { sessionId: 'old', teams: [], total: 1, live: 1, members: [{ name: '甲员', parent: '甲', team: '团', status: 'running' }] } }] } }] })
  readArtifacts = vi.fn(async (session: string) => session === 'old' ? [artifact] : [])
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { history: { readTeamArtifacts: readArtifacts } } })
})
afterEach(() => { app?.unmount(); app = undefined; container?.remove(); vi.useRealTimers(); delete (window as unknown as { electronAPI?: unknown }).electronAPI })

describe('团队产出物的实时边界', () => {
  it('切换原会话后，不让旧的文件存在性检查重新打开旧成果', async () => {
    let finish!: (exists: boolean) => void
    fixture.exists.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve }))
    mount(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click()
    fixture.terminal!.tabs[0].agentState.steps[0].organization.sessionId = 'new'
    await settle()
    finish(true); await settle()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(container.querySelector('.artifact-preview-stub')).toBeNull()
  })
  it('同一会话切换组织步骤时回到新组织图，不保留旧团队清单', async () => {
    mount(true); await settle()
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click()
    await settle()
    expect(container.querySelector('.org-artifacts')).not.toBeNull()
    view.stepId = 'another-dispatch'; await settle()
    expect(container.querySelector('.org-artifacts')).toBeNull()
    expect(container.querySelector('.oc-empty')).not.toBeNull()
  })
  it('缺失文件后点击刷新，清除过期的错误提示', async () => {
    fixture.exists.mockResolvedValue(false)
    mount(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click(); await settle()
    expect(container.querySelector('.oa-error')).not.toBeNull()
    fixture.exists.mockResolvedValue(true)
    container.querySelector<HTMLButtonElement>('.oa-refresh')!.click(); await settle()
    expect(container.querySelector('.oa-error')).toBeNull()
  })
  it('后台轮询不清除用户尚未处理的缺失文件提示', async () => {
    fixture.exists.mockResolvedValue(false)
    mount(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click(); await settle()
    await vi.advanceTimersByTimeAsync(3500); await settle()
    expect(container.querySelector('.oa-error')).not.toBeNull()
  })
  it('从预览返回时补读最后交回的成果', async () => {
    mount(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click(); await settle()
    expect(container.querySelector('.artifact-preview-stub')).not.toBeNull()
    readArtifacts.mockResolvedValue([artifact, { member: '乙员', kind: 'result', data: { action: 'open', renderer: 'markdown', artifactId: 'new-result', content: '新交回结果' } }])
    container.querySelector<HTMLButtonElement>('.oa-header .tph-back')!.click(); await settle()
    expect(container.querySelectorAll('.oa-item')).toHaveLength(2)
  })
  it('团队在轮询前收工，最后一批成果仍会刷新出来', async () => {
    readArtifacts.mockResolvedValueOnce([]).mockResolvedValue([artifact])
    mount(); await settle()
    expect(container.querySelector('.oa-item')).toBeNull()
    fixture.terminal!.tabs[0].agentState.steps[0].organization.members[0].status = 'completed'
    await settle(); await vi.advanceTimersByTimeAsync(3500); await settle()
    expect(container.querySelector('.oa-item')?.textContent).toContain('成果')
  })
})
