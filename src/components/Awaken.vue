<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type AgentMbtiType } from '../stores/config'
import {
  X, Play, Trash2, Eye, RefreshCw, History,
  Clock, Heart, Globe, Zap, FolderOpen, Calendar, Mail,
  LayoutTemplate, Plus, Sparkles, Pencil, Fingerprint, UserRound
} from 'lucide-vue-next'

const { t } = useI18n()
const configStore = useConfigStore()

const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{ close: []; 'awakened-change': [value: boolean] }>()

// ==================== Types ====================

import type {
  WatchTriggerType, WatchRunStatus, WatchTrigger,
  WatchDefinition, WatchHistoryRecord, WatchPriority
} from '@shared/types'

type WatchOutputType = 'desktop' | 'im' | 'notification' | 'log' | 'silent'

interface WatchTemplateInfo {
  id: string; name: string; nameEn: string; description: string; descriptionEn: string; category: string; icon: string
}

// ==================== Navigation ====================

type NavTab = 'watches' | 'templates' | 'sensors' | 'history' | 'personality' | 'identity' | 'userProfile'
const VALID_TABS: NavTab[] = ['watches', 'templates', 'sensors', 'history', 'personality', 'identity', 'userProfile']
const activeTab = ref<NavTab>(
  props.initialTab && VALID_TABS.includes(props.initialTab as NavTab) ? props.initialTab as NavTab : 'watches'
)

function switchTab(tab: NavTab, onSwitch?: () => void) {
  const dirtyChecks: Array<{ from: NavTab; dirty: boolean; reset: () => void }> = [
    { from: 'personality', dirty: personalityDirty.value, reset: resetPersonalityText },
    { from: 'identity', dirty: identityDirty.value, reset: resetIdentityText },
    { from: 'userProfile', dirty: userProfileDirty.value, reset: resetUserProfileText },
  ]
  for (const check of dirtyChecks) {
    if (activeTab.value === check.from && tab !== check.from && check.dirty) {
      if (!confirm(t('awaken.personalityUnsavedConfirm'))) return
      check.reset()
    }
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

// 手动触发时的 Agent 实时输出（内心独白）
const WATCH_AGENT_ID = '__watch__'
const liveExecutionWatchId = ref<string | null>(null)
const liveSteps = ref<Array<{ id: string; type: string; content: string; toolName?: string; toolResult?: string }>>([])

// 执行历史详情查看
const selectedHistoryRecord = ref<WatchHistoryRecord | null>(null)
const historyDetailSteps = ref<Array<{ id: string; type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string; timestamp: number }>>([])
const historyDetailLoading = ref(false)
const historyDetailUserTask = ref('')
const historyDetailFinalResult = ref('')
const historyPromptExpanded = ref(false)

interface ToolGroup { toolName: string; args: string; result: string; timestamp: number }
interface ConversationItem { type: 'thinking' | 'tool' | 'message' | 'error'; content: string; timestamp: number; tools?: ToolGroup[] }

const historyConversation = computed<ConversationItem[]>(() => {
  const items: ConversationItem[] = []
  const steps = historyDetailSteps.value
  let i = 0
  while (i < steps.length) {
    const s = steps[i]
    if (s.type === 'user_task' || s.type === 'final_result' || s.type === 'streaming' || s.type === 'waiting') { i++; continue }

    if (s.type === 'thinking' && s.content) {
      items.push({ type: 'thinking', content: s.content, timestamp: s.timestamp })
    } else if (s.type === 'tool_call') {
      const toolGroup: ToolGroup[] = []
      while (i < steps.length && steps[i].type === 'tool_call') {
        const call = steps[i]
        const resultStep = (i + 1 < steps.length && steps[i + 1].type === 'tool_result') ? steps[++i] : null
        toolGroup.push({
          toolName: call.toolName || 'unknown',
          args: call.content || '',
          result: resultStep?.toolResult || resultStep?.content || '',
          timestamp: call.timestamp
        })
        i++
      }
      if (toolGroup.length) items.push({ type: 'tool', content: '', timestamp: toolGroup[0].timestamp, tools: toolGroup })
      continue
    } else if (s.type === 'message' && s.content) {
      items.push({ type: 'message', content: s.content, timestamp: s.timestamp })
    } else if (s.type === 'error' && s.content) {
      items.push({ type: 'error', content: s.content, timestamp: s.timestamp })
    }
    i++
  }
  return items
})

const templates = ref<WatchTemplateInfo[]>([])
const selectedTemplateCategory = ref<string>('all')
const sensorStatus = ref<Array<{ id: string; name: string; running: boolean; details?: Record<string, any> }>>([])
const recentEvents = ref<Array<{ id: string; type: string; source: string; timestamp: number }>>([])
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

const userProfileText = ref('')
const userProfileOriginal = ref('')
const userProfileSaving = ref(false)
const userProfileError = ref('')
const userProfileDirty = computed(() => userProfileText.value !== userProfileOriginal.value)

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
    default: return (trigger as { type: string }).type
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

/** Agent 步骤图标（用于内心独白展示） */
const getStepIcon = (type: string): string => {
  const map: Record<string, string> = {
    thinking: '🤔', tool_call: '🔧', tool_result: '📋', message: '💬', error: '❌',
    final_result: '✅', waiting: '⏳', asking: '❓', user_task: '👤'
  }
  return map[type] || '•'
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

const BUILTIN_WATCH_IDS = new Set(['__wakeup__', '__daily_patrol__'])
const userWatches = computed(() =>
  configStore.agentDebugMode
    ? watches.value
    : watches.value.filter(w => !BUILTIN_WATCH_IDS.has(w.id))
)
const enabledCount = computed(() => userWatches.value.filter(w => w.enabled).length)

watch(() => userWatches.value, (list) => {
  if (selectedWatch.value && !list.some(w => w.id === selectedWatch.value!.id)) {
    selectedWatch.value = null
  }
})

// ==================== Watch Operations ====================

const selectWatch = (w: WatchDefinition) => {
  if (editing.value) cancelEditing()
  selectedWatch.value = w
}

// ==================== Edit Mode ====================

const editing = ref(false)
const editSaving = ref(false)
const editForm = ref<{
  name: string
  description: string
  prompt: string
  priority: WatchPriority
  outputType: WatchOutputType
  skills: string
  triggers: WatchTrigger[]
}>({
  name: '',
  description: '',
  prompt: '',
  priority: 'normal',
  outputType: 'desktop',
  skills: '',
  triggers: [],
})

function startEditing() {
  if (!selectedWatch.value) return
  const w = selectedWatch.value
  editForm.value = {
    name: w.name,
    description: w.description || '',
    prompt: w.prompt,
    priority: w.priority,
    outputType: w.output.type,
    skills: w.skills?.join(', ') || '',
    triggers: JSON.parse(JSON.stringify(toRaw(w.triggers))),
  }
  editing.value = true
}

function cancelEditing() {
  editing.value = false
  editSaving.value = false
}

async function saveEditing() {
  if (!selectedWatch.value || editSaving.value) return
  const form = editForm.value
  if (!form.name.trim()) { alert(t('watch.validation.nameRequired')); return }
  if (!form.prompt.trim()) { alert(t('watch.validation.promptRequired')); return }

  editSaving.value = true
  try {
    const updates: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      prompt: form.prompt.trim(),
      priority: form.priority,
      output: { type: form.outputType },
      skills: form.skills.trim() ? form.skills.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      triggers: form.triggers,
    }
    const updated = await window.electronAPI.watch.update(selectedWatch.value.id, updates)
    if (updated) {
      const idx = watches.value.findIndex(x => x.id === updated.id)
      if (idx >= 0) watches.value[idx] = updated
      selectedWatch.value = updated
    }
    editing.value = false
  } catch (e) {
    console.error('Failed to save watch:', e)
  } finally {
    editSaving.value = false
  }
}

function updateTriggerField(index: number, field: string, value: unknown) {
  const trigger = editForm.value.triggers[index] as Record<string, unknown>
  trigger[field] = value
}

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
  selectedHistoryRecord.value = null
}

const viewHistoryDetail = async (record: WatchHistoryRecord) => {
  historyPromptExpanded.value = false
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

  try {
    const agentRecord = await window.electronAPI.history.getAgentRecordById(record.agentSessionId)
    if (agentRecord) {
      historyDetailSteps.value = agentRecord.steps || []
      historyDetailUserTask.value = agentRecord.userTask || ''
      historyDetailFinalResult.value = agentRecord.finalResult || ''
    }
  } catch (e) {
    console.error('Failed to load agent record:', e)
  } finally {
    historyDetailLoading.value = false
  }
}

const closeHistoryDetail = () => {
  selectedHistoryRecord.value = null
  historyDetailSteps.value = []
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
    emit('awakened-change', awakened.value)
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

async function loadUserProfileText() {
  userProfileText.value = await window.electronAPI.config.readIdentityFile('USER.md') || ''
  userProfileOriginal.value = userProfileText.value
}

async function saveUserProfileText() {
  if (!userProfileDirty.value) return
  userProfileSaving.value = true
  userProfileError.value = ''
  try {
    const safeText = userProfileText.value.length > FILE_MAX_LENGTH
      ? userProfileText.value.substring(0, FILE_MAX_LENGTH)
      : userProfileText.value
    await window.electronAPI.config.writeIdentityFile('USER.md', safeText)
    userProfileText.value = safeText
    userProfileOriginal.value = safeText
  } catch (e) {
    console.error('保存用户画像失败:', e)
    userProfileError.value = t('awaken.personalitySaveFailed')
  } finally {
    userProfileSaving.value = false
  }
}

function resetUserProfileText() {
  userProfileText.value = userProfileOriginal.value
  userProfileError.value = ''
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
let cleanupAgentStep: (() => void) | null = null

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') requestClose()
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown, true)
  await Promise.all([loadWatchData().catch(() => {}), loadAwakenSettings()])
  loadPersonalitySettings()
  loadIdentityText()
  loadUserProfileText()
  loadTemplates()
  refreshTimer = setInterval(loadWatchData, 5 * 60 * 1000)

  cleanupWatchStarted = window.electronAPI.watch.onTaskStarted?.((data: any) => {
    if (data?.watchId) markWatchRunning(data.watchId)
    if (data?.watchId && data?.executionType === 'assistant') {
      liveExecutionWatchId.value = data.watchId
      liveSteps.value = []
    }
    if (data?.watchId === '__wakeup__' || data?.watchId === '__daily_patrol__') {
      patrolling.value = true
      patrolStatus.value = 'running'
      patrolMessage.value = t('awaken.patrolRunning')
    }
  }) ?? null
  cleanupWatchCompleted = window.electronAPI.watch.onTaskCompleted?.((data: any) => {
    if (data?.watchId) markWatchCompleted(data.watchId)
    // 不在此清空 liveExecutionWatchId，保留内心独白供用户查看
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
  // 监听关切助手的 Agent 步骤，用于详情面板展示内心独白
  cleanupAgentStep = window.electronAPI.agent.onStep((data: { agentId: string; step: { id: string; type: string; content: string; toolName?: string; toolResult?: string } }) => {
    if (data.agentId !== WATCH_AGENT_ID || !liveExecutionWatchId.value) return
    const step = data.step
    const idx = liveSteps.value.findIndex(s => s.id === step.id)
    const entry = { id: step.id, type: step.type, content: step.content, toolName: step.toolName, toolResult: step.toolResult }
    if (idx >= 0) {
      liveSteps.value[idx] = entry
    } else {
      liveSteps.value.push(entry)
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
  cleanupWatchStarted?.(); cleanupWatchCompleted?.(); cleanupAgentStep?.()
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
        <div class="header-stats" v-if="userWatches.length > 0">
          <span class="stat-item">{{ enabledCount }} {{ t('watch.activeCount') }}</span>
        </div>
        <button class="btn-icon" @click="requestClose" :title="t('watch.close')">
          <X :size="18" />
        </button>
      </div>

      <p class="awaken-desc">{{ t('awaken.description') }}</p>

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
        <!-- Left Nav -->
        <nav class="panel-nav">
          <div class="nav-group">
            <div class="nav-group-label">{{ t('awaken.navCharacter') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'identity' }" @click="switchTab('identity')">
              <Fingerprint :size="16" />
              <span>{{ t('awaken.identityNav') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'personality' }" @click="switchTab('personality')">
              <Sparkles :size="16" />
              <span>{{ t('awaken.personalityNav') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'userProfile' }" @click="switchTab('userProfile')">
              <UserRound :size="16" />
              <span>{{ t('awaken.userProfileNav') }}</span>
            </button>
          </div>
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navAutomation') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'watches' }" @click="switchTab('watches')">
              <Eye :size="16" />
              <span>{{ t('watch.watches') }}</span>
              <span v-if="userWatches.length" class="nav-badge">{{ userWatches.length }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'templates' }" @click="switchTab('templates', loadTemplates)">
              <LayoutTemplate :size="16" />
              <span>{{ t('watch.templates') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'sensors' }" @click="switchTab('sensors', () => { loadSensorData() })">
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

          <!-- ===================== 身份 (IDENTITY.md) ===================== -->
          <template v-if="activeTab === 'identity'">
            <div class="content-page personality-page">
              <div class="personality-content">
                <div class="personality-header">
                  <h3>{{ t('awaken.identityTitle') }}</h3>
                </div>
                <p class="personality-hint">{{ t('awaken.identityHint') }}</p>
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

          <!-- ===================== 用户画像 (USER.md) ===================== -->
          <template v-if="activeTab === 'userProfile'">
            <div class="content-page personality-page">
              <div class="personality-content">
                <div class="personality-header">
                  <h3>{{ t('awaken.userProfileTitle') }}</h3>
                </div>
                <p class="personality-hint">{{ t('awaken.userProfileHint') }}</p>
                <textarea
                  v-model="userProfileText"
                  class="personality-textarea"
                  :placeholder="t('awaken.userProfilePlaceholder')"
                  :maxlength="FILE_MAX_LENGTH"
                  spellcheck="false"
                />
                <div class="personality-footer">
                  <span class="personality-length">{{ userProfileText.length }}/{{ FILE_MAX_LENGTH }} {{ t('awaken.personalityChars') }}</span>
                  <div class="personality-buttons">
                    <button class="btn btn-sm" @click="resetUserProfileText" :disabled="!userProfileDirty || userProfileSaving">
                      {{ t('common.reset') }}
                    </button>
                    <button class="btn btn-primary btn-sm" @click="saveUserProfileText" :disabled="!userProfileDirty || userProfileSaving">
                      {{ userProfileSaving ? t('common.saving') : t('common.save') }}
                    </button>
                  </div>
                </div>
                <div v-if="userProfileError" class="personality-error">{{ userProfileError }}</div>
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
                  <div v-for="w in userWatches" :key="w.id" class="list-item" :class="{ active: selectedWatch?.id === w.id, disabled: !w.enabled, running: runningWatches.has(w.id) }" @click="selectWatch(w)">
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

                  <div v-if="userWatches.length === 0 && !loading" class="empty-state">
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
                    <div class="detail-title" v-if="!editing">
                      <h3>{{ selectedWatch.name }}</h3>
                      <span class="watch-badge" :class="{ enabled: selectedWatch.enabled }">{{ selectedWatch.enabled ? t('watch.enabled') : t('watch.disabled') }}</span>
                      <span class="priority-badge" :class="selectedWatch.priority">{{ selectedWatch.priority }}</span>
                    </div>
                    <div class="detail-title" v-else>
                      <h3>{{ t('watch.editWatch') }}</h3>
                    </div>
                    <div class="detail-actions" v-if="!editing">
                      <button class="btn btn-sm" @click="startEditing">
                        <Pencil :size="14" /> {{ t('watch.edit') }}
                      </button>
                      <button class="btn btn-primary btn-sm" @click="triggerWatch(selectedWatch)" :disabled="runningWatches.has(selectedWatch.id)">
                        <Play :size="14" /> {{ t('watch.trigger') }}
                      </button>
                      <button class="btn btn-danger btn-sm" @click="deleteWatch(selectedWatch)">
                        <Trash2 :size="14" />
                      </button>
                    </div>
                    <div class="detail-actions" v-else>
                      <button class="btn btn-sm" @click="cancelEditing" :disabled="editSaving">{{ t('watch.cancel') }}</button>
                      <button class="btn btn-primary btn-sm" @click="saveEditing" :disabled="editSaving">
                        {{ editSaving ? t('common.saving') : t('watch.save') }}
                      </button>
                    </div>
                  </div>

                  <!-- ===== Edit Mode ===== -->
                  <div class="detail-body" v-if="editing">
                    <div class="edit-section">
                      <label class="edit-label">{{ t('watch.name') }}</label>
                      <input v-model="editForm.name" class="edit-input" :placeholder="t('watch.namePlaceholder')" spellcheck="false" />
                    </div>
                    <div class="edit-section">
                      <label class="edit-label">{{ t('watch.description') }}</label>
                      <input v-model="editForm.description" class="edit-input" :placeholder="t('watch.descriptionPlaceholder')" spellcheck="false" />
                    </div>
                    <div class="edit-section">
                      <label class="edit-label">{{ t('watch.prompt') }}</label>
                      <textarea v-model="editForm.prompt" class="edit-textarea" :placeholder="t('watch.promptPlaceholder')" spellcheck="false" rows="6" />
                    </div>
                    <div class="edit-section">
                      <label class="edit-label">{{ t('watch.triggers') }}</label>
                      <div class="edit-triggers">
                        <div v-for="(tr, idx) in editForm.triggers" :key="idx" class="edit-trigger-item">
                          <span class="trigger-badge trigger-badge-lg">
                            <component :is="getTriggerIcon(tr.type)" :size="12" /> {{ tr.type }}
                          </span>
                          <template v-if="tr.type === 'cron'">
                            <input
                              class="edit-input edit-input-inline"
                              :value="(tr as any).expression"
                              @input="updateTriggerField(idx, 'expression', ($event.target as HTMLInputElement).value)"
                              placeholder="cron expression"
                              spellcheck="false"
                            />
                          </template>
                          <template v-else-if="tr.type === 'interval'">
                            <input
                              type="number"
                              class="edit-input edit-input-short"
                              :value="(tr as any).seconds"
                              @input="updateTriggerField(idx, 'seconds', Number(($event.target as HTMLInputElement).value))"
                              min="10"
                            />
                            <span class="edit-hint">{{ t('watch.triggerIntervalUnit') }}</span>
                          </template>
                          <template v-else-if="tr.type === 'file_change'">
                            <input
                              class="edit-input edit-input-inline"
                              :value="(tr as any).paths?.join(', ')"
                              @input="updateTriggerField(idx, 'paths', ($event.target as HTMLInputElement).value.split(',').map((s: string) => s.trim()).filter(Boolean))"
                              :placeholder="t('watch.filePathsPlaceholder')"
                              spellcheck="false"
                            />
                          </template>
                          <template v-else-if="tr.type === 'calendar'">
                            <input
                              type="number"
                              class="edit-input edit-input-short"
                              :value="(tr as any).beforeMinutes"
                              @input="updateTriggerField(idx, 'beforeMinutes', Number(($event.target as HTMLInputElement).value))"
                              min="1"
                            />
                            <span class="edit-hint">min</span>
                          </template>
                        </div>
                      </div>
                    </div>
                    <div class="edit-row">
                      <div class="edit-section edit-section-half">
                        <label class="edit-label">{{ t('watch.priority') }}</label>
                        <select v-model="editForm.priority" class="edit-select">
                          <option value="high">{{ t('watch.priorityHigh') }}</option>
                          <option value="normal">{{ t('watch.priorityNormal') }}</option>
                          <option value="low">{{ t('watch.priorityLow') }}</option>
                        </select>
                      </div>
                      <div class="edit-section edit-section-half">
                        <label class="edit-label">{{ t('watch.outputType') }}</label>
                        <select v-model="editForm.outputType" class="edit-select">
                          <option value="desktop">{{ t('watch.outputDesktop') }}</option>
                          <option value="im">{{ t('watch.outputIM') }}</option>
                          <option value="notification">{{ t('watch.outputNotification') }}</option>
                          <option value="log">{{ t('watch.outputLog') }}</option>
                          <option value="silent">{{ t('watch.outputSilent') }}</option>
                        </select>
                      </div>
                    </div>
                    <div class="edit-section">
                      <label class="edit-label">{{ t('watch.skills') }}</label>
                      <input v-model="editForm.skills" class="edit-input" :placeholder="t('watch.skillsPlaceholder')" spellcheck="false" />
                    </div>
                  </div>

                  <!-- ===== View Mode ===== -->
                  <div class="detail-body" v-else>
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
                    <!-- 手动触发时的 Agent 内心独白（实时执行过程） -->
                    <div class="detail-section live-output-section" v-if="selectedWatch.id === liveExecutionWatchId && liveSteps.length > 0">
                      <h4>{{ t('watch.liveOutput') }}</h4>
                      <div class="live-steps">
                        <div
                          v-for="step in liveSteps"
                          :key="step.id"
                          class="live-step"
                          :class="[step.type, step.type === 'thinking' ? 'step-thinking' : '']"
                        >
                          <span class="live-step-icon">{{ getStepIcon(step.type) }}</span>
                          <div class="live-step-content">
                            <div v-if="step.type === 'tool_call' && step.toolName" class="live-step-tool">
                              {{ step.toolName }}{{ step.content ? ': ' + step.content : '' }}
                            </div>
                            <div v-else-if="step.content" class="live-step-text">{{ step.content }}</div>
                            <div v-if="step.toolResult && step.toolResult !== step.content" class="live-step-result">
                              <pre>{{ step.toolResult }}</pre>
                            </div>
                          </div>
                        </div>
                      </div>
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

            </div>
          </template>

          <!-- ===================== 执行历史 ===================== -->
          <template v-if="activeTab === 'history'">
            <div class="content-page">
              <!-- 历史详情视图 -->
              <template v-if="selectedHistoryRecord">
                <div class="page-toolbar">
                  <button class="btn btn-sm" @click="closeHistoryDetail" style="gap: 4px;">
                    ← {{ t('watch.backToHistory') }}
                  </button>
                  <span class="page-title" style="margin-left: 8px;">
                    <span :class="getStatusClass(selectedHistoryRecord.status)">{{ getStatusIcon(selectedHistoryRecord.status) }}</span>
                    {{ selectedHistoryRecord.watchName }}
                  </span>
                  <span class="history-detail-meta">
                    {{ formatFullDate(selectedHistoryRecord.at) }} · {{ formatDuration(selectedHistoryRecord.duration) }}
                  </span>
                </div>

                <div class="history-detail-content">
                  <!-- 加载中 -->
                  <div v-if="historyDetailLoading" class="empty-state" style="padding: 40px 20px;">
                    <RefreshCw :size="24" class="spinning empty-icon" />
                    <p>{{ t('watch.loadingConversation') }}</p>
                  </div>

                  <template v-else>
                    <!-- 最终结果（放最上面，先看结论） -->
                    <div v-if="historyDetailFinalResult" class="history-detail-final">
                      {{ historyDetailFinalResult }}
                    </div>

                    <!-- 有完整步骤记录 -->
                    <template v-if="historyConversation.length > 0">
                      <!-- 任务提示词（默认折叠） -->
                      <div v-if="historyDetailUserTask" class="history-prompt-section">
                        <div class="prompt-toggle" @click="historyPromptExpanded = !historyPromptExpanded">
                          <span class="prompt-toggle-icon">{{ historyPromptExpanded ? '▼' : '▶' }}</span>
                          <span class="detail-section-label" style="margin-bottom: 0;">{{ t('watch.prompt') }}</span>
                        </div>
                        <div v-if="historyPromptExpanded" class="history-detail-task">
                          {{ historyDetailUserTask }}
                        </div>
                      </div>

                      <!-- 对话流程 -->
                      <div class="detail-section-label" style="padding: 8px 0 6px;">{{ t('watch.viewConversation') }}</div>
                      <div class="conversation-flow">
                        <template v-for="(item, idx) in historyConversation" :key="idx">
                          <!-- 思考 -->
                          <div v-if="item.type === 'thinking'" class="conv-item conv-thinking">
                            <span class="conv-icon">🤔</span>
                            <div class="conv-body">
                              <div class="conv-text-clamp">{{ item.content }}</div>
                            </div>
                            <span class="conv-time">{{ formatDate(item.timestamp) }}</span>
                          </div>

                          <!-- 工具调用组 -->
                          <div v-else-if="item.type === 'tool'" class="conv-item conv-tool-group">
                            <div v-for="(tool, ti) in item.tools" :key="ti" class="conv-tool">
                              <div class="conv-tool-header">
                                <span class="conv-icon">🔧</span>
                                <span class="conv-tool-name">{{ tool.toolName }}</span>
                                <span v-if="tool.args" class="conv-tool-args">{{ tool.args }}</span>
                                <span class="conv-time">{{ formatDate(tool.timestamp) }}</span>
                              </div>
                              <div v-if="tool.result" class="conv-tool-result">
                                <pre>{{ tool.result }}</pre>
                              </div>
                            </div>
                          </div>

                          <!-- 消息 -->
                          <div v-else-if="item.type === 'message'" class="conv-item conv-message">
                            <span class="conv-icon">💬</span>
                            <div class="conv-body">{{ item.content }}</div>
                            <span class="conv-time">{{ formatDate(item.timestamp) }}</span>
                          </div>

                          <!-- 错误 -->
                          <div v-else-if="item.type === 'error'" class="conv-item conv-error">
                            <span class="conv-icon">❌</span>
                            <div class="conv-body">{{ item.content }}</div>
                            <span class="conv-time">{{ formatDate(item.timestamp) }}</span>
                          </div>
                        </template>
                      </div>
                    </template>

                    <!-- 无完整步骤：回退显示 output -->
                    <template v-else>
                      <div v-if="selectedHistoryRecord.output" class="history-fallback-output">
                        <div class="detail-section-label">{{ t('watch.outputLabel') }}</div>
                        <div class="fallback-text">{{ selectedHistoryRecord.output }}</div>
                      </div>
                      <div v-if="!selectedHistoryRecord.agentSessionId" class="history-legacy-hint">
                        {{ t('watch.legacyRecordHint') }}
                      </div>
                    </template>
                  </template>
                </div>
              </template>

              <!-- 历史列表视图 -->
              <template v-else>
                <div class="page-toolbar">
                  <span class="page-title">{{ t('watch.executionHistory') }}</span>
                  <div class="toolbar-right">
                    <button class="btn btn-sm btn-danger" @click="clearWatchHistory" :disabled="watchHistory.length === 0"><Trash2 :size="14" /> {{ t('watch.clearHistory') }}</button>
                  </div>
                </div>

                <div v-if="watchHistory.length > 0" class="history-table">
                  <div v-for="h in watchHistory" :key="h.id" class="history-row" :class="{ clickable: !!h.agentSessionId }" @click="viewHistoryDetail(h)">
                    <span class="history-status-icon" :class="getStatusClass(h.status)">{{ getStatusIcon(h.status) }}</span>
                    <span class="history-name">{{ h.watchName }}</span>
                    <span class="history-trigger"><component :is="getTriggerIcon(h.triggerType as WatchTriggerType)" :size="10" /> {{ h.triggerType }}</span>
                    <span class="history-time">{{ formatFullDate(h.at) }}</span>
                    <span class="history-duration">{{ formatDuration(h.duration) }}</span>
                    <span v-if="h.agentSessionId" class="history-detail-indicator">
                      <Eye :size="12" />
                    </span>
                  </div>
                </div>

                <div v-if="watchHistory.length === 0" class="empty-state" style="padding: 60px 20px;">
                  <History :size="40" class="empty-icon" />
                  <p>{{ t('watch.noHistory') }}</p>
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
  color: #ef4444;
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
  background: rgba(137, 180, 250, 0.15);
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

/* 手动触发时的 Agent 内心独白 */
.live-output-section { background: rgba(0,0,0,0.15); border-radius: 8px; padding: 12px; border: 1px solid var(--border-color); }
.live-steps { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.live-step {
  display: flex; gap: 10px; align-items: flex-start;
  padding: 8px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5;
  background: var(--bg-primary, rgba(0,0,0,0.2));
}
.live-step.step-thinking { opacity: 0.9; }
.live-step.thinking { border-left: 3px solid rgba(59, 130, 246, 0.5); }
.live-step.tool_call { border-left: 3px solid var(--accent-primary); color: var(--accent-primary); }
.live-step.tool_result { border-left: 3px solid rgba(40, 167, 69, 0.5); }
.live-step.final_result { border-left: 3px solid #28a745; background: rgba(40, 167, 69, 0.08); }
.live-step.error { border-left: 3px solid #dc3545; color: #dc3545; }
.live-step-icon { flex-shrink: 0; font-size: 14px; }
.live-step-content { flex: 1; min-width: 0; word-break: break-word; }
.live-step-tool { font-weight: 500; }
.live-step-text { color: var(--text-secondary); white-space: pre-wrap; }
.live-step-result { margin-top: 6px; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px; font-size: 11px; overflow-x: auto; }
.live-step-result pre { margin: 0; white-space: pre-wrap; word-break: break-word; }

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
.history-row.clickable { cursor: pointer; }

.history-status-icon { min-width: 20px; text-align: center; font-size: 13px; }
.history-name { flex: 1; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-trigger { display: flex; align-items: center; gap: 3px; color: var(--text-muted); min-width: 80px; }
.history-time { color: var(--text-muted); min-width: 150px; }
.history-duration { color: var(--text-muted); min-width: 60px; text-align: right; }
.history-detail-indicator { color: var(--text-muted); opacity: 0; transition: opacity 0.15s; }
.history-row:hover .history-detail-indicator { opacity: 0.7; }

.history-detail-meta { color: var(--text-muted); font-size: 12px; margin-left: auto; }
.history-detail-content { flex: 1; overflow-y: auto; padding: 0 24px 24px; }
.history-detail-final { padding: 12px 16px; background: rgba(40, 167, 69, 0.08); border: 1px solid rgba(40, 167, 69, 0.2); border-radius: 8px; margin-bottom: 12px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; }
.history-fallback-output { padding: 12px 16px; background: var(--bg-primary, rgba(0,0,0,0.15)); border-radius: 8px; font-size: 13px; line-height: 1.6; }
.fallback-text { white-space: pre-wrap; word-break: break-word; }
.history-legacy-hint { padding: 8px 0; font-size: 11px; color: var(--text-muted); opacity: 0.7; }
.detail-section-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.step-time { flex-shrink: 0; font-size: 10px; color: var(--text-muted); opacity: 0.6; }

/* Prompt section (collapsible) */
.history-prompt-section { margin-bottom: 8px; }
.prompt-toggle { display: flex; align-items: center; gap: 6px; cursor: pointer; padding: 6px 0; user-select: none; }
.prompt-toggle:hover .detail-section-label { color: var(--text-primary); }
.prompt-toggle-icon { font-size: 10px; color: var(--text-muted); width: 12px; }
.history-detail-task { padding: 12px 16px; background: var(--bg-primary, rgba(0,0,0,0.15)); border-radius: 8px; margin-top: 4px; margin-bottom: 8px; font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; color: var(--text-secondary); }

/* Conversation flow */
.conversation-flow { display: flex; flex-direction: column; gap: 6px; }
.conv-item { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; line-height: 1.5; padding: 8px 12px; border-radius: 6px; }
.conv-icon { flex-shrink: 0; font-size: 13px; width: 20px; text-align: center; }
.conv-body { flex: 1; min-width: 0; word-break: break-word; white-space: pre-wrap; }
.conv-time { flex-shrink: 0; font-size: 10px; color: var(--text-muted); opacity: 0.6; }

.conv-thinking { background: rgba(59, 130, 246, 0.06); border-left: 3px solid rgba(59, 130, 246, 0.3); }
.conv-text-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; color: var(--text-secondary); }
.conv-message { background: var(--bg-primary, rgba(0,0,0,0.1)); }
.conv-error { background: rgba(220, 53, 69, 0.08); border-left: 3px solid rgba(220, 53, 69, 0.4); color: #dc3545; }

.conv-tool-group { display: flex; flex-direction: column; gap: 4px; padding: 0; }
.conv-tool { border-radius: 6px; overflow: hidden; border: 1px solid var(--border-color, rgba(255,255,255,0.06)); }
.conv-tool-header { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--bg-primary, rgba(0,0,0,0.15)); font-size: 12px; }
.conv-tool-name { font-weight: 600; color: var(--accent-primary); }
.conv-tool-args { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 11px; }
.conv-tool-result { padding: 8px 12px; font-size: 11px; background: var(--bg-primary, rgba(0,0,0,0.08)); max-height: 200px; overflow-y: auto; }
.conv-tool-result pre { margin: 0; white-space: pre-wrap; word-break: break-word; }

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
</style>
