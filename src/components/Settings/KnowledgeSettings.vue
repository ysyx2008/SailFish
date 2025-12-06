<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'

// 获取 API（类型在 preload 中定义）
const api = window.electronAPI as any

interface KnowledgeSettings {
  enabled: boolean
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | 'lite' | 'standard' | 'large'
  embeddingMcpServerId?: string
  autoSaveUploads: boolean
  maxChunkSize: number
  chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
  searchTopK: number
  enableRerank: boolean
  mcpKnowledgeServerId?: string
}

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
}

interface KnowledgeDocument {
  id: string
  filename: string
  fileSize: number
  fileType: string
  chunkCount: number
  createdAt: number
}

const settings = ref<KnowledgeSettings>({
  enabled: false,
  embeddingMode: 'local',
  localModel: 'lite',
  autoSaveUploads: false,
  maxChunkSize: 512,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true
})

const mcpServers = ref<McpServerStatus[]>([])
const documents = ref<KnowledgeDocument[]>([])
const loading = ref(true)
const saving = ref(false)
const deletingDocId = ref<string | null>(null)
const currentPage = ref(1)
const pageSize = 10
const showDocManager = ref(false)
const exporting = ref(false)
const importing = ref(false)

// 分页计算
const totalPages = computed(() => Math.ceil(documents.value.length / pageSize))
const paginatedDocs = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return documents.value.slice(start, start + pageSize)
})

// 翻页
const goToPage = (page: number) => {
  if (page >= 1 && page <= totalPages.value) {
    currentPage.value = page
  }
}

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 格式化日期
const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleDateString('zh-CN')
}

// 加载设置
const loadSettings = async () => {
  try {
    loading.value = true
    
    // 获取知识库设置
    settings.value = await api.knowledge.getSettings()
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    // 获取 MCP 服务器状态
    mcpServers.value = await api.mcp.getServerStatuses()
    
    // 获取文档列表
    if (settings.value.enabled) {
      await loadDocuments()
    }
  } catch (error) {
    console.error('加载设置失败:', error)
  } finally {
    loading.value = false
  }
}

// 加载文档列表
const loadDocuments = async () => {
  try {
    documents.value = await api.knowledge.getDocuments() || []
  } catch (error) {
    console.error('加载文档列表失败:', error)
  }
}

// 保存设置
const saveSettings = async () => {
  try {
    saving.value = true
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    const plainSettings = JSON.parse(JSON.stringify(settings.value))
    
    const result = await api.knowledge.updateSettings(plainSettings)
    if (!result.success) {
      console.error('保存设置失败:', result.error)
    }
    
    // 如果启用了知识库，加载文档列表
    if (settings.value.enabled) {
      await loadDocuments()
    }
  } catch (error) {
    console.error('保存设置异常:', error)
  } finally {
    saving.value = false
  }
}

// 删除文档
const deleteDocument = async (doc: KnowledgeDocument) => {
  if (!confirm(`确定要删除文档"${doc.filename}"吗？此操作不可恢复。`)) {
    return
  }
  
  try {
    deletingDocId.value = doc.id
    const result = await api.knowledge.removeDocument(doc.id)
    if (result.success) {
      documents.value = documents.value.filter(d => d.id !== doc.id)
    } else {
      alert('删除失败: ' + (result.error || '未知错误'))
    }
  } catch (error) {
    console.error('删除文档失败:', error)
    alert('删除失败')
  } finally {
    deletingDocId.value = null
  }
}

// 导出知识库
const exportKnowledge = async () => {
  try {
    exporting.value = true
    const result = await api.knowledge.exportData()
    if (result.canceled) return
    if (result.success) {
      alert(`导出成功！\n保存位置: ${result.path}`)
    } else {
      alert('导出失败: ' + (result.error || '未知错误'))
    }
  } catch (error) {
    console.error('导出失败:', error)
    alert('导出失败')
  } finally {
    exporting.value = false
  }
}

// 导入知识库
const importKnowledge = async () => {
  if (!confirm('导入将覆盖现有知识库数据，确定继续吗？')) {
    return
  }
  
  try {
    importing.value = true
    const result = await api.knowledge.importData()
    if (result.canceled) return
    if (result.success) {
      alert(`导入成功！共导入 ${result.imported || 0} 个文档`)
      await loadDocuments()
    } else {
      alert('导入失败: ' + (result.error || '未知错误'))
    }
  } catch (error) {
    console.error('导入失败:', error)
    alert('导入失败')
  } finally {
    importing.value = false
  }
}

onMounted(() => {
  loadSettings()
})
</script>

<template>
  <div class="knowledge-settings">
    <div v-if="loading" class="loading">
      加载中...
    </div>
    
    <template v-else>
      <!-- 启用开关 -->
      <div class="setting-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">启用知识库</label>
            <p class="setting-desc">开启后可将文档存储到本地知识库，AI 对话时自动检索相关内容</p>
          </div>
          <label class="switch">
            <input 
              type="checkbox" 
              v-model="settings.enabled"
              @change="saveSettings"
            />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <template v-if="settings.enabled">
        <!-- 向量嵌入说明 -->
        <div class="setting-group">
          <h4 class="group-title">向量嵌入</h4>
          
          <div class="info-box">
            <span class="info-icon">📦</span>
            <div class="info-content">
              <p class="info-title">使用内置轻量模型</p>
              <p class="info-desc">采用 all-MiniLM-L6-v2 模型（21MB），已随软件打包，无需额外下载</p>
            </div>
          </div>
        </div>

        <!-- MCP 知识库 -->
        <div class="setting-group">
          <h4 class="group-title">外部知识库</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">MCP 知识库服务</label>
              <p class="setting-desc">可选接入外部知识库 MCP 服务，与本地知识库协同搜索</p>
            </div>
            <select 
              v-model="settings.mcpKnowledgeServerId" 
              class="select"
              @change="saveSettings"
            >
              <option value="">不使用</option>
              <option 
                v-for="server in mcpServers.filter(s => s.connected)" 
                :key="server.id"
                :value="server.id"
              >
                {{ server.name }}
              </option>
            </select>
          </div>
        </div>

        <!-- 搜索设置 -->
        <div class="setting-group">
          <h4 class="group-title">搜索设置</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">返回结果数</label>
              <p class="setting-desc">每次搜索返回的最大结果数量</p>
            </div>
            <input 
              type="number" 
              v-model.number="settings.searchTopK" 
              class="input input-sm"
              min="1"
              max="50"
              @change="saveSettings"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">启用重排序</label>
              <p class="setting-desc">使用 LLM 对搜索结果进行重新排序，提高准确性</p>
            </div>
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="settings.enableRerank"
                @change="saveSettings"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- 文档处理 -->
        <div class="setting-group">
          <h4 class="group-title">文档处理</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">自动保存上传文档</label>
              <p class="setting-desc">上传的文档自动保存到知识库</p>
            </div>
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="settings.autoSaveUploads"
                @change="saveSettings"
              />
              <span class="slider"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">分块策略</label>
              <p class="setting-desc">长文档的切分方式</p>
            </div>
            <select 
              v-model="settings.chunkStrategy" 
              class="select"
              @change="saveSettings"
            >
              <option value="paragraph">按段落</option>
              <option value="semantic">语义分块</option>
              <option value="fixed">固定大小</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">最大分块大小</label>
              <p class="setting-desc">每个分块的最大 token 数（128-4096）</p>
            </div>
            <input 
              type="number" 
              v-model.number="settings.maxChunkSize" 
              class="input input-sm"
              min="128"
              max="4096"
              step="64"
              @change="saveSettings"
            />
          </div>
        </div>

        <!-- 文档管理 -->
        <div class="setting-group">
          <h4 class="group-title">文档管理</h4>
          
          <div class="doc-summary">
            <span class="doc-stat">
              📄 {{ documents.length }} 个文档
            </span>
            <button class="btn btn-sm" @click="showDocManager = true; loadDocuments()">
              管理文档
            </button>
          </div>
        </div>
      </template>
    </template>
    
    <!-- 文档管理弹窗 -->
    <Teleport to="body">
      <div v-if="showDocManager" class="doc-modal-overlay" @click.self="showDocManager = false">
        <div class="doc-modal">
          <div class="doc-modal-header">
            <h3>📚 知识库文档</h3>
            <button class="close-btn" @click="showDocManager = false">✕</button>
          </div>
          
          <div class="doc-modal-content">
            <div v-if="documents.length === 0" class="empty-docs">
              暂无文档，上传文档后会自动添加到知识库
            </div>
            
            <template v-else>
              <div class="doc-list">
                <div 
                  v-for="doc in paginatedDocs" 
                  :key="doc.id" 
                  class="doc-item"
                >
                  <div class="doc-info">
                    <span class="doc-name">{{ doc.filename }}</span>
                    <span class="doc-meta">
                      {{ formatSize(doc.fileSize) }} · {{ doc.chunkCount }} 个分块 · {{ formatDate(doc.createdAt) }}
                    </span>
                  </div>
                  <button 
                    class="btn-delete"
                    :disabled="deletingDocId === doc.id"
                    @click="deleteDocument(doc)"
                    :title="'删除 ' + doc.filename"
                  >
                    {{ deletingDocId === doc.id ? '...' : '🗑️' }}
                  </button>
                </div>
              </div>
              
              <!-- 分页 -->
              <div v-if="totalPages > 1" class="pagination">
                <button 
                  class="page-btn" 
                  :disabled="currentPage === 1"
                  @click="goToPage(currentPage - 1)"
                >
                  ‹
                </button>
                <span class="page-info">{{ currentPage }} / {{ totalPages }}</span>
                <button 
                  class="page-btn" 
                  :disabled="currentPage === totalPages"
                  @click="goToPage(currentPage + 1)"
                >
                  ›
                </button>
              </div>
            </template>
          </div>
          
          <div class="doc-modal-footer">
            <span class="doc-count-info">共 {{ documents.length }} 个文档</span>
            <div class="footer-actions">
              <button class="btn btn-sm" @click="exportKnowledge" :disabled="exporting">
                {{ exporting ? '导出中...' : '📤 导出' }}
              </button>
              <button class="btn btn-sm" @click="importKnowledge" :disabled="importing">
                {{ importing ? '导入中...' : '📥 导入' }}
              </button>
              <button class="btn btn-sm" @click="loadDocuments">🔄 刷新</button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.knowledge-settings {
  width: 100%;
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.setting-group {
  margin-bottom: 24px;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 20px;
  align-items: start;
  padding: 12px 0;
}

.setting-info {
  min-width: 200px;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.setting-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
}

/* 信息框 */
.info-box {
  display: flex;
  gap: 12px;
  padding: 14px;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(59, 130, 246, 0.1));
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 8px;
}

.info-icon {
  font-size: 24px;
}

.info-content {
  flex: 1;
}

.info-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.info-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background-color: var(--bg-tertiary);
  transition: 0.3s;
  border-radius: 24px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--accent-primary);
}

input:checked + .slider:before {
  transform: translateX(20px);
}

.select {
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  min-width: 140px;
}

.input {
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  width: 80px;
}

.input-sm {
  width: 80px;
}

/* 文档摘要 */
.doc-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.doc-stat {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 文档管理弹窗 */
.doc-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.doc-modal {
  width: 90%;
  max-width: 600px;
  max-height: 70vh;
  background: var(--bg-primary);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
}

.doc-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.doc-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.doc-modal-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 200px;
}

.doc-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
}

.doc-count-info {
  font-size: 12px;
  color: var(--text-muted);
}

.footer-actions {
  display: flex;
  gap: 8px;
}

/* 文档列表 */
.empty-docs {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
  font-size: 13px;
}

.doc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.doc-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  transition: background 0.2s;
}

.doc-item:hover {
  background: var(--bg-hover);
}

.doc-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.doc-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.doc-meta {
  font-size: 11px;
  color: var(--text-muted);
}

.btn-delete {
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-delete:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.btn-delete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 分页 */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.page-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  transition: all 0.2s;
}

.page-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--accent-primary);
}

.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.page-info {
  font-size: 12px;
  color: var(--text-secondary);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}
</style>
