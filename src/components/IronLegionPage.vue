<script setup lang="ts">
/**
 * 钢铁军团控制台界面
 * 多终端 Agent 协调模式的控制面板
 * Worker 终端会显示在主标签栏中，这里只显示控制台和状态概览
 */
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
<<<<<<< HEAD
import { ArrowLeft, Trash2, ChevronDown, Play, Square, User } from 'lucide-vue-next'
import { useIronLegion, type ConfirmStrategy } from '../composables/useIronLegion'
=======
import { useIronLegionStore } from '../stores/ironLegion'
import { useTerminalStore } from '../stores/terminal'
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
import { useConfigStore } from '../stores/config'
import type { ConfirmStrategy } from '../composables/useIronLegion'

const { t } = useI18n()
const configStore = useConfigStore()
const legionStore = useIronLegionStore()
const terminalStore = useTerminalStore()

// AI 配置
const aiProfiles = computed(() => configStore.aiProfiles)
const activeAiProfile = computed(() => configStore.activeAiProfile)
const selectedProfileId = ref(activeAiProfile.value?.id || '')

// 同步选中的 profile（当全局配置改变时）
watch(activeAiProfile, (newProfile) => {
  if (newProfile && !selectedProfileId.value) {
    selectedProfileId.value = newProfile.id
  }
}, { immediate: true })

// 任务输入
const taskInput = ref('')

// 确认策略
const confirmStrategy = ref<ConfirmStrategy>('batch')
const showStrategyMenu = ref(false)

// 策略显示名称
const strategyLabels = computed<Record<ConfirmStrategy, string>>(() => ({
  cautious: t('patrol.strategyLabels.cautious'),
  batch: t('patrol.strategyLabels.batch'),
  free: t('patrol.strategyLabels.free')
}))

// 获取当前协调器的 Worker 终端列表
const workerTabs = computed(() => {
  if (!legionStore.orchestratorId) return []
  return terminalStore.getLegionWorkerTabs(legionStore.orchestratorId)
})

// 最小化面板
const minimizePanel = () => {
  legionStore.minimize()
}

// 关闭面板（返回欢迎页，清空状态）
const closePanel = () => {
  // 关闭所有 Worker 终端
  if (legionStore.orchestratorId) {
    terminalStore.closeLegionWorkerTabs(legionStore.orchestratorId)
  }
  legionStore.reset()
}

// 选择确认策略
const selectStrategy = (strategy: ConfirmStrategy) => {
  confirmStrategy.value = strategy
  showStrategyMenu.value = false
}

// 开始执行任务
const startTask = async () => {
  if (!taskInput.value.trim() || legionStore.isRunning) return
  
  await legionStore.startTask(taskInput.value, {
    confirmStrategy: confirmStrategy.value,
    profileId: selectedProfileId.value || undefined
  })
}

// 停止执行
const stopTask = () => {
  legionStore.stopTask()
}

// 清空对话
const clearMessages = () => {
  // 关闭所有 Worker 终端
  if (legionStore.orchestratorId) {
    terminalStore.closeLegionWorkerTabs(legionStore.orchestratorId)
  }
  legionStore.clearSession()
  taskInput.value = ''
}

// 切换到指定的 Worker 终端
const switchToWorker = (tabId: string) => {
  terminalStore.setActiveTab(tabId)
  // 最小化钢铁军团面板，让用户专注于终端
  legionStore.minimize()
}

// 获取 Worker 状态图标
const getWorkerStatusIcon = (status: string) => {
  switch (status) {
    case 'connecting': return '🔄'
    case 'idle': return '⏸️'
    case 'running': return '⚡'
    case 'completed': return '✅'
    case 'failed': return '❌'
    case 'timeout': return '⏰'
    default: return '❓'
  }
}

// 获取 Worker 状态颜色类
const getWorkerStatusClass = (status: string) => {
  switch (status) {
    case 'running': return 'status-running'
    case 'completed': return 'status-completed'
    case 'failed': return 'status-failed'
    case 'timeout': return 'status-timeout'
    default: return 'status-idle'
  }
}

// 点击外部关闭策略菜单
const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.strategy-dropdown')) {
    showStrategyMenu.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  legionStore.loadHosts()
  legionStore.setupListeners()
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="iron-legion-console">
    <!-- 顶部导航栏 -->
<<<<<<< HEAD
    <header class="legion-header">
      <button class="btn-back" @click="goBack">
        <ArrowLeft :size="20" />
        <span>{{ t('common.back') }}</span>
      </button>
      <h1 class="legion-title">
        <span class="title-icon">🤖</span>
        {{ t('welcome.ironLegion') }}
      </h1>
=======
    <header class="console-header">
      <div class="header-left">
        <button class="btn-minimize" @click="minimizePanel" :title="t('legion.minimizePanel')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M6 9l6 6 6-6"/>
          </svg>
        </button>
        <h1 class="console-title">
          <span class="title-icon">🤖</span>
          {{ t('welcome.ironLegion') }}
        </h1>
        <span v-if="legionStore.isRunning" class="running-badge">
          <span class="pulse-dot"></span>
          运行中
        </span>
      </div>
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
      <div class="header-actions">
        <!-- 模型选择 -->
        <select 
          v-if="aiProfiles.length > 0"
          v-model="selectedProfileId"
          class="model-select"
          :disabled="legionStore.isRunning"
          :title="t('ai.switchModel')"
        >
          <option v-for="profile in aiProfiles" :key="profile.id" :value="profile.id">
            {{ profile.name }} ({{ profile.model }})
          </option>
        </select>
        <button class="btn-icon" @click="clearMessages" :title="t('common.clear')">
          <Trash2 :size="18" />
        </button>
        <button class="btn-icon btn-close" @click="closePanel" :title="t('common.close')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- 主体内容 -->
    <div class="console-body">
      <!-- 任务输入区 -->
      <div class="task-section">
        <div class="task-input-row">
          <textarea
            v-model="taskInput"
            class="task-input"
            :placeholder="t('legion.inputPlaceholder')"
            :disabled="legionStore.isRunning"
            rows="2"
            @keydown.ctrl.enter="startTask"
            @keydown.meta.enter="startTask"
          ></textarea>
          <div class="task-actions">
            <div class="strategy-dropdown" v-if="!legionStore.isRunning">
              <button class="btn-strategy" @click.stop="showStrategyMenu = !showStrategyMenu">
<<<<<<< HEAD
                {{ strategyLabels[confirmStrategy as ConfirmStrategy] }}
                <ChevronDown :size="12" />
=======
                {{ strategyLabels[confirmStrategy] }}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
              </button>
              <div v-if="showStrategyMenu" class="strategy-menu">
                <div 
                  v-for="(label, key) in strategyLabels" 
                  :key="key"
                  class="strategy-option"
                  :class="{ active: confirmStrategy === key }"
                  @click="selectStrategy(key as ConfirmStrategy)"
                >
                  <span class="option-label">{{ label }}</span>
<<<<<<< HEAD
                  <span v-if="key === 'cautious'" class="option-desc">{{ t('patrol.strategyDescs.cautious') }}</span>
                  <span v-if="key === 'batch'" class="option-desc">{{ t('patrol.strategyDescs.batch') }}</span>
                  <span v-if="key === 'free'" class="option-desc">{{ t('patrol.strategyDescs.free') }}</span>
=======
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
                </div>
              </div>
            </div>
            <button 
              v-if="!legionStore.isRunning"
              class="btn-start" 
              :disabled="!taskInput.trim()"
              @click="startTask"
            >
<<<<<<< HEAD
              <Play :size="18" />
              {{ t('legion.startExecution') }}
=======
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
            </button>
            <button 
              v-else
              class="btn-stop" 
              @click="stopTask"
            >
<<<<<<< HEAD
              <Square :size="18" />
              {{ t('legion.stopExecution') }}
=======
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="6" width="12" height="12"/>
              </svg>
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
            </button>
          </div>
        </div>
      </div>

<<<<<<< HEAD
        <!-- 执行区域 -->
        <div class="execution-section">
          <!-- 空状态 -->
          <div v-if="messages.length === 0 && !currentPlan" class="empty-state">
            <div class="empty-icon">🔍</div>
            <div class="empty-title">{{ t('legion.emptyTitle') }}</div>
            <div class="empty-desc">{{ t('legion.emptyDesc') }}</div>
            <div class="example-tasks">
              <div class="example-label">{{ t('legion.exampleTasks') }}</div>
              <div class="example-item" @click="taskInput = t('legion.exampleTask1')">
                {{ t('legion.exampleTask1') }}
              </div>
              <div class="example-item" @click="taskInput = t('legion.exampleTask2')">
                {{ t('legion.exampleTask2') }}
              </div>
              <div class="example-item" @click="taskInput = t('legion.exampleTask3')">
                {{ t('legion.exampleTask3') }}
              </div>
=======
      <!-- Worker 状态卡片区域 -->
      <div v-if="workerTabs.length > 0 || legionStore.workers.length > 0" class="workers-section">
        <div class="section-header">
          <span class="section-title">Worker 终端</span>
          <span class="worker-count">{{ legionStore.workers.length }} 个</span>
        </div>
        <div class="workers-grid">
          <div 
            v-for="worker in legionStore.workers" 
            :key="worker.terminalId"
            class="worker-card"
            :class="getWorkerStatusClass(worker.status)"
            @click="switchToWorker(worker.terminalId)"
          >
            <div class="worker-header">
              <span class="worker-icon">{{ getWorkerStatusIcon(worker.status) }}</span>
              <span class="worker-name">{{ worker.hostName }}</span>
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
            </div>
            <div class="worker-status">
              {{ worker.currentTask || worker.status }}
            </div>
<<<<<<< HEAD
            
            <!-- 消息列表 -->
            <div class="messages-list">
              <div 
                v-for="msg in messages" 
                :key="msg.id"
                class="message-item"
                :class="msg.type"
              >
                <div v-if="msg.type === 'user'" class="message-avatar user">
                  <User :size="16" />
                </div>
                <div v-else-if="msg.type === 'agent'" class="message-avatar agent">
                  🤖
                </div>
                <div v-else class="message-avatar system">
                  ℹ️
                </div>
                <div class="message-content">
                  <pre v-if="msg.type === 'agent'" class="message-text">{{ msg.content }}</pre>
                  <div v-else class="message-text">{{ msg.content }}</div>
                </div>
              </div>
=======
            <div v-if="worker.result" class="worker-result">
              {{ worker.result.slice(0, 50) }}{{ worker.result.length > 50 ? '...' : '' }}
            </div>
            <div v-if="worker.error" class="worker-error">
              {{ worker.error.slice(0, 50) }}{{ worker.error.length > 50 ? '...' : '' }}
>>>>>>> 0b50145 (feat: 实现钢铁军团功能，增强多终端协作体验)
            </div>
          </div>
        </div>
        <div class="workers-hint">
          💡 点击卡片可切换到对应终端查看详细执行过程
        </div>
      </div>

      <!-- 消息列表 -->
      <div v-if="legionStore.messages.length > 0" class="messages-section">
        <div class="section-header">
          <span class="section-title">执行日志</span>
        </div>
        <div class="messages-list">
          <div 
            v-for="msg in legionStore.messages" 
            :key="msg.id"
            class="message-item"
            :class="msg.type"
          >
            <span class="message-icon">
              {{ msg.type === 'user' ? '👤' : msg.type === 'agent' ? '🤖' : 'ℹ️' }}
            </span>
            <span class="message-content">{{ msg.content }}</span>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="legionStore.messages.length === 0 && workerTabs.length === 0" class="empty-state">
        <div class="empty-icon">🚀</div>
        <div class="empty-title">{{ t('legion.emptyTitle') }}</div>
        <div class="empty-desc">{{ t('legion.emptyDesc') }}</div>
        <div class="example-chips">
          <span class="example-chip" @click="taskInput = '检查所有生产服务器的磁盘使用情况'">
            检查磁盘使用
          </span>
          <span class="example-chip" @click="taskInput = '查看各服务器的内存和CPU负载'">
            查看系统负载
          </span>
          <span class="example-chip" @click="taskInput = '检查 nginx 服务是否正常运行'">
            检查服务状态
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.iron-legion-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

/* 顶部导航栏 */
.console-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  -webkit-app-region: no-drag;
}

.btn-minimize {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-minimize:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.console-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.title-icon {
  font-size: 16px;
}

.running-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  color: #10b981;
}

.pulse-dot {
  width: 6px;
  height: 6px;
  background: #10b981;
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

.header-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  -webkit-app-region: no-drag;
}

.model-select {
  padding: 4px 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 11px;
  cursor: pointer;
  outline: none;
  max-width: 150px;
}

.btn-icon {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-icon:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-close:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

/* 主体内容 */
.console-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 16px;
  overflow-y: auto;
  gap: 16px;
}

/* 任务输入区 */
.task-section {
  flex-shrink: 0;
}

.task-input-row {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}

.task-input {
  flex: 1;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  resize: none;
  transition: border-color 0.15s ease;
}

.task-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.task-input::placeholder {
  color: var(--text-muted);
}

.task-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.task-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 策略选择 */
.strategy-dropdown {
  position: relative;
}

.btn-strategy {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.strategy-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 120px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  overflow: hidden;
  z-index: 100;
}

.strategy-option {
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
}

.strategy-option:hover {
  background: var(--bg-tertiary);
}

.strategy-option.active {
  background: rgba(59, 130, 246, 0.1);
  color: var(--accent-primary);
}

/* 开始/停止按钮 */
.btn-start,
.btn-stop {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-start {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
}

.btn-start:hover:not(:disabled) {
  transform: scale(1.05);
}

.btn-start:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-stop {
  background: linear-gradient(135deg, #ef4444, #dc2626);
  color: white;
}

.btn-stop:hover {
  transform: scale(1.05);
}

/* Section 通用 */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.worker-count {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 2px 8px;
  border-radius: 10px;
}

/* Worker 状态卡片 */
.workers-section {
  flex-shrink: 0;
}

.workers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 10px;
}

.worker-card {
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.worker-card:hover {
  border-color: var(--accent-primary);
  transform: translateY(-1px);
}

.worker-card.status-running {
  border-color: rgba(59, 130, 246, 0.5);
  background: rgba(59, 130, 246, 0.05);
}

.worker-card.status-completed {
  border-color: rgba(16, 185, 129, 0.5);
  background: rgba(16, 185, 129, 0.05);
}

.worker-card.status-failed,
.worker-card.status-timeout {
  border-color: rgba(239, 68, 68, 0.5);
  background: rgba(239, 68, 68, 0.05);
}

.worker-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.worker-icon {
  font-size: 14px;
}

.worker-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.worker-status {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.worker-result {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.worker-error {
  margin-top: 6px;
  font-size: 11px;
  color: #ef4444;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workers-hint {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
}

/* 消息列表 */
.messages-section {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.messages-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.message-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
  font-size: 12px;
}

.message-icon {
  flex-shrink: 0;
  font-size: 12px;
}

.message-content {
  flex: 1;
  color: var(--text-primary);
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-item.system .message-content {
  color: var(--text-muted);
}

/* 空状态 */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
}

.empty-icon {
  font-size: 40px;
  margin-bottom: 12px;
}

.empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.empty-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.example-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}

.example-chip {
  padding: 6px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.example-chip:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}
</style>
