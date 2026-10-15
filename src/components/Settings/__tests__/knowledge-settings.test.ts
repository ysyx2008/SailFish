/**
 * @vitest-environment jsdom
 */
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '../../../i18n/locales/zh-CN'
import KnowledgeSettings from '../KnowledgeSettings.vue'

vi.mock('../../../composables/useConfirm', () => ({
  showConfirm: vi.fn(async () => true),
  showAlert: vi.fn(async () => undefined),
}))

const docs = [
  {
    id: 'leave',
    filename: 'leave.md',
    content: '差旅要审批',
    fileSize: 12,
    fileType: 'md',
    chunkCount: 1,
    createdAt: 1,
    updatedAt: 1,
    tags: [],
    folder: '公司制度/差旅',
    addedBy: 'user',
    cardStatus: 'pending',
  },
  {
    id: 'style',
    filename: 'style.md',
    content: '样式',
    fileSize: 8,
    fileType: 'md',
    chunkCount: 1,
    createdAt: 2,
    updatedAt: 2,
    tags: [],
    folder: '样式',
    addedBy: 'agent',
    cardStatus: 'ready',
    cardSummary: '样式说明',
  },
  {
    id: 'old',
    filename: 'old.md',
    content: '旧原文',
    fileSize: 9,
    fileType: 'md',
    chunkCount: 1,
    createdAt: 3,
    updatedAt: 3,
    tags: [],
    folder: '公司制度',
    addedBy: 'user',
    cardStatus: 'stale',
    cardSummary: '旧说明',
  },
]

const calls = {
  updateCard: [] as Array<{ id: string; summary: string }>,
  confirmCard: [] as string[],
  removeDocuments: [] as string[][],
}

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
      getDocuments: async () => docs.map(doc => ({ ...doc })),
      listFolders: async () => ['公司制度/差旅', '空目录'],
      updateSettings: async () => ({ success: true }),
      updateCard: async (id: string, summary: string) => {
        calls.updateCard.push({ id, summary })
        const doc = docs.find(item => item.id === id)
        if (doc) {
          doc.cardSummary = summary
          doc.cardStatus = 'ready'
        }
        return { success: true }
      },
      confirmCard: async (id: string) => {
        calls.confirmCard.push(id)
        const doc = docs.find(item => item.id === id)
        if (doc) doc.cardStatus = 'ready'
        return { success: true }
      },
      moveDocument: async () => ({ success: true }),
      removeDocument: async () => ({ success: true }),
      removeDocuments: async (ids: string[]) => {
        calls.removeDocuments.push(ids)
        return { success: true, deleted: ids.length }
      },
    },
    contextKnowledge: {
      list: async () => ({ success: true, items: [] }),
    },
    config: {
      getAiProfiles: async () => [],
    },
  }
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(button => button.textContent?.includes(text))
  if (!found) throw new Error(`找不到按钮：${text}`)
  return found as HTMLButtonElement
}

describe('档案室管理界面', () => {
  beforeEach(() => {
    calls.updateCard.length = 0
    calls.confirmCard.length = 0
    calls.removeDocuments.length = 0
    docs[0].cardStatus = 'pending'
    docs[0].cardSummary = undefined
    docs[2].cardStatus = 'stale'
    docs[2].cardSummary = '旧说明'
    installApi()
    document.body.innerHTML = ''
  })

  it('能看目录、改说明、按来源筛、批量删，并看见队列进度', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const i18n = createI18n({
      legacy: false,
      locale: 'zh-CN',
      messages: { 'zh-CN': zhCN },
    })
    const app = createApp(KnowledgeSettings)
    app.use(i18n)
    app.mount(el)
    await settle()

    buttonNamed(el, '知识库').click()
    await nextTick()

    expect(el.textContent).toContain('说明：待写 1 · 已好 1 · 脱节 1 · 失败 0')
    expect(el.textContent).toContain('公司制度')
    expect(el.textContent).toContain('公司制度/差旅')
    expect(el.textContent).toContain('空目录')
    expect(el.textContent).toContain('全部来源')

    buttonNamed(el, '公司制度/差旅').click()
    await nextTick()
    expect(el.textContent).toContain('leave.md')
    expect(el.textContent).not.toContain('style.md')
    expect(el.textContent).not.toContain('old.md')

    buttonNamed(el, '全部').click()
    await nextTick()
    const source = el.querySelector('select.source-select') as HTMLSelectElement
    source.value = 'agent'
    source.dispatchEvent(new Event('change'))
    await nextTick()
    expect(el.textContent).toContain('style.md')
    expect(el.textContent).not.toContain('leave.md')

    source.value = 'all'
    source.dispatchEvent(new Event('change'))
    await nextTick()

    const oldRow = [...el.querySelectorAll('.doc-item')].find(row => row.textContent?.includes('old.md'))
    if (!oldRow) throw new Error('找不到 old.md')
    ;(oldRow as HTMLElement).click()
    await nextTick()
    expect(el.textContent).toContain('原文已经换过版，这段说明还停在旧版。')
    const card = el.querySelector('textarea.card-input') as HTMLTextAreaElement
    expect(card.value).toBe('旧说明')
    card.value = '我改过的说明'
    card.dispatchEvent(new Event('input'))
    await nextTick()
    buttonNamed(el, '保存说明').click()
    await settle()
    expect(calls.updateCard).toEqual([{ id: 'old', summary: '我改过的说明' }])

    docs[2].cardStatus = 'stale'
    buttonNamed(el, '刷新').click()
    await settle()
    ;( [...el.querySelectorAll('.doc-item')].find(row => row.textContent?.includes('old.md')) as HTMLElement).click()
    await nextTick()
    buttonNamed(el, '仍适用于这一版').click()
    await settle()
    expect(calls.confirmCard).toEqual(['old'])

    const box = el.querySelector('.doc-item input[type="checkbox"]') as HTMLInputElement
    box.click()
    await nextTick()
    buttonNamed(el, '删除选中').click()
    await settle()
    expect(calls.removeDocuments[0]?.length).toBeGreaterThan(0)

    app.unmount()
  })
})
