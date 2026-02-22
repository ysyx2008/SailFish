<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, X, Trash2 } from 'lucide-vue-next'

const { t } = useI18n()
const api = window.electronAPI as any

// ==================== 类型 ====================

interface KnowledgeSettings {
  enabled: boolean
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | 'lite' | 'standard' | 'large'
  embeddingMcpServerId?: string
  autoSaveUploads: boolean
  chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
  searchTopK: number
  enableRerank: boolean
  enableHostMemory: boolean
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
  content: string
  fileSize: number
  fileType: string
  hostId?: string
  chunkCount: number
  createdAt: number
  updatedAt: number
  tags: string[]
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
  autoSaveUploads: true,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true,
  enableHostMemory: true
})

const mcpServers = ref<McpServerStatus[]>([])
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

// 知识库文档
const documents = ref<KnowledgeDocument[]>([])
const searchQuery = ref('')
const selectedDoc = ref<KnowledgeDocument | null>(null)
const selectedDocIds = ref<Set<string>>(new Set())
const batchDeleting = ref(false)
const clearing = ref(false)
const exporting = ref(false)
const importing = ref(false)

const kbDocuments = computed(() => {
  return documents.value.filter(doc => doc.fileType !== 'host-memory')
})

const filteredDocuments = computed(() => {
  const docs = kbDocuments.value
  if (!searchQuery.value) return docs
  const query = searchQuery.value.toLowerCase()
  return docs.filter(doc =>
    doc.filename.toLowerCase().includes(query) ||
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
  if (contextId === 'local') return '💻 本地主机'
  if (contextId === 'personal') return '👤 个人'
  return `🌐 ${contextId}`
}

// ==================== 设置加载/保存 ====================

const loadSettings = async () => {
  try {
    loading.value = true
    isKnowledgeInitialized.value = await api.knowledge.isInitialized()
    settings.value = await api.knowledge.getSettings()
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    mcpServers.value = await api.mcp.getServerStatuses()
    if (!settings.value.enabled) {
      settings.value.enabled = true
      await saveSettings()
    }
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

// ==================== 数据加载 ====================

const loadAllData = async () => {
  await Promise.all([loadContextDocs(), loadKnowledgeDocs()])
}

const loadContextDocs = async () => {
  try {
    const result = await window.electronAPI.contextKnowledge.list()
    if (result.success) contextDocs.value = result.items
  } catch (error) {
    console.error('加载记忆失败:', error)
  }
}

const loadKnowledgeDocs = async () => {
  try {
    documents.value = await api.knowledge.getDocuments() || []
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
      alert('保存失败: ' + (result.error || '未知错误'))
    }
  } catch (error) {
    console.error('保存记忆失败:', error)
  } finally {
    contextDocSaving.value = false
  }
}

const deleteContextDoc = async (contextId: string) => {
  if (!confirm(`确定删除「${getContextLabel(contextId)}」的记忆吗？`)) return
  try {
    const result = await window.electronAPI.contextKnowledge.delete(contextId)
    if (result.success) {
      if (selectedContextId.value === contextId) {
        selectedContextId.value = null
        contextDocContent.value = ''
        contextDocDirty.value = false
      }
      await loadContextDocs()
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

const viewDocument = (doc: KnowledgeDocument) => { selectedDoc.value = doc }

const deleteDocument = async (doc: KnowledgeDocument) => {
  if (!confirm(t('knowledgeManager.confirmDelete', { name: doc.filename }))) return
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
  if (!confirm(t('knowledgeManager.confirmBatchDelete', { count }))) return
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
  if (!confirm(t('knowledgeManager.confirmClear', { count: kbDocuments.value.length }))) return
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

const exportKnowledge = async () => {
  try {
    exporting.value = true
    const result = await api.knowledge.exportData()
    if (result.canceled) return
    if (result.success) alert(t('knowledgeManager.exportSuccess', { path: result.path }))
    else alert(t('knowledgeManager.exportFailed') + ': ' + (result.error || ''))
  } catch (error) {
    console.error('Export failed:', error)
  } finally {
    exporting.value = false
  }
}

const importKnowledge = async () => {
  if (!confirm(t('knowledgeManager.confirmImport'))) return
  try {
    importing.value = true
    const result = await api.knowledge.importData()
    if (result.canceled) return
    if (result.success) {
      alert(t('knowledgeManager.importSuccess', { count: result.imported || 0 }))
      await loadKnowledgeDocs()
    }
  } catch (error) {
    console.error('Import failed:', error)
  } finally {
    importing.value = false
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
  <div class="knowledge-settings">
    <div v-if="loading" class="loading">{{ t('common.loading') }}</div>

    <template v-else>
      <!-- 初始化中 -->
      <div v-if="!isKnowledgeInitialized" class="init-status">
        <Loader2 class="spinner" :size="16" />
        <span>{{ t('knowledgeSettings.initializing') }}</span>
      </div>

      <template v-else>
        <!-- ==================== 内嵌管理面板 ==================== -->
        <div class="manager-panel">
          <!-- Tab 栏 -->
          <div class="tab-bar">
            <button class="tab-btn" :class="{ active: activeTab === 'memory' }" @click="activeTab = 'memory'">
              💡 记忆 ({{ contextDocs.length }})
            </button>
            <button class="tab-btn" :class="{ active: activeTab === 'knowledge' }" @click="activeTab = 'knowledge'">
              📚 知识库 ({{ kbDocuments.length }})
            </button>
          </div>

          <div class="manager-body">
            <!-- 左侧列表 -->
            <div class="list-panel">

              <!-- ===== 记忆 tab ===== -->
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
                    <div class="memory-preview">{{ item.content.substring(0, 80) || '（空）' }}</div>
                    <button class="btn-icon btn-del" @click.stop="deleteContextDoc(item.contextId)" title="删除">
                      <X :size="12" />
                    </button>
                  </div>
                  <div v-if="contextDocs.length === 0" class="empty-state">
                    <p>暂无记忆</p>
                    <p class="hint">Agent 执行任务后会自动积累</p>
                  </div>
                </div>
                <div class="list-actions">
                  <button class="btn btn-sm" @click="loadContextDocs">🔄 刷新</button>
                </div>
              </template>

              <!-- ===== 知识库 tab ===== -->
              <template v-if="activeTab === 'knowledge'">
                <div class="search-bar">
                  <input type="text" v-model="searchQuery" :placeholder="t('knowledgeManager.searchPlaceholder')" class="search-input" />
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
                    <div class="doc-icon">{{ doc.fileType === 'pdf' ? '📄' : doc.fileType === 'docx' ? '📝' : '📃' }}</div>
                    <div class="doc-info">
                      <div class="doc-name">{{ doc.filename }}</div>
                      <div class="doc-meta">
                        <span>{{ formatSize(doc.fileSize) }}</span>
                        <span>{{ doc.chunkCount }} {{ t('knowledgeManager.chunk') }}</span>
                      </div>
                    </div>
                    <button class="btn-icon btn-del-hover" @click.stop="deleteDocument(doc)" title="删除">
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
                  <button class="btn btn-danger btn-sm" @click="clearKnowledge" :disabled="kbDocuments.length === 0 || clearing">
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

            <!-- 右侧详情/编辑 -->
            <div class="detail-panel">
              <!-- 记忆编辑 -->
              <template v-if="activeTab === 'memory'">
                <template v-if="selectedContextId">
                  <div class="detail-header">
                    <h3>{{ getContextLabel(selectedContextId) }}</h3>
                    <div class="detail-meta">
                      <span>{{ contextDocContent.length }} 字符</span>
                      <span v-if="contextDocDirty" class="unsaved">● 未保存</span>
                    </div>
                  </div>
                  <div class="editor-area">
                    <textarea
                      v-model="contextDocContent"
                      @input="onContextDocInput"
                      class="editor-textarea"
                      placeholder="在此编辑记忆内容（Markdown 格式）&#10;&#10;Agent 会在每次任务结束后自动更新此文档。&#10;你也可以手动编辑来纠正或补充信息。"
                      spellcheck="false"
                    ></textarea>
                  </div>
                  <div class="editor-actions">
                    <button class="btn btn-primary btn-sm" @click="saveContextDoc" :disabled="contextDocSaving || !contextDocDirty">
                      {{ contextDocSaving ? '保存中...' : '💾 保存' }}
                    </button>
                    <span class="editor-hint">Agent 执行任务后会自动更新</span>
                  </div>
                </template>
                <div v-else class="no-selection">
                  <p>选择左侧记忆进行查看或编辑</p>
                  <p class="hint">每台主机各有独立的记忆文档</p>
                </div>
              </template>

              <!-- 知识库文档详情 -->
              <template v-else>
                <template v-if="selectedDoc">
                  <div class="detail-header">
                    <h3>{{ selectedDoc.filename }}</h3>
                    <div class="detail-meta">
                      <span>{{ selectedDoc.fileType }}</span>
                      <span>{{ formatSize(selectedDoc.fileSize) }}</span>
                      <span>{{ selectedDoc.chunkCount }} {{ t('knowledgeManager.chunk') }}</span>
                    </div>
                  </div>
                  <div class="detail-tags" v-if="selectedDoc.tags?.length">
                    <span v-for="tag in selectedDoc.tags" :key="tag" class="tag">{{ tag }}</span>
                  </div>
                  <div class="detail-time">
                    {{ t('knowledgeManager.createdAt') }}：{{ formatDate(selectedDoc.createdAt) }} ·
                    {{ t('knowledgeManager.updatedAt') }}：{{ formatDate(selectedDoc.updatedAt) }}
                  </div>
                  <div class="content-preview">
                    {{ selectedDoc.content.slice(0, 2000) }}
                    <span v-if="selectedDoc.content.length > 2000" class="more">
                      ... ({{ t('knowledgeManager.totalChars', { count: selectedDoc.content.length }) }})
                    </span>
                  </div>
                </template>
                <div v-else class="no-selection">
                  <p>{{ t('knowledgeManager.selectDocToView') }}</p>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- ==================== 底部设置栏 ==================== -->
        <div class="bottom-settings">
          <div class="bottom-item">
            <label class="setting-label">{{ t('knowledgeSettings.autoSaveUploads') }}</label>
            <label class="switch">
              <input type="checkbox" v-model="settings.autoSaveUploads" @change="saveSettings" />
              <span class="slider"></span>
            </label>
          </div>
          <div class="bottom-item">
            <label class="setting-label">{{ t('knowledgeSettings.mcpKnowledgeService') }}</label>
            <select v-model="settings.mcpKnowledgeServerId" class="select select-sm" @change="saveSettings">
              <option value="">{{ t('knowledgeSettings.notUse') }}</option>
              <option v-for="server in mcpServers.filter(s => s.connected)" :key="server.id" :value="server.id">
                {{ server.name }}
              </option>
            </select>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.knowledge-settings { width: 100%; }

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.init-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.init-status .spinner { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.setting-group { margin-bottom: 24px; }

.setting-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 20px;
  align-items: start;
  padding: 12px 0;
}

.setting-info { min-width: 200px; }
.setting-label { font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 4px; }
.setting-desc { font-size: 12px; color: var(--text-muted); margin: 0; line-height: 1.5; }

/* Toggle switch */
.switch { position: relative; display: inline-block; width: 44px; height: 24px; }
.switch input { opacity: 0; width: 0; height: 0; }
.slider {
  position: absolute; cursor: pointer; inset: 0;
  background-color: var(--bg-tertiary); transition: 0.3s; border-radius: 24px;
}
.slider:before {
  position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px;
  background-color: white; transition: 0.3s; border-radius: 50%;
}
input:checked + .slider { background-color: var(--accent-primary); }
input:checked + .slider:before { transform: translateX(20px); }

.select {
  padding: 8px 12px; font-size: 13px;
  border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--bg-tertiary); color: var(--text-primary); min-width: 140px;
}
.select-sm { padding: 5px 8px; font-size: 12px; min-width: 100px; }

/* 底部设置栏 */
.bottom-settings {
  display: flex;
  gap: 24px;
  padding: 12px 0 4px;
}

.bottom-item {
  display: flex;
  align-items: center;
  gap: 10px;
}

.bottom-item .setting-label { font-size: 12px; margin: 0; white-space: nowrap; }

/* ==================== 内嵌管理面板 ==================== */
.manager-panel {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 24px;
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
  height: calc(100vh - 280px);
  min-height: 360px;
}

.list-panel {
  width: 280px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
}

.detail-panel {
  flex: 1;
  padding: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 搜索 */
.search-bar { padding: 10px 12px; border-bottom: 1px solid var(--border-color); }
.search-input {
  width: 100%; padding: 6px 10px; font-size: 12px;
  border: 1px solid var(--border-color); border-radius: 5px;
  background: var(--bg-tertiary); color: var(--text-primary);
}

/* 批量操作 */
.batch-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 6px 12px; background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color); font-size: 11px;
}
.check-wrap { display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--text-secondary); }
.check-wrap input { width: 13px; height: 13px; cursor: pointer; }
.sel-info { color: var(--text-muted); display: flex; align-items: center; gap: 6px; }
.btn-link { background: none; border: none; color: var(--accent-primary); cursor: pointer; font-size: 11px; padding: 0; }
.btn-link:hover { text-decoration: underline; }

/* 列表 */
.item-list { flex: 1; overflow-y: auto; padding: 6px; }

.list-actions {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
  display: flex; flex-wrap: wrap; gap: 6px;
}

/* 记忆条目 */
.memory-item {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px 10px; border-radius: 5px; cursor: pointer;
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
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 5px; cursor: pointer;
  transition: all 0.15s; border: 1px solid transparent;
}
.doc-item:hover { background: var(--bg-hover); }
.doc-item.active { background: var(--accent-primary); color: white; }
.doc-item.selected:not(.active) { background: var(--bg-hover); border-color: var(--accent-primary); }
.doc-item:hover .btn-del-hover { opacity: 1; }

.doc-check { display: flex; align-items: center; flex-shrink: 0; }
.doc-check input { width: 13px; height: 13px; cursor: pointer; }
.doc-icon { font-size: 20px; flex-shrink: 0; }
.doc-info { flex: 1; min-width: 0; }
.doc-name { font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.doc-meta { display: flex; gap: 6px; font-size: 10px; color: var(--text-muted); margin-top: 1px; }
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

.btn {
  padding: 6px 12px; font-size: 12px; border-radius: 5px;
  border: 1px solid var(--border-color); background: var(--bg-tertiary);
  color: var(--text-primary); cursor: pointer; transition: all 0.2s;
}
.btn:hover { background: var(--bg-hover); }
.btn-sm { padding: 5px 10px; font-size: 11px; }
.btn-danger { background: var(--accent-error); color: white; border-color: var(--accent-error); }
.btn-danger:hover { filter: brightness(1.1); }
.btn-primary { background: var(--accent-primary); color: white; border-color: var(--accent-primary); }
.btn-primary:hover { filter: brightness(1.1); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.empty-state { text-align: center; padding: 30px 16px; color: var(--text-muted); font-size: 13px; }
.empty-state .hint, .hint { font-size: 11px; margin-top: 6px; color: var(--text-muted); }

/* 右侧详情 */
.detail-header { margin-bottom: 12px; }
.detail-header h3 { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.detail-meta { display: flex; gap: 12px; font-size: 11px; color: var(--text-muted); }
.unsaved { color: var(--accent-warning, #f59e0b); font-weight: 500; }

.detail-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.tag { padding: 1px 6px; font-size: 10px; background: var(--accent-primary); color: white; border-radius: 3px; }
.detail-time { font-size: 11px; color: var(--text-muted); margin-bottom: 10px; }

.content-preview {
  font-size: 12px; line-height: 1.5; color: var(--text-secondary);
  background: var(--bg-tertiary); padding: 10px; border-radius: 6px;
  flex: 1; min-height: 0; overflow-y: auto; white-space: pre-wrap; word-break: break-all;
}
.more { color: var(--text-muted); font-style: italic; }

.no-selection {
  height: 100%; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: var(--text-muted);
  font-size: 13px; text-align: center;
}

/* 编辑器 */
.editor-area { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.editor-textarea {
  flex: 1; width: 100%; padding: 10px; font-size: 12px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  line-height: 1.5; border: 1px solid var(--border-color); border-radius: 6px;
  background: var(--bg-tertiary); color: var(--text-primary); resize: none; tab-size: 2;
}
.editor-textarea:focus { outline: none; border-color: var(--accent-primary); }
.editor-actions { display: flex; align-items: center; gap: 10px; padding-top: 8px; }
.editor-hint { font-size: 11px; color: var(--text-muted); }
</style>
