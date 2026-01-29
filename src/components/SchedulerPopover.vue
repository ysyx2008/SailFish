<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, Plus, Play, ChevronRight } from 'lucide-vue-next'

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

// TaskExecutionResult 类型已在 vite-env.d.ts 中定义

const emit = defineEmits<{
  openManager: []
}>()

// 状态
const tasks = ref<ScheduledTask[]>([])
const history = ref<TaskHistoryRecord[]>([])
const showPopover = ref(false)
const runningTasks = ref<Set<string>>(new Set())
const popoverRef = ref<HTMLElement | null>(null)
const buttonRef = ref<HTMLElement | null>(null)

// 事件清理函数
let cleanupTaskStarted: (() => void) | null = null
let cleanupTaskCompleted: (() => void) | null = null

// 计算属性
const enabledTasks = computed(() => tasks.value.filter((t: ScheduledTask) => t.enabled))
const enabledCount = computed(() => enabledTasks.value.length)

// 即将执行的任务（按 nextRun 排序，取前 3 个）
const upcomingTasks = computed(() => {
  return enabledTasks.value
    .filter((t: ScheduledTask) => t.nextRun)
    .sort((a: ScheduledTask, b: ScheduledTask) => (a.nextRun || 0) - (b.nextRun || 0))
    .slice(0, 3)
})

// 最近执行记录（取前 5 个）
const recentHistory = computed(() => history.value.slice(0, 5))

// 状态提示文字
const statusTooltip = computed(() => {
  if (enabledCount.value === 0) {
    return t('scheduler.noTasksConfigured')
  }
  return `${t('scheduler.title')}: ${enabledCount.value} ${t('scheduler.tasksEnabled')}`
})

// 格式化日期
const formatDate = (timestamp: number): string => {
  const now = Date.now()
  const diff = timestamp - now
  
  // 如果在 24 小时内，显示相对时间
  if (diff > 0 && diff < 24 * 60 * 60 * 1000) {
    const hours = Math.floor(diff / (60 * 60 * 1000))
    const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000))
    if (hours > 0) {
      return `${hours}h ${minutes}m`
    }
    return `${minutes}m`
  }
  
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化时长
const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

// 状态文本
const getStatusText = (status: string): string => {
  const map: Record<string, string> = {
    success: '成功',
    failed: '失败',
    timeout: '超时',
    cancelled: '取消'
  }
  return map[status] || status
}

// 状态类名
const getStatusClass = (status: string): string => {
  const map: Record<string, string> = {
    success: 'status-success',
    failed: 'status-error',
    timeout: 'status-warning',
    cancelled: 'status-muted'
  }
  return map[status] || ''
}

// 加载数据
const loadData = async () => {
  try {
    tasks.value = await window.electronAPI.scheduler.getTasks()
    history.value = await window.electronAPI.scheduler.getHistory(undefined, 5)
    const running = await window.electronAPI.scheduler.getRunningTasks()
    runningTasks.value = new Set(running)
  } catch (error) {
    console.error('加载定时任务数据失败:', error)
  }
}

// 切换弹窗
const togglePopover = async () => {
  if (!showPopover.value) {
    await loadData()
  }
  showPopover.value = !showPopover.value
}

// 关闭弹窗
const closePopover = () => {
  showPopover.value = false
}

// 点击外部关闭
const handleClickOutside = (e: MouseEvent) => {
  if (!showPopover.value) return
  const target = e.target as Node
  if (popoverRef.value && !popoverRef.value.contains(target) &&
      buttonRef.value && !buttonRef.value.contains(target)) {
    closePopover()
  }
}

// ESC 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPopover.value) {
    e.stopImmediatePropagation()
    closePopover()
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

// 打开管理器
const openManager = () => {
  closePopover()
  emit('openManager')
}

onMounted(async () => {
  await loadData()
  
  // 监听任务事件
  cleanupTaskStarted = window.electronAPI.scheduler.onTaskStarted(({ taskId }) => {
    runningTasks.value.add(taskId)
  })
  
  cleanupTaskCompleted = window.electronAPI.scheduler.onTaskCompleted(({ taskId }) => {
    runningTasks.value.delete(taskId)
    loadData()
  })
  
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  cleanupTaskStarted?.()
  cleanupTaskCompleted?.()
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="scheduler-wrapper">
    <!-- 状态按钮 -->
    <button 
      ref="buttonRef"
      class="btn-icon scheduler-btn" 
      :title="statusTooltip"
      @click="togglePopover"
    >
      <Clock :size="18" />
      <!-- 任务数量徽章 -->
      <span v-if="enabledCount > 0" class="task-badge">
        {{ enabledCount }}
      </span>
    </button>

    <!-- 弹出面板 -->
    <Teleport to="body">
      <div v-if="showPopover" ref="popoverRef" class="scheduler-popover">
        <div class="popover-header">
          <span class="popover-title">{{ t('scheduler.title') }}</span>
          <button class="btn-add" @click="openManager" :title="t('scheduler.newTask')">
            <Plus :size="14" />
          </button>
        </div>

        <div class="popover-body">
          <!-- 即将执行 -->
          <div class="section" v-if="upcomingTasks.length > 0">
            <div class="section-title">{{ t('scheduler.upcoming') }}</div>
            <div class="task-list">
              <div 
                v-for="task in upcomingTasks" 
                :key="task.id"
                class="task-item"
              >
                <div class="task-info">
                  <span class="task-name">{{ task.name }}</span>
                  <span class="task-time">{{ formatDate(task.nextRun!) }}</span>
                </div>
                <button 
                  class="btn-run"
                  @click="runTask(task)"
                  :disabled="runningTasks.has(task.id)"
                  :title="t('scheduler.runNow')"
                >
                  <Play :size="12" :class="{ spinning: runningTasks.has(task.id) }" />
                </button>
              </div>
            </div>
          </div>

          <!-- 无任务提示 -->
          <div v-else-if="enabledCount === 0" class="empty-hint">
            <Clock :size="32" class="empty-icon" />
            <span>{{ t('scheduler.noTasksConfigured') }}</span>
          </div>

          <!-- 最近执行 -->
          <div class="section" v-if="recentHistory.length > 0">
            <div class="section-title">{{ t('scheduler.recentRuns') }}</div>
            <div class="history-list">
              <div 
                v-for="record in recentHistory" 
                :key="record.id"
                class="history-item"
              >
                <span class="history-status" :class="getStatusClass(record.status)">
                  {{ getStatusText(record.status) }}
                </span>
                <span class="history-name">{{ record.taskName }}</span>
                <span class="history-duration">{{ formatDuration(record.duration) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="popover-footer">
          <button class="btn-manage" @click="openManager">
            {{ t('scheduler.manageAll') }}
            <ChevronRight :size="14" />
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.scheduler-wrapper {
  position: relative;
}

.scheduler-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 6px;
  border-radius: 6px;
}

/* 任务数量徽章 */
.task-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
  color: white;
  background: var(--accent-primary);
  border-radius: 7px;
}

/* 弹出面板 */
.scheduler-popover {
  position: fixed;
  top: 50px;
  right: 100px;
  width: 320px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  overflow: hidden;
}

.popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.popover-title {
  font-size: 14px;
  font-weight: 600;
}

.btn-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: var(--accent-primary);
  color: white;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-add:hover {
  background: var(--accent-secondary);
}

.popover-body {
  padding: 12px 0;
  max-height: 300px;
  overflow-y: auto;
}

.section {
  padding: 0 16px;
  margin-bottom: 16px;
}

.section:last-child {
  margin-bottom: 0;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 8px;
}

.task-list,
.history-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  transition: background 0.2s;
}

.task-item:hover {
  background: var(--bg-hover);
}

.task-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.task-name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-time {
  font-size: 11px;
  color: var(--text-muted);
}

.btn-run {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-run:hover:not(:disabled) {
  background: var(--accent-primary);
  color: white;
}

.btn-run:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  font-size: 12px;
}

.history-status {
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 500;
  min-width: 36px;
  text-align: center;
}

.status-success {
  background: rgba(34, 197, 94, 0.2);
  color: #22c55e;
}

.status-error {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.status-warning {
  background: rgba(234, 179, 8, 0.2);
  color: #eab308;
}

.status-muted {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.history-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-duration {
  color: var(--text-muted);
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--text-muted);
  font-size: 13px;
}

.empty-icon {
  opacity: 0.3;
}

.popover-footer {
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

.btn-manage {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  padding: 8px;
  font-size: 13px;
  border: none;
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-manage:hover {
  background: var(--bg-hover);
}

/* 动画 */
.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
