<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

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
  await loadIMSettings()

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
  cleanupImListener?.()
})

async function loadIMSettings() {
  try {
    const status = await window.electronAPI.im.getStatus()
    dtConnected.value = status.dingtalk.connected
    fsConnected.value = status.feishu.connected

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
</script>

<template>
  <div class="im-settings">

    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.im.title') }}</h4>
      </div>
      <p class="section-desc">{{ t('settings.im.description') }}</p>

      <!-- 钉钉 -->
      <div class="im-platform-card" :class="{ expanded: dingtalkExpanded, connected: dtConnected }">
        <button class="im-platform-header" @click="dingtalkExpanded = !dingtalkExpanded">
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
.im-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 通用区块 */
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

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

/* 表单控件 */
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

/* 错误提示 */
.error-msg {
  color: var(--danger-color, #f85149);
  font-size: 12px;
  margin-bottom: 14px;
  padding: 8px 12px;
  background: rgba(248, 81, 73, 0.08);
  border-radius: 6px;
  border-left: 3px solid var(--danger-color, #f85149);
}

/* 按钮 */
.btn-outline-danger {
  background: transparent;
  border: 1px solid var(--accent-error, #f85149);
  color: var(--accent-error, #f85149);
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(248, 81, 73, 0.1);
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

/* IM 平台卡片 */
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
