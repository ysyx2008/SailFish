<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy, ExternalLink, ScrollText } from 'lucide-vue-next'
import AppSelect from '../common/AppSelect.vue'

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

let cleanupAuditListener: (() => void) | null = null

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
          <AppSelect
            v-model="host"
            :disabled="isRunning"
            size="field"
            block
            :options="[
              { value: '0.0.0.0', label: `0.0.0.0 (${t('settings.gateway.allInterfaces')})` },
              { value: '127.0.0.1', label: `127.0.0.1 (${t('settings.gateway.localhostOnly')})` },
            ]"
          />
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

  </div>
</template>

<style scoped>
.gateway-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ==================== 通用区块 ==================== */

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
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
  padding: 8px 12px;
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

/* 设置行、描述文字、开关走 main.css 的 .settings-scope 规范，本页不再重复定义 */

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
  color: var(--danger-color, var(--color-error));
  font-size: 12px;
  margin-bottom: 14px;
  padding: 8px 12px;
  background: rgba(var(--color-error-rgb), 0.08);
  border-radius: 6px;
  border-left: 3px solid var(--danger-color, var(--color-error));
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
  color: var(--color-warning);
  line-height: 1.5;
  padding: 8px 12px;
  background: rgba(var(--color-warning-rgb), 0.06);
  border-radius: 6px;
  border-left: 3px solid rgba(var(--color-warning-rgb), 0.4);
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
  color: var(--color-error);
}

.audit-confirm .audit-summary {
  color: var(--color-warning);
}

</style>
