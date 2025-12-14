<script setup lang="ts">
/**
 * 钢铁军团底部状态栏
 * 当钢铁军团最小化时显示任务进度
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const props = defineProps<{
  isRunning: boolean
  taskTitle: string
  progress: number
  completedCount: number
  totalSteps: number
}>()

const emit = defineEmits<{
  expand: []
  stop: []
}>()

// 进度条颜色
const progressColor = computed(() => {
  if (props.progress >= 100) return '#10b981' // 完成-绿色
  if (props.progress > 0) return '#3b82f6' // 进行中-蓝色
  return '#6b7280' // 未开始-灰色
})

// 状态文本
const statusText = computed(() => {
  if (!props.isRunning && props.progress === 0) {
    return t('legion.statusIdle')
  }
  if (props.progress >= 100) {
    return t('legion.statusCompleted')
  }
  return `${props.completedCount}/${props.totalSteps}`
})
</script>

<template>
  <div class="legion-status-bar" @click="emit('expand')">
    <div class="status-left">
      <span class="status-icon">🤖</span>
      <span class="status-label">{{ t('welcome.ironLegion') }}</span>
      <span class="status-divider">|</span>
      <span class="task-title">{{ taskTitle || t('legion.noActiveTask') }}</span>
    </div>
    
    <div class="status-center">
      <div class="progress-container">
        <div 
          class="progress-bar" 
          :style="{ width: progress + '%', backgroundColor: progressColor }"
        ></div>
      </div>
      <span class="progress-text">{{ statusText }}</span>
    </div>
    
    <div class="status-right">
      <button 
        v-if="isRunning" 
        class="btn-stop" 
        @click.stop="emit('stop')"
        :title="t('legion.stopExecution')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="6" y="6" width="12" height="12"/>
        </svg>
      </button>
      <button class="btn-expand" :title="t('legion.expandPanel')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 15l-6-6-6 6"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.legion-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 32px;
  padding: 0 12px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  cursor: pointer;
  transition: background 0.15s ease;
}

.legion-status-bar:hover {
  background: var(--bg-tertiary);
}

.status-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-shrink: 0;
}

.status-icon {
  font-size: 14px;
}

.status-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.status-divider {
  color: var(--border-color);
}

.task-title {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.status-center {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  max-width: 300px;
  margin: 0 24px;
}

.progress-container {
  flex: 1;
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s ease, background-color 0.3s ease;
}

.progress-text {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  min-width: 40px;
  text-align: right;
}

.status-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-stop {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(239, 68, 68, 0.1);
  border: none;
  border-radius: 4px;
  color: #ef4444;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-stop:hover {
  background: rgba(239, 68, 68, 0.2);
}

.btn-expand {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-expand:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>
