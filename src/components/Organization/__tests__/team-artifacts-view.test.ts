// @vitest-environment jsdom
import { createApp, h, nextTick, reactive, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCanvasArtifactId, type OrganizationArtifactView } from '@shared/types'
import OrganizationTeamArtifacts from '../OrganizationTeamArtifacts.vue'
import OrganizationChart from '../OrganizationChart.vue'

type TerminalFixture = { tabs: Array<{ id: string; agentState: { sessionId: string; steps: Array<{ id: string; organization: { sessionId: string; teams: []; total: number; live: number; members: Array<{ name: string; parent: string; team: string; status: string }> } }> } }> }
const fixture = vi.hoisted(() => ({ terminal: null as TerminalFixture | null, exists: vi.fn(), open: vi.fn(), persist: vi.fn(), closeTab: vi.fn(), openTabs: [] as Array<{ id: string }> }))
vi.mock('../../../stores/terminal', () => ({ useTerminalStore: () => fixture.terminal }))
vi.mock('../OrganizationBranch.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['groups', 'depth'], emits: ['openArtifacts'], setup(_, { emit }) { return () => h('button', { class: 'open-team-artifacts', onClick: () => emit('openArtifacts', { name: '团', owner: '甲' }) }, '产出物') } }) }
})
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@sailfish/workbench-assistant/artifact', async () => ({
  ...await import('@sailfish/workbench-assistant/artifact/domain/artifact-close-shortcut'),
  checkFilePathExists: (...args: unknown[]) => fixture.exists(...args),
  requireArtifactDesktopHost: () => ({ persistArtifacts: fixture.persist }),
  useAssistantArtifactStore: () => ({
    getArtifactById: () => null, open: fixture.open, setActiveArtifact: vi.fn(),
    getOpenArtifacts: () => fixture.openTabs, getActiveArtifact: () => null, closeTab: fixture.closeTab, minimizePanel: vi.fn(), isVisible: () => true, isArtifactDirty: () => false,
  }),
}))
vi.mock('@sailfish/workbench-assistant/artifact/domain/artifact-content-loader', () => ({ loadArtifactContentFromDisk: vi.fn() }))
vi.mock('@sailfish/workbench-assistant/artifact/components/ArtifactPanel.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ emits: ['closePreview'], setup(_, { expose, emit }) { expose({ flushDraft: vi.fn(), deactivate: vi.fn() }); return () => h('div', { class: 'artifact-preview-stub' }, [h('button', { class: 'end-preview', onClick: () => emit('closePreview') }, '结束预览')]) } }) }
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
  vi.useFakeTimers(); vi.clearAllMocks(); view.stepId = 'dispatch'; fixture.openTabs = []
  // jsdom 不测布局，实际尺寸与拖动由隔离 Electron 回归覆盖。
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  fixture.exists.mockResolvedValue(true)
  fixture.terminal = reactive({ tabs: [{ id: 'tab', agentState: { sessionId: 'current', steps: [{ id: 'dispatch', organization: { sessionId: 'old', teams: [], total: 1, live: 1, members: [{ name: '甲员', parent: '甲', team: '团', status: 'running' }] } }] } }] })
  readArtifacts = vi.fn(async (session: string) => session === 'old' ? [artifact] : [])
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { history: { readTeamArtifacts: readArtifacts } } })
})
afterEach(() => { app?.unmount(); app = undefined; container?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (window as unknown as { electronAPI?: unknown }).electronAPI })

describe('团队产出物的实时边界', () => {
  it('文件关闭只回成果列表，保持当前对象标题和右侧详情', async () => {
    mount(true); await settle()
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click(); await settle()
    const header = container.querySelector('.od-header')
    container.querySelector<HTMLButtonElement>('.oa-item')!.click(); await settle()
    expect(container.querySelector('.artifact-preview-stub')).not.toBeNull()
    expect(container.querySelector('.oa-header')).toBeNull()
    container.querySelector<HTMLButtonElement>('.end-preview')!.click(); await settle()
    expect(container.querySelector('.artifact-preview-stub')).toBeNull()
    expect(container.querySelector('.oa-list')).not.toBeNull()
    expect(container.querySelector('.od-header')).toBe(header)
    expect(container.querySelector('.oc-detail')).not.toBeNull()
    expect(fixture.closeTab).toHaveBeenCalledWith('tab', resolveCanvasArtifactId(artifact.data))
  })
  it('预览原本已打开的文件时，返回不关闭用户原有页签', async () => {
    fixture.openTabs = [{ id: resolveCanvasArtifactId(artifact.data) }]
    mount(true); await settle()
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click(); await settle()
    container.querySelector<HTMLButtonElement>('.end-preview')!.click(); await settle()
    expect(fixture.closeTab).not.toHaveBeenCalled()
  })
  it('同对象切页签保留文件预览，键盘切回后标题与焦点稳定', async () => {
    mount(true); await settle()
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click(); await settle()
    const preview = container.querySelector('.artifact-preview-stub')
    const header = container.querySelector('.od-header')
    const tabs = container.querySelectorAll<HTMLButtonElement>('.od-tabs button')
    tabs[0].click(); await settle()
    expect(container.querySelector('.artifact-preview-stub')).toBe(preview)
    expect(container.querySelector('.org-artifacts')?.closest<HTMLElement>('.od-pane')?.style.display).toBe('none')
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await settle()
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tabs[1])
    expect(container.querySelector('.artifact-preview-stub')).toBe(preview)
    expect(container.querySelector('.od-header')).toBe(header)
  })
  it('总览与右侧详情都只提供关闭，不再有铺满入口', async () => {
    mount(true); await settle()
    expect(container.querySelector('.oc-header .tph-close')).not.toBeNull()
    expect(container.querySelector('.oc-header .tph-focus')).toBeNull()
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click(); await settle()
    expect(container.querySelector('.od-header .tph-close')).not.toBeNull()
    expect(container.querySelector('.od-header .tph-focus')).toBeNull()
    expect(container.querySelector('.oc-header .tph-focus')).toBeNull()
  })
  it('文件检查尚未返回时切走成果，不让迟到请求打开隐藏预览', async () => {
    let finish!: (exists: boolean) => void
    fixture.exists.mockReturnValue(new Promise<boolean>(resolve => { finish = resolve }))
    mount(true); await settle()
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click(); await settle()
    container.querySelector<HTMLButtonElement>('.oa-item')!.click()
    container.querySelector<HTMLButtonElement>('.od-tabs button')!.click(); await settle()
    finish(true); await settle()
    expect(fixture.open).not.toHaveBeenCalled()
    expect(container.querySelector('.artifact-preview-stub')).toBeNull()
    const calls = readArtifacts.mock.calls.length
    await vi.advanceTimersByTimeAsync(3500); await settle()
    expect(readArtifacts).toHaveBeenCalledTimes(calls)
  })
  it('右侧查看成果和关闭时保留同一团队图，不卸载总览', async () => {
    mount(true); await settle()
    const overview = container.querySelector('.oc-body')
    container.querySelector<HTMLButtonElement>('.open-team-artifacts')!.click(); await settle()
    expect(container.querySelector('.oc-detail .org-artifacts')).not.toBeNull()
    expect(container.querySelector('.oc-overview .oc-body')).toBe(overview)
    expect(container.querySelector('.oc-detail.is-focus')).toBeNull()
    expect(container.querySelector('.oc-overview')?.hasAttribute('inert')).toBe(false)
    container.querySelector<HTMLButtonElement>('.od-header .tph-close')!.click(); await settle()
    expect(container.querySelector('.oc-detail')).toBeNull()
    expect(container.querySelector('.oc-overview .oc-body')).toBe(overview)
    expect(container.querySelector('.oc-overview')?.hasAttribute('inert')).toBe(false)
  })
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
