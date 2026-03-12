<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Radio, Settings } from 'lucide-vue-next'

const { t } = useI18n()

// ==================== 类型 ====================

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

type IMPlatform = 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom'

interface IMChannelState {
  platform: IMPlatform
  label: string
  enabled: boolean
  connected: boolean
  hasCredentials: boolean
  autoConnect: boolean
}

// ==================== Emits ====================

const emit = defineEmits<{
  openSettings: [tab?: string]
}>()

// ==================== 状态 ====================

const showPopover = ref(false)
const popoverRef = ref<HTMLElement | null>(null)
const buttonRef = ref<HTMLElement | null>(null)

// IM
const imChannels = ref<IMChannelState[]>([])
const imConnecting = ref<string | null>(null)

// Gateway
const gatewayRunning = ref(false)
const gatewayPort = ref(0)
const gatewayAutoStart = ref(false)

// MCP
const mcpServers = ref<McpServerConfig[]>([])
const mcpStatuses = ref<McpServerStatus[]>([])
const mcpConnecting = ref<string | null>(null)

// ==================== 计算属性 ====================

const imConnectedCount = computed(() => imChannels.value.filter(c => c.connected).length)
// "活跃"渠道：已连接 或 配置了自动连接的
const imActiveCount = computed(() => imChannels.value.filter(c => c.connected || c.autoConnect).length)

const mcpEnabledServers = computed(() => mcpServers.value.filter(s => s.enabled))
const mcpConnectedCount = computed(() => mcpStatuses.value.length)
const mcpEnabledCount = computed(() => mcpEnabledServers.value.length)

const gatewayActive = computed(() => gatewayRunning.value || gatewayAutoStart.value)
const totalConnected = computed(() => imConnectedCount.value + (gatewayRunning.value ? 1 : 0) + mcpConnectedCount.value)
const totalEnabled = computed(() => imActiveCount.value + (gatewayActive.value ? 1 : 0) + mcpEnabledCount.value)

const statusType = computed(() => {
  if (totalEnabled.value === 0) return 'none'
  if (totalConnected.value === 0) return 'offline'
  if (totalConnected.value >= totalEnabled.value) return 'all'
  return 'partial'
})

const statusClass = computed(() => {
  switch (statusType.value) {
    case 'all': return 'status-all'
    case 'partial': return 'status-partial'
    case 'offline': return 'status-offline'
    default: return 'status-none'
  }
})

const statusIcon = computed(() => {
  switch (statusType.value) {
    case 'all': return '●'
    case 'partial': return '◐'
    default: return '○'
  }
})

const statusTooltip = computed(() => `${totalConnected.value}/${totalEnabled.value} ${t('conn.connected')}`)

// ==================== MCP 辅助 ====================

const getMcpStatus = (serverId: string): McpServerStatus | undefined => {
  return mcpStatuses.value.find(s => s.id === serverId)
}

// ==================== 数据加载 ====================

const platformLabels: Record<IMPlatform, () => string> = {
  dingtalk: () => t('settings.im.dingtalk'),
  feishu: () => t('settings.im.feishu'),
  slack: () => t('settings.im.slack'),
  telegram: () => t('settings.im.telegram'),
  wecom: () => t('settings.im.wecom'),
}

const loadIMData = async () => {
  const [status, config] = await Promise.all([
    window.electronAPI.im.getStatus(),
    window.electronAPI.im.getConfig(),
  ])

  const credCheck: Record<IMPlatform, boolean> = {
    dingtalk: !!(config.dingtalk.clientId && config.dingtalk.clientSecret),
    feishu: !!(config.feishu.appId && config.feishu.appSecret),
    slack: !!(config.slack.botToken && config.slack.appToken),
    telegram: !!config.telegram.botToken,
    wecom: !!(config.wecom.botId && config.wecom.secret),
  }

  const autoConnectCheck: Record<IMPlatform, boolean> = {
    dingtalk: config.dingtalk.autoConnect,
    feishu: config.feishu.autoConnect,
    slack: config.slack.autoConnect,
    telegram: config.telegram.autoConnect,
    wecom: config.wecom.autoConnect,
  }

  const platforms: IMPlatform[] = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom']
  imChannels.value = platforms
    .map(p => ({
      platform: p,
      label: platformLabels[p](),
      enabled: status[p].enabled,
      connected: status[p].connected,
      hasCredentials: credCheck[p],
      autoConnect: autoConnectCheck[p],
    }))
    .filter(c => c.hasCredentials)
}

const loadGatewayData = async () => {
  const [running, config, autoStart] = await Promise.all([
    window.electronAPI.gateway.isRunning(),
    window.electronAPI.gateway.getConfig(),
    window.electronAPI.gateway.getAutoStart(),
  ])
  gatewayRunning.value = running
  gatewayPort.value = config.port
  gatewayAutoStart.value = autoStart
}

const loadMcpData = async () => {
  mcpServers.value = await window.electronAPI.mcp.getServers()
  mcpStatuses.value = await window.electronAPI.mcp.getServerStatuses()
}

const loadAll = async () => {
  await Promise.all([loadIMData(), loadGatewayData(), loadMcpData()])
}

// ==================== IM 操作 ====================

const connectIM = async (channel: IMChannelState) => {
  imConnecting.value = channel.platform
  try {
    const config = await window.electronAPI.im.getConfig()
    let result: { success: boolean; error?: string }
    switch (channel.platform) {
      case 'dingtalk':
        result = await window.electronAPI.im.startDingTalk({ enabled: true, clientId: config.dingtalk.clientId, clientSecret: config.dingtalk.clientSecret })
        break
      case 'feishu':
        result = await window.electronAPI.im.startFeishu({ enabled: true, appId: config.feishu.appId, appSecret: config.feishu.appSecret })
        break
      case 'slack':
        result = await window.electronAPI.im.startSlack({ enabled: true, botToken: config.slack.botToken, appToken: config.slack.appToken })
        break
      case 'telegram':
        result = await window.electronAPI.im.startTelegram({ enabled: true, botToken: config.telegram.botToken })
        break
      case 'wecom':
        result = await window.electronAPI.im.startWeCom({
          enabled: true, botId: config.wecom.botId, secret: config.wecom.secret,
        })
        break
      default:
        result = { success: false, error: 'Unknown platform' }
    }
    if (!result.success) console.error(`[IM] Connect ${channel.platform} failed:`, result.error)
  } catch (e) {
    console.error(`[IM] Connect ${channel.platform} error:`, e)
  } finally {
    imConnecting.value = null
    await loadIMData()
  }
}

const disconnectIM = async (channel: IMChannelState) => {
  switch (channel.platform) {
    case 'dingtalk': await window.electronAPI.im.stopDingTalk(); break
    case 'feishu': await window.electronAPI.im.stopFeishu(); break
    case 'slack': await window.electronAPI.im.stopSlack(); break
    case 'telegram': await window.electronAPI.im.stopTelegram(); break
    case 'wecom': await window.electronAPI.im.stopWeCom(); break
  }
  await loadIMData()
}

// ==================== Gateway 操作 ====================

const toggleGateway = async () => {
  if (gatewayRunning.value) {
    await window.electronAPI.gateway.stop()
  } else {
    const config = await window.electronAPI.gateway.getConfig()
    await window.electronAPI.gateway.start(config)
  }
  await loadGatewayData()
}

// ==================== MCP 操作 ====================

const connectMcp = async (server: McpServerConfig) => {
  mcpConnecting.value = server.id
  try {
    await window.electronAPI.mcp.connect(JSON.parse(JSON.stringify(server)))
  } catch (e) {
    console.error('MCP connect error:', e)
  } finally {
    mcpConnecting.value = null
    await loadMcpData()
  }
}

const disconnectMcp = async (server: McpServerConfig) => {
  await window.electronAPI.mcp.disconnect(server.id)
  await loadMcpData()
}

const connectAllMcp = async () => {
  const results = await window.electronAPI.mcp.connectEnabledServers()
  const failed = results.filter((r: any) => !r.success)
  if (failed.length > 0) console.warn('MCP partial connect failures:', failed)
  await loadMcpData()
}

// ==================== 弹窗控制 ====================

let gatewayPollTimer: ReturnType<typeof setInterval> | null = null

const togglePopover = async () => {
  showPopover.value = !showPopover.value
  if (showPopover.value) {
    await loadAll()
    gatewayPollTimer = setInterval(loadGatewayData, 5000)
  } else {
    if (gatewayPollTimer) { clearInterval(gatewayPollTimer); gatewayPollTimer = null }
  }
}

const closePopover = () => {
  showPopover.value = false
  if (gatewayPollTimer) { clearInterval(gatewayPollTimer); gatewayPollTimer = null }
}

const handleClickOutside = (e: MouseEvent) => {
  if (!showPopover.value) return
  const target = e.target as Node
  if (popoverRef.value && !popoverRef.value.contains(target) &&
      buttonRef.value && !buttonRef.value.contains(target)) {
    closePopover()
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPopover.value) {
    e.stopImmediatePropagation()
    closePopover()
  }
}

const openSettings = (tab?: string) => {
  closePopover()
  emit('openSettings', tab)
}

// ==================== 生命周期 ====================

let unsubImChange: (() => void) | null = null
let unsubMcpConnected: (() => void) | null = null
let unsubMcpDisconnected: (() => void) | null = null
let unsubMcpError: (() => void) | null = null

onMounted(async () => {
  await loadAll()

  unsubImChange = window.electronAPI.im.onConnectionChange(async () => {
    await loadIMData()
  })
  unsubMcpConnected = window.electronAPI.mcp.onConnected(async () => { await loadMcpData() })
  unsubMcpDisconnected = window.electronAPI.mcp.onDisconnected(async () => { await loadMcpData() })
  unsubMcpError = window.electronAPI.mcp.onError(async () => { await loadMcpData() })

  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  unsubImChange?.()
  unsubMcpConnected?.()
  unsubMcpDisconnected?.()
  unsubMcpError?.()
  if (gatewayPollTimer) clearInterval(gatewayPollTimer)
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <div class="conn-wrapper">
    <!-- 顶栏按钮 -->
    <button
      ref="buttonRef"
      class="btn-icon conn-btn"
      :class="statusClass"
      :title="statusTooltip"
      @click="togglePopover"
    >
      <Radio :size="18" />
      <span class="status-badge" :class="statusClass">
        <span class="status-dot">{{ statusIcon }}</span>
        <span class="status-count">{{ totalConnected }}/{{ totalEnabled }}</span>
      </span>
    </button>

    <!-- 弹出面板 -->
    <Teleport to="body">
      <div v-if="showPopover" ref="popoverRef" class="conn-popover">
        <!-- 双栏内容 -->
        <div class="conn-columns">
          <!-- 左栏：远程渠道 -->
          <div class="conn-col">
            <div class="col-header">
              <span class="col-title">📡 {{ t('conn.channels') }}</span>
              <span class="col-count" :class="imConnectedCount > 0 ? 'count-ok' : ''">{{ imConnectedCount }}/{{ imActiveCount }}</span>
            </div>
            <div class="col-body">
              <!-- IM 渠道列表 -->
              <div v-if="imChannels.length === 0" class="empty-hint">
                <span>{{ t('conn.noChannels') }}</span>
                <button class="btn-link" @click="openSettings('im')">{{ t('conn.goSetup') }}</button>
              </div>
              <div v-for="ch in imChannels" :key="ch.platform" class="item" :class="{ connected: ch.connected }">
                <span class="item-dot" :class="ch.connected ? 'dot-on' : 'dot-off'">{{ ch.connected ? '●' : '○' }}</span>
                <span class="item-name">{{ ch.label }}</span>
                <div class="item-actions">
                  <button v-if="!ch.connected" class="btn-sm btn-connect" :disabled="imConnecting === ch.platform" @click="connectIM(ch)">
                    <span v-if="imConnecting === ch.platform" class="spinner"></span>
                    <span v-else>{{ t('conn.connect') }}</span>
                  </button>
                  <button v-else class="btn-sm btn-disconnect" @click="disconnectIM(ch)">{{ t('conn.disconnect') }}</button>
                </div>
              </div>

              <!-- Gateway -->
              <div class="section-divider"></div>
              <div class="item" :class="{ connected: gatewayRunning }">
                <span class="item-dot" :class="gatewayRunning ? 'dot-on' : 'dot-off'">{{ gatewayRunning ? '●' : '○' }}</span>
                <span class="item-name">Gateway</span>
                <span v-if="gatewayRunning" class="item-detail">:{{ gatewayPort }}</span>
                <div class="item-actions">
                  <button class="btn-sm" :class="gatewayRunning ? 'btn-disconnect' : 'btn-connect'" @click="toggleGateway">
                    {{ gatewayRunning ? t('conn.stop') : t('conn.start') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 右栏：MCP 服务器 -->
          <div class="conn-col">
            <div class="col-header">
              <span class="col-title">🔌 {{ t('conn.mcpServers') }}</span>
              <span class="col-count" :class="mcpConnectedCount > 0 ? 'count-ok' : ''">{{ mcpConnectedCount }}/{{ mcpEnabledCount }}</span>
              <button
                v-if="mcpEnabledCount > 0 && mcpConnectedCount < mcpEnabledCount"
                class="btn-link"
                @click="connectAllMcp"
              >{{ t('mcp.connectAll') }}</button>
            </div>
            <div class="col-body">
              <div v-if="mcpServers.length === 0" class="empty-hint">
                <span>{{ t('mcp.noServersConfigured') }}</span>
                <button class="btn-link" @click="openSettings('mcp')">{{ t('conn.goSetup') }}</button>
              </div>
              <div
                v-for="srv in mcpServers" :key="srv.id"
                class="item"
                :class="{ connected: getMcpStatus(srv.id)?.connected, disabled: !srv.enabled }"
              >
                <span class="item-dot" :class="{
                  'dot-on': getMcpStatus(srv.id)?.connected,
                  'dot-off': srv.enabled && !getMcpStatus(srv.id)?.connected,
                  'dot-disabled': !srv.enabled
                }">{{ getMcpStatus(srv.id)?.connected ? '●' : '○' }}</span>
                <div class="item-name-group">
                  <span class="item-name">{{ srv.name }}</span>
                  <span v-if="getMcpStatus(srv.id)?.connected" class="item-detail">{{ getMcpStatus(srv.id)?.toolCount }} {{ t('mcp.tools') }}</span>
                  <span v-else-if="!srv.enabled" class="item-tag">{{ t('mcp.disabled') }}</span>
                </div>
                <div class="item-actions" v-if="srv.enabled">
                  <button v-if="!getMcpStatus(srv.id)?.connected" class="btn-sm btn-connect" :disabled="mcpConnecting === srv.id" @click="connectMcp(srv)">
                    <span v-if="mcpConnecting === srv.id" class="spinner"></span>
                    <span v-else>{{ t('conn.connect') }}</span>
                  </button>
                  <button v-else class="btn-sm btn-disconnect" @click="disconnectMcp(srv)">{{ t('conn.disconnect') }}</button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 底部 -->
        <div class="conn-footer">
          <button class="btn-settings" @click="openSettings()">
            <Settings :size="14" />
            {{ t('conn.settings') }}
          </button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.conn-wrapper {
  position: relative;
}

.conn-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 4px 8px;
  border-radius: 6px;
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

.status-dot { font-size: 10px; }
.status-count { font-family: var(--font-mono); font-size: 10px; }

.status-all .status-dot, .status-all.status-badge { color: #10b981; }
.status-partial .status-dot, .status-partial.status-badge { color: #f59e0b; }
.status-offline .status-dot, .status-offline.status-badge { color: #ef4444; }
.status-none .status-dot, .status-none.status-badge { color: var(--text-muted); }

/* 弹出面板 */
.conn-popover {
  position: fixed;
  top: calc(var(--header-height, 44px) + 8px);
  right: 60px;
  width: 520px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 1100;
  animation: popIn 0.15s ease;
}

@keyframes popIn {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 双栏布局 */
.conn-columns {
  display: flex;
}

.conn-col {
  flex: 1;
  min-width: 0;
}

.conn-col:first-child {
  border-right: 1px solid var(--border-color);
}

/* 栏头 */
.col-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
}

.col-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.col-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

.col-count.count-ok {
  color: #10b981;
}

/* 栏体 */
.col-body {
  max-height: 280px;
  overflow-y: auto;
  padding: 6px 0;
}

/* 列表项 */
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  transition: background 0.15s ease;
}

.item:hover {
  background: var(--bg-hover);
}

.item.disabled {
  opacity: 0.5;
}

.item-dot {
  font-size: 11px;
  flex-shrink: 0;
}

.dot-on { color: #10b981; }
.dot-off { color: var(--text-muted); }
.dot-disabled { color: var(--text-muted); opacity: 0.5; }

.item-name {
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.item-name-group {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

.item-name-group .item-name {
  flex: unset;
}

.item-detail {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.item-tag {
  font-size: 10px;
  color: var(--text-muted);
  padding: 1px 5px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  flex-shrink: 0;
}

.item-actions {
  flex-shrink: 0;
  margin-left: auto;
}

.section-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 12px;
}

/* 按钮 */
.btn-sm {
  padding: 2px 7px;
  font-size: 10px;
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

.btn-link {
  font-size: 11px;
  color: var(--accent-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  margin-left: auto;
}

.btn-link:hover {
  text-decoration: underline;
}

.empty-hint {
  padding: 16px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.spinner {
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

/* 底部 */
.conn-footer {
  padding: 8px 12px;
  border-top: 1px solid var(--border-color);
}

.btn-settings {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 7px;
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
