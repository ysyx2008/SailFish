<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import { MessageSquare, Bot, HardDrive, CalendarRange, FolderOpen, History, Download, Upload, Trash2, Clock, AlertTriangle, Search, X, ChevronDown, ChevronRight, ExternalLink, Monitor, Server } from 'lucide-vue-next'

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
    <Transition name="msg">
      <div v-if="message" class="message" :class="message.type">
        {{ message.text }}
      </div>
    </Transition>
    
    <!-- 存储统计 -->
    <div class="section">
      <div class="section-header">
        <HardDrive :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.storageStats') }}</h4>
      </div>
      <div v-if="storageStats" class="stats-grid">
        <div class="stat-card stat-chat">
          <div class="stat-icon-wrap chat">
            <MessageSquare :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ storageStats.chatFiles }}</span>
            <span class="stat-label">{{ t('dataSettings.chatRecords') }} ({{ t('dataSettings.days') }})</span>
          </div>
        </div>
        <div class="stat-card stat-agent">
          <div class="stat-icon-wrap agent">
            <Bot :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ storageStats.agentFiles }}</span>
            <span class="stat-label">{{ t('dataSettings.agentRecords') }} ({{ t('dataSettings.days') }})</span>
          </div>
        </div>
        <div class="stat-card stat-size">
          <div class="stat-icon-wrap size">
            <HardDrive :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ formatSize(storageStats.totalSize) }}</span>
            <span class="stat-label">{{ t('dataSettings.totalSize') }}</span>
          </div>
        </div>
        <div class="stat-card stat-range">
          <div class="stat-icon-wrap range">
            <CalendarRange :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value range-value">
              {{ storageStats.oldestRecord || t('dataSettings.noData') }} ~ {{ storageStats.newestRecord || t('dataSettings.noData') }}
            </span>
            <span class="stat-label">{{ t('dataSettings.recordRange') }}</span>
          </div>
        </div>
      </div>
      <div v-else class="loading">{{ t('dataSettings.loading') }}</div>
      
      <button class="btn btn-ghost view-history-btn" @click="openHistoryViewer">
        <History :size="15" />
        {{ t('dataSettings.viewHistory') }}
      </button>
    </div>
    
    <!-- 数据目录 -->
    <div class="section">
      <div class="section-header">
        <FolderOpen :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.dataDirectory') }}</h4>
      </div>
      <div class="data-path-card">
        <code class="path-text">{{ dataPath }}</code>
        <button class="btn btn-sm btn-icon" @click="openDataFolder" :title="t('dataSettings.openFolder')" :aria-label="t('dataSettings.openFolder')">
          <ExternalLink :size="14" />
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.migrationHint') }}</p>
    </div>
    
    <!-- 导出/导入 -->
    <div class="section">
      <div class="section-header">
        <Download :size="15" class="section-icon" />
        <h4>{{ t('dataSettings.backupRestore') }}</h4>
      </div>
      
      <div class="backup-card">
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
            <Download :size="14" />
            {{ isExporting ? t('dataSettings.exporting') : t('dataSettings.exportToFolder') }}
          </button>
          <button class="btn" @click="importFromFolder" :disabled="isImporting">
            <Upload :size="14" />
            {{ isImporting ? t('dataSettings.importing') : t('dataSettings.importFromFolder') }}
          </button>
        </div>
      </div>
      <p class="hint">{{ t('dataSettings.exportHint') }}</p>
    </div>
    
    <!-- 清理 -->
    <div class="section section-danger">
      <div class="section-header">
        <Trash2 :size="15" class="section-icon danger" />
        <h4>{{ t('dataSettings.cleanupHistory') }}</h4>
      </div>
      <div class="cleanup-actions">
        <button class="btn btn-outline" @click="cleanupOldRecords(30)" :disabled="isLoading">
          <Clock :size="14" />
          {{ t('dataSettings.cleanup30Days') }}
        </button>
        <button class="btn btn-outline" @click="cleanupOldRecords(90)" :disabled="isLoading">
          <Clock :size="14" />
          {{ t('dataSettings.cleanup90Days') }}
        </button>
        <button class="btn btn-danger-fill" @click="cleanupOldRecords(0)" :disabled="isLoading">
          <AlertTriangle :size="14" />
          {{ t('dataSettings.clearAll') }}
        </button>
      </div>
      <p class="hint">{{ t('dataSettings.cleanupHint') }}</p>
    </div>
    
    <!-- 历史记录查看器弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showHistoryViewer" class="history-modal-overlay" @click.self="closeHistoryViewer">
          <div class="history-modal">
            <div class="history-modal-header">
              <div class="modal-title">
                <History :size="18" />
                <h3>{{ t('dataSettings.historyViewer') }}</h3>
              </div>
              <button class="close-btn" @click="closeHistoryViewer" aria-label="Close">
                <X :size="16" />
              </button>
            </div>
            
            <!-- 工具栏 -->
            <div class="history-toolbar">
              <div class="toolbar-left">
                <div class="tab-switcher">
                  <button 
                    :class="['tab-btn', { active: historyTab === 'agent' }]"
                    @click="switchHistoryTab('agent')"
                  >
                    <Bot :size="14" />
                    {{ t('dataSettings.agentTasks') }}
                  </button>
                  <button 
                    :class="['tab-btn', { active: historyTab === 'chat' }]"
                    @click="switchHistoryTab('chat')"
                  >
                    <MessageSquare :size="14" />
                    {{ t('dataSettings.chatHistory') }}
                  </button>
                </div>
                
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
              </div>
              
              <div class="search-box">
                <Search :size="14" class="search-icon" />
                <input 
                  ref="historySearchRef"
                  v-model="searchKeyword"
                  type="text" 
                  :placeholder="t('dataSettings.searchPlaceholder')"
                  class="search-input"
                />
                <button v-if="searchKeyword" class="clear-search" @click="searchKeyword = ''">
                  <X :size="12" />
                </button>
              </div>
            </div>
            
            <!-- 内容区域 -->
            <div class="history-content">
              <div v-if="historyLoading" class="loading-state">
                <span class="spinner"></span>
                {{ t('dataSettings.loading') }}
              </div>
              
              <!-- Agent 记录 -->
              <div v-else-if="historyTab === 'agent'" class="agent-history">
                <div v-if="filteredAgentRecords.length === 0" class="empty-state">
                  <Bot :size="32" class="empty-icon" />
                  <span>{{ t('dataSettings.noAgentRecords') }}</span>
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
                        <span v-if="record.sshHost" class="agent-host">
                          <Server :size="12" /> {{ record.sshHost }}
                        </span>
                        <span v-else class="agent-host">
                          <Monitor :size="12" /> {{ t('dataSettings.local') }}
                        </span>
                        <span class="agent-time">{{ formatTime(record.timestamp) }}</span>
                        <span class="agent-duration">
                          <Clock :size="12" /> {{ formatDuration(record.duration) }}
                        </span>
                        <ChevronDown v-if="expandedAgentIds.has(record.id)" :size="14" class="expand-icon" />
                        <ChevronRight v-else :size="14" class="expand-icon" />
                      </div>
                    </div>
                    
                    <div v-if="expandedAgentIds.has(record.id)" class="agent-details">
                      <div class="steps-list">
                        <div class="steps-label">{{ t('dataSettings.executionSteps') }} ({{ record.steps.length }})</div>
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
                      
                      <div v-if="record.finalResult" class="final-result">
                        <div class="result-label">{{ t('dataSettings.finalResult') }}</div>
                        <div class="result-content" v-html="renderMarkdown(record.finalResult)"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              
              <!-- 聊天记录 -->
              <div v-else class="chat-history">
                <div v-if="groupedChatRecords.length === 0" class="empty-state">
                  <MessageSquare :size="32" class="empty-icon" />
                  <span>{{ t('dataSettings.noChatRecords') }}</span>
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
                          <span class="chat-role">{{ record.role === 'user' ? t('dataSettings.user') : t('dataSettings.ai') }}</span>
                          <span class="chat-time">{{ formatTime(record.timestamp) }}</span>
                          <span v-if="record.sshHost" class="chat-host">
                            <Server :size="11" /> {{ record.sshHost }}
                          </span>
                          <span v-else class="chat-host">
                            <Monitor :size="11" /> {{ t('dataSettings.local') }}
                          </span>
                        </div>
                        <div class="chat-content" v-html="renderMarkdown(record.content)"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
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
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.data-settings {
  max-width: 760px;
  width: 100%;
}

.data-settings h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 24px;
}

/* Sections */
.section {
  margin-bottom: 24px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}

.section-header h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0;
}

.section-icon {
  color: var(--text-muted);
}

.section-icon.danger {
  color: #ef4444;
}

/* Message toast */
.message {
  padding: 10px 14px;
  border-radius: 8px;
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

.msg-enter-active,
.msg-leave-active {
  transition: all 0.3s ease;
}
.msg-enter-from,
.msg-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Stats grid */
.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--bg-tertiary);
  border-radius: 10px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.stat-card:hover {
  border-color: var(--border-color);
}

.stat-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon-wrap.chat {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.stat-icon-wrap.agent {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.stat-icon-wrap.size {
  background: rgba(168, 85, 247, 0.12);
  color: #a855f7;
}

.stat-icon-wrap.range {
  background: rgba(251, 146, 60, 0.12);
  color: #fb923c;
}

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-value.range-value {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  white-space: normal;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.view-history-btn {
  margin-top: 14px;
  width: 100%;
  justify-content: center;
  min-height: 34px;
}

/* Data path */
.data-path-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.path-text {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.4;
}

/* Backup card */
.backup-card {
  padding: 14px;
  background: var(--bg-tertiary);
  border-radius: 10px;
  border: 1px solid var(--border-color);
}

.export-options {
  display: flex;
  gap: 20px;
  margin-bottom: 14px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 15px;
  height: 15px;
  cursor: pointer;
  accent-color: var(--accent-primary);
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.actions .btn {
  flex: 1;
  min-width: 160px;
  justify-content: center;
}

/* Cleanup */
.section-danger .cleanup-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.section-danger .cleanup-actions .btn {
  flex: 1;
  min-width: 150px;
  justify-content: center;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 10px;
  line-height: 1.5;
}

.loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 20px 0;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 8px;
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

.btn-icon {
  padding: 6px;
  border-radius: 6px;
}

.btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-ghost {
  background: transparent;
  border: 1px dashed var(--border-color);
  color: var(--text-secondary);
}

.btn-ghost:hover:not(:disabled) {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb, 59, 130, 246), 0.06);
}

.btn-outline {
  background: transparent;
}

.btn-danger-fill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 8px;
  border: 1px solid rgba(239, 68, 68, 0.3);
  background: rgba(239, 68, 68, 0.08);
  color: #ef4444;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-danger-fill:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.15);
  border-color: rgba(239, 68, 68, 0.5);
}

.btn-danger-fill:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .actions .btn,
  .section-danger .cleanup-actions .btn {
    min-width: 0;
  }
}

/* ========== History modal ========== */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.25s ease;
}
.modal-enter-active .history-modal,
.modal-leave-active .history-modal {
  transition: transform 0.25s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .history-modal {
  transform: scale(0.95) translateY(10px);
}
.modal-leave-to .history-modal {
  transform: scale(0.95) translateY(10px);
}

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
  backdrop-filter: blur(4px);
}

.history-modal {
  width: 90%;
  max-width: 900px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
}

.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-primary);
}

.modal-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: var(--bg-tertiary);
  border-radius: 8px;
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

/* Toolbar */
.history-toolbar {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
}

.toolbar-left {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.tab-switcher {
  display: flex;
  gap: 2px;
  background: var(--bg-tertiary);
  padding: 3px;
  border-radius: 9px;
}

.tab-btn {
  padding: 6px 14px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 7px;
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
}

.tab-btn:hover {
  color: var(--text-primary);
}

.tab-btn.active {
  background: var(--accent-primary);
  color: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
}

.date-range-switcher {
  display: flex;
  gap: 4px;
}

.range-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
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
  min-width: 180px;
  max-width: 280px;
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 7px 30px 7px 32px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 8px;
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
  cursor: pointer;
  color: var(--text-muted);
  border: none;
  background: none;
  padding: 2px;
  display: flex;
  align-items: center;
}

.clear-search:hover {
  color: var(--text-primary);
}

/* Content */
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
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 200px;
  color: var(--text-muted);
  font-size: 14px;
}

.empty-icon {
  opacity: 0.3;
}

/* Chat records */
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
  gap: 10px;
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
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.chat-role {
  font-weight: 600;
}

.chat-host {
  display: inline-flex;
  align-items: center;
  gap: 3px;
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

/* Agent records */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.agent-item {
  background: var(--bg-tertiary);
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.agent-item:hover {
  border-color: var(--border-color);
}

.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
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
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-completed {
  background: rgba(16, 185, 129, 0.12);
  color: #10b981;
}

.status-failed {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}

.status-aborted {
  background: rgba(251, 191, 36, 0.12);
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

.agent-host,
.agent-duration {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.expand-icon {
  color: var(--text-muted);
  transition: transform 0.2s;
}

/* Agent details */
.agent-details {
  padding: 14px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.final-result {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border-left: 3px solid #10b981;
}

.result-label {
  font-size: 12px;
  font-weight: 600;
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
  font-weight: 600;
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

/* Footer */
.history-footer {
  padding: 10px 20px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
</style>

