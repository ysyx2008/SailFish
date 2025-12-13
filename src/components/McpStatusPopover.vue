<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

// 类型定义
interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse'
  command?: string
  url?: string
}

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
}

// Emits
const emit = defineEmits<{
  openSettings: []
}>()

// 状态
const servers = ref<McpServerConfig[]>([])
const serverStatuses = ref<McpServerStatus[]>([])
const showPopover = ref(false)
const connecting = ref<string | null>(null)
const popoverRef = ref<HTMLElement | null>(null)
const buttonRef = ref<HTMLElement | null>(null)

// 计算属性：启用的服务器
const enabledServers = computed(() => servers.value.filter(s => s.enabled))

// 计算属性：已连接的服务器数量
const connectedCount = computed(() => serverStatuses.value.length)

// 计算属性：启用的服务器数量
const enabledCount = computed(() => enabledServers.value.length)

// 计算属性：状态类型
const statusType = computed(() => {
  if (enabledCount.value === 0) {
    return 'none' // 无启用的服务器
  }
  if (connectedCount.value === 0) {
    return 'offline' // 全部离线
  }
  if (connectedCount.value >= enabledCount.value) {
    return 'all' // 全部连接
  }
  return 'partial' // 部分连接
})

// 计算属性：状态颜色类
const statusClass = computed(() => {
  switch (statusType.value) {
    case 'all': return 'status-all'
    case 'partial': return 'status-partial'
    case 'offline': return 'status-offline'
    default: return 'status-none'
  }
})

// 计算属性：状态图标
const statusIcon = computed(() => {
  switch (statusType.value) {
    case 'all': return '●'
    case 'partial': return '◐'
    default: return '○'
  }
})

// 计算属性：状态提示文字
const statusTooltip = computed(() => {
  if (enabledCount.value === 0) {
    return '未配置 MCP 服务器'
  }
  if (connectedCount.value === enabledCount.value) {
    return `MCP: 全部 ${connectedCount.value} 个服务器已连接`
  }
  if (connectedCount.value === 0) {
    return `MCP: ${enabledCount.value} 个服务器未连接`
  }
  return `MCP: ${connectedCount.value}/${enabledCount.value} 个服务器已连接`
})

// 获取服务器状态
const getServerStatus = (serverId: string): McpServerStatus | undefined => {
  return serverStatuses.value.find(s => s.id === serverId)
}

// 加载数据
const loadData = async () => {
  servers.value = await window.electronAPI.mcp.getServers()
  serverStatuses.value = await window.electronAPI.mcp.getServerStatuses()
}

// 切换弹窗
const togglePopover = () => {
  showPopover.value = !showPopover.value
}

// 关闭弹窗
const closePopover = () => {
  showPopover.value = false
}

// 点击外部关闭
const handleClickOutside = (e: MouseEvent) => {
  if (!showPopover.value) return
  const target = e.target as Node
  if (popoverRef.value && !popoverRef.value.contains(target) &&
      buttonRef.value && !buttonRef.value.contains(target)) {
    closePopover()
  }
}

// ESC 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPopover.value) {
    closePopover()
  }
}

// 连接服务器
const connectServer = async (server: McpServerConfig) => {
  connecting.value = server.id
  try {
    const plainServer = JSON.parse(JSON.stringify(server))
    await window.electronAPI.mcp.connect(plainServer)
  } catch (error) {
    console.error('连接失败:', error)
  } finally {
    connecting.value = null
    await loadData()
  }
}

// 断开服务器
const disconnectServer = async (server: McpServerConfig) => {
  await window.electronAPI.mcp.disconnect(server.id)
  await loadData()
}

// 连接所有启用的服务器
const connectAll = async () => {
  const results = await window.electronAPI.mcp.connectEnabledServers()
  const failed = results.filter(r => !r.success)
  if (failed.length > 0) {
    console.warn('部分服务器连接失败:', failed)
  }
  await loadData()
}

// 打开设置
const openSettings = () => {
  closePopover()
  emit('openSettings')
}

// 事件监听清理
let unsubConnected: (() => void) | null = null
let unsubDisconnected: (() => void) | null = null
let unsubError: (() => void) | null = null

onMounted(async () => {
  await loadData()
  
  // 监听 MCP 事件
  unsubConnected = window.electronAPI.mcp.onConnected(async () => {
    await loadData()
  })
  
  unsubDisconnected = window.electronAPI.mcp.onDisconnected(async () => {
    await loadData()
  })
  
  unsubError = window.electronAPI.mcp.onError(async () => {
    await loadData()
  })
  
  // 点击外部关闭
  document.addEventListener('click', handleClickOutside)
  // ESC 关闭
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  unsubConnected?.()
  unsubDisconnected?.()
  unsubError?.()
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="mcp-status-wrapper">
    <!-- 状态按钮 -->
    <button 
      ref="buttonRef"
      class="btn-icon mcp-status-btn" 
      :class="statusClass"
      :title="statusTooltip"
      @click="togglePopover"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        <circle cx="12" cy="12" r="4"/>
      </svg>
      <!-- 状态徽章 -->
      <span class="status-badge" :class="statusClass">
        <span class="status-dot">{{ statusIcon }}</span>
        <span v-if="enabledCount > 0" class="status-count">{{ connectedCount }}/{{ enabledCount }}</span>
        <span v-else class="status-count">-</span>
      </span>
    </button>

    <!-- 弹出面板 -->
    <Teleport to="body">
      <div v-if="showPopover" ref="popoverRef" class="mcp-popover">
        <div class="popover-header">
          <span class="popover-title">MCP 服务器</span>
          <button 
            v-if="enabledServers.length > 0 && connectedCount < enabledCount"
            class="btn-connect-all"
            @click="connectAll"
            title="连接所有启用的服务器"
          >
            全部连接
          </button>
        </div>

        <div class="popover-body">
          <!-- 无服务器提示 -->
          <div v-if="servers.length === 0" class="empty-hint">
            <span>尚未配置 MCP 服务器</span>
          </div>

          <!-- 服务器列表 -->
          <div v-else class="server-list">
            <div 
              v-for="server in servers" 
              :key="server.id"
              class="server-item"
              :class="{ 
                disabled: !server.enabled,
                connected: getServerStatus(server.id)?.connected
              }"
            >
              <!-- 状态指示 -->
              <span class="server-dot" :class="{
                'dot-connected': getServerStatus(server.id)?.connected,
                'dot-enabled': server.enabled && !getServerStatus(server.id)?.connected,
                'dot-disabled': !server.enabled
              }">
                {{ getServerStatus(server.id)?.connected ? '●' : '○' }}
              </span>

              <!-- 服务器信息 -->
              <div class="server-info">
                <span class="server-name">{{ server.name }}</span>
                <span v-if="getServerStatus(server.id)?.connected" class="server-tools">
                  {{ getServerStatus(server.id)?.toolCount }} 工具
                </span>
                <span v-else-if="!server.enabled" class="server-disabled-tag">
                  已禁用
                </span>
              </div>

              <!-- 操作按钮 -->
              <div class="server-actions">
                <template v-if="server.enabled">
                  <button 
                    v-if="!getServerStatus(server.id)?.connected"
                    class="btn-action btn-connect"
                    :disabled="connecting === server.id"
                    @click="connectServer(server)"
                    title="连接"
                  >
                    <span v-if="connecting === server.id" class="spinner-small"></span>
                    <span v-else>连接</span>
                  </button>
                  <button 
                    v-else
                    class="btn-action btn-disconnect"
                    @click="disconnectServer(server)"
                    title="断开"
                  >
                    断开
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>

        <div class="popover-footer">
          <button class="btn-settings" @click="openSettings">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            前往设置
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.mcp-status-wrapper {
  position: relative;
}

.mcp-status-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 状态徽章 */
.status-badge {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  font-weight: 500;
  padding: 1px 4px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.status-dot {
  font-size: 10px;
}

.status-count {
  font-family: var(--font-mono);
  font-size: 10px;
}

/* 状态颜色 */
.status-all .status-dot,
.status-all.status-badge {
  color: #10b981;
}

.status-partial .status-dot,
.status-partial.status-badge {
  color: #f59e0b;
}

.status-offline .status-dot,
.status-offline.status-badge {
  color: #ef4444;
}

.status-none .status-dot,
.status-none.status-badge {
  color: var(--text-muted);
}

/* 弹出面板 */
.mcp-popover {
  position: fixed;
  top: calc(var(--header-height, 44px) + 8px);
  right: 60px;
  width: 280px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 1100;
  animation: popoverIn 0.15s ease;
}

@keyframes popoverIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
}

.popover-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.btn-connect-all {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-connect-all:hover {
  background: rgba(16, 185, 129, 0.2);
  border-color: #10b981;
}

.popover-body {
  max-height: 300px;
  overflow-y: auto;
}

.empty-hint {
  padding: 24px 14px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.server-list {
  padding: 8px 0;
}

.server-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  transition: background 0.15s ease;
}

.server-item:hover {
  background: var(--bg-hover);
}

.server-item.disabled {
  opacity: 0.5;
}

.server-dot {
  font-size: 12px;
  flex-shrink: 0;
}

.dot-connected {
  color: #10b981;
}

.dot-enabled {
  color: var(--text-muted);
}

.dot-disabled {
  color: var(--text-muted);
  opacity: 0.5;
}

.server-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.server-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-tools {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.server-disabled-tag {
  font-size: 10px;
  color: var(--text-muted);
  padding: 1px 6px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  flex-shrink: 0;
}

.server-actions {
  flex-shrink: 0;
}

.btn-action {
  padding: 3px 8px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-connect {
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
}

.btn-connect:hover:not(:disabled) {
  background: rgba(100, 150, 255, 0.1);
}

.btn-connect:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-disconnect {
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-color);
}

.btn-disconnect:hover {
  color: #ef4444;
  border-color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
}

.spinner-small {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.popover-footer {
  padding: 10px 14px;
  border-top: 1px solid var(--border-color);
}

.btn-settings {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-settings:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}
</style>
