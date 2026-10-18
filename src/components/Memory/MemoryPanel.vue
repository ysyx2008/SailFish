<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X, Trash2, ChevronRight, ChevronDown, Folder, Brain } from 'lucide-vue-next'
import { showConfirm, showAlert } from '../../composables/useConfirm'
import AttachmentFileIcon from '../AttachmentFileIcon.vue'
import {
  SettingsTabs,
  SettingInput,
  SettingSelect,
  SettingNotice,
} from '../Settings/kit'

const props = defineProps<{
  /** 设置页里清空、重建之后，外面递增一次，面板据此重新取数 */
  refreshSignal?: number
}>()
const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const api = window.electronAPI as any

// ==================== 类型 ====================

interface KnowledgeDocument {
  id: string
  filename: string
  content: string
  fileSize: number
  fileType: string
  hostId?: string
  chunkCount: number
  createdAt: number
  updatedAt: number
  tags: string[]
  folder?: string
  addedBy?: 'user' | 'agent'
  cardStatus?: 'pending' | 'generating' | 'ready' | 'failed' | 'stale'
  cardSummary?: string
}

interface ContextKnowledgeItem {
  contextId: string
  content: string
}

// ==================== 状态 ====================

const loading = ref(true)
const isKnowledgeInitialized = ref(false)

const activeTab = ref<'memory' | 'knowledge'>('memory')

// 记忆
const contextDocs = ref<ContextKnowledgeItem[]>([])
const selectedContextId = ref<string | null>(null)
const contextDocContent = ref('')
const contextDocSaving = ref(false)
const contextDocDirty = ref(false)
const contextKnowledgeMaxChars = ref(5000)

// 知识库文档
const documents = ref<KnowledgeDocument[]>([])
const storedFolders = ref<string[]>([])
const searchQuery = ref('')
const browseFolder = ref('')
const addedByFilter = ref<'all' | 'user' | 'agent'>('all')
const cardDraft = ref('')
const folderDraft = ref('')
const cardSaving = ref(false)
const selectedDoc = ref<KnowledgeDocument | null>(null)
const selectedDocIds = ref<Set<string>>(new Set())
const batchDeleting = ref(false)

const kbDocuments = computed(() => {
  return documents.value.filter(doc => doc.fileType !== 'host-memory' && doc.fileType !== 'conversation')
})

const folders = computed(() => {
  const set = new Set<string>(storedFolders.value)
  for (const doc of kbDocuments.value) {
    const folder = doc.folder || ''
    if (!folder) continue
    const parts = folder.split('/')
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      set.add(acc)
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh'))
})

const sourceOptions = computed(() => [
  { value: 'all', label: t('knowledgeManager.sourceAll') },
  { value: 'user', label: t('knowledgeManager.sourceUser') },
  { value: 'agent', label: t('knowledgeManager.sourceAgent') },
])

function onSourceFilter(value: string) {
  if (value === 'all' || value === 'user' || value === 'agent') addedByFilter.value = value
}

/** 档案里没有原文件，用扩展名向系统要图标。 */
function typeIconPath(doc: { filename: string; fileType: string }): string {
  const fromName = doc.filename.includes('.') ? doc.filename.slice(doc.filename.lastIndexOf('.') + 1) : ''
  const raw = (fromName || doc.fileType || 'txt').replace(/^\./, '').toLowerCase()
  const ext = /^[a-z0-9]{1,12}$/.test(raw) ? raw : 'txt'
  return `/__icon__.${ext}`
}

interface FolderNode {
  name: string
  path: string
  children: FolderNode[]
}

const expandedFolders = ref(new Set<string>())
const seenFolders = new Set<string>()
const treeMenu = ref<{ x: number; y: number; path: string } | null>(null)
const fileMenu = ref<{ x: number; y: number; doc: KnowledgeDocument } | null>(null)
const naming = ref<{ mode: 'create' | 'rename'; parent: string; path: string; draft: string } | null>(null)
const nameInputRef = ref<HTMLInputElement | HTMLInputElement[] | null>(null)

const folderTree = computed(() => {
  const root: FolderNode = { name: '', path: '', children: [] }
  const byPath = new Map<string, FolderNode>([['', root]])
  for (const folder of folders.value) {
    let parent = root
    let acc = ''
    for (const part of folder.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${part}` : part
      let node = byPath.get(acc)
      if (!node) {
        node = { name: part, path: acc, children: [] }
        byPath.set(acc, node)
        parent.children.push(node)
      }
      parent = node
    }
  }
  return root
})

watch(folders, (list) => {
  const next = new Set(expandedFolders.value)
  if (!seenFolders.has('')) {
    next.add('')
    seenFolders.add('')
  }
  for (const folder of list) {
    if (!seenFolders.has(folder)) {
      next.add(folder)
      seenFolders.add(folder)
    }
  }
  expandedFolders.value = next
}, { immediate: true })

interface VisibleFolder {
  name: string
  path: string
  depth: number
  hasChildren: boolean
  open: boolean
}

const visibleFolders = computed(() => {
  const rows: VisibleFolder[] = []
  const walk = (nodes: FolderNode[], depth: number) => {
    for (const node of nodes) {
      const open = expandedFolders.value.has(node.path)
      rows.push({
        name: node.name,
        path: node.path,
        depth,
        hasChildren: node.children.length > 0,
        open,
      })
      if (open) walk(node.children, depth + 1)
    }
  }
  // 根目录是树的顶端，它下面的目录从第 1 层起缩进
  if (expandedFolders.value.has('')) walk(folderTree.value.children, 1)
  return rows
})

const rootOpen = computed(() => expandedFolders.value.has(''))
const rootHasChildren = computed(() => folderTree.value.children.length > 0)

function toggleFolder(path: string) {
  const next = new Set(expandedFolders.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expandedFolders.value = next
}

function closeMenus() {
  treeMenu.value = null
  fileMenu.value = null
}

function menuPoint(event: MouseEvent): { x: number; y: number } {
  const menuWidth = 168
  const menuHeight = 132
  return {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight)),
  }
}

function openTreeMenu(event: MouseEvent, path: string) {
  fileMenu.value = null
  treeMenu.value = { ...menuPoint(event), path }
}

function openFileMenu(event: MouseEvent, doc: KnowledgeDocument) {
  treeMenu.value = null
  fileMenu.value = { ...menuPoint(event), doc }
}

function parentFolder(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function filesInside(path: string): number {
  return kbDocuments.value.filter(doc => {
    const folder = doc.folder || ''
    return folder === path || folder.startsWith(`${path}/`)
  }).length
}

function startCreate(parent: string) {
  const next = new Set(expandedFolders.value)
  next.add(parent)
  expandedFolders.value = next
  naming.value = { mode: 'create', parent, path: parent, draft: '' }
  closeMenus()
}

function startRename(path: string) {
  const slash = path.lastIndexOf('/')
  naming.value = {
    mode: 'rename',
    parent: parentFolder(path),
    path,
    draft: slash < 0 ? path : path.slice(slash + 1),
  }
  closeMenus()
}

watch(naming, async (value) => {
  if (!value) return
  await nextTick()
  const el = nameInputRef.value
  const input = Array.isArray(el) ? el.find(item => item) : el
  input?.focus()
  input?.select()
})

function retargetBrowse(from: string, to: string | null) {
  const current = browseFolder.value
  if (current !== from && !current.startsWith(`${from}/`)) return
  if (to === null) {
    browseFolder.value = parentFolder(from)
    return
  }
  browseFolder.value = current === from ? to : `${to}${current.slice(from.length)}`
}

async function commitNaming() {
  const job = naming.value
  if (!job) return
  naming.value = null
  const segment = job.draft.trim()
  if (!segment || segment.includes('/') || segment === '.' || segment === '..') {
    if (job.draft.trim()) {
      await showAlert(t('common.error'), t('knowledgeManager.folderNameInvalid'))
    }
    return
  }
  const full = job.parent ? `${job.parent}/${segment}` : segment
  if (job.mode === 'rename' && full === job.path) return
  const result = job.mode === 'create'
    ? await api.knowledge.createFolder(full)
    : await api.knowledge.renameFolder(job.path, full)
  if (!result?.success) {
    await showAlert(t('common.error'), result?.error || t('knowledgeManager.moveFailed'))
    return
  }
  if (job.mode === 'rename') retargetBrowse(job.path, result.folder || full)
  else browseFolder.value = result.folder || full
  await loadKnowledgeDocs()
}

async function deleteFolderFromMenu(path: string) {
  closeMenus()
  if (!path) return
  const count = filesInside(path)
  if (count > 0) {
    const confirmed = await showConfirm({
      type: 'danger',
      title: t('knowledgeManager.deleteFolder'),
      message: t('knowledgeManager.confirmDeleteFolder', { name: path, count }),
      confirmText: t('common.delete'),
    })
    if (!confirmed) return
  }
  const result = await api.knowledge.deleteFolder(path)
  if (!result?.success) {
    await showAlert(t('common.error'), result?.error || t('knowledgeManager.moveFailed'))
    return
  }
  retargetBrowse(path, null)
  if (selectedDoc.value) {
    const folder = selectedDoc.value.folder || ''
    if (folder === path || folder.startsWith(`${path}/`)) selectedDoc.value = null
  }
  await loadKnowledgeDocs()
}

function deleteFileFromMenu(doc: KnowledgeDocument) {
  closeMenus()
  void deleteDocument(doc)
}

const libraryTabs = computed(() => [
  { value: 'memory', label: t('knowledgeManager.memoryTab', { count: contextDocs.value.length }) },
  { value: 'knowledge', label: t('knowledgeManager.knowledgeTab', { count: kbDocuments.value.length }) },
])

function onLibraryTab(value: string) {
  if (value === 'memory' || value === 'knowledge') activeTab.value = value
}

function inBrowseFolder(folder: string | undefined): boolean {
  return (folder || '') === browseFolder.value
}

const filteredDocuments = computed(() => {
  const docs = kbDocuments.value.filter(doc => {
    if (!inBrowseFolder(doc.folder)) return false
    if (addedByFilter.value !== 'all' && (doc.addedBy || 'user') !== addedByFilter.value) return false
    return true
  })
  if (!searchQuery.value) return docs
  const query = searchQuery.value.toLowerCase()
  return docs.filter(doc =>
    doc.filename.toLowerCase().includes(query) ||
    (doc.folder || '').toLowerCase().includes(query) ||
    doc.tags?.some(tag => tag.toLowerCase().includes(query))
  )
})

const isAllSelected = computed(() => {
  if (filteredDocuments.value.length === 0) return false
  return filteredDocuments.value.every(doc => selectedDocIds.value.has(doc.id))
})

const hasSelection = computed(() => selectedDocIds.value.size > 0)

// ==================== 工具函数 ====================

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const formatDate = (timestamp: number): string => {
  const { locale } = useI18n()
  return new Date(timestamp).toLocaleString(locale.value, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

const getContextLabel = (contextId: string): string => {
  if (contextId === 'local') return t('knowledgeManager.contextLabelLocal')
  if (contextId === 'personal') return t('knowledgeManager.contextLabelPersonal')
  return t('knowledgeManager.contextLabelRemote', { id: contextId })
}

// ==================== 数据加载 ====================

const loadAllData = async () => {
  try {
    loading.value = true
    isKnowledgeInitialized.value = await api.knowledge.isInitialized()
    await Promise.all([loadContextDocs(), loadKnowledgeDocs()])
  } catch (error) {
    console.error('加载记忆与档案室失败:', error)
  } finally {
    loading.value = false
  }
}

const loadContextDocs = async () => {
  try {
    const result = await window.electronAPI.contextKnowledge.list()
    if (result.success) {
      contextDocs.value = result.items
      if (typeof result.maxDocChars === 'number' && result.maxDocChars > 0) {
        contextKnowledgeMaxChars.value = result.maxDocChars
      }
    }
  } catch (error) {
    console.error('加载记忆失败:', error)
  }
}

const loadKnowledgeDocs = async () => {
  try {
    documents.value = await api.knowledge.getDocuments() || []
    storedFolders.value = await api.knowledge.listFolders() || []
    // 文件可能在别处被删（设置页清空全库），选中项跟着清掉，免得对已删的文件继续操作
    const alive = new Set(documents.value.map(doc => doc.id))
    if (selectedDoc.value && !alive.has(selectedDoc.value.id)) selectedDoc.value = null
    if ([...selectedDocIds.value].some(id => !alive.has(id))) {
      selectedDocIds.value = new Set([...selectedDocIds.value].filter(id => alive.has(id)))
    }
  } catch (error) {
    console.error('加载知识库失败:', error)
  }
}

// ==================== 记忆操作 ====================

const selectContextDoc = async (item: ContextKnowledgeItem) => {
  if (contextDocDirty.value && selectedContextId.value) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('common.confirm'),
      message: t('knowledgeManager.confirmSwitchMemory'),
    })
    if (!confirmed) return
  }
  selectedContextId.value = item.contextId
  contextDocContent.value = item.content
  contextDocDirty.value = false
}

const onContextDocInput = () => { contextDocDirty.value = true }

const saveContextDoc = async () => {
  if (!selectedContextId.value) return
  try {
    contextDocSaving.value = true
    const result = await window.electronAPI.contextKnowledge.set(selectedContextId.value, contextDocContent.value)
    if (result.success) {
      contextDocDirty.value = false
      await loadContextDocs()
    } else {
      await showAlert(t('common.error'), t('knowledgeManager.saveMemoryFailed', { error: result.error || t('knowledgeManager.unknownError') }))
    }
  } catch (error) {
    console.error('保存记忆失败:', error)
  } finally {
    contextDocSaving.value = false
  }
}

const deleteContextDoc = async (contextId: string) => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('knowledgeManager.confirmDeleteMemory', { name: getContextLabel(contextId) }),
    confirmText: t('common.delete'),
  })
  if (!confirmed) return
  try {
    const result = await window.electronAPI.contextKnowledge.delete(contextId)
    if (result.success) {
      if (selectedContextId.value === contextId) {
        selectedContextId.value = null
        contextDocContent.value = ''
        contextDocDirty.value = false
      }
      await loadContextDocs()
    } else {
      await showAlert(t('common.error'), t('knowledgeManager.deleteMemoryFailed', { error: result.error || t('knowledgeManager.unknownError') }))
    }
  } catch (error) {
    console.error('删除记忆失败:', error)
  }
}

// ==================== 知识库操作 ====================

const toggleDocSelection = (docId: string, event: Event) => {
  event.stopPropagation()
  if (selectedDocIds.value.has(docId)) selectedDocIds.value.delete(docId)
  else selectedDocIds.value.add(docId)
  selectedDocIds.value = new Set(selectedDocIds.value)
}

const toggleSelectAll = () => {
  if (isAllSelected.value) filteredDocuments.value.forEach(doc => selectedDocIds.value.delete(doc.id))
  else filteredDocuments.value.forEach(doc => selectedDocIds.value.add(doc.id))
  selectedDocIds.value = new Set(selectedDocIds.value)
}

const clearSelection = () => { selectedDocIds.value = new Set() }

const viewDocument = (doc: KnowledgeDocument) => {
  selectedDoc.value = doc
  cardDraft.value = doc.cardSummary || ''
  folderDraft.value = doc.folder || ''
}

const saveCard = async () => {
  if (!selectedDoc.value) return
  cardSaving.value = true
  try {
    const result = await api.knowledge.updateCard(selectedDoc.value.id, cardDraft.value)
    if (!result?.success) {
      await showAlert(t('common.error'), t('knowledgeManager.cardSaveFailed'))
      return
    }
    await loadKnowledgeDocs()
    const fresh = documents.value.find(doc => doc.id === selectedDoc.value?.id)
    if (fresh) viewDocument(fresh)
  } finally {
    cardSaving.value = false
  }
}

const confirmCard = async () => {
  if (!selectedDoc.value) return
  const result = await api.knowledge.confirmCard(selectedDoc.value.id)
  if (!result?.success) return
  await loadKnowledgeDocs()
  const fresh = documents.value.find(doc => doc.id === selectedDoc.value?.id)
  if (fresh) viewDocument(fresh)
}

const moveSelected = async () => {
  if (!selectedDoc.value) return
  const result = await api.knowledge.moveDocument(selectedDoc.value.id, folderDraft.value)
  if (!result?.success) {
    await showAlert(t('common.error'), result?.error || t('knowledgeManager.moveFailed'))
    return
  }
  await loadKnowledgeDocs()
  const fresh = documents.value.find(doc => doc.id === selectedDoc.value?.id)
  if (fresh) viewDocument(fresh)
}

const deleteDocument = async (doc: KnowledgeDocument) => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('knowledgeManager.confirmDelete', { name: doc.filename }),
    confirmText: t('common.delete'),
  })
  if (!confirmed) return
  try {
    const result = await api.knowledge.removeDocument(doc.id)
    if (result.success) {
      await loadKnowledgeDocs()
      selectedDocIds.value.delete(doc.id)
      selectedDocIds.value = new Set(selectedDocIds.value)
      if (selectedDoc.value?.id === doc.id) selectedDoc.value = null
    }
  } catch (error) {
    console.error('Delete document failed:', error)
  }
}

const batchDeleteDocuments = async () => {
  const count = selectedDocIds.value.size
  if (count === 0) return
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('knowledgeManager.confirmBatchDelete', { count }),
    confirmText: t('common.delete'),
  })
  if (!confirmed) return
  try {
    batchDeleting.value = true
    const docIds = Array.from(selectedDocIds.value)
    const result = await api.knowledge.removeDocuments(docIds)
    if (result.success) {
      await loadKnowledgeDocs()
      clearSelection()
      if (selectedDoc.value && docIds.includes(selectedDoc.value.id)) selectedDoc.value = null
    }
  } catch (error) {
    console.error('Batch delete failed:', error)
  } finally {
    batchDeleting.value = false
  }
}

// ==================== 生命周期 ====================

let unsubscribeKnowledgeReady: (() => void) | null = null

watch(() => props.refreshSignal, () => { void loadKnowledgeDocs(); void loadContextDocs() })

/** Esc 离开栏目；改名输入框、未保存的记忆草稿、弹层都在时不抢 Esc */
function onPanelKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  if (document.querySelector('.modal-overlay, .credential-overlay, .setup-wizard, .confirm-overlay, .app-select-menu')) return
  if (naming.value || treeMenu.value || fileMenu.value || contextDocDirty.value) return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  emit('close')
}

onMounted(() => {
  document.addEventListener('keydown', onPanelKeydown, true)
  loadAllData()
  unsubscribeKnowledgeReady = api.knowledge.onReady(() => {
    isKnowledgeInitialized.value = true
    loadAllData()
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', onPanelKeydown, true)
  unsubscribeKnowledgeReady?.()
})
</script>

<template>
  <section class="memory-panel">
    <header class="memory-header">
      <div class="memory-mark">
        <Brain :size="18" :stroke-width="1.75" />
      </div>
      <div class="memory-header-text">
        <h1>{{ t('memoryPanel.title') }}</h1>
        <p>{{ t('memoryPanel.desc') }}</p>
      </div>
    </header>
    <div class="memory-content">
      <SettingNotice v-if="loading">{{ t('common.loading') }}</SettingNotice>
      <SettingNotice v-else-if="!isKnowledgeInitialized">
        <Loader2 class="spinner" :size="16" />
        <span>{{ t('knowledgeSettings.initializing') }}</span>
      </SettingNotice>
      <template v-else>
        <SettingsTabs
          class="memory-tabs"
          :model-value="activeTab"
          :tabs="libraryTabs"
          @update:model-value="onLibraryTab"
        />
    <div class="manager-panel">
      <div class="manager-body">
        <div v-if="activeTab === 'knowledge'" class="folder-tree" role="tree" @click="closeMenus">
          <div class="tree-row" :class="{ on: browseFolder === '' }" @contextmenu.prevent="openTreeMenu($event, '')">
            <button
              v-if="rootHasChildren"
              type="button"
              class="tree-chevron"
              @click="toggleFolder('')"
            >
              <ChevronDown v-if="rootOpen" :size="14" />
              <ChevronRight v-else :size="14" />
            </button>
            <span v-else class="tree-chevron"></span>
            <button type="button" class="tree-name" @click="browseFolder = ''">
              <Folder :size="14" />
              <span>{{ t('knowledgeManager.folderAll') }}</span>
            </button>
          </div>
          <div
            v-if="naming?.mode === 'create' && naming.parent === ''"
            class="tree-row"
            :style="{ paddingLeft: '14px' }"
          >
            <span class="tree-chevron"></span>
            <input
              ref="nameInputRef"
              v-model="naming.draft"
              class="tree-name-input"
              :placeholder="t('knowledgeManager.folderNamePlaceholder')"
              @click.stop
              @keydown.enter.prevent="commitNaming"
              @keydown.esc.prevent="naming = null"
              @blur="commitNaming"
            />
          </div>
          <template v-for="row in visibleFolders" :key="row.path">
            <div
              class="tree-row"
              :class="{ on: browseFolder === row.path }"
              :style="{ paddingLeft: `${row.depth * 14}px` }"
              @contextmenu.prevent="openTreeMenu($event, row.path)"
            >
              <button
                v-if="row.hasChildren"
                type="button"
                class="tree-chevron"
                @click="toggleFolder(row.path)"
              >
                <ChevronDown v-if="row.open" :size="14" />
                <ChevronRight v-else :size="14" />
              </button>
              <span v-else class="tree-chevron"></span>
              <button
                v-if="!(naming?.mode === 'rename' && naming.path === row.path)"
                type="button"
                class="tree-name"
                @click="browseFolder = row.path"
              >
                <Folder :size="14" />
                <span>{{ row.name }}</span>
              </button>
              <input
                v-else
                ref="nameInputRef"
                v-model="naming.draft"
                class="tree-name-input"
                :placeholder="t('knowledgeManager.folderNamePlaceholder')"
                @click.stop
                @keydown.enter.prevent="commitNaming"
                @keydown.esc.prevent="naming = null"
                @blur="commitNaming"
              />
            </div>
            <div
              v-if="naming?.mode === 'create' && naming.parent === row.path"
              class="tree-row"
              :style="{ paddingLeft: `${(row.depth + 1) * 14}px` }"
            >
              <span class="tree-chevron"></span>
              <input
                ref="nameInputRef"
                v-model="naming.draft"
                class="tree-name-input"
                :placeholder="t('knowledgeManager.folderNamePlaceholder')"
                @click.stop
                @keydown.enter.prevent="commitNaming"
                @keydown.esc.prevent="naming = null"
                @blur="commitNaming"
              />
            </div>
          </template>
        </div>
        <div class="list-panel">
          <template v-if="activeTab === 'memory'">
            <div class="item-list">
                <div
                  v-for="item in contextDocs"
                  :key="item.contextId"
                  class="memory-item"
                  :class="{ active: selectedContextId === item.contextId }"
                  @click="selectContextDoc(item)"
                >
                  <div class="memory-label">{{ getContextLabel(item.contextId) }}</div>
                  <div class="memory-preview">{{ item.content.substring(0, 80) || t('knowledgeManager.emptyDocPreview') }}</div>
                  <button class="btn-icon btn-del" @click.stop="deleteContextDoc(item.contextId)" :title="t('knowledgeManager.delete')">
                    <X :size="12" />
                  </button>
                </div>
                <div v-if="contextDocs.length === 0" class="empty-state">
                  <p>{{ t('knowledgeManager.noMemoryYet') }}</p>
                  <p class="hint">{{ t('knowledgeManager.noMemoryHint') }}</p>
                </div>
              </div>
              <div class="list-actions">
                <button class="btn btn-sm" @click="loadContextDocs">{{ t('knowledgeManager.refresh') }}</button>
              </div>
            </template>

            <!-- ===== 知识库 tab ===== -->
            <template v-if="activeTab === 'knowledge'">
              <div class="list-toolbar">
                <div class="search-bar">
                  <SettingInput v-model="searchQuery" block :placeholder="t('knowledgeManager.searchPlaceholder')" />
                  <SettingSelect
                    :model-value="addedByFilter"
                    block
                    :options="sourceOptions"
                    @update:model-value="onSourceFilter"
                  />
                </div>
              </div>
              <div class="batch-bar" v-if="filteredDocuments.length > 0">
                <label class="check-wrap">
                  <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" />
                  <span>{{ t('knowledgeManager.selectAll') }}</span>
                </label>
                <span v-if="hasSelection" class="sel-info">
                  {{ t('knowledgeManager.selected', { count: selectedDocIds.size }) }}
                  <button class="btn-link" @click="clearSelection">{{ t('knowledgeManager.cancel') }}</button>
                </span>
              </div>
              <div class="item-list">
                <div
                  v-for="doc in filteredDocuments"
                  :key="doc.id"
                  class="doc-item"
                  :class="{ active: selectedDoc?.id === doc.id, selected: selectedDocIds.has(doc.id) }"
                  @click="viewDocument(doc)"
                  @contextmenu.prevent="openFileMenu($event, doc)"
                >
                  <label class="doc-check" @click.stop>
                    <input type="checkbox" :checked="selectedDocIds.has(doc.id)" @change="toggleDocSelection(doc.id, $event)" />
                  </label>
                  <AttachmentFileIcon
                    class="doc-type-icon"
                    :file-type="doc.fileType"
                    :filename="doc.filename"
                    :file-path="typeIconPath(doc)"
                    :size="22"
                  />
                  <div class="doc-info">
                    <div class="doc-name">{{ doc.filename }}</div>
                    <div class="doc-meta">
                      <span>{{ formatSize(doc.fileSize) }}</span>
                    </div>
                  </div>
                  <button class="btn-icon btn-del-hover" @click.stop="deleteDocument(doc)" :title="t('knowledgeManager.delete')">
                    <Trash2 :size="14" />
                  </button>
                </div>
                <div v-if="filteredDocuments.length === 0" class="empty-state">
                  {{ searchQuery ? t('knowledgeManager.noMatchingDocs') : t('knowledgeManager.emptyKnowledge') }}
                </div>
              </div>
              <div class="list-actions">
                <button v-if="hasSelection" class="btn btn-danger btn-sm" @click="batchDeleteDocuments" :disabled="batchDeleting">
                  {{ batchDeleting ? t('knowledgeManager.deleting') : `${t('knowledgeManager.deleteSelected')} (${selectedDocIds.size})` }}
                </button>
                <button class="btn btn-sm" @click="loadKnowledgeDocs">{{ t('knowledgeManager.refresh') }}</button>
              </div>
            </template>
          </div>

          <!-- 右侧详情/编辑 -->
          <div class="detail-panel">
            <!-- 记忆编辑 -->
            <template v-if="activeTab === 'memory'">
              <template v-if="selectedContextId">
                <div class="detail-header">
                  <h3>{{ getContextLabel(selectedContextId) }}</h3>
                  <div class="detail-meta">
                    <span>{{ t('knowledgeManager.memoryCharCount', { current: contextDocContent.length, max: contextKnowledgeMaxChars }) }}</span>
                    <span v-if="contextDocDirty" class="unsaved">{{ t('knowledgeManager.unsavedBadge') }}</span>
                  </div>
                </div>
                <div class="editor-area">
                  <textarea
                    v-model="contextDocContent"
                    @input="onContextDocInput"
                    class="editor-textarea"
                    :placeholder="t('knowledgeManager.contextDocPlaceholderSettings')"
                    spellcheck="false"
                  ></textarea>
                </div>
                <div class="editor-actions">
                  <button class="btn btn-primary btn-sm" @click="saveContextDoc" :disabled="contextDocSaving || !contextDocDirty">
                    {{ contextDocSaving ? t('knowledgeManager.savingMemory') : t('knowledgeManager.saveMemory') }}
                  </button>
                  <span class="editor-hint">{{ t('knowledgeManager.memoryAutoUpdateHint') }}</span>
                </div>
              </template>
              <div v-else class="no-selection">
                <p>{{ t('knowledgeManager.noSelectionMemoryTitle') }}</p>
                <p class="hint">{{ t('knowledgeManager.noSelectionMemoryHintSettings') }}</p>
              </div>
            </template>

            <!-- 知识库文档详情 -->
            <template v-else>
              <template v-if="selectedDoc">
                <div class="reader">
                  <header class="reader-head">
                    <AttachmentFileIcon
                      :file-type="selectedDoc.fileType"
                      :filename="selectedDoc.filename"
                      :file-path="typeIconPath(selectedDoc)"
                      :size="32"
                    />
                    <div class="reader-titles">
                      <h3>{{ selectedDoc.filename }}</h3>
                      <p class="reader-meta">
                        <span>{{ formatSize(selectedDoc.fileSize) }}</span>
                        <span>{{ t('knowledgeManager.createdAt') }} {{ formatDate(selectedDoc.createdAt) }}</span>
                        <span>{{ t('knowledgeManager.updatedAt') }} {{ formatDate(selectedDoc.updatedAt) }}</span>
                        <span>{{ selectedDoc.addedBy === 'agent' ? t('knowledgeManager.sourceAgent') : t('knowledgeManager.sourceUser') }}</span>
                      </p>
                      <div class="detail-tags" v-if="selectedDoc.tags?.length">
                        <span v-for="tag in selectedDoc.tags" :key="tag" class="tag">{{ tag }}</span>
                      </div>
                    </div>
                  </header>
                  <article class="reader-body">{{ selectedDoc.content }}</article>
                  <footer class="reader-tools">
                    <p v-if="selectedDoc.cardStatus === 'stale'" class="card-stale">{{ t('knowledgeManager.cardStale') }}</p>
                    <div class="tool-line">
                      <label class="card-label">{{ t('knowledgeManager.cardLabel') }}</label>
                      <textarea v-model="cardDraft" class="card-input" rows="2" :placeholder="t('knowledgeManager.cardPlaceholder')"></textarea>
                      <button class="btn btn-primary btn-sm" @click="saveCard" :disabled="cardSaving">
                        {{ cardSaving ? t('knowledgeManager.savingMemory') : t('knowledgeManager.saveCard') }}
                      </button>
                    </div>
                    <button v-if="selectedDoc.cardStatus === 'stale'" class="btn btn-sm tool-confirm" @click="confirmCard">
                      {{ t('knowledgeManager.confirmCard') }}
                    </button>
                    <div class="tool-line">
                      <label class="card-label">{{ t('knowledgeManager.folderLabel') }}</label>
                      <input v-model="folderDraft" class="search-input" :placeholder="t('knowledgeManager.folderPlaceholder')" />
                      <button class="btn btn-sm" @click="moveSelected">{{ t('knowledgeManager.moveFolder') }}</button>
                    </div>
                  </footer>
                </div>
              </template>
              <div v-else class="no-selection">
                <p>{{ t('knowledgeManager.selectDocToView') }}</p>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div v-if="treeMenu" class="context-menu-overlay" @click="closeMenus" @contextmenu.prevent="closeMenus" />
      <div
        v-if="treeMenu"
        class="context-menu"
        :style="{ left: `${treeMenu.x}px`, top: `${treeMenu.y}px` }"
        @contextmenu.prevent
      >
        <button type="button" class="context-menu-item" @click="startCreate(treeMenu.path)">
          {{ t('knowledgeManager.newSubfolder') }}
        </button>
        <template v-if="treeMenu.path">
          <button type="button" class="context-menu-item" @click="startRename(treeMenu.path)">
            {{ t('knowledgeManager.renameFolder') }}
          </button>
          <div class="context-menu-separator" role="separator" />
          <button type="button" class="context-menu-item danger" @click="deleteFolderFromMenu(treeMenu.path)">
            {{ t('knowledgeManager.deleteFolder') }}
          </button>
        </template>
      </div>
      <div v-if="fileMenu" class="context-menu-overlay" @click="closeMenus" @contextmenu.prevent="closeMenus" />
      <div
        v-if="fileMenu"
        class="context-menu"
        :style="{ left: `${fileMenu.x}px`, top: `${fileMenu.y}px` }"
        @contextmenu.prevent
      >
        <button type="button" class="context-menu-item danger" @click="deleteFileFromMenu(fileMenu.doc)">
          {{ t('knowledgeManager.delete') }}
        </button>
      </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.memory-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.memory-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}
.memory-mark {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent);
}
.memory-header-text { min-width: 0; flex: 1; }
.memory-header h1 { margin: 0; font-size: 16px; font-weight: 600; }
.memory-header p { margin: 2px 0 0; font-size: 12px; color: var(--text-muted); }

.memory-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 16px 20px 20px;
}

/* 标签条在内容区顶端，与下面的管理区隔开一段 */
.memory-tabs { flex-shrink: 0; margin-bottom: 12px; }

.spinner { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ==================== 内嵌管理面板 ==================== */
.manager-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
}

.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.tab-btn {
  flex: 1;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 500;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s;
}

.tab-btn:hover { color: var(--text-primary); }
.tab-btn.active { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }

.manager-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.list-panel {
  width: 280px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
}

.detail-panel {
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 16px 18px 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 左侧筛选：目录、搜索、进度各自留开，不贴边 */
.list-toolbar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--border-color);
}

/* 搜索 */
.search-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0;
  border: none;
}
.search-input {
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.4;
  font-family: inherit;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

/* 批量操作 */
.batch-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px; background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color); font-size: 12px;
}
.check-wrap { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text-secondary); }
.check-wrap input { width: 13px; height: 13px; cursor: pointer; }
.sel-info { color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.btn-link { background: none; border: none; color: var(--accent-primary); cursor: pointer; font-size: 11px; padding: 0; }
.btn-link:hover { text-decoration: underline; }

/* 列表 */
.item-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.list-actions {
  padding: 12px 14px;
  border-top: 1px solid var(--border-color);
  display: flex; flex-wrap: wrap; gap: 8px;
}

/* 记忆条目 */
.memory-item {
  display: flex; flex-direction: column; gap: 6px;
  padding: 10px 12px; border-radius: 6px; cursor: pointer;
  transition: all 0.15s; border: 1px solid transparent; position: relative;
}
.memory-item:hover { background: var(--bg-hover); }
.memory-item.active { background: color-mix(in srgb, var(--accent-primary) 16%, transparent); color: var(--text-primary); }
.memory-item:hover .btn-del, .memory-item.active .btn-del { opacity: 1; }
.memory-item .btn-del { position: absolute; top: 6px; right: 6px; }

.memory-label { font-size: 12px; font-weight: 500; }
.memory-preview { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.memory-item.active .memory-preview { color: var(--text-muted); }
.memory-item.active .btn-del { color: var(--text-secondary); }
.memory-item.active .btn-del:hover { color: var(--text-primary); }

/* 文档条目 */
.doc-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 6px; cursor: pointer;
  transition: all 0.15s; border: 1px solid transparent;
}
.doc-item:hover { background: var(--bg-hover); }
.doc-item.active { background: color-mix(in srgb, var(--accent-primary) 16%, transparent); color: var(--text-primary); }
.doc-item.selected:not(.active) { background: var(--bg-hover); border-color: var(--accent-primary); }
.doc-item:hover .btn-del-hover { opacity: 1; }

.doc-check { display: flex; align-items: center; flex-shrink: 0; }
.doc-check input { width: 13px; height: 13px; cursor: pointer; }
.doc-type-icon { flex-shrink: 0; }
.doc-info { flex: 1; min-width: 0; }
.doc-name { font-size: 13px; font-weight: 500; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.folder-tree {
  width: 200px;
  flex: 0 0 200px;
  min-height: 0;
  overflow: auto;
  padding: 8px 6px;
  border-right: 1px solid var(--border-color);
}
.tree-row {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  border-radius: var(--radius-sm, 6px);
}
.tree-row.on { background: color-mix(in srgb, var(--accent-primary) 16%, transparent); }
.tree-chevron, .tree-name {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  cursor: pointer;
}
.tree-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 22px;
  flex: 0 0 18px;
  padding: 0;
}
.tree-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 0;
  text-align: left;
  font-size: var(--fs-desc, 13px);
}
.tree-name :deep(svg) { flex-shrink: 0; }
.tree-name span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tree-name-input {
  flex: 1;
  min-width: 0;
  margin: 2px 6px 2px 0;
  padding: 2px 6px;
  font: inherit;
  font-size: var(--fs-desc, 13px);
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--accent-primary);
  border-radius: 4px;
}
.tree-name-input:focus { outline: none; }
.context-menu {
  position: fixed;
  min-width: 132px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  padding: 3px;
  z-index: 30;
}
.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 29;
}
.context-menu-item {
  display: block;
  width: 100%;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1.25;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.context-menu-item:hover { background: var(--bg-hover); }
.context-menu-item.danger { color: var(--accent-error); }
.context-menu-item.danger:hover { background: rgba(244, 63, 94, 0.1); }
.context-menu-separator {
  height: 1px;
  margin: 2px 6px;
  background: var(--border-color);
}
.tree-row.on .tree-name { color: var(--text-primary); }
.card-label { display: block; margin: 0; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.card-stale { color: var(--warning, #b86e00); font-size: 12px; line-height: 1.5; margin: 0; }
.card-input {
  width: 100%;
  min-height: 0;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.5;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  resize: vertical;
}
.card-input:focus { outline: none; border-color: var(--accent-primary); }
.doc-meta { display: flex; gap: 8px; font-size: 11px; line-height: 1.4; color: var(--text-muted); margin-top: 4px; }
.doc-item.active .doc-meta { color: var(--text-muted); }

/* 按钮 */
.btn-icon {
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border: none; background: transparent;
  color: var(--text-secondary); border-radius: 4px; cursor: pointer;
}
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

.btn-del, .btn-del-hover { opacity: 0; transition: opacity 0.15s; }
.btn-del:hover, .btn-del-hover:hover { color: var(--accent-error); }

.empty-state { text-align: center; padding: 30px 16px; color: var(--text-muted); font-size: 13px; }
.empty-state .hint, .hint { font-size: 11px; margin-top: 6px; color: var(--text-muted); }

/* 右侧详情 */
.detail-header { margin: 0; flex-shrink: 0; }
.detail-header h3 { font-size: 15px; font-weight: 600; line-height: 1.4; margin: 0 0 8px; overflow-wrap: anywhere; }
.detail-meta { display: flex; flex-wrap: wrap; gap: 8px 14px; font-size: 12px; line-height: 1.4; color: var(--text-muted); }
.unsaved { color: var(--color-warning); font-weight: 500; }

.detail-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; flex-shrink: 0; }
.tag { padding: 2px 8px; font-size: 11px; background: var(--accent-primary); color: white; border-radius: 4px; }
.detail-time { font-size: 12px; line-height: 1.5; color: var(--text-muted); margin: 0; flex-shrink: 0; }

.reader {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.reader-head {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.reader-titles { min-width: 0; flex: 1; }
.reader-titles .detail-tags { margin-top: 8px; }
.reader-titles h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.reader-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-muted);
}
.reader-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px;
  font-size: 14px;
  line-height: 1.75;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border-radius: 8px;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.reader-tools {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
}
.tool-line {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.tool-line .card-label {
  width: 64px;
  flex-shrink: 0;
  padding-top: 8px;
}
.tool-line .card-input,
.tool-line .search-input {
  flex: 1;
  min-width: 0;
}
.tool-line .btn {
  flex-shrink: 0;
  white-space: nowrap;
}
.tool-confirm { align-self: flex-start; margin-left: 74px; }
.more { color: var(--text-muted); font-style: italic; }

.no-selection {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: var(--text-muted);
  font-size: 13px; text-align: center;
}

/* 编辑器 */
.editor-area { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.editor-textarea {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 10px;
  font-size: 12px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  line-height: 1.5;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  resize: none;
  tab-size: 2;
  overflow-y: auto;
}
.editor-textarea:focus { outline: none; border-color: var(--accent-primary); }
.editor-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding-top: 0; margin: 0; }
.editor-hint { font-size: 11px; color: var(--text-muted); }
</style>
