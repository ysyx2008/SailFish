<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, Play, Trash2, Edit3, Clock, Server, Terminal, RefreshCw, History } from 'lucide-vue-next'
import SchedulerTaskEditor from './SchedulerTaskEditor.vue'

const { t } = useI18n()

// 类型定义
type TaskRunStatus = 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
type ScheduleType = 'cron' | 'interval' | 'once'
type TargetType = 'local' | 'ssh' | 'assistant'

interface ScheduleConfig {
  type: ScheduleType
  expression: string
}

interface TargetConfig {
  type: TargetType
  sshSessionId?: string
  sshSessionName?: string
  workingDirectory?: string
}

interface TaskOptions {
  timeout: number
  requireConfirm: boolean
  notifyOnComplete: boolean
  notifyOnError: boolean
}

interface TaskRunRecord {
  at: number
  status: TaskRunStatus
  duration: number
  output?: string
  error?: string
}

interface ScheduledTask {
  id: string
  name: string
  description?: string
  enabled: boolean
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options: TaskOptions
  createdAt: number
  updatedAt: number
  lastRun?: TaskRunRecord
  nextRun?: number
}

interface TaskHistoryRecord extends TaskRunRecord {
  id: string
  taskId: string
  taskName: string
}

interface CreateTaskParams {
  name: string
  description?: string
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options?: Partial<TaskOptions>
  enabled?: boolean
}

// TaskExecutionResult 类型已在 vite-env.d.ts 中定义

const emit = defineEmits<{
  close: []
}>()

// 状态
const tasks = ref<ScheduledTask[]>([])
const history = ref<TaskHistoryRecord[]>([])
const loading = ref(true)
const selectedTask = ref<ScheduledTask | null>(null)
const showEditor = ref(false)
const editingTask = ref<ScheduledTask | null>(null)
const runningTasks = ref<Set<string>>(new Set())
const activeTab = ref<'tasks' | 'history'>('tasks')

// 事件清理函数
let cleanupTaskStarted: (() => void) | null = null
let cleanupTaskCompleted: (() => void) | null = null

// 格式化日期
const formatDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化完整日期
const formatFullDate = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// 格式化时长
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

// 格式化调度表达式
const formatSchedule = (schedule: ScheduleConfig): string => {
  if (schedule.type === 'cron') {
    return `Cron: ${schedule.expression}`
  } else if (schedule.type === 'interval') {
    const match = schedule.expression.match(/^(\d+)(s|m|h|d)$/)
    if (match) {
      const value = match[1]
      const unit = match[2]
      const unitMap: Record<string, string> = { s: '秒', m: '分钟', h: '小时', d: '天' }
      return `每 ${value} ${unitMap[unit]}`
    }
    return schedule.expression
  } else {
    return `一次性: ${formatDate(new Date(schedule.expression).getTime())}`
  }
}

// 获取目标描述
const getTargetDescription = (target: TargetConfig): string => {
  if (target.type === 'local') {
    return target.workingDirectory ? `本地: ${target.workingDirectory}` : '本地终端'
  } else if (target.type === 'ssh') {
    return `SSH: ${target.sshSessionName || target.sshSessionId}`
  } else {
    return '无需终端'
  }
}

// 获取目标图标
const getTargetIcon = (target: TargetConfig) => {
  if (target.type === 'local') return Terminal
  if (target.type === 'ssh') return Server
  return Clock
}

// 状态文本
const getStatusText = (status: string): string => {
  const map: Record<string, string> = {
    success: '成功',
    failed: '失败',
    timeout: '超时',
    cancelled: '取消',
    running: '运行中'
  }
  return map[status] || status
}

// 状态类名
const getStatusClass = (status: string): string => {
  const map: Record<string, string> = {
    success: 'status-success',
    failed: 'status-error',
    timeout: 'status-warning',
    cancelled: 'status-muted',
    running: 'status-running'
  }
  return map[status] || ''
}

// 加载数据
const loadData = async () => {
  try {
    loading.value = true
    tasks.value = await window.electronAPI.scheduler.getTasks()
    history.value = await window.electronAPI.scheduler.getHistory(undefined, 50)
    
    // 获取运行中的任务
    const running = await window.electronAPI.scheduler.getRunningTasks()
    runningTasks.value = new Set(running)
  } catch (error) {
    console.error('加载定时任务数据失败:', error)
  } finally {
    loading.value = false
  }
}

// 选中任务
const selectTask = (task: ScheduledTask) => {
  selectedTask.value = task
}

// 创建任务
const openCreateTask = () => {
  editingTask.value = null
  showEditor.value = true
}

// 编辑任务
const openEditTask = (task: ScheduledTask) => {
  editingTask.value = task
  showEditor.value = true
}

// 保存任务
const handleSaveTask = async (params: CreateTaskParams) => {
  try {
    if (editingTask.value) {
      // 更新
      await window.electronAPI.scheduler.updateTask(editingTask.value.id, params)
    } else {
      // 创建
      await window.electronAPI.scheduler.createTask(params)
    }
    showEditor.value = false
    editingTask.value = null
    await loadData()
  } catch (error) {
    console.error('保存任务失败:', error)
  }
}

// 删除任务
const deleteTask = async (task: ScheduledTask) => {
  if (!confirm(`确定要删除任务 "${task.name}" 吗？`)) return
  
  try {
    await window.electronAPI.scheduler.deleteTask(task.id)
    if (selectedTask.value?.id === task.id) {
      selectedTask.value = null
    }
    await loadData()
  } catch (error) {
    console.error('删除任务失败:', error)
  }
}

// 切换任务启用状态
const toggleTask = async (task: ScheduledTask) => {
  try {
    await window.electronAPI.scheduler.toggleTask(task.id)
    await loadData()
  } catch (error) {
    console.error('切换任务状态失败:', error)
  }
}

// 立即执行任务
const runTask = async (task: ScheduledTask) => {
  if (runningTasks.value.has(task.id)) return
  
  try {
    runningTasks.value.add(task.id)
    await window.electronAPI.scheduler.runTask(task.id)
  } catch (error) {
    console.error('执行任务失败:', error)
  }
}

// 清除历史
const clearHistory = async () => {
  if (!confirm('确定要清除所有执行历史吗？')) return
  
  try {
    await window.electronAPI.scheduler.clearHistory()
    history.value = []
  } catch (error) {
    console.error('清除历史失败:', error)
  }
}

// 关闭
const handleClose = () => {
  emit('close')
}

// 键盘事件
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (showEditor.value) {
      showEditor.value = false
    } else {
      handleClose()
    }
  }
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  await loadData()
  
  // 监听任务事件
  cleanupTaskStarted = window.electronAPI.scheduler.onTaskStarted(({ taskId }) => {
    runningTasks.value.add(taskId)
  })
  
  cleanupTaskCompleted = window.electronAPI.scheduler.onTaskCompleted(({ taskId }) => {
    runningTasks.value.delete(taskId)
    loadData() // 刷新数据
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  cleanupTaskStarted?.()
  cleanupTaskCompleted?.()
})
</script>

<template>
  <div class="modal-overlay" @click.self="handleClose">
    <div class="scheduler-manager">
      <!-- 头部 -->
      <div class="manager-header">
        <h2>
          <Clock :size="20" style="margin-right: 8px; vertical-align: middle;" />
          {{ t('scheduler.title') }}
        </h2>
        <button class="btn-icon" @click="handleClose">
          <X :size="20" />
        </button>
      </div>

      <!-- 主体 -->
      <div class="manager-body">
        <!-- 左侧：任务列表 -->
        <div class="task-list-panel">
          <!-- 标签切换 -->
          <div class="tabs">
            <button 
              class="tab-btn"
              :class="{ active: activeTab === 'tasks' }"
              @click="activeTab = 'tasks'"
            >
              <Clock :size="14" />
              {{ t('scheduler.tasks') }} ({{ tasks.length }})
            </button>
            <button 
              class="tab-btn"
              :class="{ active: activeTab === 'history' }"
              @click="activeTab = 'history'"
            >
              <History :size="14" />
              {{ t('scheduler.history') }}
            </button>
          </div>

          <!-- 任务列表 -->
          <template v-if="activeTab === 'tasks'">
            <div class="list-toolbar">
              <button class="btn btn-primary btn-sm" @click="openCreateTask">
                <Plus :size="14" />
                {{ t('scheduler.newTask') }}
              </button>
              <button class="btn btn-sm" @click="loadData" :disabled="loading">
                <RefreshCw :size="14" :class="{ spinning: loading }" />
              </button>
            </div>

            <div class="task-list" v-if="!loading">
              <div 
                v-for="task in tasks" 
                :key="task.id"
                class="task-item"
                :class="{ active: selectedTask?.id === task.id, disabled: !task.enabled }"
                @click="selectTask(task)"
              >
                <div class="task-status">
                  <button 
                    class="btn-toggle"
                    :class="{ enabled: task.enabled }"
                    @click.stop="toggleTask(task)"
                    :title="task.enabled ? t('scheduler.disable') : t('scheduler.enable')"
                  >
                    <span class="toggle-dot"></span>
                  </button>
                </div>
                <div class="task-info">
                  <div class="task-name">{{ task.name }}</div>
                  <div class="task-meta">
                    <span class="task-schedule">{{ formatSchedule(task.schedule) }}</span>
                    <span class="task-target">
                      <component :is="getTargetIcon(task.target)" :size="10" />
                      {{ task.target.type === 'ssh' ? task.target.sshSessionName : task.target.type }}
                    </span>
                  </div>
                  <div class="task-next" v-if="task.nextRun && task.enabled">
                    {{ t('scheduler.nextRun') }}: {{ formatDate(task.nextRun) }}
                  </div>
                </div>
                <div class="task-actions">
                  <button 
                    class="btn-icon btn-sm"
                    @click.stop="runTask(task)"
                    :disabled="runningTasks.has(task.id)"
                    :title="t('scheduler.runNow')"
                  >
                    <Play :size="14" :class="{ spinning: runningTasks.has(task.id) }" />
                  </button>
                </div>
              </div>

              <div v-if="tasks.length === 0" class="empty-state">
                <Clock :size="48" class="empty-icon" />
                <p>{{ t('scheduler.noTasks') }}</p>
                <button class="btn btn-primary" @click="openCreateTask">
                  {{ t('scheduler.createFirst') }}
                </button>
              </div>
            </div>

            <div v-else class="loading-state">
              <RefreshCw :size="24" class="spinning" />
              <p>{{ t('scheduler.loading') }}</p>
            </div>
          </template>

          <!-- 历史记录 -->
          <template v-else>
            <div class="list-toolbar">
              <span class="history-count">{{ t('scheduler.historyCount', { count: history.length }) }}</span>
              <button class="btn btn-sm btn-danger" @click="clearHistory" :disabled="history.length === 0">
                <Trash2 :size="14" />
                {{ t('scheduler.clearHistory') }}
              </button>
            </div>

            <div class="history-list">
              <div 
                v-for="record in history" 
                :key="record.id"
                class="history-item"
              >
                <div class="history-status" :class="getStatusClass(record.status)">
                  {{ getStatusText(record.status) }}
                </div>
                <div class="history-info">
                  <div class="history-name">{{ record.taskName }}</div>
                  <div class="history-meta">
                    <span>{{ formatFullDate(record.at) }}</span>
                    <span>{{ formatDuration(record.duration) }}</span>
                  </div>
                </div>
              </div>

              <div v-if="history.length === 0" class="empty-state">
                <History :size="48" class="empty-icon" />
                <p>{{ t('scheduler.noHistory') }}</p>
              </div>
            </div>
          </template>
        </div>

        <!-- 右侧：任务详情 -->
        <div class="task-detail-panel">
          <template v-if="selectedTask">
            <div class="detail-header">
              <div class="detail-title">
                <h3>{{ selectedTask.name }}</h3>
                <span class="task-badge" :class="{ enabled: selectedTask.enabled }">
                  {{ selectedTask.enabled ? t('scheduler.enabled') : t('scheduler.disabled') }}
                </span>
              </div>
              <div class="detail-actions">
                <button class="btn btn-sm" @click="openEditTask(selectedTask)">
                  <Edit3 :size="14" />
                  {{ t('scheduler.edit') }}
                </button>
                <button 
                  class="btn btn-primary btn-sm" 
                  @click="runTask(selectedTask)"
                  :disabled="runningTasks.has(selectedTask.id)"
                >
                  <Play :size="14" />
                  {{ runningTasks.has(selectedTask.id) ? t('scheduler.running') : t('scheduler.runNow') }}
                </button>
                <button class="btn btn-danger btn-sm" @click="deleteTask(selectedTask)">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <div class="detail-content">
              <div class="detail-section">
                <h4>{{ t('scheduler.scheduleConfig') }}</h4>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.scheduleType') }}:</span>
                  <span class="value">{{ formatSchedule(selectedTask.schedule) }}</span>
                </div>
                <div class="detail-row" v-if="selectedTask.nextRun && selectedTask.enabled">
                  <span class="label">{{ t('scheduler.nextRun') }}:</span>
                  <span class="value">{{ formatFullDate(selectedTask.nextRun) }}</span>
                </div>
              </div>

              <div class="detail-section">
                <h4>{{ t('scheduler.targetConfig') }}</h4>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.targetType') }}:</span>
                  <span class="value">{{ getTargetDescription(selectedTask.target) }}</span>
                </div>
              </div>

              <div class="detail-section">
                <h4>{{ t('scheduler.taskPrompt') }}</h4>
                <div class="prompt-content">
                  {{ selectedTask.prompt }}
                </div>
              </div>

              <div class="detail-section">
                <h4>{{ t('scheduler.options') }}</h4>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.timeout') }}:</span>
                  <span class="value">{{ selectedTask.options.timeout }}s</span>
                </div>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.notifyComplete') }}:</span>
                  <span class="value">{{ selectedTask.options.notifyOnComplete ? '是' : '否' }}</span>
                </div>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.notifyError') }}:</span>
                  <span class="value">{{ selectedTask.options.notifyOnError ? '是' : '否' }}</span>
                </div>
              </div>

              <div class="detail-section" v-if="selectedTask.lastRun">
                <h4>{{ t('scheduler.lastRun') }}</h4>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.status') }}:</span>
                  <span class="value" :class="getStatusClass(selectedTask.lastRun.status)">
                    {{ getStatusText(selectedTask.lastRun.status) }}
                  </span>
                </div>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.time') }}:</span>
                  <span class="value">{{ formatFullDate(selectedTask.lastRun.at) }}</span>
                </div>
                <div class="detail-row">
                  <span class="label">{{ t('scheduler.duration') }}:</span>
                  <span class="value">{{ formatDuration(selectedTask.lastRun.duration) }}</span>
                </div>
                <div class="detail-row" v-if="selectedTask.lastRun.error">
                  <span class="label">{{ t('scheduler.error') }}:</span>
                  <span class="value error-text">{{ selectedTask.lastRun.error }}</span>
                </div>
              </div>
            </div>
          </template>

          <div v-else class="no-selection">
            <Clock :size="64" class="empty-icon" />
            <p>{{ t('scheduler.selectTask') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 任务编辑器弹窗 -->
    <SchedulerTaskEditor
      v-if="showEditor"
      :task="editingTask"
      @save="handleSaveTask"
      @cancel="showEditor = false"
    />
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

.scheduler-manager {
  width: 1000px;
  max-width: 95vw;
  height: 700px;
  max-height: 90vh;
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
  display: flex;
  align-items: center;
}

.manager-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 左侧面板 */
.task-list-panel {
  width: 380px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-color);
}

.tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color);
}

.tab-btn {
  flex: 1;
  padding: 12px;
  font-size: 13px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  transition: all 0.2s;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tab-btn.active {
  color: var(--accent-primary);
  border-bottom: 2px solid var(--accent-primary);
}

.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.history-count {
  font-size: 13px;
  color: var(--text-muted);
}

.task-list,
.history-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.task-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.task-item:hover {
  background: var(--bg-hover);
}

.task-item.active {
  background: var(--accent-primary);
  color: white;
}

.task-item.disabled {
  opacity: 0.6;
}

.task-status {
  flex-shrink: 0;
  padding-top: 2px;
}

.btn-toggle {
  width: 36px;
  height: 20px;
  border-radius: 10px;
  border: none;
  background: var(--bg-tertiary);
  cursor: pointer;
  position: relative;
  transition: all 0.2s;
}

.btn-toggle.enabled {
  background: var(--success);
}

.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: white;
  transition: all 0.2s;
}

.btn-toggle.enabled .toggle-dot {
  left: 18px;
}

.task-info {
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 4px;
}

.task-meta {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
}

.task-item.active .task-meta {
  color: rgba(255, 255, 255, 0.7);
}

.task-target {
  display: flex;
  align-items: center;
  gap: 4px;
}

.task-next {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

.task-item.active .task-next {
  color: rgba(255, 255, 255, 0.6);
}

.task-actions {
  opacity: 0;
  transition: opacity 0.2s;
}

.task-item:hover .task-actions {
  opacity: 1;
}

.task-item.active .task-actions {
  opacity: 1;
}

/* 历史记录项 */
.history-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  transition: background 0.2s;
}

.history-item:hover {
  background: var(--bg-hover);
}

.history-status {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  min-width: 50px;
  text-align: center;
}

.status-success {
  background: rgba(var(--success-rgb, 34, 197, 94), 0.2);
  color: var(--success);
}

.status-error {
  background: rgba(var(--error-rgb, 239, 68, 68), 0.2);
  color: var(--error);
}

.status-warning {
  background: rgba(var(--warning-rgb, 234, 179, 8), 0.2);
  color: var(--warning);
}

.status-muted {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.status-running {
  background: rgba(var(--accent-rgb, 99, 102, 241), 0.2);
  color: var(--accent-primary);
}

.history-info {
  flex: 1;
}

.history-name {
  font-size: 13px;
  margin-bottom: 2px;
}

.history-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
}

/* 右侧详情面板 */
.task-detail-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.detail-title {
  display: flex;
  align-items: center;
  gap: 12px;
}

.detail-title h3 {
  font-size: 16px;
  font-weight: 600;
}

.task-badge {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.task-badge.enabled {
  background: rgba(var(--success-rgb, 34, 197, 94), 0.2);
  color: var(--success);
}

.detail-actions {
  display: flex;
  gap: 8px;
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.detail-section {
  margin-bottom: 24px;
}

.detail-section h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.detail-row {
  display: flex;
  margin-bottom: 8px;
  font-size: 13px;
}

.detail-row .label {
  width: 100px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.detail-row .value {
  flex: 1;
}

.error-text {
  color: var(--error);
}

.prompt-content {
  background: var(--bg-tertiary);
  padding: 12px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  max-height: 200px;
  overflow-y: auto;
}

/* 空状态 */
.empty-state,
.loading-state,
.no-selection {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  gap: 16px;
}

.empty-icon {
  opacity: 0.3;
}

/* 动画 */
.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 按钮样式 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
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

.btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-secondary);
}

.btn-danger {
  background: var(--error);
  border-color: var(--error);
  color: white;
}

.btn-danger:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-sm {
  padding: 6px 10px;
  font-size: 12px;
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-icon:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-icon.btn-sm {
  width: 28px;
  height: 28px;
}
</style>
