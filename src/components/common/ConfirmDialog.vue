<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'

export interface ConfirmDialogOptions {
  title: string
  message: string
  detail?: string
  confirmText?: string
  cancelText?: string
  type?: 'default' | 'danger' | 'warning'
  showCancel?: boolean
  fileInfo?: {
    name?: string
    size?: string
    count?: number
    type?: string
  }
}

const props = withDefaults(defineProps<{
  show: boolean
  options: ConfirmDialogOptions
}>(), {
  show: false
})

const emit = defineEmits<{
  confirm: []
  cancel: []
  close: []
}>()

const dialogRef = ref<HTMLDivElement | null>(null)
const confirmBtnRef = ref<HTMLButtonElement | null>(null)

// 处理确认
const handleConfirm = () => {
  emit('confirm')
  emit('close')
}

// 处理取消
const handleCancel = () => {
  emit('cancel')
  emit('close')
}

// 键盘事件
const handleKeydown = (e: KeyboardEvent) => {
  if (!props.show) return
  
  if (e.key === 'Escape') {
    e.preventDefault()
    handleCancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    handleConfirm()
  }
}

// 聚焦到确认按钮
watch(() => props.show, async (show) => {
  if (show) {
    await nextTick()
    confirmBtnRef.value?.focus()
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

// 获取类型图标
const getIcon = () => {
  switch (props.options.type) {
    case 'danger':
      return 'danger'
    case 'warning':
      return 'warning'
    default:
      return 'info'
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="show" class="confirm-overlay" @click.self="handleCancel">
        <Transition name="scale">
          <div v-if="show" ref="dialogRef" class="confirm-dialog" :class="options.type || 'default'">
            <!-- 图标 -->
            <div class="dialog-icon" :class="getIcon()">
              <!-- 危险图标 -->
              <svg v-if="options.type === 'danger'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <!-- 警告图标 -->
              <svg v-else-if="options.type === 'warning'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <!-- 默认图标 -->
              <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>

            <!-- 标题 -->
            <h3 class="dialog-title">{{ options.title }}</h3>

            <!-- 消息 -->
            <p class="dialog-message">{{ options.message }}</p>

            <!-- 文件信息 -->
            <div v-if="options.fileInfo" class="file-info">
              <div v-if="options.fileInfo.name" class="file-info-item">
                <span class="label">名称</span>
                <span class="value" :title="options.fileInfo.name">{{ options.fileInfo.name }}</span>
              </div>
              <div v-if="options.fileInfo.type" class="file-info-item">
                <span class="label">类型</span>
                <span class="value">{{ options.fileInfo.type }}</span>
              </div>
              <div v-if="options.fileInfo.size" class="file-info-item">
                <span class="label">大小</span>
                <span class="value">{{ options.fileInfo.size }}</span>
              </div>
              <div v-if="options.fileInfo.count" class="file-info-item">
                <span class="label">数量</span>
                <span class="value">{{ options.fileInfo.count }} 个项目</span>
              </div>
            </div>

            <!-- 详细信息 -->
            <p v-if="options.detail" class="dialog-detail">{{ options.detail }}</p>

            <!-- 按钮 -->
            <div class="dialog-buttons">
              <button 
                v-if="options.showCancel !== false"
                class="btn btn-cancel" 
                @click="handleCancel"
              >
                {{ options.cancelText || '取消' }}
              </button>
              <button 
                ref="confirmBtnRef"
                class="btn btn-confirm" 
                :class="options.type || 'default'"
                @click="handleConfirm"
              >
                {{ options.confirmText || '确定' }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(2px);
}

.confirm-dialog {
  width: 380px;
  max-width: 90vw;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

/* 图标 */
.dialog-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 16px;
}

.dialog-icon.info {
  background: rgba(137, 180, 250, 0.15);
  color: var(--accent-primary);
}

.dialog-icon.warning {
  background: rgba(249, 226, 175, 0.15);
  color: var(--accent-warning);
}

.dialog-icon.danger {
  background: rgba(243, 139, 168, 0.15);
  color: var(--accent-error);
}

/* 标题 */
.dialog-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text-primary);
}

/* 消息 */
.dialog-message {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  line-height: 1.5;
}

/* 文件信息 */
.file-info {
  width: 100%;
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}

.file-info-item {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 13px;
}

.file-info-item .label {
  color: var(--text-muted);
}

.file-info-item .value {
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 详细信息 */
.dialog-detail {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 16px 0;
}

/* 按钮 */
.dialog-buttons {
  display: flex;
  gap: 12px;
  width: 100%;
}

.btn {
  flex: 1;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.btn-cancel {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-confirm {
  background: var(--accent-primary);
  color: white;
}

.btn-confirm:hover {
  filter: brightness(1.1);
}

.btn-confirm.danger {
  background: var(--accent-error);
}

.btn-confirm.warning {
  background: var(--accent-warning);
  color: var(--bg-primary);
}

/* 动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}

.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
