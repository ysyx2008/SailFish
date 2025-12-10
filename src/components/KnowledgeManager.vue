<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'

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

const emit = defineEmits<{
  close: []
}>()

const documents = ref<KnowledgeDocument[]>([])
const stats = ref<KnowledgeStats | null>(null)
const loading = ref(true)
const searchQuery = ref('')
const selectedDoc = ref<KnowledgeDocument | null>(null)
const selectedDocIds = ref<Set<string>>(new Set())
const batchDeleting = ref(false)
const clearing = ref(false)

// 过滤后的文档
const filteredDocuments = computed(() => {
  if (!searchQuery.value) return documents.value
  const query = searchQuery.value.toLowerCase()
  return documents.value.filter(doc => 
    doc.filename.toLowerCase().includes(query) ||
    doc.tags.some(tag => tag.toLowerCase().includes(query))
  )
})

// 是否全选
const isAllSelected = computed(() => {
  if (filteredDocuments.value.length === 0) return false
  return filteredDocuments.value.every(doc => selectedDocIds.value.has(doc.id))
})

// 是否有选中项
const hasSelection = computed(() => selectedDocIds.value.size > 0)

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 格式化日期
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

// 加载数据
const loadData = async () => {
  try {
    loading.value = true
    
    // 获取文档列表
    documents.value = await window.electronAPI.knowledge.getDocuments()
    
    // 获取统计信息
    const result = await window.electronAPI.knowledge.getStats()
    if (result.success && result.stats) {
      stats.value = result.stats
    }
  } catch (error) {
    console.error('加载知识库数据失败:', error)
  } finally {
    loading.value = false
  }
}

// 切换单个文档选择
const toggleDocSelection = (docId: string, event: Event) => {
  event.stopPropagation()
  if (selectedDocIds.value.has(docId)) {
    selectedDocIds.value.delete(docId)
  } else {
    selectedDocIds.value.add(docId)
  }
  selectedDocIds.value = new Set(selectedDocIds.value)
}

// 全选/取消全选
const toggleSelectAll = () => {
  if (isAllSelected.value) {
    filteredDocuments.value.forEach(doc => selectedDocIds.value.delete(doc.id))
  } else {
    filteredDocuments.value.forEach(doc => selectedDocIds.value.add(doc.id))
  }
  selectedDocIds.value = new Set(selectedDocIds.value)
}

// 清空选择
const clearSelection = () => {
  selectedDocIds.value = new Set()
}

// 删除文档
const deleteDocument = async (doc: KnowledgeDocument) => {
  if (!confirm(t('knowledgeManager.confirmDelete', { name: doc.filename }))) {
    return
  }
  
  try {
    const result = await window.electronAPI.knowledge.removeDocument(doc.id)
    if (result.success) {
      await loadData()
      selectedDocIds.value.delete(doc.id)
      selectedDocIds.value = new Set(selectedDocIds.value)
      if (selectedDoc.value?.id === doc.id) {
        selectedDoc.value = null
      }
    } else {
      alert(`${t('knowledgeManager.deleteFailed')}: ${result.error}`)
    }
  } catch (error) {
    console.error('Delete document failed:', error)
  }
}

// 批量删除文档
const batchDeleteDocuments = async () => {
  const count = selectedDocIds.value.size
  if (count === 0) return
  
  if (!confirm(t('knowledgeManager.confirmBatchDelete', { count }))) {
    return
  }
  
  try {
    batchDeleting.value = true
    const docIds = Array.from(selectedDocIds.value)
    const result = await window.electronAPI.knowledge.removeDocuments(docIds)
    
    if (result.success) {
      await loadData()
      clearSelection()
      if (selectedDoc.value && docIds.includes(selectedDoc.value.id)) {
        selectedDoc.value = null
      }
    } else {
      alert(`${t('knowledgeManager.batchDeleteFailed')}: ${result.error}`)
    }
  } catch (error) {
    console.error('Batch delete documents failed:', error)
  } finally {
    batchDeleting.value = false
  }
}

// 清空知识库
const clearKnowledge = async () => {
  if (documents.value.length === 0) return
  
  if (!confirm(t('knowledgeManager.confirmClear', { count: documents.value.length }))) {
    return
  }
  
  try {
    clearing.value = true
    const result = await window.electronAPI.knowledge.clear()
    if (result.success) {
      await loadData()
      selectedDoc.value = null
      clearSelection()
    } else {
      alert(`${t('knowledgeManager.clearFailed')}: ${result.error}`)
    }
  } catch (error) {
    console.error('Clear knowledge base failed:', error)
  } finally {
    clearing.value = false
  }
}

// 查看文档详情
const viewDocument = (doc: KnowledgeDocument) => {
  selectedDoc.value = doc
}

onMounted(() => {
  loadData()
})
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="knowledge-manager">
      <div class="manager-header">
        <h2>📚 {{ t('knowledgeManager.title') }}</h2>
        <button class="btn-icon" @click="emit('close')" :title="t('knowledgeManager.close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="manager-body">
        <!-- 左侧：文档列表 -->
        <div class="doc-list-panel">
          <!-- 统计信息 -->
          <div v-if="stats" class="stats-bar">
            <span>{{ stats.documentCount }} {{ t('knowledgeManager.documents') }}</span>
            <span>{{ stats.chunkCount }} {{ t('knowledgeManager.chunks') }}</span>
            <span>{{ formatSize(stats.totalSize) }}</span>
          </div>

          <!-- 搜索框 -->
          <div class="search-bar">
            <input 
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
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
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
              :disabled="documents.length === 0 || clearing"
            >
              {{ clearing ? t('knowledgeManager.clearing') : t('knowledgeManager.clearAll') }}
            </button>
          </div>
        </div>

        <!-- 右侧：文档详情 -->
        <div class="doc-detail-panel">
          <template v-if="selectedDoc">
            <div class="detail-header">
              <h3>{{ selectedDoc.filename }}</h3>
              <div class="detail-meta">
                <span>{{ t('knowledgeManager.type') }}：{{ selectedDoc.fileType }}</span>
                <span>{{ t('knowledgeManager.size') }}：{{ formatSize(selectedDoc.fileSize) }}</span>
                <span>{{ t('knowledgeManager.chunkCount') }}：{{ selectedDoc.chunkCount }}</span>
              </div>
            </div>

            <div class="detail-section">
              <h4>{{ t('knowledgeManager.tags') }}</h4>
              <div class="tags-list">
                <span v-for="tag in selectedDoc.tags" :key="tag" class="tag">
                  {{ tag }}
                </span>
                <span v-if="selectedDoc.tags.length === 0" class="no-tags">
                  {{ t('knowledgeManager.noTags') }}
                </span>
              </div>
            </div>

            <div class="detail-section">
              <h4>{{ t('knowledgeManager.timeInfo') }}</h4>
              <div class="time-info">
                <div>{{ t('knowledgeManager.createdAt') }}：{{ formatDate(selectedDoc.createdAt) }}</div>
                <div>{{ t('knowledgeManager.updatedAt') }}：{{ formatDate(selectedDoc.updatedAt) }}</div>
              </div>
            </div>

            <div class="detail-section">
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

/* 左侧文档列表 */
.doc-list-panel {
  width: 320px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
}

.stats-bar {
  display: flex;
  gap: 16px;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
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

.doc-item:hover {
  background: var(--bg-hover);
}

.doc-item.active {
  background: var(--accent-primary);
  color: white;
}

.doc-item.selected:not(.active) {
  background: rgba(59, 130, 246, 0.1);
  border-color: rgba(59, 130, 246, 0.3);
}

.doc-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.doc-info {
  flex: 1;
  min-width: 0;
}

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

.doc-item.active .doc-meta {
  color: rgba(255, 255, 255, 0.7);
}

.btn-delete {
  opacity: 0;
  transition: opacity 0.2s;
}

.doc-item:hover .btn-delete {
  opacity: 1;
}

.empty-state,
.loading-state {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.list-actions {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

/* 右侧详情 */
.doc-detail-panel {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

.detail-header {
  margin-bottom: 20px;
}

.detail-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
}

.detail-meta {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: var(--text-muted);
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  padding: 2px 8px;
  font-size: 11px;
  background: var(--accent-primary);
  color: white;
  border-radius: 4px;
}

.no-tags {
  font-size: 12px;
  color: var(--text-muted);
}

.time-info {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.content-preview {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  padding: 12px;
  border-radius: 6px;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.more {
  color: var(--text-muted);
  font-style: italic;
}

.no-selection {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

/* 按钮样式 */
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

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn {
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

.btn-danger {
  background: var(--danger-color, #ef4444);
  color: white;
}

.btn-danger:hover {
  filter: brightness(1.1);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

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

.checkbox-wrapper input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

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

.btn-link:hover {
  text-decoration: underline;
}

/* 文档复选框 */
.doc-checkbox {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.doc-checkbox input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}
</style>

