/**
 * @vitest-environment jsdom
 */
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'
import zhCN from '../../../i18n/locales/zh-CN'
import KnowledgeSettings from '../KnowledgeSettings.vue'

const confirm = vi.hoisted(() => ({
  showConfirm: vi.fn(async () => true),
  showAlert: vi.fn(async () => undefined),
}))
vi.mock('../../../composables/useConfirm', () => confirm)

const removed: string[][] = []

function installApi() {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    knowledge: {
      isInitialized: async () => true,
      getSettings: async () => ({
        enabled: true,
        embeddingMode: 'local',
        localModel: 'lite',
        autoSaveUploads: true,
        chunkStrategy: 'paragraph',
        searchTopK: 10,
        enableRerank: true,
        enableHostMemory: true,
        cardProfileId: '',
        recallFolder: '',
      }),
      onReady: () => () => undefined,
      getDocuments: async () => [
        { id: 'a', filename: 'a.md', fileType: 'md' },
        { id: 'b', filename: 'b.md', fileType: 'md' },
        { id: 'host', filename: 'host', fileType: 'host-memory' },
      ],
      updateSettings: async () => ({ success: true }),
      removeDocuments: async (ids: string[]) => {
        removed.push(ids)
        return { success: true }
      },
    },
    contextKnowledge: {
      list: async () => ({ success: true, items: [], maxDocChars: 5000 }),
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

function mountSettings() {
  installApi()
  document.body.innerHTML = ''
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(KnowledgeSettings)
  app.use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } }))
  app.mount(el)
  return { el, app }
}

describe('记忆与知识库设置页', () => {
  it('只有设置项，没有内容管理', async () => {
    const { el, app } = mountSettings()
    await settle()

    expect(el.textContent).toContain('清空')
    expect(el.textContent).toContain('修复')
    expect(el.querySelector('.folder-tree')).toBeNull()
    expect(el.querySelector('.manager-panel')).toBeNull()
    expect(el.querySelector('.doc-item')).toBeNull()

    app.unmount()
  })

  it('清空全库只清档案室里的文件', async () => {
    removed.length = 0
    const { el, app } = mountSettings()
    await settle()

    const clear = [...el.querySelectorAll('button')].find(b => b.classList.contains('btn-danger-fill')) as HTMLButtonElement
    clear.click()
    await settle()
    expect(removed).toEqual([['a', 'b']])

    app.unmount()
  })
})
