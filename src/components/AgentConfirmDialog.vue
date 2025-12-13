<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'
import type { PendingConfirmation } from '../stores/terminal'

const props = defineProps<{
  confirmation: PendingConfirmation
}>()

const emit = defineEmits<{
  confirm: [approved: boolean]
}>()

// 确认按钮引用
const confirmBtnRef = ref<HTMLButtonElement | null>(null)

// ESC 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    handleReject()
  }
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown)
  // 自动聚焦到确认按钮
  await nextTick()
  confirmBtnRef.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

// 获取风险等级的显示文本
const riskText = computed(() => {
  switch (props.confirmation.riskLevel) {
    case 'dangerous': return '高风险操作'
    case 'moderate': return '中风险操作'
    case 'safe': return '安全操作'
    case 'blocked': return '被阻止'
    default: return '未知风险'
  }
})

// 获取风险等级的颜色类
const riskClass = computed(() => {
  return `risk-${props.confirmation.riskLevel}`
})

// 获取工具的显示名称
const toolDisplayName = computed(() => {
  const names: Record<string, string> = {
    execute_command: '执行命令',
    read_file: '读取文件',
    write_file: '写入文件',
    get_terminal_context: '获取终端上下文'
  }
  return names[props.confirmation.toolName] || props.confirmation.toolName
})

// 格式化参数显示
const formattedArgs = computed(() => {
  const args = props.confirmation.toolArgs
  if (args.command) {
    return args.command as string
  }
  if (args.path) {
    return `路径: ${args.path}`
  }
  return JSON.stringify(args, null, 2)
})

// 确认
const handleConfirm = () => {
  emit('confirm', true)
}

// 拒绝
const handleReject = () => {
  emit('confirm', false)
}
</script>

<template>
  <div class="agent-confirm-dialog">
    <div class="confirm-overlay" @click="handleReject"></div>
    <div class="confirm-modal">
      <div class="confirm-header">
        <div class="confirm-icon">⚠️</div>
        <div class="confirm-title">Agent 请求确认</div>
        <div class="confirm-risk" :class="riskClass">{{ riskText }}</div>
      </div>
      
      <div class="confirm-body">
        <div class="confirm-tool">
          <span class="tool-label">操作:</span>
          <span class="tool-name">{{ toolDisplayName }}</span>
        </div>
        
        <div class="confirm-args">
          <div class="args-label">详情:</div>
          <pre class="args-content">{{ formattedArgs }}</pre>
        </div>
        
        <div v-if="confirmation.riskLevel === 'dangerous'" class="confirm-warning">
          <span class="warning-icon">⚠️</span>
          <span>这是一个危险操作，请仔细确认后再执行</span>
        </div>
      </div>
      
      <div class="confirm-footer">
        <button class="btn btn-secondary" @click="handleReject">
          取消
        </button>
        <button 
          ref="confirmBtnRef"
          class="btn" 
          :class="confirmation.riskLevel === 'dangerous' ? 'btn-danger' : 'btn-primary'"
          @click="handleConfirm"
        >
          {{ confirmation.riskLevel === 'dangerous' ? '确认执行' : '允许' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-confirm-dialog {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.confirm-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
}

.confirm-modal {
  position: relative;
  width: 400px;
  max-width: 90%;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.confirm-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.confirm-icon {
  font-size: 24px;
}

.confirm-title {
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.confirm-risk {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 600;
  border-radius: 12px;
}

.confirm-risk.risk-safe {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.confirm-risk.risk-moderate {
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.confirm-risk.risk-dangerous {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.confirm-risk.risk-blocked {
  background: rgba(107, 114, 128, 0.15);
  color: #6b7280;
}

.confirm-body {
  padding: 16px;
}

.confirm-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.tool-label {
  font-size: 12px;
  color: var(--text-muted);
}

.tool-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent-primary);
}

.confirm-args {
  margin-bottom: 12px;
}

.args-label {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.args-content {
  margin: 0;
  padding: 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
}

.confirm-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: 12px;
  color: #ef4444;
}

.warning-icon {
  font-size: 14px;
}

.confirm-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.btn {
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-secondary {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.btn-secondary:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-primary {
  background: var(--accent-primary);
  border: 1px solid var(--accent-primary);
  color: #fff;
}

.btn-primary:hover {
  filter: brightness(1.1);
}

.btn-danger {
  background: #ef4444;
  border: 1px solid #ef4444;
  color: #fff;
}

.btn-danger:hover {
  background: #dc2626;
  border-color: #dc2626;
}
</style>

