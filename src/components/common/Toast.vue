<script setup lang="ts">
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-vue-next'
import { useToast, type Toast } from '../../composables/useToast'

const { toasts, close } = useToast()

// 获取图标
const getIcon = (type: Toast['type']) => {
  switch (type) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    default:
      return 'info'
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast-item"
          :class="toast.type"
        >
          <!-- 图标 -->
          <span class="toast-icon" :class="getIcon(toast.type)">
            <CheckCircle v-if="toast.type === 'success'" :size="18" />
            <XCircle v-else-if="toast.type === 'error'" :size="18" />
            <AlertTriangle v-else-if="toast.type === 'warning'" :size="18" />
            <Info v-else :size="18" />
          </span>

          <!-- 消息 -->
          <span class="toast-message">{{ toast.message }}</span>

          <!-- 关闭按钮 -->
          <button
            v-if="toast.closable"
            class="toast-close"
            @click="close(toast.id)"
          >
            <X :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 10001;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none;
}

.toast-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: var(--bg-secondary);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  border-left: 3px solid var(--accent-primary);
  pointer-events: auto;
  max-width: 400px;
}

.toast-item.success {
  border-left-color: var(--accent-success);
}

.toast-item.error {
  border-left-color: var(--accent-error);
}

.toast-item.warning {
  border-left-color: var(--accent-warning);
}

.toast-item.info {
  border-left-color: var(--accent-primary);
}

/* 图标 */
.toast-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.toast-icon.success {
  color: var(--accent-success);
}

.toast-icon.error {
  color: var(--accent-error);
}

.toast-icon.warning {
  color: var(--accent-warning);
}

.toast-icon.info {
  color: var(--accent-primary);
}

/* 消息 */
.toast-message {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
}

/* 关闭按钮 */
.toast-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.2s;
  flex-shrink: 0;
}

.toast-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 动画 */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(100%);
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(100%);
}

.toast-move {
  transition: transform 0.3s ease;
}
</style>
