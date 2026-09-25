<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, onErrorCaptured, watch, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import {
  X, Play, Trash2, Eye, RefreshCw, History,
  Clock, Heart, Globe, Zap, FolderOpen, Calendar, Mail,
  LayoutTemplate, Plus, Pencil,
  LayoutGrid
} from 'lucide-vue-next'
import { shouldShowToolResultStep } from '../../utils/tool-display'
import { parseThinking } from '../../utils/thinking-block'
import { useMarkdown } from '../../composables'
import ThinkingBlock from '../ThinkingBlock.vue'
import ToolCallContent from '../ToolCallContent.vue'
import cronstrue from 'cronstrue/i18n'
import WatchOverviewPanel from './WatchOverviewPanel.vue'
import WatchHistoryDetailView from './WatchHistoryDetailView.vue'
import { showConfirm, showAlert } from '../../composables/useConfirm'
import AppSelect from '../common/AppSelect.vue'

const { t } = useI18n()
const configStore = useConfigStore()
const { renderMarkdown, handleCodeBlockClick, handleFilePathContextMenu } = useMarkdown()

const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{ close: [] }>()

// ==================== Types ====================

import type {
  WatchTriggerType, WatchRunStatus, WatchTrigger,
  WatchDefinition, WatchHistoryRecord, WatchPriority
} from '@shared/types'
import { isWatchAgentKey, watchIdFromAgentKey } from '@shared/types'

type WatchOutputType = 'desktop' | 'im' | 'notification' | 'log' | 'silent'

interface WatchTemplateInfo {
  id: string; name: string; nameEn: string; description: string; descriptionEn: string; category: string; icon: string
}

// ==================== Navigation ====================

type NavTab = 'overview' | 'watches' | 'templates' | 'watchHistory'

const VALID_TABS: NavTab[] = ['overview', 'watches', 'templates', 'watchHistory']
const LAST_TAB_STORAGE_KEY = 'sfterm-watch-panel-last-tab'
const DEFAULT_TAB: NavTab = 'overview'

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

function switchTab(tab: NavTab, onSwitch?: () => void) {
  if (historyDetailInOverlay.value) closeHistoryDetail()
  if (tab !== 'watchHistory') historyWatchIdFilter.value = null
  activeTab.value = tab
  if (tab === 'watchHistory') historyFilter.value = 'watch'
  try { localStorage.setItem(LAST_TAB_STORAGE_KEY, tab) } catch { /* ignore quota */ }
  onSwitch?.()
}

// ==================== State ====================

const watches = ref<WatchDefinition[]>([])
const watchHistory = ref<WatchHistoryRecord[]>([])
const historyPageSize = 50
const historyHasMore = ref(false)
const historyLoadingMore = ref(false)

const historyFilter = ref<'watch'>('watch')
/** 运行历史页按关切过滤（总览「查看更多」带入）；null = 全部用户关切 */
const historyWatchIdFilter = ref<string | null>(null)
const loading = ref(true)
const selectedWatch = ref<WatchDefinition | null>(null)
/** 总览 / 关切页内查看流水详情（叠层），不切到 watchHistory tab */
const historyDetailInOverlay = ref(false)
const runningWatches = ref<Set<string>>(new Set())

// 手动触发时的 Agent 实时输出（内心独白）——单一来源：@shared/types
const liveExecutionWatchId = ref<string | null>(null)
// 字段需要包含 success / images / webSearchResults / subAgents，
// 以便 shouldShowToolResultStep 能正确判定"失败 / 富内容"步骤始终展示
type LiveStep = {
  id: string
  type: string
  content: string
  toolName?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  timestamp: number
  success?: boolean
  images?: string[]
  webSearchResults?: unknown[]
  subAgents?: unknown[]
}
const liveSteps = ref<LiveStep[]>([])

// 执行历史详情查看
const selectedHistoryRecord = ref<WatchHistoryRecord | null>(null)
const historyDetailSteps = ref<Array<{ id: string; type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; riskLevel?: string; timestamp: number; success?: boolean; images?: string[]; webSearchResults?: unknown[]; subAgents?: unknown[] }>>([])
const historyDetailLoading = ref(false)
const historyDetailUserTask = ref('')
const historyDetailFinalResult = ref('')

const HIDDEN_STEP_TYPES = new Set(['user_task', 'streaming', 'waiting', 'waiting_password', 'confirm'])

/** 与 AiPanel 一致：成功 final_result 不单独成卡（正文已在 message）；失败/中断才保留 */
function isFailureFinalResult(content: string): boolean {
  return content.startsWith('❌') || content.startsWith('⚠️')
}

function filterHistorySteps<T extends { type: string; content: string }>(
  raw: T[],
  debugMode: boolean
): T[] {
  const steps = raw
    .filter(s => !HIDDEN_STEP_TYPES.has(s.type))
    .filter(s => shouldShowToolResultStep(s, debugMode))
  const finalResult = steps.find(s => s.type === 'final_result')
  if (!finalResult) return steps
  if (isFailureFinalResult(finalResult.content)) return steps

  const finalText = finalResult.content.trim()
  const hasDuplicateMessage = steps.some(s => {
    if (s.type !== 'message') return false
    return parseThinking(s.content).body.trim() === finalText
  })
  if (hasDuplicateMessage) {
    return steps.filter(s => s.type !== 'final_result')
  }
  // 无 message 正文时保留 final_result，避免总结消失
  return steps
}

const visibleLiveSteps = computed(() =>
  filterHistorySteps(liveSteps.value, configStore.agentDebugMode)
)

/** 与 AiPanel 一致：从 message.content 抽出思考块 + 正文 */
const getMessageStepPresentation = (step: { content: string }) => {
  const parsed = parseThinking(step.content)
  return {
    thinking: parsed.thinking
      ? { reasoning: parsed.thinking.reasoning, isStreaming: !parsed.thinking.isDone }
      : null,
    body: parsed.body,
  }
}

const expandedThinkingSteps = ref<Set<string>>(new Set())
const isThinkingExpanded = (stepId: string): boolean => expandedThinkingSteps.value.has(stepId)
const toggleThinkingExpand = (stepId: string) => {
  const next = new Set(expandedThinkingSteps.value)
  if (next.has(stepId)) next.delete(stepId)
  else next.add(stepId)
  expandedThinkingSteps.value = next
}

const templates = ref<WatchTemplateInfo[]>([])
const selectedTemplateCategory = ref<string>('all')

// ==================== Utilities ====================

const formatDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
const formatFullDate = (ts: number) => new Date(ts).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

const filteredHistory = computed<WatchHistoryRecord[]>(() => {
  if (historyWatchIdFilter.value) return watchHistory.value
  return watchHistory.value.filter(h => h.watchId !== '__wakeup__')
})

const historyPageTitle = computed(() => {
  const id = historyWatchIdFilter.value
  if (!id) return t('watch.watchHistoryTitle')
  const name = userWatches.value.find(w => w.id === id)?.name
    || watchHistory.value.find(h => h.watchId === id)?.watchName
    || id
  return t('watch.overviewHistoryForWatch', { name })
})

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
    const all = await window.electronAPI.watch.getHistory(
      historyWatchIdFilter.value ?? undefined,
      watchHistory.value.length + historyPageSize
    )
    historyHasMore.value = all.length > watchHistory.value.length + historyPageSize - 1
    watchHistory.value = all
  } finally {
    historyLoadingMore.value = false
  }
}

/** 把 cron 表达式翻译成自然语言（zh-CN/en），失败时回退到原始表达式 */
const cronToHuman = (expr: string): string => {
  try {
    const locale = configStore.language === 'zh-CN' ? 'zh_CN' : 'en'
    const text = cronstrue.toString(expr, { locale, use24HourTimeFormat: true })
    return text.replace(/^在\s*/, '')
  } catch {
    return `Cron: ${expr}`
  }
}

const getTriggerLabel = (trigger: WatchTrigger): string => {
  switch (trigger.type) {
    case 'cron': return cronToHuman(trigger.expression)
    case 'interval': {
      const s = trigger.seconds || 0
      if (s >= 3600) return t('watch.triggerIntervalHumanHours', { hours: Math.round(s / 3600) })
      if (s >= 60) return t('watch.triggerIntervalHumanMinutes', { minutes: Math.round(s / 60) })
      return t('watch.triggerIntervalHumanSeconds', { seconds: s })
    }
    case 'heartbeat': return t('watch.triggerHeartbeat')
    case 'webhook': return 'Webhook'
    case 'manual': return t('watch.triggerManual')
    case 'file_change': return t('watch.triggerFileChange')
    case 'calendar': return `${t('watch.triggerCalendar')} (${trigger.beforeMinutes}min)`
    case 'email': return t('watch.triggerEmail')
    default: return (trigger as { type: string }).type
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

const getTriggerIcon = (type: WatchTriggerType | string) => {
  const map: Record<string, any> = {
    cron: Clock, interval: RefreshCw, heartbeat: Heart,
    webhook: Globe, manual: Zap,
    file_change: FolderOpen, calendar: Calendar, email: Mail,
    im_connected: Globe, app_lifecycle: Zap,
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

const formatToolResult = (result: string): string | null => {
  if (!result) return null
  const match = /<content>([\s\S]*?)<\/content>/.exec(result)
  return match ? match[1].trim() : result
}

// ==================== Data Loading ====================

const loadWatchData = async () => {
  loading.value = true
  try {
    watches.value = await window.electronAPI.watch.getAll()
    const history = await window.electronAPI.watch.getHistory(
      historyWatchIdFilter.value ?? undefined,
      historyPageSize + 1
    )
    historyHasMore.value = history.length > historyPageSize
    watchHistory.value = historyHasMore.value ? history.slice(0, historyPageSize) : history
    const running = await window.electronAPI.watch.getRunning()
    runningWatches.value = new Set(running)
  } catch (e) {
    console.error('Failed to load watches:', e)
  } finally {
    loading.value = false
  }
}

/** 打开运行历史；可带 watchId 只看该关切（总览「查看更多」） */
const openWatchHistory = (watchId?: string) => {
  historyWatchIdFilter.value = watchId || null
  selectedHistoryRecord.value = null
  switchTab('watchHistory', loadWatchData)
}

const clearHistoryWatchFilter = () => {
  historyWatchIdFilter.value = null
  loadWatchData()
}

const loadTemplates = async () => {
  try { templates.value = await window.electronAPI.watch.getTemplates() } catch (e) { console.error('Failed to load templates:', e) }
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

// 把 watch 折算成「运营 UI 状态」，与 binding-resolver.computeWatchStatus 同源
type WatchUIStatus = 'running' | 'error' | 'success' | 'warning' | 'idle'
const watchStatusOf = (w: WatchDefinition): WatchUIStatus => {
  if (runningWatches.value.has(w.id)) return 'running'
  if (!w.enabled) return 'idle'
  const last = w.lastRun
  if (!last) return 'idle'
  if (last.status === 'failed' || last.status === 'timeout') return 'error'
  if (last.status === 'cancelled' || last.status === 'skipped') return 'warning'
  if (last.status === 'completed') return 'success'
  if (last.status === 'running') return 'running'
  return 'idle'
}

// 异常关切数（含失败/超时），供总览徽章/状态条使用
const errorCount = computed(() =>
  userWatches.value.filter(w => w.enabled && watchStatusOf(w) === 'error').length
)
const runningCount = computed(() => userWatches.value.filter(w => runningWatches.value.has(w.id)).length)
const disabledCount = computed(() => userWatches.value.filter(w => !w.enabled).length)
const totalCount = computed(() => userWatches.value.length)
// 「正常」= 启用 - 异常 - 运行中，包含 idle（从未运行过）和 warning（上次被取消/跳过）。
// 这样汇总条的口径满足 normal + error + running + disabled = total，不会漏数。
const normalCount = computed(() =>
  Math.max(0, totalCount.value - disabledCount.value - errorCount.value - runningCount.value)
)

// 状态汇总条筛选
type WatchStatusFilter = 'all' | 'normal' | 'error' | 'running' | 'disabled'
const statusFilter = ref<WatchStatusFilter>('all')
const setStatusFilter = (f: WatchStatusFilter) => {
  // 再次点击当前筛选项 → 回到「全部」
  statusFilter.value = statusFilter.value === f ? 'all' : f
}
const filteredWatches = computed<WatchDefinition[]>(() => {
  const list = userWatches.value
  switch (statusFilter.value) {
    // 与 normalCount 同口径：启用且非异常非运行中（含 idle / warning）
    case 'normal':   return list.filter(w => {
      if (!w.enabled) return false
      const s = watchStatusOf(w)
      return s !== 'error' && s !== 'running'
    })
    case 'error':    return list.filter(w => w.enabled && watchStatusOf(w) === 'error')
    case 'running':  return list.filter(w => runningWatches.value.has(w.id))
    case 'disabled': return list.filter(w => !w.enabled)
    default:         return list
  }
})

watch(() => userWatches.value, (list) => {
  if (selectedWatch.value && !list.some(w => w.id === selectedWatch.value!.id)) {
    selectedWatch.value = null
  }
})

// ==================== Watch Operations ====================

const selectWatch = (w: WatchDefinition) => {
  if (editing.value) cancelEditing()
  // 左栏筛选可能把该项藏起来——从总览点进来时自动放宽到「全部」
  if (statusFilter.value !== 'all') {
    const visible = filteredWatches.value.some(x => x.id === w.id)
    if (!visible) statusFilter.value = 'all'
  }
  historyDetailInOverlay.value = false
  selectedWatch.value = w
  if (activeTab.value !== 'watches') {
    activeTab.value = 'watches'
    try { localStorage.setItem(LAST_TAB_STORAGE_KEY, 'watches') } catch { /* ignore */ }
  }
  // 总览可连续重试多条；进详情时接到正在跑的这条，后续独白才能续上
  if (runningWatches.value.has(w.id) && liveExecutionWatchId.value !== w.id) {
    liveExecutionWatchId.value = w.id
    liveSteps.value = []
  }
  loadWatchRecentHistory(w.id)
}

const selectOverview = () => {
  if (editing.value) cancelEditing()
  historyDetailInOverlay.value = false
  switchTab('overview')
}

/** 总览异常徽章：切到关切列表筛异常，并打开最近失败的一条 */
const focusAnomalies = () => {
  statusFilter.value = 'error'
  const sorted = userWatches.value
    .filter(w => w.enabled && watchStatusOf(w) === 'error')
    .sort((a, b) => (b.lastRun?.at ?? 0) - (a.lastRun?.at ?? 0))
  if (sorted[0]) selectWatch(sorted[0])
  else switchTab('watches')
}

// 当前关切的最近运行历史（详情页内嵌时间线）
const watchRecentHistory = ref<WatchHistoryRecord[]>([])
const watchRecentHistoryLoading = ref(false)
const WATCH_RECENT_HISTORY_LIMIT = 5

const loadWatchRecentHistory = async (watchId: string) => {
  watchRecentHistoryLoading.value = true
  try {
    const list = await window.electronAPI.watch.getHistory(watchId, WATCH_RECENT_HISTORY_LIMIT)
    watchRecentHistory.value = Array.isArray(list) ? list : []
  } catch (e) {
    console.error('Failed to load watch recent history:', e)
    watchRecentHistory.value = []
  } finally {
    watchRecentHistoryLoading.value = false
  }
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
  if (!form.name.trim()) {
    await showAlert(t('common.warning'), t('watch.validation.nameRequired'))
    return
  }
  if (!form.prompt.trim()) {
    await showAlert(t('common.warning'), t('watch.validation.promptRequired'))
    return
  }

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

/** 总览异常处置：停用（仅当当前为启用时 toggle） */
const disableWatchById = async (id: string) => {
  const w = watches.value.find(x => x.id === id)
  if (!w?.enabled) return
  await toggleWatch(w)
}

/** 总览运行中：取消执行 */
const cancelWatchById = async (id: string) => {
  try {
    const ok = await window.electronAPI.watch.cancel(id)
    if (ok) {
      const next = new Set(runningWatches.value)
      next.delete(id)
      runningWatches.value = next
      if (liveExecutionWatchId.value === id) {
        // 保留已有独白供回顾；若尚无步骤则清掉「正在启动」
        if (liveSteps.value.length === 0) liveExecutionWatchId.value = null
      }
      await loadWatchData()
    }
  } catch (e) {
    console.error('Failed to cancel watch:', e)
  }
}

const RUNNING_TIMEOUT_MS = 10 * 60 * 1000
const watchTimeouts = new Map<string, NodeJS.Timeout>()

const triggerWatch = async (w: WatchDefinition, opts?: { stayOnCurrentPage?: boolean }) => {
  // 关切列表/详情里手动触发：跳到该关切，便于看运行态 / 独白
  // 总览「重试」只触发，不切页
  if (!opts?.stayOnCurrentPage) selectWatch(w)

  // 关切一律助手执行并推 agent:step；手动触发必开内心独白
  liveExecutionWatchId.value = w.id
  liveSteps.value = []

  try {
    await window.electronAPI.watch.trigger(w.id)
  } catch (e) {
    console.error('Failed to trigger watch:', e)
    if (liveExecutionWatchId.value === w.id) liveExecutionWatchId.value = null
  }
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
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('watch.confirmDelete', { name: w.name }),
    confirmText: t('common.delete'),
  })
  if (!confirmed) return
  await window.electronAPI.watch.delete(w.id)
  if (selectedWatch.value?.id === w.id) selectedWatch.value = null
  await loadWatchData()
}

const clearWatchHistory = async () => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.clear'),
    message: t('watch.confirmClearHistory'),
    confirmText: t('common.clear'),
  })
  if (!confirmed) return
  await window.electronAPI.watch.clearHistory(historyWatchIdFilter.value ?? undefined)
  watchHistory.value = []
  selectedHistoryRecord.value = null
}

const viewHistoryDetail = async (record: WatchHistoryRecord) => {
  // 总览 / 关切页内用叠层；其它入口切到历史 tab
  if (activeTab.value === 'overview' || activeTab.value === 'watches') {
    historyDetailInOverlay.value = true
  } else {
    historyDetailInOverlay.value = false
    if (activeTab.value !== 'watchHistory') {
      switchTab('watchHistory', loadWatchData)
    }
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
    // 快速连点多条流水时，丢弃过期响应
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
  historyDetailInOverlay.value = false
}

const useTemplate = async (tpl: WatchTemplateInfo) => {
  try {
    const watch = await window.electronAPI.watch.createFromTemplate(tpl.id)
    if (watch) {
      activeTab.value = 'watches'
      await loadWatchData()
      const created = watches.value.find(w => w.id === watch.id)
      if (created) selectWatch(created)
    }
  } catch (e) { console.error('Failed to create from template:', e) }
}


function requestClose() {
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

onErrorCaptured((err, _instance, info) => {
  console.error('[WatchPanel] Error captured:', err, 'info:', info)
  return false
})

onMounted(async () => {
  document.addEventListener('keydown', handleKeydown, true)
  await loadWatchData().catch(() => {})
  loadTemplates()
  refreshTimer = setInterval(loadWatchData, 5 * 60 * 1000)

  cleanupWatchStarted = window.electronAPI.watch.onTaskStarted?.((data: any) => {
    if (data?.watchId) {
      markWatchRunning(data.watchId)
      void loadWatchData()
    }
    // 并发下仅绑定当前正在直播或已选中详情的关切，避免其它关切冲掉内心独白
    if (data?.watchId && data?.executionType === 'assistant') {
      if (
        liveExecutionWatchId.value === data.watchId ||
        selectedWatch.value?.id === data.watchId
      ) {
        liveExecutionWatchId.value = data.watchId
        liveSteps.value = []
      }
    }
  }) ?? null
  cleanupWatchCompleted = window.electronAPI.watch.onTaskCompleted?.((data: any) => {
    if (data?.watchId) markWatchCompleted(data.watchId)
  }) ?? null
  // 监听关切助手的 Agent 步骤，用于详情面板展示内心独白（按 watchId 过滤，支持并发）
  cleanupAgentStep = window.electronAPI.agent.onStep((data: { agentId: string; step: { id: string; type: string; content: string; toolName?: string; toolArgs?: Record<string, unknown>; toolResult?: string; timestamp?: number; success?: boolean; images?: string[]; webSearchResults?: unknown[]; subAgents?: unknown[] } }) => {
    if (!liveExecutionWatchId.value || !isWatchAgentKey(data.agentId)) return
    const fromKey = watchIdFromAgentKey(data.agentId)
    // 新格式必须 watchId 匹配；legacy `__watch__` 无后缀时仅接受当前直播流
    if (fromKey !== null && fromKey !== liveExecutionWatchId.value) return
    const step = data.step
    const idx = liveSteps.value.findIndex(s => s.id === step.id)
    const entry: LiveStep = {
      id: step.id, type: step.type, content: step.content,
      toolName: step.toolName, toolArgs: step.toolArgs, toolResult: step.toolResult,
      timestamp: step.timestamp ?? Date.now(),
      success: step.success, images: step.images,
      webSearchResults: step.webSearchResults, subAgents: step.subAgents
    }
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
          <Eye :size="16" style="margin-right: 6px;" />
          {{ t('watch.watches') }}
        </h2>
        <div class="header-stats" v-if="userWatches.length > 0">
          <span class="stat-item">{{ enabledCount }} {{ t('watch.activeCount') }}</span>
        </div>
        <button class="btn-icon btn-icon-header" @click="requestClose" :title="t('watch.close')">
          <X :size="18" />
        </button>
      </div>

      <p class="panel-desc">{{ t('watch.panelDesc') }}</p>

      <div class="panel-body">
        <nav class="panel-nav">
          <div class="nav-group">
            <button class="nav-item" :class="{ active: activeTab === 'overview' }" @click="switchTab('overview')">
              <LayoutGrid :size="16" />
              <span>{{ t('watch.overviewTitle') }}</span>
              <span v-if="errorCount > 0" class="nav-badge nav-badge-error" :title="t('watch.errorCountBadge', { n: errorCount })">{{ errorCount }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'watches' }" @click="switchTab('watches')">
              <Eye :size="16" />
              <span>{{ t('watch.watches') }}</span>
              <span v-if="userWatches.length" class="nav-badge">{{ userWatches.length }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'templates' }" @click="switchTab('templates', loadTemplates)">
              <LayoutTemplate :size="16" />
              <span>{{ t('watch.templates') }}</span>
            </button>
            <button class="nav-item" :class="{ active: activeTab === 'watchHistory' }" @click="openWatchHistory()">
              <History :size="16" />
              <span>{{ t('watch.executionHistory') }}</span>
            </button>
          </div>
        </nav>

        <!-- Content Area -->
        <div class="panel-content">

          <!-- ===================== 运营总览（独立页） ===================== -->
          <template v-if="activeTab === 'overview'">
            <div class="content-page">
              <WatchHistoryDetailView
                v-if="historyDetailInOverlay && selectedHistoryRecord"
                :record="selectedHistoryRecord"
                :loading="historyDetailLoading"
                :steps="historyDetailSteps"
                :user-task="historyDetailUserTask"
                :back-label="t('watch.backToOverview')"
                @back="closeHistoryDetail"
              />
              <WatchOverviewPanel
                v-else
                :watches="userWatches"
                :history="watchHistory"
                :running-watches="runningWatches"
                @select-watch="(id) => { const w = userWatches.find(x => x.id === id); if (w) selectWatch(w) }"
                @view-history-detail="viewHistoryDetail"
                @retry-watch="(id) => { const w = userWatches.find(x => x.id === id); if (w) triggerWatch(w, { stayOnCurrentPage: true }) }"
                @disable-watch="disableWatchById"
                @cancel-watch="cancelWatchById"
                @focus-anomalies="focusAnomalies"
                @view-all-history="() => openWatchHistory()"
                @view-more-history="(id) => openWatchHistory(id)"
                @go-templates="() => switchTab('templates', loadTemplates)"
              />
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

                <!-- 状态汇总条 -->
                <div class="status-summary" v-if="userWatches.length > 0">
                  <button class="status-chip" :class="{ active: statusFilter === 'all' }" @click="setStatusFilter('all')" :title="t('watch.filterAll')">
                    <span class="chip-label">{{ t('watch.filterAll') }}</span>
                    <span class="chip-count">{{ totalCount }}</span>
                  </button>
                  <button class="status-chip status-normal" :class="{ active: statusFilter === 'normal' }" @click="setStatusFilter('normal')" :title="t('watch.filterNormal')">
                    <span class="chip-dot"></span>
                    <span class="chip-count">{{ normalCount }}</span>
                  </button>
                  <button class="status-chip status-error" :class="{ active: statusFilter === 'error' }" @click="setStatusFilter('error')" :title="t('watch.filterError')">
                    <span class="chip-dot"></span>
                    <span class="chip-count">{{ errorCount }}</span>
                  </button>
                  <button class="status-chip status-running" :class="{ active: statusFilter === 'running' }" @click="setStatusFilter('running')" :title="t('watch.filterRunning')">
                    <span class="chip-dot"></span>
                    <span class="chip-count">{{ runningCount }}</span>
                  </button>
                  <button class="status-chip status-disabled" :class="{ active: statusFilter === 'disabled' }" @click="setStatusFilter('disabled')" :title="t('watch.filterDisabled')">
                    <span class="chip-dot"></span>
                    <span class="chip-count">{{ disabledCount }}</span>
                  </button>
                </div>

                <div class="item-list">
                  <div v-for="w in filteredWatches" :key="w.id" class="list-item" :class="{ active: selectedWatch?.id === w.id, disabled: !w.enabled, running: runningWatches.has(w.id) }" @click="selectWatch(w)">
                    <button class="btn-toggle" :class="{ enabled: w.enabled }" @click.stop="toggleWatch(w)">
                      <span class="toggle-dot"></span>
                    </button>
                    <div class="item-info">
                      <div class="item-name">{{ w.name }}</div>
                    </div>
                    <button class="btn-icon-sm" @click.stop="triggerWatch(w)" :disabled="runningWatches.has(w.id)" :title="runningWatches.has(w.id) ? t('watch.statusRunning') : t('watch.trigger')">
                      <RefreshCw v-if="runningWatches.has(w.id)" :size="14" class="spinning" />
                      <Play v-else :size="14" />
                    </button>
                  </div>

                  <div v-if="userWatches.length === 0 && !loading" class="empty-state empty-state-list">
                    <p class="hint-text">{{ t('watch.noWatchesYet') }}</p>
                  </div>
                  <div v-else-if="filteredWatches.length === 0 && !loading" class="empty-state empty-state-list">
                    <p class="hint-text">{{ t('watch.noWatchesInFilter') }}</p>
                    <button class="btn btn-sm" @click="setStatusFilter('all')">{{ t('watch.filterAll') }}</button>
                  </div>
                </div>
              </div>

              <!-- Watch Detail -->
              <div class="detail-area">
                <WatchHistoryDetailView
                  v-if="historyDetailInOverlay && selectedHistoryRecord"
                  :record="selectedHistoryRecord"
                  :loading="historyDetailLoading"
                  :steps="historyDetailSteps"
                  :user-task="historyDetailUserTask"
                  :back-label="t('watch.backToWatch')"
                  @back="closeHistoryDetail"
                />
                <template v-else-if="selectedWatch">
                  <div class="detail-header">
                    <div class="detail-title" v-if="!editing">
                      <button class="btn btn-sm back-to-overview" @click="selectOverview" :title="t('watch.backToOverview')">
                        ← {{ t('watch.backToOverview') }}
                      </button>
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
                        <AppSelect
                          :model-value="editForm.priority"
                          size="field"
                          block
                          :options="[
                            { value: 'high', label: t('watch.priorityHigh') },
                            { value: 'normal', label: t('watch.priorityNormal') },
                            { value: 'low', label: t('watch.priorityLow') },
                          ]"
                          @update:model-value="editForm.priority = $event as 'high' | 'normal' | 'low'"
                        />
                      </div>
                      <div class="edit-section edit-section-half">
                        <label class="edit-label">{{ t('watch.outputType') }}</label>
                        <AppSelect
                          :model-value="editForm.outputType"
                          size="field"
                          block
                          :options="[
                            { value: 'desktop', label: t('watch.outputDesktop') },
                            { value: 'im', label: t('watch.outputIM') },
                            { value: 'notification', label: t('watch.outputNotification') },
                            { value: 'log', label: t('watch.outputLog') },
                            { value: 'silent', label: t('watch.outputSilent') },
                          ]"
                          @update:model-value="editForm.outputType = $event as 'desktop' | 'im' | 'notification' | 'log' | 'silent'"
                        />
                      </div>
                    </div>
                    <div class="edit-section">
                      <label class="edit-label">{{ t('watch.skills') }}</label>
                      <input v-model="editForm.skills" class="edit-input" :placeholder="t('watch.skillsPlaceholder')" spellcheck="false" />
                    </div>
                  </div>

                  <!-- ===== View Mode ===== -->
                  <div class="detail-body" v-else>
                    <!-- 内心独白置顶：执行中优先可见，不必滚过配置区 -->
                    <div class="detail-section live-output-section" v-if="selectedWatch.id === liveExecutionWatchId">
                      <h4>{{ t('watch.liveOutput') }}</h4>
                      <div v-if="visibleLiveSteps.length === 0" class="live-output-waiting">
                        <RefreshCw :size="14" class="spinning" />
                        <span>{{ t('watch.liveOutputWaiting') }}</span>
                      </div>
                      <div
                        v-else
                        class="live-steps history-steps-list"
                        @click="handleCodeBlockClick"
                        @contextmenu="handleFilePathContextMenu"
                      >
                        <div
                          v-for="step in visibleLiveSteps"
                          :key="step.id"
                          class="agent-step-inline"
                          :class="[step.type]"
                        >
                          <span class="step-icon">{{ getStepIcon(step.type) }}</span>
                          <div class="step-content">
                            <div v-if="step.type === 'message' || step.type === 'thinking'" class="agent-message-stack">
                              <template v-for="(pres, presIdx) in [getMessageStepPresentation(step)]" :key="presIdx">
                                <ThinkingBlock
                                  v-if="pres.thinking"
                                  :reasoning="pres.thinking.reasoning"
                                  :is-streaming="pres.thinking.isStreaming"
                                  :expanded="isThinkingExpanded(step.id)"
                                  :started-at="step.timestamp"
                                  @toggle="toggleThinkingExpand(step.id)"
                                />
                                <div
                                  v-else-if="step.type === 'thinking' && step.content"
                                  class="step-text"
                                >{{ step.content }}</div>
                                <div
                                  v-if="pres.body && step.type === 'message'"
                                  class="step-text step-analysis markdown-content"
                                  v-html="renderMarkdown(pres.body)"
                                ></div>
                              </template>
                            </div>
                            <ToolCallContent
                              v-else-if="step.type === 'tool_call'"
                              :content="step.content"
                              :toolArgs="step.toolArgs"
                            />
                            <div
                              v-else-if="step.type === 'error'"
                              class="step-text"
                            >{{ step.content }}</div>
                            <div
                              v-else-if="step.content"
                              class="step-text markdown-content"
                              v-html="renderMarkdown(step.content)"
                            ></div>
                            <div v-if="step.toolResult && step.toolResult !== step.content" class="step-tool-result">
                              <pre>{{ formatToolResult(step.toolResult) }}</pre>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
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
                    <!-- 该关切的运行历史时间线（最近 5 条） -->
                    <div class="detail-section">
                      <h4>{{ t('watch.recentRuns') }}</h4>
                      <div v-if="watchRecentHistoryLoading" class="watch-recent-empty">{{ t('watch.loading') }}</div>
                      <div v-else-if="watchRecentHistory.length === 0" class="watch-recent-empty">{{ t('watch.noHistory') }}</div>
                      <div v-else class="watch-recent-list">
                        <div
                          v-for="h in watchRecentHistory" :key="h.id"
                          class="watch-recent-row"
                          :class="{ clickable: !!h.agentSessionId }"
                          @click="viewHistoryDetail(h)"
                        >
                          <span class="history-status-icon" :class="getStatusClass(h.status)">{{ getStatusIcon(h.status) }}</span>
                          <span class="history-trigger-chip">{{ getTriggerTypeLabel(h.triggerType) }}</span>
                          <span class="history-spacer-grow"></span>
                          <span class="history-time">{{ formatDate(h.at) }}</span>
                          <span class="history-duration">{{ formatDuration(h.duration) }}</span>
                          <span v-if="h.agentSessionId" class="history-detail-indicator"><Eye :size="12" /></span>
                        </div>
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

          <!-- ===================== 执行历史 ===================== -->
          <template v-if="activeTab === 'watchHistory'">
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

              <!-- 历史列表视图：仅用户关切（不含 wakeup） -->
              <template v-else>
                <div class="page-toolbar">
                  <span class="page-title">
                    {{ historyPageTitle }}
                  </span>
                  <div class="toolbar-right">
                    <button
                      v-if="historyWatchIdFilter"
                      class="btn btn-sm"
                      @click="clearHistoryWatchFilter"
                    >
                      {{ t('watch.overviewShowAllWatchesHistory') }}
                    </button>
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

.panel-desc,
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

.nav-badge-error {
  background: var(--status-error, #c0392b);
  color: #fff;
}
.nav-item.active .nav-badge-error {
  background: rgba(255, 255, 255, 0.25);
  color: inherit;
}
.empty-state-list {
  padding: 24px 12px;
  text-align: center;
}

.item-info { flex: 1; min-width: 0; }
.item-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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
