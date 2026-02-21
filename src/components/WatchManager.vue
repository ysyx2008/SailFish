<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  X, Plus, Play, Trash2, Edit3, Eye, EyeOff, RefreshCw, History,
  Clock, Heart, Globe, Zap, Terminal, Server, MessageSquare,
  Bell, Send, FileText, FolderOpen, Calendar, Mail,
  LayoutTemplate, Database
} from 'lucide-vue-next'
import SchedulerTaskEditor from './SchedulerTaskEditor.vue'

const { t } = useI18n()

const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{ close: [] }>()

// ==================== Watch Types ====================

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
  id: string; name: string; nameEn: string; description: string; descriptionEn: string; category: string; icon: string
}

interface WatchDefinition {
  id: string; name: string; description?: string; enabled: boolean; triggers: WatchTrigger[]; prompt: string
  skills?: string[]
  execution: { type: 'assistant' | 'local' | 'ssh'; sshSessionId?: string; sshSessionName?: string; workingDirectory?: string; timeout?: number }
  output: { type: WatchOutputType }
  preCheck?: { enabled: boolean; hint?: string }
  state?: Record<string, unknown>; priority: WatchPriority
  createdAt: number; updatedAt: number; expiresAt?: number
  lastRun?: { at: number; status: WatchRunStatus; duration: number; triggerType: string; output?: string; error?: string; skipReason?: string }
  nextRun?: number
}

interface WatchHistoryRecord {
  id: string; watchId: string; watchName: string; at: number; status: WatchRunStatus; duration: number
  triggerType: string; output?: string; error?: string; skipReason?: string
}

// ==================== Scheduler Types ====================

type ScheduleType = 'cron' | 'interval' | 'once'
type TargetType = 'local' | 'ssh' | 'assistant'

interface ScheduleConfig { type: ScheduleType; expression: string }
interface TargetConfig { type: TargetType; sshSessionId?: string; sshSessionName?: string; workingDirectory?: string }
interface TaskOptions { timeout: number; requireConfirm: boolean; notifyOnComplete: boolean; notifyOnError: boolean }
type TaskRunStatusType = 'success' | 'failed' | 'timeout' | 'cancelled' | 'running'
interface TaskRunRecord { at: number; status: TaskRunStatusType; duration: number; output?: string; error?: string }

interface ScheduledTask {
  id: string; name: string; description?: string; enabled: boolean; schedule: ScheduleConfig
  prompt: string; target: TargetConfig; options: TaskOptions
  createdAt: number; updatedAt: number; lastRun?: TaskRunRecord; nextRun?: number
}

interface TaskHistoryRecord extends TaskRunRecord {
  id: string; taskId: string; taskName: string
}

interface CreateTaskParams {
  name: string; description?: string; schedule: ScheduleConfig; prompt: string
  target: TargetConfig; options?: Partial<TaskOptions>; enabled?: boolean
}

// ==================== Navigation ====================

type NavTab = 'watches' | 'scheduler' | 'templates' | 'sensors' | 'history'
const VALID_TABS: NavTab[] = ['watches', 'scheduler', 'templates', 'sensors', 'history']
const activeTab = ref<NavTab>(
  props.initialTab && VALID_TABS.includes(props.initialTab as NavTab) ? props.initialTab as NavTab : 'watches'
)

// ==================== Watch State ====================

const watches = ref<WatchDefinition[]>([])
const watchHistory = ref<WatchHistoryRecord[]>([])
const loading = ref(true)
const selectedWatch = ref<WatchDefinition | null>(null)
const runningWatches = ref<Set<string>>(new Set())
const showEditor = ref(false)
const editingWatch = ref<WatchDefinition | null>(null)

const formName = ref(''); const formDescription = ref(''); const formPrompt = ref('')
const formTriggerTypes = ref<Set<WatchTriggerType>>(new Set(['manual']))
const formCronExpression = ref('0 9 * * *')
const formIntervalValue = ref(30); const formIntervalUnit = ref<'m' | 'h'>('m')
const formExecutionType = ref<'local' | 'ssh' | 'assistant'>('local')
const formOutputType = ref<WatchOutputType>('log')
const formPreCheckEnabled = ref(false); const formPreCheckHint = ref('')
const formPriority = ref<WatchPriority>('normal'); const formEnabled = ref(true); const formSkills = ref('')
const formFilePaths = ref(''); const formFilePattern = ref('')
const formCalendarIcsPath = ref(''); const formCalendarBeforeMinutes = ref(15)
const formEmailFrom = ref(''); const formEmailSubject = ref('')

const templates = ref<WatchTemplateInfo[]>([]); const selectedTemplateCategory = ref<string>('all')
const sharedState = ref<Record<string, unknown>>({})
const sensorStatus = ref<Array<{ id: string; name: string; running: boolean }>>([])
const recentEvents = ref<Array<{ id: string; type: string; source: string; timestamp: number }>>([])

// ==================== Scheduler State ====================

const schedulerTasks = ref<ScheduledTask[]>([])
const schedulerHistory = ref<TaskHistoryRecord[]>([])
const schedulerLoading = ref(false)
const selectedTask = ref<ScheduledTask | null>(null)
const showTaskEditor = ref(false)
const editingTask = ref<ScheduledTask | null>(null)
const runningTasks = ref<Set<string>>(new Set())

// ==================== Watch Utilities ====================

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
  const map: Record<WatchOutputType, string> = { im: t('watch.outputIM'), notification: t('watch.outputNotification'), log: t('watch.outputLog'), silent: t('watch.outputSilent') }
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

// ==================== Scheduler Utilities ====================

const formatSchedule = (schedule: ScheduleConfig): string => {
  if (schedule.type === 'cron') return `Cron: ${schedule.expression}`
  if (schedule.type === 'interval') {
    const match = schedule.expression.match(/^(\d+)(s|m|h|d)$/)
    if (match) {
      const unitMap: Record<string, string> = { s: '秒', m: '分钟', h: '小时', d: '天' }
      return `${t('scheduler.every')} ${match[1]} ${unitMap[match[2]]}`
    }
    return schedule.expression
  }
  return `${t('scheduler.once')}: ${formatDate(new Date(schedule.expression).getTime())}`
}

const getTargetDescription = (target: TargetConfig): string => {
  if (target.type === 'local') return target.workingDirectory ? `${t('scheduler.localTerminal')}: ${target.workingDirectory}` : t('scheduler.localTerminal')
  if (target.type === 'ssh') return `SSH: ${target.sshSessionName || target.sshSessionId}`
  return t('scheduler.noTerminal')
}

const getTargetIcon = (target: TargetConfig) => target.type === 'local' ? Terminal : target.type === 'ssh' ? Server : MessageSquare

const getTaskStatusText = (status: string): string => {
  const map: Record<string, string> = { success: t('watch.statusCompleted'), failed: t('watch.statusFailed'), timeout: t('watch.statusTimeout'), cancelled: t('watch.statusCancelled'), running: t('watch.statusRunning') }
  return map[status] || status
}

// ==================== Watch Data ====================

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
    sensorStatus.value = await window.electronAPI.sensor.getStatus()
    recentEvents.value = await window.electronAPI.sensor.getRecentEvents(20)
  } catch (e) { console.error('Failed to load sensor data:', e) }
}

const filteredTemplates = computed(() => {
  if (selectedTemplateCategory.value === 'all') return templates.value
  return templates.value.filter(t => t.category === selectedTemplateCategory.value)
})

// ==================== Scheduler Data ====================

const loadSchedulerData = async () => {
  schedulerLoading.value = true
  try {
    schedulerTasks.value = await window.electronAPI.scheduler.getTasks()
    schedulerHistory.value = await window.electronAPI.scheduler.getHistory(undefined, 50)
    const running = await window.electronAPI.scheduler.getRunningTasks()
    runningTasks.value = new Set(running)
  } catch (e) {
    console.error('Failed to load scheduler data:', e)
  } finally {
    schedulerLoading.value = false
  }
}

// ==================== Watch Operations ====================

const selectWatch = (w: WatchDefinition) => { selectedWatch.value = w; showEditor.value = false }

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
      if (selectedWatch.value) openEdit(selectedWatch.value)
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

// ==================== Watch Editor ====================

const openCreate = () => {
  editingWatch.value = null
  formName.value = ''; formDescription.value = ''; formPrompt.value = ''
  formTriggerTypes.value = new Set(['manual'])
  formCronExpression.value = '0 9 * * *'
  formIntervalValue.value = 30; formIntervalUnit.value = 'm'
  formExecutionType.value = 'local'; formOutputType.value = 'log'
  formPreCheckEnabled.value = false; formPreCheckHint.value = ''
  formPriority.value = 'normal'; formEnabled.value = true; formSkills.value = ''
  formFilePaths.value = ''; formFilePattern.value = ''
  formCalendarIcsPath.value = ''; formCalendarBeforeMinutes.value = 15
  formEmailFrom.value = ''; formEmailSubject.value = ''
  selectedWatch.value = null; showEditor.value = true
}

const openEdit = (w: WatchDefinition) => {
  editingWatch.value = w
  formName.value = w.name; formDescription.value = w.description || ''; formPrompt.value = w.prompt
  formTriggerTypes.value = new Set(w.triggers.map(t => t.type))
  const cronTrigger = w.triggers.find(t => t.type === 'cron')
  if (cronTrigger?.expression) formCronExpression.value = cronTrigger.expression
  const intervalTrigger = w.triggers.find(t => t.type === 'interval')
  if (intervalTrigger?.seconds) {
    if (intervalTrigger.seconds >= 3600) { formIntervalValue.value = intervalTrigger.seconds / 3600; formIntervalUnit.value = 'h' }
    else { formIntervalValue.value = intervalTrigger.seconds / 60; formIntervalUnit.value = 'm' }
  }
  formExecutionType.value = w.execution.type; formOutputType.value = w.output.type
  formPreCheckEnabled.value = w.preCheck?.enabled ?? false; formPreCheckHint.value = w.preCheck?.hint ?? ''
  formPriority.value = w.priority; formEnabled.value = w.enabled
  formSkills.value = w.skills?.join(', ') || ''
  const fc = w.triggers.find(t => t.type === 'file_change')
  formFilePaths.value = fc?.paths?.join(', ') || ''; formFilePattern.value = fc?.pattern || ''
  const cal = w.triggers.find(t => t.type === 'calendar')
  formCalendarIcsPath.value = cal?.icsPath || ''; formCalendarBeforeMinutes.value = cal?.beforeMinutes || 15
  const em = w.triggers.find(t => t.type === 'email')
  formEmailFrom.value = em?.filter?.from || ''; formEmailSubject.value = em?.filter?.subject || ''
  showEditor.value = true
}

const toggleTrigger = (type: WatchTriggerType) => {
  if (formTriggerTypes.value.has(type)) formTriggerTypes.value.delete(type)
  else formTriggerTypes.value.add(type)
}

const saveWatch = async () => {
  if (!formName.value.trim() || !formPrompt.value.trim()) { alert(t('watch.validation.nameRequired')); return }
  if (formTriggerTypes.value.size === 0) { alert(t('watch.validation.triggerRequired')); return }

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
  if (formTriggerTypes.value.has('calendar')) triggers.push({ type: 'calendar', beforeMinutes: formCalendarBeforeMinutes.value, icsPath: formCalendarIcsPath.value.trim() || undefined } as any)
  if (formTriggerTypes.value.has('email')) {
    const filter: any = { unseen: true }
    if (formEmailFrom.value.trim()) filter.from = formEmailFrom.value.trim()
    if (formEmailSubject.value.trim()) filter.subject = formEmailSubject.value.trim()
    triggers.push({ type: 'email', filter } as any)
  }

  const skills = formSkills.value.trim() ? formSkills.value.split(',').map(s => s.trim()).filter(Boolean) : undefined
  const params = {
    name: formName.value.trim(), description: formDescription.value.trim() || undefined,
    prompt: formPrompt.value.trim(), triggers, skills,
    execution: { type: formExecutionType.value, timeout: 300 },
    output: { type: formOutputType.value },
    preCheck: formPreCheckEnabled.value ? { enabled: true, hint: formPreCheckHint.value.trim() || undefined } : undefined,
    priority: formPriority.value, enabled: formEnabled.value
  }

  if (editingWatch.value) await window.electronAPI.watch.update(editingWatch.value.id, params)
  else await window.electronAPI.watch.create(params)
  showEditor.value = false; await loadWatchData()
}

// ==================== Scheduler Operations ====================

const selectTask = (task: ScheduledTask) => { selectedTask.value = task }
const openCreateTask = () => { editingTask.value = null; showTaskEditor.value = true }
const openEditTask = (task: ScheduledTask) => { editingTask.value = task; showTaskEditor.value = true }

const handleSaveTask = async (params: CreateTaskParams) => {
  try {
    if (editingTask.value) await window.electronAPI.scheduler.updateTask(editingTask.value.id, params)
    else await window.electronAPI.scheduler.createTask(params)
    showTaskEditor.value = false; editingTask.value = null; await loadSchedulerData()
  } catch (e) { console.error('Failed to save task:', e) }
}

const deleteTask = async (task: ScheduledTask) => {
  if (!confirm(t('watch.confirmDelete', { name: task.name }))) return
  try {
    await window.electronAPI.scheduler.deleteTask(task.id)
    if (selectedTask.value?.id === task.id) selectedTask.value = null
    await loadSchedulerData()
  } catch (e) { console.error('Failed to delete task:', e) }
}

const toggleTask = async (task: ScheduledTask) => {
  try { await window.electronAPI.scheduler.toggleTask(task.id); await loadSchedulerData() } catch (e) { console.error('Failed to toggle task:', e) }
}

const runTask = async (task: ScheduledTask) => {
  if (runningTasks.value.has(task.id)) return
  try {
    runningTasks.value.add(task.id)
    await window.electronAPI.scheduler.runTask(task.id)
  } catch (e) {
    console.error('Failed to run task:', e)
    runningTasks.value.delete(task.id)
  }
}

const clearSchedulerHistory = async () => {
  if (!confirm(t('watch.confirmClearHistory'))) return
  try { await window.electronAPI.scheduler.clearHistory(); schedulerHistory.value = [] } catch (e) { console.error('Failed to clear history:', e) }
}

// ==================== Presets ====================

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

// ==================== Lifecycle ====================

let refreshTimer: NodeJS.Timeout | null = null
let cleanupWatchStarted: (() => void) | null = null
let cleanupWatchCompleted: (() => void) | null = null
let cleanupTaskStarted: (() => void) | null = null
let cleanupTaskCompleted: (() => void) | null = null

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (showTaskEditor.value) { showTaskEditor.value = false; return }
    if (showEditor.value) { showEditor.value = false; return }
    emit('close')
  }
}

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown, true)
  await Promise.all([loadWatchData(), loadSchedulerData()])
  loadTemplates(); loadSharedState()
  refreshTimer = setInterval(() => { loadWatchData(); loadSchedulerData() }, 30000)

  cleanupWatchStarted = window.electronAPI.watch.onTaskStarted?.((data: any) => { if (data?.watchId) markWatchRunning(data.watchId) })
  cleanupWatchCompleted = window.electronAPI.watch.onTaskCompleted?.((data: any) => { if (data?.watchId) markWatchCompleted(data.watchId) })
  cleanupTaskStarted = window.electronAPI.scheduler.onTaskStarted(({ taskId }) => { runningTasks.value.add(taskId) })
  cleanupTaskCompleted = window.electronAPI.scheduler.onTaskCompleted(({ taskId }) => { runningTasks.value.delete(taskId); loadSchedulerData() })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
  if (refreshTimer) clearInterval(refreshTimer)
  cleanupWatchStarted?.(); cleanupWatchCompleted?.()
  cleanupTaskStarted?.(); cleanupTaskCompleted?.()
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
          <Eye :size="16" style="margin-right: 6px;" />
          {{ t('watch.panelTitle') }}
        </h2>
        <button class="btn-icon" @click="emit('close')" :title="t('watch.close')">
          <X :size="18" />
        </button>
      </div>

      <div class="panel-body">
        <!-- Left Nav -->
        <nav class="panel-nav">
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navAutomation') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'watches' }" @click="activeTab = 'watches'">
              <Eye :size="16" />
              <span>{{ t('watch.watches') }}</span>
              <span v-if="watches.length" class="nav-badge">{{ watches.length }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'scheduler' }" @click="activeTab = 'scheduler'; loadSchedulerData()">
              <Clock :size="16" />
              <span>{{ t('watch.schedulerTab') }}</span>
              <span v-if="schedulerTasks.length" class="nav-badge">{{ schedulerTasks.length }}</span>
            </button>
          </div>
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navTools') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'templates' }" @click="activeTab = 'templates'; loadTemplates()">
              <LayoutTemplate :size="16" />
              <span>{{ t('watch.templates') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'sensors' }" @click="activeTab = 'sensors'; loadSensorData(); loadSharedState()">
              <Heart :size="16" />
              <span>{{ t('watch.sensors') }}</span>
            </button>
          </div>
          <div class="nav-group">
            <div class="nav-group-label">{{ t('watch.navRecords') }}</div>
            <button class="nav-item" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'; loadWatchData(); loadSchedulerData()">
              <History :size="16" />
              <span>{{ t('watch.executionHistory') }}</span>
            </button>
          </div>
        </nav>

        <!-- Content Area -->
        <div class="panel-content">

          <!-- ===================== 关切 ===================== -->
          <template v-if="activeTab === 'watches'">
            <div class="content-page master-detail-page">
              <!-- Watch List -->
              <div class="master-list">
                <div class="list-toolbar">
                  <button class="btn btn-primary btn-sm" @click="openCreate">
                    <Plus :size="14" /> {{ t('watch.newWatch') }}
                  </button>
                  <button class="btn btn-sm" @click="loadWatchData" :disabled="loading">
                    <RefreshCw :size="14" :class="{ spinning: loading }" />
                  </button>
                </div>

                <div class="item-list">
                  <div v-for="w in watches" :key="w.id" class="list-item" :class="{ active: selectedWatch?.id === w.id && !showEditor, disabled: !w.enabled }" @click="selectWatch(w)">
                    <button class="btn-toggle" :class="{ enabled: w.enabled }" @click.stop="toggleWatch(w)">
                      <span class="toggle-dot"></span>
                    </button>
                    <div class="item-info">
                      <div class="item-name">{{ w.name }}</div>
                      <div class="item-meta">
                        <span v-for="trigger in w.triggers" :key="trigger.type" class="trigger-badge">
                          <component :is="getTriggerIcon(trigger.type)" :size="10" />
                          {{ getTriggerLabel(trigger) }}
                        </span>
                      </div>
                      <div class="item-sub" v-if="w.lastRun">
                        <span :class="getStatusClass(w.lastRun.status)">{{ getStatusIcon(w.lastRun.status) }}</span>
                        {{ formatDate(w.lastRun.at) }}
                      </div>
                    </div>
                    <button class="btn-icon-sm" @click.stop="triggerWatch(w)" :disabled="runningWatches.has(w.id)" :title="t('watch.trigger')">
                      <Play :size="14" :class="{ spinning: runningWatches.has(w.id) }" />
                    </button>
                  </div>

                  <div v-if="watches.length === 0 && !loading" class="empty-state">
                    <Eye :size="40" class="empty-icon" />
                    <p>{{ t('watch.noWatches') }}</p>
                    <button class="btn btn-primary btn-sm" @click="openCreate">{{ t('watch.newWatch') }}</button>
                  </div>
                </div>
              </div>

              <!-- Watch Detail / Editor -->
              <div class="detail-area">
                <!-- Editor -->
                <template v-if="showEditor">
                  <div class="detail-header">
                    <h3>{{ editingWatch ? t('watch.editWatch') : t('watch.createWatch') }}</h3>
                    <button class="btn btn-sm" @click="showEditor = false"><X :size="14" /></button>
                  </div>
                  <div class="detail-body">
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
                        <label v-for="tt in (['cron','interval','heartbeat','webhook','manual','file_change','calendar','email'] as WatchTriggerType[])" :key="tt" class="trigger-option" :class="{ selected: formTriggerTypes.has(tt) }">
                          <input type="checkbox" :checked="formTriggerTypes.has(tt)" @change="toggleTrigger(tt)" />
                          <component :is="getTriggerIcon(tt)" :size="14" />
                          <span>{{ tt === 'cron' ? t('watch.triggerCron') : tt === 'interval' ? t('watch.triggerInterval') : tt === 'heartbeat' ? t('watch.triggerHeartbeat') : tt === 'webhook' ? 'Webhook' : tt === 'manual' ? t('watch.triggerManual') : tt === 'file_change' ? t('watch.triggerFileChange') : tt === 'calendar' ? t('watch.triggerCalendar') : t('watch.triggerEmail') }}</span>
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
                          <input type="number" v-model.number="formIntervalValue" class="form-input" style="width:80px" min="1" />
                          <select v-model="formIntervalUnit" class="form-select"><option value="m">min</option><option value="h">hr</option></select>
                        </div>
                      </div>
                      <div v-if="formTriggerTypes.has('file_change')" class="trigger-config">
                        <label class="form-label-sm">{{ t('watch.filePathsLabel') }}</label>
                        <input type="text" v-model="formFilePaths" class="form-input" :placeholder="t('watch.filePathsPlaceholder')" />
                        <label class="form-label-sm" style="margin-top:6px">{{ t('watch.filePatternLabel') }}</label>
                        <input type="text" v-model="formFilePattern" class="form-input" placeholder="*.log, *.txt" />
                      </div>
                      <div v-if="formTriggerTypes.has('calendar')" class="trigger-config">
                        <label class="form-label-sm">{{ t('watch.calendarBeforeLabel') }}</label>
                        <div class="interval-input">
                          <input type="number" v-model.number="formCalendarBeforeMinutes" class="form-input" style="width:80px" min="1" max="1440" />
                          <span class="unit-text">min</span>
                        </div>
                        <label class="form-label-sm" style="margin-top:6px">{{ t('watch.calendarIcsLabel') }}</label>
                        <input type="text" v-model="formCalendarIcsPath" class="form-input" :placeholder="t('watch.calendarIcsPlaceholder')" />
                      </div>
                      <div v-if="formTriggerTypes.has('email')" class="trigger-config">
                        <label class="form-label-sm">{{ t('watch.emailFromLabel') }}</label>
                        <input type="text" v-model="formEmailFrom" class="form-input" :placeholder="t('watch.emailFromPlaceholder')" />
                        <label class="form-label-sm" style="margin-top:6px">{{ t('watch.emailSubjectLabel') }}</label>
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
                      <label class="form-label"><input type="checkbox" v-model="formEnabled" /> {{ t('watch.enabled') }}</label>
                    </div>
                    <div class="editor-actions">
                      <button class="btn" @click="showEditor = false">{{ t('watch.cancel') }}</button>
                      <button class="btn btn-primary" @click="saveWatch">{{ editingWatch ? t('watch.save') : t('watch.create') }}</button>
                    </div>
                  </div>
                </template>

                <!-- Detail View -->
                <template v-else-if="selectedWatch">
                  <div class="detail-header">
                    <div class="detail-title">
                      <h3>{{ selectedWatch.name }}</h3>
                      <span class="watch-badge" :class="{ enabled: selectedWatch.enabled }">{{ selectedWatch.enabled ? t('watch.enabled') : t('watch.disabled') }}</span>
                      <span class="priority-badge" :class="selectedWatch.priority">{{ selectedWatch.priority }}</span>
                    </div>
                    <div class="detail-actions">
                      <button class="btn btn-sm" @click="openEdit(selectedWatch)"><Edit3 :size="14" /> {{ t('watch.edit') }}</button>
                      <button class="btn btn-primary btn-sm" @click="triggerWatch(selectedWatch)" :disabled="runningWatches.has(selectedWatch.id)"><Play :size="14" /> {{ t('watch.trigger') }}</button>
                      <button class="btn btn-danger btn-sm" @click="deleteWatch(selectedWatch)"><Trash2 :size="14" /></button>
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
                        <span v-for="tr in selectedWatch.triggers" :key="tr.type" class="trigger-badge">
                          <component :is="getTriggerIcon(tr.type)" :size="12" /> {{ getTriggerLabel(tr) }}
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
                      <div class="skills-list"><span v-for="s in selectedWatch.skills" :key="s" class="skill-badge">{{ s }}</span></div>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('watch.outputType') }}</h4>
                      <p>{{ getOutputLabel(selectedWatch.output.type) }}</p>
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
                        <span class="label">{{ t('scheduler.status') }}:</span>
                        <span class="value" :class="getStatusClass(selectedWatch.lastRun.status)">{{ getWatchStatusText(selectedWatch.lastRun.status) }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="label">{{ t('scheduler.time') }}:</span>
                        <span class="value">{{ formatFullDate(selectedWatch.lastRun.at) }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="label">{{ t('watch.duration') }}:</span>
                        <span class="value">{{ formatDuration(selectedWatch.lastRun.duration) }}</span>
                      </div>
                      <div class="detail-row" v-if="selectedWatch.lastRun.error">
                        <span class="label">{{ t('scheduler.error') }}:</span>
                        <span class="value error-text">{{ selectedWatch.lastRun.error }}</span>
                      </div>
                      <div class="detail-row" v-if="selectedWatch.lastRun.skipReason">
                        <span class="label">{{ t('watch.statusSkipped') }}:</span>
                        <span class="value">{{ selectedWatch.lastRun.skipReason }}</span>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- Empty State -->
                <div v-else class="empty-detail">
                  <Eye :size="48" class="empty-icon" />
                  <p>{{ t('watch.createFirst') }}</p>
                </div>
              </div>
            </div>
          </template>

          <!-- ===================== 定时任务 ===================== -->
          <template v-if="activeTab === 'scheduler'">
            <div class="content-page master-detail-page">
              <div class="master-list">
                <div class="list-toolbar">
                  <button class="btn btn-primary btn-sm" @click="openCreateTask">
                    <Plus :size="14" /> {{ t('scheduler.newTask') }}
                  </button>
                  <button class="btn btn-sm" @click="loadSchedulerData" :disabled="schedulerLoading">
                    <RefreshCw :size="14" :class="{ spinning: schedulerLoading }" />
                  </button>
                </div>
                <div class="item-list">
                  <div v-for="task in schedulerTasks" :key="task.id" class="list-item" :class="{ active: selectedTask?.id === task.id, disabled: !task.enabled }" @click="selectTask(task)">
                    <button class="btn-toggle" :class="{ enabled: task.enabled }" @click.stop="toggleTask(task)">
                      <span class="toggle-dot"></span>
                    </button>
                    <div class="item-info">
                      <div class="item-name">{{ task.name }}</div>
                      <div class="item-meta">
                        <span class="trigger-badge">{{ formatSchedule(task.schedule) }}</span>
                        <span class="trigger-badge">
                          <component :is="getTargetIcon(task.target)" :size="10" />
                          {{ task.target.type === 'ssh' ? task.target.sshSessionName : task.target.type }}
                        </span>
                      </div>
                      <div class="item-sub" v-if="task.nextRun && task.enabled">
                        {{ t('scheduler.nextRun') }}: {{ formatDate(task.nextRun) }}
                      </div>
                    </div>
                    <button class="btn-icon-sm" @click.stop="runTask(task)" :disabled="runningTasks.has(task.id)" :title="t('scheduler.runNow')">
                      <Play :size="14" :class="{ spinning: runningTasks.has(task.id) }" />
                    </button>
                  </div>

                  <div v-if="schedulerTasks.length === 0 && !schedulerLoading" class="empty-state">
                    <Clock :size="40" class="empty-icon" />
                    <p>{{ t('scheduler.noTasks') }}</p>
                    <button class="btn btn-primary btn-sm" @click="openCreateTask">{{ t('scheduler.newTask') }}</button>
                  </div>
                </div>
              </div>

              <div class="detail-area">
                <template v-if="selectedTask">
                  <div class="detail-header">
                    <div class="detail-title">
                      <h3>{{ selectedTask.name }}</h3>
                      <span class="watch-badge" :class="{ enabled: selectedTask.enabled }">{{ selectedTask.enabled ? t('scheduler.enabled') : t('scheduler.disabled') }}</span>
                    </div>
                    <div class="detail-actions">
                      <button class="btn btn-sm" @click="openEditTask(selectedTask)"><Edit3 :size="14" /> {{ t('scheduler.edit') }}</button>
                      <button class="btn btn-primary btn-sm" @click="runTask(selectedTask)" :disabled="runningTasks.has(selectedTask.id)"><Play :size="14" /> {{ t('scheduler.runNow') }}</button>
                      <button class="btn btn-danger btn-sm" @click="deleteTask(selectedTask)"><Trash2 :size="14" /></button>
                    </div>
                  </div>
                  <div class="detail-body">
                    <div class="detail-section">
                      <h4>{{ t('scheduler.scheduleConfig') }}</h4>
                      <div class="detail-row"><span class="label">{{ t('scheduler.scheduleType') }}:</span><span class="value">{{ formatSchedule(selectedTask.schedule) }}</span></div>
                      <div class="detail-row" v-if="selectedTask.nextRun && selectedTask.enabled"><span class="label">{{ t('scheduler.nextRun') }}:</span><span class="value">{{ formatFullDate(selectedTask.nextRun) }}</span></div>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('scheduler.targetConfig') }}</h4>
                      <div class="detail-row"><span class="label">{{ t('scheduler.targetType') }}:</span><span class="value">{{ getTargetDescription(selectedTask.target) }}</span></div>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('scheduler.taskPrompt') }}</h4>
                      <div class="prompt-content">{{ selectedTask.prompt }}</div>
                    </div>
                    <div class="detail-section">
                      <h4>{{ t('scheduler.options') }}</h4>
                      <div class="detail-row"><span class="label">{{ t('scheduler.timeout') }}:</span><span class="value">{{ selectedTask.options.timeout }}s</span></div>
                      <div class="detail-row"><span class="label">{{ t('scheduler.notifyComplete') }}:</span><span class="value">{{ selectedTask.options.notifyOnComplete ? '✓' : '—' }}</span></div>
                      <div class="detail-row"><span class="label">{{ t('scheduler.notifyError') }}:</span><span class="value">{{ selectedTask.options.notifyOnError ? '✓' : '—' }}</span></div>
                    </div>
                    <div class="detail-section" v-if="selectedTask.lastRun">
                      <h4>{{ t('scheduler.lastRun') }}</h4>
                      <div class="detail-row"><span class="label">{{ t('scheduler.status') }}:</span><span class="value" :class="getStatusClass(selectedTask.lastRun.status)">{{ getTaskStatusText(selectedTask.lastRun.status) }}</span></div>
                      <div class="detail-row"><span class="label">{{ t('scheduler.time') }}:</span><span class="value">{{ formatFullDate(selectedTask.lastRun.at) }}</span></div>
                      <div class="detail-row"><span class="label">{{ t('scheduler.duration') }}:</span><span class="value">{{ formatDuration(selectedTask.lastRun.duration) }}</span></div>
                      <div class="detail-row" v-if="selectedTask.lastRun.error"><span class="label">{{ t('scheduler.error') }}:</span><span class="value error-text">{{ selectedTask.lastRun.error }}</span></div>
                    </div>
                  </div>
                </template>
                <div v-else class="empty-detail">
                  <Clock :size="48" class="empty-icon" />
                  <p>{{ t('scheduler.selectTask') }}</p>
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

              <!-- Watch History -->
              <div v-if="watchHistory.length > 0" class="content-section">
                <h4><Eye :size="14" /> {{ t('watch.watches') }}</h4>
                <div class="history-table">
                  <div v-for="h in watchHistory" :key="h.id" class="history-row">
                    <span class="history-status-icon" :class="getStatusClass(h.status)">{{ getStatusIcon(h.status) }}</span>
                    <span class="history-name">{{ h.watchName }}</span>
                    <span class="history-trigger"><component :is="getTriggerIcon(h.triggerType as WatchTriggerType)" :size="10" /> {{ h.triggerType }}</span>
                    <span class="history-time">{{ formatFullDate(h.at) }}</span>
                    <span class="history-duration">{{ formatDuration(h.duration) }}</span>
                  </div>
                </div>
              </div>

              <!-- Scheduler History -->
              <div v-if="schedulerHistory.length > 0" class="content-section">
                <div class="section-header-row">
                  <h4><Clock :size="14" /> {{ t('watch.schedulerTab') }}</h4>
                  <button class="btn btn-sm btn-danger" @click="clearSchedulerHistory" :disabled="schedulerHistory.length === 0"><Trash2 :size="12" /></button>
                </div>
                <div class="history-table">
                  <div v-for="h in schedulerHistory" :key="h.id" class="history-row">
                    <span class="history-status-icon" :class="getStatusClass(h.status)">{{ getTaskStatusText(h.status) }}</span>
                    <span class="history-name">{{ h.taskName }}</span>
                    <span class="history-time">{{ formatFullDate(h.at) }}</span>
                    <span class="history-duration">{{ formatDuration(h.duration) }}</span>
                  </div>
                </div>
              </div>

              <div v-if="watchHistory.length === 0 && schedulerHistory.length === 0" class="empty-state" style="padding: 60px 20px;">
                <History :size="40" class="empty-icon" />
                <p>{{ t('watch.noHistory') }}</p>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Scheduler Task Editor Overlay -->
    <SchedulerTaskEditor v-if="showTaskEditor" :task="editingTask" @save="handleSaveTask" @cancel="showTaskEditor = false" />
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
  justify-content: space-between;
  height: var(--header-height);
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.panel-header h2 {
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  margin: 0;
  padding-left: 4px;
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

.item-info { flex: 1; min-width: 0; }
.item-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

.empty-detail {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
}
.empty-detail p { color: var(--text-muted); font-size: 13px; margin: 0; }

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

/* ==================== Editor Form ==================== */

.form-section { margin-bottom: 16px; }
.form-label { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: 6px; }
.form-label-sm { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; }
.form-input { width: 100%; padding: 8px 10px; background: var(--bg-primary, rgba(0,0,0,0.2)); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 13px; box-sizing: border-box; }
.form-input:focus { outline: none; border-color: var(--accent-primary); }
.form-textarea { width: 100%; padding: 8px 10px; background: var(--bg-primary, rgba(0,0,0,0.2)); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 13px; resize: vertical; box-sizing: border-box; font-family: inherit; line-height: 1.5; }
.form-textarea:focus { outline: none; border-color: var(--accent-primary); }
.form-select { padding: 8px 10px; background: var(--bg-primary, rgba(0,0,0,0.2)); border: 1px solid var(--border-color); border-radius: 6px; color: var(--text-primary); font-size: 13px; }

.trigger-options { display: flex; flex-wrap: wrap; gap: 6px; }
.trigger-option {
  display: flex; align-items: center; gap: 5px;
  padding: 5px 10px; border: 1px solid var(--border-color);
  border-radius: 6px; cursor: pointer; font-size: 11px; transition: all 0.15s;
}
.trigger-option input { display: none; }
.trigger-option:hover { border-color: var(--accent-primary); }
.trigger-option.selected { border-color: var(--accent-primary); background: rgba(var(--accent-rgb, 59, 130, 246), 0.1); }

.trigger-config { margin-top: 8px; padding: 10px; background: var(--bg-primary, rgba(0,0,0,0.1)); border-radius: 6px; }

.presets { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.preset-btn { padding: 3px 8px; border: 1px solid var(--border-color); background: none; color: var(--text-secondary); cursor: pointer; border-radius: 4px; font-size: 10px; }
.preset-btn:hover { border-color: var(--accent-primary); }
.preset-btn.active { border-color: var(--accent-primary); background: rgba(var(--accent-rgb, 59, 130, 246), 0.1); }

.interval-input { display: flex; align-items: center; gap: 6px; }
.unit-text { font-size: 12px; color: var(--text-muted); }
.radio-group { display: flex; flex-wrap: wrap; gap: 10px; }
.radio-item { display: flex; align-items: center; gap: 5px; font-size: 12px; cursor: pointer; }

.editor-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border-color); margin-top: 20px; }

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
  display: flex; align-items: center; gap: 12px;
  padding: 14px 16px; border-radius: 8px; border: 1px solid var(--border-color);
  min-width: 240px; flex: 1; max-width: 360px;
}
.sensor-indicator { width: 10px; height: 10px; border-radius: 50%; background: #6c757d; flex-shrink: 0; }
.sensor-indicator.active { background: #28a745; box-shadow: 0 0 6px rgba(40, 167, 69, 0.4); }
.sensor-info { flex: 1; }
.sensor-name { font-size: 13px; font-weight: 500; }
.sensor-status-text { font-size: 11px; color: var(--text-muted); }

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

.history-table { display: flex; flex-direction: column; gap: 2px; padding: 0 24px; }

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
