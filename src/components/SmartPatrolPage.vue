<script setup lang="ts">
/**
 * 智能巡检全屏界面
 * 多终端 Agent 协调模式的主界面
 */
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSmartPatrol, type ConfirmStrategy } from '../composables/useSmartPatrol'
import AgentPlanView from './AgentPlanView.vue'

const { t } = useI18n()

const emit = defineEmits<{
  back: []
}>()

// 使用智能巡检 composable
const {
  isRunning,
  messages,
  currentPlan,
  hasHosts,
  startTask: doStartTask,
  stopTask: doStopTask,
  clearSession
} = useSmartPatrol()

// 任务输入
const taskInput = ref('')

// 确认策略
const confirmStrategy = ref<ConfirmStrategy>('batch')
const showStrategyMenu = ref(false)

// 策略显示名称
const strategyLabels: Record<ConfirmStrategy, string> = {
  cautious: '审慎模式',
  batch: '批量确认',
  free: '自由模式'
}

// 返回欢迎页
const goBack = () => {
  emit('back')
}

// 选择确认策略
const selectStrategy = (strategy: ConfirmStrategy) => {
  confirmStrategy.value = strategy
  showStrategyMenu.value = false
}

// 开始执行任务
const startTask = async () => {
  if (!taskInput.value.trim() || isRunning.value) return
  
  await doStartTask(taskInput.value, {
    confirmStrategy: confirmStrategy.value
  })
}

// 停止执行
const stopTask = () => {
  doStopTask()
}

// 清空对话
const clearMessages = () => {
  clearSession()
  taskInput.value = ''
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
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<template>
  <div class="smart-patrol-page">
    <!-- 顶部导航栏 -->
    <header class="patrol-header">
      <button class="btn-back" @click="goBack">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M19 12H5M12 19l-7-7 7-7"/>
        </svg>
        <span>{{ t('common.back') }}</span>
      </button>
      <h1 class="patrol-title">
        <span class="title-icon">🤖</span>
        {{ t('welcome.smartPatrol') }}
      </h1>
      <div class="header-actions">
        <button class="btn-icon" @click="clearMessages" :title="t('common.clear')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- 主体内容 -->
    <div class="patrol-body">
      <!-- 无 SSH 会话提示（但仍可使用本地终端） -->
      <div v-if="!hasHosts" class="no-sessions-hint-banner">
        <span class="hint-text">💡 {{ t('patrol.noSessionsHint') }}</span>
        <button class="btn-link" @click="goBack">{{ t('patrol.goAddSessions') }}</button>
      </div>

      <!-- 正常界面 -->
      <template>
        <!-- 任务输入区 -->
        <div class="task-input-section">
          <div class="input-wrapper">
            <textarea
              v-model="taskInput"
              class="task-input"
              :placeholder="t('patrol.inputPlaceholder')"
              :disabled="isRunning"
              rows="3"
              @keydown.ctrl.enter="startTask"
              @keydown.meta.enter="startTask"
            ></textarea>
          </div>
          <div class="input-actions">
            <div class="strategy-dropdown" v-if="!isRunning">
              <button class="btn-strategy" @click.stop="showStrategyMenu = !showStrategyMenu">
                {{ strategyLabels[confirmStrategy] }}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M6 9l6 6 6-6"/>
                </svg>
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
                  <span v-if="key === 'cautious'" class="option-desc">每个危险命令都确认</span>
                  <span v-if="key === 'batch'" class="option-desc">相同命令批量确认</span>
                  <span v-if="key === 'free'" class="option-desc">自动执行（谨慎使用）</span>
                </div>
              </div>
            </div>
            <button 
              v-if="!isRunning"
              class="btn-start" 
              :disabled="!taskInput.trim()"
              @click="startTask"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
              {{ t('patrol.startExecution') }}
            </button>
            <button 
              v-else
              class="btn-stop" 
              @click="stopTask"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="6" y="6" width="12" height="12"/>
              </svg>
              {{ t('patrol.stopExecution') }}
            </button>
          </div>
        </div>

        <!-- 执行区域 -->
        <div class="execution-section">
          <!-- 空状态 -->
          <div v-if="messages.length === 0 && !currentPlan" class="empty-state">
            <div class="empty-icon">🔍</div>
            <div class="empty-title">{{ t('patrol.emptyTitle') }}</div>
            <div class="empty-desc">{{ t('patrol.emptyDesc') }}</div>
            <div class="example-tasks">
              <div class="example-label">{{ t('patrol.exampleTasks') }}</div>
              <div class="example-item" @click="taskInput = '检查所有生产服务器的磁盘使用情况'">
                检查所有生产服务器的磁盘使用情况
              </div>
              <div class="example-item" @click="taskInput = '查看各服务器的内存和CPU负载'">
                查看各服务器的内存和CPU负载
              </div>
              <div class="example-item" @click="taskInput = '检查 nginx 服务是否正常运行'">
                检查 nginx 服务是否正常运行
              </div>
            </div>
          </div>

          <!-- 对话和进度 -->
          <div v-else class="execution-content">
            <!-- 计划进度卡片 -->
            <div v-if="currentPlan" class="plan-card">
              <AgentPlanView :plan="currentPlan" />
            </div>
            
            <!-- 消息列表 -->
            <div class="messages-list">
              <div 
                v-for="msg in messages" 
                :key="msg.id"
                class="message-item"
                :class="msg.type"
              >
                <div v-if="msg.type === 'user'" class="message-avatar user">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
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
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.smart-patrol-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
}

/* 顶部导航栏 */
.patrol-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}

.btn-back {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
  -webkit-app-region: no-drag;
}

.btn-back:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.patrol-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.title-icon {
  font-size: 20px;
}

.header-actions {
  display: flex;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.btn-icon {
  width: 32px;
  height: 32px;
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

/* 主体内容 */
.patrol-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 24px;
  overflow-y: auto;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

/* 无会话提示横幅 */
.no-sessions-hint-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  margin-bottom: 16px;
  background: rgba(251, 191, 36, 0.1);
  border: 1px solid rgba(251, 191, 36, 0.3);
  border-radius: 8px;
  font-size: 13px;
}

.hint-text {
  color: var(--text-secondary);
}

.btn-link {
  background: none;
  border: none;
  color: var(--accent-primary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}

.btn-link:hover {
  opacity: 0.8;
}

/* 任务输入区 */
.task-input-section {
  margin-bottom: 24px;
}

.input-wrapper {
  margin-bottom: 12px;
}

.task-input {
  width: 100%;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  color: var(--text-primary);
  font-size: 15px;
  font-family: inherit;
  line-height: 1.5;
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

.input-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}

/* 策略选择 */
.strategy-dropdown {
  position: relative;
}

.btn-strategy {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-strategy:hover {
  background: var(--bg-tertiary);
}

.strategy-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 8px;
  min-width: 200px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  overflow: hidden;
  z-index: 100;
}

.strategy-option {
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.strategy-option:hover {
  background: var(--bg-tertiary);
}

.strategy-option.active {
  background: rgba(59, 130, 246, 0.1);
}

.option-label {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.option-desc {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
}

/* 开始/停止按钮 */
.btn-start,
.btn-stop {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-start {
  background: linear-gradient(135deg, #10b981, #059669);
  color: white;
}

.btn-start:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
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
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
}

/* 执行区域 */
.execution-section {
  flex: 1;
  display: flex;
  flex-direction: column;
}

/* 空状态 */
.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.empty-desc {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 24px;
}

.example-tasks {
  text-align: left;
  max-width: 400px;
}

.example-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.example-item {
  padding: 12px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  margin-bottom: 8px;
}

.example-item:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

/* 执行内容 */
.execution-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 计划卡片 */
.plan-card {
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
}

/* 消息列表 */
.messages-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.message-item {
  display: flex;
  gap: 12px;
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 16px;
}

.message-avatar.user {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  color: white;
}

.message-avatar.agent {
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
}

.message-avatar.system {
  background: var(--bg-tertiary);
}

.message-content {
  flex: 1;
  min-width: 0;
}

.message-text {
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-radius: 12px;
  font-size: 14px;
  color: var(--text-primary);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  font-family: inherit;
}

.message-item.user .message-text {
  background: rgba(59, 130, 246, 0.1);
}

.message-item.system .message-text {
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-size: 13px;
}
</style>

