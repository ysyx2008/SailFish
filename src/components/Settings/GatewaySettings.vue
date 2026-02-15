<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, ExternalLink, ScrollText } from 'lucide-vue-next'

const { t } = useI18n()

// ==================== Gateway 相关 ====================
const isRunning = ref(false)
const isLoading = ref(false)
const port = ref(3721)
const host = ref('0.0.0.0')
const apiToken = ref('')
const autoStart = ref(false)
const error = ref('')
const copied = ref<string | null>(null)

const chatUrl = computed(() => {
  const h = host.value === '0.0.0.0' ? 'localhost' : host.value
  return `http://${h}:${port.value}/chat`
})

// ==================== IM 集成相关 ====================
const dingtalkExpanded = ref(false)
const feishuExpanded = ref(false)

// 钉钉
const dtClientId = ref('')
const dtClientSecret = ref('')
const dtConnected = ref(false)
const dtConnecting = ref(false)
const dtError = ref('')
const dtActiveSessions = ref(0)

// 飞书
const fsAppId = ref('')
const fsAppSecret = ref('')
const fsConnected = ref(false)
const fsConnecting = ref(false)
const fsError = ref('')
const fsActiveSessions = ref(0)

// IM 自动连接
const imAutoConnect = ref(false)

let cleanupImListener: (() => void) | null = null

onMounted(async () => {
  try {
    const [running, auto] = await Promise.all([
      window.electronAPI.gateway.isRunning(),
      window.electronAPI.gateway.getAutoStart()
    ])
    isRunning.value = running
    autoStart.value = auto
    if (running) {
      const config = await window.electronAPI.gateway.getConfig()
      port.value = config.port
      host.value = config.host
      apiToken.value = config.apiToken
    }
  } catch {
    // ignore
  }

  // 实时监听审计日志
  cleanupAuditListener = window.electronAPI.gateway.onAuditLog((entry) => {
    auditLog.value.push(entry)
    // 保持最近 100 条
    if (auditLog.value.length > 100) {
      auditLog.value = auditLog.value.slice(-100)
    }
  })

  // 加载 IM 设置
  await loadIMSettings()

  // 监听 IM 连接状态变化
  cleanupImListener = window.electronAPI.im.onConnectionChange((data) => {
    if (data.platform === 'dingtalk') {
      dtConnected.value = data.connected
      if (!data.connected) dtConnecting.value = false
    } else if (data.platform === 'feishu') {
      fsConnected.value = data.connected
      if (!data.connected) fsConnecting.value = false
    }
  })
})

onUnmounted(() => {
  cleanupAuditListener?.()
  cleanupImListener?.()
})

async function loadIMSettings() {
  try {
    const status = await window.electronAPI.im.getStatus()
    dtConnected.value = status.dingtalk.connected
    dtActiveSessions.value = status.dingtalk.activeSessions
    fsConnected.value = status.feishu.connected
    fsActiveSessions.value = status.feishu.activeSessions

    // 加载保存的配置
    const config = await window.electronAPI.im.getConfig()
    dtClientId.value = config.dingtalk?.clientId || ''
    dtClientSecret.value = config.dingtalk?.clientSecret || ''
    fsAppId.value = config.feishu?.appId || ''
    fsAppSecret.value = config.feishu?.appSecret || ''
    imAutoConnect.value = config.autoConnect || false
  } catch {
    // ignore
  }
}

// ==================== 钉钉操作 ====================
async function toggleDingTalk() {
  dtError.value = ''
  if (dtConnected.value) {
    await window.electronAPI.im.stopDingTalk()
    dtConnected.value = false
  } else {
    if (!dtClientId.value || !dtClientSecret.value) {
      dtError.value = 'Client ID and Client Secret are required'
      return
    }
    dtConnecting.value = true
    try {
      const result = await window.electronAPI.im.startDingTalk({
        enabled: true,
        clientId: dtClientId.value,
        clientSecret: dtClientSecret.value
      })
      if (result.success) {
        dtConnected.value = true
      } else {
        dtError.value = result.error || t('settings.im.connectFailed')
      }
    } catch (e: any) {
      dtError.value = e.message
    } finally {
      dtConnecting.value = false
    }
  }
}

// ==================== 飞书操作 ====================
async function toggleFeishu() {
  fsError.value = ''
  if (fsConnected.value) {
    await window.electronAPI.im.stopFeishu()
    fsConnected.value = false
  } else {
    if (!fsAppId.value || !fsAppSecret.value) {
      fsError.value = 'App ID and App Secret are required'
      return
    }
    fsConnecting.value = true
    try {
      const result = await window.electronAPI.im.startFeishu({
        enabled: true,
        appId: fsAppId.value,
        appSecret: fsAppSecret.value
      })
      if (result.success) {
        fsConnected.value = true
      } else {
        fsError.value = result.error || t('settings.im.connectFailed')
      }
    } catch (e: any) {
      fsError.value = e.message
    } finally {
      fsConnecting.value = false
    }
  }
}

async function toggleImAutoConnect() {
  try {
    await window.electronAPI.im.setAutoConnect(imAutoConnect.value)
  } catch {
    imAutoConnect.value = !imAutoConnect.value
  }
}

// ==================== Gateway 操作 ====================
async function toggleGateway() {
  isLoading.value = true
  error.value = ''

  try {
    if (isRunning.value) {
      await window.electronAPI.gateway.stop()
      isRunning.value = false
      apiToken.value = ''
    } else {
      const result = await window.electronAPI.gateway.start({
        enabled: true,
        port: port.value,
        host: host.value,
        apiToken: ''  // 让服务端自动生成
      })
      if (result.success) {
        isRunning.value = true
        const config = await window.electronAPI.gateway.getConfig()
        apiToken.value = config.apiToken
      } else {
        error.value = result.error || t('settings.gateway.startFailed')
      }
    }
  } catch (e: any) {
    error.value = e.message
  } finally {
    isLoading.value = false
  }
}

async function toggleAutoStart() {
  // v-model 已更新 autoStart，直接保存
  try {
    await window.electronAPI.gateway.setAutoStart(autoStart.value)
  } catch {
    autoStart.value = !autoStart.value  // revert on error
  }
}

// 审计日志
interface AuditLogEntry {
  id: string
  timestamp: number
  type: string
  clientIp?: string
  summary: string
  details?: Record<string, unknown>
}
const auditLog = ref<AuditLogEntry[]>([])
const showAuditLog = ref(false)
let cleanupAuditListener: (() => void) | null = null

async function loadAuditLog() {
  try {
    auditLog.value = await window.electronAPI.gateway.getAuditLog(100)
  } catch { /* ignore */ }
}

function toggleAuditLog() {
  showAuditLog.value = !showAuditLog.value
  if (showAuditLog.value) {
    loadAuditLog()
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function auditTypeIcon(type: string): string {
  switch (type) {
    case 'connection': return '🔗'
    case 'task_start': return '🚀'
    case 'tool_call': return '🔧'
    case 'task_complete': return '✅'
    case 'task_error': return '❌'
    case 'confirm': return '⚠️'
    default: return '📋'
  }
}

async function copyToClipboard(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = label
    setTimeout(() => { copied.value = null }, 2000)
  } catch {
    // 回退方案
    const input = document.createElement('input')
    input.value = text
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    document.execCommand('copy')
    document.body.removeChild(input)
    copied.value = label
    setTimeout(() => { copied.value = null }, 2000)
  }
}
</script>

<template>
  <div class="gateway-settings">
    <h3>{{ t('settings.gateway.title') }}</h3>
    <p class="description">{{ t('settings.gateway.description') }}</p>

    <!-- 端口配置 -->
    <div class="form-group">
      <label>{{ t('settings.gateway.port') }}</label>
      <input
        v-model.number="port"
        type="number"
        min="1024"
        max="65535"
        :disabled="isRunning"
        class="input-field"
      />
    </div>

    <!-- 监听地址 -->
    <div class="form-group">
      <label>{{ t('settings.gateway.host') }}</label>
      <select v-model="host" :disabled="isRunning" class="input-field">
        <option value="0.0.0.0">0.0.0.0 ({{ t('settings.gateway.allInterfaces') }})</option>
        <option value="127.0.0.1">127.0.0.1 ({{ t('settings.gateway.localhostOnly') }})</option>
      </select>
    </div>

    <!-- 自动启动 -->
    <div class="form-group setting-row">
      <div>
        <label class="setting-label">{{ t('settings.gateway.autoStart') }}</label>
        <p class="setting-desc">{{ t('settings.gateway.autoStartHint') }}</p>
      </div>
      <label class="switch">
        <input type="checkbox" v-model="autoStart" @change="toggleAutoStart" />
        <span class="slider"></span>
      </label>
    </div>

    <!-- 启停按钮 -->
    <div class="form-group">
      <button
        v-if="isRunning"
        class="btn btn-sm btn-danger"
        :disabled="isLoading"
        @click="toggleGateway"
      >
        {{ isLoading ? t('settings.gateway.loading') : t('settings.gateway.stop') }}
      </button>
      <button
        v-else
        class="btn btn-sm btn-primary"
        :disabled="isLoading"
        @click="toggleGateway"
      >
        {{ isLoading ? t('settings.gateway.loading') : t('settings.gateway.start') }}
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="error-msg">{{ error }}</div>

    <!-- 运行信息 -->
    <div v-if="isRunning" class="running-info">
      <div class="info-row">
        <span class="info-label">{{ t('settings.gateway.chatUrl') }}</span>
        <div class="info-value">
          <code>{{ chatUrl }}</code>
          <button class="btn btn-sm" @click="copyToClipboard(chatUrl, 'url')">
            <Copy :size="13" /> {{ t('settings.gateway.copy') }}
          </button>
          <a :href="chatUrl" target="_blank" class="btn btn-sm">
            <ExternalLink :size="13" /> {{ t('settings.gateway.openInBrowser') }}
          </a>
          <span v-if="copied === 'url'" class="copied-tip">{{ t('settings.gateway.copied') }}</span>
        </div>
      </div>

      <div class="info-row">
        <span class="info-label">API Token</span>
        <div class="info-value">
          <code class="token-text">{{ apiToken }}</code>
          <button class="btn btn-sm" @click="copyToClipboard(apiToken, 'token')">
            <Copy :size="13" /> {{ t('settings.gateway.copy') }}
          </button>
          <span v-if="copied === 'token'" class="copied-tip">{{ t('settings.gateway.copied') }}</span>
        </div>
      </div>

      <div class="security-note">
        ⚠️ {{ t('settings.gateway.securityNote') }}
      </div>

      <!-- 审计日志 -->
      <div class="audit-section">
        <button class="audit-toggle" @click="toggleAuditLog">
          <ScrollText :size="14" />
          {{ t('settings.gateway.auditLog') }}
          <span class="audit-count" v-if="auditLog.length">{{ auditLog.length }}</span>
          <span class="toggle-arrow">{{ showAuditLog ? '▲' : '▼' }}</span>
        </button>

        <div v-if="showAuditLog" class="audit-log-panel">
          <div v-if="auditLog.length === 0" class="audit-empty">
            {{ t('settings.gateway.noAuditLog') }}
          </div>
          <div v-else class="audit-list">
            <div
              v-for="entry in [...auditLog].reverse()"
              :key="entry.id"
              class="audit-entry"
              :class="'audit-' + entry.type"
            >
              <span class="audit-icon">{{ auditTypeIcon(entry.type) }}</span>
              <span class="audit-time">{{ formatTime(entry.timestamp) }}</span>
              <span class="audit-summary">{{ entry.summary }}</span>
              <span v-if="entry.clientIp" class="audit-ip">{{ entry.clientIp }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== IM 集成 ==================== -->
    <div class="im-section">
      <h3>{{ t('settings.im.title') }}</h3>
      <p class="description">{{ t('settings.im.description') }}</p>

      <!-- IM 自动连接 -->
      <div class="form-group setting-row">
        <div>
          <label class="setting-label">{{ t('settings.im.autoConnect') }}</label>
          <p class="setting-desc">{{ t('settings.im.autoConnectHint') }}</p>
        </div>
        <label class="switch">
          <input type="checkbox" v-model="imAutoConnect" @change="toggleImAutoConnect" />
          <span class="slider"></span>
        </label>
      </div>

      <!-- 钉钉 -->
      <div class="im-platform-card">
        <button class="im-platform-header" @click="dingtalkExpanded = !dingtalkExpanded">
          <span class="im-platform-name">{{ t('settings.im.dingtalk') }}</span>
          <span class="im-status-dot" :class="{ connected: dtConnected }"></span>
          <span class="im-status-text">{{ dtConnected ? t('settings.im.connected') : t('settings.im.disconnected') }}</span>
          <span v-if="dtConnected && dtActiveSessions > 0" class="im-sessions">{{ dtActiveSessions }} {{ t('settings.im.activeSessions') }}</span>
          <span class="toggle-arrow">{{ dingtalkExpanded ? '▲' : '▼' }}</span>
        </button>

        <div v-if="dingtalkExpanded" class="im-platform-body">
          <p class="im-hint">{{ t('settings.im.dingtalkHint') }}</p>

          <div class="form-group">
            <label>{{ t('settings.im.clientId') }}</label>
            <input
              v-model="dtClientId"
              type="text"
              :disabled="dtConnected"
              class="input-field input-wide"
              placeholder="AppKey"
            />
          </div>
          <div class="form-group">
            <label>{{ t('settings.im.clientSecret') }}</label>
            <input
              v-model="dtClientSecret"
              type="password"
              :disabled="dtConnected"
              class="input-field input-wide"
              placeholder="AppSecret"
            />
          </div>

          <div v-if="dtError" class="error-msg">{{ dtError }}</div>

          <div class="form-group">
            <button
              v-if="dtConnected"
              class="btn btn-sm btn-danger"
              @click="toggleDingTalk"
            >{{ t('settings.im.disconnect') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="dtConnecting"
              @click="toggleDingTalk"
            >{{ dtConnecting ? t('settings.im.connecting') : t('settings.im.connect') }}</button>
          </div>
        </div>
      </div>

      <!-- 飞书 -->
      <div class="im-platform-card">
        <button class="im-platform-header" @click="feishuExpanded = !feishuExpanded">
          <span class="im-platform-name">{{ t('settings.im.feishu') }}</span>
          <span class="im-status-dot" :class="{ connected: fsConnected }"></span>
          <span class="im-status-text">{{ fsConnected ? t('settings.im.connected') : t('settings.im.disconnected') }}</span>
          <span v-if="fsConnected && fsActiveSessions > 0" class="im-sessions">{{ fsActiveSessions }} {{ t('settings.im.activeSessions') }}</span>
          <span class="toggle-arrow">{{ feishuExpanded ? '▲' : '▼' }}</span>
        </button>

        <div v-if="feishuExpanded" class="im-platform-body">
          <p class="im-hint">{{ t('settings.im.feishuHint') }}</p>

          <div class="form-group">
            <label>{{ t('settings.im.appId') }}</label>
            <input
              v-model="fsAppId"
              type="text"
              :disabled="fsConnected"
              class="input-field input-wide"
              placeholder="App ID"
            />
          </div>
          <div class="form-group">
            <label>{{ t('settings.im.appSecret') }}</label>
            <input
              v-model="fsAppSecret"
              type="password"
              :disabled="fsConnected"
              class="input-field input-wide"
              placeholder="App Secret"
            />
          </div>

          <div v-if="fsError" class="error-msg">{{ fsError }}</div>

          <div class="form-group">
            <button
              v-if="fsConnected"
              class="btn btn-sm btn-danger"
              @click="toggleFeishu"
            >{{ t('settings.im.disconnect') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="fsConnecting"
              @click="toggleFeishu"
            >{{ fsConnecting ? t('settings.im.connecting') : t('settings.im.connect') }}</button>
          </div>
        </div>
      </div>

      <div class="security-note" style="margin-top: 12px;">
        {{ t('settings.im.securityNote') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.gateway-settings {
  max-width: 600px;
}

h3 {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}

.description {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 20px;
  line-height: 1.5;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-primary);
}

.input-field {
  width: 200px;
  padding: 6px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.input-field:focus {
  border-color: var(--accent-color);
}

.input-field:disabled {
  opacity: 0.6;
}

/* Setting row (label + switch) */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.setting-label {
  font-weight: 500;
  color: var(--text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 0;
}

/* Toggle switch - same as KnowledgeSettings */
.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background-color: var(--bg-tertiary);
  transition: 0.3s;
  border-radius: 24px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--accent-primary);
}

input:checked + .slider:before {
  transform: translateX(20px);
}

.hint {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
  margin-left: 46px;
}

/* btn-danger - 同 KnowledgeSettings */
.btn-danger {
  background: var(--bg-tertiary);
  border-color: var(--accent-error);
  color: var(--accent-error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--bg-hover);
}


.error-msg {
  color: var(--danger-color, #f85149);
  font-size: 13px;
  margin-bottom: 16px;
  padding: 8px 12px;
  background: rgba(248, 81, 73, 0.1);
  border-radius: 6px;
}

.running-info {
  margin-top: 20px;
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.info-row {
  margin-bottom: 12px;
}

.info-row:last-of-type {
  margin-bottom: 16px;
}

.info-label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  font-weight: 500;
}

.info-value {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.info-value code {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
  padding: 4px 8px;
  background: var(--bg-tertiary, var(--bg-primary));
  border-radius: 4px;
  color: var(--text-primary);
  user-select: all;
}

.token-text {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.info-value .btn {
  text-decoration: none;
}

.copied-tip {
  font-size: 12px;
  color: var(--success-color, #3fb950);
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.security-note {
  font-size: 12px;
  color: var(--warning-color, #d29922);
  line-height: 1.5;
  padding: 8px 10px;
  background: rgba(210, 153, 34, 0.08);
  border-radius: 6px;
}

/* 审计日志 */
.audit-section {
  margin-top: 16px;
}

.audit-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-secondary, #161b22);
  border: 1px solid var(--border-primary, #30363d);
  color: var(--text-secondary);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  width: 100%;
  transition: all 0.2s;
}

.audit-toggle:hover {
  background: var(--bg-tertiary, var(--bg-primary));
  color: var(--text-primary);
}

.audit-count {
  background: var(--accent-primary, #1f6feb);
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.toggle-arrow {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
}

.audit-log-panel {
  margin-top: 8px;
  border: 1px solid var(--border-primary, #30363d);
  border-radius: 6px;
  max-height: 300px;
  overflow-y: auto;
}

.audit-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.audit-list {
  padding: 4px;
}

.audit-entry {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.4;
  transition: background 0.15s;
}

.audit-entry:hover {
  background: var(--bg-secondary, #161b22);
}

.audit-icon {
  flex-shrink: 0;
  font-size: 13px;
}

.audit-time {
  flex-shrink: 0;
  color: var(--text-muted);
  font-family: monospace;
  font-size: 11px;
  white-space: nowrap;
}

.audit-summary {
  flex: 1;
  color: var(--text-secondary);
  word-break: break-all;
}

.audit-ip {
  flex-shrink: 0;
  color: var(--text-muted);
  font-family: monospace;
  font-size: 11px;
}

.audit-task_error .audit-summary {
  color: var(--error-color, #f85149);
}

.audit-confirm .audit-summary {
  color: var(--warning-color, #d29922);
}

/* ==================== IM 集成样式 ==================== */
.im-section {
  margin-top: 32px;
  padding-top: 24px;
  border-top: 1px solid var(--border-color);
}

.im-platform-card {
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
}

.im-platform-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  background: var(--bg-secondary);
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.im-platform-header:hover {
  background: var(--bg-tertiary, var(--bg-primary));
}

.im-platform-name {
  font-weight: 600;
}

.im-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted, #6e7681);
  flex-shrink: 0;
}

.im-status-dot.connected {
  background: var(--success-color, #3fb950);
}

.im-status-text {
  font-size: 12px;
  color: var(--text-secondary);
}

.im-sessions {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 8px;
}

.im-platform-body {
  padding: 14px;
  border-top: 1px solid var(--border-color);
}

.im-hint {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 14px;
}

.input-wide {
  width: 100%;
  max-width: 400px;
}
</style>
