<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const dingtalkExpanded = ref(false)
const feishuExpanded = ref(false)
const slackExpanded = ref(false)
const telegramExpanded = ref(false)
const wecomExpanded = ref(false)

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
// Slack
const slBotToken = ref('')
const slAppToken = ref('')
const slConnected = ref(false)
const slConnecting = ref(false)
const slError = ref('')
// Telegram
const tgBotToken = ref('')
const tgConnected = ref(false)
const tgConnecting = ref(false)
const tgError = ref('')
// 企业微信
const wcCorpId = ref('')
const wcCorpSecret = ref('')
const wcAgentId = ref(0)
const wcToken = ref('')
const wcEncodingAESKey = ref('')
const wcCallbackPort = ref(3722)
const wcConnected = ref(false)
const wcConnecting = ref(false)
const wcError = ref('')
// 每平台自动连接
const dtAutoConnect = ref(false)
const fsAutoConnect = ref(false)
const slAutoConnect = ref(false)
const tgAutoConnect = ref(false)
const wcAutoConnect = ref(false)
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
    } else if (data.platform === 'slack') {
      slConnected.value = data.connected
      if (!data.connected) slConnecting.value = false
    } else if (data.platform === 'telegram') {
      tgConnected.value = data.connected
      if (!data.connected) tgConnecting.value = false
    } else if (data.platform === 'wecom') {
      wcConnected.value = data.connected
      if (!data.connected) wcConnecting.value = false
    }
  })
})

onUnmounted(() => {
  cleanupImListener?.()
})

async function loadIMSettings() {
  try {
    const status = await window.electronAPI.im.getStatus()
    dtConnected.value = status.dingtalk?.connected ?? false
    fsConnected.value = status.feishu?.connected ?? false
    slConnected.value = status.slack?.connected ?? false
    tgConnected.value = status.telegram?.connected ?? false
    wcConnected.value = status.wecom?.connected ?? false

    const config = await window.electronAPI.im.getConfig()
    dtClientId.value = config.dingtalk?.clientId || ''
    dtClientSecret.value = config.dingtalk?.clientSecret || ''
    dtAutoConnect.value = config.dingtalk?.autoConnect || false
    fsAppId.value = config.feishu?.appId || ''
    fsAppSecret.value = config.feishu?.appSecret || ''
    fsAutoConnect.value = config.feishu?.autoConnect || false
    slBotToken.value = config.slack?.botToken || ''
    slAppToken.value = config.slack?.appToken || ''
    slAutoConnect.value = config.slack?.autoConnect || false
    tgBotToken.value = config.telegram?.botToken || ''
    tgAutoConnect.value = config.telegram?.autoConnect || false
    wcCorpId.value = config.wecom?.corpId || ''
    wcCorpSecret.value = config.wecom?.corpSecret || ''
    wcAgentId.value = config.wecom?.agentId || 0
    wcToken.value = config.wecom?.token || ''
    wcEncodingAESKey.value = config.wecom?.encodingAESKey || ''
    wcCallbackPort.value = config.wecom?.callbackPort || 3722
    wcAutoConnect.value = config.wecom?.autoConnect || false
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

async function toggleSlack() {
  slError.value = ''
  if (slConnected.value) {
    await window.electronAPI.im.stopSlack()
    slConnected.value = false
  } else {
    if (!slBotToken.value || !slAppToken.value) {
      slError.value = 'Bot Token and App Token are required'
      return
    }
    slConnecting.value = true
    try {
      const result = await window.electronAPI.im.startSlack({
        enabled: true,
        botToken: slBotToken.value,
        appToken: slAppToken.value
      })
      if (result.success) {
        slConnected.value = true
      } else {
        slError.value = result.error || t('settings.im.connectFailed')
      }
    } catch (e: any) {
      slError.value = e.message
    } finally {
      slConnecting.value = false
    }
  }
}

async function toggleTelegram() {
  tgError.value = ''
  if (tgConnected.value) {
    await window.electronAPI.im.stopTelegram()
    tgConnected.value = false
  } else {
    if (!tgBotToken.value) {
      tgError.value = 'Bot Token is required'
      return
    }
    tgConnecting.value = true
    try {
      const result = await window.electronAPI.im.startTelegram({
        enabled: true,
        botToken: tgBotToken.value
      })
      if (result.success) {
        tgConnected.value = true
      } else {
        tgError.value = result.error || t('settings.im.connectFailed')
      }
    } catch (e: any) {
      tgError.value = e.message
    } finally {
      tgConnecting.value = false
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

async function toggleSlAutoConnect() {
  try {
    await window.electronAPI.im.setAutoConnect('slack', slAutoConnect.value)
  } catch {
    slAutoConnect.value = !slAutoConnect.value
  }
}

async function toggleTgAutoConnect() {
  try {
    await window.electronAPI.im.setAutoConnect('telegram', tgAutoConnect.value)
  } catch {
    tgAutoConnect.value = !tgAutoConnect.value
  }
}

async function toggleWeCom() {
  wcError.value = ''
  if (wcConnected.value) {
    await window.electronAPI.im.stopWeCom()
    wcConnected.value = false
  } else {
    if (!wcCorpId.value || !wcCorpSecret.value || !wcAgentId.value) {
      wcError.value = 'Corp ID, Corp Secret and Agent ID are required'
      return
    }
    if (!wcToken.value || !wcEncodingAESKey.value) {
      wcError.value = 'Token and EncodingAESKey are required'
      return
    }
    wcConnecting.value = true
    try {
      const result = await window.electronAPI.im.startWeCom({
        enabled: true,
        corpId: wcCorpId.value,
        corpSecret: wcCorpSecret.value,
        agentId: wcAgentId.value,
        token: wcToken.value,
        encodingAESKey: wcEncodingAESKey.value,
        callbackPort: wcCallbackPort.value || 3722
      })
      if (result.success) {
        wcConnected.value = true
      } else {
        wcError.value = result.error || t('settings.im.connectFailed')
      }
    } catch (e: any) {
      wcError.value = e.message
    } finally {
      wcConnecting.value = false
    }
  }
}

async function toggleWcAutoConnect() {
  try {
    await window.electronAPI.im.setAutoConnect('wecom', wcAutoConnect.value)
  } catch {
    wcAutoConnect.value = !wcAutoConnect.value
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
            <div class="im-hint-header">
              <p class="hint-summary">{{ t('settings.im.dingtalkHint') }}</p>
              <a class="im-channel-help-link" :href="t('settings.im.guideDocUrlDingtalk')" target="_blank" rel="noopener noreferrer">{{ t('settings.im.guideDetailLink') }} ↗</a>
            </div>
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
            <div class="im-hint-header">
              <p class="hint-summary">{{ t('settings.im.feishuHint') }}</p>
              <a class="im-channel-help-link" :href="t('settings.im.guideDocUrlFeishu')" target="_blank" rel="noopener noreferrer">{{ t('settings.im.guideDetailLink') }} ↗</a>
            </div>
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

      <!-- Slack -->
      <div class="im-platform-card" :class="{ expanded: slackExpanded, connected: slConnected }">
        <button class="im-platform-header" @click="slackExpanded = !slackExpanded">
          <span class="im-platform-name">{{ t('settings.im.slack') }}</span>
          <span class="im-status-indicator" :class="{ connected: slConnected, connecting: slConnecting }">
            <span class="indicator-dot"></span>
            {{ slConnecting ? t('settings.im.connecting') : (slConnected ? t('settings.im.connected') : t('settings.im.disconnected')) }}
          </span>
          <span class="toggle-arrow" :class="{ open: slackExpanded }">›</span>
        </button>

        <div v-if="slackExpanded" class="im-platform-body">
          <div class="im-hint">
            <div class="im-hint-header">
              <p class="hint-summary">{{ t('settings.im.slackHint') }}</p>
              <a class="im-channel-help-link" :href="t('settings.im.guideDocUrlSlack')" target="_blank" rel="noopener noreferrer">{{ t('settings.im.guideDetailLink') }} ↗</a>
            </div>
            <ol class="setup-steps">
              <li>{{ t('settings.im.slackStep1') }}</li>
              <li>{{ t('settings.im.slackStep2') }}</li>
              <li>{{ t('settings.im.slackStep3') }}</li>
              <li>{{ t('settings.im.slackStep4') }}</li>
            </ol>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.im.slackBotToken') }}</label>
            <input
              v-model="slBotToken"
              type="password"
              :disabled="slConnected"
              class="input-field"
              placeholder="xoxb-..."
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.slackAppToken') }}</label>
            <input
              v-model="slAppToken"
              type="password"
              :disabled="slConnected"
              class="input-field"
              placeholder="xapp-..."
            />
          </div>

          <div v-if="slError" class="error-msg">{{ slError }}</div>

          <div class="im-card-actions">
            <label class="auto-connect-label">
              <input type="checkbox" v-model="slAutoConnect" @change="toggleSlAutoConnect" />
              <span>{{ t('settings.im.autoConnect') }}</span>
            </label>
            <button
              v-if="slConnected"
              class="btn btn-sm btn-outline-danger"
              @click="toggleSlack"
            >{{ t('settings.im.disconnect') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="slConnecting"
              @click="toggleSlack"
            >{{ slConnecting ? t('settings.im.connecting') : t('settings.im.connect') }}</button>
          </div>
        </div>
      </div>

      <!-- Telegram -->
      <div class="im-platform-card" :class="{ expanded: telegramExpanded, connected: tgConnected }">
        <button class="im-platform-header" @click="telegramExpanded = !telegramExpanded">
          <span class="im-platform-name">{{ t('settings.im.telegram') }}</span>
          <span class="beta-badge" :title="t('settings.im.betaTooltip')">{{ t('settings.im.betaBadge') }}</span>
          <span class="im-status-indicator" :class="{ connected: tgConnected, connecting: tgConnecting }">
            <span class="indicator-dot"></span>
            {{ tgConnecting ? t('settings.im.connecting') : (tgConnected ? t('settings.im.connected') : t('settings.im.disconnected')) }}
          </span>
          <span class="toggle-arrow" :class="{ open: telegramExpanded }">›</span>
        </button>

        <div v-if="telegramExpanded" class="im-platform-body">
          <div class="im-hint">
            <div class="im-hint-header">
              <p class="hint-summary">{{ t('settings.im.telegramHint') }}</p>
              <a class="im-channel-help-link" :href="t('settings.im.guideDocUrlTelegram')" target="_blank" rel="noopener noreferrer">{{ t('settings.im.guideDetailLink') }} ↗</a>
            </div>
            <ol class="setup-steps">
              <li>{{ t('settings.im.telegramStep1') }}</li>
              <li>{{ t('settings.im.telegramStep2') }}</li>
              <li>{{ t('settings.im.telegramStep3') }}</li>
            </ol>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.im.telegramBotToken') }}</label>
            <input
              v-model="tgBotToken"
              type="password"
              :disabled="tgConnected"
              class="input-field"
              placeholder="123456:ABC-DEF..."
            />
          </div>

          <div v-if="tgError" class="error-msg">{{ tgError }}</div>

          <div class="im-card-actions">
            <label class="auto-connect-label">
              <input type="checkbox" v-model="tgAutoConnect" @change="toggleTgAutoConnect" />
              <span>{{ t('settings.im.autoConnect') }}</span>
            </label>
            <button
              v-if="tgConnected"
              class="btn btn-sm btn-outline-danger"
              @click="toggleTelegram"
            >{{ t('settings.im.disconnect') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="tgConnecting"
              @click="toggleTelegram"
            >{{ tgConnecting ? t('settings.im.connecting') : t('settings.im.connect') }}</button>
          </div>
        </div>
      </div>

      <!-- 企业微信 -->
      <div class="im-platform-card" :class="{ expanded: wecomExpanded, connected: wcConnected }">
        <button class="im-platform-header" @click="wecomExpanded = !wecomExpanded">
          <span class="im-platform-name">{{ t('settings.im.wecom') }}</span>
          <span class="beta-badge" :title="t('settings.im.betaTooltip')">{{ t('settings.im.betaBadge') }}</span>
          <span class="im-status-indicator" :class="{ connected: wcConnected, connecting: wcConnecting }">
            <span class="indicator-dot"></span>
            {{ wcConnecting ? t('settings.im.connecting') : (wcConnected ? t('settings.im.connected') : t('settings.im.disconnected')) }}
          </span>
          <span class="toggle-arrow" :class="{ open: wecomExpanded }">›</span>
        </button>

        <div v-if="wecomExpanded" class="im-platform-body">
          <div class="im-hint">
            <div class="im-hint-header">
              <p class="hint-summary">{{ t('settings.im.wecomHint') }}</p>
              <a class="im-channel-help-link" :href="t('settings.im.guideDocUrlWecom')" target="_blank" rel="noopener noreferrer">{{ t('settings.im.guideDetailLink') }} ↗</a>
            </div>
            <ol class="setup-steps">
              <li>{{ t('settings.im.wecomStep1') }}</li>
              <li>{{ t('settings.im.wecomStep2') }}</li>
              <li>{{ t('settings.im.wecomStep3') }}</li>
              <li>{{ t('settings.im.wecomStep4') }}</li>
            </ol>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.im.wecomCorpId') }}</label>
            <input
              v-model="wcCorpId"
              type="text"
              :disabled="wcConnected"
              class="input-field"
              placeholder="Corp ID"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.wecomCorpSecret') }}</label>
            <input
              v-model="wcCorpSecret"
              type="password"
              :disabled="wcConnected"
              class="input-field"
              placeholder="Corp Secret"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.wecomAgentId') }}</label>
            <input
              v-model.number="wcAgentId"
              type="number"
              :disabled="wcConnected"
              class="input-field"
              placeholder="Agent ID"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.wecomToken') }}</label>
            <input
              v-model="wcToken"
              type="password"
              :disabled="wcConnected"
              class="input-field"
              placeholder="Token"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.wecomEncodingAESKey') }}</label>
            <input
              v-model="wcEncodingAESKey"
              type="password"
              :disabled="wcConnected"
              class="input-field"
              placeholder="EncodingAESKey"
            />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('settings.im.wecomCallbackPort') }}</label>
            <input
              v-model.number="wcCallbackPort"
              type="number"
              :disabled="wcConnected"
              class="input-field"
              placeholder="3722"
            />
          </div>

          <div v-if="wcError" class="error-msg">{{ wcError }}</div>

          <div class="im-card-actions">
            <label class="auto-connect-label">
              <input type="checkbox" v-model="wcAutoConnect" @change="toggleWcAutoConnect" />
              <span>{{ t('settings.im.autoConnect') }}</span>
            </label>
            <button
              v-if="wcConnected"
              class="btn btn-sm btn-outline-danger"
              @click="toggleWeCom"
            >{{ t('settings.im.disconnect') }}</button>
            <button
              v-else
              class="btn btn-sm btn-primary"
              :disabled="wcConnecting"
              @click="toggleWeCom"
            >{{ wcConnecting ? t('settings.im.connecting') : t('settings.im.connect') }}</button>
          </div>
        </div>
      </div>

      <div class="security-note">
        {{ t('settings.im.securityNote') }}
      </div>
    </div>

    <!-- 运行模式（独立区块） -->
    <div class="settings-section">
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
    </div>

    <!-- 配置说明 -->
    <div class="settings-section guide-section">
      <div class="section-header">
        <h4>📖 {{ t('settings.im.guideTitle') }}</h4>
        <a class="guide-doc-link" :href="t('settings.im.guideDocUrl')" target="_blank" rel="noopener noreferrer">
          {{ t('settings.im.guideDocLink') }} ↗
        </a>
      </div>
      <p class="section-desc">{{ t('settings.im.guideDesc') }}</p>

      <div class="guide-grid">
        <!-- 钉钉机器人配置 -->
        <div class="guide-card">
          <h5 class="guide-card-title">🔧 {{ t('settings.im.guideDingtalkTitle') }}</h5>
          <ol class="guide-steps">
            <li>{{ t('settings.im.guideDingtalkStep1') }}</li>
            <li>{{ t('settings.im.guideDingtalkStep2') }}</li>
            <li>{{ t('settings.im.guideDingtalkStep3') }}</li>
            <li>{{ t('settings.im.guideDingtalkStep4') }}</li>
            <li>{{ t('settings.im.guideDingtalkStep5') }}</li>
          </ol>
        </div>

        <!-- 飞书机器人配置 -->
        <div class="guide-card">
          <h5 class="guide-card-title">🔧 {{ t('settings.im.guideFeishuTitle') }}</h5>
          <ol class="guide-steps">
            <li>{{ t('settings.im.guideFeishuStep1') }}</li>
            <li>{{ t('settings.im.guideFeishuStep2') }}</li>
            <li>{{ t('settings.im.guideFeishuStep3') }}</li>
            <li>{{ t('settings.im.guideFeishuStep4') }}</li>
            <li>{{ t('settings.im.guideFeishuStep5') }}</li>
            <li>{{ t('settings.im.guideFeishuStep6') }}</li>
            <li>{{ t('settings.im.guideFeishuStep7') }}</li>
          </ol>
        </div>

        <!-- Slack 配置 -->
        <div class="guide-card">
          <h5 class="guide-card-title">🔧 {{ t('settings.im.guideSlackTitle') }}</h5>
          <ol class="guide-steps">
            <li>{{ t('settings.im.guideSlackStep1') }}</li>
            <li>{{ t('settings.im.guideSlackStep2') }}</li>
            <li>{{ t('settings.im.guideSlackStep3') }}</li>
            <li>{{ t('settings.im.guideSlackStep4') }}</li>
            <li>{{ t('settings.im.guideSlackStep5') }}</li>
          </ol>
        </div>

        <!-- Telegram 配置 -->
        <div class="guide-card">
          <h5 class="guide-card-title">🔧 {{ t('settings.im.guideTelegramTitle') }}</h5>
          <ol class="guide-steps">
            <li>{{ t('settings.im.guideTelegramStep1') }}</li>
            <li>{{ t('settings.im.guideTelegramStep2') }}</li>
            <li>{{ t('settings.im.guideTelegramStep3') }}</li>
          </ol>
        </div>

        <!-- 企业微信配置 -->
        <div class="guide-card">
          <h5 class="guide-card-title">🔧 {{ t('settings.im.guideWecomTitle') }}</h5>
          <ol class="guide-steps">
            <li>{{ t('settings.im.guideWecomStep1') }}</li>
            <li>{{ t('settings.im.guideWecomStep2') }}</li>
            <li>{{ t('settings.im.guideWecomStep3') }}</li>
            <li>{{ t('settings.im.guideWecomStep4') }}</li>
            <li>{{ t('settings.im.guideWecomStep5') }}</li>
          </ol>
        </div>

        <!-- 使用提示 -->
        <div class="guide-card">
          <h5 class="guide-card-title">💡 {{ t('settings.im.guideUsageTitle') }}</h5>
          <p class="guide-card-desc">{{ t('settings.im.guideUsageDesc') }}</p>
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
            <div class="command-item">
              <code class="confirm-approve">{{ t('settings.im.guideConfirmApproveWord') }}</code>
              <span>{{ t('settings.im.guideConfirmApprove') }}</span>
            </div>
            <div class="command-item">
              <code class="confirm-reject">{{ t('settings.im.guideConfirmRejectWord') }}</code>
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

.beta-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(210, 153, 34, 0.15);
  color: var(--warning-color, #d29922);
  border: 1px solid rgba(210, 153, 34, 0.3);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  cursor: help;
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

.im-hint-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.im-hint-header .hint-summary {
  margin: 0;
  flex: 1;
  min-width: 0;
}

.im-hint-header .im-channel-help-link {
  flex-shrink: 0;
  margin-top: 0;
  font-size: 12px;
  color: var(--accent-primary);
  text-decoration: none;
}

.im-hint-header .im-channel-help-link:hover {
  text-decoration: underline;
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

/* 配置说明 */
.guide-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.guide-doc-link {
  font-size: 12px;
  color: var(--accent-primary);
  text-decoration: none;
  white-space: nowrap;
}

.guide-doc-link:hover {
  text-decoration: underline;
}

.guide-card-doc-link {
  display: inline-block;
  margin-top: 8px;
  font-size: 12px;
  color: var(--accent-primary);
  text-decoration: none;
}

.guide-card-doc-link:hover {
  text-decoration: underline;
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

.guide-card:nth-last-child(1) {
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

.guide-steps {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.8;
}

.guide-steps li {
  margin: 2px 0;
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
