<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Copy,
  Check,
  RefreshCw,
  ChevronDown,
  AlertTriangle,
  Puzzle,
  Loader2,
  ExternalLink,
  Plus,
} from 'lucide-vue-next'
import { showConfirm } from '../../composables/useConfirm'
import {
  BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL,
  BROWSER_BRIDGE_CHROMIUM_CWS_LISTING_URL,
  isBrowserBridgeComponentsInstalled,
  isChromiumBridgeConnection,
  isFirefoxBridgeConnection,
  type BrowserBridgeStatus,
} from '@shared/types/browser-bridge'

const { t } = useI18n()

/** 选择器只分两路：Chromium 系（Chrome/Edge/…）与 Firefox */
type BrowserFamily = 'chromium' | 'firefox'

const installing = ref(false)
const uninstalling = ref(false)
const checking = ref(false)
const status = ref<BrowserBridgeStatus | null>(null)
const errorMsg = ref('')
const actionMsg = ref('')
const loadReadyMsg = ref<BrowserFamily | null>(null)
let actionMsgTimer: ReturnType<typeof setTimeout> | null = null
let loadReadyTimer: ReturnType<typeof setTimeout> | null = null

const copiedPathKey = ref<string | null>(null)
let copiedPathTimer: ReturnType<typeof setTimeout> | null = null

const selectedFamily = ref<BrowserFamily>('chromium')
const manualSelect = ref(false)
// 已连接时把「选择浏览器」主区收起，点「连接其他浏览器」再展开
const showSetup = ref(false)

const isMac = computed(() => navigator.platform.toLowerCase().includes('mac'))
const chromiumPath = computed(() => status.value?.install?.chromiumExtensionPath ?? '')
const firefoxPath = computed(() => status.value?.install?.firefoxExtensionPath ?? '')
const chromiumFolderName = computed(() => folderBaseName(chromiumPath.value) || 'extension-chromium')
const firefoxManifestPath = computed(() =>
  firefoxPath.value ? `${firefoxPath.value}/manifest.json` : '',
)

function folderBaseName(filePath: string): string {
  if (!filePath) return ''
  const sep = filePath.includes('\\') ? '\\' : '/'
  return filePath.slice(filePath.lastIndexOf(sep) + 1)
}

function parentFolder(filePath: string): string {
  const sep = filePath.includes('\\') ? '\\' : '/'
  const idx = filePath.lastIndexOf(sep)
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

const componentsInstalled = computed(() => isBrowserBridgeComponentsInstalled(status.value?.install))

const connections = computed(() => status.value?.connections ?? [])
const chromiumConnection = computed(() => connections.value.find(isChromiumBridgeConnection))
const firefoxConnection = computed(() => connections.value.find(isFirefoxBridgeConnection))
const chromiumConnected = computed(() => Boolean(chromiumConnection.value))
const firefoxConnected = computed(() => Boolean(firefoxConnection.value))
const firefoxHostPermissionsMissing = computed(
  () => firefoxConnected.value && firefoxConnection.value?.hostPermissionsGranted === false,
)
const anyConnected = computed(() => chromiumConnected.value || firefoxConnected.value)

// —— 选择器派生态 ——
const browserOptions = computed<{ id: BrowserFamily; label: string }[]>(() => [
  { id: 'chromium', label: t('browserBridge.browserChromium') },
  { id: 'firefox', label: t('browserBridge.browserFirefox') },
])
const selectedConnected = computed(() =>
  selectedFamily.value === 'firefox' ? firefoxConnected.value : chromiumConnected.value,
)
const selectedConnection = computed(() =>
  selectedFamily.value === 'firefox' ? firefoxConnection.value : chromiumConnection.value,
)
const selectedWaiting = computed(
  () => !selectedConnected.value && loadReadyMsg.value === selectedFamily.value,
)

function familyConnected(family: BrowserFamily): boolean {
  return family === 'firefox' ? firefoxConnected.value : chromiumConnected.value
}

function pickFamily(id: BrowserFamily) {
  selectedFamily.value = id
  manualSelect.value = true
}

/** 首次/刷新后自动聚焦到「还没连上的」一路，减少用户找入口的成本 */
function autoFocusBrowser() {
  if (manualSelect.value) return
  if (!chromiumConnected.value) selectedFamily.value = 'chromium'
  else if (!firefoxConnected.value) selectedFamily.value = 'firefox'
}

function connectionStatusText(connected: boolean, version?: string): string {
  if (!connected) return t('browserBridge.statusExtensionDisconnected')
  return version
    ? t('browserBridge.statusExtensionConnectedVersion', { version })
    : t('browserBridge.statusExtensionConnected')
}

function flashActionMsg(msg: string) {
  actionMsg.value = msg
  if (actionMsgTimer) clearTimeout(actionMsgTimer)
  actionMsgTimer = setTimeout(() => {
    actionMsg.value = ''
  }, 4000)
}

function flashLoadReady(family: BrowserFamily) {
  loadReadyMsg.value = family
  if (loadReadyTimer) clearTimeout(loadReadyTimer)
  loadReadyTimer = setTimeout(() => {
    loadReadyMsg.value = null
  }, 10000)
}

async function refreshStatus() {
  checking.value = true
  try {
    status.value = await window.electronAPI.browserBridge.getStatus()
    autoFocusBrowser()
    const held = status.value.install?.heldNotice?.message
    if (held) errorMsg.value = held
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    checking.value = false
  }
}

async function install() {
  const wasInstalled = componentsInstalled.value
  installing.value = true
  errorMsg.value = ''
  actionMsg.value = ''
  try {
    const result = await window.electronAPI.browserBridge.install()
    if (result.errors?.length) {
      errorMsg.value = result.errors.join('\n')
    } else {
      flashActionMsg(
        wasInstalled ? t('browserBridge.reinstallSuccess') : t('browserBridge.installSuccessShort'),
      )
    }
    await refreshStatus()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    installing.value = false
  }
}

async function uninstall() {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.confirm'),
    message: t('browserBridge.confirmUninstall'),
  })
  if (!confirmed) return
  uninstalling.value = true
  errorMsg.value = ''
  actionMsg.value = ''
  try {
    const result = await window.electronAPI.browserBridge.uninstall()
    if (result.errors?.length) {
      errorMsg.value = result.errors.join('\n')
    } else {
      flashActionMsg(t('browserBridge.uninstallSuccess'))
    }
    await refreshStatus()
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    uninstalling.value = false
  }
}

async function copyExtensionPath(family: BrowserFamily) {
  const folderPath = family === 'chromium' ? chromiumPath.value : firefoxPath.value
  if (!folderPath) return
  try {
    await navigator.clipboard.writeText(folderPath)
    copiedPathKey.value = family
    if (copiedPathTimer) clearTimeout(copiedPathTimer)
    copiedPathTimer = setTimeout(() => {
      copiedPathKey.value = null
    }, 2500)
  } catch {
    errorMsg.value = t('browserBridge.copyFailed')
  }
}

async function revealExtensionFolder(family: BrowserFamily) {
  const folderPath = family === 'chromium' ? chromiumPath.value : firefoxPath.value
  if (!folderPath) return
  if (family === 'firefox' && isMac.value && firefoxManifestPath.value) {
    await window.electronAPI.shell.showItemInFolder(firefoxManifestPath.value)
    return
  }
  const openTarget = family === 'chromium' && isMac.value
    ? parentFolder(folderPath)
    : folderPath
  await window.electronAPI.shell.openPath(openTarget)
}

async function startLoadChromium(browser: 'chrome' | 'edge') {
  if (!chromiumPath.value) return
  errorMsg.value = ''
  if (!isMac.value) await copyExtensionPath('chromium')
  try {
    await window.electronAPI.browserBridge.openExtensionGuide(browser)
  } catch {
    errorMsg.value = t(`browserBridge.openGuideFailed.${browser}`)
    return
  }
  await revealExtensionFolder('chromium')
  flashLoadReady('chromium')
}

async function startLoadFirefox() {
  if (!firefoxPath.value) return
  errorMsg.value = ''
  if (!isMac.value) await copyExtensionPath('firefox')
  try {
    await window.electronAPI.browserBridge.openExtensionGuide('firefox')
  } catch {
    errorMsg.value = t('browserBridge.openGuideFailed.firefox')
    return
  }
  await revealExtensionFolder('firefox')
  flashLoadReady('firefox')
}

/** 手动加载默认打开 Chrome 扩展页；Edge 在模板里另有入口 */
function primaryLoad() {
  if (selectedFamily.value === 'firefox') return
  void startLoadChromium('chrome')
}

let unsubConnections: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null

function startPollingIfNeeded() {
  if (pollTimer) return
  // 如果有浏览器未连接，每 4s 自动刷新一次，最长 90s
  let elapsed = 0
  pollTimer = setInterval(async () => {
    elapsed += 4
    if (anyConnected.value || elapsed >= 90) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
      return
    }
    await refreshStatus()
  }, 4000)
}

onMounted(() => {
  void refreshStatus().then(startPollingIfNeeded)
  unsubConnections = window.electronAPI.browserBridge.onConnectionsChanged((next) => {
    status.value = next
    autoFocusBrowser()
    if (anyConnected.value && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  })
})

onUnmounted(() => {
  unsubConnections?.()
  if (actionMsgTimer) clearTimeout(actionMsgTimer)
  if (copiedPathTimer) clearTimeout(copiedPathTimer)
  if (loadReadyTimer) clearTimeout(loadReadyTimer)
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
})
</script>

<template>
  <div class="bb">
    <!-- ============ 未安装：引导安装本机组件 ============ -->
    <div v-if="!componentsInstalled" class="bb-onboard">
      <div class="bb-onboard-badge">
        <Puzzle :size="26" />
      </div>
      <h4 class="bb-onboard-title">{{ t('browserBridge.title') }}</h4>
      <p class="bb-onboard-desc">{{ t('browserBridge.installIntro') }}</p>
      <button
        type="button"
        class="btn btn-primary bb-onboard-cta"
        :disabled="installing"
        @click="install"
      >
        <Loader2 v-if="installing" :size="15" class="spinning" />
        {{ installing ? t('browserBridge.installing') : t('browserBridge.install') }}
      </button>
      <p v-if="actionMsg" class="bb-flash">{{ actionMsg }}</p>
      <div v-if="errorMsg" class="bb-error">{{ errorMsg }}</div>
    </div>

    <template v-else>
      <!-- ============ 页头 ============ -->
      <header class="bb-header">
        <div class="bb-header-text">
          <h4 class="bb-title">{{ t('browserBridge.title') }}</h4>
          <p class="bb-subtitle">{{ t('browserBridge.description') }}</p>
        </div>
        <button
          type="button"
          class="bb-icon-btn"
          :disabled="checking"
          :title="checking ? t('browserBridge.rechecking') : t('browserBridge.refresh')"
          :aria-label="checking ? t('browserBridge.rechecking') : t('browserBridge.refresh')"
          @click="refreshStatus"
        >
          <RefreshCw :size="15" :class="{ spinning: checking }" />
        </button>
      </header>

      <!-- 已连接汇总条 -->
      <div v-if="anyConnected" class="bb-summary">
        <Check :size="15" class="bb-summary-icon" />
        <span class="bb-summary-text">{{ t('browserBridge.connectedSummary') }}</span>
        <span class="bb-summary-chips">
          <span v-if="chromiumConnected" class="bb-chip">
            🌐 {{ t('browserBridge.browserChromium') }}{{ chromiumConnection?.version ? ` · v${chromiumConnection.version}` : '' }}
          </span>
          <span v-if="firefoxConnected" class="bb-chip">
            🦊 {{ t('browserBridge.browserFirefox') }}{{ firefoxConnection?.version ? ` · v${firefoxConnection.version}` : '' }}
          </span>
        </span>
      </div>

      <p v-if="actionMsg" class="bb-flash">{{ actionMsg }}</p>
      <div v-if="errorMsg" class="bb-error">{{ errorMsg }}</div>

      <!-- 已连接时：主区收起为一个轻量入口 -->
      <button
        v-if="anyConnected && !showSetup"
        type="button"
        class="bb-connect-more"
        @click="showSetup = true"
      >
        <Plus :size="14" />
        {{ t('browserBridge.connectAnother') }}
      </button>

      <!-- ============ 浏览器选择器 + 聚焦面板 ============ -->
      <section v-show="!anyConnected || showSetup" class="bb-setup">
        <div class="bb-setup-head">
          <span class="bb-setup-title">{{ t('browserBridge.setupTitle') }}</span>
        </div>
        <p class="bb-setup-desc">{{ t('browserBridge.setupDesc') }}</p>

        <!-- 选择器 -->
        <div class="bb-picker" role="tablist">
          <button
            v-for="opt in browserOptions"
            :key="opt.id"
            type="button"
            role="tab"
            class="bb-picker-item"
            :class="{ active: selectedFamily === opt.id }"
            :aria-selected="selectedFamily === opt.id"
            @click="pickFamily(opt.id)"
          >
            <span class="bb-picker-emoji" aria-hidden="true">{{ opt.id === 'firefox' ? '🦊' : '🌐' }}</span>
            <span class="bb-picker-label">{{ opt.label }}</span>
            <span
              v-if="familyConnected(opt.id)"
              class="bb-picker-dot"
              :title="t('browserBridge.statusExtensionConnected')"
            />
          </button>
        </div>

        <!-- 聚焦面板 -->
        <div class="bb-pane" :class="{ 'is-connected': selectedConnected }">
          <div class="bb-pane-head">
            <span
              class="bb-brand-badge"
              :class="selectedFamily === 'firefox' ? 'bb-brand-badge--firefox' : 'bb-brand-badge--chromium'"
              aria-hidden="true"
            >{{ selectedFamily === 'firefox' ? '🦊' : '🌐' }}</span>
            <div class="bb-pane-status" :class="selectedConnected ? 'is-on' : 'is-off'">
              <span class="bb-status-dot" />
              {{ connectionStatusText(selectedConnected, selectedConnection?.version) }}
            </div>
          </div>

          <!-- 已连接：无需再做任何事 -->
          <template v-if="selectedConnected">
            <div
              v-if="selectedFamily === 'firefox' && firefoxHostPermissionsMissing"
              class="bb-alert"
            >
              <AlertTriangle :size="15" class="bb-alert-icon" />
              <span>{{ t('browserBridge.firefoxHostPermissionMissing') }}</span>
            </div>
          </template>

          <!-- 未连接：展示该浏览器的加载引导 -->
          <template v-else>
            <!-- Chromium 系 -->
            <template v-if="selectedFamily === 'chromium'">
              <a
                class="btn btn-primary bb-pane-cta"
                :href="BROWSER_BRIDGE_CHROMIUM_CWS_LISTING_URL"
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink :size="14" />
                {{ t('browserBridge.chromiumStoreInstall') }}
              </a>
              <p class="bb-note">{{ t('browserBridge.chromiumStoreNote') }}</p>

              <details class="bb-guide">
                <summary class="bb-guide-summary">
                  {{ t('browserBridge.devLoadFallback') }}
                  <ChevronDown :size="14" class="bb-chev" />
                </summary>
                <div class="bb-guide-body">
                  <div class="bb-pane-actions">
                    <button type="button" class="btn btn-sm btn-outline" @click="primaryLoad">
                      <ExternalLink :size="13" />
                      {{ isMac ? t('browserBridge.startLoadChromeMac') : t('browserBridge.startLoadChrome') }}
                    </button>
                    <button type="button" class="btn btn-sm btn-outline" @click="startLoadChromium('edge')">
                      <ExternalLink :size="13" />
                      {{ t('browserBridge.startLoadEdge') }}
                    </button>
                    <button
                      v-if="!isMac"
                      type="button"
                      class="btn btn-sm btn-outline"
                      @click="copyExtensionPath('chromium')"
                    >
                      <Check v-if="copiedPathKey === 'chromium'" :size="13" />
                      <Copy v-else :size="13" />
                      {{ copiedPathKey === 'chromium' ? t('browserBridge.copied') : t('browserBridge.copyPath') }}
                    </button>
                  </div>
                  <p class="bb-note bb-note--sub">{{ t('browserBridge.otherChromiumHint') }}</p>
                  <ol class="bb-steps">
                    <template v-if="isMac">
                      <li>{{ t('browserBridge.dragStep1') }}</li>
                      <li>{{ t('browserBridge.dragStep2') }}</li>
                      <li>
                        {{ t('browserBridge.dragStep3Prefix') }}
                        <code class="bb-code">{{ chromiumFolderName }}</code>
                        {{ t('browserBridge.dragStep3Suffix') }}
                      </li>
                    </template>
                    <template v-else>
                      <li>{{ t('browserBridge.chromeStep2') }}</li>
                      <li>{{ t('browserBridge.chromeStep3Win') }}</li>
                    </template>
                  </ol>
                </div>
              </details>
            </template>

            <!-- Firefox -->
            <template v-else>
              <div class="bb-pane-actions">
                <a
                  class="btn btn-primary bb-firefox-btn"
                  :href="BROWSER_BRIDGE_FIREFOX_AMO_LISTING_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink :size="14" />
                  {{ t('browserBridge.firefoxAmoInstall') }}
                </a>
              </div>
              <p class="bb-note">{{ t('browserBridge.firefoxHostPermissionNote') }}</p>

              <details class="bb-guide">
                <summary class="bb-guide-summary">
                  {{ t('browserBridge.howToLoadFirefoxTemp') }}
                  <ChevronDown :size="14" class="bb-chev" />
                </summary>
                <div class="bb-guide-body">
                  <ol class="bb-steps">
                    <template v-if="isMac">
                      <li>{{ t('browserBridge.firefoxDragStep1') }}</li>
                      <li>{{ t('browserBridge.firefoxDragStep2') }}</li>
                      <li>
                        {{ t('browserBridge.firefoxDragStep3Prefix') }}
                        <code class="bb-code">manifest.json</code>
                        {{ t('browserBridge.firefoxDragStep3Suffix') }}
                      </li>
                    </template>
                    <template v-else>
                      <li>{{ t('browserBridge.firefoxStep2') }}</li>
                      <li>{{ t('browserBridge.firefoxStep3') }}</li>
                    </template>
                  </ol>
                  <div class="bb-pane-actions">
                    <button type="button" class="btn btn-sm btn-outline" @click="startLoadFirefox">
                      {{ t('browserBridge.startLoadFirefoxTemp') }}
                    </button>
                  </div>
                  <p class="bb-note bb-note--sub">{{ t('browserBridge.firefoxTempNote') }}</p>
                </div>
              </details>
            </template>

            <!-- 加载后就绪 / 等待连接提示 -->
            <p v-if="loadReadyMsg === selectedFamily" class="bb-ready">
              {{
                selectedFamily === 'firefox'
                  ? (isMac ? t('browserBridge.loadFirefoxReadyMac') : t('browserBridge.loadFirefoxReady'))
                  : (isMac ? t('browserBridge.loadExtensionReadyMac') : t('browserBridge.loadExtensionReady'))
              }}
            </p>
            <p v-if="selectedWaiting" class="bb-waiting">
              <Loader2 :size="14" class="spinning" />
              {{ t('browserBridge.waitingConnection') }}
            </p>
          </template>
        </div>
      </section>

      <!-- ============ 连接组件（两个按钮，不折叠） ============ -->
      <div class="bb-manage">
        <div class="bb-manage-text">
          <span class="bb-manage-label">{{ t('browserBridge.manageTitle') }}</span>
          <span class="bb-manage-hint">{{ t('browserBridge.manageHint') }}</span>
        </div>
        <div class="bb-manage-actions">
          <button
            type="button"
            class="btn btn-sm btn-outline"
            :disabled="installing || uninstalling"
            @click="install"
          >
            {{ installing ? t('browserBridge.installing') : t('browserBridge.reinstall') }}
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline bb-danger"
            :disabled="installing || uninstalling"
            @click="uninstall"
          >
            {{ uninstalling ? t('browserBridge.uninstalling') : t('browserBridge.uninstall') }}
          </button>
        </div>
      </div>

      <!-- ============ 遇到问题？（合并故障排查） ============ -->
      <details class="bb-fold">
        <summary class="bb-fold-summary">
          {{ t('browserBridge.helpTitle') }}
          <ChevronDown :size="15" class="bb-chev" />
        </summary>
        <div class="bb-fold-body">
          <div class="bb-help-block">
            <div class="bb-help-label">{{ t('browserBridge.troubleshootTitle') }}</div>
            <ol class="bb-steps">
              <li>{{ t('browserBridge.troubleshootStep1') }}</li>
              <li>
                {{ t('browserBridge.troubleshootStep2Prefix') }}
                <code class="bb-code">{{ status?.extensionIds?.chromium }}</code>
                {{ t('browserBridge.troubleshootStep2Suffix') }}
              </li>
              <li>{{ t('browserBridge.troubleshootStep3') }}</li>
              <li>{{ t('browserBridge.troubleshootStep4') }}</li>
              <li>{{ t('browserBridge.troubleshootStep5') }}</li>
            </ol>
          </div>
          <div class="bb-help-block">
            <div class="bb-help-label">{{ t('browserBridge.firefoxTroubleshootTitle') }}</div>
            <ol class="bb-steps">
              <li>{{ t('browserBridge.firefoxTroubleshootPermStep') }}</li>
              <li>{{ t('browserBridge.firefoxTroubleshootReloadStep') }}</li>
            </ol>
          </div>
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.bb {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.spinning {
  animation: bb-spin 0.8s linear infinite;
}

@keyframes bb-spin {
  to { transform: rotate(360deg); }
}

/* ---------- 未安装引导 ---------- */
.bb-onboard {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 10px;
  padding: 36px 24px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.bb-onboard-badge {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: 12px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  margin-bottom: 4px;
}

.bb-onboard-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.bb-onboard-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
  max-width: 420px;
  margin: 0;
}

.bb-onboard-cta {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  min-width: 200px;
  padding: 9px 20px;
  font-weight: 600;
}

/* ---------- 页头 ---------- */
.bb-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.bb-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 4px;
  color: var(--text-primary);
}

.bb-subtitle {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.55;
  margin: 0;
  max-width: 460px;
}

.bb-icon-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  cursor: pointer;
  flex-shrink: 0;
  transition: color 0.15s, border-color 0.15s;
}

.bb-icon-btn:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

.bb-icon-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* ---------- 已连接汇总条 ---------- */
.bb-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--bg-tertiary);
}

.bb-summary-icon {
  color: var(--color-success);
  flex-shrink: 0;
}

.bb-summary-text {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
}

.bb-summary-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}

.bb-chip {
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  white-space: nowrap;
}

/* ---------- 设置区（选择器 + 面板） ---------- */
.bb-setup {
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.bb-setup-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.bb-setup-desc {
  margin: 5px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-muted);
}

/* 选择器 */
.bb-picker {
  display: flex;
  gap: 4px;
  margin-top: 14px;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.bb-picker-item {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.bb-picker-item:hover {
  color: var(--text-primary);
}

.bb-picker-item.active {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.bb-picker-emoji {
  font-size: 15px;
  line-height: 1;
}

.bb-picker-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success);
}

/* 聚焦面板：直接坐在设置区上，不再套一层带边框的盒子 */
.bb-pane {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.bb-pane-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bb-brand-badge {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  font-size: 19px;
  flex-shrink: 0;
  background: var(--bg-hover);
}

.bb-pane-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 500;
}

.bb-pane-status.is-on {
  color: var(--color-success);
}

.bb-pane-status.is-off {
  color: var(--text-muted);
}

.bb-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.bb-pane-cta {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-top: 14px;
}

.bb-firefox-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.bb-pane-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

/* ---------- 步骤 / 提示 ---------- */
.bb-steps {
  margin: 14px 0 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-secondary);
}

.bb-steps li + li {
  margin-top: 6px;
}

.bb-note {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}

.bb-note--sub {
  margin-top: 8px;
}

.bb-ready {
  margin: 12px 0 0;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 6px;
}

.bb-waiting {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.bb-waiting .spinning {
  color: var(--accent-primary);
}

.bb-alert {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0 0;
  padding: 9px 11px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--color-warning);
  background: rgba(var(--color-warning-rgb), 0.1);
  border-radius: 6px;
}

.bb-alert-icon {
  flex-shrink: 0;
  margin-top: 1px;
}

/* ---------- 折叠指引（面板内） ---------- */
.bb-guide {
  margin-top: 12px;
}

.bb-guide-summary,
.bb-fold-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  cursor: pointer;
  user-select: none;
  list-style: none;
  color: var(--text-secondary);
  font-size: 12.5px;
  transition: color 0.15s;
}

.bb-guide-summary::-webkit-details-marker,
.bb-fold-summary::-webkit-details-marker {
  display: none;
}

.bb-guide-summary:hover,
.bb-fold-summary:hover {
  color: var(--text-primary);
}

.bb-chev {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s;
}

details[open] > .bb-guide-summary .bb-chev,
details[open] > .bb-fold-summary .bb-chev {
  transform: rotate(180deg);
}

.bb-guide-body {
  padding-top: 10px;
}

/* ---------- 「连接其他浏览器」轻量入口 ---------- */
.bb-connect-more {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 6px 4px;
  border: none;
  background: transparent;
  color: var(--accent-primary);
  font-size: 12.5px;
  cursor: pointer;
}

.bb-connect-more:hover {
  text-decoration: underline;
}

/* ---------- 合并故障排查块 ---------- */
.bb-help-block + .bb-help-block {
  margin-top: 16px;
}

.bb-help-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
}

.bb-help-block .bb-steps {
  margin-top: 8px;
}

/* ---------- 底部折叠区块 ---------- */
.bb-fold {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
}

.bb-fold-summary {
  padding: 12px 16px;
  font-weight: 500;
}

.bb-fold-body {
  padding: 4px 16px 16px;
}

.bb-fold-body .bb-note {
  margin-top: 10px;
}

.bb-manage {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.bb-manage-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.bb-manage-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.bb-manage-hint {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--text-tertiary);
}

.bb-manage-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* ---------- 代码 / 消息 ---------- */
.bb-code {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 11px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--accent-primary);
  word-break: break-all;
}

.bb-flash {
  font-size: 12.5px;
  color: var(--text-muted);
  margin: 0;
}

.bb-error {
  color: var(--color-error);
  font-size: 12px;
  line-height: 1.55;
  margin: 0;
  padding: 9px 12px;
  background: rgba(var(--color-error-rgb), 0.08);
  border-radius: 6px;
  border-left: 3px solid var(--color-error);
  white-space: pre-wrap;
}

.bb-danger {
  color: var(--color-error);
  border-color: rgba(var(--color-error-rgb), 0.4);
}

.bb-danger:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.08);
}

/* ---------- 窄屏 ---------- */
@media (max-width: 520px) {
  .bb-header {
    flex-direction: column;
  }

  .bb-summary-chips {
    margin-left: 0;
    width: 100%;
  }

  .bb-picker {
    flex-direction: column;
  }
}
</style>
