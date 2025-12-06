<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

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

// 过滤后的文档
const filteredDocuments = computed(() => {
  if (!searchQuery.value) return documents.value
  const query = searchQuery.value.toLowerCase()
  return documents.value.filter(doc => 
    doc.filename.toLowerCase().includes(query) ||
    doc.tags.some(tag => tag.toLowerCase().includes(query))
  )
})

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 格式化日期
const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN', {
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

// 删除文档
const deleteDocument = async (doc: KnowledgeDocument) => {
  if (!confirm(`确定要删除 "${doc.filename}" 吗？`)) {
    return
  }
  
  try {
    const result = await window.electronAPI.knowledge.removeDocument(doc.id)
    if (result.success) {
      await loadData()
      if (selectedDoc.value?.id === doc.id) {
        selectedDoc.value = null
      }
    } else {
      alert(`删除失败: ${result.error}`)
    }
  } catch (error) {
    console.error('删除文档失败:', error)
  }
}

// 清空知识库
const clearKnowledge = async () => {
  if (!confirm('确定要清空整个知识库吗？此操作不可恢复！')) {
    return
  }
  
  try {
    const result = await window.electronAPI.knowledge.clear()
    if (result.success) {
      await loadData()
      selectedDoc.value = null
    } else {
      alert(`清空失败: ${result.error}`)
    }
  } catch (error) {
    console.error('清空知识库失败:', error)
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
        <h2>📚 知识库管理</h2>
        <button class="btn-icon" @click="emit('close')" title="关闭">
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
            <span>{{ stats.documentCount }} 个文档</span>
            <span>{{ stats.chunkCount }} 个分块</span>
            <span>{{ formatSize(stats.totalSize) }}</span>
          </div>

          <!-- 搜索框 -->
          <div class="search-bar">
            <input 
              type="text"
              v-model="searchQuery"
              placeholder="搜索文档..."
              class="search-input"
            />
          </div>

          <!-- 文档列表 -->
          <div class="doc-list" v-if="!loading">
            <div 
              v-for="doc in filteredDocuments" 
              :key="doc.id"
              class="doc-item"
              :class="{ active: selectedDoc?.id === doc.id }"
              @click="viewDocument(doc)"
            >
              <div class="doc-icon">
                {{ doc.fileType === 'pdf' ? '📄' : doc.fileType === 'docx' ? '📝' : '📃' }}
              </div>
              <div class="doc-info">
                <div class="doc-name">{{ doc.filename }}</div>
                <div class="doc-meta">
                  <span>{{ formatSize(doc.fileSize) }}</span>
                  <span>{{ doc.chunkCount }} 块</span>
                </div>
              </div>
              <button 
                class="btn-icon btn-delete"
                @click.stop="deleteDocument(doc)"
                title="删除"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>

            <div v-if="filteredDocuments.length === 0" class="empty-state">
              {{ searchQuery ? '没有找到匹配的文档' : '知识库为空' }}
            </div>
          </div>

          <div v-else class="loading-state">
            加载中...
          </div>

          <!-- 操作按钮 -->
          <div class="list-actions">
            <button 
              class="btn btn-danger btn-sm"
              @click="clearKnowledge"
              :disabled="documents.length === 0"
            >
              清空知识库
            </button>
          </div>
        </div>

        <!-- 右侧：文档详情 -->
        <div class="doc-detail-panel">
          <template v-if="selectedDoc">
            <div class="detail-header">
              <h3>{{ selectedDoc.filename }}</h3>
              <div class="detail-meta">
                <span>类型：{{ selectedDoc.fileType }}</span>
                <span>大小：{{ formatSize(selectedDoc.fileSize) }}</span>
                <span>分块：{{ selectedDoc.chunkCount }}</span>
              </div>
            </div>

            <div class="detail-section">
              <h4>标签</h4>
              <div class="tags-list">
                <span v-for="tag in selectedDoc.tags" :key="tag" class="tag">
                  {{ tag }}
                </span>
                <span v-if="selectedDoc.tags.length === 0" class="no-tags">
                  无标签
                </span>
              </div>
            </div>

            <div class="detail-section">
              <h4>时间信息</h4>
              <div class="time-info">
                <div>创建时间：{{ formatDate(selectedDoc.createdAt) }}</div>
                <div>更新时间：{{ formatDate(selectedDoc.updatedAt) }}</div>
              </div>
            </div>

            <div class="detail-section">
              <h4>内容预览</h4>
              <div class="content-preview">
                {{ selectedDoc.content.slice(0, 1000) }}
                <span v-if="selectedDoc.content.length > 1000" class="more">
                  ... (共 {{ selectedDoc.content.length }} 字符)
                </span>
              </div>
            </div>
          </template>

          <div v-else class="no-selection">
            <p>选择一个文档查看详情</p>
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
  transition: background 0.2s;
}

.doc-item:hover {
  background: var(--bg-hover);
}

.doc-item.active {
  background: var(--accent-primary);
  color: white;
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
</style>

