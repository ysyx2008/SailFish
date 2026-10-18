<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onErrorCaptured, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type AgentMbtiType } from '../stores/config'
import {
  X, Trash2, Eye, RefreshCw, History, Heart,
  Sparkles, Fingerprint, HeartPulse, Camera,
} from 'lucide-vue-next'
import WatchHistoryDetailView from './Awaken/WatchHistoryDetailView.vue'
import { showConfirm } from '../composables/useConfirm'

const { t } = useI18n()
const configStore = useConfigStore()
const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{ close: [awakened: boolean]; 'awakened-change': [value: boolean] }>()

// ==================== Types ====================

import type { WatchRunStatus, WatchHistoryRecord } from '@shared/types'

// ==================== Navigation ====================

type NavTab =
  | 'identity' | 'personality' | 'heartbeat'
  | 'wakeupHistory'

const VALID_TABS: NavTab[] = [
  'identity', 'personality', 'heartbeat',
  'wakeupHistory',
]
const LAST_TAB_STORAGE_KEY = 'sfterm-awaken-last-tab'
const DEFAULT_TAB: NavTab = 'identity'

function readLastTab(): NavTab {
  try {
    const v = localStorage.getItem(LAST_TAB_STORAGE_KEY)
    if (v && VALID_TABS.includes(v as NavTab)) return v as NavTab
  } catch { /* ignore */ }
  return DEFAULT_TAB
}

const activeTab = ref<NavTab>(
  props.initialTab && VALID_TABS.includes(props.initialTab as NavTab)
    ? props.initialTab as NavTab
    : readLastTab()
)

async function switchTab(tab: NavTab, onSwitch?: () => void) {
  const dirtyChecks: Array<{ from: NavTab; dirty: boolean; reset: () => void }> = [
    { from: 'personality', dirty: personalityDirty.value, reset: resetPersonalityText },
    { from: 'identity', dirty: identityDirty.value, reset: resetIdentityText },
    { from: 'heartbeat', dirty: heartbeatDirty.value, reset: resetHeartbeatText },
  ]
  for (const check of dirtyChecks) {
    if (activeTab.value === check.from && tab !== check.from && check.dirty) {
      const confirmed = await showConfirm({
        type: 'warning',
        title: t('common.confirm'),
        message: t('awaken.personalityUnsavedConfirm'),
      })
      if (!confirmed) return
      check.reset()
    }
  }
  activeTab.value = tab
  if (tab === 'wakeupHistory') historyFilter.value = 'wakeup'
  // 记忆上次离开的 tab，下次打开面板回到这里
  try { localStorage.setItem(LAST_TAB_STORAGE_KEY, tab) } catch { /* ignore quota */ }
  onSwitch?.()
}

// ==================== State ====================

const watchHistory = ref<WatchHistoryRecord[]>([])
const historyPageSize = 50
const historyHasMore = ref(false)
const historyLoadingMore = ref(false)
const historyFilter = ref<'wakeup'>('wakeup')
const historyLoading = ref(true)

const selectedHistoryRecord = ref<WatchHistoryRecord | null>(null)
const historyDetailSteps = ref<Array<{ id: string; type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string; timestamp: number; success?: boolean; images?: string[]; webSearchResults?: unknown[]; subAgents?: unknown[] }>>([])
const historyDetailLoading = ref(false)
const historyDetailUserTask = ref('')
const historyDetailFinalResult = ref('')

const personalityText = ref('')
const personalityOriginal = ref('')
const personalitySaving = ref(false)
const personalityError = ref('')
const FILE_MAX_LENGTH = 1000
const personalityDirty = computed(() => personalityText.value !== personalityOriginal.value)

const identityText = ref('')
const identityOriginal = ref('')
const identitySaving = ref(false)
const identityError = ref('')
const identityDirty = computed(() => identityText.value !== identityOriginal.value)


const heartbeatText = ref('')
const heartbeatOriginal = ref('')
const heartbeatSaving = ref(false)
const heartbeatError = ref('')
const heartbeatDirty = computed(() => heartbeatText.value !== heartbeatOriginal.value)

// ==================== Utilities ====================

const formatTime = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`

const getDateKey = (ts: number): string => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const formatDateLabel = (dateKey: string): string => {
  const today = getDateKey(Date.now())
  const yesterday = getDateKey(Date.now() - 86400000)
  if (dateKey === today) return t('watch.today')
  if (dateKey === yesterday) return t('watch.yesterday')
  return dateKey
}

const filteredHistory = computed<WatchHistoryRecord[]>(() =>
  watchHistory.value
)

const groupedHistory = computed(() => {
  const groups: Array<{ dateKey: string; label: string; records: WatchHistoryRecord[] }> = []
  let currentKey = ''
  for (const h of filteredHistory.value) {
    const key = getDateKey(h.at)
    if (key !== currentKey) {
      currentKey = key
      groups.push({ dateKey: key, label: formatDateLabel(key), records: [] })
    }
    groups[groups.length - 1].records.push(h)
  }
  return groups
})

const loadMoreHistory = async () => {
  historyLoadingMore.value = true
  try {
    const all = await window.electronAPI.watch.getHistory('__wakeup__', watchHistory.value.length + historyPageSize)
    historyHasMore.value = all.length > watchHistory.value.length + historyPageSize - 1
    watchHistory.value = all
  } finally {
    historyLoadingMore.value = false
  }
}

// ==================== Data Loading ====================

const loadWatchData = async () => {
  historyLoading.value = true
  try {
    const history = await window.electronAPI.watch.getHistory('__wakeup__', historyPageSize + 1)
    historyHasMore.value = history.length > historyPageSize
    watchHistory.value = historyHasMore.value ? history.slice(0, historyPageSize) : history
  } catch (e) {
    console.error('Failed to load wakeup history:', e)
  } finally {
    historyLoading.value = false
  }
}

const getTriggerTypeLabel = (type: string): string => {
  const map: Record<string, string> = {
    cron: t('watch.triggerCron'),
    interval: t('watch.triggerInterval'),
    heartbeat: t('watch.triggerHeartbeat'),
    webhook: 'Webhook',
    manual: t('watch.triggerManual'),
    file_change: t('watch.triggerFileChange'),
    calendar: t('watch.triggerCalendar'),
    email: t('watch.triggerEmail'),
    im_connected: t('watch.triggerImConnected'),
    app_lifecycle: t('watch.triggerAppLifecycle'),
  }
  return map[type] || type
}

const getStatusClass = (status: string): string => {
  const map: Record<string, string> = {
    completed: 'status-success', success: 'status-success', failed: 'status-error',
    skipped: 'status-skipped', timeout: 'status-warning', cancelled: 'status-muted', running: 'status-running'
  }
  return map[status] || ''
}

const getStatusIcon = (status: WatchRunStatus): string => {
  const map: Record<string, string> = {
    completed: '✓', failed: '✗', skipped: '⊘', timeout: '⏱', cancelled: '—', running: '●'
  }
  return map[status] || '?'
}

const clearWatchHistory = async () => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.clear'),
    message: t('watch.confirmClearHistory'),
    confirmText: t('common.clear'),
  })
  if (!confirmed) return
  await window.electronAPI.watch.clearHistory('__wakeup__')
  watchHistory.value = []
  selectedHistoryRecord.value = null
}

const viewHistoryDetail = async (record: WatchHistoryRecord) => {
  if (activeTab.value !== 'wakeupHistory') {
    switchTab('wakeupHistory', loadWatchData)
  }

  if (!record.agentSessionId) {
    selectedHistoryRecord.value = record
    historyDetailSteps.value = []
    historyDetailUserTask.value = ''
    historyDetailFinalResult.value = ''
    return
  }

  selectedHistoryRecord.value = record
  historyDetailLoading.value = true
  historyDetailSteps.value = []
  historyDetailUserTask.value = ''
  historyDetailFinalResult.value = ''

  const requestId = record.id
  try {
    const agentRecord = await window.electronAPI.history.getAgentRecordById(record.agentSessionId)
    if (selectedHistoryRecord.value?.id !== requestId) return
    if (agentRecord) {
      historyDetailSteps.value = (agentRecord.steps || []).map(s => ({
        ...s,
        timestamp: s.timestamp ?? Date.now(),
      }))
      historyDetailUserTask.value = agentRecord.userTask || ''
      historyDetailFinalResult.value = agentRecord.finalResult || ''
    }
  } catch (e) {
    if (selectedHistoryRecord.value?.id !== requestId) return
    console.error('Failed to load agent record:', e)
  } finally {
    if (selectedHistoryRecord.value?.id === requestId) {
      historyDetailLoading.value = false
    }
  }
}

const closeHistoryDetail = () => {
  selectedHistoryRecord.value = null
  historyDetailSteps.value = []
  historyDetailUserTask.value = ''
  historyDetailFinalResult.value = ''
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

let awakenTogglePending: boolean | null = null
let awakenToggleRunning = false

async function applyAwakenedState(enabled: boolean) {
  const prev = awakened.value
  awakened.value = enabled
  try {
    await window.electronAPI.sensor.setAwakened(enabled, heartbeatInterval.value)
    const stored = await window.electronAPI.config.get('agentAwakened')
    if (!!stored !== enabled) {
      await window.electronAPI.config.set('agentAwakened', enabled)
    }
    const statusList = await window.electronAPI.sensor.getStatus()
    awakenedRunning.value = statusList.some((s: { id: string; running: boolean }) => s.id === 'heartbeat' && s.running)
    emit('awakened-change', enabled)
  } catch (e) {
    console.error('Failed to toggle awakened:', e)
    awakened.value = prev
    emit('awakened-change', prev)
  }
}

async function flushAwakenToggle() {
  if (awakenToggleRunning) return
  awakenToggleRunning = true
  try {
    while (awakenTogglePending !== null) {
      const enabled = awakenTogglePending
      awakenTogglePending = null
      await applyAwakenedState(enabled)
    }
  } finally {
    awakenToggleRunning = false
    if (awakenTogglePending !== null) {
      void flushAwakenToggle()
    }
  }
}

function requestAwakenToggle() {
  awakenTogglePending = !awakened.value
  void flushAwakenToggle()
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
    await window.electronAPI.watch.trigger('__wakeup__')
  } catch (e) {
    patrolling.value = false
    patrolStatus.value = 'error'
    patrolMessage.value = t('awaken.patrolError')
    clearPatrolStatus()
  }
}

// AI 名字
const agentNameInput = ref('')

// MBTI
const currentMbti = computed(() => configStore.agentMbti)
const mbtiTypes = computed(() => [
  { type: 'INTJ' as const, name: t('aiSettings.mbtiTypes.INTJ.name'), desc: t('aiSettings.mbtiTypes.INTJ.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'INTP' as const, name: t('aiSettings.mbtiTypes.INTP.name'), desc: t('aiSettings.mbtiTypes.INTP.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'ENTJ' as const, name: t('aiSettings.mbtiTypes.ENTJ.name'), desc: t('aiSettings.mbtiTypes.ENTJ.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'ENTP' as const, name: t('aiSettings.mbtiTypes.ENTP.name'), desc: t('aiSettings.mbtiTypes.ENTP.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'INFJ' as const, name: t('aiSettings.mbtiTypes.INFJ.name'), desc: t('aiSettings.mbtiTypes.INFJ.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'INFP' as const, name: t('aiSettings.mbtiTypes.INFP.name'), desc: t('aiSettings.mbtiTypes.INFP.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'ENFJ' as const, name: t('aiSettings.mbtiTypes.ENFJ.name'), desc: t('aiSettings.mbtiTypes.ENFJ.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'ENFP' as const, name: t('aiSettings.mbtiTypes.ENFP.name'), desc: t('aiSettings.mbtiTypes.ENFP.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'ISTJ' as const, name: t('aiSettings.mbtiTypes.ISTJ.name'), desc: t('aiSettings.mbtiTypes.ISTJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ISFJ' as const, name: t('aiSettings.mbtiTypes.ISFJ.name'), desc: t('aiSettings.mbtiTypes.ISFJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ESTJ' as const, name: t('aiSettings.mbtiTypes.ESTJ.name'), desc: t('aiSettings.mbtiTypes.ESTJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ESFJ' as const, name: t('aiSettings.mbtiTypes.ESFJ.name'), desc: t('aiSettings.mbtiTypes.ESFJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ISTP' as const, name: t('aiSettings.mbtiTypes.ISTP.name'), desc: t('aiSettings.mbtiTypes.ISTP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
  { type: 'ISFP' as const, name: t('aiSettings.mbtiTypes.ISFP.name'), desc: t('aiSettings.mbtiTypes.ISFP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
  { type: 'ESTP' as const, name: t('aiSettings.mbtiTypes.ESTP.name'), desc: t('aiSettings.mbtiTypes.ESTP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
  { type: 'ESFP' as const, name: t('aiSettings.mbtiTypes.ESFP.name'), desc: t('aiSettings.mbtiTypes.ESFP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
])
const setMbti = async (mbti: AgentMbtiType) => {
  await configStore.setAgentMbti(mbti)
}

async function loadPersonalitySettings() {
  const soul = await window.electronAPI.config.readIdentityFile('SOUL.md')
  personalityText.value = soul || ''
  personalityOriginal.value = personalityText.value
  agentNameInput.value = configStore.agentName || ''
}

async function saveAgentName() {
  const trimmed = agentNameInput.value.trim()
  if (trimmed === (configStore.agentName || '')) return
  await configStore.setAgentName(trimmed)
}

// AI 头像
const avatarFileInput = ref<HTMLInputElement | null>(null)
const currentAvatar = computed(() => configStore.agentAvatar)

function triggerAvatarSelect() {
  avatarFileInput.value?.click()
}

async function handleAvatarSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''

  if (!file.type.startsWith('image/')) return

  const MAX_SIZE = 128
  const dataUrl = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let w = img.width, h = img.height
        if (w > MAX_SIZE || h > MAX_SIZE) {
          const scale = MAX_SIZE / Math.max(w, h)
          w = Math.round(w * scale)
          h = Math.round(h * scale)
        }
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/png'))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
  await configStore.setAgentAvatar(dataUrl)
}

async function removeAvatar() {
  await configStore.setAgentAvatar('')
}

async function savePersonalityText() {
  if (!personalityDirty.value) return
  personalitySaving.value = true
  personalityError.value = ''
  try {
    const safeText = personalityText.value.length > FILE_MAX_LENGTH
      ? personalityText.value.substring(0, FILE_MAX_LENGTH)
      : personalityText.value
    await window.electronAPI.config.writeIdentityFile('SOUL.md', safeText)
    personalityText.value = safeText
    personalityOriginal.value = safeText
  } catch (e) {
    console.error('保存灵魂定义失败:', e)
    personalityError.value = t('awaken.personalitySaveFailed')
  } finally {
    personalitySaving.value = false
  }
}

function resetPersonalityText() {
  personalityText.value = personalityOriginal.value
  personalityError.value = ''
}

async function loadIdentityText() {
  identityText.value = await window.electronAPI.config.readIdentityFile('IDENTITY.md') || ''
  identityOriginal.value = identityText.value
}

async function saveIdentityText() {
  if (!identityDirty.value) return
  identitySaving.value = true
  identityError.value = ''
  try {
    const safeText = identityText.value.length > FILE_MAX_LENGTH
      ? identityText.value.substring(0, FILE_MAX_LENGTH)
      : identityText.value
    await window.electronAPI.config.writeIdentityFile('IDENTITY.md', safeText)
    identityText.value = safeText
    identityOriginal.value = safeText
  } catch (e) {
    console.error('保存身份描述失败:', e)
    identityError.value = t('awaken.personalitySaveFailed')
  } finally {
    identitySaving.value = false
  }
}

function resetIdentityText() {
  identityText.value = identityOriginal.value
  identityError.value = ''
}

async function loadHeartbeatText() {
  heartbeatText.value = await window.electronAPI.config.readIdentityFile('HEARTBEAT.md') || ''
  heartbeatOriginal.value = heartbeatText.value
}

async function saveHeartbeatText() {
  if (!heartbeatDirty.value) return
  heartbeatSaving.value = true
  heartbeatError.value = ''
  try {
    await window.electronAPI.config.writeIdentityFile('HEARTBEAT.md', heartbeatText.value)
    heartbeatOriginal.value = heartbeatText.value
  } catch (e) {
    console.error('保存心跳指令失败:', e)
    heartbeatError.value = t('awaken.heartbeatSaveFailed')
  } finally {
    heartbeatSaving.value = false
  }
}

function resetHeartbeatText() {
  heartbeatText.value = heartbeatOriginal.value
  heartbeatError.value = ''
}

async function resetHeartbeatToDefault() {
  const confirmed = await showConfirm({
    type: 'warning',
    title: t('common.confirm'),
    message: t('awaken.heartbeatResetConfirm'),
  })
  if (!confirmed) return
  try {
    await window.electronAPI.watch.resetHeartbeat()
    await loadHeartbeatText()
  } catch (e) {
    console.error('重置心跳指令失败:', e)
  }
}

async function requestClose() {
  if (personalityDirty.value) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('common.confirm'),
      message: t('awaken.personalityUnsavedConfirm'),
    })
    if (!confirmed) return
  }
  emit('close', awakened.value)
}

// ==================== Lifecycle ====================

let refreshTimer: NodeJS.Timeout | null = null
let cleanupWatchStarted: (() => void) | null = null
let cleanupWatchCompleted: (() => void) | null = null

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') requestClose()
}

onErrorCaptured((err, _instance, info) => {
  console.error('[Awaken] Error captured:', err, 'info:', info)
  return false
})

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown, true)
  await Promise.all([loadWatchData().catch(() => {}), loadAwakenSettings()])
  loadPersonalitySettings()
  loadIdentityText()
  loadHeartbeatText().catch(e => console.error('[Awaken] loadHeartbeatText failed:', e))
  refreshTimer = setInterval(loadWatchData, 5 * 60 * 1000)

  cleanupWatchStarted = window.electronAPI.watch.onTaskStarted?.((data: any) => {
    if (data?.watchId === '__wakeup__' || data?.watchId === '__daily_patrol__') {
      patrolling.value = true
      patrolStatus.value = 'running'
      patrolMessage.value = t('awaken.patrolRunning')
    }
  }) ?? null
  cleanupWatchCompleted = window.electronAPI.watch.onTaskCompleted?.((data: any) => {
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
  }) ?? null
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
  if (refreshTimer) clearInterval(refreshTimer)
  if (patrolStatusTimer) clearTimeout(patrolStatusTimer)
  if (patrolTimeout) clearTimeout(patrolTimeout)
  if (ecgFlashTimer) clearTimeout(ecgFlashTimer)
  if (ecgBootTimer) clearTimeout(ecgBootTimer)
  cleanupWatchStarted?.(); cleanupWatchCompleted?.()
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
<button class="btn-icon btn-icon-header" @click="requestClose" :title="t('watch.close')">
          <X :size="18" />
        </button>
      </div>

      <p class="awaken-desc">{{ t('awaken.description') }}</p>

      <!-- 觉醒主控栏：常驻顶部，避免切 tab 时一闪一闪 -->
      <div class="awaken-bar">
        <div class="awaken-left">
          <label class="awaken-toggle" @click.prevent="requestAwakenToggle">
            <input type="checkbox" :checked="awakened" tabindex="-1" aria-hidden="true" />
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
        <div class="awaken-center" :class="{ pending: !awakenReady }" :title="t('awaken.intervalDesc')">
          <span class="interval-label">{{ t('awaken.intervalPrefix') }}</span>
          <input
            type="number"
            v-model.number="heartbeatInterval"
            :min="1" :max="1440"
            class="interval-input"
            :disabled="!awakenReady"
            @change="updateAwakenInterval"
          />
          <span class="interval-unit">{{ t('awaken.intervalUnit') }}</span>
          <span class="interval-label">{{ t('awaken.intervalSuffix') }}</span>
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
        <nav class="panel-nav">
          <div class="nav-group">
            <button class="nav-item" :class="{ active: activeTab === 'identity' }" @click="switchTab('identity')">
              <Fingerprint :size="16" />
              <span>{{ t('awaken.identityNav') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'personality' }" @click="switchTab('personality')">
              <Sparkles :size="16" />
              <span>{{ t('awaken.personalityNav') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'heartbeat' }" @click="switchTab('heartbeat')">
              <HeartPulse :size="16" />
              <span>{{ t('awaken.heartbeatNav') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'wakeupHistory' }" @click="switchTab('wakeupHistory', loadWatchData)">
              <History :size="16" />
              <span>{{ t('watch.executionHistory') }}</span>
            </button>
          </div>
        </nav>

        <!-- Content Area -->
        <div class="panel-content">

          <!-- ===================== 身份 (IDENTITY.md) ===================== -->
          <template v-if="activeTab === 'identity'">
            <div class="content-page personality-page">
              <div class="personality-content">
                <div class="personality-header">
                  <h3>{{ t('awaken.identityTitle') }}</h3>
                </div>
                <p class="personality-hint">{{ t('awaken.identityHint') }}</p>
                <div class="identity-profile-row">
                  <div class="identity-avatar-area" @click="triggerAvatarSelect" :title="t('awaken.avatarChange')">
                    <img v-if="currentAvatar" :src="currentAvatar" class="identity-avatar-img" />
                    <div v-else class="identity-avatar-placeholder">
                      <Camera :size="20" />
                    </div>
                    <div class="identity-avatar-overlay">
                      <Camera :size="14" />
                    </div>
                    <button v-if="currentAvatar" class="identity-avatar-remove" @click.stop="removeAvatar" :title="t('awaken.avatarRemove')">
                      <X :size="10" />
                    </button>
                    <input
                      ref="avatarFileInput"
                      type="file"
                      accept="image/*"
                      style="display: none"
                      @change="handleAvatarSelect"
                    />
                  </div>
                  <div class="identity-name-group">
                    <div class="personality-name-row">
                      <label class="personality-name-label">{{ t('awaken.nameLabel') }}</label>
                      <input
                        v-model="agentNameInput"
                        class="personality-name-input"
                        :placeholder="t('awaken.namePlaceholder')"
                        maxlength="20"
                        spellcheck="false"
                        @blur="saveAgentName"
                        @keydown.enter="($event.target as HTMLInputElement)?.blur()"
                      />
                    </div>
                    <span class="identity-avatar-hint">{{ t('awaken.avatarHint') }}</span>
                  </div>
                </div>
                <textarea
                  v-model="identityText"
                  class="personality-textarea"
                  :placeholder="t('awaken.identityPlaceholder')"
                  :maxlength="FILE_MAX_LENGTH"
                  spellcheck="false"
                />
                <div class="personality-footer">
                  <span class="personality-length">{{ identityText.length }}/{{ FILE_MAX_LENGTH }} {{ t('awaken.personalityChars') }}</span>
                  <div class="personality-buttons">
                    <button class="btn btn-sm" @click="resetIdentityText" :disabled="!identityDirty || identitySaving">
                      {{ t('common.reset') }}
                    </button>
                    <button class="btn btn-primary btn-sm" @click="saveIdentityText" :disabled="!identityDirty || identitySaving">
                      {{ identitySaving ? t('common.saving') : t('common.save') }}
                    </button>
                  </div>
                </div>
                <div v-if="identityError" class="personality-error">{{ identityError }}</div>
              </div>
            </div>
          </template>

          <!-- ===================== 灵魂 (SOUL.md) ===================== -->
          <template v-if="activeTab === 'personality'">
            <div class="content-page personality-page soul-page">
              <div class="personality-content">
                <div class="personality-header">
                  <h3>{{ t('awaken.personalityTitle') }}</h3>
                </div>
                <p class="personality-hint">{{ t('awaken.personalityHint') }}</p>
                <textarea
                  v-model="personalityText"
                  class="personality-textarea"
                  :placeholder="t('awaken.personalityPlaceholder')"
                  :maxlength="FILE_MAX_LENGTH"
                  spellcheck="false"
                />
                <div class="personality-footer">
                  <span class="personality-length">{{ personalityText.length }}/{{ FILE_MAX_LENGTH }} {{ t('awaken.personalityChars') }}</span>
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

                <div class="mbti-section">
                  <div class="personality-header">
                    <h3>{{ t('aiSettings.agentPersonality') }}</h3>
                    <button v-if="currentMbti" class="btn btn-sm" @click="setMbti(null)">{{ t('common.reset') }}</button>
                  </div>
                  <p class="personality-hint">{{ t('aiSettings.agentPersonalityDesc') }}</p>
                  <div class="mbti-grid">
                    <div
                      v-for="item in mbtiTypes"
                      :key="item.type"
                      class="mbti-card"
                      :class="{ active: currentMbti === item.type }"
                      @click="setMbti(item.type)"
                    >
                      <div class="mbti-type">{{ item.type }}</div>
                      <div class="mbti-name">{{ item.name }}</div>
                      <div class="mbti-desc">{{ item.desc }}</div>
                      <div class="mbti-group">{{ item.group }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- ===================== 心跳指令 (HEARTBEAT.md) ===================== -->
          <template v-if="activeTab === 'heartbeat'">
            <div class="content-page personality-page">
              <div class="personality-content">
                <div class="personality-header">
                  <h3>{{ t('awaken.heartbeatTitle') }}</h3>
                </div>
                <p class="personality-hint">{{ t('awaken.heartbeatHint') }}</p>
                <textarea
                  v-model="heartbeatText"
                  class="personality-textarea heartbeat-textarea"
                  :placeholder="t('awaken.heartbeatPlaceholder')"
                  spellcheck="false"
                />
                <div class="personality-footer">
                  <span class="personality-length">{{ heartbeatText.length }} {{ t('awaken.personalityChars') }}</span>
                  <div class="personality-buttons">
                    <button class="btn btn-sm" @click="resetHeartbeatToDefault">
                      {{ t('awaken.heartbeatResetDefault') }}
                    </button>
                    <button class="btn btn-sm" @click="resetHeartbeatText" :disabled="!heartbeatDirty || heartbeatSaving">
                      {{ t('common.reset') }}
                    </button>
                    <button class="btn btn-primary btn-sm" @click="saveHeartbeatText" :disabled="!heartbeatDirty || heartbeatSaving">
                      {{ heartbeatSaving ? t('common.saving') : t('common.save') }}
                    </button>
                  </div>
                </div>
                <div v-if="heartbeatError" class="personality-error">{{ heartbeatError }}</div>
              </div>
            </div>
          </template>

          <!-- ===================== 执行历史 ===================== -->
          <template v-if="activeTab === 'wakeupHistory'">
            <div class="content-page">
              <!-- 历史详情视图 -->
              <WatchHistoryDetailView
                v-if="selectedHistoryRecord"
                :record="selectedHistoryRecord"
                :loading="historyDetailLoading"
                :steps="historyDetailSteps"
                :user-task="historyDetailUserTask"
                :back-label="t('watch.backToHistory')"
                @back="closeHistoryDetail"
              />

              <!-- 历史列表视图：仅唤醒（__wakeup__） -->
              <template v-else>
                <div class="page-toolbar">
                  <span class="page-title">
                    {{ t('watch.wakeupHistoryTitle') }}
                  </span>
                  <div class="toolbar-right">
                    <button class="btn btn-sm btn-danger" @click="clearWatchHistory" :disabled="watchHistory.length === 0"><Trash2 :size="14" /> {{ t('watch.clearHistory') }}</button>
                  </div>
                </div>

                <div v-if="filteredHistory.length > 0" class="history-table">
                  <template v-for="group in groupedHistory" :key="group.dateKey">
                    <div class="history-date-header">{{ group.label }}</div>
                    <div v-for="h in group.records" :key="h.id" class="history-row" :class="{ clickable: !!h.agentSessionId }" @click="viewHistoryDetail(h)">
                      <span class="history-status-icon" :class="getStatusClass(h.status)">{{ getStatusIcon(h.status) }}</span>
                      <span class="history-trigger-chip">{{ getTriggerTypeLabel(h.triggerType) }}</span>
                      <span class="history-watch-name" :title="h.watchName">{{ h.watchName }}</span>
                      <span class="history-spacer"></span>
                      <span class="history-time">{{ formatTime(h.at) }}</span>
                      <span class="history-duration">{{ formatDuration(h.duration) }}</span>
                      <span v-if="h.agentSessionId" class="history-detail-indicator">
                        <Eye :size="12" />
                      </span>
                    </div>
                  </template>
                  <div v-if="historyHasMore" class="history-load-more">
                    <button class="btn btn-sm" @click="loadMoreHistory" :disabled="historyLoadingMore">
                      {{ historyLoadingMore ? t('watch.loading') : t('watch.loadMore') }}
                    </button>
                  </div>
                </div>

                <div v-else class="empty-state" style="padding: 60px 20px;">
                  <History :size="40" class="empty-icon" />
                  <p>{{ watchHistory.length === 0 ? t('watch.noHistory') : t('watch.noHistoryInFilter') }}</p>
                </div>
              </template>
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
  /* 与欢迎页 / 壳层顶条同一行高，红绿灯按这个高度垂直居中 */
  height: var(--workbench-panel-header-height, 38px);
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
  padding: 2px 8px;
  background: rgba(var(--brand-vital-rgb), 0.12);
  border-radius: 10px;
  color: var(--brand-vital);
}

/* 与 main.css 的 .btn-icon-header 变体同源（22x22, padding 2, radius 5, hover scale 1.04）；
   scoped 特异性更高，保证 HMR / 加载顺序变化时依然稳定生效。 */
.panel-header .btn-icon {
  width: 22px;
  height: 22px;
  padding: 2px;
  border-radius: 5px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  /* header-stats 在 userWatches 为空时 v-if=false 不渲染，没有它撑满中间空间，
     X 会紧挨标题。这里强制让 X 始终被推到右侧，与 settings-header 的 space-between 对齐。 */
  margin-left: auto;
}
.panel-header .btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  transform: scale(1.04);
}

/* ==================== Awaken Bar ==================== */

.awaken-desc {
  margin: 0;
  padding: 6px 16px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

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
  background: var(--brand-vital);
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
  color: var(--brand-vital);
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
  stroke: var(--brand-vital);
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  filter: drop-shadow(0 0 2px rgba(var(--brand-vital-rgb), 0.6));
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
  border-color: rgba(var(--brand-vital-rgb), 0.3);
  box-shadow: 0 0 8px rgba(var(--brand-vital-rgb), 0.1);
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
  border-color: var(--accent-primary);
}
.interval-unit {
  font-size: 11px;
  color: var(--text-tertiary);
}
.interval-label {
  font-size: 11px;
  color: var(--text-tertiary);
  white-space: nowrap;
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

.content-page.personality-page.soul-page {
  overflow-y: auto;
  height: auto;
}

.soul-page .personality-textarea {
  flex: none;
  height: 240px;
}

.heartbeat-textarea {
  min-height: 320px;
  font-size: 12px;
  line-height: 1.5;
}

.personality-content {
  display: flex;
  flex-direction: column;
  padding: 20px 24px;
  height: 100%;
  gap: 12px;
}

.personality-name-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.personality-name-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
}

.personality-name-input {
  flex: 0 0 160px;
  padding: 5px 10px;
  font-size: 13px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.2s;
}
.personality-name-input:focus {
  border-color: var(--primary);
}
.personality-name-input::placeholder {
  color: var(--text-muted);
}

.identity-profile-row {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.identity-avatar-area {
  position: relative;
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  transition: border-color 0.2s;
}
.identity-avatar-area:hover {
  border-color: var(--primary);
}
.identity-avatar-area:hover .identity-avatar-overlay {
  opacity: 1;
}

.identity-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.identity-avatar-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.identity-avatar-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s;
}

.identity-avatar-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;
  transition: opacity 0.2s;
}
.identity-avatar-area:hover .identity-avatar-remove {
  opacity: 1;
}
.identity-avatar-remove:hover {
  background: rgba(220, 38, 38, 0.8);
}

.identity-name-group {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-height: 64px;
}

.identity-avatar-hint {
  font-size: 11px;
  color: var(--text-muted);
}

.personality-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.personality-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.personality-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
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
  color: var(--color-error);
}

.mbti-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.mbti-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.mbti-card {
  display: flex;
  flex-direction: column;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
}

.mbti-card:hover {
  border-color: var(--accent-primary);
  background: var(--bg-surface);
}

.mbti-card.active {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.15);
}

.mbti-type {
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-primary);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.mbti-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-top: 4px;
}

.mbti-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.4;
}

.mbti-group {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color);
  opacity: 0.7;
}

.patrol-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
}
.patrol-hint.running { color: var(--brand-vital); }
.patrol-hint.done { color: var(--brand-vital); }
.patrol-hint.skipped { color: var(--text-tertiary); }
.patrol-hint.error { color: var(--color-error); }

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
.nav-item.active { background: var(--accent-primary); color: var(--accent-contrast); }

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

.detail-title .back-to-overview {
  margin-right: 4px;
  flex-shrink: 0;
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
.list-item { position: relative; }
.list-item:hover { background: var(--bg-hover); }
.list-item.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
}
.list-item.active::before {
  content: '';
  position: absolute;
  left: 0; top: 6px; bottom: 6px;
  width: 3px;
  background: var(--accent-primary);
  border-radius: 0 2px 2px 0;
}
.list-item.disabled { opacity: 0.5; }
.list-item.running { border-color: var(--accent-primary); background: rgba(var(--accent-rgb, 137, 180, 250), 0.06); }

/* 状态汇总条 */
.status-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 4px 10px;
  flex-wrap: wrap;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  background: transparent;
  border-radius: 12px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.status-chip:hover {
  background: var(--bg-hover);
}
.status-chip.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.15);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.5);
  color: var(--text-primary);
}
.status-chip .chip-label { font-weight: 500; }
.status-chip .chip-count {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.status-chip .chip-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.status-chip.status-normal .chip-dot   { background: #2ecc71; }
.status-chip.status-error .chip-dot    { background: #e74c3c; }
.status-chip.status-running .chip-dot  { background: var(--accent-primary); animation: chip-pulse 1.4s ease-in-out infinite; }
.status-chip.status-disabled .chip-dot { background: var(--text-muted); }
@keyframes chip-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.35; }
}

/* 总览虚拟项 */
.list-item-overview { gap: 8px; }
.overview-icon {
  width: 22px; height: 22px;
  display: flex; align-items: center; justify-content: center;
  color: var(--accent-primary);
  flex-shrink: 0;
}
.overview-badge {
  background: var(--status-error, #c0392b);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 9px;
  min-width: 18px;
  text-align: center;
  flex-shrink: 0;
}
.overview-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 4px 6px 4px;
  opacity: 0.6;
}
.empty-state-list {
  padding: 24px 12px;
  text-align: center;
}

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
.item-sub {
  font-size: 11px; color: var(--text-muted); margin-top: 2px;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
}
.item-sub-segment { display: inline-flex; align-items: center; gap: 3px; }
.item-sub-muted { font-style: italic; opacity: 0.7; }
.item-sub-next {
  padding: 1px 6px;
  background: rgba(var(--accent-rgb, 100 200 250), 0.08);
  color: var(--accent-primary);
  border-radius: 8px;
}

.btn-icon-sm {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  padding: 4px; border-radius: 4px; opacity: 0.55; transition: all 0.15s;
}
.list-item:hover .btn-icon-sm, .list-item.active .btn-icon-sm { opacity: 1; }
.btn-icon-sm:hover { background: var(--bg-hover); color: var(--text-primary); opacity: 1; }

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

/* 手动触发时的 Agent 内心独白（复用 history-steps-list 渲染） */
.live-output-section { background: rgba(0,0,0,0.15); border-radius: 8px; padding: 12px; border: 1px solid var(--border-color); }
.live-steps.history-steps-list { max-height: 280px; overflow-y: auto; }
.live-output-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted);
  padding: 4px 0;
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
  display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); grid-auto-rows: 1fr; gap: 12px; padding: 16px 24px;
}

.sensor-card {
  display: flex; align-items: flex-start; gap: 12px;
  padding: 14px 16px; border-radius: 8px; border: 1px solid var(--border-color);
  min-height: 88px;
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
.detail-tag.warn { background: rgba(var(--color-error-rgb), 0.12); color: var(--color-error); }
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

.history-table { display: flex; flex-direction: column; gap: 1px; padding: 8px 24px; flex: 1; overflow-y: auto; }

.history-date-header {
  font-size: 11px; font-weight: 600; color: var(--text-muted);
  padding: 12px 12px 4px; letter-spacing: 0.3px;
  position: sticky; top: 0; background: var(--bg-secondary, var(--bg-primary)); z-index: 1;
}
.history-date-header:first-child { padding-top: 4px; }

.history-row {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 12px; border-radius: 6px; font-size: 12px;
}
.history-row:hover { background: var(--bg-hover); }
.history-row.clickable { cursor: pointer; }

.history-status-icon { min-width: 18px; text-align: center; font-size: 13px; }
.history-trigger-chip {
  display: inline-flex; align-items: center;
  padding: 1px 8px;
  background: var(--bg-tertiary); color: var(--text-secondary);
  border-radius: 10px; font-size: 11px; font-weight: 500;
  white-space: nowrap; flex-shrink: 0;
}
.history-watch-name {
  color: var(--text-primary);
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.history-spacer { display: none; }
.history-time { color: var(--text-muted); min-width: 70px; text-align: right; flex-shrink: 0; }
.history-duration { color: var(--text-muted); min-width: 50px; text-align: right; flex-shrink: 0; }
.history-detail-indicator { color: var(--text-muted); opacity: 0.5; transition: opacity 0.15s; flex-shrink: 0; }
.history-row:hover .history-detail-indicator { opacity: 0.9; }
.history-load-more { display: flex; justify-content: center; padding: 12px 0; }

/* 关切详情内嵌的最近运行列表 */
.watch-recent-list { display: flex; flex-direction: column; gap: 2px; }
.watch-recent-row {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; border-radius: 6px; font-size: 12px;
}
.watch-recent-row:hover { background: var(--bg-hover); }
.watch-recent-row.clickable { cursor: pointer; }
.watch-recent-empty { color: var(--text-muted); font-size: 12px; padding: 6px 4px; }
.history-spacer-grow { flex: 1; }


.history-detail-meta { color: var(--text-muted); font-size: 12px; margin-left: auto; }
.history-detail-content { flex: 1; overflow-y: auto; padding: 0 24px 24px; }
.history-fallback-output { padding: 12px 16px; background: var(--bg-primary, rgba(0,0,0,0.15)); border-radius: 8px; font-size: 13px; line-height: 1.6; }
.fallback-text { white-space: pre-wrap; word-break: break-word; }
.history-legacy-hint { padding: 8px 0; font-size: 11px; color: var(--text-muted); opacity: 0.7; }
.detail-section-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }

/* Prompt section (collapsible) */
.history-prompt-section { margin-bottom: 8px; }
.prompt-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 0; user-select: none; }
.prompt-toggle:hover .detail-section-label { color: var(--text-primary); }
.prompt-toggle-icon { font-size: 10px; color: var(--text-muted); width: 12px; }
.history-detail-task { padding: 12px 16px; background: var(--bg-primary, rgba(0,0,0,0.15)); border-radius: 8px; margin-top: 4px; margin-bottom: 8px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; color: var(--text-secondary); }

/* Steps list (same style as AiPanel) */
.history-steps-list { padding: 4px 0; }
.history-steps-list .agent-step-inline { display: flex; gap: 8px; padding: 8px 0; font-size: 12px; color: var(--text-secondary); border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
.history-steps-list .agent-step-inline:last-child { border-bottom: none; }
.history-steps-list .step-icon { flex-shrink: 0; font-size: 14px; }
.history-steps-list .step-content { flex: 1; min-width: 0; }
.history-steps-list .step-text { word-break: break-word; line-height: 1.5; }
.history-steps-list .agent-message-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.history-steps-list .agent-message-stack > .step-text.step-analysis { margin: 0; }
.history-steps-list .agent-message-stack :deep(.thinking-block) { margin: 0; }
.history-steps-list .step-text.step-analysis {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.03);
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
}
.history-steps-list .step-text.markdown-content :deep(p) { margin: 0.4em 0; }
.history-steps-list .step-text.markdown-content :deep(p:first-child) { margin-top: 0; }
.history-steps-list .step-text.markdown-content :deep(p:last-child) { margin-bottom: 0; }
.history-steps-list .step-text.markdown-content :deep(pre) { margin: 0.5em 0; overflow-x: auto; }
.history-steps-list .agent-step-inline.thinking { color: rgba(var(--brand-vital-rgb), 0.85); }
.history-steps-list .agent-step-inline.tool_call { color: var(--accent-primary); }
.history-steps-list .agent-step-inline.tool_call .step-text { color: var(--text-primary); white-space: pre-wrap; }
.history-steps-list .agent-step-inline.tool_result { color: var(--text-secondary); }
.history-steps-list .agent-step-inline.tool_result .step-text { font-size: 11px; max-height: 120px; overflow-y: auto; background: var(--bg-primary, rgba(0,0,0,0.1)); padding: 6px 8px; border-radius: 4px; }
.step-tool-result { margin-top: 4px; font-size: 11px; max-height: 150px; overflow-y: auto; background: var(--bg-primary, rgba(0,0,0,0.1)); padding: 6px 8px; border-radius: 4px; color: var(--text-secondary); }
.step-tool-result pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.history-steps-list .agent-step-inline.error { color: var(--color-error); }
.history-steps-list .agent-step-inline.message { color: var(--text-primary); }
.history-steps-list .agent-step-inline.final_result { color: var(--text-primary); }
.history-steps-list .agent-step-inline.final_result .step-text { background: rgba(40, 167, 69, 0.08); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(40, 167, 69, 0.2); }

/* ==================== Edit Form ==================== */

.edit-section {
  margin-bottom: 16px;
}

.edit-section-half {
  flex: 1;
  min-width: 0;
}

.edit-row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.edit-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.edit-input,
.edit-select {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}

.edit-input:focus,
.edit-select:focus,
.edit-textarea:focus {
  border-color: var(--accent-primary);
}

.edit-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.6;
  font-family: var(--font-mono);
  resize: vertical;
  min-height: 100px;
  outline: none;
  transition: border-color 0.2s;
}

.edit-triggers {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edit-trigger-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.edit-input-inline {
  flex: 1;
  min-width: 0;
}

.edit-input-short {
  width: 80px;
  flex: none;
  text-align: center;
}

.edit-hint {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

.edit-select {
  cursor: pointer;
  appearance: auto;
}

/* ==================== Animations ==================== */

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spinning { animation: spin 1s linear infinite; }

/* ==================== Header 与主标题"旗鱼"左对齐 ==================== */
/* macOS 非全屏下红绿灯浮层会贴在 modal 左上角，header 需要和 app-header 同步让位；
   使用 --mac-traffic-light-inset（与主 header 同源）保证"觉醒"标题与"旗鱼"左边界对齐；
   全屏时红绿灯消失，恢复默认 12px */
.app-container.is-mac .panel-header {
  padding-left: var(--mac-traffic-light-inset);
}
.app-container.is-mac.is-fullscreen .panel-header {
  padding-left: 12px;
}
</style>
