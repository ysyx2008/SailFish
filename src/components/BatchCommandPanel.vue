<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Terminal, Monitor, Check, Send, Layers } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'

const { t } = useI18n()
const terminalStore = useTerminalStore()

// 是否显示面板
const isOpen = ref(false)
// 命令输入
const command = ref('')
// 选中的终端 ID 列表
const selectedTabIds = ref<string[]>([])
// 是否发送回车
const sendEnter = ref(true)
// 输入框引用
const inputRef = ref<HTMLInputElement | null>(null)

// 可用的终端列表（已连接的）
const availableTabs = computed(() => {
  return terminalStore.tabs.filter(tab => tab.isConnected && tab.ptyId)
})

// 是否全选
const isAllSelected = computed(() => {
  return availableTabs.value.length > 0 && 
    selectedTabIds.value.length === availableTabs.value.length
})

// 切换终端选中状态
const toggleTab = (tabId: string) => {
  const index = selectedTabIds.value.indexOf(tabId)
  if (index === -1) {
    selectedTabIds.value.push(tabId)
  } else {
    selectedTabIds.value.splice(index, 1)
  }
}

// 全选/取消全选
const toggleSelectAll = () => {
  if (isAllSelected.value) {
    selectedTabIds.value = []
  } else {
    selectedTabIds.value = availableTabs.value.map(tab => tab.id)
  }
}

// 发送命令到所有选中的终端
const sendCommand = async () => {
  if (!command.value.trim() || selectedTabIds.value.length === 0) return
  
  const cmdToSend = sendEnter.value ? command.value + '\r' : command.value
  
  // 并行发送到所有选中的终端
  const promises = selectedTabIds.value.map(tabId => 
    terminalStore.writeToTerminal(tabId, cmdToSend)
  )
  
  await Promise.all(promises)
  
  // 清空命令输入
  command.value = ''
}

// 打开面板
const open = () => {
  isOpen.value = true
  // 默认选中所有终端
  selectedTabIds.value = availableTabs.value.map(tab => tab.id)
  // 聚焦输入框
  setTimeout(() => {
    inputRef.value?.focus()
  }, 100)
}

// 关闭面板
const close = () => {
  isOpen.value = false
  command.value = ''
}

// 处理键盘事件
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    close()
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendCommand()
  }
}

// 监听快捷键打开面板
const handleGlobalKeydown = (e: KeyboardEvent) => {
  // Ctrl/Cmd + Shift + B 打开批量操作面板
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
    e.preventDefault()
    if (isOpen.value) {
      close()
    } else {
      open()
    }
  }
}

// 监听菜单命令触发的自定义事件
const handleToggleBatchPanel = () => {
  if (isOpen.value) {
    close()
  } else {
    open()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('toggle-batch-panel', handleToggleBatchPanel)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('toggle-batch-panel', handleToggleBatchPanel)
})

// 暴露给父组件
defineExpose({
  open,
  close,
  isOpen
})
</script>

<template>
  <!-- 遮罩层 -->
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="isOpen" class="batch-overlay" @click="close"></div>
    </Transition>
    
    <!-- 批量命令面板 -->
    <Transition name="slide-up">
      <div v-if="isOpen" class="batch-panel">
        <div class="batch-header">
          <div class="batch-title">
            <Layers :size="18" />
            <span>{{ t('batch.title') }}</span>
          </div>
          <button class="close-btn" @click="close" :title="t('common.close')">
            <X :size="16" />
          </button>
        </div>
        
        <div class="batch-content">
          <!-- 终端选择 -->
          <div class="terminal-selection">
            <div class="selection-header">
              <span class="selection-label">{{ t('batch.selectTerminals') }}</span>
              <button class="select-all-btn" @click="toggleSelectAll">
                <span v-if="isAllSelected">{{ t('common.unselectAll') }}</span>
                <span v-else>{{ t('common.selectAll') }}</span>
              </button>
            </div>
            
            <div v-if="availableTabs.length === 0" class="no-terminals">
              {{ t('batch.noActiveTerminals') }}
            </div>
            
            <div v-else class="terminal-list">
              <div 
                v-for="tab in availableTabs" 
                :key="tab.id"
                class="terminal-item"
                :class="{ selected: selectedTabIds.includes(tab.id) }"
                @click="toggleTab(tab.id)"
              >
                <div class="terminal-checkbox">
                  <Check v-if="selectedTabIds.includes(tab.id)" :size="14" />
                </div>
                <span class="terminal-icon">
                  <Terminal v-if="tab.type === 'local'" :size="14" />
                  <Monitor v-else :size="14" />
                </span>
                <span class="terminal-name">{{ tab.title }}</span>
              </div>
            </div>
          </div>
          
          <!-- 命令输入 -->
          <div class="command-input-section">
            <label class="input-label">{{ t('batch.commandInput') }}</label>
            <div class="input-wrapper">
              <input
                ref="inputRef"
                v-model="command"
                type="text"
                class="command-input"
                :placeholder="t('batch.commandPlaceholder')"
                @keydown="handleKeydown"
              />
              <button 
                class="send-btn" 
                :disabled="!command.trim() || selectedTabIds.length === 0"
                @click="sendCommand"
                :title="t('batch.send')"
              >
                <Send :size="16" />
              </button>
            </div>
            
            <div class="input-options">
              <label class="checkbox-label">
                <input type="checkbox" v-model="sendEnter" />
                <span>{{ t('batch.sendEnter') }}</span>
              </label>
              <span class="selected-count">
                {{ t('batch.selectedCount', { count: selectedTabIds.length }) }}
              </span>
            </div>
          </div>
        </div>
        
        <div class="batch-footer">
          <span class="shortcut-hint">{{ t('batch.shortcutHint') }}</span>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.batch-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
}

.batch-panel {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  border-radius: 12px 12px 0 0;
  z-index: 1001;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
}

.batch-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 12px 12px 0 0;
}

.batch-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.batch-title svg {
  color: var(--accent-primary);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.batch-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.terminal-selection {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.selection-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.selection-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.select-all-btn {
  padding: 4px 10px;
  font-size: 12px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.select-all-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.no-terminals {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.terminal-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.terminal-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.terminal-item:hover {
  border-color: var(--accent-primary);
  background: var(--bg-surface);
}

.terminal-item.selected {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.15);
}

.terminal-checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  transition: all 0.2s ease;
}

.terminal-item.selected .terminal-checkbox {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.terminal-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
}

.terminal-item.selected .terminal-icon {
  color: var(--accent-primary);
}

.terminal-name {
  font-size: 13px;
  color: var(--text-primary);
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-input-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.input-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.input-wrapper {
  display: flex;
  gap: 8px;
}

.command-input {
  flex: 1;
  padding: 12px 16px;
  font-size: 14px;
  font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  outline: none;
  transition: all 0.2s ease;
}

.command-input:focus {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(var(--accent-rgb, 137, 180, 250), 0.2);
}

.command-input::placeholder {
  color: var(--text-muted);
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  padding: 0;
  background: var(--accent-primary);
  border: none;
  border-radius: 8px;
  color: white;
  cursor: pointer;
  transition: all 0.2s ease;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-secondary);
  transform: scale(1.05);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.input-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 16px;
  height: 16px;
  accent-color: var(--accent-primary);
}

.selected-count {
  font-size: 12px;
  color: var(--text-muted);
}

.batch-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.shortcut-hint {
  font-size: 12px;
  color: var(--text-muted);
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

.slide-up-enter-active,
.slide-up-leave-active {
  transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>

