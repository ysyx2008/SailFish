<script setup lang="ts">
import { ref, watch, onMounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '../stores/terminal'

const { t } = useI18n()
const terminalStore = useTerminalStore()

// 拖拽状态
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// 新建终端下拉菜单
const showNewMenu = ref(false)
const menuPosition = ref({ top: '0px', left: '0px' })

// 滚动相关
const tabsContainerRef = ref<HTMLElement | null>(null)
const canScrollLeft = ref(false)
const canScrollRight = ref(false)

// Shell 选项（动态检测系统可用的 shell）
const shellOptions = ref<Array<{ label: string; value: string; icon: string }>>([])

// 加载可用的 shell 列表
const loadAvailableShells = async () => {
  try {
    const shells = await window.electronAPI.pty.getAvailableShells()
    shellOptions.value = shells
  } catch (e) {
    console.error('Failed to load available shells:', e)
    // 降级：使用默认列表
    const isWindows = navigator.platform.toLowerCase().includes('win')
    if (isWindows) {
      shellOptions.value = [
        { label: 'PowerShell', value: 'powershell.exe', icon: '⚡' },
        { label: 'CMD', value: 'cmd.exe', icon: '📟' }
      ]
    } else {
      shellOptions.value = [
        { label: 'Bash', value: '/bin/bash', icon: '🐚' },
        { label: 'Zsh', value: '/bin/zsh', icon: '🔮' }
      ]
    }
  }
}

// 检查滚动状态
const checkScrollState = () => {
  const container = tabsContainerRef.value
  if (!container) return
  
  canScrollLeft.value = container.scrollLeft > 0
  canScrollRight.value = container.scrollLeft < container.scrollWidth - container.clientWidth - 1
}

// 滚动到指定方向
const scroll = (direction: 'left' | 'right') => {
  const container = tabsContainerRef.value
  if (!container) return
  
  const scrollAmount = 200
  container.scrollBy({
    left: direction === 'left' ? -scrollAmount : scrollAmount,
    behavior: 'smooth'
  })
}

// 滚动到当前激活的 tab
const scrollToActiveTab = () => {
  nextTick(() => {
    const container = tabsContainerRef.value
    if (!container) return
    
    const activeTab = container.querySelector('.tab.active') as HTMLElement
    if (!activeTab) return
    
    const containerRect = container.getBoundingClientRect()
    const tabRect = activeTab.getBoundingClientRect()
    
    // 如果 tab 不在可见范围内，滚动到可见
    if (tabRect.left < containerRect.left) {
      container.scrollBy({
        left: tabRect.left - containerRect.left - 10,
        behavior: 'smooth'
      })
    } else if (tabRect.right > containerRect.right) {
      container.scrollBy({
        left: tabRect.right - containerRect.right + 10,
        behavior: 'smooth'
      })
    }
  })
}

// 监听 tab 变化和激活状态变化
watch(() => terminalStore.tabs.length, () => {
  nextTick(checkScrollState)
})

watch(() => terminalStore.activeTabId, () => {
  scrollToActiveTab()
})

onMounted(() => {
  checkScrollState()
  // 监听滚动事件
  tabsContainerRef.value?.addEventListener('scroll', checkScrollState)
  // 监听窗口大小变化
  window.addEventListener('resize', checkScrollState)
  // 加载可用的 shell 列表
  loadAvailableShells()
})

const handleNewTab = (shell?: string) => {
  terminalStore.createTab('local', undefined, shell)
  showNewMenu.value = false
}

const toggleNewMenu = (event: MouseEvent) => {
  if (!showNewMenu.value) {
    // 计算菜单位置
    const button = event.currentTarget as HTMLElement
    const rect = button.getBoundingClientRect()
    menuPosition.value = {
      top: `${rect.bottom + 4}px`,
      left: `${rect.right - 150}px`  // 150 是菜单宽度
    }
  }
  showNewMenu.value = !showNewMenu.value
}

const hideNewMenu = () => {
  showNewMenu.value = false
}

const handleCloseTab = (tabId: string, event: MouseEvent) => {
  event.stopPropagation()
  terminalStore.closeTab(tabId)
}

// 拖拽开始
const handleDragStart = (index: number, event: DragEvent) => {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', index.toString())
  }
}

// 拖拽经过
const handleDragOver = (index: number, event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragOverIndex.value = index
}

// 拖拽离开
const handleDragLeave = () => {
  dragOverIndex.value = null
}

// 放置
const handleDrop = (toIndex: number, event: DragEvent) => {
  event.preventDefault()
  if (dragIndex.value !== null && dragIndex.value !== toIndex) {
    terminalStore.reorderTabs(dragIndex.value, toIndex)
  }
  dragIndex.value = null
  dragOverIndex.value = null
}

// 拖拽结束
const handleDragEnd = () => {
  dragIndex.value = null
  dragOverIndex.value = null
}
</script>

<template>
  <div class="tab-bar">
    <!-- 左滚动按钮 -->
    <button 
      v-show="canScrollLeft" 
      class="scroll-btn scroll-left" 
      @click="scroll('left')"
      :title="t('tabs.scrollLeft')"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
    </button>
    
    <div ref="tabsContainerRef" class="tabs-container" @scroll="checkScrollState">
      <div
        v-for="(tab, index) in terminalStore.tabs"
        :key="tab.id"
        class="tab"
        :class="{ 
          active: tab.id === terminalStore.activeTabId,
          dragging: dragIndex === index,
          'drag-over': dragOverIndex === index && dragIndex !== index,
          'needs-attention': tab.id !== terminalStore.activeTabId && terminalStore.hasPendingConfirm(tab.id)
        }"
        draggable="true"
        @click="terminalStore.setActiveTab(tab.id)"
        @dragstart="handleDragStart(index, $event)"
        @dragover="handleDragOver(index, $event)"
        @dragleave="handleDragLeave"
        @drop="handleDrop(index, $event)"
        @dragend="handleDragEnd"
      >
        <span class="tab-icon">
          <svg v-if="tab.type === 'local'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 17 10 11 4 5"/>
            <line x1="12" y1="19" x2="20" y2="19"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
        </span>
        <span class="tab-title">{{ tab.title }}</span>
        <span v-if="tab.isLoading" class="tab-loading">
          <svg class="spinner" width="12" height="12" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" fill="none" stroke-dasharray="60" stroke-linecap="round"/>
          </svg>
        </span>
        <button
          v-else
          class="tab-close"
          @click="handleCloseTab(tab.id, $event)"
          :title="t('tabs.closeTab')"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
    
    <!-- 右滚动按钮 -->
    <button 
      v-show="canScrollRight" 
      class="scroll-btn scroll-right" 
      @click="scroll('right')"
      :title="t('tabs.scrollRight')"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
    
    <!-- 新建终端按钮（带下拉菜单） -->
    <div class="new-tab-wrapper">
      <button class="btn-new-tab" @click="handleNewTab()" :title="t('tabs.newTab')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
      <button class="btn-new-tab-dropdown" @click="toggleNewMenu" :title="t('tabs.selectShell')">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      
    </div>
    
    <!-- Shell 选择菜单（使用 Teleport 避免 overflow 裁剪） -->
    <Teleport to="body">
      <div v-if="showNewMenu" class="shell-menu-overlay" @click="hideNewMenu"></div>
      <div v-if="showNewMenu" class="shell-menu" :style="menuPosition">
        <div 
          v-for="option in shellOptions" 
          :key="option.value"
          class="shell-menu-item"
          @click="handleNewTab(option.value)"
        >
          <span class="shell-icon">{{ option.icon }}</span>
          <span>{{ option.label }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  overflow: hidden;
}

.scroll-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 28px;
  padding: 0;
  background: var(--bg-tertiary);
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.scroll-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.scroll-left {
  border-radius: 4px 0 0 4px;
}

.scroll-right {
  border-radius: 0 4px 4px 0;
}

.tabs-container {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  min-width: 0;
}

.tabs-container::-webkit-scrollbar {
  display: none;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  min-width: 120px;
  max-width: 180px;
  background: var(--bg-tertiary);
  border-radius: 8px 8px 0 0;
  cursor: grab;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}

/* Tab 底部渐变指示线 */
.tab::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 50%;
  width: 0;
  height: 2px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  transition: all 0.25s ease;
  transform: translateX(-50%);
  border-radius: 1px;
}

.tab:hover {
  background: var(--bg-surface);
}

.tab:hover::after {
  width: 50%;
}

.tab.active {
  background: var(--bg-primary);
  box-shadow: 
    0 -4px 15px rgba(var(--accent-rgb, 137, 180, 250), 0.15),
    inset 0 1px 0 rgba(255, 255, 255, 0.05);
  position: relative;
}

.tab.active::after {
  width: 100%;
  height: 3px;
  background: linear-gradient(90deg, var(--accent-primary), var(--accent-secondary));
  box-shadow: 0 0 10px var(--accent-primary);
}

.tab.active::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.3), transparent);
}

.tab.dragging {
  opacity: 0.5;
  cursor: grabbing;
}

.tab.drag-over {
  border-left: 2px solid var(--accent-primary);
  margin-left: -2px;
}

/* 需要注意的状态（有待确认操作） */
.tab.needs-attention {
  animation: tab-attention-pulse 1.5s ease-in-out infinite;
  border-color: var(--warning-color, #f59e0b);
  background: rgba(245, 158, 11, 0.15);
}

.tab.needs-attention .tab-title {
  color: var(--warning-color, #f59e0b);
}

.tab.needs-attention .tab-icon {
  color: var(--warning-color, #f59e0b);
}

@keyframes tab-attention-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(245, 158, 11, 0);
  }
}

.tab-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  transition: all 0.25s ease;
}

.tab:hover .tab-icon {
  color: var(--text-secondary);
}

.tab.active .tab-icon {
  color: var(--accent-primary);
  filter: drop-shadow(0 0 4px var(--accent-primary));
}

.tab-title {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.2s ease;
}

.tab:hover .tab-title {
  color: var(--text-primary);
}

.tab.active .tab-title {
  color: var(--text-primary);
  font-weight: 600;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transform: scale(0.8);
}

.tab:hover .tab-close {
  opacity: 1;
  transform: scale(1);
}

.tab-close:hover {
  background: rgba(var(--accent-error-rgb, 243, 139, 168), 0.2);
  color: var(--accent-error);
  transform: scale(1.1);
}

.tab-close:active {
  transform: scale(0.9);
}

.tab-loading {
  display: flex;
  align-items: center;
  color: var(--accent-primary);
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.new-tab-wrapper {
  position: relative;
  display: flex;
  flex-shrink: 0;
  margin-left: 4px;
}

.btn-new-tab {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 8px 0 0 8px;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  overflow: hidden;
}

/* 新建按钮悬停光效 */
.btn-new-tab::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  transition: opacity 0.25s ease;
}

.btn-new-tab:hover::before {
  opacity: 0.15;
}

.btn-new-tab:hover {
  background: var(--bg-surface);
  color: var(--accent-primary);
  transform: scale(1.05);
}

.btn-new-tab:hover svg {
  filter: drop-shadow(0 0 4px var(--accent-primary));
}

.btn-new-tab:active {
  transform: scale(0.95);
}

.btn-new-tab-dropdown {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-left: 1px solid var(--border-color);
  border-radius: 0 8px 8px 0;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.btn-new-tab-dropdown:hover {
  background: var(--bg-surface);
  color: var(--accent-primary);
}

.btn-new-tab-dropdown:active {
  transform: scale(0.95);
}

.shell-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
}

.shell-menu {
  position: fixed;
  min-width: 150px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 1001;
  overflow: hidden;
}

.shell-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.15s;
}

.shell-menu-item:hover {
  background: var(--bg-hover);
}

.shell-icon {
  font-size: 14px;
}
</style>
