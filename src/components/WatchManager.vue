<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Plus, Play, Trash2, Edit3, Eye, EyeOff, RefreshCw, History, Clock, Heart, Globe, Zap, Terminal, Server, MessageSquare, Bell, Send, FileText, ChevronDown, ChevronRight, FolderOpen, Calendar, Mail, BookTemplate, LayoutTemplate, Database } from 'lucide-vue-next'

const { t } = useI18n()

// ==================== 类型 ====================

type WatchTriggerType = 'cron' | 'interval' | 'heartbeat' | 'webhook' | 'manual' | 'file_change' | 'calendar' | 'email'
type WatchPriority = 'high' | 'normal' | 'low'
type WatchOutputType = 'im' | 'notification' | 'log' | 'silent'
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
  id: string
  name: string
  nameEn: string
  description: string
  descriptionEn: string
  category: string
  icon: string
}

interface WatchDefinition {
  id: string
  name: string
  description?: string
  enabled: boolean
  triggers: WatchTrigger[]
  prompt: string
  skills?: string[]
  execution: { type: 'assistant' | 'local' | 'ssh'; sshSessionId?: string; sshSessionName?: string; workingDirectory?: string; timeout?: number }
  output: { type: WatchOutputType }
  preCheck?: { enabled: boolean; hint?: string }
  state?: Record<string, unknown>
  priority: WatchPriority
  createdAt: number
  updatedAt: number
  expiresAt?: number
  lastRun?: { at: number; status: WatchRunStatus; duration: number; triggerType: string; output?: string; error?: string; skipReason?: string }
  nextRun?: number
}

interface WatchHistoryRecord {
  id: string
  watchId: string
  watchName: string
  at: number
  status: WatchRunStatus
  duration: number
  triggerType: string
  output?: string
  error?: string
  skipReason?: string
}

const emit = defineEmits<{ close: [] }>()

// ==================== 状态 ====================

const watches = ref<WatchDefinition[]>([])
const history = ref<WatchHistoryRecord[]>([])
const loading = ref(true)
const selectedWatch = ref<WatchDefinition | null>(null)
const activeTab = ref<'watches' | 'history' | 'sensors' | 'templates'>('watches')
const runningWatches = ref<Set<string>>(new Set())

// 模板
const templates = ref<WatchTemplateInfo[]>([])
const selectedTemplateCategory = ref<string>('all')

// 共享状态
const sharedState = ref<Record<string, unknown>>({})

// 编辑器状态
const showEditor = ref(false)
const editingWatch = ref<WatchDefinition | null>(null)

// 编辑器表单
const formName = ref('')
const formDescription = ref('')
const formPrompt = ref('')
const formTriggerTypes = ref<Set<WatchTriggerType>>(new Set(['manual']))
const formCronExpression = ref('0 9 * * *')
const formIntervalValue = ref(30)
const formIntervalUnit = ref<'m' | 'h'>('m')
const formExecutionType = ref<'local' | 'ssh' | 'assistant'>('local')
const formOutputType = ref<WatchOutputType>('log')
const formPreCheckEnabled = ref(false)
const formPreCheckHint = ref('')
const formPriority = ref<WatchPriority>('normal')
const formEnabled = ref(true)
const formSkills = ref('')

// 新触发器表单
const formFilePaths = ref('')
const formFilePattern = ref('')
const formCalendarIcsPath = ref('')
const formCalendarBeforeMinutes = ref(15)
const formEmailFrom = ref('')
const formEmailSubject = ref('')

// Sensor 状态
const sensorStatus = ref<Array<{ id: string; name: string; running: boolean }>>([])
const recentEvents = ref<Array<{ id: string; type: string; source: string; timestamp: number }>>([])

// ==================== 格式化工具 ====================

const formatDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const formatFullDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}m`

const getTriggerLabel = (trigger: WatchTrigger): string => {
  switch (trigger.type) {
    case 'cron': return `Cron: ${trigger.expression}`
    case 'interval': {
      const s = trigger.seconds || 0
      return s >= 3600 ? `${s / 3600}h` : `${s / 60}m`
    }
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
  const map: Record<WatchOutputType, string> = {
    im: t('watch.outputIM'),
    notification: t('watch.outputNotification'),
    log: t('watch.outputLog'),
    silent: t('watch.outputSilent')
  }
  return map[type] || type
}

const getStatusText = (status: WatchRunStatus): string => {
  const map: Record<string, string> = {
    completed: t('watch.statusCompleted'),
    failed: t('watch.statusFailed'),
    skipped: t('watch.statusSkipped'),
    timeout: t('watch.statusTimeout'),
    cancelled: t('watch.statusCancelled'),
    running: t('watch.statusRunning')
  }
  return map[status] || status
}

const getStatusClass = (status: string): string => {
  const map: Record<string, string> = { completed: 'status-success', failed: 'status-error', skipped: 'status-skipped', timeout: 'status-warning', cancelled: 'status-muted', running: 'status-running' }
  return map[status] || ''
}

const getStatusIcon = (status: WatchRunStatus): string => {
  const map: Record<string, string> = { completed: '✓', failed: '✗', skipped: '⊘', timeout: '⏱', cancelled: '—', running: '●' }
  return map[status] || '?'
}

// ==================== 数据加载 ====================

const loadData = async () => {
  loading.value = true
  try {
    watches.value = await window.electronAPI.watch.getAll()
    history.value = await window.electronAPI.watch.getHistory(undefined, 50)
    const running = await window.electronAPI.watch.getRunning()
    runningWatches.value = new Set(running)
  } catch (e) {
    console.error('Failed to load watches:', e)
  } finally {
    loading.value = false
  }
}

const loadTemplates = async () => {
  try {
    templates.value = await window.electronAPI.watch.getTemplates()
  } catch (e) {
    console.error('Failed to load templates:', e)
  }
}

const loadSharedState = async () => {
  try {
    sharedState.value = await window.electronAPI.watch.getSharedState()
  } catch (e) {
    console.error('Failed to load shared state:', e)
  }
}

const filteredTemplates = computed(() => {
  if (selectedTemplateCategory.value === 'all') return templates.value
  return templates.value.filter(t => t.category === selectedTemplateCategory.value)
})

const useTemplate = async (tpl: WatchTemplateInfo) => {
  try {
    const watch = await window.electronAPI.watch.createFromTemplate(tpl.id)
    if (watch) {
      activeTab.value = 'watches'
      await loadData()
      selectedWatch.value = watches.value.find(w => w.id === watch.id) || null
      openEdit(selectedWatch.value!)
    }
  } catch (e) {
    console.error('Failed to create from template:', e)
  }
}

const clearSharedState = async () => {
  if (!confirm(t('watch.confirmClearSharedState'))) return
  await window.electronAPI.watch.clearSharedState()
  sharedState.value = {}
}

const loadSensorData = async () => {
  try {
    sensorStatus.value = await window.electronAPI.sensor.getStatus()
    recentEvents.value = await window.electronAPI.sensor.getRecentEvents(20)
  } catch (e) {
    console.error('Failed to load sensor data:', e)
  }
}

// ==================== Watch 操作 ====================

const selectWatch = (w: WatchDefinition) => { selectedWatch.value = w }

const toggleWatch = async (w: WatchDefinition) => {
  const updated = await window.electronAPI.watch.toggle(w.id)
  if (updated) {
    const idx = watches.value.findIndex(x => x.id === w.id)
    if (idx >= 0) watches.value[idx] = updated
    if (selectedWatch.value?.id === w.id) selectedWatch.value = updated
  }
}

const watchTimeouts = new Map<string, NodeJS.Timeout>()

const triggerWatch = async (w: WatchDefinition) => {
  try {
    await window.electronAPI.watch.trigger(w.id)
  } catch (e) {
    console.error('Failed to trigger watch:', e)
  }
}

const markWatchRunning = (watchId: string) => {
  runningWatches.value.add(watchId)
  if (watchTimeouts.has(watchId)) {
    clearTimeout(watchTimeouts.get(watchId)!)
  }
  const timeout = setTimeout(() => {
    runningWatches.value.delete(watchId)
    watchTimeouts.delete(watchId)
    loadData()
  }, 10 * 60 * 1000)
  watchTimeouts.set(watchId, timeout)
}

const markWatchCompleted = (watchId: string) => {
  runningWatches.value.delete(watchId)
  const timeout = watchTimeouts.get(watchId)
  if (timeout) {
    clearTimeout(timeout)
    watchTimeouts.delete(watchId)
  }
  loadData()
}

const deleteWatch = async (w: WatchDefinition) => {
  if (!confirm(t('watch.confirmDelete', { name: w.name }))) return
  await window.electronAPI.watch.delete(w.id)
  if (selectedWatch.value?.id === w.id) selectedWatch.value = null
  await loadData()
}

const clearHistory = async () => {
  if (!confirm(t('watch.confirmClearHistory'))) return
  await window.electronAPI.watch.clearHistory()
  history.value = []
}

// ==================== 编辑器 ====================

const openCreate = () => {
  editingWatch.value = null
  formName.value = ''
  formDescription.value = ''
  formPrompt.value = ''
  formTriggerTypes.value = new Set(['manual'])
  formCronExpression.value = '0 9 * * *'
  formIntervalValue.value = 30
  formIntervalUnit.value = 'm'
  formExecutionType.value = 'local'
  formOutputType.value = 'log'
  formPreCheckEnabled.value = false
  formPreCheckHint.value = ''
  formPriority.value = 'normal'
  formEnabled.value = true
  formSkills.value = ''
  formFilePaths.value = ''
  formFilePattern.value = ''
  formCalendarIcsPath.value = ''
  formCalendarBeforeMinutes.value = 15
  formEmailFrom.value = ''
  formEmailSubject.value = ''
  showEditor.value = true
}

const openEdit = (w: WatchDefinition) => {
  editingWatch.value = w
  formName.value = w.name
  formDescription.value = w.description || ''
  formPrompt.value = w.prompt
  formTriggerTypes.value = new Set(w.triggers.map(t => t.type))
  const cronTrigger = w.triggers.find(t => t.type === 'cron')
  if (cronTrigger?.expression) formCronExpression.value = cronTrigger.expression
  const intervalTrigger = w.triggers.find(t => t.type === 'interval')
  if (intervalTrigger?.seconds) {
    if (intervalTrigger.seconds >= 3600) { formIntervalValue.value = intervalTrigger.seconds / 3600; formIntervalUnit.value = 'h' }
    else { formIntervalValue.value = intervalTrigger.seconds / 60; formIntervalUnit.value = 'm' }
  }
  formExecutionType.value = w.execution.type
  formOutputType.value = w.output.type
  formPreCheckEnabled.value = w.preCheck?.enabled ?? false
  formPreCheckHint.value = w.preCheck?.hint ?? ''
  formPriority.value = w.priority
  formEnabled.value = w.enabled
  formSkills.value = w.skills?.join(', ') || ''

  const fileChangeTrigger = w.triggers.find(t => t.type === 'file_change')
  formFilePaths.value = fileChangeTrigger?.paths?.join(', ') || ''
  formFilePattern.value = fileChangeTrigger?.pattern || ''
  const calTrigger = w.triggers.find(t => t.type === 'calendar')
  formCalendarIcsPath.value = calTrigger?.icsPath || ''
  formCalendarBeforeMinutes.value = calTrigger?.beforeMinutes || 15
  const emailTrigger = w.triggers.find(t => t.type === 'email')
  formEmailFrom.value = emailTrigger?.filter?.from || ''
  formEmailSubject.value = emailTrigger?.filter?.subject || ''

  showEditor.value = true
}

const toggleTrigger = (type: WatchTriggerType) => {
  if (formTriggerTypes.value.has(type)) {
    formTriggerTypes.value.delete(type)
  } else {
    formTriggerTypes.value.add(type)
  }
}

const saveWatch = async () => {
  if (!formName.value.trim() || !formPrompt.value.trim()) {
    alert(t('watch.validation.nameRequired'))
    return
  }
  if (formTriggerTypes.value.size === 0) {
    alert(t('watch.validation.triggerRequired'))
    return
  }

  const triggers: WatchTrigger[] = []
  if (formTriggerTypes.value.has('cron')) triggers.push({ type: 'cron', expression: formCronExpression.value })
  if (formTriggerTypes.value.has('interval')) {
    const seconds = formIntervalUnit.value === 'h' ? formIntervalValue.value * 3600 : formIntervalValue.value * 60
    triggers.push({ type: 'interval', seconds })
  }
  if (formTriggerTypes.value.has('heartbeat')) triggers.push({ type: 'heartbeat' })
  if (formTriggerTypes.value.has('webhook')) triggers.push({ type: 'webhook', token: '' })
  if (formTriggerTypes.value.has('manual')) triggers.push({ type: 'manual' })
  if (formTriggerTypes.value.has('file_change')) {
    const paths = formFilePaths.value.split(',').map(p => p.trim()).filter(Boolean)
    if (paths.length === 0) { alert(t('watch.validation.filePathRequired')); return }
    triggers.push({ type: 'file_change', paths, pattern: formFilePattern.value.trim() || undefined } as any)
  }
  if (formTriggerTypes.value.has('calendar')) {
    triggers.push({ type: 'calendar', beforeMinutes: formCalendarBeforeMinutes.value, icsPath: formCalendarIcsPath.value.trim() || undefined } as any)
  }
  if (formTriggerTypes.value.has('email')) {
    const filter: any = { unseen: true }
    if (formEmailFrom.value.trim()) filter.from = formEmailFrom.value.trim()
    if (formEmailSubject.value.trim()) filter.subject = formEmailSubject.value.trim()
    triggers.push({ type: 'email', filter } as any)
  }

  const skills = formSkills.value.trim() ? formSkills.value.split(',').map(s => s.trim()).filter(Boolean) : undefined

  const params = {
    name: formName.value.trim(),
    description: formDescription.value.trim() || undefined,
    prompt: formPrompt.value.trim(),
    triggers,
    skills,
    execution: { type: formExecutionType.value, timeout: 300 },
    output: { type: formOutputType.value },
    preCheck: formPreCheckEnabled.value ? { enabled: true, hint: formPreCheckHint.value.trim() || undefined } : undefined,
    priority: formPriority.value,
    enabled: formEnabled.value
  }

  if (editingWatch.value) {
    await window.electronAPI.watch.update(editingWatch.value.id, params)
  } else {
    await window.electronAPI.watch.create(params)
  }

  showEditor.value = false
  await loadData()
}

// ==================== Sensor 操作 ====================

const triggerHeartbeat = async () => {
  await window.electronAPI.sensor.triggerHeartbeat()
  setTimeout(loadSensorData, 500)
}

// ==================== 常用 Cron 预设 ====================

const outputOptions = computed(() => [
  { v: 'im', l: t('watch.outputIM'), i: Send },
  { v: 'notification', l: t('watch.outputNotification'), i: Bell },
  { v: 'log', l: t('watch.outputLog'), i: FileText },
  { v: 'silent', l: t('watch.outputSilent'), i: EyeOff },
])

const cronPresets = [
  { label: '8:00', value: '0 8 * * *' },
  { label: '9:00', value: '0 9 * * *' },
  { label: '1h', value: '0 * * * *' },
  { label: '30m', value: '*/30 * * * *' },
  { label: 'Mon-Fri 9:00', value: '0 9 * * 1-5' },
  { label: 'Mon 9:00', value: '0 9 * * 1' },
]

// ==================== 生命周期 ====================

let refreshTimer: NodeJS.Timeout | null = null
let cleanupStarted: (() => void) | null = null
let cleanupCompleted: (() => void) | null = null

onMounted(async () => {
  await loadData()
  loadTemplates()
  loadSharedState()
  refreshTimer = setInterval(loadData, 30000)

  // 监听 Watch 执行事件
  cleanupStarted = window.electronAPI.watch.onTaskStarted?.((data: any) => {
    if (data?.watchId) markWatchRunning(data.watchId)
  })
  cleanupCompleted = window.electronAPI.watch.onTaskCompleted?.((data: any) => {
    if (data?.watchId) markWatchCompleted(data.watchId)
  })
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  cleanupStarted?.()
  cleanupCompleted?.()
  for (const timeout of watchTimeouts.values()) {
    clearTimeout(timeout)
  }
  watchTimeouts.clear()
})
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="watch-manager">
      <!-- 标题栏 -->
      <div class="manager-header">
        <h2>
          <Eye :size="20" />
          {{ t('watch.title') }}
        </h2>
        <button class="btn-close" @click="emit('close')">
          <X :size="20" />
        </button>
      </div>

      <div class="manager-body">
        <!-- 左侧面板 -->
        <div class="list-panel">
          <div class="tab-bar">
            <button :class="{ active: activeTab === 'watches' }" @click="activeTab = 'watches'">
              <Eye :size="14" />
              {{ t('watch.watches') }}
            </button>
            <button :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
              <History :size="14" />
              {{ t('watch.history') }}
            </button>
            <button :class="{ active: activeTab === 'templates' }" @click="activeTab = 'templates'; loadTemplates()">
              <LayoutTemplate :size="14" />
              {{ t('watch.templates') }}
            </button>
            <button :class="{ active: activeTab === 'sensors' }" @click="activeTab = 'sensors'; loadSensorData(); loadSharedState()">
              <Heart :size="14" />
              {{ t('watch.sensors') }}
            </button>
          </div>

          <!-- Watch 列表 -->
          <template v-if="activeTab === 'watches'">
            <div class="list-toolbar">
              <button class="btn btn-primary btn-sm" @click="openCreate">
                <Plus :size="14" />
                {{ t('watch.newWatch') }}
              </button>
              <button class="btn btn-sm" @click="loadData" :disabled="loading">
                <RefreshCw :size="14" :class="{ spinning: loading }" />
              </button>
            </div>

            <div class="watch-list" v-if="!loading">
              <div
                v-for="w in watches"
                :key="w.id"
                class="watch-item"
                :class="{ active: selectedWatch?.id === w.id, disabled: !w.enabled }"
                @click="selectWatch(w)"
              >
                <div class="watch-status">
                  <button
                    class="btn-toggle"
                    :class="{ enabled: w.enabled }"
                    @click.stop="toggleWatch(w)"
                  >
                    <span class="toggle-dot"></span>
                  </button>
                </div>
                <div class="watch-info">
                  <div class="watch-name">{{ w.name }}</div>
                  <div class="watch-meta">
                    <span v-for="trigger in w.triggers" :key="trigger.type" class="trigger-badge">
                      <component :is="getTriggerIcon(trigger.type)" :size="10" />
                      {{ getTriggerLabel(trigger) }}
                    </span>
                  </div>
                  <div class="watch-last-run" v-if="w.lastRun">
                    <span :class="getStatusClass(w.lastRun.status)">{{ getStatusIcon(w.lastRun.status) }}</span>
                    {{ formatDate(w.lastRun.at) }}
                  </div>
                </div>
                <div class="watch-actions">
                  <button
                    class="btn-icon btn-sm"
                    @click.stop="triggerWatch(w)"
                    :disabled="runningWatches.has(w.id)"
                    :title="t('watch.trigger')"
                  >
                    <Play :size="14" :class="{ spinning: runningWatches.has(w.id) }" />
                  </button>
                </div>
              </div>

              <div v-if="watches.length === 0" class="empty-state">
                <Eye :size="48" class="empty-icon" />
                <p>{{ t('watch.noWatches') }}</p>
                <p class="empty-hint">{{ t('watch.createFirst') }}</p>
                <button class="btn btn-primary" @click="openCreate">{{ t('watch.newWatch') }}</button>
              </div>
            </div>
          </template>

          <!-- 历史记录 -->
          <template v-if="activeTab === 'history'">
            <div class="list-toolbar">
              <span class="history-count">{{ history.length }}</span>
              <button class="btn btn-sm btn-danger" @click="clearHistory" :disabled="history.length === 0">
                <Trash2 :size="14" />
                {{ t('watch.clearHistory') }}
              </button>
            </div>

            <div class="history-list">
              <div v-for="h in history" :key="h.id" class="history-item">
                <div class="history-status" :class="getStatusClass(h.status)">
                  {{ getStatusIcon(h.status) }}
                </div>
                <div class="history-info">
                  <div class="history-name">{{ h.watchName }}</div>
                  <div class="history-meta">
                    <span class="trigger-badge-sm">
                      <component :is="getTriggerIcon(h.triggerType as WatchTriggerType)" :size="10" />
                      {{ h.triggerType }}
                    </span>
                    <span>{{ formatFullDate(h.at) }}</span>
                    <span>{{ formatDuration(h.duration) }}</span>
                  </div>
                  <div class="history-detail" v-if="h.skipReason">{{ t('watch.statusSkipped') }}: {{ h.skipReason }}</div>
                  <div class="history-detail error-text" v-if="h.error">{{ h.error }}</div>
                </div>
              </div>

              <div v-if="history.length === 0" class="empty-state">
                <History :size="48" class="empty-icon" />
                <p>{{ t('watch.noHistory') }}</p>
              </div>
            </div>
          </template>

          <!-- 模板面板 -->
          <template v-if="activeTab === 'templates'">
            <div class="list-toolbar">
              <div class="category-filter">
                <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'all' }" @click="selectedTemplateCategory = 'all'">{{ t('watch.templateAll') }}</button>
                <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'daily' }" @click="selectedTemplateCategory = 'daily'">{{ t('watch.templateDaily') }}</button>
                <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'email' }" @click="selectedTemplateCategory = 'email'">{{ t('watch.templateEmail') }}</button>
                <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'devops' }" @click="selectedTemplateCategory = 'devops'">DevOps</button>
                <button class="filter-btn" :class="{ active: selectedTemplateCategory === 'monitor' }" @click="selectedTemplateCategory = 'monitor'">{{ t('watch.templateMonitor') }}</button>
              </div>
            </div>

            <div class="template-list">
              <div v-for="tpl in filteredTemplates" :key="tpl.id" class="template-item" @click="useTemplate(tpl)">
                <div class="template-icon">{{ tpl.icon }}</div>
                <div class="template-info">
                  <div class="template-name">{{ tpl.name }}</div>
                  <div class="template-desc">{{ tpl.description }}</div>
                </div>
                <button class="btn btn-sm btn-primary" @click.stop="useTemplate(tpl)">
                  <Plus :size="12" /> {{ t('watch.useTemplate') }}
                </button>
              </div>

              <div v-if="filteredTemplates.length === 0" class="empty-state">
                <LayoutTemplate :size="48" class="empty-icon" />
                <p>{{ t('watch.noTemplates') }}</p>
              </div>
            </div>
          </template>

          <!-- 传感器面板 -->
          <template v-if="activeTab === 'sensors'">
            <div class="list-toolbar">
              <span class="history-count">{{ t('watch.sensorStatus') }}</span>
              <button class="btn btn-sm" @click="loadSensorData">
                <RefreshCw :size="14" />
              </button>
            </div>

            <div class="sensor-list">
              <div v-for="s in sensorStatus" :key="s.id" class="sensor-item">
                <div class="sensor-indicator" :class="{ active: s.running }"></div>
                <div class="sensor-info">
                  <div class="sensor-name">{{ s.name }}</div>
                  <div class="sensor-status-text">{{ s.running ? t('watch.sensorRunning') : t('watch.sensorStopped') }}</div>
                </div>
                <button
                  v-if="s.id === 'heartbeat'"
                  class="btn btn-sm"
                  @click="triggerHeartbeat"
                  :title="t('watch.triggerHeartbeatBtn')"
                >
                  <Heart :size="14" />
                  触发
                </button>
              </div>

              <div v-if="recentEvents.length > 0" class="recent-events">
                <h4>{{ t('watch.recentEvents') }}</h4>
                <div v-for="e in recentEvents" :key="e.id" class="event-item">
                  <span class="event-time">{{ new Date(e.timestamp).toLocaleTimeString() }}</span>
                  <span class="event-type">
                    <component :is="getTriggerIcon(e.type as WatchTriggerType)" :size="12" />
                    {{ e.type }}
                  </span>
                  <span class="event-source">{{ e.source }}</span>
                </div>
              </div>

              <div v-if="Object.keys(sharedState).length > 0" class="shared-state-section">
                <div class="shared-state-header">
                  <h4><Database :size="12" /> {{ t('watch.sharedState') }}</h4>
                  <button class="btn btn-sm btn-danger" @click="clearSharedState">
                    <Trash2 :size="12" />
                  </button>
                </div>
                <div class="shared-state-content">
                  <div v-for="(value, key) in sharedState" :key="String(key)" class="state-item">
                    <span class="state-key">{{ String(key) }}</span>
                    <span class="state-value">{{ typeof value === 'object' ? JSON.stringify(value) : String(value) }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 右侧：详情 / 编辑器 -->
        <div class="detail-panel">
          <!-- 编辑器模式 -->
          <template v-if="showEditor">
            <div class="detail-header">
              <h3>{{ editingWatch ? t('watch.editWatch') : t('watch.createWatch') }}</h3>
              <button class="btn btn-sm" @click="showEditor = false">
                <X :size="14" />
              </button>
            </div>

            <div class="editor-content">
              <div class="form-section">
                <label class="form-label">{{ t('watch.name') }} *</label>
                <input type="text" v-model="formName" class="form-input" :placeholder="t('watch.namePlaceholder')" />
              </div>

              <div class="form-section">
                <label class="form-label">{{ t('watch.description') }}</label>
                <input type="text" v-model="formDescription" class="form-input" :placeholder="t('watch.descriptionPlaceholder')" />
              </div>

              <div class="form-section">
                <label class="form-label">{{ t('watch.prompt') }} *</label>
                <textarea v-model="formPrompt" class="form-textarea" rows="4" :placeholder="t('watch.promptPlaceholder')"></textarea>
              </div>

              <div class="form-section">
                <label class="form-label">{{ t('watch.triggers') }}</label>
                <div class="trigger-options">
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('cron') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('cron')" @change="toggleTrigger('cron')" />
                    <Clock :size="14" />
                    <span>{{ t('watch.triggerCron') }}</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('interval') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('interval')" @change="toggleTrigger('interval')" />
                    <RefreshCw :size="14" />
                    <span>{{ t('watch.triggerInterval') }}</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('heartbeat') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('heartbeat')" @change="toggleTrigger('heartbeat')" />
                    <Heart :size="14" />
                    <span>{{ t('watch.triggerHeartbeat') }}</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('webhook') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('webhook')" @change="toggleTrigger('webhook')" />
                    <Globe :size="14" />
                    <span>Webhook</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('manual') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('manual')" @change="toggleTrigger('manual')" />
                    <Zap :size="14" />
                    <span>{{ t('watch.triggerManual') }}</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('file_change') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('file_change')" @change="toggleTrigger('file_change')" />
                    <FolderOpen :size="14" />
                    <span>{{ t('watch.triggerFileChange') }}</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('calendar') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('calendar')" @change="toggleTrigger('calendar')" />
                    <Calendar :size="14" />
                    <span>{{ t('watch.triggerCalendar') }}</span>
                  </label>
                  <label class="trigger-option" :class="{ selected: formTriggerTypes.has('email') }">
                    <input type="checkbox" :checked="formTriggerTypes.has('email')" @change="toggleTrigger('email')" />
                    <Mail :size="14" />
                    <span>{{ t('watch.triggerEmail') }}</span>
                  </label>
                </div>

                <div v-if="formTriggerTypes.has('cron')" class="trigger-config">
                  <label class="form-label-sm">Cron</label>
                  <input type="text" v-model="formCronExpression" class="form-input" placeholder="0 9 * * *" />
                  <div class="presets">
                    <button v-for="p in cronPresets" :key="p.value" class="preset-btn" :class="{ active: formCronExpression === p.value }" @click="formCronExpression = p.value">{{ p.label }}</button>
                  </div>
                </div>

                <div v-if="formTriggerTypes.has('interval')" class="trigger-config">
                  <label class="form-label-sm">{{ t('watch.triggerInterval') }}</label>
                  <div class="interval-input">
                    <input type="number" v-model.number="formIntervalValue" class="form-input interval-value" min="1" />
                    <select v-model="formIntervalUnit" class="form-select">
                      <option value="m">min</option>
                      <option value="h">hr</option>
                    </select>
                  </div>
                </div>

                <div v-if="formTriggerTypes.has('file_change')" class="trigger-config">
                  <label class="form-label-sm">{{ t('watch.filePathsLabel') }}</label>
                  <input type="text" v-model="formFilePaths" class="form-input" :placeholder="t('watch.filePathsPlaceholder')" />
                  <label class="form-label-sm" style="margin-top: 6px">{{ t('watch.filePatternLabel') }}</label>
                  <input type="text" v-model="formFilePattern" class="form-input" placeholder="*.log, *.txt" />
                </div>

                <div v-if="formTriggerTypes.has('calendar')" class="trigger-config">
                  <label class="form-label-sm">{{ t('watch.calendarBeforeLabel') }}</label>
                  <div class="interval-input">
                    <input type="number" v-model.number="formCalendarBeforeMinutes" class="form-input interval-value" min="1" max="1440" />
                    <span class="unit-text">min</span>
                  </div>
                  <label class="form-label-sm" style="margin-top: 6px">{{ t('watch.calendarIcsLabel') }}</label>
                  <input type="text" v-model="formCalendarIcsPath" class="form-input" :placeholder="t('watch.calendarIcsPlaceholder')" />
                </div>

                <div v-if="formTriggerTypes.has('email')" class="trigger-config">
                  <label class="form-label-sm">{{ t('watch.emailFromLabel') }}</label>
                  <input type="text" v-model="formEmailFrom" class="form-input" :placeholder="t('watch.emailFromPlaceholder')" />
                  <label class="form-label-sm" style="margin-top: 6px">{{ t('watch.emailSubjectLabel') }}</label>
                  <input type="text" v-model="formEmailSubject" class="form-input" :placeholder="t('watch.emailSubjectPlaceholder')" />
                </div>
              </div>

              <div class="form-section">
                <label class="form-label">{{ t('watch.outputType') }}</label>
                <div class="radio-group">
                  <label class="radio-item" v-for="opt in outputOptions" :key="opt.v">
                    <input type="radio" v-model="formOutputType" :value="opt.v" />
                    <component :is="opt.i" :size="14" />
                    {{ opt.l }}
                  </label>
                </div>
              </div>

              <div class="form-section">
                <label class="form-label">
                  <input type="checkbox" v-model="formPreCheckEnabled" />
                  {{ t('watch.preCheck') }} — {{ t('watch.preCheckDesc') }}
                </label>
                <input v-if="formPreCheckEnabled" type="text" v-model="formPreCheckHint" class="form-input" :placeholder="t('watch.preCheckHint')" />
              </div>

              <div class="form-section">
                <label class="form-label">{{ t('watch.skills') }}</label>
                <input type="text" v-model="formSkills" class="form-input" :placeholder="t('watch.skillsPlaceholder')" />
              </div>

              <div class="form-section">
                <label class="form-label">
                  <input type="checkbox" v-model="formEnabled" />
                  {{ t('watch.enabled') }}
                </label>
              </div>

              <div class="editor-actions">
                <button class="btn" @click="showEditor = false">{{ t('watch.cancel') }}</button>
                <button class="btn btn-primary" @click="saveWatch">{{ editingWatch ? t('watch.save') : t('watch.create') }}</button>
              </div>
            </div>
          </template>

          <!-- Watch 详情 -->
          <template v-else-if="selectedWatch">
            <div class="detail-header">
              <div class="detail-title">
                <h3>{{ selectedWatch.name }}</h3>
                <span class="watch-badge" :class="{ enabled: selectedWatch.enabled }">
                  {{ selectedWatch.enabled ? t('watch.enabled') : t('watch.disabled') }}
                </span>
                <span class="priority-badge" :class="selectedWatch.priority">{{ selectedWatch.priority }}</span>
              </div>
              <div class="detail-actions">
                <button class="btn btn-sm" @click="openEdit(selectedWatch)">
                  <Edit3 :size="14" /> {{ t('watch.edit') }}
                </button>
                <button class="btn btn-primary btn-sm" @click="triggerWatch(selectedWatch)" :disabled="runningWatches.has(selectedWatch.id)">
                  <Play :size="14" /> {{ t('watch.trigger') }}
                </button>
                <button class="btn btn-danger btn-sm" @click="deleteWatch(selectedWatch)">
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>

            <div class="detail-content">
              <div class="detail-section" v-if="selectedWatch.description">
                <h4>{{ t('watch.description') }}</h4>
                <p>{{ selectedWatch.description }}</p>
              </div>

              <div class="detail-section">
                <h4>{{ t('watch.triggers') }}</h4>
                <div class="trigger-list">
                  <span v-for="t in selectedWatch.triggers" :key="t.type" class="trigger-badge">
                    <component :is="getTriggerIcon(t.type)" :size="12" />
                    {{ getTriggerLabel(t) }}
                  </span>
                </div>
                <div class="detail-row" v-if="selectedWatch.nextRun && selectedWatch.enabled">
                  <span class="label">{{ t('watch.nextRun') }}:</span>
                  <span class="value">{{ formatFullDate(selectedWatch.nextRun) }}</span>
                </div>
              </div>

              <div class="detail-section">
                <h4>Prompt</h4>
                <div class="prompt-content">{{ selectedWatch.prompt }}</div>
              </div>

              <div class="detail-section" v-if="selectedWatch.skills?.length">
                <h4>{{ t('watch.skills') }}</h4>
                <div class="skills-list">
                  <span v-for="s in selectedWatch.skills" :key="s" class="skill-badge">{{ s }}</span>
                </div>
              </div>

              <div class="detail-section">
                <h4>{{ t('watch.outputType') }}</h4>
                <div class="detail-row">
                  <span class="label">{{ t('watch.outputType') }}:</span>
                  <span class="value">{{ getOutputLabel(selectedWatch.output.type) }}</span>
                </div>
              </div>

              <div class="detail-section" v-if="selectedWatch.preCheck?.enabled">
                <h4>Pre-check</h4>
                <p>✓ {{ t('watch.enabled') }} {{ selectedWatch.preCheck.hint ? `— ${selectedWatch.preCheck.hint}` : '' }}</p>
              </div>

              <div class="detail-section" v-if="selectedWatch.triggers.some(t => t.type === 'webhook')">
                <h4>Webhook URL</h4>
                <code class="webhook-url">POST /hooks/{{ selectedWatch.triggers.find(t => t.type === 'webhook')?.token }}</code>
              </div>

              <div class="detail-section" v-if="selectedWatch.lastRun">
                <h4>{{ t('watch.lastRun') }}</h4>
                <div class="detail-row">
                  <span class="label">状态:</span>
                  <span class="value" :class="getStatusClass(selectedWatch.lastRun.status)">{{ getStatusText(selectedWatch.lastRun.status) }}</span>
                </div>
                <div class="detail-row">
                  <span class="label">时间:</span>
                  <span class="value">{{ formatFullDate(selectedWatch.lastRun.at) }}</span>
                </div>
                <div class="detail-row">
                  <span class="label">耗时:</span>
                  <span class="value">{{ formatDuration(selectedWatch.lastRun.duration) }}</span>
                </div>
                <div class="detail-row" v-if="selectedWatch.lastRun.skipReason">
                  <span class="label">{{ t('watch.statusSkipped') }}:</span>
                  <span class="value">{{ selectedWatch.lastRun.skipReason }}</span>
                </div>
              </div>
            </div>
          </template>

          <!-- 空状态 -->
          <div v-else class="no-selection">
            <Eye :size="64" class="empty-icon" />
            <p>{{ t('watch.noWatches') }}</p>
            <p class="empty-hint">{{ t('watch.createFirst') }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.watch-manager {
  width: 1060px;
  max-width: 95vw;
  height: 720px;
  max-height: 90vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}

.manager-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.manager-header h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.btn-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}
.btn-close:hover { background: var(--bg-hover); }

.manager-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.list-panel {
  width: 380px;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.detail-panel {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.tab-bar {
  display: flex;
  padding: 8px 12px;
  gap: 4px;
  border-bottom: 1px solid var(--border-color);
}

.tab-bar button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px;
  font-size: 12px;
}
.tab-bar button.active { background: var(--bg-active); color: var(--text-primary); font-weight: 500; }
.tab-bar button:hover:not(.active) { background: var(--bg-hover); }

.list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-color);
}

.btn { padding: 5px 10px; border: 1px solid var(--border-color); background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; border-radius: 6px; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
.btn:hover { background: var(--bg-hover); }
.btn-primary { background: var(--accent-color); color: #fff; border-color: var(--accent-color); }
.btn-primary:hover { opacity: 0.9; }
.btn-danger { background: #dc3545; color: #fff; border-color: #dc3545; }
.btn-danger:hover { opacity: 0.9; }
.btn-sm { padding: 3px 8px; font-size: 11px; }
.btn-icon { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 4px; border-radius: 4px; }
.btn-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

.watch-list, .history-list, .sensor-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.watch-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 2px;
}
.watch-item:hover { background: var(--bg-hover); }
.watch-item.active { background: var(--bg-active); }
.watch-item.disabled { opacity: 0.5; }

.watch-info { flex: 1; min-width: 0; }
.watch-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.watch-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.watch-last-run { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

.trigger-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  background: var(--bg-tertiary, rgba(255,255,255,0.05));
  border-radius: 4px;
  font-size: 10px;
  color: var(--text-secondary);
}

.trigger-badge-sm {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  color: var(--text-muted);
}

.btn-toggle {
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--bg-tertiary, rgba(255,255,255,0.1));
  border: none;
  cursor: pointer;
  position: relative;
  transition: background 0.2s;
}
.btn-toggle.enabled { background: var(--accent-color); }
.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.2s;
}
.btn-toggle.enabled .toggle-dot { transform: translateX(14px); }

.history-item {
  display: flex;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 6px;
}
.history-item:hover { background: var(--bg-hover); }
.history-status { font-size: 14px; min-width: 20px; text-align: center; padding-top: 2px; }
.history-info { flex: 1; }
.history-name { font-size: 12px; font-weight: 500; }
.history-meta { display: flex; gap: 8px; font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.history-detail { font-size: 11px; color: var(--text-muted); margin-top: 2px; }

.status-success { color: #28a745; }
.status-error { color: #dc3545; }
.status-warning { color: #ffc107; }
.status-skipped { color: #6c757d; }
.status-muted { color: var(--text-muted); }
.status-running { color: var(--accent-color); }
.error-text { color: #dc3545; }

.sensor-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 6px;
}
.sensor-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6c757d;
}
.sensor-indicator.active { background: #28a745; }
.sensor-info { flex: 1; }
.sensor-name { font-size: 13px; font-weight: 500; }
.sensor-status-text { font-size: 11px; color: var(--text-muted); }

.recent-events { padding: 12px; }
.recent-events h4 { font-size: 12px; color: var(--text-secondary); margin: 12px 0 8px; }
.event-item { display: flex; gap: 8px; padding: 4px 0; font-size: 11px; color: var(--text-muted); align-items: center; }
.event-time { min-width: 60px; }
.event-type { display: flex; align-items: center; gap: 3px; }

.history-count { font-size: 12px; color: var(--text-muted); }

.empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; gap: 8px; }
.empty-icon { color: var(--text-muted); opacity: 0.3; }
.empty-state p { color: var(--text-muted); font-size: 13px; margin: 0; }
.empty-hint { font-size: 11px !important; }

.no-selection { display: flex; flex-direction: column; align-items: center; justify-content: center; flex: 1; gap: 8px; }
.no-selection p { color: var(--text-muted); font-size: 13px; margin: 0; }

/* 详情面板 */
.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}
.detail-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail-title h3 { margin: 0; font-size: 15px; }
.detail-actions { display: flex; gap: 6px; }

.watch-badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  background: rgba(108, 117, 125, 0.2);
  color: #6c757d;
}
.watch-badge.enabled { background: rgba(40, 167, 69, 0.15); color: #28a745; }

.priority-badge {
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
}
.priority-badge.high { background: rgba(220, 53, 69, 0.15); color: #dc3545; }
.priority-badge.normal { background: rgba(108, 117, 125, 0.15); color: var(--text-muted); }
.priority-badge.low { background: rgba(108, 117, 125, 0.1); color: var(--text-muted); }

.detail-content { padding: 16px 20px; overflow-y: auto; flex: 1; }
.detail-section { margin-bottom: 16px; }
.detail-section h4 { font-size: 12px; color: var(--text-secondary); margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.5px; }
.detail-row { display: flex; gap: 8px; margin-bottom: 4px; font-size: 13px; }
.detail-row .label { color: var(--text-muted); min-width: 80px; }
.detail-row .value { color: var(--text-primary); }

.prompt-content {
  background: var(--bg-primary, rgba(0,0,0,0.2));
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.trigger-list { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.skills-list { display: flex; gap: 4px; flex-wrap: wrap; }
.skill-badge { padding: 2px 8px; background: var(--bg-tertiary, rgba(255,255,255,0.05)); border-radius: 4px; font-size: 11px; }
.webhook-url { display: block; padding: 8px 12px; background: var(--bg-primary, rgba(0,0,0,0.2)); border-radius: 6px; font-size: 12px; word-break: break-all; }

/* 编辑器 */
.editor-content { padding: 16px 20px; overflow-y: auto; flex: 1; }
.form-section { margin-bottom: 14px; }
.form-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
.form-label-sm { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
.form-input { width: 100%; padding: 7px 10px; background: var(--bg-primary, rgba(0,0,0,0.2)); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--accent-color); }
.form-textarea { width: 100%; padding: 7px 10px; background: var(--bg-primary, rgba(0,0,0,0.2)); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; resize: vertical; box-sizing: border-box; font-family: inherit; }
.form-textarea:focus { outline: none; border-color: var(--accent-color); }
.form-select { padding: 7px 10px; background: var(--bg-primary, rgba(0,0,0,0.2)); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 12px; }

.trigger-options { display: flex; flex-wrap: wrap; gap: 6px; }
.trigger-option {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  font-size: 11px;
  transition: all 0.15s;
}
.trigger-option input { display: none; }
.trigger-option:hover { border-color: var(--accent-color); }
.trigger-option.selected { border-color: var(--accent-color); background: rgba(var(--accent-rgb, 59, 130, 246), 0.1); }

.trigger-config { margin-top: 8px; padding: 10px; background: var(--bg-primary, rgba(0,0,0,0.1)); border-radius: 6px; }

.presets { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.preset-btn { padding: 2px 8px; border: 1px solid var(--border-color); background: none; color: var(--text-secondary); cursor: pointer; border-radius: 4px; font-size: 10px; }
.preset-btn:hover { border-color: var(--accent-color); }
.preset-btn.active { border-color: var(--accent-color); background: rgba(var(--accent-rgb, 59, 130, 246), 0.1); }

.interval-input { display: flex; align-items: center; gap: 6px; }
.interval-value { width: 80px; }

.radio-group { display: flex; flex-wrap: wrap; gap: 8px; }
.radio-item { display: flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }

.editor-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 12px; border-top: 1px solid var(--border-color); margin-top: 16px; }

@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spinning { animation: spin 1s linear infinite; }

/* 模板 */
.category-filter { display: flex; gap: 4px; flex-wrap: wrap; }
.filter-btn { padding: 2px 8px; border: 1px solid var(--border-color); background: none; color: var(--text-secondary); cursor: pointer; border-radius: 4px; font-size: 10px; }
.filter-btn:hover { border-color: var(--accent-color); }
.filter-btn.active { border-color: var(--accent-color); background: rgba(var(--accent-rgb, 59, 130, 246), 0.1); color: var(--accent-color); }

.template-list { flex: 1; overflow-y: auto; padding: 4px; }
.template-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  margin-bottom: 2px;
}
.template-item:hover { background: var(--bg-hover); }
.template-icon { font-size: 24px; min-width: 36px; text-align: center; }
.template-info { flex: 1; min-width: 0; }
.template-name { font-size: 13px; font-weight: 500; }
.template-desc { font-size: 11px; color: var(--text-muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 共享状态 */
.shared-state-section { padding: 12px; border-top: 1px solid var(--border-color); margin-top: 8px; }
.shared-state-header { display: flex; align-items: center; justify-content: space-between; }
.shared-state-header h4 { font-size: 12px; color: var(--text-secondary); margin: 0; display: flex; align-items: center; gap: 4px; }
.shared-state-content { margin-top: 8px; }
.state-item { display: flex; gap: 8px; padding: 3px 0; font-size: 11px; }
.state-key { color: var(--accent-color); min-width: 80px; font-weight: 500; }
.state-value { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.unit-text { font-size: 12px; color: var(--text-muted); }
</style>
