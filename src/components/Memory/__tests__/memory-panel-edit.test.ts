/**
 * @vitest-environment jsdom
 */
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '../../../i18n/locales/zh-CN'
import MemoryPanel from '../MemoryPanel.vue'
import { showConfirm, showAlert } from '../../../composables/useConfirm'

vi.mock('../../../composables/useConfirm', () => ({
  showConfirm: vi.fn(async () => true),
  showAlert: vi.fn(async () => undefined),
}))

/** 磁盘上的「用户」记忆；测试里可以随时模拟 AI 在对话后改了它 */
const store = { personal: '# 用户\n\n## 身份与职责\n运维\n\n## 偏好与约定\n简短', updatedAt: 1_700_000_000_000 }
const setCalls: Array<{ content: string; base?: string }> = []

function installApi() {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    knowledge: {
      isInitialized: async () => true,
      getSettings: async () => ({ enabled: true }),
      onReady: () => () => undefined,
      getDocuments: async () => [],
      listFolders: async () => [],
    },
    contextKnowledge: {
      list: async () => ({
        success: true,
        items: [{ contextId: 'personal', content: store.personal, updatedAt: store.updatedAt }],
        maxDocChars: 5000,
      }),
      set: async (_id: string, content: string, base?: string) => {
        setCalls.push({ content, base })
        if (base !== undefined && base !== store.personal) return { success: false, conflict: true, latest: store.personal }
        store.personal = content
        return { success: true }
      },
    },
    config: { getAiProfiles: async () => [] },
  }
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(MemoryPanel)
  app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } }))
  app.mount(el)
  return { el, app }
}

function saveButton(el: HTMLElement) {
  return [...el.querySelectorAll('button')].find(b => b.textContent?.includes('保存')) as HTMLButtonElement
}

async function type(el: HTMLElement, value: string) {
  const area = el.querySelector('.editor-textarea') as HTMLTextAreaElement
  area.value = value
  area.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('记忆栏目：列表与编辑冲突', () => {
  beforeEach(() => {
    store.personal = '# 用户\n\n## 身份与职责\n运维\n\n## 偏好与约定\n简短'
    setCalls.length = 0
    vi.mocked(showConfirm).mockReset().mockResolvedValue(true)
    vi.mocked(showAlert).mockReset().mockResolvedValue(undefined)
    installApi()
    document.body.innerHTML = ''
  })
  afterEach(() => { vi.useRealTimers() })

  it('列表里看得到主题段、字数和更新时间', async () => {
    const { el, app } = mount()
    await settle()
    const item = el.querySelector('.memory-item') as HTMLElement
    expect(item.textContent).toContain('身份与职责 · 偏好与约定')
    expect(item.textContent).toMatch(/\d+ \/ 5000 字/)
    expect(item.textContent).toContain('更新于')
    app.unmount()
  })

  it('没有未保存改动时，AI 改了之后会自动读到最新内容', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    expect((el.querySelector('.editor-textarea') as HTMLTextAreaElement).value).toContain('运维')

    store.personal = '# 用户\n\n## 身份与职责\n运维负责人'
    vi.advanceTimersByTime(15_000)
    await settle()
    expect((el.querySelector('.editor-textarea') as HTMLTextAreaElement).value).toContain('运维负责人')
    app.unmount()
  })

  it('有未保存改动时，自动刷新不替用户换文字', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    await type(el, '我正在改的')

    store.personal = 'AI 刚写的'
    vi.advanceTimersByTime(15_000)
    await settle()
    expect((el.querySelector('.editor-textarea') as HTMLTextAreaElement).value).toBe('我正在改的')
    app.unmount()
  })

  it('保存时发现被改过：选「载入最新」就不覆盖', async () => {
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    await type(el, '我改的')

    store.personal = 'AI 刚写的'
    // 点中间那个「放弃我的修改，载入最新」
    vi.mocked(showConfirm).mockImplementation(async (opts) => { opts.onNeutral?.(); return false })
    saveButton(el).click()
    await settle()

    expect(store.personal).toBe('AI 刚写的')
    expect((el.querySelector('.editor-textarea') as HTMLTextAreaElement).value).toBe('AI 刚写的')
    expect(el.textContent).not.toContain('未保存')
    app.unmount()
  })

  it('保存时发现被改过：Esc 关掉弹窗什么都不动，仍留在编辑状态', async () => {
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    await type(el, '我改的')

    store.personal = 'AI 刚写的'
    vi.mocked(showConfirm).mockResolvedValue(false)
    saveButton(el).click()
    await settle()

    expect(store.personal).toBe('AI 刚写的')
    expect((el.querySelector('.editor-textarea') as HTMLTextAreaElement).value).toBe('我改的')
    expect(el.textContent).toContain('未保存')
    app.unmount()
  })

  it('文本框限制在字数上限内，和服务端存下的一致', async () => {
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    expect((el.querySelector('.editor-textarea') as HTMLTextAreaElement).maxLength).toBe(5000)
    app.unmount()
  })

  it('保存时发现被改过：选「覆盖」就以用户的为准', async () => {
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    await type(el, '我改的')

    store.personal = 'AI 刚写的'
    saveButton(el).click()
    await settle()

    expect(store.personal).toBe('我改的')
    expect(setCalls).toHaveLength(2)
    expect(setCalls[1].base).toBe('AI 刚写的')
    app.unmount()
  })

  it('没被改过：一次保存就成功，不弹确认', async () => {
    const { el, app } = mount()
    await settle();
    (el.querySelector('.memory-item') as HTMLElement).click()
    await settle()
    await type(el, '我改的')
    saveButton(el).click()
    await settle()
    expect(store.personal).toBe('我改的')
    expect(showConfirm).not.toHaveBeenCalled()
    app.unmount()
  })
})
