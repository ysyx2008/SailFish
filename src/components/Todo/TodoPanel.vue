<script setup lang="ts">
/**
 * 本地待办面板 —— TabBar 固定面（联络右侧）
 * 列表紧凑单行；点击打开右侧详情（完整 TodoItem 字段）
 */
import { computed, inject, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  Plus,
  Trash2,
  ListTodo,
  Loader2,
  MessagesSquare,
  X,
} from 'lucide-vue-next'
import type { TodoItem, TodoPriority, TodoSource, TodoStatus } from '@sailfish/shared-types'
import { useTerminalStore, COMPANION_TAB_AGENT_ID } from '../../stores/terminal'
import { toast } from '../../composables/useToast'
import type { UrgencyTier } from './urgency'
import AppSelect from '../common/AppSelect.vue'
import TodoRowHoverTip from './TodoRowHoverTip.vue'
import TodoMenu from './TodoMenu.vue'
import TodoDatePicker from './TodoDatePicker.vue'

const { t, locale } = useI18n()
const terminalStore = useTerminalStore()
const openAppSettings = inject<(tab?: string, section?: string) => void>('openAppSettings')
const emit = defineEmits<{ close: [] }>()

const contextMenu = ref<{ item: TodoItem; x: number; y: number } | null>(null)
const sourceLabels = ref<Record<string, string>>({})
const dispatching = ref(false)

type FilterMode = 'active' | 'completed' | 'all'

const loading = ref(true)
const todos = ref<TodoItem[]>([])
const filterMode = ref<FilterMode>('all')
const newTitle = ref('')
const newDueDate = ref('')
const creating = ref(false)
const busyIds = ref<Set<string>>(new Set())
const titleInputRef = ref<HTMLInputElement | null>(null)
const selectedId = ref<string | null>(null)
const savingDetail = ref(false)

/** 跟随鼠标的悬停速览 */
const hoverTipItem = ref<TodoItem | null>(null)
const hoverTipPos = ref({ x: 0, y: 0 })
const hoverTipSuppressed = ref(false)

/** 详情草稿（选中条目的可编辑副本） */
const draft = ref<{
  title: string
  description: string
  status: TodoStatus
  priority: TodoPriority | ''
  dueDate: string
  tagsText: string
} | null>(null)

let unsubChanged: (() => void) | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

const PRIORITIES: TodoPriority[] = ['urgent', 'high', 'normal', 'low']
const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

/** 陈旧补洞阈值（天）——见 todo SPEC 设计目标 */
const STALE_DAYS = 7

/** 标题综合关注度（完成态不着色） */
type AttentionLevel = 'critical' | 'strong' | 'medium' | 'mild' | 'default' | 'faint'

/** 剩余不足此比例（含）→ 与「今天」一并进入即将到期分区 */
const DUE_SOON_REMAINING_MAX = 0.2

/** 绝对剩余 ≤ 此毫秒也进「即将到期」（约 48h） */
const DUE_SOON_ABSOLUTE_MS = 48 * 60 * 60 * 1000

/** 进度条条长封顶：满条 = 剩余 ≥ 14 天 */
const DUE_BAR_CAP_MS = 14 * 24 * 60 * 60 * 1000

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 本地日历日 YYYY-MM-DD */
function localYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 截止日的本地日历日。
 * 面板 date input 存 YYYY-MM-DD，按用户意图的公历日理解；带时刻的 ISO 再按本地日切。
 */
function dueLocalYmd(due: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(due.trim())
  if (m) return m[1]
  const d = new Date(due)
  if (Number.isNaN(d.getTime())) return null
  return localYmd(d)
}

/**
 * 截止时刻（ms）。纯日期 YYYY-MM-DD → 该本地日结束（23:59:59.999）；
 * 带时刻的 ISO 用解析时刻。
 */
function dueDeadlineMs(due: string): number | null {
  const trimmed = due.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [y, mo, d] = trimmed.split('-').map(Number)
    const end = new Date(y, mo - 1, d, 23, 59, 59, 999)
    return end.getTime()
  }
  const t = new Date(trimmed).getTime()
  return Number.isNaN(t) ? null : t
}

function isActiveTodo(item: TodoItem): boolean {
  return item.status !== 'completed' && item.status !== 'cancelled'
}

/** 逾期：截止本地日早于今天（与即将到期同一套日历基准） */
function isOverdue(item: TodoItem): boolean {
  if (!isActiveTodo(item) || !item.dueDate) return false
  const due = dueLocalYmd(item.dueDate)
  return !!due && due < localYmd(new Date())
}

/** 绝对剩余毫秒；无截止/完成/逾期 → null */
function dueRemainingMs(item: TodoItem): number | null {
  if (!isActiveTodo(item) || !item.dueDate || isOverdue(item)) return null
  const due = dueDeadlineMs(item.dueDate)
  if (due == null) return null
  return Math.max(0, due - Date.now())
}

/**
 * 进度条宽度 0–1：绝对剩余 / 14 天封顶。
 * 明天到期 ≈ 短条，两周后 ≈ 满条；无截止/完成/逾期不画条。
 */
function dueProgressRatio(item: TodoItem): number | null {
  const rem = dueRemainingMs(item)
  if (rem == null) return null
  return Math.min(1, rem / DUE_BAR_CAP_MS)
}

/** 预留期剩余占比（仅用于「即将到期」比例判据，不画条） */
function dueBudgetRemainingRatio(item: TodoItem): number | null {
  if (!isActiveTodo(item) || !item.dueDate || isOverdue(item)) return null
  const created = new Date(item.createdAt).getTime()
  const due = dueDeadlineMs(item.dueDate)
  if (Number.isNaN(created) || due == null || due <= created) return null
  return Math.min(1, Math.max(0, (due - Date.now()) / (due - created)))
}

/**
 * 即将到期（进独立分区）：今天截止、绝对剩余 ≤ 48h、或预留期剩余 ≤ 20%。
 * 未逾期；与进行中/待办互斥。
 */
function isDueSoon(item: TodoItem): boolean {
  if (!isActiveTodo(item) || !item.dueDate || isOverdue(item)) return false
  const due = dueLocalYmd(item.dueDate)
  if (due && due === localYmd(new Date())) return true
  const rem = dueRemainingMs(item)
  if (rem != null && rem <= DUE_SOON_ABSOLUTE_MS) return true
  const budget = dueBudgetRemainingRatio(item)
  return budget != null && budget <= DUE_SOON_REMAINING_MAX
}

function isStale(item: TodoItem): boolean {
  if (!isActiveTodo(item)) return false
  if (isOverdue(item) || isDueSoon(item)) return false
  const created = new Date(item.createdAt).getTime()
  if (Number.isNaN(created)) return false
  return Date.now() - created >= STALE_DAYS * MS_PER_DAY
}

/**
 * 综合关注度：时限（已逾期 ≥ 即将到期）× 重要度 × 陈旧补洞。
 * 无紧迫截止时 high/urgent 只轻度着色；陈旧再上浮一档，不得到 critical。
 */
function attentionLevel(item: TodoItem): AttentionLevel {
  if (!isActiveTodo(item)) return 'default'

  const pri = item.priority

  if (isOverdue(item) || isDueSoon(item)) {
    return pri === 'urgent' || pri === 'high' ? 'critical' : 'strong'
  }
  if (pri === 'urgent' || pri === 'high') {
    return isStale(item) ? 'medium' : 'mild'
  }
  if (pri === 'low') return 'faint'
  return 'default'
}

/** 到期紧急档：与项目现成的跨主题固定三档强弱阶梯对应
 * --brand-alert（红/高风险）→ --brand-caution（橙/中风险）→ --brand-vital（绿/低风险）。
 * 单一判档函数，供进度条颜色、Hover 速览文案与色点共用，避免阈值散落三处。
 */
function dueUrgencyTier(remainingMs: number): UrgencyTier {
  if (remainingMs <= 2 * MS_PER_DAY) return 'urgent'
  if (remainingMs <= 7 * MS_PER_DAY) return 'watch'
  return 'relaxed'
}

const URGENCY_COLOR_VAR: Record<UrgencyTier, string> = {
  urgent: '--brand-alert',
  watch: '--brand-caution',
  relaxed: '--brand-vital',
}

function dueProgressColor(remainingMs: number): string {
  const tier = dueUrgencyTier(remainingMs)
  const pct = tier === 'relaxed' ? 14 : 16
  return `color-mix(in srgb, var(${URGENCY_COLOR_VAR[tier]}) ${pct}%, transparent)`
}

function dueProgressVars(item: TodoItem): Record<string, string> | undefined {
  const rem = dueRemainingMs(item)
  const ratio = dueProgressRatio(item)
  if (rem == null || ratio == null) return undefined
  return {
    '--due-progress': `${Math.round(ratio * 100)}%`,
    '--due-progress-color': dueProgressColor(rem),
  }
}

/** Hover 速览：剩余时间文案 */
function dueRemainLabel(item: TodoItem): string | null {
  if (isOverdue(item)) return t('todoPanel.dueOverdueHint')
  const rem = dueRemainingMs(item)
  if (rem == null) return null
  if (rem < 60 * 60 * 1000) return t('todoPanel.dueRemainLtHour')
  if (rem < MS_PER_DAY) {
    return t('todoPanel.dueRemainHours', { n: Math.max(1, Math.round(rem / (60 * 60 * 1000))) })
  }
  if (rem < DUE_BAR_CAP_MS) {
    return t('todoPanel.dueRemainDays', { n: Math.max(1, Math.round(rem / MS_PER_DAY)) })
  }
  return t('todoPanel.dueRemainOverCap')
}

/** Hover 速览：紧急档文案（逾期/无截止不显示） */
function dueUrgencyLabel(item: TodoItem): string | null {
  const rem = dueRemainingMs(item)
  if (rem == null) return null
  const tier = dueUrgencyTier(rem)
  if (tier === 'urgent') return t('todoPanel.dueUrgencyUrgent')
  if (tier === 'watch') return t('todoPanel.dueUrgencyWatch')
  return t('todoPanel.dueUrgencyRelaxed')
}

/** Hover 速览：紧急档枚举（逾期/无截止不显示），供卡片画色点，不做关键词匹配 */
function dueUrgencyTierOf(item: TodoItem): UrgencyTier | null {
  const rem = dueRemainingMs(item)
  return rem == null ? null : dueUrgencyTier(rem)
}

function onRowPointerMove(item: TodoItem, ev: MouseEvent) {
  const el = ev.target as HTMLElement | null
  if (el?.closest?.('.check-btn, .todo-actions')) {
    hoverTipSuppressed.value = true
    return
  }
  hoverTipSuppressed.value = false
  hoverTipItem.value = item
  hoverTipPos.value = { x: ev.clientX, y: ev.clientY }
}

function onRowPointerLeave() {
  hoverTipItem.value = null
  hoverTipSuppressed.value = false
}

function onRowContextMenu(item: TodoItem, ev: MouseEvent) {
  ev.preventDefault()
  hoverTipSuppressed.value = true
  hoverTipItem.value = null
  contextMenu.value = { item, x: ev.clientX, y: ev.clientY }
}

function closeContextMenu() {
  contextMenu.value = null
}

async function dispatchTodo(item: TodoItem, kind: 'handle' | 'schedule', minutes?: number) {
  if (dispatching.value) return
  closeContextMenu()
  dispatching.value = true
  try {
    const prompt = await window.electronAPI.todo.buildHandoffPrompt(item.id, kind, minutes)
    if (!prompt) {
      toast.error(t('todoPanel.menu.dispatchFailed'))
      return
    }
    const tabId = terminalStore.createAssistantTab({
      activate: false,
      title: item.title,
      initialMessage: prompt,
    })
    terminalStore.markAssistantSkipOnboarding(tabId)
    terminalStore.focusHubConversation(tabId)
  } catch (e) {
    console.error('Failed to dispatch todo:', e)
    toast.error(t('todoPanel.menu.dispatchFailed'))
  } finally {
    dispatching.value = false
  }
}

/** 菜单里的动作走这里取当前项：回调执行时菜单可能已经关了，不能指望模板里的窄化 */
function dispatchFromContextMenu(kind: 'handle' | 'schedule', minutes?: number) {
  const target = contextMenu.value
  if (!target) return
  void dispatchTodo(target.item, kind, minutes)
}

function openCalendarSettings() {
  closeContextMenu()
  openAppSettings?.('calendar')
}

function formatRange(start?: string, end?: string): string {
  const a = start ? formatAbsolute(start) : ''
  const b = end ? formatAbsolute(end) : ''
  if (a && b) return `${a} – ${b}`
  return a || b || '—'
}

function sourceKindLabel(kind: TodoSource['kind']): string {
  return t(`todoPanel.sources.${kind}`)
}

function sourceDisplay(source: TodoSource): string {
  if (source.label) return source.label
  if (source.kind === 'conversation') {
    return sourceLabels.value[source.sessionId || '']
      || t('todoPanel.sources.conversation')
  }
  if (source.kind === 'email') {
    return [source.from, source.subject].filter(Boolean).join(' · ') || t('todoPanel.sources.email')
  }
  if (source.kind === 'file') return source.path || t('todoPanel.sources.file')
  return source.url || t('todoPanel.sources.url')
}

async function resolveSourceLabels(item: TodoItem | null) {
  const next: Record<string, string> = {}
  const sessions = (item?.sources ?? []).filter(s => s.kind === 'conversation' && s.sessionId)
  await Promise.all(sessions.map(async s => {
    const id = s.sessionId!
    try {
      const rec = await window.electronAPI.history.getAgentRecordById(id)
      const title = (rec as { title?: string } | undefined)?.title || rec?.userTask
      if (title) next[id] = title
    } catch {
      /* 失效无所谓 */
    }
  }))
  sourceLabels.value = next
}

/** 面板分区内：只按重要度（同档按创建时间） */
function priorityRank(p?: TodoPriority): number {
  if (p === 'urgent') return 0
  if (p === 'high') return 1
  if (p === 'low') return 3
  return 2 // normal / 未设
}

function sortByImportance(items: TodoItem[]): TodoItem[] {
  return items.slice().sort((a, b) => {
    const d = priorityRank(a.priority) - priorityRank(b.priority)
    if (d !== 0) return d
    return a.createdAt.localeCompare(b.createdAt)
  })
}

const dueSoonItems = computed(() => sortByImportance(todos.value.filter(isDueSoon)))
const overdueItems = computed(() => sortByImportance(todos.value.filter(isOverdue)))
const inProgressItems = computed(() =>
  sortByImportance(
    todos.value.filter(t => t.status === 'in_progress' && !isOverdue(t) && !isDueSoon(t))
  )
)
const pendingItems = computed(() =>
  sortByImportance(
    todos.value.filter(t => t.status === 'pending' && !isOverdue(t) && !isDueSoon(t))
  )
)
const doneItems = computed(() =>
  todos.value
    .filter(t => t.status === 'completed' || t.status === 'cancelled')
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
)

const showActiveSections = computed(() => filterMode.value === 'active' || filterMode.value === 'all')
const showDoneSection = computed(() => filterMode.value === 'completed' || filterMode.value === 'all')

const activeCount = computed(
  () =>
    dueSoonItems.value.length +
    overdueItems.value.length +
    inProgressItems.value.length +
    pendingItems.value.length
)

const isEmpty = computed(() => {
  if (filterMode.value === 'active') return activeCount.value === 0
  if (filterMode.value === 'completed') return doneItems.value.length === 0
  return todos.value.length === 0
})

const selectedItem = computed(() =>
  selectedId.value ? todos.value.find(t => t.id === selectedId.value) ?? null : null
)

watch(selectedItem, (item) => {
  void resolveSourceLabels(item)
})

const detailOpen = computed(() => !!selectedId.value && !!draft.value)

function syncDraftFromItem(item: TodoItem) {
  draft.value = {
    title: item.title,
    description: item.description ?? '',
    status: item.status,
    priority: item.priority ?? '',
    dueDate: item.dueDate ? item.dueDate.slice(0, 10) : '',
    tagsText: item.tags?.join(', ') ?? '',
  }
}

function selectItem(item: TodoItem) {
  if (selectedId.value === item.id) {
    closeDetail()
    return
  }
  selectedId.value = item.id
  syncDraftFromItem(item)
}

function closeDetail() {
  flushSave()
  selectedId.value = null
  draft.value = null
}

async function loadTodos() {
  try {
    if (filterMode.value === 'active') {
      todos.value = await window.electronAPI.todo.list({})
    } else if (filterMode.value === 'completed') {
      const list = await window.electronAPI.todo.list({ status: 'all', includeDone: true })
      todos.value = list.filter(t => t.status === 'completed' || t.status === 'cancelled')
    } else {
      todos.value = await window.electronAPI.todo.list({ status: 'all', includeDone: true })
    }
    // 选中项若被过滤掉则关闭详情；仍在列表则刷新草稿（非编辑中）
    if (selectedId.value) {
      const still = todos.value.find(t => t.id === selectedId.value)
      if (!still) {
        selectedId.value = null
        draft.value = null
      } else if (draft.value && !savingDetail.value) {
        // 外部变更时同步，避免覆盖正在输入：仅当字段与草稿一致来源时更新时间戳展示用 selectedItem
      }
    }
  } catch (e) {
    console.error('Failed to load todos:', e)
  } finally {
    loading.value = false
  }
}

function setFilter(mode: FilterMode) {
  if (filterMode.value === mode) return
  filterMode.value = mode
  loading.value = true
  closeDetail()
  void loadTodos()
}

function formatDueShort(due?: string): string {
  if (!due) return ''
  try {
    const d = new Date(due)
    if (Number.isNaN(d.getTime())) return due
    const today = new Date()
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    if (sameDay) return t('todoPanel.dueToday')
    return new Intl.DateTimeFormat(locale.value, { month: '2-digit', day: '2-digit' }).format(d)
  } catch {
    return due
  }
}

function formatAbsolute(iso?: string): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat(locale.value, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return iso
  }
}

function formatRelative(iso?: string): string {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const diff = Date.now() - d.getTime()
    const sec = Math.floor(diff / 1000)
    if (sec < 60) return t('todoPanel.timeJustNow')
    const min = Math.floor(sec / 60)
    if (min < 60) return t('todoPanel.timeMinAgo', { n: min })
    const hr = Math.floor(min / 60)
    if (hr < 24) return t('todoPanel.timeHrAgo', { n: hr })
    const day = Math.floor(hr / 24)
    if (day < 30) return t('todoPanel.timeDayAgo', { n: day })
    return formatDueShort(iso)
  } catch {
    return ''
  }
}

function priorityLabel(p?: string | null): string {
  if (!p || p === 'normal') return ''
  return t(`todoPanel.priority.${p}`)
}

function statusLabel(s: TodoStatus): string {
  return t(`todoPanel.status.${s}`)
}

function withBusy<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = new Set(busyIds.value)
  next.add(id)
  busyIds.value = next
  return fn().finally(() => {
    const after = new Set(busyIds.value)
    after.delete(id)
    busyIds.value = after
  })
}

async function handleCreate() {
  const title = newTitle.value.trim()
  if (!title || creating.value) return
  creating.value = true
  try {
    const item = await window.electronAPI.todo.create({
      title,
      dueDate: newDueDate.value.trim() || undefined,
    })
    newTitle.value = ''
    newDueDate.value = ''
    await loadTodos()
    selectedId.value = item.id
    syncDraftFromItem(item)
    titleInputRef.value?.focus()
  } catch (e) {
    console.error('Failed to create todo:', e)
    toast.error(t('todoPanel.createFailed'))
  } finally {
    creating.value = false
  }
}

async function handleComplete(item: TodoItem, ev?: Event) {
  ev?.stopPropagation()
  await withBusy(item.id, async () => {
    if (item.status === 'completed' || item.status === 'cancelled') {
      await window.electronAPI.todo.update(item.id, { status: 'pending' })
    } else {
      await window.electronAPI.todo.complete(item.id)
    }
    await loadTodos()
    const updated = todos.value.find(t => t.id === item.id)
    if (updated && selectedId.value === item.id) syncDraftFromItem(updated)
  })
}

async function handleDelete(item: TodoItem, ev?: Event) {
  ev?.stopPropagation()
  await withBusy(item.id, async () => {
    await window.electronAPI.todo.delete(item.id)
    if (selectedId.value === item.id) {
      selectedId.value = null
      draft.value = null
    }
    await loadTodos()
  })
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void persistDraft()
  }, 400)
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void persistDraft()
}

async function persistDraft() {
  const id = selectedId.value
  const d = draft.value
  const original = id ? todos.value.find(t => t.id === id) : null
  if (!id || !d || !original) return

  const title = d.title.trim()
  if (!title) {
    toast.error(t('todoPanel.titleRequired'))
    d.title = original.title
    return
  }

  const tags = d.tagsText
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean)

  const patch: {
    title?: string
    description?: string | null
    status?: TodoStatus
    priority?: TodoPriority | null
    dueDate?: string | null
    tags?: string[] | null
  } = {}

  if (title !== original.title) patch.title = title

  const nextDesc = d.description.trim()
  const prevDesc = original.description ?? ''
  if (nextDesc !== prevDesc) patch.description = nextDesc || null

  if (d.status !== original.status) patch.status = d.status

  const nextPri = d.priority || null
  const prevPri = original.priority ?? null
  if (nextPri !== prevPri) patch.priority = nextPri as TodoPriority | null

  const nextDue = d.dueDate.trim() || null
  const prevDue = original.dueDate ? original.dueDate.slice(0, 10) : null
  if (nextDue !== prevDue) patch.dueDate = nextDue

  const prevTags = original.tags ?? []
  const tagsChanged =
    tags.length !== prevTags.length || tags.some((x, i) => x !== prevTags[i])
  if (tagsChanged) patch.tags = tags.length ? tags : null

  if (Object.keys(patch).length === 0) return

  savingDetail.value = true
  try {
    const updated = await window.electronAPI.todo.update(id, patch)
    if (updated) {
      const idx = todos.value.findIndex(t => t.id === id)
      if (idx >= 0) todos.value[idx] = updated
      else await loadTodos()
    }
  } catch (e) {
    console.error('Failed to update todo:', e)
    toast.error(t('todoPanel.saveFailed'))
  } finally {
    savingDetail.value = false
  }
}

watch(
  draft,
  () => {
    if (draft.value && selectedId.value) scheduleSave()
  },
  { deep: true }
)

function openCompanion() {
  const companion = terminalStore.tabs.find(t => t.agentId === COMPANION_TAB_AGENT_ID)
  if (companion) terminalStore.setActiveTab(companion.id)
}

function onRowKeydown(item: TodoItem, ev: KeyboardEvent) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault()
    selectItem(item)
  }
}

function onPanelKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  // 设置 / 觉醒 / 关切 / 确认框等盖在上面时，ESC 先给它们
  if (document.querySelector('.modal-overlay, .credential-overlay, .setup-wizard, .confirm-overlay, .todo-date-popover')) return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  if (contextMenu.value) {
    closeContextMenu()
    return
  }
  if (detailOpen.value) {
    closeDetail()
    return
  }
  emit('close')
}

onMounted(async () => {
  await loadTodos()
  unsubChanged = window.electronAPI.todo.onChanged(() => {
    void loadTodos()
  })
  document.addEventListener('keydown', onPanelKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onPanelKeydown, true)
  unsubChanged?.()
  if (saveTimer) clearTimeout(saveTimer)
})
</script>

<template>
  <div class="todo-panel" :class="{ 'detail-open': detailOpen }">
    <div class="todo-main">
      <div class="todo-chrome">
        <header class="todo-header">
          <div class="todo-mark">
            <ListTodo :size="18" :stroke-width="1.75" />
          </div>
          <div class="todo-header-text">
            <div class="todo-title-row">
              <h1>{{ t('todoPanel.title') }}</h1>
              <span v-if="!loading && filterMode === 'active'" class="count-pill">{{ activeCount }}</span>
            </div>
            <p class="todo-header-desc">{{ t('todoPanel.desc') }}</p>
          </div>
        </header>

        <form class="todo-create" @submit.prevent="handleCreate">
          <div class="create-field">
            <input
              ref="titleInputRef"
              v-model="newTitle"
              class="todo-input"
              type="text"
              :placeholder="t('todoPanel.newPlaceholder')"
              :disabled="creating"
            />
            <TodoDatePicker v-model="newDueDate" variant="compact" :disabled="creating" />
            <button
              type="submit"
              class="todo-add-btn"
              :disabled="!newTitle.trim() || creating"
              :title="t('todoPanel.add')"
            >
              <Loader2 v-if="creating" :size="16" class="spin" />
              <Plus v-else :size="16" />
            </button>
          </div>
        </form>

        <div class="todo-filters" role="tablist">
          <button
            type="button"
            class="filter-btn"
            :class="{ active: filterMode === 'all' }"
            @click="setFilter('all')"
          >
            {{ t('todoPanel.filterAll') }}
          </button>
          <button
            type="button"
            class="filter-btn"
            :class="{ active: filterMode === 'active' }"
            @click="setFilter('active')"
          >
            {{ t('todoPanel.filterActive') }}
          </button>
          <button
            type="button"
            class="filter-btn"
            :class="{ active: filterMode === 'completed' }"
            @click="setFilter('completed')"
          >
            {{ t('todoPanel.filterCompleted') }}
          </button>
        </div>
      </div>

      <div class="todo-scroll">
        <div v-if="loading" class="todo-loading">
          <Loader2 :size="22" class="spin" />
        </div>

        <div v-else-if="isEmpty" class="todo-empty">
          <div class="todo-empty-mark">
            <ListTodo :size="28" :stroke-width="1.5" />
          </div>
          <p class="todo-empty-title">{{ t('todoPanel.emptyTitle') }}</p>
          <p class="todo-empty-hint">
            {{ t('todoPanel.emptyHint') }}
            <button type="button" class="link-btn" @click="openCompanion">
              <MessagesSquare :size="13" />
              {{ t('todoPanel.openCompanion') }}
            </button>
          </p>
        </div>

        <div v-else class="todo-lists">
          <section v-if="showActiveSections && overdueItems.length" class="todo-section">
            <div class="section-header">
              <span class="section-title overdue">{{ t('todoPanel.sectionOverdue') }}</span>
              <span class="section-count overdue">{{ overdueItems.length }}</span>
            </div>
            <ul class="todo-list">
              <li
                v-for="item in overdueItems"
                :key="item.id"
                class="todo-row overdue"
                :class="{
                  selected: selectedId === item.id,
                  busy: busyIds.has(item.id),
                  'has-due-progress': dueProgressRatio(item) != null,
                  'full-due-progress': (dueProgressRatio(item) ?? 0) >= 0.995,
                }"
                :style="dueProgressVars(item)"
                role="button"
                tabindex="0"
                @click="selectItem(item)"
                @keydown="onRowKeydown(item, $event)"
                @mousemove="onRowPointerMove(item, $event)"
                @mouseleave="onRowPointerLeave"
                @contextmenu.prevent="onRowContextMenu(item, $event)"
              >
                <button
                  type="button"
                  class="check-btn"
                  :disabled="busyIds.has(item.id)"
                  :title="t('todoPanel.complete')"
                  @click="handleComplete(item, $event)"
                >
                  <Check :size="12" :stroke-width="2.5" />
                </button>
                <div class="todo-row-main">
                  <span class="todo-item-title" :data-attention="attentionLevel(item)">{{ item.title }}</span>
                  <span v-if="priorityLabel(item.priority)" class="meta-chip priority" :data-p="item.priority">
                    {{ priorityLabel(item.priority) }}
                  </span>
                  <span v-if="item.dueDate" class="meta-chip due-overdue">{{ formatDueShort(item.dueDate) }}</span>
                  <span class="meta-time">{{ formatRelative(item.createdAt) }}</span>
                </div>
                <div class="todo-actions" @click.stop>
                  <button type="button" class="action-btn danger" :title="t('todoPanel.delete')" @click="handleDelete(item, $event)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="showActiveSections && dueSoonItems.length" class="todo-section">
            <div class="section-header">
              <span class="section-title due-soon">{{ t('todoPanel.sectionDueSoon') }}</span>
              <span class="section-count due-soon">{{ dueSoonItems.length }}</span>
            </div>
            <ul class="todo-list">
              <li
                v-for="item in dueSoonItems"
                :key="item.id"
                class="todo-row due-soon"
                :class="{
                  selected: selectedId === item.id,
                  busy: busyIds.has(item.id),
                  'has-due-progress': dueProgressRatio(item) != null,
                  'full-due-progress': (dueProgressRatio(item) ?? 0) >= 0.995,
                }"
                :style="dueProgressVars(item)"
                role="button"
                tabindex="0"
                @click="selectItem(item)"
                @keydown="onRowKeydown(item, $event)"
                @mousemove="onRowPointerMove(item, $event)"
                @mouseleave="onRowPointerLeave"
                @contextmenu.prevent="onRowContextMenu(item, $event)"
              >
                <button
                  type="button"
                  class="check-btn"
                  :disabled="busyIds.has(item.id)"
                  :title="t('todoPanel.complete')"
                  @click="handleComplete(item, $event)"
                >
                  <Check :size="12" :stroke-width="2.5" />
                </button>
                <div class="todo-row-main">
                  <span class="todo-item-title" :data-attention="attentionLevel(item)">{{ item.title }}</span>
                  <span v-if="priorityLabel(item.priority)" class="meta-chip priority" :data-p="item.priority">
                    {{ priorityLabel(item.priority) }}
                  </span>
                  <span v-if="item.dueDate" class="meta-chip due">{{ formatDueShort(item.dueDate) }}</span>
                  <span class="meta-time">{{ formatRelative(item.createdAt) }}</span>
                </div>
                <div class="todo-actions" @click.stop>
                  <button type="button" class="action-btn danger" :title="t('todoPanel.delete')" @click="handleDelete(item, $event)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="showActiveSections && inProgressItems.length" class="todo-section">
            <div class="section-header">
              <span class="section-title">{{ t('todoPanel.sectionInProgress') }}</span>
              <span class="section-count">{{ inProgressItems.length }}</span>
            </div>
            <ul class="todo-list">
              <li
                v-for="item in inProgressItems"
                :key="item.id"
                class="todo-row"
                :class="{
                  selected: selectedId === item.id,
                  busy: busyIds.has(item.id),
                  'has-due-progress': dueProgressRatio(item) != null,
                  'full-due-progress': (dueProgressRatio(item) ?? 0) >= 0.995,
                }"
                :style="dueProgressVars(item)"
                role="button"
                tabindex="0"
                @click="selectItem(item)"
                @keydown="onRowKeydown(item, $event)"
                @mousemove="onRowPointerMove(item, $event)"
                @mouseleave="onRowPointerLeave"
                @contextmenu.prevent="onRowContextMenu(item, $event)"
              >
                <button
                  type="button"
                  class="check-btn"
                  :disabled="busyIds.has(item.id)"
                  :title="t('todoPanel.complete')"
                  @click="handleComplete(item, $event)"
                >
                  <Check :size="12" :stroke-width="2.5" />
                </button>
                <div class="todo-row-main">
                  <span class="todo-item-title" :data-attention="attentionLevel(item)">{{ item.title }}</span>
                  <span v-if="priorityLabel(item.priority)" class="meta-chip priority" :data-p="item.priority">
                    {{ priorityLabel(item.priority) }}
                  </span>
                  <span v-if="item.dueDate" class="meta-chip">{{ formatDueShort(item.dueDate) }}</span>
                  <span class="meta-time">{{ formatRelative(item.createdAt) }}</span>
                </div>
                <div class="todo-actions" @click.stop>
                  <button type="button" class="action-btn danger" :title="t('todoPanel.delete')" @click="handleDelete(item, $event)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="showActiveSections && pendingItems.length" class="todo-section">
            <div class="section-header">
              <span class="section-title">{{ t('todoPanel.sectionPending') }}</span>
              <span class="section-count">{{ pendingItems.length }}</span>
            </div>
            <ul class="todo-list">
              <li
                v-for="item in pendingItems"
                :key="item.id"
                class="todo-row"
                :class="{
                  selected: selectedId === item.id,
                  busy: busyIds.has(item.id),
                  'has-due-progress': dueProgressRatio(item) != null,
                  'full-due-progress': (dueProgressRatio(item) ?? 0) >= 0.995,
                }"
                :style="dueProgressVars(item)"
                role="button"
                tabindex="0"
                @click="selectItem(item)"
                @keydown="onRowKeydown(item, $event)"
                @mousemove="onRowPointerMove(item, $event)"
                @mouseleave="onRowPointerLeave"
                @contextmenu.prevent="onRowContextMenu(item, $event)"
              >
                <button
                  type="button"
                  class="check-btn"
                  :disabled="busyIds.has(item.id)"
                  :title="t('todoPanel.complete')"
                  @click="handleComplete(item, $event)"
                >
                  <Check :size="12" :stroke-width="2.5" />
                </button>
                <div class="todo-row-main">
                  <span class="todo-item-title" :data-attention="attentionLevel(item)">{{ item.title }}</span>
                  <span v-if="priorityLabel(item.priority)" class="meta-chip priority" :data-p="item.priority">
                    {{ priorityLabel(item.priority) }}
                  </span>
                  <span v-if="item.dueDate" class="meta-chip">{{ formatDueShort(item.dueDate) }}</span>
                  <span class="meta-time">{{ formatRelative(item.createdAt) }}</span>
                </div>
                <div class="todo-actions" @click.stop>
                  <button type="button" class="action-btn danger" :title="t('todoPanel.delete')" @click="handleDelete(item, $event)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>

          <section v-if="showDoneSection && doneItems.length" class="todo-section">
            <div class="section-header">
              <span class="section-title">{{ t('todoPanel.sectionDone') }}</span>
              <span class="section-count">{{ doneItems.length }}</span>
            </div>
            <ul class="todo-list">
              <li
                v-for="item in doneItems"
                :key="item.id"
                class="todo-row done"
                :class="{ selected: selectedId === item.id, busy: busyIds.has(item.id) }"
                role="button"
                tabindex="0"
                @click="selectItem(item)"
                @keydown="onRowKeydown(item, $event)"
                @mousemove="onRowPointerMove(item, $event)"
                @mouseleave="onRowPointerLeave"
                @contextmenu.prevent="onRowContextMenu(item, $event)"
              >
                <button
                  type="button"
                  class="check-btn checked"
                  :disabled="busyIds.has(item.id)"
                  :title="t('todoPanel.reopen')"
                  @click="handleComplete(item, $event)"
                >
                  <Check :size="12" :stroke-width="2.5" />
                </button>
                <div class="todo-row-main">
                  <span class="todo-item-title">{{ item.title }}</span>
                  <span class="meta-chip">{{ statusLabel(item.status) }}</span>
                  <span class="meta-time">{{ formatRelative(item.completedAt || item.updatedAt) }}</span>
                </div>
                <div class="todo-actions" @click.stop>
                  <button type="button" class="action-btn danger" :title="t('todoPanel.delete')" @click="handleDelete(item, $event)">
                    <Trash2 :size="13" />
                  </button>
                </div>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <TodoRowHoverTip
        v-if="hoverTipItem && !hoverTipSuppressed"
        :item="hoverTipItem"
        :remain-label="dueRemainLabel(hoverTipItem)"
        :urgency-label="dueUrgencyLabel(hoverTipItem)"
        :urgency-tier="dueUrgencyTierOf(hoverTipItem)"
        :show-bar-hint="dueProgressRatio(hoverTipItem) != null"
        :cursor-x="hoverTipPos.x"
        :cursor-y="hoverTipPos.y"
      />
    </Teleport>

    <TodoMenu
      v-if="contextMenu"
      :item="contextMenu.item"
      :x="contextMenu.x"
      :y="contextMenu.y"
      @handle="dispatchFromContextMenu('handle')"
      @schedule="(minutes) => dispatchFromContextMenu('schedule', minutes)"
      @open-calendar-settings="openCalendarSettings"
      @close="closeContextMenu"
    />

    <!-- 右侧详情 -->
    <aside v-if="detailOpen && draft && selectedItem" class="todo-detail">
      <div class="detail-top">
        <h2>{{ t('todoPanel.detailTitle') }}</h2>
        <div class="detail-top-actions">
          <span v-if="savingDetail" class="saving-hint">{{ t('todoPanel.saving') }}</span>
          <button type="button" class="icon-close" :title="t('todoPanel.closeDetail')" @click="closeDetail">
            <X :size="16" />
          </button>
        </div>
      </div>

      <div class="detail-body">
        <label class="field">
          <span class="field-label">{{ t('todoPanel.fieldTitle') }}</span>
          <input v-model="draft.title" class="field-input" type="text" />
        </label>

        <label class="field">
          <span class="field-label">{{ t('todoPanel.fieldDescription') }}</span>
          <textarea
            v-model="draft.description"
            class="field-textarea"
            rows="4"
            :placeholder="t('todoPanel.descriptionPlaceholder')"
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('todoPanel.fieldStatus') }}</span>
            <AppSelect
              :model-value="draft.status"
              size="field"
              block
              :options="STATUSES.map(s => ({ value: s, label: statusLabel(s) }))"
              @update:model-value="draft.status = $event as TodoStatus"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('todoPanel.fieldPriority') }}</span>
            <AppSelect
              :model-value="draft.priority && draft.priority !== 'normal' ? draft.priority : ''"
              size="field"
              block
              :options="[
                { value: '', label: t('todoPanel.priority.normal') },
                ...PRIORITIES.filter(x => x !== 'normal').map(p => ({ value: p, label: priorityLabel(p) })),
              ]"
              @update:model-value="draft.priority = $event as TodoPriority | ''"
            />
          </label>
        </div>

        <div class="field">
          <span class="field-label">{{ t('todoPanel.dueDate') }}</span>
          <TodoDatePicker v-model="draft.dueDate" />
        </div>

        <label class="field">
          <span class="field-label">{{ t('todoPanel.fieldTags') }}</span>
          <input
            v-model="draft.tagsText"
            class="field-input"
            type="text"
            :placeholder="t('todoPanel.tagsPlaceholder')"
          />
        </label>

        <section v-if="selectedItem.journal?.length" class="readonly-block">
          <h3>{{ t('todoPanel.journal.title') }}</h3>
          <ul>
            <li v-for="entry in [...selectedItem.journal].reverse()" :key="entry.id">
              <template v-if="entry.kind === 'scheduled'">
                {{ t('todoPanel.journal.scheduled') }} · {{ formatRange(entry.start, entry.end) }}
              </template>
              <template v-else>
                {{ t('todoPanel.journal.progress') }} · {{ entry.note }}
              </template>
            </li>
          </ul>
        </section>

        <section v-if="selectedItem.sources?.length" class="readonly-block">
          <h3>{{ t('todoPanel.sources.title') }}</h3>
          <ul>
            <li v-for="source in selectedItem.sources" :key="source.id">
              {{ sourceKindLabel(source.kind) }} · {{ sourceDisplay(source) }}
            </li>
          </ul>
        </section>

        <dl class="meta-grid">
          <div class="meta-cell">
            <dt>{{ t('todoPanel.fieldCreated') }}</dt>
            <dd>{{ formatAbsolute(selectedItem.createdAt) }}</dd>
          </div>
          <div class="meta-cell">
            <dt>{{ t('todoPanel.fieldUpdated') }}</dt>
            <dd>{{ formatAbsolute(selectedItem.updatedAt) }}</dd>
          </div>
          <div v-if="selectedItem.completedAt" class="meta-cell">
            <dt>{{ t('todoPanel.fieldCompleted') }}</dt>
            <dd>{{ formatAbsolute(selectedItem.completedAt) }}</dd>
          </div>
          <div class="meta-cell mono">
            <dt>ID</dt>
            <dd :title="selectedItem.id">{{ selectedItem.id.slice(0, 8) }}…</dd>
          </div>
        </dl>
      </div>

      <div class="detail-footer">
        <button
          type="button"
          class="footer-btn"
          @click="handleComplete(selectedItem)"
        >
          {{
            selectedItem.status === 'completed' || selectedItem.status === 'cancelled'
              ? t('todoPanel.reopen')
              : t('todoPanel.complete')
          }}
        </button>
        <button type="button" class="footer-btn danger" @click="handleDelete(selectedItem)">
          {{ t('todoPanel.delete') }}
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.todo-panel {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.todo-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.todo-chrome {
  flex-shrink: 0;
  padding: 16px 20px 0;
}

.todo-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}

.todo-mark {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent);
}

.todo-header-text { min-width: 0; }
.todo-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.todo-header h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.count-pill {
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  display: inline-flex;
  align-items: center;
}
.todo-header-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.todo-create { margin-bottom: 10px; }
.create-field {
  display: flex;
  align-items: center;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
}
.create-field:focus-within {
  border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 14%, transparent);
}
.todo-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}
.todo-add-btn {
  width: 36px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-left: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
  color: var(--accent-primary);
  cursor: pointer;
}
.todo-add-btn:hover:not(:disabled) {
  background: var(--accent-primary);
  color: #fff;
}
.todo-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.todo-filters {
  display: flex;
  gap: 2px;
  padding-bottom: 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}
.filter-btn {
  padding: 4px 10px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.filter-btn:hover { color: var(--text-secondary); background: var(--bg-hover, rgba(255,255,255,0.04)); }
.filter-btn.active {
  color: var(--text-primary);
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
}

.todo-scroll {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 10px 20px 24px;
  scrollbar-gutter: stable;
}
.todo-scroll::-webkit-scrollbar { width: 8px; }
.todo-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-muted) 35%, transparent);
  border-radius: 4px;
}

.todo-lists {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.todo-loading,
.todo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 200px;
  color: var(--text-muted);
}
.todo-empty-mark {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: 1px dashed var(--border-color);
}
.todo-empty-title { margin: 0; font-size: 14px; color: var(--text-secondary); }
.todo-empty-hint {
  margin: 0;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}
.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-primary);
  cursor: pointer;
  font-size: inherit;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  padding: 0 2px;
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.section-title.due-soon,
.section-count.due-soon,
.section-title.overdue,
.section-count.overdue { color: var(--brand-alert); }
.section-count {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  /* visible：允许行 hover 提示冒出列表圆角；圆角由首/末行自行裁切 */
  overflow: visible;
}
.todo-row:first-child {
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
}
.todo-row:last-child {
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
}
.todo-row:only-child { border-radius: 8px; }

.todo-row {
  position: relative;
  z-index: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 36px;
  padding: 6px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
  cursor: pointer;
  transition: background 0.1s ease;
  /* 避免按 ESC 等键盘操作后出现系统黄/橙 focus ring；选中态已有左侧 accent 条 */
  outline: none;
  isolation: isolate;
}
.todo-row:focus,
.todo-row:focus-visible {
  outline: none;
}
.todo-row:last-child { border-bottom: none; }
.todo-row:hover {
  z-index: 5;
  background: color-mix(in srgb, var(--text-primary) 3.5%, transparent);
}
.todo-row.selected {
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
}
/* 行内内容压在进度条之上，避免文字/按钮被盖住 */
.todo-row > * {
  position: relative;
  z-index: 1;
}
/* 主内容区占满中间空间 */
.todo-row-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 选中左侧条：画在进度条之上，避免满进度时被盖住 */
.todo-row.selected::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: var(--accent-primary);
  pointer-events: none;
  z-index: 2;
}
/* 绝对剩余时间：右对齐浅填充（14 天封顶满条；颜色见 dueProgressColor）
 * z-index: 0 压在行 background 之上，避免 hover/selected 背景把进度条盖掉。
 * 短条：只圆贴列表外沿的右侧角，左缘保持直角（避免胶囊感）。
 * 满条：才补上左侧外沿圆角，与列表首/末行圆角对齐。 */
.todo-row.has-due-progress::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: auto;
  width: var(--due-progress, 0%);
  background: var(--due-progress-color);
  pointer-events: none;
  z-index: 0;
  border-radius: 0;
}
.todo-row:first-child.has-due-progress::before {
  border-top-right-radius: 8px;
}
.todo-row:first-child.has-due-progress.full-due-progress::before {
  border-top-left-radius: 8px;
}
.todo-row:last-child.has-due-progress::before {
  border-bottom-right-radius: 8px;
}
.todo-row:last-child.has-due-progress.full-due-progress::before {
  border-bottom-left-radius: 8px;
}
.todo-row:only-child.has-due-progress::before {
  border-top-right-radius: 8px;
  border-bottom-right-radius: 8px;
}
.todo-row:only-child.has-due-progress.full-due-progress::before {
  border-radius: 8px;
}
.todo-row.overdue.selected,
.todo-row.has-due-progress.selected {
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
}
.todo-row.busy { opacity: 0.5; pointer-events: none; }
.todo-row.done .todo-item-title {
  text-decoration: line-through;
  color: var(--text-muted);
}

.check-btn {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  border: 1.5px solid color-mix(in srgb, var(--border-color) 70%, var(--text-muted));
  background: transparent;
  color: transparent;
  cursor: pointer;
}
.check-btn:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}
.check-btn.checked {
  /* 已完成：低调灰，避免品牌蓝实心抢眼 */
  border-color: color-mix(in srgb, var(--text-muted) 55%, transparent);
  background: color-mix(in srgb, var(--text-muted) 22%, transparent);
  color: var(--text-muted);
}

.todo-item-title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.3;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 标题色：已逾期/即将到期 alert、高优 warning；走主题变量 */
.todo-item-title[data-attention='critical'] {
  color: var(--brand-alert);
  font-weight: 600;
}
.todo-item-title[data-attention='strong'] {
  color: var(--brand-alert);
  font-weight: 600;
}
.todo-item-title[data-attention='medium'] {
  color: var(--accent-warning);
  font-weight: 550;
}
.todo-item-title[data-attention='mild'] {
  color: color-mix(in srgb, var(--text-primary) 45%, var(--accent-warning));
}
.todo-item-title[data-attention='faint'] {
  color: var(--text-muted);
}
.todo-item-title[data-attention='default'] {
  color: var(--text-primary);
}

.meta-chip {
  flex-shrink: 0;
  height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 550;
  line-height: 18px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
}
/* 即将到期与已逾期：跨主题警戒红；高优：warning */
.meta-chip.due,
.meta-chip.due-overdue {
  color: var(--brand-alert);
  background: color-mix(in srgb, var(--brand-alert) 14%, transparent);
}
.meta-chip.priority[data-p='urgent'] {
  color: var(--brand-alert);
  background: color-mix(in srgb, var(--brand-alert) 14%, transparent);
}
.meta-chip.priority[data-p='high'] {
  color: var(--accent-warning);
  background: color-mix(in srgb, var(--accent-warning) 14%, transparent);
}
.meta-chip.priority[data-p='low'] { color: var(--text-muted); }

.meta-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  min-width: 3.2em;
  text-align: right;
}

.todo-actions {
  display: flex;
  gap: 1px;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s ease;
}
.todo-row:hover .todo-actions,
.todo-row:focus-within .todo-actions,
.todo-row.selected .todo-actions { opacity: 1; }

.action-btn {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.action-btn:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  color: var(--text-secondary);
}
.action-btn.danger:hover {
  background: color-mix(in srgb, var(--brand-alert) 12%, transparent);
  color: var(--brand-alert);
}

/* 详情侧栏 */
.todo-detail {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.detail-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
}
.detail-top h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.detail-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.saving-hint {
  font-size: 11px;
  color: var(--text-muted);
}
.icon-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.icon-close:hover {
  background: color-mix(in srgb, var(--text-primary) 7%, transparent);
  color: var(--text-primary);
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.field-label {
  font-size: 11px;
  font-weight: 550;
  color: var(--text-muted);
}
.field-input,
.field-select,
.field-textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  padding: 7px 9px;
  outline: none;
}
.field-input:focus,
.field-select:focus,
.field-textarea:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color));
}
.field-textarea {
  resize: vertical;
  min-height: 84px;
  line-height: 1.45;
  font-family: inherit;
}

.readonly-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.readonly-block h3 {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}
.readonly-block ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.readonly-block li {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  word-break: break-word;
}

.meta-grid {
  margin: 4px 0 0;
  padding: 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  display: grid;
  gap: 8px;
}
.meta-cell {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 8px;
  font-size: 11px;
}
.meta-cell dt {
  margin: 0;
  color: var(--text-muted);
}
.meta-cell dd {
  margin: 0;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-cell.mono dd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
}

.detail-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 14px 14px;
  border-top: 1px solid var(--border-color);
}
.footer-btn {
  flex: 1;
  min-width: 0;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.footer-btn:hover {
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-color));
}
.footer-btn.danger:hover {
  color: var(--brand-alert);
  border-color: color-mix(in srgb, var(--brand-alert) 35%, var(--border-color));
  background: color-mix(in srgb, var(--brand-alert) 8%, transparent);
}

.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .todo-panel.detail-open {
    position: relative;
  }
  .todo-detail {
    position: absolute;
    inset: 0;
    width: auto;
    z-index: 5;
  }
  .todo-actions { opacity: 1; }
}
</style>
