<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'

const { t } = useI18n()

// 历史记录类型
interface ChatRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: 'local' | 'ssh'
  sshHost?: string
  role: 'user' | 'assistant'
  content: string
}

interface AgentStepRecord {
  id: string
  type: string
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: string
  timestamp: number
}

interface AgentRecord {
  id: string
  timestamp: number
  terminalId: string
  terminalType: 'local' | 'ssh'
  sshHost?: string
  userTask: string
  steps: AgentStepRecord[]
  finalResult?: string
  duration: number
  status: 'completed' | 'failed' | 'aborted'
}

// 存储统计
const storageStats = ref<{
  chatFiles: number
  agentFiles: number
  totalSize: number
  oldestRecord?: string
  newestRecord?: string
} | null>(null)

// 数据目录路径
const dataPath = ref('')

// 加载状态
const isLoading = ref(false)
const isExporting = ref(false)
const isImporting = ref(false)

// 消息提示
const message = ref<{ type: 'success' | 'error'; text: string } | null>(null)

// ========== 历史记录查看 ==========
const showHistoryViewer = ref(false)
const historyTab = ref<'chat' | 'agent'>('agent')
const historyLoading = ref(false)
const chatRecords = ref<ChatRecord[]>([])
const agentRecords = ref<AgentRecord[]>([])
const searchKeyword = ref('')
const selectedDateRange = ref<'today' | 'week' | 'month' | 'all'>('week')
const expandedAgentIds = ref<Set<string>>(new Set())

// 日期范围计算
const getDateRange = () => {
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  
  switch (selectedDateRange.value) {
    case 'today':
      return { start: today, end: today }
    case 'week': {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { start: weekAgo.toISOString().split('T')[0], end: today }
    }
    case 'month': {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      return { start: monthAgo.toISOString().split('T')[0], end: today }
    }
    case 'all':
    default:
      return { start: undefined, end: undefined }
  }
}

// 加载历史记录
const loadHistory = async () => {
  historyLoading.value = true
  try {
    const { start, end } = getDateRange()
    
    if (historyTab.value === 'chat') {
      chatRecords.value = await window.electronAPI.history.getChatRecords(start, end) || []
    } else {
      agentRecords.value = await window.electronAPI.history.getAgentRecords(start, end) || []
    }
  } catch (e) {
    console.error('Failed to load history:', e)
    showMessage('error', t('dataSettings.loadHistoryFailed'))
  } finally {
    historyLoading.value = false
  }
}

// 切换标签时加载
const switchHistoryTab = (tab: 'chat' | 'agent') => {
  historyTab.value = tab
  loadHistory()
}

// 切换日期范围时加载
const switchDateRange = (range: 'today' | 'week' | 'month' | 'all') => {
  selectedDateRange.value = range
  loadHistory()
}

// 打开历史查看器
const openHistoryViewer = async () => {
  showHistoryViewer.value = true
  await loadHistory()
}

// 关闭历史查看器
const closeHistoryViewer = () => {
  showHistoryViewer.value = false
  chatRecords.value = []
  agentRecords.value = []
  searchKeyword.value = ''
  expandedAgentIds.value.clear()
}

// 格式化时间
const formatTime = (timestamp: number) => {
  const { locale } = useI18n()
  const date = new Date(timestamp)
  return date.toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化时长
const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

// 过滤聊天记录
const filteredChatRecords = computed(() => {
  if (!searchKeyword.value.trim()) return chatRecords.value
  const keyword = searchKeyword.value.toLowerCase()
  return chatRecords.value.filter(r => 
    r.content.toLowerCase().includes(keyword) ||
    r.sshHost?.toLowerCase().includes(keyword)
  )
})

// 过滤 Agent 记录
const filteredAgentRecords = computed(() => {
  if (!searchKeyword.value.trim()) return agentRecords.value
  const keyword = searchKeyword.value.toLowerCase()
  return agentRecords.value.filter(r => 
    r.userTask.toLowerCase().includes(keyword) ||
    r.finalResult?.toLowerCase().includes(keyword) ||
    r.sshHost?.toLowerCase().includes(keyword)
  )
})

// 按对话分组聊天记录
const groupedChatRecords = computed(() => {
  const { locale } = useI18n()
  const groups: Array<{
    date: string
    records: ChatRecord[]
  }> = []
  
  let currentDate = ''
  let currentGroup: ChatRecord[] = []
  
  for (const record of filteredChatRecords.value) {
    const date = new Date(record.timestamp).toLocaleDateString(locale.value)
    if (date !== currentDate) {
      if (currentGroup.length > 0) {
        groups.push({ date: currentDate, records: currentGroup })
      }
      currentDate = date
      currentGroup = [record]
    } else {
      currentGroup.push(record)
    }
  }
  
  if (currentGroup.length > 0) {
    groups.push({ date: currentDate, records: currentGroup })
  }
  
  return groups.reverse() // 最新的在前
})

// 切换展开 Agent 详情
const toggleAgentExpand = (id: string) => {
  if (expandedAgentIds.value.has(id)) {
    expandedAgentIds.value.delete(id)
  } else {
    expandedAgentIds.value.add(id)
  }
}

// 渲染 markdown
const renderMarkdown = (content: string) => {
  try {
    return marked(content, { breaks: true })
  } catch {
    return content
  }
}

// 获取步骤类型图标
const getStepIcon = (type: string) => {
  switch (type) {
    case 'thinking': return '🤔'
    case 'tool_call': return '🔧'
    case 'tool_result': return '📋'
    case 'message': return '💬'
    case 'error': return '❌'
    default: return '📌'
  }
}

// 获取状态标签样式
const getStatusClass = (status: string) => {
  switch (status) {
    case 'completed': return 'status-completed'
    case 'failed': return 'status-failed'
    case 'aborted': return 'status-aborted'
    default: return ''
  }
}

// 获取状态文本
const getStatusText = (status: string) => {
  switch (status) {
    case 'completed': return t('dataSettings.statusCompleted')
    case 'failed': return t('dataSettings.statusFailed')
    case 'aborted': return t('dataSettings.statusAborted')
    default: return status
  }
}

// 加载存储统计
const loadStorageStats = async () => {
  try {
    storageStats.value = await window.electronAPI.history.getStorageStats()
    dataPath.value = await window.electronAPI.history.getDataPath()
  } catch (e) {
    console.error('Failed to load storage stats:', e)
  }
}

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 打开数据目录
const openDataFolder = async () => {
  try {
    await window.electronAPI.history.openDataFolder()
  } catch (e) {
    showMessage('error', t('dataSettings.openFolderFailed'))
  }
}

// 导出选项
const exportOptions = ref({
  includeSshPasswords: false,
  includeApiKeys: false
})

// 导出到文件夹
const exportToFolder = async () => {
  isExporting.value = true
  try {
    // 将响应式对象转换为普通对象，避免 IPC 序列化错误
    const options = {
      includeSshPasswords: exportOptions.value.includeSshPasswords,
      includeApiKeys: exportOptions.value.includeApiKeys
    }
    const result = await window.electronAPI.history.exportToFolder(options)
    
    if (result.canceled) {
      // 用户取消
    } else if (result.success) {
      showMessage('success', t('dataSettings.exportedFiles', { count: result.files?.length || 0 }))
    } else {
      showMessage('error', result.error || t('dataSettings.exportFailed'))
    }
  } catch (e) {
    showMessage('error', `${t('dataSettings.exportFailed')}: ${e}`)
  } finally {
    isExporting.value = false
  }
}

// 从文件夹导入
const importFromFolder = async () => {
  isImporting.value = true
  try {
    const result = await window.electronAPI.history.importFromFolder()
    
    if (result.canceled) {
      // 用户取消
    } else if (result.success) {
      showMessage('success', t('dataSettings.importedItems', { items: result.imported?.join(', ') || t('dataSettings.importNone') }))
      await loadStorageStats()
    } else {
      showMessage('error', result.error || t('dataSettings.importFailed'))
    }
  } catch (e) {
    showMessage('error', `${t('dataSettings.importFailed')}: ${e}`)
  } finally {
    isImporting.value = false
  }
}

// 清理旧记录
const cleanupOldRecords = async (days: number) => {
  const confirmMsg = days === 0 
    ? t('dataSettings.confirmClearAll')
    : t('dataSettings.confirmCleanup', { days })
  
  if (!confirm(confirmMsg)) {
    return
  }
  
  isLoading.value = true
  try {
    const result = await window.electronAPI.history.cleanup(days)
    showMessage('success', t('dataSettings.cleanupResult', { chatDeleted: result.chatDeleted, agentDeleted: result.agentDeleted }))
    await loadStorageStats()
  } catch (e) {
    showMessage('error', `${t('dataSettings.cleanupFailed')}: ${e}`)
  } finally {
    isLoading.value = false
  }
}

// 显示消息
const showMessage = (type: 'success' | 'error', text: string) => {
  message.value = { type, text }
  setTimeout(() => {
    message.value = null
  }, 3000)
}

// 搜索框引用
const historySearchRef = ref<HTMLInputElement | null>(null)

// ESC 关闭历史记录弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showHistoryViewer.value) {
    e.stopImmediatePropagation() // 阻止其他监听器被调用，防止同时关闭父级弹窗
    closeHistoryViewer()
  }
}

// 监听弹窗打开，自动聚焦到搜索框
watch(showHistoryViewer, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    historySearchRef.value?.focus()
  }
})

onMounted(() => {
  loadStorageStats()
  // 使用捕获阶段，确保在父组件之前处理事件
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})
</script>

<template>
  <div class="data-settings">
    <h3>{{ t('dataSettings.title') }}</h3>
    
    <!-- 消息提示 -->
    <div v-if="message" class="message" :class="message.type">
      {{ message.text }}
    </div>
    
    <!-- 存储统计 -->
    <div class="section">
      <h4>{{ t('dataSettings.storageStats') }}</h4>
      <div v-if="storageStats" class="stats-grid">
        <div class="stat-item">
          <span class="stat-label">{{ t('dataSettings.chatRecords') }}</span>
          <span class="stat-value">{{ storageStats.chatFiles }} {{ t('dataSettings.days') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">{{ t('dataSettings.agentRecords') }}</span>
          <span class="stat-value">{{ storageStats.agentFiles }} {{ t('dataSettings.days') }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">{{ t('dataSettings.totalSize') }}</span>
          <span class="stat-value">{{ formatSize(storageStats.totalSize) }}</span>
        </div>
        <div class="stat-item">
          <span class="stat-label">{{ t('dataSettings.recordRange') }}</span>
          <span class="stat-value">
            {{ storageStats.oldestRecord || t('dataSettings.noData') }} ~ {{ storageStats.newestRecord || t('dataSettings.noData') }}
          </span>
        </div>
      </div>
      <div v-else class="loading">{{ t('dataSettings.loading') }}</div>
      
      <!-- 查看历史记录按钮 -->
      <button class="btn btn-primary view-history-btn" @click="openHistoryViewer">
        📜 {{ t('dataSettings.viewHistory') }}
      </button>
    </div>
    
    <!-- 数据目录 -->
    <div class="section">
      <h4>{{ t('dataSettings.dataDirectory') }}</h4>
      <div class="data-path">
        <code>{{ dataPath }}</code>
        <button class="btn btn-sm" @click="openDataFolder">
          📂 {{ t('dataSettings.openFolder') }}
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.migrationHint') }}</p>
    </div>
    
    <!-- 导出/导入 -->
    <div class="section">
      <h4>{{ t('dataSettings.backupRestore') }}</h4>
      
      <!-- 导出选项 -->
      <div class="export-options">
        <label class="checkbox-label">
          <input type="checkbox" v-model="exportOptions.includeSshPasswords">
          <span>{{ t('dataSettings.includeSshPasswords') }}</span>
        </label>
        <label class="checkbox-label">
          <input type="checkbox" v-model="exportOptions.includeApiKeys">
          <span>{{ t('dataSettings.includeApiKeys') }}</span>
        </label>
      </div>
      
      <div class="actions">
        <button class="btn btn-primary" @click="exportToFolder" :disabled="isExporting">
          {{ isExporting ? t('dataSettings.exporting') : `📂 ${t('dataSettings.exportToFolder')}` }}
        </button>
        <button class="btn" @click="importFromFolder" :disabled="isImporting">
          {{ isImporting ? t('dataSettings.importing') : `📂 ${t('dataSettings.importFromFolder')}` }}
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.exportHint') }}</p>
    </div>
    
    <!-- 清理 -->
    <div class="section">
      <h4>{{ t('dataSettings.cleanupHistory') }}</h4>
      <div class="actions">
        <button class="btn btn-outline" @click="cleanupOldRecords(30)" :disabled="isLoading">
          {{ t('dataSettings.cleanup30Days') }}
        </button>
        <button class="btn btn-outline" @click="cleanupOldRecords(90)" :disabled="isLoading">
          {{ t('dataSettings.cleanup90Days') }}
        </button>
        <button class="btn btn-outline btn-danger" @click="cleanupOldRecords(0)" :disabled="isLoading">
          {{ t('dataSettings.clearAll') }}
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.cleanupHint') }}</p>
    </div>
    
    <!-- 历史记录查看器弹窗 -->
    <Teleport to="body">
      <div v-if="showHistoryViewer" class="history-modal-overlay" @click.self="closeHistoryViewer">
        <div class="history-modal">
          <div class="history-modal-header">
            <h3>📜 {{ t('dataSettings.historyViewer') }}</h3>
            <button class="close-btn" @click="closeHistoryViewer">✕</button>
          </div>
          
          <!-- 工具栏 -->
          <div class="history-toolbar">
            <!-- 标签切换 -->
            <div class="tab-switcher">
              <button 
                :class="['tab-btn', { active: historyTab === 'agent' }]"
                @click="switchHistoryTab('agent')"
              >
                🤖 {{ t('dataSettings.agentTasks') }}
              </button>
              <button 
                :class="['tab-btn', { active: historyTab === 'chat' }]"
                @click="switchHistoryTab('chat')"
              >
                💬 {{ t('dataSettings.chatHistory') }}
              </button>
            </div>
            
            <!-- 日期范围 -->
            <div class="date-range-switcher">
              <button 
                v-for="range in [
                  { value: 'today', label: t('dataSettings.today') },
                  { value: 'week', label: t('dataSettings.last7Days') },
                  { value: 'month', label: t('dataSettings.last30Days') },
                  { value: 'all', label: t('dataSettings.all') }
                ]" 
                :key="range.value"
                :class="['range-btn', { active: selectedDateRange === range.value }]"
                @click="switchDateRange(range.value as 'today' | 'week' | 'month' | 'all')"
              >
                {{ range.label }}
              </button>
            </div>
            
            <!-- 搜索框 -->
            <div class="search-box">
              <input 
                ref="historySearchRef"
                v-model="searchKeyword"
                type="text" 
                :placeholder="t('dataSettings.searchPlaceholder')"
                class="search-input"
              />
              <span v-if="searchKeyword" class="clear-search" @click="searchKeyword = ''">✕</span>
            </div>
          </div>
          
          <!-- 内容区域 -->
          <div class="history-content">
            <!-- 加载中 -->
            <div v-if="historyLoading" class="loading-state">
              <span class="spinner"></span>
              {{ t('dataSettings.loading') }}
            </div>
            
            <!-- Agent 记录 -->
            <div v-else-if="historyTab === 'agent'" class="agent-history">
              <div v-if="filteredAgentRecords.length === 0" class="empty-state">
                {{ t('dataSettings.noAgentRecords') }}
              </div>
              <div v-else class="agent-list">
                <div 
                  v-for="record in filteredAgentRecords" 
                  :key="record.id"
                  class="agent-item"
                >
                  <div class="agent-header" @click="toggleAgentExpand(record.id)">
                    <div class="agent-info">
                      <span :class="['status-badge', getStatusClass(record.status)]">
                        {{ getStatusText(record.status) }}
                      </span>
                      <span class="agent-task">{{ record.userTask }}</span>
                    </div>
                    <div class="agent-meta">
                      <span v-if="record.sshHost" class="agent-host">🖥️ {{ record.sshHost }}</span>
                      <span v-else class="agent-host">💻 {{ t('dataSettings.local') }}</span>
                      <span class="agent-time">{{ formatTime(record.timestamp) }}</span>
                      <span class="agent-duration">⏱️ {{ formatDuration(record.duration) }}</span>
                      <span class="expand-icon">{{ expandedAgentIds.has(record.id) ? '▼' : '▶' }}</span>
                    </div>
                  </div>
                  
                  <!-- 展开的详情 -->
                  <div v-if="expandedAgentIds.has(record.id)" class="agent-details">
                    <!-- 步骤列表 -->
                    <div class="steps-list">
                      <div class="steps-label">📝 {{ t('dataSettings.executionSteps') }} ({{ record.steps.length }})</div>
                      <div 
                        v-for="step in record.steps" 
                        :key="step.id"
                        :class="['step-item', step.type]"
                      >
                        <div class="step-header">
                          <span class="step-icon">{{ getStepIcon(step.type) }}</span>
                          <span class="step-type">{{ step.type }}</span>
                          <span v-if="step.toolName" class="step-tool">{{ step.toolName }}</span>
                          <span class="step-time">{{ formatTime(step.timestamp) }}</span>
                        </div>
                        <div v-if="step.content" class="step-content">{{ step.content }}</div>
                        <div v-if="step.toolArgs" class="step-args">
                          <code>{{ JSON.stringify(step.toolArgs, null, 2) }}</code>
                        </div>
                        <div v-if="step.toolResult" class="step-result">
                          <pre>{{ step.toolResult }}</pre>
                        </div>
                      </div>
                    </div>
                    
                    <!-- 最终结果（在步骤下方） -->
                    <div v-if="record.finalResult" class="final-result">
                      <div class="result-label">📋 {{ t('dataSettings.finalResult') }}</div>
                      <div class="result-content" v-html="renderMarkdown(record.finalResult)"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <!-- 聊天记录 -->
            <div v-else class="chat-history">
              <div v-if="groupedChatRecords.length === 0" class="empty-state">
                {{ t('dataSettings.noChatRecords') }}
              </div>
              <div v-else>
                <div v-for="group in groupedChatRecords" :key="group.date" class="date-group">
                  <div class="date-header">{{ group.date }}</div>
                  <div class="chat-list">
                    <div 
                      v-for="record in group.records" 
                      :key="record.id"
                      :class="['chat-item', record.role]"
                    >
                      <div class="chat-meta">
                        <span class="chat-role">{{ record.role === 'user' ? `👤 ${t('dataSettings.user')}` : `🤖 ${t('dataSettings.ai')}` }}</span>
                        <span class="chat-time">{{ formatTime(record.timestamp) }}</span>
                        <span v-if="record.sshHost" class="chat-host">🖥️ {{ record.sshHost }}</span>
                        <span v-else class="chat-host">💻 {{ t('dataSettings.local') }}</span>
                      </div>
                      <div class="chat-content" v-html="renderMarkdown(record.content)"></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          
          <!-- 统计信息 -->
          <div class="history-footer">
            <span v-if="historyTab === 'agent'">
              {{ t('dataSettings.totalTasks', { count: filteredAgentRecords.length }) }}
            </span>
            <span v-else>
              {{ t('dataSettings.totalRecords', { count: filteredChatRecords.length }) }}
            </span>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.data-settings {
  max-width: 500px;
}

.data-settings h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 20px;
}

.section {
  margin-bottom: 24px;
}

.section h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.message {
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 16px;
  font-size: 13px;
}

.message.success {
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
  border: 1px solid rgba(16, 185, 129, 0.2);
}

.message.error {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-muted);
}

.stat-value {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.data-path {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-bottom: 8px;
}

.data-path code {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

.loading {
  color: var(--text-muted);
  font-size: 13px;
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

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-outline {
  background: transparent;
}

.btn-danger {
  color: #ef4444;
  border-color: #ef4444;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
}

.export-options {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.view-history-btn {
  margin-top: 16px;
  width: 100%;
}

/* ========== 历史记录弹窗样式 ========== */
.history-modal-overlay {
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
}

.history-modal {
  width: 90%;
  max-width: 900px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
}

.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.history-modal-header h3 {
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

/* 工具栏 */
.history-toolbar {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
  align-items: center;
}

.tab-switcher {
  display: flex;
  gap: 4px;
  background: var(--bg-tertiary);
  padding: 3px;
  border-radius: 8px;
}

.tab-btn {
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  background: var(--accent-primary);
  color: white;
}

.date-range-switcher {
  display: flex;
  gap: 4px;
}

.range-btn {
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.range-btn:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.range-btn.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.search-box {
  flex: 1;
  min-width: 150px;
  max-width: 300px;
  position: relative;
}

.search-input {
  width: 100%;
  padding: 6px 28px 6px 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.clear-search {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
}

.clear-search:hover {
  color: var(--text-primary);
}

/* 内容区域 */
.history-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 300px;
  user-select: text;
  -webkit-user-select: text;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 200px;
  color: var(--text-muted);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-muted);
  font-size: 14px;
}

/* 聊天记录样式 */
.date-group {
  margin-bottom: 20px;
}

.date-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.chat-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.chat-item {
  padding: 12px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.chat-item.user {
  border-left: 3px solid var(--accent-primary);
}

.chat-item.assistant {
  border-left: 3px solid #10b981;
}

.chat-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.chat-role {
  font-weight: 500;
}

.chat-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.chat-content :deep(p) {
  margin: 0 0 8px 0;
}

.chat-content :deep(p:last-child) {
  margin-bottom: 0;
}

.chat-content :deep(pre) {
  background: var(--bg-secondary);
  padding: 10px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
}

.chat-content :deep(code) {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
}

/* Agent 记录样式 */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.agent-item {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
}

.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  cursor: pointer;
  transition: background 0.2s;
}

.agent-header:hover {
  background: var(--bg-hover);
}

.agent-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.status-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-completed {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.status-failed {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.status-aborted {
  background: rgba(251, 191, 36, 0.15);
  color: #f59e0b;
}

.agent-task {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
  -webkit-user-select: text;
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.expand-icon {
  font-size: 10px;
  color: var(--text-muted);
}

/* Agent 详情 */
.agent-details {
  padding: 12px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.final-result {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  border-left: 3px solid #10b981;
}

.result-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.result-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.result-content :deep(p) {
  margin: 0 0 8px 0;
}

.result-content :deep(p:last-child) {
  margin-bottom: 0;
}

.steps-list {
  max-height: 400px;
  overflow-y: auto;
}

.steps-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.step-item {
  padding: 10px;
  margin-bottom: 8px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
}

.step-item:last-child {
  margin-bottom: 0;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.step-icon {
  font-size: 14px;
}

.step-type {
  font-weight: 500;
  text-transform: capitalize;
}

.step-tool {
  padding: 1px 6px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-family: monospace;
}

.step-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

.step-content {
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.step-args {
  margin-top: 6px;
}

.step-args code {
  display: block;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.step-result {
  margin-top: 6px;
}

.step-result pre {
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 200px;
  margin: 0;
  color: var(--text-secondary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

/* 底部统计 */
.history-footer {
  padding: 10px 20px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
</style>

