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
const activeTab = ref<'documents' | 'memories'>('documents')
const exporting = ref(false)
const importing = ref(false)

// 普通文档（排除主机记忆）
const normalDocuments = computed(() => {
  return documents.value.filter(doc => doc.fileType !== 'host-memory')
})

// 主机记忆文档
const memoryDocuments = computed(() => {
  return documents.value.filter(doc => doc.fileType === 'host-memory')
})

// 按主机分组的记忆
const memoriesByHost = computed(() => {
  const grouped = new Map<string, KnowledgeDocument[]>()
  for (const doc of memoryDocuments.value) {
    const hostId = doc.hostId || 'unknown'
    if (!grouped.has(hostId)) {
      grouped.set(hostId, [])
    }
    grouped.get(hostId)!.push(doc)
  }
  // 按时间倒序排序每个主机的记忆
  for (const [, memories] of grouped) {
    memories.sort((a, b) => b.createdAt - a.createdAt)
  }
  return grouped
})

// 过滤后的文档（仅普通文档）
const filteredDocuments = computed(() => {
  const docs = normalDocuments.value
  if (!searchQuery.value) return docs
  const query = searchQuery.value.toLowerCase()
  return docs.filter(doc => 
    doc.filename.toLowerCase().includes(query) ||
    doc.tags.some(tag => tag.toLowerCase().includes(query))
  )
})

// 过滤后的记忆
const filteredMemories = computed(() => {
  if (!searchQuery.value) return memoryDocuments.value
  const query = searchQuery.value.toLowerCase()
  return memoryDocuments.value.filter(doc => 
    doc.content.toLowerCase().includes(query) ||
    (doc.hostId || '').toLowerCase().includes(query)
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

// 清空知识库（仅普通文档）
const clearKnowledge = async () => {
  if (normalDocuments.value.length === 0) return
  
  if (!confirm(t('knowledgeManager.confirmClear', { count: normalDocuments.value.length }))) {
    return
  }
  
  try {
    clearing.value = true
    // 只删除普通文档，保留主机记忆
    const docIds = normalDocuments.value.map(d => d.id)
    const result = await window.electronAPI.knowledge.removeDocuments(docIds)
    
    // 无论成功与否都刷新数据，显示实际状态
    await loadData()
    selectedDoc.value = null
    clearSelection()
    
    // 如果有删除失败的情况，提示用户
    if (result.failed && result.failed > 0) {
      alert(`${t('knowledgeManager.clearFailed')}: ${result.deleted} 个成功, ${result.failed} 个失败`)
    }
  } catch (error) {
    console.error('Clear knowledge base failed:', error)
    // 出错也刷新数据
    await loadData()
  } finally {
    clearing.value = false
  }
}

// 清空所有主机记忆
const clearAllMemories = async () => {
  if (memoryDocuments.value.length === 0) return
  
  if (!confirm(`确定要清空所有主机记忆吗？共 ${memoryDocuments.value.length} 条记忆将被删除。`)) {
    return
  }
  
  try {
    clearing.value = true
    const docIds = memoryDocuments.value.map(d => d.id)
    const result = await window.electronAPI.knowledge.removeDocuments(docIds)
    
    // 无论成功与否都刷新数据，显示实际状态
    await loadData()
    if (selectedDoc.value && selectedDoc.value.fileType === 'host-memory') {
      selectedDoc.value = null
    }
    
    // 如果有删除失败的情况，提示用户
    if (result.failed && result.failed > 0) {
      alert(`清空记忆部分失败: ${result.deleted} 条成功, ${result.failed} 条失败`)
    }
  } catch (error) {
    console.error('Clear memories failed:', error)
    // 出错也刷新数据
    await loadData()
  } finally {
    clearing.value = false
  }
}

// 查看文档详情
const viewDocument = (doc: KnowledgeDocument) => {
  selectedDoc.value = doc
}

// 导出知识库
const exportKnowledge = async () => {
  try {
    exporting.value = true
    const result = await window.electronAPI.knowledge.exportData()
    if (result.canceled) return
    if (result.success) {
      let msg = t('knowledgeManager.exportSuccess', { path: result.path })
      if (result.hasPassword) {
        msg += '\n\n⚠️ ' + t('knowledgeManager.exportEncryptedHint')
      }
      alert(msg)
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

// 导入知识库
const importKnowledge = async () => {
  if (!confirm(t('knowledgeManager.confirmImport') + '\n\n💡 ' + t('knowledgeManager.importPasswordHint'))) {
    return
  }
  
  try {
    importing.value = true
    const result = await window.electronAPI.knowledge.importData()
    if (result.canceled) return
    if (result.success) {
      let msg = t('knowledgeManager.importSuccess', { count: result.imported || 0 })
      if (result.needsPassword) {
        msg += '\n\n🔐 ' + t('knowledgeManager.importEncryptedHint')
      }
      alert(msg)
      await loadData()
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

// 搜索框引用
const searchInputRef = ref<HTMLInputElement | null>(null)

// ESC 关闭处理
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation() // 阻止事件传播到父组件，防止同时关闭设置界面
    emit('close')
  }
}

onMounted(async () => {
  loadData()
  
  // 添加键盘事件监听
  document.addEventListener('keydown', handleKeydown, true)
  
  // 聚焦到搜索框
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
        <h2>📚 {{ t('knowledgeManager.title') }}</h2>
        <button class="btn-icon" @click="emit('close')" :title="t('knowledgeManager.close')">
          <X :size="18" />
        </button>
      </div>

      <div class="manager-body">
        <!-- 左侧：文档列表 -->
        <div class="doc-list-panel">
          <!-- 统计信息 -->
          <div v-if="stats" class="stats-bar">
            <span>{{ normalDocuments.length }} {{ t('knowledgeManager.tabDocuments') }}</span>
            <span>{{ memoryDocuments.length }} {{ t('knowledgeManager.tabMemories') }}</span>
            <span>{{ formatSize(stats.totalSize) }}</span>
          </div>

          <!-- 标签页切换 -->
          <div class="tab-bar">
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'documents' }"
              @click="activeTab = 'documents'"
            >
              📄 {{ t('knowledgeManager.tabDocuments') }} ({{ normalDocuments.length }})
            </button>
            <button 
              class="tab-btn" 
              :class="{ active: activeTab === 'memories' }"
              @click="activeTab = 'memories'"
            >
              🧠 {{ t('knowledgeManager.tabMemories') }} ({{ memoryDocuments.length }})
            </button>
          </div>

          <!-- 搜索框 -->
          <div class="search-bar">
            <input 
              ref="searchInputRef"
              type="text"
              v-model="searchQuery"
              :placeholder="activeTab === 'documents' ? t('knowledgeManager.searchPlaceholder') : t('knowledgeManager.searchMemoriesPlaceholder')"
              class="search-input"
            />
          </div>

          <!-- 文档标签页 -->
          <template v-if="activeTab === 'documents'">
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
                :disabled="normalDocuments.length === 0 || clearing"
              >
                {{ clearing ? t('knowledgeManager.clearing') : t('knowledgeManager.clearAll') }}
              </button>
              <button class="btn btn-sm" @click="exportKnowledge" :disabled="exporting">
                {{ exporting ? t('knowledgeManager.exporting') : `📤 ${t('knowledgeManager.export')}` }}
              </button>
              <button class="btn btn-sm" @click="importKnowledge" :disabled="importing">
                {{ importing ? t('knowledgeManager.importing') : `📥 ${t('knowledgeManager.import')}` }}
              </button>
              <button class="btn btn-sm" @click="loadData">🔄 {{ t('knowledgeManager.refresh') }}</button>
            </div>
          </template>

          <!-- 主机记忆标签页 -->
          <template v-else>
            <div class="memory-list" v-if="!loading">
              <!-- 按主机分组显示 -->
              <div v-for="[hostId, memories] in memoriesByHost" :key="hostId" class="memory-group">
                <div class="memory-group-header">
                  <span class="host-icon">{{ hostId === 'local' ? '💻' : '🌐' }}</span>
                  <span class="host-name">{{ hostId }}</span>
                  <span class="memory-count">{{ t('knowledgeManager.memoryCount', { count: memories.length }) }}</span>
                </div>
                <div class="memory-items">
                  <div 
                    v-for="memory in (searchQuery ? memories.filter(m => m.content.toLowerCase().includes(searchQuery.toLowerCase())) : memories)" 
                    :key="memory.id"
                    class="memory-item"
                    :class="{ active: selectedDoc?.id === memory.id }"
                    @click="viewDocument(memory)"
                  >
                    <div class="memory-content">{{ memory.content }}</div>
                    <div class="memory-meta">
                      <span>{{ formatDate(memory.createdAt) }}</span>
                      <button 
                        class="btn-icon btn-delete-small"
                        @click.stop="deleteDocument(memory)"
                        :title="t('knowledgeManager.delete')"
                      >
                        <X :size="12" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div v-if="filteredMemories.length === 0" class="empty-state">
                {{ searchQuery ? t('knowledgeManager.noMatchingMemories') : t('knowledgeManager.noMemories') }}
              </div>
            </div>

            <div v-else class="loading-state">
              {{ t('knowledgeManager.loading') }}
            </div>

            <!-- 记忆操作按钮 -->
            <div class="list-actions" v-if="memoryDocuments.length > 0">
              <button 
                class="btn btn-danger btn-sm"
                @click="clearAllMemories"
                :disabled="clearing"
              >
                {{ clearing ? t('knowledgeManager.clearingMemories') : t('knowledgeManager.clearAllMemories') }}
              </button>
            </div>
          </template>
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

            <div class="detail-row">
              <div class="detail-section detail-section-half">
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
  background: var(--bg-hover);
  border-color: var(--accent-primary);
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
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* 右侧详情 */
.doc-detail-panel {
  flex: 1;
  padding: 20px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
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

.detail-row {
  display: flex;
  gap: 20px;
  margin-bottom: 16px;
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section-half {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
}

.detail-section-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  margin-bottom: 0;
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
  flex: 1;
  min-height: 0;
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
  background: var(--accent-error);
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

/* 标签页样式 */
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

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab-btn.active {
  color: var(--accent-primary);
  border-bottom-color: var(--accent-primary);
}

/* 主机记忆列表样式 */
.memory-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.memory-group {
  margin-bottom: 16px;
}

.memory-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  margin-bottom: 8px;
}

.host-icon {
  font-size: 16px;
}

.host-name {
  font-size: 13px;
  font-weight: 600;
  flex: 1;
}

.memory-count {
  font-size: 11px;
  color: var(--text-muted);
}

.memory-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.memory-item {
  padding: 10px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s;
}

.memory-item:hover {
  border-color: var(--accent-primary);
}

.memory-item.active {
  border-color: var(--accent-primary);
  background: var(--bg-hover);
}

.memory-content {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.memory-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.btn-delete-small {
  width: 20px;
  height: 20px;
  opacity: 0;
  transition: opacity 0.2s;
}

.memory-item:hover .btn-delete-small {
  opacity: 1;
}

.btn-delete-small:hover {
  color: var(--accent-error);
}
</style>

