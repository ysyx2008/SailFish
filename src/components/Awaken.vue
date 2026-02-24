<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../stores/config'
import {
  X, Play, Trash2, Eye, EyeOff, RefreshCw, History,
  Clock, Heart, Globe, Zap, FolderOpen, Calendar, Mail,
  LayoutTemplate, Database, Plus, Power, Sparkles
} from 'lucide-vue-next'

const { t } = useI18n()
const configStore = useConfigStore()

const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{ close: [] }>()

// ==================== Types ====================

type WatchTriggerType = 'cron' | 'interval' | 'heartbeat' | 'webhook' | 'manual' | 'file_change' | 'calendar' | 'email'
type WatchPriority = 'high' | 'normal' | 'low'
type WatchOutputType = 'desktop' | 'im' | 'notification' | 'log' | 'silent'
type WatchRunStatus = 'completed' | 'failed' | 'skipped' | 'timeout' | 'cancelled' | 'running'

interface WatchTrigger {
  type: WatchTriggerType
  expression?: string
  seconds?: number
  token?: string
  paths?: string[]
  pattern?: string
  events?: Array<'add' | 'change' | 'unlink'>
  icsPath?: string
  beforeMinutes?: number
  filter?: { from?: string; subject?: string; unseen?: boolean }
}

interface WatchTemplateInfo {
  id: string; name: string; nameEn: string; description: string; descriptionEn: string; category: string; icon: string
}

interface WatchDefinition {
  id: string; name: string; description?: string; enabled: boolean; triggers: WatchTrigger[]; prompt: string
  skills?: string[]
  execution: { type: 'assistant' | 'local' | 'ssh'; sshSessionId?: string; sshSessionName?: string; workingDirectory?: string; timeout?: number }
  output: { type: WatchOutputType }
  state?: Record<string, unknown>; priority: WatchPriority
  createdAt: number; updatedAt: number; expiresAt?: number
  lastRun?: { at: number; status: WatchRunStatus; duration: number; triggerType: string; output?: string; error?: string; skipReason?: string }
  nextRun?: number
}

interface WatchHistoryRecord {
  id: string; watchId: string; watchName: string; at: number; status: WatchRunStatus; duration: number
  triggerType: string; output?: string; error?: string; skipReason?: string
}

// ==================== Navigation ====================

type NavTab = 'watches' | 'templates' | 'sensors' | 'history' | 'personality'
const VALID_TABS: NavTab[] = ['watches', 'templates', 'sensors', 'history', 'personality']
const activeTab = ref<NavTab>(
  props.initialTab && VALID_TABS.includes(props.initialTab as NavTab) ? props.initialTab as NavTab : 'watches'
)

function switchTab(tab: NavTab, onSwitch?: () => void) {
  if (activeTab.value === 'personality' && tab !== 'personality' && personalityDirty.value) {
    if (!confirm(t('awaken.personalityUnsavedConfirm'))) return
    resetPersonalityText()
  }
  activeTab.value = tab
  onSwitch?.()
}

// ==================== State ====================

const watches = ref<WatchDefinition[]>([])
const watchHistory = ref<WatchHistoryRecord[]>([])
const loading = ref(true)
const selectedWatch = ref<WatchDefinition | null>(null)
const runningWatches = ref<Set<string>>(new Set())

const templates = ref<WatchTemplateInfo[]>([])
const selectedTemplateCategory = ref<string>('all')
const sharedState = ref<Record<string, unknown>>({})
const sensorStatus = ref<Array<{ id: string; name: string; running: boolean; details?: Record<string, any> }>>([])
const recentEvents = ref<Array<{ id: string; type: string; source: string; timestamp: number }>>([])
const personalityText = ref('')
const personalityOriginal = ref('')
const personalitySaving = ref(false)
const personalityError = ref('')
const PERSONALITY_MAX_LENGTH = 1000
const personalityDirty = computed(() => personalityText.value !== personalityOriginal.value)

// ==================== Utilities ====================

const formatDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const formatFullDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`

const getTriggerLabel = (trigger: WatchTrigger): string => {
  switch (trigger.type) {
    case 'cron': return `Cron: ${trigger.expression}`
    case 'interval': { const s = trigger.seconds || 0; return s >= 3600 ? `${s / 3600}h` : `${s / 60}m` }
    case 'heartbeat': return t('watch.triggerHeartbeat')
    case 'webhook': return 'Webhook'
    case 'manual': return t('watch.triggerManual')
    case 'file_change': return t('watch.triggerFileChange')
    case 'calendar': return `${t('watch.triggerCalendar')} (${trigger.beforeMinutes}min)`
    case 'email': return t('watch.triggerEmail')
    default: return trigger.type
  }
}

const getTriggerIcon = (type: WatchTriggerType | string) => {
  const map: Record<string, any> = {
    cron: Clock, interval: RefreshCw, heartbeat: Heart,
    webhook: Globe, manual: Zap,
    file_change: FolderOpen, calendar: Calendar, email: Mail
  }
  return map[type] || Zap
}

const getOutputLabel = (type: WatchOutputType): string => {
  const map: Record<WatchOutputType, string> = { desktop: t('watch.outputDesktop'), im: t('watch.outputIM'), notification: t('watch.outputNotification'), log: t('watch.outputLog'), silent: t('watch.outputSilent') }
  return map[type] || type
}

const getWatchStatusText = (status: WatchRunStatus): string => {
  const map: Record<string, string> = {
    completed: t('watch.statusCompleted'), failed: t('watch.statusFailed'), skipped: t('watch.statusSkipped'),
    timeout: t('watch.statusTimeout'), cancelled: t('watch.statusCancelled'), running: t('watch.statusRunning')
  }
  return map[status] || status
}

const getStatusClass = (status: string): string => {
  const map: Record<string, string> = { completed: 'status-success', success: 'status-success', failed: 'status-error', skipped: 'status-skipped', timeout: 'status-warning', cancelled: 'status-muted', running: 'status-running' }
  return map[status] || ''
}

const getStatusIcon = (status: WatchRunStatus): string => {
  const map: Record<string, string> = { completed: '✓', failed: '✗', skipped: '⊘', timeout: '⏱', cancelled: '—', running: '●' }
  return map[status] || '?'
}

// ==================== Data Loading ====================

const loadWatchData = async () => {
  loading.value = true
  try {
    watches.value = await window.electronAPI.watch.getAll()
    watchHistory.value = await window.electronAPI.watch.getHistory(undefined, 50)
    const running = await window.electronAPI.watch.getRunning()
    runningWatches.value = new Set(running)
  } catch (e) {
    console.error('Failed to load watches:', e)
  } finally {
    loading.value = false
  }
}

const loadTemplates = async () => {
  try { templates.value = await window.electronAPI.watch.getTemplates() } catch (e) { console.error('Failed to load templates:', e) }
}

const loadSharedState = async () => {
  try { sharedState.value = await window.electronAPI.watch.getSharedState() } catch (e) { console.error('Failed to load shared state:', e) }
}

const loadSensorData = async () => {
  try {
    const detailed = window.electronAPI.sensor.getStatusDetailed
    sensorStatus.value = detailed ? await detailed() : await window.electronAPI.sensor.getStatus()
    recentEvents.value = await window.electronAPI.sensor.getRecentEvents(20)
  } catch (e) { console.error('Failed to load sensor data:', e) }
}

const filteredTemplates = computed(() => {
  if (selectedTemplateCategory.value === 'all') return templates.value
  return templates.value.filter(t => t.category === selectedTemplateCategory.value)
})

const enabledCount = computed(() => watches.value.filter(w => w.enabled).length)

// ==================== Watch Operations ====================

const selectWatch = (w: WatchDefinition) => { selectedWatch.value = w }

const toggleWatch = async (w: WatchDefinition) => {
  const updated = await window.electronAPI.watch.toggle(w.id)
  if (updated) {
    const idx = watches.value.findIndex(x => x.id === w.id)
    if (idx >= 0) watches.value[idx] = updated
    if (selectedWatch.value?.id === w.id) selectedWatch.value = updated
  }
}

const RUNNING_TIMEOUT_MS = 10 * 60 * 1000
const watchTimeouts = new Map<string, NodeJS.Timeout>()

const triggerWatch = async (w: WatchDefinition) => {
  try { await window.electronAPI.watch.trigger(w.id) } catch (e) { console.error('Failed to trigger watch:', e) }
}

const markWatchRunning = (watchId: string) => {
  runningWatches.value.add(watchId)
  if (watchTimeouts.has(watchId)) clearTimeout(watchTimeouts.get(watchId)!)
  const timeout = setTimeout(() => { runningWatches.value.delete(watchId); watchTimeouts.delete(watchId); loadWatchData() }, RUNNING_TIMEOUT_MS)
  watchTimeouts.set(watchId, timeout)
}

const markWatchCompleted = (watchId: string) => {
  runningWatches.value.delete(watchId)
  const timeout = watchTimeouts.get(watchId)
  if (timeout) { clearTimeout(timeout); watchTimeouts.delete(watchId) }
  loadWatchData()
}

const deleteWatch = async (w: WatchDefinition) => {
  if (!confirm(t('watch.confirmDelete', { name: w.name }))) return
  await window.electronAPI.watch.delete(w.id)
  if (selectedWatch.value?.id === w.id) selectedWatch.value = null
  await loadWatchData()
}

const clearWatchHistory = async () => {
  if (!confirm(t('watch.confirmClearHistory'))) return
  await window.electronAPI.watch.clearHistory()
  watchHistory.value = []
}

const useTemplate = async (tpl: WatchTemplateInfo) => {
  try {
    const watch = await window.electronAPI.watch.createFromTemplate(tpl.id)
    if (watch) {
      activeTab.value = 'watches'
      await loadWatchData()
      selectedWatch.value = watches.value.find(w => w.id === watch.id) || null
    }
  } catch (e) { console.error('Failed to create from template:', e) }
}

const clearSharedState = async () => {
  if (!confirm(t('watch.confirmClearSharedState'))) return
  await window.electronAPI.watch.clearSharedState()
  sharedState.value = {}
}

const triggerHeartbeat = async () => {
  await window.electronAPI.sensor.triggerHeartbeat()
  setTimeout(loadSensorData, 500)
}

// ==================== 觉醒控制 ====================

const awakened = ref(false)
const heartbeatInterval = ref(30)
const awakenedRunning = ref(false)
const ecgBooting = ref(false)
const ecgBaselineFlashing = ref(false)
const patrolling = ref(false)
const patrolStatus = ref<'idle' | 'running' | 'done' | 'skipped' | 'error'>('idle')
const patrolMessage = ref('')
let patrolStatusTimer: ReturnType<typeof setTimeout> | null = null
let patrolTimeout: ReturnType<typeof setTimeout> | null = null
let ecgBootTimer: ReturnType<typeof setTimeout> | null = null
let ecgFlashTimer: ReturnType<typeof setTimeout> | null = null
let awakenStateHydrated = false

const ECG_BASELINE_FLASH_MS = 320
const ECG_BOOT_MS = 900
const awakenReady = computed(() => awakened.value && !ecgBaselineFlashing.value && !ecgBooting.value)

function clearPatrolStatus() {
  if (patrolStatusTimer) clearTimeout(patrolStatusTimer)
  patrolStatusTimer = setTimeout(() => {
    patrolStatus.value = 'idle'
    patrolMessage.value = ''
  }, 8000)
}

async function loadAwakenSettings() {
  try {
    awakened.value = !!(await window.electronAPI.config.get('agentAwakened'))
    const interval = await window.electronAPI.config.get('watchHeartbeatInterval')
    if (interval && typeof interval === 'number') heartbeatInterval.value = interval
    const statusList = await window.electronAPI.sensor.getStatus()
    awakenedRunning.value = statusList.some((s: any) => s.id === 'heartbeat' && s.running)
  } catch { /* ignore */ }
  finally {
    awakenStateHydrated = true
  }
}

function startEcgBoot() {
  ecgBaselineFlashing.value = true
  ecgBooting.value = false
  if (ecgFlashTimer) clearTimeout(ecgFlashTimer)
  if (ecgBootTimer) clearTimeout(ecgBootTimer)
  ecgFlashTimer = setTimeout(() => {
    ecgBaselineFlashing.value = false
    ecgBooting.value = true
    ecgFlashTimer = null
    ecgBootTimer = setTimeout(() => {
      ecgBooting.value = false
      ecgBootTimer = null
    }, ECG_BOOT_MS)
  }, ECG_BASELINE_FLASH_MS)
}

async function toggleAwakened() {
  const prev = !awakened.value
  try {
    await window.electronAPI.sensor.setAwakened(awakened.value, heartbeatInterval.value)
    awakenedRunning.value = awakened.value
  } catch (e) {
    console.error('Failed to toggle awakened:', e)
    awakened.value = prev
  }
}

watch(awakened, (next, prev) => {
  if (!awakenStateHydrated) return
  if (next && !prev) {
    startEcgBoot()
    return
  }
  if (!next) {
    ecgBaselineFlashing.value = false
    ecgBooting.value = false
    if (ecgFlashTimer) {
      clearTimeout(ecgFlashTimer)
      ecgFlashTimer = null
    }
    if (ecgBootTimer) {
      clearTimeout(ecgBootTimer)
      ecgBootTimer = null
    }
  }
})

async function updateAwakenInterval() {
  if (heartbeatInterval.value < 1) heartbeatInterval.value = 1
  if (heartbeatInterval.value > 1440) heartbeatInterval.value = 1440
  if (awakened.value) {
    await window.electronAPI.sensor.setAwakened(true, heartbeatInterval.value)
  } else {
    await window.electronAPI.config.set('watchHeartbeatInterval', heartbeatInterval.value)
  }
}

async function manualHeartbeat() {
  patrolling.value = true
  patrolStatus.value = 'running'
  patrolMessage.value = t('awaken.patrolRunning')
  if (patrolTimeout) clearTimeout(patrolTimeout)
  patrolTimeout = setTimeout(() => {
    if (patrolling.value) {
      patrolling.value = false
      patrolStatus.value = 'done'
      patrolMessage.value = t('awaken.patrolDone')
      clearPatrolStatus()
    }
  }, 5 * 60 * 1000)
  try {
    await window.electronAPI.sensor.triggerHeartbeat()
  } catch (e) {
    patrolling.value = false
    patrolStatus.value = 'error'
    patrolMessage.value = t('awaken.patrolError')
    clearPatrolStatus()
  }
}

function loadPersonalitySettings() {
  personalityText.value = configStore.agentPersonalityText || ''
  personalityOriginal.value = personalityText.value
}

async function savePersonalityText() {
  if (!personalityDirty.value) return
  personalitySaving.value = true
  personalityError.value = ''
  try {
    const safeText = personalityText.value.length > PERSONALITY_MAX_LENGTH
      ? personalityText.value.substring(0, PERSONALITY_MAX_LENGTH)
      : personalityText.value
    await configStore.setAgentPersonalityText(safeText)
    personalityText.value = safeText
    personalityOriginal.value = safeText
  } catch (e) {
    console.error('保存个性补充失败:', e)
    personalityError.value = t('awaken.personalitySaveFailed')
  } finally {
    personalitySaving.value = false
  }
}

function resetPersonalityText() {
  personalityText.value = personalityOriginal.value
  personalityError.value = ''
}

function requestClose() {
  if (personalityDirty.value && !confirm(t('awaken.personalityUnsavedConfirm'))) {
    return
  }
  emit('close')
}

// ==================== Lifecycle ====================

let refreshTimer: NodeJS.Timeout | null = null
let cleanupWatchStarted: (() => void) | null = null
let cleanupWatchCompleted: (() => void) | null = null

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') requestClose()
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown, true)
  await Promise.all([loadWatchData().catch(() => {}), loadAwakenSettings()])
  loadPersonalitySettings()
  loadTemplates(); loadSharedState()
  refreshTimer = setInterval(loadWatchData, 5 * 60 * 1000)

  cleanupWatchStarted = window.electronAPI.watch.onTaskStarted?.((data: any) => {
    if (data?.watchId) markWatchRunning(data.watchId)
    if (data?.watchId === '__wakeup__' || data?.watchId === '__daily_patrol__') {
      patrolling.value = true
      patrolStatus.value = 'running'
      patrolMessage.value = t('awaken.patrolRunning')
    }
  })
  cleanupWatchCompleted = window.electronAPI.watch.onTaskCompleted?.((data: any) => {
    if (data?.watchId) markWatchCompleted(data.watchId)
    if (data?.watchId === '__wakeup__' || data?.watchId === '__daily_patrol__') {
      patrolling.value = false
      if (patrolTimeout) { clearTimeout(patrolTimeout); patrolTimeout = null }
      if (data.result?.success) {
        patrolStatus.value = data.result.skipped ? 'skipped' : 'done'
        patrolMessage.value = data.result.skipped ? t('awaken.patrolSkipped') : t('awaken.patrolDone')
      } else {
        patrolStatus.value = 'error'
        patrolMessage.value = data.result?.error || t('awaken.patrolError')
      }
      clearPatrolStatus()
    }
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
  if (refreshTimer) clearInterval(refreshTimer)
  if (patrolStatusTimer) clearTimeout(patrolStatusTimer)
  if (patrolTimeout) clearTimeout(patrolTimeout)
  if (ecgFlashTimer) clearTimeout(ecgFlashTimer)
  if (ecgBootTimer) clearTimeout(ecgBootTimer)
  cleanupWatchStarted?.(); cleanupWatchCompleted?.()
  for (const timeout of watchTimeouts.values()) clearTimeout(timeout)
  watchTimeouts.clear()
})
</script>

<template>
  <div class="modal-overlay">
    <div class="watch-panel">
      <!-- Header -->
      <div class="panel-header">
        <h2>
          <Heart :size="16" style="margin-right: 6px;" />
          {{ t('awaken.title') }}
        </h2>
        <div class="header-stats" v-if="watches.length > 0">
          <span class="stat-item">{{ enabledCount }} {{ t('watch.activeCount') }}</span>
        </div>
        <button class="btn-icon" @click="requestClose" :title="t('watch.close')">
          <X :size="18" />
        </button>
      </div>

      <!-- 觉醒主控栏 -->
      <div class="awaken-bar">
        <div class="awaken-left">
          <label class="awaken-toggle">
            <input type="checkbox" v-model="awakened" @change="toggleAwakened" />
            <span class="toggle-slider"></span>
          </label>
          <div class="ecg-monitor" :class="{ active: awakened }">
            <svg width="120" height="24" viewBox="0 0 120 24">
              <line class="ecg-flatline" :class="{ active: awakened, flashing: ecgBaselineFlashing }" x1="0" y1="12" x2="120" y2="12" />
              <g v-if="awakened && !ecgBaselineFlashing" class="ecg-wave-track">
                <g class="ecg-wave-reveal" :class="{ booting: ecgBooting }">
                  <polyline class="ecg-line"
                    points="0,12 15,12 17,9 19,12 24,12 26,2 28,22 30,6 32,12 40,12 43,9 46,12 60,12 75,12 77,9 79,12 84,12 86,2 88,22 90,6 92,12 100,12 103,9 106,12 120,12 135,12 137,9 139,12 144,12 146,2 148,22 150,6 152,12 160,12 163,9 166,12 180,12"
                  />
                </g>
              </g>
            </svg>
          </div>
          <span class="awaken-status" :class="{ active: awakenReady }">
            {{ awakenReady ? t('awaken.running') : t('awaken.stopped') }}
          </span>
        </div>
        <div class="awaken-center" :class="{ pending: !awakenReady }">
          <input
            type="number"
            v-model.number="heartbeatInterval"
            :min="1" :max="1440"
            class="interval-input"
            :disabled="!awakenReady"
            @change="updateAwakenInterval"
          />
          <span class="interval-unit">min</span>
        </div>
        <div class="awaken-right">
          <span v-if="patrolStatus !== 'idle'" class="patrol-hint" :class="patrolStatus">
            <RefreshCw v-if="patrolStatus === 'running'" :size="12" class="spinning" />
            {{ patrolMessage }}
          </span>
          <button class="btn btn-sm awaken-trigger-btn" :class="{ hidden: !awakenReady }" :disabled="!awakenReady || patrolling" @click="manualHeartbeat">
            <RefreshCw v-if="patrolling" :size="13" class="spinning" />
            <Heart v-else :size="13" />
            {{ t('awaken.trigger') }}
          </button>
        </div>
      </div>
      
      <div class="panel-body">
        <!-- Left Nav -->
        <nav class="panel-nav">
          <div class="nav-group">
            <button class="nav-item" :class="{ active: activeTab === 'personality' }" @click="switchTab('personality')">
              <Sparkles :size="16" />
              <span>{{ t('awaken.personalityNav') }}</span>
            </button>
          </div>
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navAutomation') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'watches' }" @click="switchTab('watches')">
              <Eye :size="16" />
              <span>{{ t('watch.watches') }}</span>
              <span v-if="watches.length" class="nav-badge">{{ watches.length }}</span>
            </button>
          </div>
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navTools') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'templates' }" @click="switchTab('templates', loadTemplates)">
              <LayoutTemplate :size="16" />
              <span>{{ t('watch.templates') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'sensors' }" @click="switchTab('sensors', () => { loadSensorData(); loadSharedState() })">
              <Heart :size="16" />
              <span>{{ t('watch.sensors') }}</span>
            </button>
          </div>
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navRecords') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'history' }" @click="switchTab('history', loadWatchData)">
              <History :size="16" />
              <span>{{ t('watch.executionHistory') }}</span>
            </button>
          </div>
        </nav>

        <!-- Content Area -->
        <div class="panel-content">

          <!-- ===================== 个性 ===================== -->
          <template v-if="activeTab === 'personality'">
            <div class="content-page personality-page">
              <div class="personality-content">
                <div class="personality-header">
                  <h3>{{ t('awaken.personalityTitle') }}</h3>
                  <span class="personality-note">{{ t('awaken.personalityHint') }}</span>
                </div>
                <textarea
                  v-model="personalityText"
                  class="personality-textarea"
                  :placeholder="t('awaken.personalityPlaceholder')"
                  :maxlength="PERSONALITY_MAX_LENGTH"
                  spellcheck="false"
                />
                <div class="personality-footer">
                  <span class="personality-length">{{ personalityText.length }}/{{ PERSONALITY_MAX_LENGTH }} {{ t('awaken.personalityChars') }}</span>
                  <div class="personality-buttons">
                    <button class="btn btn-sm" @click="resetPersonalityText" :disabled="!personalityDirty || personalitySaving">
                      {{ t('common.reset') }}
                    </button>
                    <button class="btn btn-primary btn-sm" @click="savePersonalityText" :disabled="!personalityDirty || personalitySaving">
                      {{ personalitySaving ? t('common.saving') : t('common.save') }}
                    </button>
                  </div>
                </div>
                <div v-if="personalityError" class="personality-error">{{ personalityError }}</div>
              </div>
            </div>
          </template>

          <!-- ===================== 关切列表 ===================== -->
          <template v-if="activeTab === 'watches'">
            <div class="content-page master-detail-page">
              <!-- Watch List -->
              <div class="master-list">
                <div class="list-toolbar">
                  <span class="toolbar-title">{{ t('watch.watches') }}</span>
                  <button class="btn btn-sm" @click="loadWatchData" :disabled="loading">
                    <RefreshCw :size="14" :class="{ spinning: loading }" />
                  </button>
                </div>

                <div class="item-list">
                  <div v-for="w in watches" :key="w.id" class="list-item" :class="{ active: selectedWatch?.id === w.id, disabled: !w.enabled, running: runningWatches.has(w.id) }" @click="selectWatch(w)">
                    <button class="btn-toggle" :class="{ enabled: w.enabled }" @click.stop="toggleWatch(w)">
                      <span class="toggle-dot"></span>
                    </button>
                    <div class="item-info">
                      <div class="item-name">
                        {{ w.name }}
                        <span v-if="runningWatches.has(w.id)" class="running-indicator">
                          <RefreshCw :size="11" class="spinning" />
                          {{ t('watch.statusRunning') }}
                        </span>
                      </div>
                      <div class="item-meta">
                        <span v-for="trigger in w.triggers" :key="trigger.type" class="trigger-badge">
                          <component :is="getTriggerIcon(trigger.type)" :size="10" />
                          {{ getTriggerLabel(trigger) }}
                        </span>
                      </div>
                      <div class="item-sub" v-if="w.lastRun && !runningWatches.has(w.id)">
                        <span :class="getStatusClass(w.lastRun.status)">{{ getStatusIcon(w.lastRun.status) }}</span>
                        {{ formatDate(w.lastRun.at) }}
                      </div>
                    </div>
                    <button class="btn-icon-sm" @click.stop="triggerWatch(w)" :disabled="runningWatches.has(w.id)" :title="t('watch.trigger')">
                      <RefreshCw v-if="runningWatches.has(w.id)" :size="14" class="spinning" />
                      <Play v-else :size="14" />
                    </button>
                  </div>

                  <div v-if="watches.length === 0 && !loading" class="empty-state">
                    <Eye :size="40" class="empty-icon" />
                    <p>{{ t('watch.noWatches') }}</p>
                    <p class="hint-text">{{ t('watch.createViaAgent') }}</p>
                  </div>
                </div>
              </div>

              <!-- Watch Detail -->
              <div class="detail-area">
                <template v-if="selectedWatch">
                  <div class="detail-header">
                    <div class="detail-title">
                      <h3>{{ selectedWatch.name }}</h3>
                      <span class="watch-badge" :class="{ enabled: selectedWatch.enabled }">{{ selectedWatch.enabled ? t('watch.enabled') : t('watch.disabled') }}</span>
                      <span class="priority-badge" :class="selectedWatch.priority">{{ selectedWatch.priority }}</span>
                    </div>
                    <div class="detail-actions">
                      <button class="btn btn-primary btn-sm" @click="triggerWatch(selectedWatch)" :disabled="runningWatches.has(selectedWatch.id)">
                        <Play :size="14" /> {{ t('watch.trigger') }}
                      </button>
                      <button class="btn btn-danger btn-sm" @click="deleteWatch(selectedWatch)">
                        <Trash2 :size="14" />
                      </button>
                    </div>
                  </div>
                  <div class="detail-body">
                    <div class="detail-section" v-if="selectedWatch.description">
                      <h4>{{ t('watch.description') }}</h4>
                      <p>{{ selectedWatch.description }}</p>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('watch.triggers') }}</h4>
                      <div class="trigger-list">
                        <span v-for="tr in selectedWatch.triggers" :key="tr.type" class="trigger-badge trigger-badge-lg">
                          <component :is="getTriggerIcon(tr.type)" :size="12" /> {{ getTriggerLabel(tr) }}
                        </span>
                      </div>
                      <div class="detail-row" v-if="selectedWatch.nextRun && selectedWatch.enabled">
                        <span class="label">{{ t('watch.nextRun') }}:</span>
                        <span class="value">{{ formatFullDate(selectedWatch.nextRun) }}</span>
                      </div>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('watch.prompt') }}</h4>
                      <div class="prompt-content">{{ selectedWatch.prompt }}</div>
                    </div>
                    <div class="detail-section" v-if="selectedWatch.skills?.length">
                      <h4>{{ t('watch.skills') }}</h4>
                      <div class="skills-list"><span v-for="s in selectedWatch.skills" :key="s" class="skill-badge">{{ s }}</span></div>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('watch.outputType') }}</h4>
                      <p>{{ getOutputLabel(selectedWatch.output.type) }}</p>
                    </div>
                    <div class="detail-section" v-if="selectedWatch.triggers.some(t => t.type === 'webhook')">
                      <h4>Webhook URL</h4>
                      <code class="webhook-url">POST /hooks/{{ selectedWatch.triggers.find(t => t.type === 'webhook')?.token }}</code>
                    </div>
                    <div class="detail-section" v-if="selectedWatch.lastRun">
                      <h4>{{ t('watch.lastRun') }}</h4>
                      <div class="detail-row">
                        <span class="label">{{ t('watch.statusLabel') }}:</span>
                        <span class="value" :class="getStatusClass(selectedWatch.lastRun.status)">{{ getWatchStatusText(selectedWatch.lastRun.status) }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="label">{{ t('watch.timeLabel') }}:</span>
                        <span class="value">{{ formatFullDate(selectedWatch.lastRun.at) }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="label">{{ t('watch.duration') }}:</span>
                        <span class="value">{{ formatDuration(selectedWatch.lastRun.duration) }}</span>
                      </div>
                      <div class="detail-row" v-if="selectedWatch.lastRun.error">
                        <span class="label">{{ t('watch.errorLabel') }}:</span>
                        <span class="value error-text">{{ selectedWatch.lastRun.error }}</span>
                      </div>
                      <div class="detail-row" v-if="selectedWatch.lastRun.skipReason">
                        <span class="label">{{ t('watch.statusSkipped') }}:</span>
                        <span class="value">{{ selectedWatch.lastRun.skipReason }}</span>
                      </div>
                    </div>
                    <div class="detail-section detail-meta">
                      <span>{{ t('watch.createdAt') }}: {{ formatFullDate(selectedWatch.createdAt) }}</span>
                      <span>{{ t('watch.updatedAt') }}: {{ formatFullDate(selectedWatch.updatedAt) }}</span>
                    </div>
                  </div>
                </template>

                <!-- Empty State -->
                <div v-else class="empty-detail">
                  <Eye :size="48" class="empty-icon" />
                  <p>{{ t('watch.selectOrCreate') }}</p>
                  <p class="hint-text">{{ t('watch.createViaAgent') }}</p>
                </div>
              </div>
            </div>
          </template>

          <!-- ===================== 模板 ===================== -->
          <template v-if="activeTab === 'templates'">
            <div class="content-page">
              <div class="page-toolbar">
                <div class="category-filter">
                  <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'all' }" @click="selectedTemplateCategory = 'all'">{{ t('watch.templateAll') }}</button>
                  <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'daily' }" @click="selectedTemplateCategory = 'daily'">{{ t('watch.templateDaily') }}</button>
                  <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'email' }" @click="selectedTemplateCategory = 'email'">{{ t('watch.templateEmail') }}</button>
                  <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'devops' }" @click="selectedTemplateCategory = 'devops'">DevOps</button>
                  <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'monitor' }" @click="selectedTemplateCategory = 'monitor'">{{ t('watch.templateMonitor') }}</button>
                </div>
              </div>
              <div class="template-grid">
                <div v-for="tpl in filteredTemplates" :key="tpl.id" class="template-card" @click="useTemplate(tpl)">
                  <div class="template-icon">{{ tpl.icon }}</div>
                  <div class="template-info">
                    <div class="template-name">{{ tpl.name }}</div>
                    <div class="template-desc">{{ tpl.description }}</div>
                  </div>
                  <button class="btn btn-sm btn-primary" @click.stop="useTemplate(tpl)"><Plus :size="12" /> {{ t('watch.useTemplate') }}</button>
                </div>
                <div v-if="filteredTemplates.length === 0" class="empty-state" style="padding: 60px 20px;">
                  <LayoutTemplate :size="40" class="empty-icon" />
                  <p>{{ t('watch.noTemplates') }}</p>
                </div>
              </div>
            </div>
          </template>

          <!-- ===================== 传感器 ===================== -->
          <template v-if="activeTab === 'sensors'">
            <div class="content-page">
              <div class="page-toolbar">
                <span class="page-title">{{ t('watch.sensorStatus') }}</span>
                <button class="btn btn-sm" @click="loadSensorData"><RefreshCw :size="14" /></button>
              </div>

              <div class="sensor-grid">
                <div v-for="s in sensorStatus" :key="s.id" class="sensor-card">
                  <div class="sensor-indicator" :class="{ active: s.running }"></div>
                  <div class="sensor-info">
                    <div class="sensor-name">{{ s.name }}</div>
                    <div class="sensor-status-text">{{ s.running ? t('watch.sensorRunning') : t('watch.sensorStopped') }}</div>
                    <div v-if="s.details" class="sensor-details">
                      <template v-if="s.id === 'heartbeat'">
                        <span class="detail-tag">{{ s.details.intervalMinutes }}min</span>
                      </template>
                      <template v-else-if="s.id === 'email'">
                        <span class="detail-tag" :class="{ warn: !s.details.connected }">
                          {{ s.details.connected ? 'IMAP ✓' : 'IMAP ✗' }}
                        </span>
                        <span class="detail-tag">{{ s.details.targetCount }} {{ t('watch.targets') }}</span>
                        <div v-if="s.details.accounts?.length" class="detail-accounts">
                          <div v-for="acct in (s.details.accounts as any[])" :key="acct.accountId" class="detail-account">
                            <span class="acct-dot" :class="{ connected: acct.connected }"></span>
                            <span class="acct-email">{{ acct.email }}</span>
                          </div>
                        </div>
                      </template>
                      <template v-else-if="s.id === 'calendar'">
                        <span class="detail-tag">{{ s.details.targetCount }} {{ t('watch.targets') }}</span>
                        <div v-if="s.details.accountStatuses?.length" class="detail-accounts">
                          <div v-for="acct in (s.details.accountStatuses as any[])" :key="acct.accountId" class="detail-account">
                            <span class="acct-dot" :class="{ connected: acct.connected }"></span>
                            <span class="acct-email">{{ acct.name }}</span>
                          </div>
                        </div>
                      </template>
                      <template v-else-if="s.id === 'file-watch'">
                        <span class="detail-tag">{{ s.details.targetCount }} {{ t('watch.targets') }}</span>
                      </template>
                    </div>
                  </div>
                  <button v-if="s.id === 'heartbeat'" class="btn btn-sm" @click="triggerHeartbeat" :title="t('watch.triggerHeartbeatBtn')">
                    <Heart :size="14" /> {{ t('watch.trigger') }}
                  </button>
                </div>
              </div>

              <div v-if="recentEvents.length > 0" class="content-section">
                <h4>{{ t('watch.recentEvents') }}</h4>
                <div class="event-list">
                  <div v-for="e in recentEvents" :key="e.id" class="event-item">
                    <span class="event-time">{{ new Date(e.timestamp).toLocaleTimeString() }}</span>
                    <span class="event-type"><component :is="getTriggerIcon(e.type as WatchTriggerType)" :size="12" /> {{ e.type }}</span>
                    <span class="event-source">{{ e.source }}</span>
                  </div>
                </div>
              </div>

              <div v-if="Object.keys(sharedState).length > 0" class="content-section">
                <div class="section-header-row">
                  <h4><Database :size="14" /> {{ t('watch.sharedState') }}</h4>
                  <button class="btn btn-sm btn-danger" @click="clearSharedState"><Trash2 :size="12" /></button>
                </div>
                <div class="state-list">
                  <div v-for="(value, key) in sharedState" :key="String(key)" class="state-item">
                    <span class="state-key">{{ String(key) }}</span>
                    <span class="state-value">{{ typeof value === 'object' ? JSON.stringify(value) : String(value) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- ===================== 执行历史 ===================== -->
          <template v-if="activeTab === 'history'">
            <div class="content-page">
              <div class="page-toolbar">
                <span class="page-title">{{ t('watch.executionHistory') }}</span>
                <div class="toolbar-right">
                  <button class="btn btn-sm btn-danger" @click="clearWatchHistory" :disabled="watchHistory.length === 0"><Trash2 :size="14" /> {{ t('watch.clearHistory') }}</button>
                </div>
              </div>

              <div v-if="watchHistory.length > 0" class="history-table">
                <div v-for="h in watchHistory" :key="h.id" class="history-row">
                  <span class="history-status-icon" :class="getStatusClass(h.status)">{{ getStatusIcon(h.status) }}</span>
                  <span class="history-name">{{ h.watchName }}</span>
                  <span class="history-trigger"><component :is="getTriggerIcon(h.triggerType as WatchTriggerType)" :size="10" /> {{ h.triggerType }}</span>
                  <span class="history-time">{{ formatFullDate(h.at) }}</span>
                  <span class="history-duration">{{ formatDuration(h.duration) }}</span>
                </div>
              </div>

              <div v-if="watchHistory.length === 0" class="empty-state" style="padding: 60px 20px;">
                <History :size="40" class="empty-icon" />
                <p>{{ t('watch.noHistory') }}</p>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ==================== Full-Screen Panel Layout ==================== */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: transparent;
  display: flex;
  z-index: 1000;
  animation: fadeIn 0.15s ease;
}

.watch-panel {
  width: 100%;
  height: 100%;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  height: var(--header-height);
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  gap: 12px;
}

.panel-header h2 {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  margin: 0;
  padding-left: 4px;
}

.header-stats {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 12px;
}

.stat-item {
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 8px;
  background: rgba(40, 167, 69, 0.1);
  border-radius: 10px;
  color: #28a745;
}

.panel-header .btn-icon {
  width: 30px;
  height: 30px;
  padding: 6px;
  border-radius: 6px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}
.panel-header .btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

/* ==================== Awaken Bar ==================== */

.awaken-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-primary);
  flex-shrink: 0;
}

.awaken-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.awaken-toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}
.awaken-toggle input { display: none; }
.toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--bg-tertiary);
  border-radius: 10px;
  transition: background 0.2s;
}
.toggle-slider::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: white;
  border-radius: 50%;
  transition: transform 0.2s;
}
.awaken-toggle input:checked + .toggle-slider {
  background: var(--accent-color, #10b981);
}
.awaken-toggle input:checked + .toggle-slider::before {
  transform: translateX(16px);
}

.awaken-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-secondary);
}
.awaken-status.active {
  color: #10b981;
}

/* ==================== ECG Monitor ==================== */

.ecg-monitor {
  width: 120px;
  height: 24px;
  overflow: hidden;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid var(--border-color);
  flex-shrink: 0;
}

.ecg-monitor svg {
  display: block;
}

.ecg-flatline {
  stroke: var(--text-tertiary);
  stroke-width: 1.5;
  opacity: 0.3;
}
.ecg-flatline.active {
  opacity: 0.22;
}
.ecg-flatline.flashing {
  stroke: #8af7c5;
  stroke-width: 1.8;
  filter: drop-shadow(0 0 4px rgba(138, 247, 197, 0.8));
  animation: ecg-flatline-flash 100ms ease-in-out 3;
}

.ecg-line {
  fill: none;
  stroke: #10b981;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 2px rgba(16, 185, 129, 0.6));
}

.ecg-wave-track {
  animation: ecg-scroll 1.5s linear infinite;
}

.ecg-wave-reveal {
  clip-path: inset(0 0 0 0);
}

.ecg-wave-reveal.booting {
  clip-path: inset(0 0 0 100%);
  animation: ecg-reveal-right-to-left 1.05s linear forwards;
}

.ecg-monitor.active {
  border-color: rgba(16, 185, 129, 0.3);
  box-shadow: 0 0 8px rgba(16, 185, 129, 0.1);
}

@keyframes ecg-scroll {
  from { transform: translateX(0); }
  to { transform: translateX(-60px); }
}

@keyframes ecg-reveal-right-to-left {
  from { clip-path: inset(0 0 0 100%); }
  to { clip-path: inset(0 0 0 0); }
}

@keyframes ecg-flatline-flash {
  0% { opacity: 0.18; }
  50% { opacity: 1; }
  100% { opacity: 0.2; }
}

.awaken-center {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 88px;
}
.awaken-center.pending {
  visibility: hidden;
}
.interval-input {
  width: 50px;
  padding: 2px 6px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 12px;
  text-align: center;
}
.interval-input:focus {
  outline: none;
  border-color: var(--accent-color, #10b981);
}
.interval-unit {
  font-size: 11px;
  color: var(--text-tertiary);
}

.awaken-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 110px;
  justify-content: flex-end;
}

.awaken-trigger-btn.hidden {
  visibility: hidden;
  pointer-events: none;
}

.personality-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.personality-content {
  display: flex;
  flex-direction: column;
  padding: 20px 24px;
  gap: 12px;
  height: 100%;
}

.personality-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.personality-header h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.personality-note {
  font-size: 12px;
  color: var(--text-muted);
}

.personality-textarea {
  width: 100%;
  flex: 1;
  min-height: 120px;
  resize: none;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.6;
  font-family: var(--font-mono);
}

.personality-textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.personality-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.personality-length {
  font-size: 11px;
  color: var(--text-muted);
}

.personality-buttons {
  display: flex;
  gap: 6px;
}

.personality-error {
  font-size: 11px;
  color: #ef4444;
}

.patrol-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
}
.patrol-hint.running { color: var(--accent-color, #10b981); }
.patrol-hint.done { color: #10b981; }
.patrol-hint.skipped { color: var(--text-tertiary); }
.patrol-hint.error { color: #ef4444; }

@keyframes spin {
  to { transform: rotate(360deg); }
}
.spinning {
  animation: spin 1s linear infinite;
}

.panel-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* ==================== Left Nav ==================== */

.panel-nav {
  width: 200px;
  min-width: 200px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-y: auto;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-group + .nav-group {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
}

.nav-group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 12px 6px;
  user-select: none;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  text-align: left;
}

.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item.active { background: var(--accent-primary); color: var(--bg-primary); }

.nav-badge {
  margin-left: auto;
  font-size: 11px;
  background: rgba(110, 118, 129, 0.2);
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 500;
}
.nav-item.active .nav-badge { background: rgba(255, 255, 255, 0.2); color: inherit; }

/* ==================== Content Area ==================== */

.panel-content {
  flex: 1;
  overflow: hidden;
  display: flex;
}

.content-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ==================== Master-Detail Layout ==================== */

.master-detail-page {
  flex-direction: row;
}

.master-list {
  width: 340px;
  min-width: 340px;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ==================== List Components ==================== */

.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  gap: 8px;
}

.toolbar-title { font-size: 12px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

.item-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.list-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 2px;
  transition: background 0.15s;
}
.list-item:hover { background: var(--bg-hover); }
.list-item.active { background: var(--bg-active); }
.list-item.disabled { opacity: 0.5; }
.list-item.running { border-color: var(--accent-primary); background: rgba(137, 180, 250, 0.06); }

.item-info { flex: 1; min-width: 0; }
.item-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }

.running-indicator {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-weight: 500;
  color: var(--accent-primary);
  flex-shrink: 0;
}
.item-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.item-sub { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

.btn-icon-sm {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  padding: 4px; border-radius: 4px; opacity: 0; transition: all 0.15s;
}
.list-item:hover .btn-icon-sm, .list-item.active .btn-icon-sm { opacity: 1; }
.btn-icon-sm:hover { background: var(--bg-hover); color: var(--text-primary); }

/* ==================== Detail Components ==================== */

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-color);
  gap: 12px;
}

.detail-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-title h3 { margin: 0; font-size: 16px; font-weight: 600; }
.detail-actions { display: flex; gap: 6px; flex-shrink: 0; }

.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.detail-section { margin-bottom: 20px; }
.detail-section h4 { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.detail-section p { margin: 0; font-size: 13px; line-height: 1.5; }

.detail-row { display: flex; gap: 8px; margin-bottom: 6px; font-size: 13px; }
.detail-row .label { color: var(--text-muted); min-width: 90px; flex-shrink: 0; }
.detail-row .value { color: var(--text-primary); }

.detail-meta {
  display: flex;
  gap: 20px;
  font-size: 11px;
  color: var(--text-muted);
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.empty-detail {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
}
.empty-detail p { color: var(--text-muted); font-size: 13px; margin: 0; }

.hint-text { font-size: 12px; color: var(--text-muted); opacity: 0.7; }

/* ==================== Shared UI Components ==================== */

.btn { padding: 6px 12px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; border-radius: 6px; font-size: 12px; display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s; }
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent-primary); color: #fff; border-color: var(--accent-primary); }
.btn-primary:hover:not(:disabled) { opacity: 0.9; }
.btn-danger { background: #dc3545; color: #fff; border-color: #dc3545; }
.btn-danger:hover:not(:disabled) { opacity: 0.9; }
.btn-sm { padding: 4px 10px; font-size: 11px; }

.trigger-badge {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 7px; background: var(--bg-tertiary, rgba(255,255,255,0.05));
  border-radius: 4px; font-size: 10px; color: var(--text-secondary);
}
.trigger-badge-lg { padding: 3px 10px; font-size: 12px; }

.watch-badge { padding: 2px 8px; border-radius: 4px; font-size: 10px; background: rgba(108,117,125,0.2); color: #6c757d; }
.watch-badge.enabled { background: rgba(40,167,69,0.15); color: #28a745; }

.priority-badge { padding: 2px 6px; border-radius: 4px; font-size: 10px; }
.priority-badge.high { background: rgba(220,53,69,0.15); color: #dc3545; }
.priority-badge.normal { background: rgba(108,117,125,0.15); color: var(--text-muted); }
.priority-badge.low { background: rgba(108,117,125,0.1); color: var(--text-muted); }

.btn-toggle {
  width: 32px; height: 18px; border-radius: 9px;
  background: var(--bg-tertiary, rgba(255,255,255,0.1));
  border: none; cursor: pointer; position: relative; transition: background 0.2s; flex-shrink: 0;
}
.btn-toggle.enabled { background: var(--accent-primary); }
.toggle-dot {
  position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform 0.2s;
}
.btn-toggle.enabled .toggle-dot { transform: translateX(14px); }

.prompt-content {
  background: var(--bg-primary, rgba(0,0,0,0.2));
  padding: 12px; border-radius: 6px; font-size: 13px;
  line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  max-height: 200px; overflow-y: auto;
}

.webhook-url { display: block; padding: 8px 12px; background: var(--bg-primary, rgba(0,0,0,0.2)); border-radius: 6px; font-size: 12px; word-break: break-all; }
.trigger-list { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.skills-list { display: flex; gap: 4px; flex-wrap: wrap; }
.skill-badge { padding: 2px 8px; background: var(--bg-tertiary, rgba(255,255,255,0.05)); border-radius: 4px; font-size: 11px; }

.status-success { color: #28a745; }
.status-error { color: #dc3545; }
.status-warning { color: #ffc107; }
.status-skipped { color: #6c757d; }
.status-muted { color: var(--text-muted); }
.status-running { color: var(--accent-primary); }
.error-text { color: #dc3545; }

.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 10px; }
.empty-icon { color: var(--text-muted); opacity: 0.3; }
.empty-state p { color: var(--text-muted); font-size: 13px; margin: 0; }

/* ==================== Templates ==================== */

.page-toolbar {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 24px; border-bottom: 1px solid var(--border-color); gap: 12px;
}
.page-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.toolbar-right { display: flex; gap: 8px; }

.category-filter { display: flex; gap: 6px; flex-wrap: wrap; }
.filter-btn { padding: 4px 12px; border: 1px solid var(--border-color); background: none; color: var(--text-secondary); cursor: pointer; border-radius: 6px; font-size: 12px; transition: all 0.15s; }
.filter-btn:hover { border-color: var(--accent-primary); }
.filter-btn.active { border-color: var(--accent-primary); background: rgba(var(--accent-rgb, 59, 130, 246), 0.1); color: var(--accent-primary); }

.template-grid {
  flex: 1; overflow-y: auto; padding: 16px 24px;
  display: flex; flex-direction: column; gap: 8px;
}

.template-card {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 16px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--border-color); transition: all 0.15s;
}
.template-card:hover { border-color: var(--accent-primary); background: var(--bg-hover); }
.template-icon { font-size: 28px; min-width: 40px; text-align: center; }
.template-info { flex: 1; min-width: 0; }
.template-name { font-size: 14px; font-weight: 500; }
.template-desc { font-size: 12px; color: var(--text-muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ==================== Sensors ==================== */

.sensor-grid {
  display: flex; flex-wrap: wrap; gap: 12px; padding: 16px 24px;
}

.sensor-card {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 16px; border-radius: 8px; border: 1px solid var(--border-color);
  min-width: 240px; flex: 1; max-width: 400px;
}
.sensor-indicator { width: 10px; height: 10px; border-radius: 50%; background: #6c757d; flex-shrink: 0; margin-top: 4px; }
.sensor-indicator.active { background: #28a745; box-shadow: 0 0 6px rgba(40, 167, 69, 0.4); }
.sensor-info { flex: 1; }
.sensor-name { font-size: 13px; font-weight: 500; }
.sensor-status-text { font-size: 11px; color: var(--text-muted); }

.sensor-details { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.detail-tag {
  font-size: 10px; padding: 1px 6px; border-radius: 3px;
  background: var(--bg-tertiary); color: var(--text-secondary);
}
.detail-tag.warn { background: rgba(248, 81, 73, 0.12); color: #f85149; }
.detail-accounts { width: 100%; margin-top: 4px; }
.detail-account {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text-secondary); padding: 1px 0;
}
.acct-dot { width: 5px; height: 5px; border-radius: 50%; background: #6c757d; flex-shrink: 0; }
.acct-dot.connected { background: #28a745; }

.content-section { padding: 0 24px 20px; }
.content-section h4 { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 20px 0 10px; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; }

.section-header-row { display: flex; align-items: center; justify-content: space-between; padding: 0 24px; }
.section-header-row h4 { font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 20px 0 10px; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; }

.event-list { display: flex; flex-direction: column; gap: 4px; }
.event-item { display: flex; gap: 10px; padding: 4px 0; font-size: 12px; color: var(--text-muted); align-items: center; }
.event-time { min-width: 70px; }
.event-type { display: flex; align-items: center; gap: 4px; min-width: 90px; }

.state-list { padding: 0 24px 16px; }
.state-item { display: flex; gap: 10px; padding: 4px 0; font-size: 12px; }
.state-key { color: var(--accent-primary); min-width: 100px; font-weight: 500; }
.state-value { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ==================== History ==================== */

.history-table { display: flex; flex-direction: column; gap: 2px; padding: 12px 24px; flex: 1; overflow-y: auto; }

.history-row {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; border-radius: 6px; font-size: 12px;
}
.history-row:hover { background: var(--bg-hover); }

.history-status-icon { min-width: 20px; text-align: center; font-size: 13px; }
.history-name { flex: 1; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-trigger { display: flex; align-items: center; gap: 3px; color: var(--text-muted); min-width: 80px; }
.history-time { color: var(--text-muted); min-width: 150px; }
.history-duration { color: var(--text-muted); min-width: 60px; text-align: right; }

/* ==================== Animations ==================== */

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spinning { animation: spin 1s linear infinite; }
</style>
