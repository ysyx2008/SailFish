<script setup lang="ts">
/**
 * Agent 任务计划展示组件
 * 显示任务执行进度和步骤状态
 */
import { computed } from 'vue'

// 步骤进度信息
interface StepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

// 计划步骤状态
type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

// 计划步骤
interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: PlanStepStatus
  result?: string
  progress?: StepProgress
}

// Agent 执行计划
interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  createdAt: number
  updatedAt: number
}

const props = defineProps<{
  plan: AgentPlan
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

// 当前执行中的步骤索引
const currentStepIndex = computed(() => 
  props.plan.steps.findIndex(s => s.status === 'in_progress')
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
    return progress.statusText || '执行中...'
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
</script>

<template>
  <div class="agent-plan" :class="{ 'is-completed': isAllCompleted, 'has-failed': hasFailed }">
    <!-- 计划头部 -->
    <div class="plan-header">
      <div class="plan-title">
        <span class="plan-icon">📋</span>
        <span class="plan-title-text">{{ plan.title }}</span>
      </div>
      <div class="plan-progress">
        <div class="progress-bar">
          <div 
            class="progress-fill" 
            :class="{ 'failed': hasFailed }"
            :style="{ width: progressPercent + '%' }"
          ></div>
        </div>
        <span class="progress-text">{{ completedCount }}/{{ plan.steps.length }}</span>
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
          <div class="step-title">{{ step.title }}</div>
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
</template>

<style scoped>
.agent-plan {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 14px 16px;
  margin: 8px 0;
}

.agent-plan.is-completed {
  border-color: rgba(16, 185, 129, 0.3);
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.05), transparent);
}

.agent-plan.has-failed {
  border-color: rgba(239, 68, 68, 0.3);
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.05), transparent);
}

.plan-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border-color);
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

.plan-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-bar {
  width: 80px;
  height: 6px;
  background: var(--bg-surface);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #10b981, #34d399);
  border-radius: 3px;
  transition: width 0.4s ease;
}

.progress-fill.failed {
  background: linear-gradient(90deg, #f87171, #ef4444);
}

.progress-text {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
}

.plan-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  min-width: 60px;
}
</style>

