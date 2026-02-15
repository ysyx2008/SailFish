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
// 飞书
const fsAppId = ref('')
const fsAppSecret = ref('')
const fsConnected = ref(false)
const fsConnecting = ref(false)
const fsError = ref('')
// 每平台自动连接
const dtAutoConnect = ref(false)
const fsAutoConnect = ref(false)

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
    fsConnected.value = status.feishu.connected

    // 加载保存的配置
    const config = await window.electronAPI.im.getConfig()
    dtClientId.value = config.dingtalk?.clientId || ''
    dtClientSecret.value = config.dingtalk?.clientSecret || ''
    dtAutoConnect.value = config.dingtalk?.autoConnect || false
    fsAppId.value = config.feishu?.appId || ''
    fsAppSecret.value = config.feishu?.appSecret || ''
    fsAutoConnect.value = config.feishu?.autoConnect || false
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

async function toggleDtAutoConnect() {
  try {
    await window.electronAPI.im.setAutoConnect('dingtalk', dtAutoConnect.value)
  } catch {
    dtAutoConnect.value = !dtAutoConnect.value
  }
}

async function toggleFsAutoConnect() {
  try {
    await window.electronAPI.im.setAutoConnect('feishu', fsAutoConnect.value)
  } catch {
    fsAutoConnect.value = !fsAutoConnect.value
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

    <!-- ==================== Gateway 服务 ==================== -->
    <div class="settings-section">
      <div class="section-header">
        <div class="section-title-group">
          <h4>{{ t('settings.gateway.title') }}</h4>
          <span class="status-badge" :class="{ active: isRunning }">
            <span class="status-dot"></span>
            {{ isRunning ? t('settings.gateway.running') : t('settings.gateway.stopped') }}
          </span>
        </div>
        <button
          class="btn btn-sm"
          :class="isRunning ? 'btn-danger' : 'btn-primary'"
          :disabled="isLoading"
          @click="toggleGateway"
        >
          {{ isLoading ? t('settings.gateway.loading') : (isRunning ? t('settings.gateway.stop') : t('settings.gateway.start')) }}
        </button>
      </div>
      <p class="section-desc">{{ t('settings.gateway.description') }}</p>

      <!-- 错误提示 -->
      <div v-if="error" class="error-msg">{{ error }}</div>

      <!-- 端口 + 监听地址 水平布局 -->
      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ t('settings.gateway.port') }}</label>
          <input
            v-model.number="port"
            type="number"
            min="1024"
            max="65535"
            :disabled="isRunning"
            class="input-field"
          />
        </div>
        <div class="form-group flex-1">
          <label class="form-label">{{ t('settings.gateway.host') }}</label>
          <select v-model="host" :disabled="isRunning" class="input-field">
            <option value="0.0.0.0">0.0.0.0 ({{ t('settings.gateway.allInterfaces') }})</option>
            <option value="127.0.0.1">127.0.0.1 ({{ t('settings.gateway.localhostOnly') }})</option>
          </select>
        </div>
      </div>

      <!-- 自动启动 -->
      <div class="setting-row">
        <div>
          <label class="form-label">{{ t('settings.gateway.autoStart') }}</label>
          <p class="setting-desc">{{ t('settings.gateway.autoStartHint') }}</p>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" v-model="autoStart" @change="toggleAutoStart" />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <!-- 运行信息 -->
      <div v-if="isRunning" class="running-info">
        <div class="info-row">
          <span class="info-label">{{ t('settings.gateway.chatUrl') }}</span>
          <div class="info-value">
            <code>{{ chatUrl }}</code>
            <button class="btn-icon-sm" @click="copyToClipboard(chatUrl, 'url')" :title="t('settings.gateway.copy')">
              <Copy :size="13" />
            </button>
            <a :href="chatUrl" target="_blank" class="btn-icon-sm" :title="t('settings.gateway.openInBrowser')">
              <ExternalLink :size="13" />
            </a>
            <span v-if="copied === 'url'" class="copied-tip">{{ t('settings.gateway.copied') }}</span>
          </div>
        </div>

        <div class="info-row">
          <span class="info-label">API Token</span>
          <div class="info-value">
            <code class="token-text">{{ apiToken }}</code>
            <button class="btn-icon-sm" @click="copyToClipboard(apiToken, 'token')" :title="t('settings.gateway.copy')">
              <Copy :size="13" />
            </button>
            <span v-if="copied === 'token'" class="copied-tip">{{ t('settings.gateway.copied') }}</span>
          </div>
        </div>

        <div class="security-note">
          {{ t('settings.gateway.securityNote') }}
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
    </div>

    <!-- ==================== IM 集成 ==================== -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.im.title') }}</h4>
      </div>
      <p class="section-desc">{{ t('settings.im.description') }}</p>

      <!-- 钉钉 -->
      <div class="im-platform-card" :class="{ expanded: dingtalkExpanded, connected: dtConnected }">
        <button class="im-platform-header" @click="dingtalkExpanded = !dingtalkExpanded">
          <span class="im-platform-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-.8 5.42s-.04.16-.12.2c-.08.04-.16 0-.16 0-.36-.12-1-.64-1.44-.96-.08-.08-.2-.16-.2-.16l-1.64 1.4s-.08.08-.2.04l.24-2.12s3.24-2.88 3.56-3.16c.12-.12.04-.2-.08-.12-.44.32-4.2 2.64-4.2 2.64l-2.04-.68s-.24-.08-.04-.28c0 0 4.28-1.76 5.56-2.24s1.72-.52 1.72-.52.32-.12.24.44z"/></svg>
          </span>
          <span class="im-platform-name">{{ t('settings.im.dingtalk') }}</span>
          <span class="im-status-indicator" :class="{ connected: dtConnected, connecting: dtConnecting }">
            <span class="indicator-dot"></span>
            {{ dtConnecting ? t('settings.im.connecting') : (dtConnected ? t('settings.im.connected') : t('settings.im.disconnected')) }}
          </span>
          <span class="toggle-arrow" :class="{ open: dingtalkExpanded }">›</span>
        </button>

        <div v-if="dingtalkExpanded" class="im-platform-body">
          <p class="im-hint">{{ t('settings.im.dingtalkHint') }}</p>

          <div class="form-group">
            <label class="form-label">{{ t('settings.im.clientId') }}</label>
            <input
              v-model="dtClientId"
              type="text"
              :disabled="dtConnected"
              class="input-field"
              placeholder="AppKey"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.clientSecret') }}</label>
            <input
              v-model="dtClientSecret"
              type="password"
              :disabled="dtConnected"
              class="input-field"
              placeholder="AppSecret"
            />
          </div>

          <div v-if="dtError" class="error-msg">{{ dtError }}</div>

          <div class="im-card-actions">
            <label class="auto-connect-label">
              <input type="checkbox" v-model="dtAutoConnect" @change="toggleDtAutoConnect" />
              <span>{{ t('settings.im.autoConnect') }}</span>
            </label>
            <button
              v-if="dtConnected"
              class="btn btn-sm btn-outline-danger"
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
      <div class="im-platform-card" :class="{ expanded: feishuExpanded, connected: fsConnected }">
        <button class="im-platform-header" @click="feishuExpanded = !feishuExpanded">
          <span class="im-platform-icon feishu">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm3.5 13.5l-5-2.5L7 16l1-5.5L5.5 7l5.5 1 2.5-5L15 8.5l5.5 1L17 13l-1.5 2.5z"/></svg>
          </span>
          <span class="im-platform-name">{{ t('settings.im.feishu') }}</span>
          <span class="im-status-indicator" :class="{ connected: fsConnected, connecting: fsConnecting }">
            <span class="indicator-dot"></span>
            {{ fsConnecting ? t('settings.im.connecting') : (fsConnected ? t('settings.im.connected') : t('settings.im.disconnected')) }}
          </span>
          <span class="toggle-arrow" :class="{ open: feishuExpanded }">›</span>
        </button>

        <div v-if="feishuExpanded" class="im-platform-body">
          <p class="im-hint">{{ t('settings.im.feishuHint') }}</p>

          <div class="form-group">
            <label class="form-label">{{ t('settings.im.appId') }}</label>
            <input
              v-model="fsAppId"
              type="text"
              :disabled="fsConnected"
              class="input-field"
              placeholder="App ID"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.appSecret') }}</label>
            <input
              v-model="fsAppSecret"
              type="password"
              :disabled="fsConnected"
              class="input-field"
              placeholder="App Secret"
            />
          </div>

          <div v-if="fsError" class="error-msg">{{ fsError }}</div>

          <div class="im-card-actions">
            <label class="auto-connect-label">
              <input type="checkbox" v-model="fsAutoConnect" @change="toggleFsAutoConnect" />
              <span>{{ t('settings.im.autoConnect') }}</span>
            </label>
            <button
              v-if="fsConnected"
              class="btn btn-sm btn-outline-danger"
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

      <div class="security-note">
        {{ t('settings.im.securityNote') }}
      </div>
    </div>

  </div>
</template>

<style scoped>
.gateway-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ==================== 通用区块 ==================== */
.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.section-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

/* 运行状态徽章 */
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 10px;
  border-radius: 12px;
  background: rgba(110, 118, 129, 0.12);
  color: var(--text-muted);
}

.status-badge.active {
  background: rgba(63, 185, 80, 0.12);
  color: var(--success-color, #3fb950);
}

.status-badge .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-badge.active .status-dot {
  box-shadow: 0 0 6px var(--success-color, #3fb950);
}

/* ==================== 表单控件 ==================== */
.form-group {
  margin-bottom: 14px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-primary);
}

.form-row {
  display: flex;
  gap: 12px;
  margin-bottom: 14px;
}

.flex-1 {
  flex: 1;
}

.input-field {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}

.input-field:focus {
  border-color: var(--accent-primary);
}

.input-field:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 设置行（标签 + 开关） */
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin: 2px 0 0;
}

/* 开关组件 - 同 AiSettings */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: 0.3s;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 2px;
  bottom: 2px;
  background-color: var(--text-muted);
  border-radius: 50%;
  transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
  background-color: white;
}

/* ==================== 按钮 ==================== */
.btn-danger {
  background: transparent;
  border-color: var(--accent-error, #f85149);
  color: var(--accent-error, #f85149);
}

.btn-danger:hover:not(:disabled) {
  background: rgba(248, 81, 73, 0.1);
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid var(--accent-error, #f85149);
  color: var(--accent-error, #f85149);
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(248, 81, 73, 0.1);
}

.btn-block {
  width: 100%;
  justify-content: center;
}

.btn-icon-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.btn-icon-sm:hover {
  background: var(--bg-surface, var(--bg-primary));
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

/* ==================== 错误提示 ==================== */
.error-msg {
  color: var(--danger-color, #f85149);
  font-size: 12px;
  margin-bottom: 14px;
  padding: 8px 12px;
  background: rgba(248, 81, 73, 0.08);
  border-radius: 6px;
  border-left: 3px solid var(--danger-color, #f85149);
}

/* ==================== 运行信息面板 ==================== */
.running-info {
  margin-top: 14px;
  padding: 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.info-row {
  margin-bottom: 12px;
}

.info-row:last-of-type {
  margin-bottom: 14px;
}

.info-label {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 4px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
  padding: 5px 10px;
  background: var(--bg-tertiary, var(--bg-primary));
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--accent-primary);
  user-select: all;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-text {
  max-width: 360px;
}

.copied-tip {
  font-size: 11px;
  color: var(--success-color, #3fb950);
  font-weight: 500;
  animation: fadeIn 0.2s;
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: translateY(0); }
}

.security-note {
  font-size: 12px;
  color: var(--warning-color, #d29922);
  line-height: 1.5;
  padding: 8px 12px;
  background: rgba(210, 153, 34, 0.06);
  border-radius: 6px;
  border-left: 3px solid rgba(210, 153, 34, 0.4);
}

/* ==================== 审计日志 ==================== */
.audit-section {
  margin-top: 14px;
}

.audit-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
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
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  min-width: 18px;
  text-align: center;
}

.audit-log-panel {
  margin-top: 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  max-height: 300px;
  overflow-y: auto;
}

.audit-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
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
  font-size: 11px;
  line-height: 1.4;
  transition: background 0.15s;
}

.audit-entry:hover {
  background: var(--bg-secondary);
}

.audit-icon {
  flex-shrink: 0;
  font-size: 12px;
}

.audit-time {
  flex-shrink: 0;
  color: var(--text-muted);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
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
  font-family: var(--font-mono, monospace);
  font-size: 10px;
}

.audit-task_error .audit-summary {
  color: var(--accent-error, #f85149);
}

.audit-confirm .audit-summary {
  color: var(--warning-color, #d29922);
}

/* ==================== IM 平台卡片 ==================== */
.im-platform-card {
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color 0.2s;
}

.im-platform-card.connected {
  border-color: rgba(63, 185, 80, 0.3);
}

.im-platform-card.expanded {
  border-color: var(--accent-primary);
}

.im-platform-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}

.im-platform-header:hover {
  background: var(--bg-surface, var(--bg-primary));
}

/* 平台图标 */
.im-platform-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(56, 132, 244, 0.12);
  color: #3884f4;
  flex-shrink: 0;
}

.im-platform-icon.feishu {
  background: rgba(51, 112, 255, 0.12);
  color: #3370ff;
}

.im-platform-name {
  font-weight: 600;
  font-size: 13px;
}

/* 状态指示器 */
.im-status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(110, 118, 129, 0.08);
}

.im-status-indicator.connected {
  color: var(--success-color, #3fb950);
  background: rgba(63, 185, 80, 0.1);
}

.im-status-indicator.connecting {
  color: var(--warning-color, #d29922);
  background: rgba(210, 153, 34, 0.1);
}

.indicator-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.im-status-indicator.connected .indicator-dot {
  box-shadow: 0 0 6px var(--success-color, #3fb950);
}

.im-status-indicator.connecting .indicator-dot {
  animation: blink 1s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* 展开/收起箭头 */
.toggle-arrow {
  margin-left: auto;
  font-size: 14px;
  color: var(--text-muted);
  transition: transform 0.2s;
  font-weight: 300;
}

.toggle-arrow.open {
  transform: rotate(90deg);
}

/* 平台详情面板 */
.im-platform-body {
  padding: 14px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.im-hint {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  margin-bottom: 14px;
  padding: 8px 12px;
  background: rgba(137, 180, 250, 0.06);
  border-radius: 6px;
  border-left: 3px solid var(--accent-primary);
}

/* 卡片底部操作栏 */
.im-card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 4px;
}

.auto-connect-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.auto-connect-label input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
  accent-color: var(--accent-primary);
}

.auto-connect-label:hover {
  color: var(--text-primary);
}
</style>
