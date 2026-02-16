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
// 执行模式
const executionMode = ref<'strict' | 'relaxed' | 'free'>('relaxed')
// 自由模式二次确认弹窗
const showFreeModeConfirm = ref(false)

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
    executionMode.value = config.executionMode || 'relaxed'
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

async function changeExecutionMode(mode: 'strict' | 'relaxed' | 'free') {
  const oldMode = executionMode.value
  executionMode.value = mode
  try {
    await window.electronAPI.im.setExecutionMode(mode)
  } catch (err) {
    executionMode.value = oldMode
    console.error('Failed to set IM execution mode:', err)
  }
}

function requestFreeMode() {
  showFreeModeConfirm.value = true
}

async function confirmEnableFreeMode() {
  showFreeModeConfirm.value = false
  await changeExecutionMode('free')
}

function cancelFreeMode() {
  showFreeModeConfirm.value = false
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
          <div class="im-hint">
            <p class="hint-summary">{{ t('settings.im.dingtalkHint') }}</p>
            <ol class="setup-steps">
              <li>{{ t('settings.im.dingtalkStep1') }}</li>
              <li>{{ t('settings.im.dingtalkStep2') }}</li>
              <li>{{ t('settings.im.dingtalkStep3') }}</li>
              <li>{{ t('settings.im.dingtalkStep4') }}</li>
            </ol>
          </div>

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
          <div class="im-hint">
            <p class="hint-summary">{{ t('settings.im.feishuHint') }}</p>
            <ol class="setup-steps">
              <li>{{ t('settings.im.feishuStep1') }}</li>
              <li>{{ t('settings.im.feishuStep2') }}</li>
              <li>{{ t('settings.im.feishuStep3') }}</li>
              <li>{{ t('settings.im.feishuStep4') }}</li>
            </ol>
          </div>

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

      <!-- 运行模式 -->
      <div class="execution-mode-section">
        <span class="execution-mode-title">{{ t('settings.im.executionMode') }}</span>
        <div class="execution-mode-selector">
          <button
            class="mode-option"
            :class="{ active: executionMode === 'strict' }"
            @click="changeExecutionMode('strict')"
            :title="t('settings.im.modeStrictDesc')"
          >{{ t('settings.im.modeStrict') }}</button>
          <button
            class="mode-option"
            :class="{ active: executionMode === 'relaxed' }"
            @click="changeExecutionMode('relaxed')"
            :title="t('settings.im.modeRelaxedDesc')"
          >{{ t('settings.im.modeRelaxed') }}</button>
          <button
            class="mode-option mode-option-free"
            :class="{ active: executionMode === 'free' }"
            @click="executionMode === 'free' ? changeExecutionMode('strict') : requestFreeMode()"
            :title="t('settings.im.modeFreeDesc')"
          >{{ t('settings.im.modeFree') }}</button>
        </div>
        <span class="execution-mode-desc">{{ t('settings.im.executionModeDesc') }}</span>
      </div>

      <div class="security-note">
        {{ t('settings.im.securityNote') }}
      </div>
    </div>

    <!-- 使用说明 -->
    <div class="settings-section guide-section">
      <div class="section-header">
        <h4>💡 {{ t('settings.im.guideTitle') }}</h4>
      </div>
      <p class="section-desc">{{ t('settings.im.guideDesc') }}</p>

      <div class="guide-grid">
        <!-- 支持的能力 -->
        <div class="guide-card">
          <h5 class="guide-card-title">{{ t('settings.im.guideFeatures') }}</h5>
          <ul class="guide-list">
            <li>{{ t('settings.im.guideFeature1') }}</li>
            <li>{{ t('settings.im.guideFeature2') }}</li>
            <li>{{ t('settings.im.guideFeature3') }}</li>
            <li>{{ t('settings.im.guideFeature4') }}</li>
          </ul>
        </div>

        <!-- 内置命令 -->
        <div class="guide-card">
          <h5 class="guide-card-title">{{ t('settings.im.guideCommands') }}</h5>
          <div class="command-list">
            <div class="command-item">
              <code>/help</code>
              <span>{{ t('settings.im.guideCommandHelp') }}</span>
            </div>
            <div class="command-item">
              <code>/status</code>
              <span>{{ t('settings.im.guideCommandStatus') }}</span>
            </div>
            <div class="command-item">
              <code>/clear</code>
              <span>{{ t('settings.im.guideCommandClear') }}</span>
            </div>
          </div>
        </div>

        <!-- 操作确认 -->
        <div class="guide-card">
          <h5 class="guide-card-title">{{ t('settings.im.guideConfirmTitle') }}</h5>
          <p class="guide-card-desc">{{ t('settings.im.guideConfirmDesc') }}</p>
          <div class="command-list">
            <div class="command-item">
              <code class="confirm-approve">确认</code>
              <span>{{ t('settings.im.guideConfirmApprove') }}</span>
            </div>
            <div class="command-item">
              <code class="confirm-reject">拒绝</code>
              <span>{{ t('settings.im.guideConfirmReject') }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 自由模式二次确认对话框 -->
    <div v-if="showFreeModeConfirm" class="free-mode-confirm-overlay">
      <div class="free-mode-confirm-dialog">
        <div class="confirm-dialog-header">
          <span class="confirm-dialog-icon">⚠️</span>
          <span class="confirm-dialog-title">{{ t('ai.freeModeConfirmTitle') }}</span>
        </div>
        <div class="confirm-dialog-content">
          <p>{{ t('ai.freeModeConfirmDesc') }}</p>
          <ul class="confirm-dialog-warnings">
            <li>{{ t('ai.freeModeWarning1') }}</li>
            <li>{{ t('ai.freeModeWarning2') }}</li>
            <li>{{ t('ai.freeModeWarning3') }}</li>
          </ul>
        </div>
        <div class="confirm-dialog-actions">
          <button type="button" class="btn btn-sm btn-outline" @click="cancelFreeMode">
            {{ t('common.no') }}
          </button>
          <button type="button" class="btn btn-sm btn-danger" @click="confirmEnableFreeMode">
            {{ t('common.yes') }}
          </button>
        </div>
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
  padding: 10px 12px;
  background: rgba(137, 180, 250, 0.06);
  border-radius: 6px;
  border-left: 3px solid var(--accent-primary);
}

.im-hint .hint-summary {
  margin-bottom: 8px;
  font-weight: 500;
  color: var(--text-secondary);
}

.setup-steps {
  margin: 0;
  padding-left: 18px;
}

.setup-steps li {
  margin-bottom: 4px;
  line-height: 1.5;
}

.setup-steps li:last-child {
  margin-bottom: 0;
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

/* 运行模式 */
.execution-mode-section {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.execution-mode-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.execution-mode-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}

.execution-mode-selector {
  display: flex;
  align-items: center;
  gap: 2px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  padding: 2px;
  border: 1px solid var(--border-color);
}

.mode-option {
  padding: 4px 12px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.mode-option:hover {
  background: var(--bg-surface, var(--bg-primary));
  color: var(--text-primary);
}

.mode-option.active {
  background: var(--accent-primary);
  color: #fff;
}

.mode-option-free.active {
  background: var(--danger-color, #f85149);
}

.mode-option-free:hover:not(.active) {
  background: rgba(248, 81, 73, 0.15);
  color: var(--danger-color, #f85149);
}

/* 自由模式二次确认对话框 */
.free-mode-confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.free-mode-confirm-dialog {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  max-width: 400px;
  width: 100%;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.confirm-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.confirm-dialog-icon {
  font-size: 24px;
}

.confirm-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: #ef4444;
}

.confirm-dialog-content {
  margin-bottom: 20px;
}

.confirm-dialog-content p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.5;
}

.confirm-dialog-warnings {
  margin: 12px 0;
  padding-left: 20px;
}

.confirm-dialog-warnings li {
  font-size: 12px;
  color: #ef4444;
  margin: 6px 0;
  line-height: 1.4;
}

.confirm-dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

/* 使用说明 */
.guide-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.guide-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.guide-card {
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.guide-card:last-child {
  grid-column: 1 / -1;
}

.guide-card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.guide-card-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  margin-bottom: 8px;
}

.guide-list {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.7;
}

.command-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.command-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.command-item code {
  font-family: 'Cascadia Code', 'Fira Code', monospace;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--accent-primary);
  border: 1px solid var(--border-color);
  white-space: nowrap;
}

.command-item code.confirm-approve {
  color: var(--success-color, #3fb950);
  border-color: rgba(63, 185, 80, 0.3);
}

.command-item code.confirm-reject {
  color: var(--danger-color, #f85149);
  border-color: rgba(248, 81, 73, 0.3);
}
</style>
