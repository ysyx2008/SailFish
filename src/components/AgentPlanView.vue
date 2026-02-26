<script setup lang="ts">
/**
 * Agent 任务计划展示组件
 * 显示任务执行进度和步骤状态
 * 支持紧凑模式（顶部固定）和展开模式
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AgentPlan } from '@shared/types'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  plan: AgentPlan
  compact?: boolean
}>(), {
  compact: false
})

const emit = defineEmits<{
  toggle: []
}>()

// 计算完成的步骤数
const completedCount = computed(() => 
  props.plan.steps.filter(s => s.status === 'completed').length
)

// 计算进度百分比
const progressPercent = computed(() => {
  if (!props.plan || props.plan.steps.length === 0) return 0
  return Math.round((completedCount.value / props.plan.steps.length) * 100)
})

// 当前执行中的步骤
const currentStep = computed(() => 
  props.plan.steps.find(s => s.status === 'in_progress')
)

// 是否全部完成
const isAllCompleted = computed(() => 
  props.plan.steps.every(s => s.status === 'completed' || s.status === 'skipped')
)

// 是否有失败的步骤
const hasFailed = computed(() => 
  props.plan.steps.some(s => s.status === 'failed')
)

// 获取步骤状态图标
const getStepIcon = (status: PlanStepStatus): string => {
  switch (status) {
    case 'completed': return '✓'
    case 'failed': return '✗'
    case 'skipped': return '–'
    case 'in_progress': return ''
    default: return ''
  }
}

// 格式化进度显示
const formatProgress = (progress: StepProgress): string => {
  if (progress.isIndeterminate) {
    return progress.statusText || t('ai.executing')
  }
  
  let text = ''
  if (progress.current !== undefined && progress.total !== undefined) {
    text = `${progress.current}/${progress.total}`
  } else {
    text = `${progress.value}%`
  }
  
  if (progress.eta) {
    text += ` · ETA: ${progress.eta}`
  }
  
  return text
}

// 点击切换展开/折叠
const handleToggle = () => {
  emit('toggle')
}
</script>

<template>
  <div 
    class="agent-plan" 
    :class="{ 
      'is-completed': isAllCompleted, 
      'has-failed': hasFailed,
      'is-compact': compact
    }"
  >
    <!-- 顶部进度条 -->
    <div 
      class="top-progress-bar"
      :style="{ '--progress': progressPercent + '%' }"
      :class="{ 'failed': hasFailed }"
    ></div>

    <!-- 紧凑模式 -->
    <div v-if="compact" class="plan-compact" @click="handleToggle">
      <div class="compact-left">
        <span class="plan-icon">📋</span>
        <span class="plan-title-text">{{ plan.title }}</span>
        <span class="compact-separator">·</span>
        <span v-if="currentStep" class="current-step-hint">
          <span class="current-step-spinner"></span>
          {{ currentStep.title }}
        </span>
        <span v-else-if="isAllCompleted" class="completed-hint">✓ 已完成</span>
        <span v-else-if="hasFailed" class="failed-hint">✗ 执行失败</span>
      </div>
      <div class="compact-right">
        <span class="progress-text">{{ completedCount }}/{{ plan.steps.length }}</span>
        <span class="expand-icon">▼</span>
      </div>
    </div>

    <!-- 展开模式 -->
    <div v-else class="plan-expanded">
      <!-- 计划头部 -->
      <div class="plan-header" @click="handleToggle">
        <div class="plan-title">
          <span class="plan-icon">📋</span>
          <span class="plan-title-text">{{ plan.title }}</span>
        </div>
        <div class="plan-header-right">
          <span class="progress-text">{{ completedCount }}/{{ plan.steps.length }}</span>
          <span class="collapse-icon">▲</span>
        </div>
      </div>
      
      <!-- 步骤列表 -->
      <div class="plan-steps">
        <div 
          v-for="(step, index) in plan.steps" 
          :key="step.id"
          class="plan-step"
          :class="step.status"
        >
          <!-- 步骤指示器 -->
          <div class="step-indicator">
            <span v-if="step.status === 'in_progress'" class="step-spinner"></span>
            <span v-else-if="getStepIcon(step.status)" class="step-icon" :class="step.status">
              {{ getStepIcon(step.status) }}
            </span>
            <span v-else class="step-number">{{ index + 1 }}</span>
          </div>
          
          <!-- 步骤内容 -->
          <div class="step-content">
            <div class="step-title">
              <span v-if="step.terminalName" class="terminal-badge">[{{ step.terminalName }}]</span>
              {{ step.title }}
            </div>
            <div v-if="step.description && step.status === 'pending'" class="step-description">
              {{ step.description }}
            </div>
            <div v-if="step.result" class="step-result" :class="step.status">
              {{ step.result }}
            </div>
            
            <!-- 步骤进度条 -->
            <div v-if="step.progress && step.status === 'in_progress'" class="step-progress">
              <div class="mini-progress-bar">
                <div 
                  class="mini-progress-fill" 
                  :class="{ 'indeterminate': step.progress.isIndeterminate }"
                  :style="{ width: step.progress.isIndeterminate ? '100%' : step.progress.value + '%' }"
                ></div>
              </div>
              <span class="mini-progress-text">{{ formatProgress(step.progress) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-plan {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px 16px 14px;
  transition: all 0.2s ease;
  position: relative;
  overflow: hidden;
}

.agent-plan.is-compact {
  padding: 12px 14px 10px;
  border-radius: 8px;
}

.agent-plan.is-completed {
  border-color: rgba(16, 185, 129, 0.3);
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.05), transparent);
}

.agent-plan.has-failed {
  border-color: rgba(239, 68, 68, 0.3);
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.05), transparent);
}

/* ==================== 紧凑模式样式 ==================== */
.plan-compact {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  gap: 12px;
}

.plan-compact:hover {
  opacity: 0.9;
}

.compact-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.compact-separator {
  color: var(--text-muted);
  opacity: 0.5;
}

.current-step-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #3b82f6;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.current-step-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(59, 130, 246, 0.2);
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  flex-shrink: 0;
}

.completed-hint {
  color: #10b981;
  font-size: 13px;
}

.failed-hint {
  color: #ef4444;
  font-size: 13px;
}

.compact-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 顶部进度条 - 紧凑模式 */
.top-progress-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: rgba(255, 255, 255, 0.08);
}

.top-progress-bar::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--progress, 0%);
  background: linear-gradient(90deg, #10b981, #34d399);
  transition: width 0.4s ease;
}

.top-progress-bar.failed::after {
  background: linear-gradient(90deg, #f87171, #ef4444);
}


.expand-icon,
.collapse-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.expand-icon {
  transform: rotate(0deg);
}

.collapse-icon {
  transform: rotate(0deg);
}

/* ==================== 展开模式样式 ==================== */
.plan-expanded {
  display: contents;
}

.plan-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
}

.plan-header:hover {
  opacity: 0.9;
}

.plan-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

.plan-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plan-icon {
  font-size: 16px;
}

.plan-title-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.progress-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.plan-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  padding-right: 4px;
}

/* 自定义滚动条 */
.plan-steps::-webkit-scrollbar {
  width: 4px;
}

.plan-steps::-webkit-scrollbar-track {
  background: transparent;
}

.plan-steps::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

.plan-steps::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}

.plan-step {
  display: flex;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border-radius: 8px;
  border-left: 3px solid transparent;
  transition: all 0.2s ease;
}

.plan-step.pending {
  opacity: 0.7;
}

.plan-step.in_progress {
  border-left-color: #3b82f6;
  background: rgba(59, 130, 246, 0.08);
}

.plan-step.completed {
  border-left-color: #10b981;
}

.plan-step.failed {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.05);
}

.plan-step.skipped {
  opacity: 0.5;
  border-left-color: var(--text-muted);
}

.step-indicator {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.step-number {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-radius: 50%;
}

.step-icon {
  font-size: 14px;
  font-weight: bold;
}

.step-icon.completed { color: #10b981; }
.step-icon.failed { color: #ef4444; }
.step-icon.skipped { color: var(--text-muted); }

.step-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(59, 130, 246, 0.2);
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.step-content {
  flex: 1;
  min-width: 0;
}

.step-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  line-height: 1.4;
}

.terminal-badge {
  color: var(--accent-primary);
  font-weight: 600;
  margin-right: 4px;
}

.step-description {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.step-result {
  font-size: 12px;
  margin-top: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.step-result.completed {
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
}

.step-result.failed {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.step-result.skipped {
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.03);
}

/* 步骤内的迷你进度条 */
.step-progress {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.mini-progress-bar {
  flex: 1;
  height: 4px;
  background: rgba(59, 130, 246, 0.2);
  border-radius: 2px;
  overflow: hidden;
}

.mini-progress-fill {
  height: 100%;
  background: #3b82f6;
  border-radius: 2px;
  transition: width 0.3s ease;
}

.mini-progress-fill.indeterminate {
  animation: indeterminate 1.5s ease-in-out infinite;
  background: linear-gradient(90deg, transparent, #3b82f6, transparent);
}

@keyframes indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.mini-progress-text {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
