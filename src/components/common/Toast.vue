<script setup lang="ts">
import { CheckCircle, XCircle, AlertTriangle, Info, X, Heart } from 'lucide-vue-next'
import { useToast, type Toast } from '../../composables/useToast'

const { toasts, close } = useToast()

const getIcon = (type: Toast['type']) => {
  switch (type) {
    case 'success': return 'success'
    case 'error': return 'error'
    case 'warning': return 'warning'
    case 'proactive': return 'proactive'
    default: return 'info'
  }
}

function handleClick(toast: Toast) {
  if (toast.onClick) {
    toast.onClick()
    close(toast.id)
  }
}

function handleAction(e: Event, toast: Toast) {
  e.stopPropagation()
  if (toast.onClick) {
    toast.onClick()
    close(toast.id)
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-container">
      <TransitionGroup name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          class="toast-item"
          :class="[t.type, { clickable: !!t.onClick, 'has-progress': t.progress, 'has-detail': !!t.detail }]"
          @click="handleClick(t)"
        >
          <span class="toast-icon" :class="getIcon(t.type)">
            <CheckCircle v-if="t.type === 'success'" :size="18" />
            <XCircle v-else-if="t.type === 'error'" :size="18" />
            <AlertTriangle v-else-if="t.type === 'warning'" :size="18" />
            <Heart v-else-if="t.type === 'proactive'" :size="18" />
            <Info v-else :size="18" />
          </span>

          <span class="toast-copy">
            <span class="toast-message">{{ t.message }}</span>
            <span v-if="t.detail" class="toast-detail">{{ t.detail }}</span>
          </span>

          <button
            v-if="t.action && t.onClick"
            class="toast-action"
            @click="handleAction($event, t)"
          >
            {{ t.action }}
          </button>

          <button
            v-if="t.closable"
            class="toast-close"
            @click.stop="close(t.id)"
          >
            <X :size="14" />
          </button>
          <span v-if="t.progress" class="toast-progress" aria-hidden="true"><span /></span>
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
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  overflow: hidden;
  background: var(--bg-secondary);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  border-left: 3px solid var(--accent-primary);
  pointer-events: auto;
  max-width: 400px;
}

.toast-item.clickable {
  cursor: pointer;
  transition: background 0.2s;
}
.toast-item.clickable:hover {
  background: var(--bg-hover);
}

.toast-item.success { border-left-color: var(--accent-success); }
.toast-item.error { border-left-color: var(--accent-error); }
.toast-item.warning { border-left-color: var(--accent-warning); }
.toast-item.info { border-left-color: var(--accent-primary); }
.toast-item.proactive { border-left-color: var(--accent-primary); }
.toast-item.has-progress { padding-bottom: 16px; }
.toast-item.has-detail { align-items: flex-start; }

.toast-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: color-mix(in srgb, var(--accent-primary) 18%, transparent);
}
.toast-progress > span {
  display: block;
  height: 100%;
  width: 35%;
  background: var(--accent-primary);
  animation: toast-progress 1.1s ease-in-out infinite;
}
@keyframes toast-progress {
  0% { transform: translateX(-120%); }
  100% { transform: translateX(320%); }
}

.toast-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.toast-icon.success { color: var(--accent-success); }
.toast-icon.error { color: var(--accent-error); }
.toast-icon.warning { color: var(--accent-warning); }
.toast-icon.info { color: var(--accent-primary); }
.toast-icon.proactive { color: var(--accent-primary); }

.toast-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.toast-message {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.toast-detail {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
  white-space: pre-wrap;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.toast-action {
  display: flex;
  align-items: center;
  padding: 4px 10px;
  border: none;
  background: var(--accent-primary);
  color: #fff;
  cursor: pointer;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  flex-shrink: 0;
  transition: opacity 0.2s;
}
.toast-action:hover { opacity: 0.85; }

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
