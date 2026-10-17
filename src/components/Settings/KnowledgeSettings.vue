<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X, Trash2, AlertTriangle } from 'lucide-vue-next'
import { showConfirm, showAlert } from '../../composables/useConfirm'
import AttachmentFileIcon from '../AttachmentFileIcon.vue'
import {
  SettingsPage,
  SettingsGroup,
  SettingRow,
  SettingInput,
  SettingToggle,
  SettingSelect,
  SettingNotice,
} from './kit'

const { t } = useI18n()
const api = window.electronAPI as any

// ==================== 类型 ====================

interface KnowledgeSettings {
  enabled: boolean
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | 'lite' | 'standard' | 'large'
  embeddingDevice?: 'auto' | 'cpu' | 'gpu' | 'coreml' | 'cuda' | 'dml' | 'webgpu'
  embeddingMcpServerId?: string
  autoSaveUploads: boolean
  chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
  searchTopK: number
  enableRerank: boolean
  enableHostMemory: boolean
  mcpKnowledgeServerId?: string
  cardProfileId?: string
  recallFolder?: string
}

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

// ==================== 设置状态 ====================

const settings = ref<KnowledgeSettings>({
  enabled: true,
  embeddingMode: 'local',
  localModel: 'lite',
  embeddingDevice: 'auto',
  autoSaveUploads: true,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true,
  enableHostMemory: true,
  cardProfileId: '',
  recallFolder: '',
})

const loading = ref(true)
const saving = ref(false)
const isKnowledgeInitialized = ref(false)

// ==================== 管理面板状态 ====================

const activeTab = ref<'memory' | 'knowledge'>('memory')

// 记忆
const contextDocs = ref<ContextKnowledgeItem[]>([])
const selectedContextId = ref<string | null>(null)
const contextDocContent = ref('')
const contextDocSaving = ref(false)
const contextDocDirty = ref(false)
const contextKnowledgeMaxChars = ref(5000)
const contextKnowledgeMaxCharsDraft = ref<number | ''>(5000)
const contextKnowledgeMaxCharsMin = ref(1000)
const contextKnowledgeMaxCharsMax = ref(20000)
const contextKnowledgeMaxCharsSaving = ref(false)

// 知识库文档
const documents = ref<KnowledgeDocument[]>([])
const storedFolders = ref<string[]>([])
const searchQuery = ref('')
const browseFolder = ref('')
const addedByFilter = ref<'all' | 'user' | 'agent'>('all')
const cardDraft = ref('')
const folderDraft = ref('')
const cardSaving = ref(false)
const cardProfiles = ref<{ id: string; name: string }[]>([])
const selectedDoc = ref<KnowledgeDocument | null>(null)
const selectedDocIds = ref<Set<string>>(new Set())
const batchDeleting = ref(false)
const clearing = ref(false)
const repairing = ref(false)
const repairProgress = ref<{ current: number; total: number; filename: string } | null>(null)

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

const cardCounts = computed(() => {
  const counts = { pending: 0, ready: 0, failed: 0, stale: 0 }
  for (const doc of kbDocuments.value) {
    const status = doc.cardStatus || 'pending'
    if (status === 'generating' || status === 'pending') counts.pending += 1
    else if (status === 'ready') counts.ready += 1
    else if (status === 'failed') counts.failed += 1
    else if (status === 'stale') counts.stale += 1
  }
  return counts
})

const cardProfileOptions = computed(() => [
  { value: '', label: t('knowledgeManager.cardProfileOff') },
  ...cardProfiles.value.map(profile => ({ value: profile.id, label: profile.name })),
])

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

function inBrowseFolder(folder: string | undefined): boolean {
  const prefix = browseFolder.value
  const value = folder || ''
  if (!prefix) return true
  return value === prefix || value.startsWith(`${prefix}/`)
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

// ==================== 设置加载/保存 ====================

const loadSettings = async () => {
  try {
    loading.value = true
    isKnowledgeInitialized.value = await api.knowledge.isInitialized()
    settings.value = await api.knowledge.getSettings()
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    if (settings.value.mcpKnowledgeServerId) {
      settings.value.mcpKnowledgeServerId = ''
      await saveSettings()
    }
    if (!settings.value.enabled) {
      settings.value.enabled = true
      await saveSettings()
    }
    settings.value.cardProfileId = settings.value.cardProfileId || ''
    settings.value.recallFolder = settings.value.recallFolder || ''
    const profiles = await api.config.getAiProfiles()
    cardProfiles.value = (profiles || []).map((profile: { id: string; name?: string }) => ({
      id: profile.id,
      name: profile.name || profile.id,
    }))
    await loadAllData()
  } catch (error) {
    console.error('加载设置失败:', error)
  } finally {
    loading.value = false
  }
}

const saveSettings = async () => {
  try {
    saving.value = true
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    settings.value.mcpKnowledgeServerId = ''
    const plainSettings = JSON.parse(JSON.stringify(settings.value))
    const result = await api.knowledge.updateSettings(plainSettings)
    if (!result.success) {
      console.error('保存设置失败:', result.error)
    }
  } catch (error) {
    console.error('保存设置异常:', error)
  } finally {
    saving.value = false
  }
}

const onAutoSaveUploads = async (enabled: boolean) => {
  settings.value.autoSaveUploads = enabled
  await saveSettings()
}

const onEmbeddingDevice = async (device: string) => {
  settings.value.embeddingDevice = device as KnowledgeSettings['embeddingDevice']
  await saveSettings()
}

const embeddingDeviceOptions = computed(() => [
  { value: 'auto', label: t('knowledgeSettings.embeddingDeviceAuto') },
  { value: 'cpu', label: t('knowledgeSettings.embeddingDeviceCpu') },
])

// ==================== 数据加载 ====================

const loadAllData = async () => {
  await Promise.all([loadContextDocs(), loadKnowledgeDocs()])
}

const loadContextDocs = async () => {
  try {
    const result = await window.electronAPI.contextKnowledge.list()
    if (result.success) {
      contextDocs.value = result.items
      if (typeof result.maxDocChars === 'number' && result.maxDocChars > 0) {
        contextKnowledgeMaxChars.value = result.maxDocChars
        contextKnowledgeMaxCharsDraft.value = result.maxDocChars
      }
      if (typeof result.minDocChars === 'number' && result.minDocChars > 0) {
        contextKnowledgeMaxCharsMin.value = result.minDocChars
      }
      if (typeof result.maxDocCharsLimit === 'number' && result.maxDocCharsLimit > 0) {
        contextKnowledgeMaxCharsMax.value = result.maxDocCharsLimit
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

const commitMemoryMaxChars = async () => {
  if (contextKnowledgeMaxCharsSaving.value) return
  if (contextKnowledgeMaxCharsDraft.value === '') {
    contextKnowledgeMaxCharsDraft.value = contextKnowledgeMaxChars.value
    return
  }
  let v = Math.round(Number(contextKnowledgeMaxCharsDraft.value))
  if (!Number.isFinite(v)) v = contextKnowledgeMaxChars.value
  if (v < contextKnowledgeMaxCharsMin.value) v = contextKnowledgeMaxCharsMin.value
  if (v > contextKnowledgeMaxCharsMax.value) v = contextKnowledgeMaxCharsMax.value
  contextKnowledgeMaxCharsDraft.value = v
  if (v === contextKnowledgeMaxChars.value) return
  contextKnowledgeMaxCharsSaving.value = true
  try {
    const result = await window.electronAPI.contextKnowledge.setMaxDocChars(v)
    if (result.success) {
      contextKnowledgeMaxChars.value = result.maxDocChars
      contextKnowledgeMaxCharsDraft.value = result.maxDocChars
    } else {
      contextKnowledgeMaxCharsDraft.value = contextKnowledgeMaxChars.value
    }
  } catch (error) {
    console.error('保存记忆长度失败:', error)
    contextKnowledgeMaxCharsDraft.value = contextKnowledgeMaxChars.value
  } finally {
    contextKnowledgeMaxCharsSaving.value = false
  }
}

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

const onCardProfile = async (profileId: string) => {
  settings.value.cardProfileId = profileId
  await saveSettings()
}

const onRecallFolder = async () => {
  settings.value.recallFolder = (settings.value.recallFolder || '').trim()
  await saveSettings()
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

const clearKnowledge = async () => {
  if (kbDocuments.value.length === 0) return
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('knowledgeSettings.clearLabel'),
    message: t('knowledgeManager.confirmClear', { count: kbDocuments.value.length }),
    confirmText: t('knowledgeSettings.clearAction'),
    typedPhrase: t('knowledgeSettings.clearConfirmPhrase'),
  })
  if (!confirmed) return
  try {
    clearing.value = true
    const docIds = kbDocuments.value.map(d => d.id)
    await api.knowledge.removeDocuments(docIds)
    await loadKnowledgeDocs()
    selectedDoc.value = null
    clearSelection()
  } catch (error) {
    console.error('Clear knowledge base failed:', error)
    await loadKnowledgeDocs()
  } finally {
    clearing.value = false
  }
}

const repairKnowledge = async () => {
  try {
    repairing.value = true
    repairProgress.value = null

    const unsubProgress = api.knowledge.onRepairProgress?.((data: { current: number; total: number; filename: string }) => {
      repairProgress.value = data
    })

    const result = await api.knowledge.repairIndex()

    unsubProgress?.()
    repairProgress.value = null

    if (result.success) {
      const secs = ((result.durationMs || 0) / 1000).toFixed(1)
      await showAlert(t('common.success'), t('knowledgeManager.repairSuccess', {
        added: result.added ?? 0,
        checked: result.checked ?? 0,
        secs,
      }))
    } else {
      await showAlert(t('common.error'), t('knowledgeManager.repairFailed') + ': ' + (result.error || t('knowledgeManager.unknownError')))
    }
  } catch (error) {
    console.error('Repair index failed:', error)
    await showAlert(t('common.error'), t('knowledgeManager.repairFailed'))
  } finally {
    repairing.value = false
    repairProgress.value = null
  }
}

// ==================== 生命周期 ====================

let unsubscribeKnowledgeReady: (() => void) | null = null

onMounted(() => {
  loadSettings()
  unsubscribeKnowledgeReady = api.knowledge.onReady(() => {
    isKnowledgeInitialized.value = true
    loadSettings()
  })
})

onUnmounted(() => {
  unsubscribeKnowledgeReady?.()
})
</script>

<template>
  <SettingsPage class="knowledge-page" :title="t('settings.tabs.knowledge')" :desc="t('knowledgeSettings.description')">
    <SettingNotice v-if="loading">{{ t('common.loading') }}</SettingNotice>
    <SettingNotice v-else-if="!isKnowledgeInitialized">
      <Loader2 class="spinner" :size="16" />
      <span>{{ t('knowledgeSettings.initializing') }}</span>
    </SettingNotice>

    <template v-else>
      <div class="manager-panel">
        <div class="tab-bar">
          <button class="tab-btn" :class="{ active: activeTab === 'memory' }" @click="activeTab = 'memory'">
            {{ t('knowledgeManager.memoryTab', { count: contextDocs.length }) }}
          </button>
          <button class="tab-btn" :class="{ active: activeTab === 'knowledge' }" @click="activeTab = 'knowledge'">
            {{ t('knowledgeManager.knowledgeTab', { count: kbDocuments.length }) }}
          </button>
        </div>

        <div class="manager-body">
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
                  <div class="folder-bar">
                    <button type="button" class="folder-chip" :class="{ on: browseFolder === '' }" @click="browseFolder = ''">
                      {{ t('knowledgeManager.folderAll') }}
                    </button>
                    <button
                      v-for="folder in folders"
                      :key="folder"
                      type="button"
                      class="folder-chip"
                      :class="{ on: browseFolder === folder }"
                      @click="browseFolder = folder"
                    >{{ folder }}</button>
                  </div>
                  <div class="search-bar">
                    <input type="text" v-model="searchQuery" :placeholder="t('knowledgeManager.searchPlaceholder')" class="search-input" />
                    <SettingSelect
                      :model-value="addedByFilter"
                      block
                      :options="sourceOptions"
                      @update:model-value="onSourceFilter"
                    />
                  </div>
                  <p class="card-progress">
                    {{ t('knowledgeManager.cardProgress', cardCounts) }}
                  </p>
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
                      <div class="doc-name">{{ doc.folder ? `${doc.folder}/` : '' }}{{ doc.filename }}</div>
                      <div class="doc-meta">
                        <span>{{ formatSize(doc.fileSize) }}</span>
                        <span>{{ doc.chunkCount }} {{ t('knowledgeManager.chunk') }}</span>
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
                          <span>{{ selectedDoc.fileType }}</span>
                          <span>{{ formatSize(selectedDoc.fileSize) }}</span>
                          <span>{{ selectedDoc.chunkCount }} {{ t('knowledgeManager.chunk') }}</span>
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

      <SettingsGroup :title="t('knowledgeSettings.memoryLengthGroup')">
        <SettingRow
          :label="t('knowledgeSettings.memoryMaxChars')"
          :desc="t('knowledgeSettings.memoryMaxCharsHint')"
        >
          <SettingInput
            v-model="contextKnowledgeMaxCharsDraft"
            type="number"
            compact
            :min="contextKnowledgeMaxCharsMin"
            :max="contextKnowledgeMaxCharsMax"
            :disabled="contextKnowledgeMaxCharsSaving"
            @change="commitMemoryMaxChars"
            @blur="commitMemoryMaxChars"
          />
          <span class="memory-max-unit">{{ t('knowledgeSettings.memoryMaxCharsUnit') }}</span>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup :title="t('knowledgeSettings.archiveGroup')">
        <SettingRow
          :label="t('knowledgeSettings.cardProfile')"
          :desc="t('knowledgeSettings.cardProfileDesc')"
        >
          <SettingSelect
            :model-value="settings.cardProfileId || ''"
            :options="cardProfileOptions"
            @update:model-value="onCardProfile"
          />
        </SettingRow>
        <SettingRow
          :label="t('knowledgeSettings.recallFolder')"
          :desc="t('knowledgeSettings.recallFolderDesc')"
        >
          <SettingInput
            v-model="settings.recallFolder"
            :placeholder="t('knowledgeManager.folderPlaceholder')"
            @change="onRecallFolder"
            @blur="onRecallFolder"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup :title="t('knowledgeSettings.docProcessing')">
        <SettingRow
          clickable
          :label="t('knowledgeSettings.autoSaveUploads')"
          :desc="t('knowledgeSettings.autoSaveUploadsDesc')"
        >
          <SettingToggle
            :model-value="settings.autoSaveUploads"
            @update:model-value="onAutoSaveUploads"
          />
        </SettingRow>
        <SettingRow
          :label="t('knowledgeSettings.embeddingDevice')"
          :desc="t('knowledgeSettings.embeddingDeviceDesc')"
        >
          <SettingSelect
            :model-value="settings.embeddingDevice || 'auto'"
            :options="embeddingDeviceOptions"
            @update:model-value="onEmbeddingDevice"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup :title="t('knowledgeSettings.maintainGroup')">
        <SettingRow
          :label="t('knowledgeSettings.repairLabel')"
          :desc="t('knowledgeSettings.repairDesc')"
        >
          <button class="btn btn-sm" @click="repairKnowledge" :disabled="repairing">
            <template v-if="repairing">
              {{ repairProgress ? `${repairProgress.current}/${repairProgress.total}` : t('knowledgeManager.repairing') }}
            </template>
            <template v-else>{{ t('knowledgeSettings.repairAction') }}</template>
          </button>
        </SettingRow>
        <SettingRow
          :label="t('knowledgeSettings.clearLabel')"
          :desc="t('knowledgeSettings.clearDesc')"
        >
          <button
            class="btn btn-danger-fill"
            @click="clearKnowledge"
            :disabled="kbDocuments.length === 0 || clearing"
          >
            <AlertTriangle :size="14" />
            {{ clearing ? t('knowledgeManager.clearing') : t('knowledgeSettings.clearAction') }}
          </button>
        </SettingRow>
      </SettingsGroup>
      </template>
    </SettingsPage>
</template>

<style scoped>
.spinner { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.memory-max-unit {
  font-size: var(--fs-desc);
  color: var(--text-secondary);
}

.btn-danger-fill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid rgba(var(--color-error-rgb), 0.45);
  background: var(--color-error);
  color: #fff;
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s, opacity 0.2s;
}

.btn-danger-fill:hover:not(:disabled) {
  filter: brightness(1.08);
}

.btn-danger-fill:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ==================== 内嵌管理面板 ==================== */
.manager-panel {
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
  height: calc(100vh - 220px);
  min-height: 560px;
}

.list-panel {
  width: 280px;
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
.memory-item.active { background: var(--accent-primary); color: white; }
.memory-item:hover .btn-del, .memory-item.active .btn-del { opacity: 1; }
.memory-item .btn-del { position: absolute; top: 6px; right: 6px; }

.memory-label { font-size: 12px; font-weight: 500; }
.memory-preview { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.memory-item.active .memory-preview { color: rgba(255, 255, 255, 0.7); }
.memory-item.active .btn-del { color: rgba(255, 255, 255, 0.7); }
.memory-item.active .btn-del:hover { color: white; }

/* 文档条目 */
.doc-item {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 6px; cursor: pointer;
  transition: all 0.15s; border: 1px solid transparent;
}
.doc-item:hover { background: var(--bg-hover); }
.doc-item.active { background: var(--accent-primary); color: white; }
.doc-item.selected:not(.active) { background: var(--bg-hover); border-color: var(--accent-primary); }
.doc-item:hover .btn-del-hover { opacity: 1; }

.doc-check { display: flex; align-items: center; flex-shrink: 0; }
.doc-check input { width: 13px; height: 13px; cursor: pointer; }
.doc-type-icon { flex-shrink: 0; }
.doc-info { flex: 1; min-width: 0; }
.doc-name { font-size: 13px; font-weight: 500; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.folder-bar { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; }
.folder-chip {
  border: 1px solid var(--border-color, #ddd);
  background: transparent;
  border-radius: 999px;
  padding: 4px 12px;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
}
.folder-chip.on { border-color: var(--accent-primary); color: var(--accent-primary); }
.card-progress { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-muted); }
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
.doc-item.active .doc-meta { color: rgba(255, 255, 255, 0.7); }

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
