<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Trash2 } from 'lucide-vue-next'

const { t } = useI18n()

interface KnowledgeDocument {
  id: string
  filename: string
  content: string
  fileSize: number
  fileType: string
  hostId?: string
  tags: string[]
  createdAt: number
  updatedAt: number
  chunkCount: number
}

interface KnowledgeStats {
  documentCount: number
  chunkCount: number
  totalSize: number
  lastUpdated?: number
}

interface ContextKnowledgeItem {
  contextId: string
  content: string
}

const emit = defineEmits<{
  close: []
}>()

// ==================== 共享状态 ====================
const loading = ref(true)
const activeTab = ref<'memory' | 'knowledge'>('memory')

// ==================== 记忆 tab 状态 ====================
const contextDocs = ref<ContextKnowledgeItem[]>([])
const selectedContextId = ref<string | null>(null)
const contextDocContent = ref('')
const contextDocSaving = ref(false)
const contextDocDirty = ref(false)

// ==================== 知识库 tab 状态 ====================
const documents = ref<KnowledgeDocument[]>([])
const stats = ref<KnowledgeStats | null>(null)
const searchQuery = ref('')
const selectedDoc = ref<KnowledgeDocument | null>(null)
const selectedDocIds = ref<Set<string>>(new Set())
const batchDeleting = ref(false)
const clearing = ref(false)
const exporting = ref(false)
const importing = ref(false)

// 知识库文档（排除旧的 host-memory 类型）
const kbDocuments = computed(() => {
  return documents.value.filter(doc => doc.fileType !== 'host-memory')
})

const filteredDocuments = computed(() => {
  const docs = kbDocuments.value
  if (!searchQuery.value) return docs
  const query = searchQuery.value.toLowerCase()
  return docs.filter(doc => 
    doc.filename.toLowerCase().includes(query) ||
    doc.tags.some(tag => tag.toLowerCase().includes(query))
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
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const getContextLabel = (contextId: string): string => {
  if (contextId === 'local') return '💻 本地主机'
  if (contextId === 'personal') return '👤 个人'
  return `🌐 ${contextId}`
}

// ==================== 数据加载 ====================

const loadData = async () => {
  try {
    loading.value = true
    await Promise.all([loadContextDocs(), loadKnowledgeDocs()])
  } catch (error) {
    console.error('加载数据失败:', error)
  } finally {
    loading.value = false
  }
}

const loadContextDocs = async () => {
  try {
    const result = await window.electronAPI.contextKnowledge.list()
    if (result.success) {
      contextDocs.value = result.items
    }
  } catch (error) {
    console.error('加载记忆失败:', error)
  }
}

const loadKnowledgeDocs = async () => {
  try {
    documents.value = await window.electronAPI.knowledge.getDocuments()
    const result = await window.electronAPI.knowledge.getStats()
    if (result.success && result.stats) {
      stats.value = result.stats
    }
  } catch (error) {
    console.error('加载知识库失败:', error)
  }
}

// ==================== 记忆操作 ====================

const selectContextDoc = (item: ContextKnowledgeItem) => {
  if (contextDocDirty.value && selectedContextId.value) {
    if (!confirm('当前记忆有未保存的修改，确定要切换吗？')) return
  }
  selectedContextId.value = item.contextId
  contextDocContent.value = item.content
  contextDocDirty.value = false
}

const onContextDocInput = () => {
  contextDocDirty.value = true
}

const saveContextDoc = async () => {
  if (!selectedContextId.value) return
  try {
    contextDocSaving.value = true
    const result = await window.electronAPI.contextKnowledge.set(
      selectedContextId.value,
      contextDocContent.value
    )
    if (result.success) {
      contextDocDirty.value = false
      await loadContextDocs()
    } else {
      alert('保存失败: ' + (result.error || '未知错误'))
    }
  } catch (error) {
    console.error('保存记忆失败:', error)
  } finally {
    contextDocSaving.value = false
  }
}

const deleteContextDoc = async (contextId: string) => {
  const label = getContextLabel(contextId)
  if (!confirm(`确定删除「${label}」的记忆吗？`)) return
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
      alert('删除失败: ' + (result.error || '未知错误'))
    }
  } catch (error) {
    console.error('删除记忆失败:', error)
  }
}

// ==================== 知识库操作 ====================

const toggleDocSelection = (docId: string, event: Event) => {
  event.stopPropagation()
  if (selectedDocIds.value.has(docId)) {
    selectedDocIds.value.delete(docId)
  } else {
    selectedDocIds.value.add(docId)
  }
  selectedDocIds.value = new Set(selectedDocIds.value)
}

const toggleSelectAll = () => {
  if (isAllSelected.value) {
    filteredDocuments.value.forEach(doc => selectedDocIds.value.delete(doc.id))
  } else {
    filteredDocuments.value.forEach(doc => selectedDocIds.value.add(doc.id))
  }
  selectedDocIds.value = new Set(selectedDocIds.value)
}

const clearSelection = () => {
  selectedDocIds.value = new Set()
}

const viewDocument = (doc: KnowledgeDocument) => {
  selectedDoc.value = doc
}

const deleteDocument = async (doc: KnowledgeDocument) => {
  if (!confirm(t('knowledgeManager.confirmDelete', { name: doc.filename }))) return
  try {
    const result = await window.electronAPI.knowledge.removeDocument(doc.id)
    if (result.success) {
      await loadKnowledgeDocs()
      selectedDocIds.value.delete(doc.id)
      selectedDocIds.value = new Set(selectedDocIds.value)
      if (selectedDoc.value?.id === doc.id) selectedDoc.value = null
    } else {
      alert(`${t('knowledgeManager.deleteFailed')}: ${result.error}`)
    }
  } catch (error) {
    console.error('Delete document failed:', error)
  }
}

const batchDeleteDocuments = async () => {
  const count = selectedDocIds.value.size
  if (count === 0) return
  if (!confirm(t('knowledgeManager.confirmBatchDelete', { count }))) return
  try {
    batchDeleting.value = true
    const docIds = Array.from(selectedDocIds.value)
    const result = await window.electronAPI.knowledge.removeDocuments(docIds)
    if (result.success) {
      await loadKnowledgeDocs()
      clearSelection()
      if (selectedDoc.value && docIds.includes(selectedDoc.value.id)) selectedDoc.value = null
    } else {
      alert(`${t('knowledgeManager.batchDeleteFailed')}: ${result.error}`)
    }
  } catch (error) {
    console.error('Batch delete failed:', error)
  } finally {
    batchDeleting.value = false
  }
}

const clearKnowledge = async () => {
  if (kbDocuments.value.length === 0) return
  if (!confirm(t('knowledgeManager.confirmClear', { count: kbDocuments.value.length }))) return
  try {
    clearing.value = true
    const docIds = kbDocuments.value.map(d => d.id)
    const result = await window.electronAPI.knowledge.removeDocuments(docIds)
    await loadKnowledgeDocs()
    selectedDoc.value = null
    clearSelection()
    if (result.failed && result.failed > 0) {
      alert(`${t('knowledgeManager.clearFailed')}: ${result.deleted} 个成功, ${result.failed} 个失败`)
    }
  } catch (error) {
    console.error('Clear knowledge base failed:', error)
    await loadKnowledgeDocs()
  } finally {
    clearing.value = false
  }
}

const exportKnowledge = async () => {
  try {
    exporting.value = true
    const result = await window.electronAPI.knowledge.exportData()
    if (result.canceled) return
    if (result.success) {
      alert(t('knowledgeManager.exportSuccess', { path: result.path }))
    } else {
      alert(t('knowledgeManager.exportFailed') + ': ' + (result.error || t('knowledgeManager.unknownError')))
    }
  } catch (error) {
    console.error('Export failed:', error)
    alert(t('knowledgeManager.exportFailed'))
  } finally {
    exporting.value = false
  }
}

const importKnowledge = async () => {
  if (!confirm(t('knowledgeManager.confirmImport'))) return
  try {
    importing.value = true
    const result = await window.electronAPI.knowledge.importData()
    if (result.canceled) return
    if (result.success) {
      alert(t('knowledgeManager.importSuccess', { count: result.imported || 0 }))
      await loadKnowledgeDocs()
    } else {
      alert(t('knowledgeManager.importFailed') + ': ' + (result.error || t('knowledgeManager.unknownError')))
    }
  } catch (error) {
    console.error('Import failed:', error)
    alert(t('knowledgeManager.importFailed'))
  } finally {
    importing.value = false
  }
}

// ==================== 生命周期 ====================

const searchInputRef = ref<HTMLInputElement | null>(null)

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    emit('close')
  }
}

onMounted(async () => {
  loadData()
  document.addEventListener('keydown', handleKeydown, true)
  await nextTick()
  searchInputRef.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="knowledge-manager">
      <div class="manager-header">
        <h2>🧠 记忆管理</h2>
        <button class="btn-icon" @click="emit('close')" :title="t('knowledgeManager.close')">
          <X :size="18" />
        </button>
      </div>

      <div class="manager-body">
        <!-- 左侧面板 -->
        <div class="doc-list-panel">
          <!-- 标签页切换 -->
          <div class="tab-bar">
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'memory' }"
              @click="activeTab = 'memory'"
            >
              🧠 记忆 ({{ contextDocs.length }})
            </button>
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'knowledge' }"
              @click="activeTab = 'knowledge'"
            >
              📚 知识库 ({{ kbDocuments.length }})
            </button>
          </div>

          <!-- ==================== 记忆 tab ==================== -->
          <template v-if="activeTab === 'memory'">
            <div class="context-doc-list" v-if="!loading">
              <div 
                v-for="item in contextDocs" 
                :key="item.contextId"
                class="context-doc-item"
                :class="{ active: selectedContextId === item.contextId }"
                @click="selectContextDoc(item)"
              >
                <div class="context-doc-label">{{ getContextLabel(item.contextId) }}</div>
                <div class="context-doc-preview">{{ item.content.substring(0, 80) || '（空）' }}</div>
                <button 
                  class="btn-icon btn-delete-small"
                  @click.stop="deleteContextDoc(item.contextId)"
                  :title="t('knowledgeManager.delete')"
                >
                  <X :size="12" />
                </button>
              </div>

              <div v-if="contextDocs.length === 0" class="empty-state">
                <p>暂无记忆</p>
                <p class="empty-hint">Agent 在执行任务后会自动积累记忆</p>
              </div>
            </div>

            <div v-else class="loading-state">
              {{ t('knowledgeManager.loading') }}
            </div>

            <div class="list-actions">
              <button class="btn btn-sm" @click="loadContextDocs">🔄 {{ t('knowledgeManager.refresh') }}</button>
            </div>
          </template>

          <!-- ==================== 知识库 tab ==================== -->
          <template v-if="activeTab === 'knowledge'">
            <!-- 搜索框 -->
            <div class="search-bar">
              <input 
                ref="searchInputRef"
                type="text"
                v-model="searchQuery"
                :placeholder="t('knowledgeManager.searchPlaceholder')"
                class="search-input"
              />
            </div>

            <!-- 批量操作栏 -->
            <div class="batch-actions-bar" v-if="filteredDocuments.length > 0">
              <label class="checkbox-wrapper">
                <input 
                  type="checkbox" 
                  :checked="isAllSelected"
                  @change="toggleSelectAll"
                />
                <span class="checkbox-label">{{ t('knowledgeManager.selectAll') }}</span>
              </label>
              <span v-if="hasSelection" class="selection-info">
                {{ t('knowledgeManager.selected', { count: selectedDocIds.size }) }}
                <button class="btn-link" @click="clearSelection">{{ t('knowledgeManager.cancel') }}</button>
              </span>
            </div>

            <!-- 文档列表 -->
            <div class="doc-list" v-if="!loading">
              <div 
                v-for="doc in filteredDocuments" 
                :key="doc.id"
                class="doc-item"
                :class="{ active: selectedDoc?.id === doc.id, selected: selectedDocIds.has(doc.id) }"
                @click="viewDocument(doc)"
              >
                <label class="doc-checkbox" @click.stop>
                  <input 
                    type="checkbox" 
                    :checked="selectedDocIds.has(doc.id)"
                    @change="toggleDocSelection(doc.id, $event)"
                  />
                </label>
                <div class="doc-icon">
                  {{ doc.fileType === 'pdf' ? '📄' : doc.fileType === 'docx' ? '📝' : '📃' }}
                </div>
                <div class="doc-info">
                  <div class="doc-name">{{ doc.filename }}</div>
                  <div class="doc-meta">
                    <span>{{ formatSize(doc.fileSize) }}</span>
                    <span>{{ doc.chunkCount }} {{ t('knowledgeManager.chunk') }}</span>
                  </div>
                </div>
                <button 
                  class="btn-icon btn-delete"
                  @click.stop="deleteDocument(doc)"
                  :title="t('knowledgeManager.delete')"
                >
                  <Trash2 :size="14" />
                </button>
              </div>

              <div v-if="filteredDocuments.length === 0" class="empty-state">
                {{ searchQuery ? t('knowledgeManager.noMatchingDocs') : t('knowledgeManager.emptyKnowledge') }}
              </div>
            </div>

            <div v-else class="loading-state">
              {{ t('knowledgeManager.loading') }}
            </div>

            <!-- 操作按钮 -->
            <div class="list-actions">
              <button 
                v-if="hasSelection"
                class="btn btn-danger btn-sm"
                @click="batchDeleteDocuments"
                :disabled="batchDeleting"
              >
                {{ batchDeleting ? t('knowledgeManager.deleting') : `${t('knowledgeManager.deleteSelected')} (${selectedDocIds.size})` }}
              </button>
              <button 
                class="btn btn-danger btn-sm"
                @click="clearKnowledge"
                :disabled="kbDocuments.length === 0 || clearing"
              >
                {{ clearing ? t('knowledgeManager.clearing') : t('knowledgeManager.clearAll') }}
              </button>
              <button class="btn btn-sm" @click="exportKnowledge" :disabled="exporting">
                {{ exporting ? t('knowledgeManager.exporting') : `📤 ${t('knowledgeManager.export')}` }}
              </button>
              <button class="btn btn-sm" @click="importKnowledge" :disabled="importing">
                {{ importing ? t('knowledgeManager.importing') : `📥 ${t('knowledgeManager.import')}` }}
              </button>
              <button class="btn btn-sm" @click="loadKnowledgeDocs">🔄 {{ t('knowledgeManager.refresh') }}</button>
            </div>
          </template>
        </div>

        <!-- 右侧面板 -->
        <div class="doc-detail-panel">
          <!-- 记忆编辑 -->
          <template v-if="activeTab === 'memory'">
            <template v-if="selectedContextId">
              <div class="detail-header">
                <h3>{{ getContextLabel(selectedContextId) }}</h3>
                <div class="detail-meta">
                  <span>{{ contextDocContent.length }} 字符</span>
                  <span v-if="contextDocDirty" class="unsaved-badge">● 未保存</span>
                </div>
              </div>
              <div class="context-doc-editor">
                <textarea
                  v-model="contextDocContent"
                  @input="onContextDocInput"
                  class="context-doc-textarea"
                  placeholder="在此编辑记忆内容（Markdown 格式）&#10;&#10;Agent 会在每次任务结束后自动更新此文档，记录有用的系统信息和用户偏好。&#10;你也可以手动编辑来纠正或补充信息。"
                  spellcheck="false"
                ></textarea>
              </div>
              <div class="context-doc-actions">
                <button 
                  class="btn btn-primary btn-sm" 
                  @click="saveContextDoc"
                  :disabled="contextDocSaving || !contextDocDirty"
                >
                  {{ contextDocSaving ? '保存中...' : '💾 保存' }}
                </button>
                <span class="context-doc-hint">Agent 执行任务后会自动更新</span>
              </div>
            </template>
            <div v-else class="no-selection">
              <div class="no-selection-content">
                <p class="no-selection-title">选择左侧记忆进行查看或编辑</p>
                <p class="no-selection-hint">每台主机、每种连接方式各有独立的记忆文档</p>
              </div>
            </div>
          </template>

          <!-- 知识库文档详情 -->
          <template v-else>
            <template v-if="selectedDoc">
              <div class="detail-header">
                <h3>{{ selectedDoc.filename }}</h3>
                <div class="detail-meta">
                  <span>{{ t('knowledgeManager.type') }}：{{ selectedDoc.fileType }}</span>
                  <span>{{ t('knowledgeManager.size') }}：{{ formatSize(selectedDoc.fileSize) }}</span>
                  <span>{{ t('knowledgeManager.chunkCount') }}：{{ selectedDoc.chunkCount }}</span>
                </div>
              </div>

              <div class="detail-row">
                <div class="detail-section detail-section-half">
                  <h4>{{ t('knowledgeManager.tags') }}</h4>
                  <div class="tags-list">
                    <span v-for="tag in selectedDoc.tags" :key="tag" class="tag">{{ tag }}</span>
                    <span v-if="selectedDoc.tags.length === 0" class="no-tags">{{ t('knowledgeManager.noTags') }}</span>
                  </div>
                </div>
                <div class="detail-section detail-section-half">
                  <h4>{{ t('knowledgeManager.timeInfo') }}</h4>
                  <div class="time-info">
                    <div>{{ t('knowledgeManager.createdAt') }}：{{ formatDate(selectedDoc.createdAt) }}</div>
                    <div>{{ t('knowledgeManager.updatedAt') }}：{{ formatDate(selectedDoc.updatedAt) }}</div>
                  </div>
                </div>
              </div>

              <div class="detail-section detail-section-content">
                <h4>{{ t('knowledgeManager.contentPreview') }}</h4>
                <div class="content-preview">
                  {{ selectedDoc.content.slice(0, 1000) }}
                  <span v-if="selectedDoc.content.length > 1000" class="more">
                    ... ({{ t('knowledgeManager.totalChars', { count: selectedDoc.content.length }) }})
                  </span>
                </div>
              </div>
            </template>

            <div v-else class="no-selection">
              <p>{{ t('knowledgeManager.selectDocToView') }}</p>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.knowledge-manager {
  width: 900px;
  max-width: 95vw;
  height: 600px;
  max-height: 85vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.manager-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.manager-header h2 {
  font-size: 18px;
  font-weight: 600;
}

.manager-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 左侧面板 */
.doc-list-panel {
  width: 320px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
}

.search-bar {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.search-input {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.doc-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.doc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.doc-item:hover { background: var(--bg-hover); }
.doc-item.active { background: var(--accent-primary); color: white; }
.doc-item.selected:not(.active) { background: var(--bg-hover); border-color: var(--accent-primary); }

.doc-icon { font-size: 24px; flex-shrink: 0; }

.doc-info { flex: 1; min-width: 0; }

.doc-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 2px;
}

.doc-item.active .doc-meta { color: rgba(255, 255, 255, 0.7); }

.btn-delete { opacity: 0; transition: opacity 0.2s; }
.doc-item:hover .btn-delete { opacity: 1; }

.empty-state,
.loading-state {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.empty-hint {
  font-size: 12px;
  margin-top: 8px;
  color: var(--text-muted);
}

.list-actions {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 右侧面板 */
.doc-detail-panel {
  flex: 1;
  padding: 20px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.detail-header { margin-bottom: 20px; }
.detail-header h3 { font-size: 16px; font-weight: 600; margin-bottom: 8px; }

.detail-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-muted);
}

.detail-row {
  display: flex;
  gap: 20px;
  margin-bottom: 16px;
}

.detail-section { margin-bottom: 20px; }
.detail-section-half { flex: 1; min-width: 0; margin-bottom: 0; }
.detail-section-content { flex: 1; display: flex; flex-direction: column; min-height: 0; margin-bottom: 0; }
.detail-section h4 { font-size: 13px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; }

.tags-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tag { padding: 2px 8px; font-size: 11px; background: var(--accent-primary); color: white; border-radius: 4px; }
.no-tags { font-size: 12px; color: var(--text-muted); }
.time-info { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }

.content-preview {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: 12px;
  border-radius: 6px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.more { color: var(--text-muted); font-style: italic; }

.no-selection {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.no-selection-content { text-align: center; }
.no-selection-title { font-size: 14px; margin-bottom: 8px; }
.no-selection-hint { font-size: 12px; color: var(--text-muted); }

/* 按钮 */
.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
}

.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

.btn {
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-sm { padding: 6px 12px; font-size: 12px; }
.btn-danger { background: var(--accent-error); color: white; }
.btn-danger:hover { filter: brightness(1.1); }
.btn-primary { background: var(--accent-primary); color: white; }
.btn-primary:hover { filter: brightness(1.1); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 批量操作栏 */
.batch-actions-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.checkbox-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}

.checkbox-wrapper input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; }

.selection-info {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-link {
  background: none;
  border: none;
  color: var(--accent-primary);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.btn-link:hover { text-decoration: underline; }

.doc-checkbox { display: flex; align-items: center; flex-shrink: 0; }
.doc-checkbox input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; }

/* 标签页 */
.tab-bar {
  display: flex;
  border-bottom: 1px solid var(--border-color);
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

.tab-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.tab-btn.active { color: var(--accent-primary); border-bottom-color: var(--accent-primary); }

/* 记忆列表 */
.context-doc-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.context-doc-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
  position: relative;
}

.context-doc-item:hover { background: var(--bg-hover); }
.context-doc-item.active { background: var(--accent-primary); color: white; }

.btn-delete-small {
  width: 20px;
  height: 20px;
  opacity: 0;
  transition: opacity 0.2s;
}

.context-doc-item:hover .btn-delete-small { opacity: 1; }
.btn-delete-small:hover { color: var(--accent-error); }

.context-doc-item .btn-delete-small {
  position: absolute;
  top: 8px;
  right: 8px;
}

.context-doc-label { font-size: 13px; font-weight: 500; }

.context-doc-preview {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-doc-item.active .context-doc-preview { color: rgba(255, 255, 255, 0.7); }

/* 记忆编辑器 */
.context-doc-editor {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.context-doc-textarea {
  flex: 1;
  width: 100%;
  padding: 12px;
  font-size: 13px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  line-height: 1.6;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  resize: none;
  tab-size: 2;
}

.context-doc-textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.context-doc-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 12px;
}

.context-doc-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.unsaved-badge {
  color: var(--accent-warning, #f59e0b);
  font-weight: 500;
}
</style>
