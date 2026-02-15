<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, ExternalLink, ScrollText } from 'lucide-vue-next'

const { t } = useI18n()

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
})

onUnmounted(() => {
  cleanupAuditListener?.()
})

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
</style>
