<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRandomPlaceholder } from '../composables/useRandomPlaceholder'
import { X, Plus, Square, ArrowUp, Check, Mic, MicOff, Loader2, Volume2, ListTree, Pencil, CornerDownLeft, GripVertical, Sparkles } from 'lucide-vue-next'
import { useMentions } from '../composables/useMentions'
import {
  formatSlashInvocation,
  matchSlashCommands,
  parseLeadingSlash,
  primarySlashName,
  resolveExactSlash,
  shouldShowSlashHint,
  type SlashCommandDef
} from '../composables/slash-commands'
import { decorateShortcut, formatAccelerator, resolveComposerChord } from '../utils/shortcut'
import { toast } from '../composables/useToast'
import { useComposerQuoteStore } from '../stores/composer-quote'
import { useConversationSkillsStore } from '../stores/conversation-skills'
import { useConfigStore } from '../stores/config'
import type { ComposerQuoteSnippet } from '../stores/composer-quote'
import type { ParsedDocument } from '../stores/terminal'
import type { ParsingDocument } from '../composables/useDocumentUpload'
import type { ContextCompositionId, ContextCompositionNode } from '@shared/types'
import AttachmentFileIcon from './AttachmentFileIcon.vue'
import HoverTipOverlay from './HoverTipOverlay.vue'
import { useHoverTip, BUTTON_HOVER_TIP_DELAY_MS } from '../composables/useHoverTip'
import { useOutputTokenRate } from '../composables/useOutputTokenRate'

interface ContextStats {
  tokenEstimate: number
  maxTokens: number
  percentage: number
  cacheHitRate?: number
  effectiveModel?: string
  composition?: ContextCompositionNode
  consumedTokens?: number
  consumedPromptTokens?: number
  consumedCompletionTokens?: number
}

interface PendingImage {
  id: string
  name: string
  dataUrl: string
}

interface UploadedDoc {
  filename: string
  fileType: string
  fileSize: number
  filePath?: string
  error?: string
}

const props = defineProps<{
  currentTabId: string
  visible?: boolean
  contextStats: ContextStats
  cacheBarWidth: number
  uploadedDocs: UploadedDoc[]
  parsingDocs: ParsingDocument[]
  pendingImages: PendingImage[]
  isAttaching: boolean
  isAgentRunning: boolean
  isLoading: boolean
  canSendEmpty: boolean
  hasImages: boolean
  isRecording: boolean
  isTranscribing: boolean
  isPushToTalk: boolean
  audioAvailable: boolean
  isSpeechInitializing: boolean
  /** 语音输入功能总开关（快捷键非空即启用）；关闭时隐藏麦克风按钮 */
  voiceInputEnabled: boolean
  formatFileSize: (size?: number) => string
  openImagePreview: (url: string) => void
  removeImage: (id: string) => void
  selectAttachment: () => void
  removeUploadedDoc: (index: number) => void
  clearUploadedDocs: () => void
  handlePaste: (event: ClipboardEvent) => void
  handleRecordClick: () => void
  stopGeneration: () => void
  abortAgent: () => void
  ttsIsSpeaking: boolean
  ttsStop: () => void
  submitMessage: (message: string, options?: { workbenchContext?: import('@shared/types').WorkbenchContext; enqueue?: boolean }) => void | Promise<void>
  submitEmptyMessage: () => void | Promise<void>
  followUpQueue?: { id: string; message: string; editing?: boolean }[]
  isEditingFollowUp?: boolean
  removeFollowUp?: (id: string) => void
  insertFollowUp?: (id: string) => void
  beginEditFollowUp?: (id: string) => void
  cancelEditFollowUp?: () => void
  reorderFollowUp?: (fromIndex: number, toIndex: number) => void
  clearTabError: () => void
  /**
   * 发送时取出的旁路工作台上下文（不上聊天气泡）。
   * 助手工作台用于 Markdown 选区作用域。
   */
  consumeWorkbenchContext?: () => import('@shared/types').WorkbenchContext | undefined
  compactContext?: (hint?: string) => Promise<
    | { ok: true; freedTokens: number }
    | { ok: false; reason: 'running' | 'empty' | 'failed' }
  >
  /** 嵌入欢迎页等非面板场景：去掉顶部分割线，使用独立圆角容器 */
  embedded?: boolean
  /** 文档铺满：同一套输入，换成浮在文档上的薄胶囊 */
  overlay?: boolean
  /** 覆盖默认 placeholder（如欢迎页传入随机值） */
  placeholder?: string
  /** 覆盖默认随机池 i18n 键（默认 ai.inputPlaceholderPools） */
  placeholderPoolsKey?: string
  /** 随机池为空时的 fallback i18n 键 */
  placeholderFallbackKey?: string
}>()

const { t, te } = useI18n()

const COMPOSITION_COLORS: Partial<Record<ContextCompositionId, string>> = {
  // 一级：与分段条共用，彼此区分度高
  system: '#94a3b8',
  tools: '#a78bfa',
  messages: '#f472b6',
  // 二级
  identity: '#64748b',
  rules: '#22c55e',
  skills: '#f59e0b',
  knowledge: '#38bdf8',
  environment: '#818cf8',
  builtin: '#8b5cf6',
  mcp: '#e879f9',
  history: '#d946ef',
  currentUser: '#fb7185',
  images: '#fbbf24',
}

const TOP_LEVEL_IDS: ContextCompositionId[] = ['system', 'tools', 'messages']

/** 组成明细默认收起；普通用户只看用量 + Cache */
const showCompositionDetail = ref(false)

const topLevelComposition = computed(() => {
  const root = props.contextStats.composition
  if (!root?.children?.length) return []
  return root.children.filter(c => TOP_LEVEL_IDS.includes(c.id))
})

const compositionTotalChars = computed(() => {
  const root = props.contextStats.composition
  if (root && root.chars > 0) return root.chars
  return topLevelComposition.value.reduce((s, c) => s + c.chars, 0)
})

function compositionPercent(chars: number): number {
  const total = compositionTotalChars.value
  if (total <= 0) return 0
  return Math.max(0, Math.round((chars / total) * 1000) / 10)
}

/** 固定一位小数，右侧百分比列对齐 */
function formatCompositionPercent(chars: number): string {
  return `${compositionPercent(chars).toFixed(1)}%`
}

function compositionLabel(id: ContextCompositionId): string {
  return t(`ai.contextComposition.${id}`)
}

function compositionColor(id: ContextCompositionId): string {
  return COMPOSITION_COLORS[id] || '#94a3b8'
}

function toggleCompositionDetail() {
  showCompositionDetail.value = !showCompositionDetail.value
  nextTick(() => {
    updateContextTipPosition()
    // 展开后内容变宽，再量一次居中
    requestAnimationFrame(() => updateContextTipPosition())
  })
}

/** Teleport 到 body，避免被 ai-panel / composer 的 overflow 裁切 */
const contextMiniEl = ref<HTMLElement | null>(null)
const contextTipEl = ref<HTMLElement | null>(null)
const showContextTip = ref(false)
const contextTipStyle = ref<Record<string, string>>({})
let tipHideTimer: ReturnType<typeof setTimeout> | null = null
let tipShowTimer: ReturnType<typeof setTimeout> | null = null
/** tip 水平锚点（clientX），随进度条上鼠标移动 */
let tipAnchorX = 0
let tipRepositionBound = false
/** 避免路过进度条就弹出；与系统 title 延迟接近 */
const CONTEXT_TIP_SHOW_DELAY_MS = 450

function clearTipHideTimer() {
  if (tipHideTimer) {
    clearTimeout(tipHideTimer)
    tipHideTimer = null
  }
}

function clearTipShowTimer() {
  if (tipShowTimer) {
    clearTimeout(tipShowTimer)
    tipShowTimer = null
  }
}

function bindTipRepositionListeners() {
  if (tipRepositionBound) return
  tipRepositionBound = true
  window.addEventListener('scroll', updateContextTipPosition, true)
  window.addEventListener('resize', updateContextTipPosition)
}

function unbindTipRepositionListeners() {
  if (!tipRepositionBound) return
  tipRepositionBound = false
  window.removeEventListener('scroll', updateContextTipPosition, true)
  window.removeEventListener('resize', updateContextTipPosition)
}

function updateContextTipPosition() {
  const el = contextMiniEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  const maxW = window.innerWidth - 16
  const gap = 2
  const spaceAbove = rect.top
  const spaceBelow = window.innerHeight - rect.bottom
  // 进度条在输入区顶部、面板底部附近：优先向上展开
  const placeAbove = spaceAbove >= 200 || spaceAbove >= spaceBelow

  // 简洁 / 展开组成：都按内容收缩，避免第一行被裁切；上限夹视口
  let tipWidth: number
  if (contextTipEl.value) {
    const prevWidth = contextTipEl.value.style.width
    contextTipEl.value.style.width = 'max-content'
    tipWidth = Math.min(Math.max(contextTipEl.value.offsetWidth, 120), maxW)
    contextTipEl.value.style.width = prevWidth
  } else if (showCompositionDetail.value) {
    tipWidth = Math.min(360, maxW)
  } else {
    tipWidth = Math.min(360, maxW)
  }

  // 水平跟随鼠标；夹在进度条范围内再夹视口
  const anchorX = tipAnchorX || rect.left + rect.width / 2
  const clampedAnchor = Math.max(rect.left, Math.min(anchorX, rect.right))
  let left = clampedAnchor - tipWidth / 2
  left = Math.max(8, Math.min(left, window.innerWidth - tipWidth - 8))

  const base: Record<string, string> = {
    position: 'fixed',
    left: `${left}px`,
    width: 'max-content',
    maxWidth: `${maxW}px`,
  }

  if (placeAbove) {
    const maxH = Math.max(120, Math.min(spaceAbove - gap - 8, Math.floor(window.innerHeight * 0.65)))
    contextTipStyle.value = {
      ...base,
      bottom: `${window.innerHeight - rect.top + gap}px`,
      top: 'auto',
      maxHeight: `${maxH}px`,
    }
  } else {
    const maxH = Math.max(120, Math.min(spaceBelow - gap - 8, Math.floor(window.innerHeight * 0.65)))
    contextTipStyle.value = {
      ...base,
      top: `${rect.bottom + gap}px`,
      bottom: 'auto',
      maxHeight: `${maxH}px`,
    }
  }
}

function onContextMiniEnter(e: MouseEvent) {
  tipAnchorX = e.clientX
  openContextTip()
}

function onContextMiniMove(e: MouseEvent) {
  // 仅在尚未显示时更新锚点，保证延迟弹出时贴着鼠标；显示后固定不动
  if (showContextTip.value) return
  tipAnchorX = e.clientX
}

function openContextTip() {
  clearTipHideTimer()
  clearTipShowTimer()
  // 弹层已打开时只续命，不重置「查看组成」状态（进度条 ↔ tip 桥接）
  if (showContextTip.value) return
  tipShowTimer = setTimeout(() => {
    tipShowTimer = null
    // 每次新打开回到简洁视图
    showCompositionDetail.value = false
    updateContextTipPosition()
    showContextTip.value = true
    bindTipRepositionListeners()
    nextTick(() => updateContextTipPosition())
  }, CONTEXT_TIP_SHOW_DELAY_MS)
}

function scheduleCloseContextTip() {
  clearTipShowTimer()
  clearTipHideTimer()
  // 进度条与弹层之间有缝隙，稍长延迟便于鼠标移入弹层
  tipHideTimer = setTimeout(() => {
    showContextTip.value = false
    showCompositionDetail.value = false
    unbindTipRepositionListeners()
    tipHideTimer = null
  }, 280)
}

function keepContextTip() {
  clearTipShowTimer()
  clearTipHideTimer()
  showContextTip.value = true
}

onBeforeUnmount(() => {
  clearTipShowTimer()
  clearTipHideTimer()
  unbindTipRepositionListeners()
  skillChipsDrag = null
  skillChipsDragging.value = false
})

const quoteStore = useComposerQuoteStore()
const quoteSnippets = computed(() => quoteStore.getSnippets(props.currentTabId))
const conversationSkills = useConversationSkillsStore()
const configStore = useConfigStore()
const skillChips = computed(() => conversationSkills.getSkills(props.currentTabId))
const justAddedSkillIds = computed(() => conversationSkills.justAddedIds(props.currentTabId))
const showSkillChipRow = computed(
  () => configStore.showConversationSkillChips
)
const hasActiveSkillChips = computed(() => showSkillChipRow.value && skillChips.value.length > 0)
const showInlineSkillPicker = computed(() => showSkillChipRow.value && skillChips.value.length === 0)

function onSkillPicked(skill: { id: string; name: string; description?: string }) {
  void conversationSkills.pin(props.currentTabId, skill)
}

function skillChipInsertStyle(id: string): Record<string, string> | undefined {
  const i = justAddedSkillIds.value.indexOf(id)
  if (i < 0) return undefined
  return { '--skill-insert-delay': `${i * 72}ms` }
}

function skillChipTitle(s: { id: string; name: string; description?: string; unavailable?: boolean }): string {
  if (s.unavailable) return t('ai.conversationSkillUnavailableTip')
  if (!s.id.startsWith('user:')) {
    const key = `skillSettings.builtinSkillDescs.${s.id}`
    if (te(key)) return String(t(key))
  }
  const description = s.description?.trim()
  return description || s.name
}

const { hoverTip: skillChipHoverTip, showTip: showSkillChipTip, hideTip: hideSkillChipTip } = useHoverTip({
  placement: 'top',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS,
  wrap: true
})

function onSkillChipHover(e: MouseEvent, s: { id: string; name: string; description?: string; unavailable?: boolean }) {
  if (skillChipsDragging.value) return
  showSkillChipTip(e, skillChipTitle(s))
}

function removeSkillChip(skillId: string) {
  hideSkillChipTip()
  void conversationSkills.unpin(props.currentTabId, skillId)
}

const skillChipsScrollerEl = ref<HTMLElement | null>(null)
const skillChipsCanScrollLeft = ref(false)
const skillChipsCanScrollRight = ref(false)
const skillChipsDragging = ref(false)
const SKILL_CHIPS_DRAG_THRESHOLD = 4
let skillChipsDrag: { pointerId: number; startX: number; startScroll: number; moved: boolean } | null = null
let suppressSkillChipClick = false

function onSkillChipsScroll() {
  hideSkillChipTip()
  updateSkillChipsOverflow()
}

function updateSkillChipsOverflow() {
  const el = skillChipsScrollerEl.value
  if (!el) {
    skillChipsCanScrollLeft.value = false
    skillChipsCanScrollRight.value = false
    return
  }
  const max = el.scrollWidth - el.clientWidth
  skillChipsCanScrollLeft.value = el.scrollLeft > 1
  skillChipsCanScrollRight.value = max - el.scrollLeft > 1
}

function scrollSkillChipIntoView(skillId: string) {
  const scroller = skillChipsScrollerEl.value
  if (!scroller) return
  const chips = skillChips.value
  const isNewest = chips[chips.length - 1]?.id === skillId
  const maxScroll = scroller.scrollWidth - scroller.clientWidth
  if (isNewest && maxScroll > 1) {
    scroller.scrollTo({ left: maxScroll, behavior: 'smooth' })
    return
  }
  const chip = scroller.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(skillId)}"]`)
  if (!chip) return
  const chipRect = chip.getBoundingClientRect()
  const scrollerRect = scroller.getBoundingClientRect()
  if (chipRect.left < scrollerRect.left + 8) {
    scroller.scrollLeft += chipRect.left - scrollerRect.left - 12
  } else if (chipRect.right > scrollerRect.right - 8) {
    scroller.scrollLeft += chipRect.right - scrollerRect.right + 12
  }
}

function revealNewestSkillChip(skillId: string) {
  scrollSkillChipIntoView(skillId)
  updateSkillChipsOverflow()
}

function onSkillChipsWheel(e: WheelEvent) {
  const el = skillChipsScrollerEl.value
  if (!el) return
  const max = el.scrollWidth - el.clientWidth
  if (max <= 0) return
  const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  if (dx === 0) return
  const next = Math.min(max, Math.max(0, el.scrollLeft + dx))
  if (next === el.scrollLeft) return
  e.preventDefault()
  el.scrollLeft = next
}

function onSkillChipsPointerDown(e: PointerEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.composer-skill-chip-remove')) return
  const el = skillChipsScrollerEl.value
  if (!el || el.scrollWidth <= el.clientWidth) return
  skillChipsDrag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startScroll: el.scrollLeft,
    moved: false
  }
  el.setPointerCapture(e.pointerId)
}

function onSkillChipsPointerMove(e: PointerEvent) {
  if (!skillChipsDrag || skillChipsDrag.pointerId !== e.pointerId) return
  const el = skillChipsScrollerEl.value
  if (!el) return
  const dx = e.clientX - skillChipsDrag.startX
  if (!skillChipsDrag.moved && Math.abs(dx) < SKILL_CHIPS_DRAG_THRESHOLD) return
  skillChipsDrag.moved = true
  skillChipsDragging.value = true
  hideSkillChipTip()
  el.scrollLeft = skillChipsDrag.startScroll - dx
}

function endSkillChipsDrag(e: PointerEvent) {
  if (!skillChipsDrag || skillChipsDrag.pointerId !== e.pointerId) return
  const el = skillChipsScrollerEl.value
  if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
  if (skillChipsDrag.moved) suppressSkillChipClick = true
  skillChipsDrag = null
  skillChipsDragging.value = false
}

function onSkillChipsClickCapture(e: MouseEvent) {
  if (!suppressSkillChipClick) return
  suppressSkillChipClick = false
  e.preventDefault()
  e.stopPropagation()
}

watch(skillChips, async (chips, prev) => {
  const nextIds = new Set(chips.map(s => s.id))
  if (prev?.some(s => !nextIds.has(s.id))) hideSkillChipTip()
  await nextTick()
  updateSkillChipsOverflow()
})

watch(justAddedSkillIds, async (ids) => {
  const skillId = ids[ids.length - 1]
  if (!skillId) return
  await nextTick()
  requestAnimationFrame(() => revealNewestSkillChip(skillId))
  // 推进会改宽度，开口后再补滚一次确保队尾仍可见
  window.setTimeout(() => revealNewestSkillChip(skillId), 220)
})

watch(skillChipsScrollerEl, (el, _prev, onCleanup) => {
  if (!el) return
  const ro = new ResizeObserver(() => updateSkillChipsOverflow())
  ro.observe(el)
  el.addEventListener('wheel', onSkillChipsWheel, { passive: false })
  updateSkillChipsOverflow()
  onCleanup(() => {
    ro.disconnect()
    el.removeEventListener('wheel', onSkillChipsWheel)
  })
})

const { value: randomPlaceholder, pick: pickRandomPlaceholder } = useRandomPlaceholder(
  () => props.placeholderPoolsKey ?? 'ai.inputPlaceholderPools',
  () => props.placeholderFallbackKey ?? 'ai.inputPlaceholderAgent'
)

const sendShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.sendMessage))
const queueShortcut = computed(() => formatAccelerator(configStore.keyboardShortcuts.queueFollowUp))

const followUpItems = computed(() => props.followUpQueue ?? [])
const isEditingFollowUp = computed(() => !!props.isEditingFollowUp)

function composerChord(event: KeyboardEvent): 'queue' | 'send' | null {
  return resolveComposerChord(
    event,
    configStore.keyboardShortcuts.sendMessage,
    configStore.keyboardShortcuts.queueFollowUp,
  )
}

const sendButtonTitle = computed(() => {
  if (isEditingFollowUp.value) {
    return t('ai.followUpEditSave', { shortcut: decorateShortcut(sendShortcut.value, t('ai.hintExecute')) })
  }
  if (props.isAgentRunning) {
    return t('ai.sendSupplementWithQueue', {
      send: decorateShortcut(sendShortcut.value, t('ai.hintExecute')),
      queue: decorateShortcut(queueShortcut.value, t('ai.hintQueueTask')),
    })
  }
  return t('ai.executeTask', { shortcut: decorateShortcut(sendShortcut.value, t('ai.hintExecute')) })
})

const composerPlaceholder = computed(
  () =>
    props.placeholder ??
    (isEditingFollowUp.value
      ? t('ai.inputPlaceholderEditFollowUp', { shortcut: decorateShortcut(sendShortcut.value, t('ai.hintEditSave')) })
      : props.isAgentRunning
        ? t('ai.inputPlaceholderSupplement', {
            send: decorateShortcut(sendShortcut.value, t('ai.hintParen')),
            queue: decorateShortcut(queueShortcut.value, t('ai.hintQueueShort')),
          })
        : randomPlaceholder.value || t(props.placeholderFallbackKey ?? 'ai.inputPlaceholderAgent'))
)

const followUpDragIndex = ref<number | null>(null)
const followUpDragOverIndex = ref<number | null>(null)

const handleFollowUpDragStart = (index: number, event: DragEvent) => {
  followUpDragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

const handleFollowUpDragOver = (index: number, event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  followUpDragOverIndex.value = index
}

const handleFollowUpDrop = (toIndex: number, event: DragEvent) => {
  event.preventDefault()
  const fromIndex = followUpDragIndex.value
  followUpDragIndex.value = null
  followUpDragOverIndex.value = null
  if (fromIndex == null || fromIndex === toIndex) return
  props.reorderFollowUp?.(fromIndex, toIndex)
}

const handleFollowUpDragEnd = () => {
  followUpDragIndex.value = null
  followUpDragOverIndex.value = null
}

const handleFollowUpQueueDragLeave = (event: DragEvent) => {
  const root = event.currentTarget as HTMLElement | null
  const related = event.relatedTarget as Node | null
  if (root && related && root.contains(related)) return
  followUpDragOverIndex.value = null
}

const handleCancelEditClick = () => {
  props.cancelEditFollowUp?.()
  inputText.value = ''
  void pickRandomPlaceholder()
  syncTextareaSize()
}

/** 小文件瞬间解析完时不闪进度；超过此时长才露出解析中的小条 */
const PARSE_CHIP_REVEAL_MS = 200
const parsingChipsVisible = ref(false)
let parsingRevealTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => props.parsingDocs.length,
  (count) => {
    if (count === 0) {
      if (parsingRevealTimer) {
        clearTimeout(parsingRevealTimer)
        parsingRevealTimer = null
      }
      parsingChipsVisible.value = false
      return
    }
    if (parsingChipsVisible.value || parsingRevealTimer) return
    parsingRevealTimer = setTimeout(() => {
      parsingRevealTimer = null
      parsingChipsVisible.value = props.parsingDocs.length > 0
    }, PARSE_CHIP_REVEAL_MS)
  },
  { immediate: true }
)

const getParsePhaseLabel = (doc: ParsingDocument) => {
  if (doc.error) return doc.error
  if (doc.current !== undefined && doc.total !== undefined && doc.total > 0) {
    return `${t(`ai.documentParsePhase.${doc.phase}`)} ${doc.current}/${doc.total}`
  }
  return doc.message || t(`ai.documentParsePhase.${doc.phase}`)
}

const parseProgressLabel = (doc: ParsingDocument) => {
  if (doc.status === 'failed') return t('ai.documentParsePhase.failed')
  if (doc.current !== undefined && doc.total !== undefined && doc.total > 0) {
    return `${doc.current}/${doc.total}`
  }
  return t('ai.parsingInProgress')
}

const isSameAttachment = (a: { filename: string; fileSize: number }, b: { filename: string; fileSize: number }) =>
  a.filename === b.filename && a.fileSize === b.fileSize

/** 已进附件排的解析中文件；解析完立刻让位给正式小条，避免叠两条 */
const activeParsingDocs = computed(() => {
  if (!parsingChipsVisible.value) return []
  return props.parsingDocs.filter(doc =>
    !props.uploadedDocs.some(uploaded => isSameAttachment(uploaded, doc))
  )
})

/** embedded 模式：有附件时才显示外层统一容器，避免空态双层边框 */
const hasComposerAttachments = computed(
  () =>
    activeParsingDocs.value.length > 0 ||
    props.uploadedDocs.length > 0 ||
    quoteSnippets.value.length > 0 ||
    props.pendingImages.length > 0 ||
    followUpItems.value.length > 0
)

let textareaResizeObserver: ResizeObserver | null = null
/** 防止 measure 改高度 → wrap ResizeObserver → 再 measure 的重入 */
let measuringTextareaHeight = false

const setupTextareaResizeObserver = () => {
  textareaResizeObserver?.disconnect()
  const target = textareaWrapEl.value
  if (!target) return

  textareaResizeObserver = new ResizeObserver(() => {
    // 宽度变化（分栏/窗口）才需要重测；自身改高度触发的回调由 measuring 守卫跳过
    if (measuringTextareaHeight) return
    measureTextareaHeight()
  })
  textareaResizeObserver.observe(target)
}

onMounted(() => {
  conversationSkills.startListening()
  void conversationSkills.sync(props.currentTabId)
  syncTextareaSize()
  nextTick(setupTextareaResizeObserver)
})

watch(
  () => props.currentTabId,
  (tabId) => {
    hideSkillChipTip()
    void conversationSkills.sync(tabId)
  }
)

watch(
  () => configStore.showConversationSkillChips,
  (visible) => {
    if (!visible) {
      hideSkillChipTip()
      skillChipsDrag = null
      skillChipsDragging.value = false
    }
  }
)

onBeforeUnmount(() => {
  textareaResizeObserver?.disconnect()
  textareaResizeObserver = null
  if (parsingRevealTimer) {
    clearTimeout(parsingRevealTimer)
    parsingRevealTimer = null
  }
})

/** 输入框无文字时，有图片、已上传文件或引用摘录也可发送 */
const canSubmitMessage = computed(
  () =>
    !!inputText.value.trim() ||
    props.hasImages ||
    props.uploadedDocs.length > 0 ||
    quoteSnippets.value.length > 0
)

function removeQuoteSnippet(id: string) {
  quoteStore.removeSnippet(props.currentTabId, id)
}

function snippetChipSummary(s: ComposerQuoteSnippet): string {
  const count = [...s.excerpt].length
  if (s.quoteOrigin === 'terminal') {
    return t('ai.quoteSnippetChipTerminal', { label: s.label, count })
  }
  if (s.sourceLinesAccurate && s.startLine != null && s.endLine != null) {
    return t('ai.quoteSnippetChipRange', {
      label: s.label,
      start: s.startLine,
      end: s.endLine,
      count
    })
  }
  return t('ai.quoteSnippetChipPreview', { label: s.label, count })
}

/** 发送时附加给模型：带行号的完整摘录（显式引用胶囊；选区作用域已改走 workbenchContext） */
function formatQuotesAppendix(snippets: ComposerQuoteSnippet[]): string {
  if (snippets.length === 0) return ''
  const blocks: string[] = [t('ai.quoteSnippetAppendixIntro')]
  snippets.forEach((s, i) => {
    const n = i + 1
    const range =
      s.quoteOrigin === 'terminal'
        ? t('ai.quoteSnippetRangeTerminal')
        : s.sourceLinesAccurate && s.startLine != null && s.endLine != null
          ? t('ai.quoteSnippetRangeFileLines', { start: s.startLine, end: s.endLine })
          : t('ai.quoteSnippetRelativeLinesNote')
    blocks.push(`### ${t('ai.quoteSnippetAppendixHeading', { n, label: s.label, range })}`)
    if (s.sourcePath) {
      blocks.push(`${t('ai.quoteSnippetAppendixPath')}: ${s.sourcePath}`)
    }
    if (s.quoteOrigin === 'terminal') {
      blocks.push(t('ai.quoteSnippetAppendixTerminalDisclaimer'))
    } else if (!s.sourceLinesAccurate) {
      blocks.push(t('ai.quoteSnippetAppendixPreviewDisclaimer'))
    }
    blocks.push('')
    const lines = s.excerpt.split('\n')
    lines.forEach((line, idx) => {
      const num =
        s.sourceLinesAccurate && s.startLine != null ? s.startLine + idx : idx + 1
      blocks.push(`${String(num).padStart(5, ' ')} | ${line}`)
    })
  })
  return blocks.join('\n')
}

const inputText = ref('')
const isComposing = ref(false)
const mentionInputEl = ref<HTMLTextAreaElement | null>(null)
const textareaWrapEl = ref<HTMLDivElement | null>(null)
const mentionListEl = ref<HTMLDivElement | null>(null)
const mentionMenuEl = ref<HTMLDivElement | null>(null)
const skillMenuSearchEl = ref<HTMLInputElement | null>(null)
const currentTabIdRef = computed(() => props.currentTabId)
const uploadedDocsRef = computed(() => props.uploadedDocs as ParsedDocument[])

const {
  showMenu: showMentionMenu,
  menuType: mentionMenuType,
  suggestions: mentionSuggestions,
  selectedIndex: mentionSelectedIndex,
  isLoading: isMentionLoading,
  hasMore: mentionHasMore,
  totalCount: mentionTotalCount,
  currentDir: mentionCurrentDir,
  detectTrigger,
  openSkillMenu,
  skillMenuStandalone,
  searchQuery: mentionSearchQuery,
  setSkillSearch,
  selectSuggestion: doSelectSuggestion,
  clearMentions,
  closeMenu: closeMentionMenu,
  goBack: mentionGoBack,
  handleKeyDown: handleMentionKeyDown,
  expandMentions
} = useMentions(inputText, currentTabIdRef, uploadedDocsRef, onSkillPicked)

const slashMirrorEl = ref<HTMLDivElement | null>(null)
const slashSelectedIndex = ref(0)
const isCompacting = ref(false)

const parsedSlash = computed(() => parseLeadingSlash(inputText.value.trimStart()))
const slashMatches = computed(() => {
  if (showMentionMenu.value || !parsedSlash.value) return []
  return matchSlashCommands(parsedSlash.value.name)
})
const slashHintVisible = computed(() => {
  if (showMentionMenu.value) return false
  return shouldShowSlashHint(inputText.value)
})
const slashHighlight = computed(() => {
  if (!parsedSlash.value || slashMatches.value.length === 0) return null
  const leading = inputText.value.match(/^\s*/)?.[0] ?? ''
  return {
    token: `${leading}${parsedSlash.value.raw}`,
    rest: inputText.value.slice(leading.length + parsedSlash.value.raw.length)
  }
})

watch(slashMatches, (matches) => {
  if (slashSelectedIndex.value >= matches.length) slashSelectedIndex.value = 0
})

const syncSlashMirror = () => {
  const ta = mentionInputEl.value
  const mirror = slashMirrorEl.value
  if (!ta || !mirror) return
  mirror.scrollTop = ta.scrollTop
}

const completeSlash = (def: SlashCommandDef) => {
  const leading = inputText.value.match(/^\s*/)?.[0] ?? ''
  const rest = parsedSlash.value?.rest ?? ''
  inputText.value = rest ? `${leading}/${primarySlashName(def)} ${rest}` : `${leading}/${primarySlashName(def)} `
  nextTick(() => {
    focusInput()
    measureTextareaHeight()
    syncSlashMirror()
  })
}

const applySlashResult = (result: { ok: true; freedTokens: number } | { ok: false; reason: string }) => {
  if (result.ok) return
  if (result.reason === 'running') toast.warning(t('ai.slashCompactRunning', { shortcut: queueShortcut.value }))
  else if (result.reason === 'failed') toast.error(t('ai.slashCompactFailed'))
  else toast.info(t('ai.slashCompactEmpty'))
}

const runSlashCommand = async (def: SlashCommandDef, hint?: string) => {
  if (def.id !== 'compact') return
  if (isCompacting.value) return
  inputText.value = ''
  void pickRandomPlaceholder()
  if (!props.compactContext) {
    applySlashResult({ ok: false, reason: 'empty' })
    return
  }
  isCompacting.value = true
  nextTick(() => focusInput())
  try {
    applySlashResult(await props.compactContext(hint))
  } catch {
    applySlashResult({ ok: false, reason: 'failed' })
  } finally {
    isCompacting.value = false
  }
}

const focusInput = () => {
  mentionInputEl.value?.focus()
}

const inputContainerEl = ref<HTMLElement | null>(null)
const mentionMenuStyle = ref<Record<string, string>>({ visibility: 'hidden' })
const mentionMenuBelow = ref(false)
const mentionListCanScrollUp = ref(false)
const mentionListCanScrollDown = ref(false)
let mentionMenuRepositionBound = false

const MENTION_MENU_GAP = 8
const MENTION_MENU_MAX_H = 320

function updateMentionListOverflow() {
  const el = mentionListEl.value
  if (!el) {
    mentionListCanScrollUp.value = false
    mentionListCanScrollDown.value = false
    return
  }
  mentionListCanScrollUp.value = el.scrollTop > 1
  mentionListCanScrollDown.value = el.scrollHeight - el.scrollTop - el.clientHeight > 1
}

function updateMentionMenuPosition() {
  const anchor = inputContainerEl.value
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const spaceAbove = rect.top - MENTION_MENU_GAP
  const spaceBelow = window.innerHeight - rect.bottom - MENTION_MENU_GAP
  const placeBelow = spaceBelow > spaceAbove
  mentionMenuBelow.value = placeBelow
  const available = placeBelow ? spaceBelow : spaceAbove
  const maxH = Math.max(80, Math.min(MENTION_MENU_MAX_H, available))
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 16))
  const width = Math.min(rect.width, window.innerWidth - left - 8)
  mentionMenuStyle.value = placeBelow
    ? {
        position: 'fixed',
        top: `${rect.bottom + MENTION_MENU_GAP}px`,
        bottom: 'auto',
        left: `${left}px`,
        width: `${width}px`,
        maxHeight: `${maxH}px`,
        visibility: 'visible'
      }
    : {
        position: 'fixed',
        top: 'auto',
        bottom: `${window.innerHeight - rect.top + MENTION_MENU_GAP}px`,
        left: `${left}px`,
        width: `${width}px`,
        maxHeight: `${maxH}px`,
        visibility: 'visible'
      }
  nextTick(updateMentionListOverflow)
}

function bindMentionMenuReposition() {
  if (mentionMenuRepositionBound) return
  mentionMenuRepositionBound = true
  window.addEventListener('scroll', updateMentionMenuPosition, true)
  window.addEventListener('resize', updateMentionMenuPosition)
}

function unbindMentionMenuReposition() {
  if (!mentionMenuRepositionBound) return
  mentionMenuRepositionBound = false
  window.removeEventListener('scroll', updateMentionMenuPosition, true)
  window.removeEventListener('resize', updateMentionMenuPosition)
}

function openSkillPicker() {
  openSkillMenu()
}

function onComposerSurfaceMouseDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (!target) return
  if (target.closest('button, textarea, input, a, .composer-skill-chip')) return
  focusInput()
}

function closeMentionMenuAndFocusInput() {
  closeMentionMenu()
  nextTick(() => focusInput())
}

function onStandaloneSkillSearch(event: Event) {
  setSkillSearch((event.target as HTMLInputElement).value)
}

function handleSkillSearchKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMentionMenuAndFocusInput()
    return
  }
  handleMentionKeyDown(event)
}

/** 两行 grid 布局下测量高度。
 *
 * 增高可直接用 scrollHeight 扩。变矮则必须先 height=0 再量——textarea 偏高时
 * scrollHeight 常等于 clientHeight，单靠 `scrollHeight < current` 永远测不出「该缩」。
 * 11.2.2 防抖动优化只在确认变矮时塌缩，导致偶发撑满后缩不回去。
 *
 * 塌缩重测时先锁住 wrap 当前高度，避免 composer 瞬间变矮带动上方消息列表抖动。
 */
const measureTextareaHeight = () => {
  const textarea = mentionInputEl.value
  if (!textarea || measuringTextareaHeight) return

  measuringTextareaHeight = true
  const wrap = textareaWrapEl.value
  let frozeWrap = false
  try {
    // 读 CSS max-height：欢迎页会压得更矮，硬编码 360 会提前锁 overflow:hidden
    const computedMax = parseFloat(getComputedStyle(textarea).maxHeight)
    const maxH = Number.isFinite(computedMax) && computedMax > 0 ? computedMax : 360
    const minH = 20
    textarea.style.overflow = 'hidden'

    const current = textarea.offsetHeight

    // 内容明确撑破 → 直接扩，不经 0（无抖动）
    if (textarea.scrollHeight > current + 1) {
      const nextHeight = Math.min(Math.max(textarea.scrollHeight, minH), maxH)
      if (current !== nextHeight) {
        textarea.style.height = `${nextHeight}px`
      }
      textarea.style.overflow = nextHeight >= maxH ? 'auto' : 'hidden'
      return
    }

    // 同行敲字 / 疑似变矮 / 已卡住偏高：必须塌缩重测才能得到内容真实高度。
    // wrap 锁高期间消息区 flex 看不到瞬时塌缩。
    if (wrap) {
      wrap.style.height = `${wrap.offsetHeight}px`
      frozeWrap = true
    }
    textarea.style.height = '0px'
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minH), maxH)
    textarea.style.height = `${nextHeight}px`
    textarea.style.overflow = nextHeight >= maxH ? 'auto' : 'hidden'
  } finally {
    if (frozeWrap && wrap) {
      wrap.style.height = ''
    }
    measuringTextareaHeight = false
  }
}

const syncTextareaSize = () => {
  nextTick(measureTextareaHeight)
}

const appendText = (text: string) => {
  if (!text.trim()) return
  inputText.value = inputText.value
    ? `${inputText.value} ${text}`.trim()
    : text
  syncTextareaSize()
  nextTick(focusInput)
}

const setText = (text: string) => {
  inputText.value = text
  syncTextareaSize()
  nextTick(focusInput)
}

const clearText = () => {
  inputText.value = ''
  syncTextareaSize()
}

// 一次性脉冲提示：让用户从场景卡片填入 prompt 后，注意到输入框已就绪。
// 用户从欢迎区点击场景卡片 → setText 把 prompt 填进来 → flashHint 触发蓝色
// outline 脉冲 ~1.5s 引导用户「这就是输入框，按 Enter 就发送」。
const isFlashHint = ref(false)
let flashHintTimer: ReturnType<typeof setTimeout> | null = null

const flashHint = () => {
  if (flashHintTimer) {
    clearTimeout(flashHintTimer)
    flashHintTimer = null
  }
  // 先关再开，确保 CSS 动画从头重放（连续点击场景卡片时也能每次脉冲）
  isFlashHint.value = false
  nextTick(() => {
    isFlashHint.value = true
    flashHintTimer = setTimeout(() => {
      isFlashHint.value = false
      flashHintTimer = null
    }, 1500)
  })
}

watch(() => props.visible, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      focusInput()
      measureTextareaHeight()
    })
  }
}, { immediate: true })

watch(
  () => quoteSnippets.value.length,
  (len, prevLen) => {
    if (len > (prevLen ?? 0)) {
      nextTick(() => {
        focusInput()
        measureTextareaHeight()
      })
    }
  }
)

watch(inputText, () => {
  syncTextareaSize()
})

watch(mentionSelectedIndex, (newIndex) => {
  nextTick(() => {
    if (!mentionListEl.value) return
    const items = mentionListEl.value.querySelectorAll('.mention-item')
    const selectedItem = items[newIndex] as HTMLElement | undefined
    selectedItem?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    updateMentionListOverflow()
  })
})

watch(showMentionMenu, async (open) => {
  if (!open) {
    unbindMentionMenuReposition()
    mentionListCanScrollUp.value = false
    mentionListCanScrollDown.value = false
    mentionMenuStyle.value = { visibility: 'hidden' }
    return
  }
  await nextTick()
  updateMentionMenuPosition()
  bindMentionMenuReposition()
  if (skillMenuStandalone.value) {
    await nextTick()
    skillMenuSearchEl.value?.focus()
  }
})

watch(
  [mentionSuggestions, mentionMenuType, isMentionLoading],
  () => {
    if (!showMentionMenu.value) return
    nextTick(() => {
      updateMentionMenuPosition()
      updateMentionListOverflow()
    })
  }
)

onBeforeUnmount(unbindMentionMenuReposition)

const setMentionSelectedIndex = (index: number) => {
  mentionSelectedIndex.value = index
}

const handleInputChange = (event: Event) => {
  const textarea = event.target as HTMLTextAreaElement
  const cursorPos = textarea.selectionStart || 0
  if (!parseLeadingSlash(textarea.value.trimStart())) {
    detectTrigger(textarea.value, cursorPos)
  }
  measureTextareaHeight()
  syncSlashMirror()
}

const handleInputBlur = () => {
  setTimeout(() => {
    const active = document.activeElement
    if (mentionMenuEl.value?.contains(active)) return
    closeMentionMenu()
  }, 150)
}

const selectSuggestion = (suggestion: typeof mentionSuggestions.value[0]) => {
  doSelectSuggestion(suggestion)
  nextTick(() => {
    focusInput()
    measureTextareaHeight()
  })
}

const handleInputKeyDown = (event: KeyboardEvent) => {
  if (slashHintVisible.value && !showMentionMenu.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      slashSelectedIndex.value = Math.min(slashMatches.value.length - 1, slashSelectedIndex.value + 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      slashSelectedIndex.value = Math.max(0, slashSelectedIndex.value - 1)
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const selected = slashMatches.value[slashSelectedIndex.value]
      if (selected) completeSlash(selected)
      return
    }
    if (!isComposing.value && composerChord(event) === 'queue') {
      event.preventDefault()
      void handleSend({ enqueue: props.isAgentRunning && !isEditingFollowUp.value })
      return
    }
    if (!isComposing.value && composerChord(event) === 'send') {
      event.preventDefault()
      const selected = slashMatches.value[slashSelectedIndex.value]
      if (!selected) return
      if (resolveExactSlash(inputText.value.trim())) {
        void handleSend()
        return
      }
      completeSlash(selected)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !isComposing.value) {
      event.preventDefault()
      const selected = slashMatches.value[slashSelectedIndex.value]
      if (selected) completeSlash(selected)
      return
    }
  }

  if (showMentionMenu.value) {
    if (event.key === 'Escape' && skillMenuStandalone.value) {
      event.preventDefault()
      closeMentionMenuAndFocusInput()
      return
    }
    const handled = handleMentionKeyDown(event)
    if (handled) return
  }

  if (event.key === 'Escape' && isEditingFollowUp.value) {
    event.preventDefault()
    handleCancelEditClick()
    return
  }

  if (isComposing.value) return

  // 编辑排队消息：发送和排队都是保存回原位
  if (isEditingFollowUp.value) {
    if (composerChord(event)) {
      event.preventDefault()
      void handleSend()
    }
    return
  }

  const chord = composerChord(event)
  if (chord === 'queue') {
    event.preventDefault()
    void handleSend({ enqueue: props.isAgentRunning })
    return
  }

  if (chord === 'send') {
    event.preventDefault()
    void handleSend()
  }
}

const handleSend = async (opts?: { enqueue?: boolean }) => {
  if (isComposing.value) return
  // 压缩是一轮活，输入框不能锁死。压缩接不了补充，发出去的先排上，压完再走。
  if (isCompacting.value) opts = { enqueue: true }
  if (props.isAttaching) {
    toast.warning(t('ai.parsingPleaseWait'))
    return
  }
  closeMentionMenu()

  const rawInput = inputText.value.trim()
  const exactSlash = !isEditingFollowUp.value ? resolveExactSlash(rawInput) : null
  if (exactSlash) {
    const commandText = formatSlashInvocation(exactSlash.def, exactSlash.hint)
    if (opts?.enqueue) {
      inputText.value = ''
      void pickRandomPlaceholder()
      props.clearTabError()
      await props.submitMessage(commandText, { enqueue: true })
      return
    }
    if (props.isAgentRunning) {
      toast.warning(t('ai.slashCompactRunning', { shortcut: queueShortcut.value }))
      return
    }
    await runSlashCommand(exactSlash.def, exactSlash.hint)
    return
  }
  if (!isEditingFollowUp.value && slashHintVisible.value) {
    const selected = slashMatches.value[slashSelectedIndex.value]
    if (selected) {
      completeSlash(selected)
      return
    }
  }

  const quotesSnapshot = [...quoteStore.getSnippets(props.currentTabId)]
  // 编辑排队不吃选区作用域——保存时沿用入队快照
  const workbenchContext = isEditingFollowUp.value
    ? undefined
    : props.consumeWorkbenchContext?.()
  const hasSelectionScope = Boolean(workbenchContext?.selectionScope?.excerpt?.trim())
  const hasDocs = props.uploadedDocs.length > 0
  const hasComposerPayload =
    !!inputText.value.trim() ||
    props.hasImages ||
    hasDocs ||
    quotesSnapshot.length > 0 ||
    hasSelectionScope

  if (
    !opts?.enqueue &&
    !isEditingFollowUp.value &&
    !hasComposerPayload &&
    props.canSendEmpty &&
    props.isAgentRunning
  ) {
    props.clearTabError()
    await props.submitEmptyMessage()
    return
  }

  if (!isEditingFollowUp.value && !hasComposerPayload) {
    return
  }

  // 编辑排队且内容清空：仍提交，由上层从队列删掉
  if (
    isEditingFollowUp.value &&
    !inputText.value.trim() &&
    !props.hasImages &&
    !hasDocs &&
    quotesSnapshot.length === 0 &&
    !hasSelectionScope
  ) {
    inputText.value = ''
    void pickRandomPlaceholder()
    props.clearTabError()
    quoteStore.clearSnippets(props.currentTabId)
    await props.submitMessage('', {})
    return
  }

  inputText.value = ''
  void pickRandomPlaceholder()
  props.clearTabError()

  await new Promise(resolve => setTimeout(resolve, 0))

  const { contextParts } = await expandMentions(rawInput)
  let mergedUser =
    contextParts.length > 0 ? `${rawInput}\n\n${contextParts.join('\n\n')}` : rawInput

  // 仅有选区作用域、用户未打字：气泡用短提示；摘录正文走 workbenchContext
  if (!mergedUser.trim() && hasSelectionScope && quotesSnapshot.length === 0) {
    mergedUser = t('ai.selectionScopeOnlyPrompt')
  } else if (!mergedUser.trim() && quotesSnapshot.length > 0) {
    mergedUser = t('ai.quoteOnlyPrompt')
  } else if (!mergedUser.trim() && hasDocs) {
    mergedUser = t('ai.docsOnlyPrompt')
  }

  // 显式引用胶囊仍附正文（终端等）；选区作用域不再拼进可见字符串
  const appendix = formatQuotesAppendix(quotesSnapshot)
  const finalMessage = appendix ? `${mergedUser}\n\n${appendix}` : mergedUser

  clearMentions()
  quoteStore.clearSnippets(props.currentTabId)

  await new Promise(resolve => setTimeout(resolve, 0))
  await props.submitMessage(finalMessage, {
    ...(workbenchContext ? { workbenchContext } : {}),
    ...(opts?.enqueue ? { enqueue: true } : {})
  })
}

const slots = useSlots()
const isTwoRow = computed(() => !props.overlay && !!slots['footer-left'])

function formatLiveTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.?0+$/, '')}k`
  return n.toLocaleString()
}

const displayedConsumed = ref(0)
let consumedAnimRaf = 0

watch(
  () => props.contextStats.consumedTokens ?? 0,
  (target) => {
    const start = displayedConsumed.value
    if (target <= start) {
      cancelAnimationFrame(consumedAnimRaf)
      displayedConsumed.value = target
      return
    }
    const delta = target - start
    const dur = Math.min(400, Math.max(120, delta * 0.35))
    const t0 = performance.now()
    cancelAnimationFrame(consumedAnimRaf)
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur)
      const eased = 1 - (1 - p) ** 2
      displayedConsumed.value = Math.round(start + delta * eased)
      if (p < 1) consumedAnimRaf = requestAnimationFrame(tick)
    }
    consumedAnimRaf = requestAnimationFrame(tick)
  },
  { immediate: true }
)

onBeforeUnmount(() => cancelAnimationFrame(consumedAnimRaf))

const consumedTokenLabel = computed(() => {
  if (!configStore.showSessionTokenUsage) return ''
  if (displayedConsumed.value <= 0) return ''
  return formatLiveTokens(displayedConsumed.value)
})

const { rateKind: outputRateKind, rateText: outputRateText } = useOutputTokenRate(
  () => props.contextStats.consumedCompletionTokens ?? 0,
  () => props.isAgentRunning,
  () => props.currentTabId,
)

const consumedTokenTitle = computed(() => {
  const stats = props.contextStats
  if (!stats.consumedTokens || stats.consumedTokens <= 0) return ''
  const prompt = (stats.consumedPromptTokens ?? 0).toLocaleString()
  const completion = (stats.consumedCompletionTokens ?? 0).toLocaleString()
  if (outputRateText.value && outputRateKind.value === 'avg') {
    return t('ai.sessionConsumedTitleWithAvgRate', { prompt, completion, rate: outputRateText.value })
  }
  if (outputRateText.value) {
    return t('ai.sessionConsumedTitleWithRate', { prompt, completion, rate: outputRateText.value })
  }
  return t('ai.sessionConsumedTitle', { prompt, completion })
})

const { hoverTip: consumedHoverTip, showTip: showConsumedTip, hideTip: hideConsumedTip } = useHoverTip({
  placement: 'top',
  delayMs: 200,
})

watch(consumedTokenTitle, (text) => {
  if (consumedHoverTip.value && text) {
    consumedHoverTip.value = { ...consumedHoverTip.value, text }
  }
})

/** 面板快捷指令当场发送：不改输入框里已有的字，选区仍走 consumeWorkbenchContext */
const submitPrepared = async (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return
  if (props.isAttaching) {
    toast.warning(t('ai.parsingPleaseWait'))
    return
  }
  closeMentionMenu()
  const workbenchContext = isEditingFollowUp.value
    ? undefined
    : props.consumeWorkbenchContext?.()
  await props.submitMessage(trimmed, {
    ...(workbenchContext ? { workbenchContext } : {}),
    ...(props.isAgentRunning && !isEditingFollowUp.value ? { enqueue: true } : {})
  })
}

defineExpose({
  focusInput,
  appendText,
  setText,
  clearText,
  flashHint,
  getText: () => inputText.value,
  refreshPlaceholder: () => { void pickRandomPlaceholder() },
  submitPrepared,
})

const handleSendClick = (event: MouseEvent) => {
  event.preventDefault()
  void handleSend()
}
</script>

<template>
  <div
    class="composer-root"
    :class="{
      'composer-root-embedded': embedded,
      'composer-root-embedded-filled': embedded && hasComposerAttachments,
      'composer-root-overlay': overlay,
      'composer-root-overlay-filled': overlay && hasComposerAttachments
    }"
  >
  <div v-if="uploadedDocs.length > 0 || activeParsingDocs.length > 0" class="uploaded-docs">
    <div class="uploaded-docs-header">
      <span class="uploaded-docs-title">📎 {{ t('ai.uploadedDocs') }} ({{ uploadedDocs.length + activeParsingDocs.length }})</span>
      <button
        v-if="uploadedDocs.length > 0"
        class="btn-clear-docs"
        @click="clearUploadedDocs"
        :title="t('ai.clearDocs')"
      >
        <X :size="12" />
      </button>
    </div>
    <div class="uploaded-docs-list">
      <div
        v-for="(doc, index) in uploadedDocs"
        :key="`uploaded-${index}-${doc.filename}`"
        class="uploaded-doc-item"
        :class="{ 'has-error': doc.error }"
      >
        <AttachmentFileIcon class="doc-icon" :file-type="doc.fileType" :filename="doc.filename" :file-path="doc.filePath" :size="14" />
        <span class="doc-name" :title="doc.filename">{{ doc.filename }}</span>
        <span class="doc-size">{{ formatFileSize(doc.fileSize) }}</span>
        <span v-if="doc.error" class="doc-error" :data-tooltip="doc.error">⚠️</span>
        <button class="btn-remove-doc" @click="removeUploadedDoc(index)" :title="t('ai.removeDoc')">
          <X :size="10" />
        </button>
      </div>
      <div
        v-for="doc in activeParsingDocs"
        :key="`${doc.requestId}-${doc.fileIndex}`"
        class="uploaded-doc-item is-parsing"
        :class="{ 'has-error': doc.status === 'failed' }"
        :title="getParsePhaseLabel(doc)"
      >
        <AttachmentFileIcon class="doc-icon" :filename="doc.filename" :size="14" />
        <span class="doc-name">{{ doc.filename }}</span>
        <span class="doc-size">{{ parseProgressLabel(doc) }}</span>
        <span v-if="doc.status === 'failed'" class="doc-error" :data-tooltip="doc.error || getParsePhaseLabel(doc)">⚠️</span>
        <div
          v-if="doc.status !== 'failed'"
          class="doc-parse-bar"
          :style="{ width: Math.max(4, Math.min(100, doc.percent)) + '%' }"
        />
      </div>
    </div>
  </div>

  <div
    v-if="followUpItems.length > 0"
    class="follow-up-queue"
    @dragleave="handleFollowUpQueueDragLeave"
  >
    <div class="follow-up-queue-header">
      {{ t('ai.followUpQueueHeader', { count: followUpItems.length }) }}
    </div>
    <div
      v-for="(item, index) in followUpItems"
      :key="item.id"
      class="follow-up-row"
      :class="{
        'follow-up-row-editing': item.editing,
        'follow-up-row-drag-over': followUpDragOverIndex === index && followUpDragIndex !== index,
        'follow-up-row-dragging': followUpDragIndex === index,
      }"
      @dragover="handleFollowUpDragOver(index, $event)"
      @drop="handleFollowUpDrop(index, $event)"
      @dragend="handleFollowUpDragEnd"
    >
      <span
        v-if="!item.editing"
        class="follow-up-row-grip"
        draggable="true"
        :title="t('ai.followUpQueueReorder')"
        @dragstart="handleFollowUpDragStart(index, $event)"
      >
        <GripVertical :size="12" />
      </span>
      <span v-else class="follow-up-row-grip follow-up-row-grip-disabled">
        <GripVertical :size="12" />
      </span>
      <span
        v-if="item.editing"
        class="follow-up-row-text follow-up-row-text-editing"
      >{{ t('ai.followUpQueueEditing') }}</span>
      <span v-else class="follow-up-row-text" :title="item.message">{{ item.message }}</span>
      <div v-if="!item.editing" class="follow-up-row-actions">
        <button
          type="button"
          class="follow-up-row-icon-btn"
          :title="t('ai.followUpQueueEdit')"
          @click="beginEditFollowUp?.(item.id)"
        >
          <Pencil :size="12" />
        </button>
        <button
          type="button"
          class="follow-up-row-icon-btn"
          :title="t('ai.followUpQueueInsert')"
          @click="insertFollowUp?.(item.id)"
        >
          <CornerDownLeft :size="12" />
        </button>
        <button
          type="button"
          class="follow-up-row-remove"
          :title="t('ai.followUpQueueRemove')"
          @click="removeFollowUp?.(item.id)"
        >
          <X :size="12" />
        </button>
      </div>
    </div>
  </div>

  <div v-if="quoteSnippets.length > 0" class="composer-quote-snips">
    <div class="composer-quote-snips-header">
      <span class="composer-quote-snips-title">{{ t('ai.quoteSnippetsSection') }}</span>
    </div>
    <div class="composer-quote-snips-list">
      <div v-for="s in quoteSnippets" :key="s.id" class="composer-quote-chip" :title="snippetChipSummary(s)">
        <span class="composer-quote-chip-label">{{ snippetChipSummary(s) }}</span>
        <button type="button" class="composer-quote-chip-remove" @click="removeQuoteSnippet(s.id)" :title="t('ai.quoteSnippetRemove')">
          <X :size="12" />
        </button>
      </div>
    </div>
  </div>

  <div
    v-if="isEditingFollowUp"
    class="follow-up-edit-banner"
  >
    <span class="follow-up-edit-banner-text">{{ t('ai.followUpEditBanner') }}</span>
    <button
      type="button"
      class="follow-up-edit-banner-cancel"
      @click="handleCancelEditClick"
    >
      {{ t('ai.followUpEditCancel') }}
    </button>
  </div>

  <div
    v-if="slashHintVisible"
    class="slash-hint"
    role="listbox"
    :aria-label="t('ai.slashHintKey', { shortcut: decorateShortcut(sendShortcut, t('ai.hintSlashSend')) })"
  >
    <button
      v-for="(cmd, index) in slashMatches"
      :key="cmd.id"
      type="button"
      class="slash-hint-item"
      :class="{ active: index === slashSelectedIndex }"
      role="option"
      :aria-selected="index === slashSelectedIndex"
      @mousedown.prevent="completeSlash(cmd)"
      @mouseenter="slashSelectedIndex = index"
    >
      <span class="slash-hint-name">/{{ primarySlashName(cmd) }}</span>
      <span class="slash-hint-desc">{{ t('ai.slashCompactDesc') }}</span>
      <span class="slash-hint-key">{{ t('ai.slashHintKey', { shortcut: decorateShortcut(sendShortcut, t('ai.hintSlashSend')) }) }}</span>
    </button>
  </div>

  <div class="ai-input" :class="{ 'ai-input-embedded': embedded, 'ai-input-overlay': overlay, 'ai-input-editing-follow-up': isEditingFollowUp }">
    <div
      v-if="!overlay && contextStats.tokenEstimate > 0"
      ref="contextMiniEl"
      class="context-mini"
      @mouseenter="onContextMiniEnter"
      @mousemove="onContextMiniMove"
      @mouseleave="scheduleCloseContextTip"
    >
      <template v-if="cacheBarWidth > 0">
        <div class="context-mini-bar cached" :style="{ width: cacheBarWidth + '%' }"></div>
        <div
          class="context-mini-bar"
          :class="{ warning: contextStats.percentage > 60, danger: contextStats.percentage > 85 }"
          :style="{ left: cacheBarWidth + '%', width: (contextStats.percentage - cacheBarWidth) + '%' }"
        ></div>
      </template>
      <div
        v-else
        class="context-mini-bar"
        :class="{ warning: contextStats.percentage > 60, danger: contextStats.percentage > 85 }"
        :style="{ width: contextStats.percentage + '%' }"
      ></div>
    </div>

    <Teleport to="body">
      <div
        v-if="showContextTip && contextStats.tokenEstimate > 0"
        ref="contextTipEl"
        class="context-mini-tip"
        :class="{ 'is-detail': showCompositionDetail }"
        :style="contextTipStyle"
        @mouseenter="keepContextTip"
        @mouseleave="scheduleCloseContextTip"
        @mousedown.stop
      >
        <div class="ctx-usage-simple">
          <span class="ctx-usage-simple-line">
            <template v-if="contextStats.effectiveModel">{{ contextStats.effectiveModel }} · </template>{{ t('ai.context') }}: {{ contextStats.tokenEstimate.toLocaleString() }} / {{ (contextStats.maxTokens / 1000).toFixed(0) }}K ({{ contextStats.percentage }}%)<template v-if="contextStats.cacheHitRate !== undefined"> · Cache {{ contextStats.cacheHitRate }}%</template>
          </span>
          <button
            v-if="topLevelComposition.length > 0"
            type="button"
            class="ctx-usage-detail-toggle"
            :class="{ open: showCompositionDetail }"
            :title="showCompositionDetail ? t('ai.contextUsageHideDetail') : t('ai.contextUsageShowDetail')"
            :aria-label="showCompositionDetail ? t('ai.contextUsageHideDetail') : t('ai.contextUsageShowDetail')"
            :aria-expanded="showCompositionDetail"
            @click.stop="toggleCompositionDetail"
          >
            <ListTree :size="11" />
          </button>
        </div>
        <div v-if="showCompositionDetail && topLevelComposition.length > 0" class="ctx-usage-detail">
          <div class="ctx-usage-segments">
            <div
              v-for="node in topLevelComposition"
              :key="node.id"
              class="ctx-usage-seg"
              :style="{ flexGrow: Math.max(node.chars, 1), flexBasis: '0px', background: compositionColor(node.id) }"
              :title="compositionLabel(node.id)"
            ></div>
          </div>
          <ul class="ctx-usage-list">
            <li v-for="node in topLevelComposition" :key="node.id" class="ctx-usage-item">
              <div class="ctx-usage-row">
                <span class="ctx-usage-swatch" :style="{ background: compositionColor(node.id) }"></span>
                <span class="ctx-usage-name">{{ compositionLabel(node.id) }}</span>
                <span class="ctx-usage-pct-col">{{ formatCompositionPercent(node.chars) }}</span>
              </div>
              <ul v-if="node.children?.length" class="ctx-usage-children">
                <li v-for="child in node.children" :key="child.id" class="ctx-usage-row child">
                  <span class="ctx-usage-swatch" :style="{ background: compositionColor(child.id) }"></span>
                  <span class="ctx-usage-name">{{ compositionLabel(child.id) }}</span>
                  <span class="ctx-usage-pct-col">{{ formatCompositionPercent(child.chars) }}</span>
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </div>
    </Teleport>

    <div v-if="pendingImages.length > 0" class="image-preview-strip">
      <div v-for="img in pendingImages" :key="img.id" class="image-preview-item">
        <img :src="img.dataUrl" :alt="img.name" class="image-thumbnail" @click="openImagePreview(img.dataUrl)" />
        <button class="image-remove-btn" @click="removeImage(img.id)" :title="t('ai.removeImage')">
          <X :size="12" />
        </button>
      </div>
    </div>

    <div
      ref="inputContainerEl"
      class="input-container"
      :class="{
        'flash-hint': isFlashHint,
        'input-container-two-row': isTwoRow,
        'has-skill-chips': hasActiveSkillChips
      }"
      @mousedown="onComposerSurfaceMouseDown"
    >
      <div
        v-if="!overlay && hasActiveSkillChips"
        class="composer-skill-chips"
        :class="{ 'is-dragging': skillChipsDragging, 'is-empowering': justAddedSkillIds.length > 0 }"
        :aria-label="t('ai.conversationSkills')"
      >
        <button
          type="button"
          class="composer-skill-chips-mark"
          :class="{ 'is-open': skillMenuStandalone }"
          :aria-label="t('ai.conversationSkillAdd')"
          :title="t('ai.conversationSkillAdd')"
          @mousedown.prevent
          @click="openSkillPicker"
        >
          <Sparkles :size="12" :stroke-width="1.75" />
        </button>
        <div
          class="composer-skill-chips-track"
          :class="{
            'can-scroll-left': skillChipsCanScrollLeft,
            'can-scroll-right': skillChipsCanScrollRight
          }"
        >
          <div
            ref="skillChipsScrollerEl"
            class="composer-skill-chips-scroller"
            @scroll="onSkillChipsScroll"
            @pointerdown="onSkillChipsPointerDown"
            @pointermove="onSkillChipsPointerMove"
            @pointerup="endSkillChipsDrag"
            @pointercancel="endSkillChipsDrag"
            @click.capture="onSkillChipsClickCapture"
          >
            <div
              v-for="s in skillChips"
              :key="s.id"
              class="composer-skill-chip"
              :class="{
                'is-new': justAddedSkillIds.includes(s.id),
                'is-unavailable': s.unavailable
              }"
              :style="skillChipInsertStyle(s.id)"
              :data-skill-id="s.id"
              @mouseenter="onSkillChipHover($event, s)"
              @mouseleave="hideSkillChipTip"
            >
              <button type="button" class="composer-skill-chip-remove" @click="removeSkillChip(s.id)" :title="t('ai.conversationSkillRemove')">
                <X :size="11" />
              </button>
              <span class="composer-skill-chip-label">{{ s.name }}</span>
            </div>
          </div>
        </div>
      </div>
      <button
        v-if="!overlay && !isTwoRow && showInlineSkillPicker"
        type="button"
        class="upload-btn composer-skill-picker-btn"
        :class="{ 'is-open': skillMenuStandalone }"
        :aria-label="t('ai.conversationSkillAdd')"
        :title="t('ai.conversationSkillAdd')"
        @mousedown.prevent
        @click="openSkillPicker"
      >
        <Sparkles :size="14" :stroke-width="1.75" />
      </button>
      <button
        v-if="!overlay && !isTwoRow"
        class="upload-btn"
        :disabled="isAttaching"
        :title="t('ai.attach')"
        @click="selectAttachment"
      >
        <span v-if="isAttaching" class="upload-spinner"></span>
        <Plus v-else :size="18" />
      </button>

      <div ref="textareaWrapEl" class="input-textarea-wrap">
        <div
          v-if="slashHighlight"
          ref="slashMirrorEl"
          class="slash-mirror"
          aria-hidden="true"
        ><span class="slash-token">{{ slashHighlight.token }}</span><span>{{ slashHighlight.rest }}</span></div>
        <textarea
          ref="mentionInputEl"
          v-model="inputText"
          :class="{ 'has-slash-overlay': !!slashHighlight }"
          :placeholder="composerPlaceholder"
          @input="handleInputChange"
          @scroll="syncSlashMirror"
          @keydown="handleInputKeyDown"
          @paste="handlePaste"
          @compositionstart="isComposing = true"
          @compositionend="isComposing = false"
          @blur="handleInputBlur"
        ></textarea>
      </div>

      <Teleport to="body">
      <div
        v-if="showMentionMenu"
        ref="mentionMenuEl"
        class="mention-menu"
        :class="{ 'place-below': mentionMenuBelow }"
        :style="mentionMenuStyle"
      >
        <div v-if="mentionMenuType === null" class="mention-menu-header">
          {{ t('mentions.selectCommand') }}
        </div>
        <div v-else class="mention-menu-header" :class="{ 'has-search': skillMenuStandalone }">
          <span v-if="mentionMenuType === 'file'">📄 {{ t('mentions.file') }}</span>
          <span v-else-if="mentionMenuType === 'docs'">📚 {{ t('mentions.docs') }}</span>
          <span v-else-if="mentionMenuType === 'skill'">✨ {{ t('mentions.skill') }}</span>
          <input
            v-if="skillMenuStandalone"
            ref="skillMenuSearchEl"
            class="mention-skill-search"
            :value="mentionSearchQuery"
            :placeholder="t('mentions.searchSkills')"
            @input="onStandaloneSkillSearch"
            @keydown="handleSkillSearchKeyDown"
            @blur="handleInputBlur"
          />
          <span v-if="mentionCurrentDir" class="mention-path" :title="mentionCurrentDir">{{ mentionCurrentDir }}</span>
        </div>

        <div v-if="isMentionLoading" class="mention-loading">
          <span class="mention-spinner"></span>
          {{ t('common.loading') }}
        </div>
        <div v-else-if="mentionSuggestions.length === 0" class="mention-empty">
          {{ t('mentions.noResults') }}
        </div>
        <div
          v-else
          class="mention-list-wrap"
          :class="{
            'can-scroll-up': mentionListCanScrollUp,
            'can-scroll-down': mentionListCanScrollDown
          }"
        >
          <div ref="mentionListEl" class="mention-list" @scroll="updateMentionListOverflow">
            <div
              v-for="(suggestion, index) in mentionSuggestions"
              :key="suggestion.id"
              class="mention-item"
              :class="{ active: index === mentionSelectedIndex }"
              @mousedown.prevent="selectSuggestion(suggestion)"
              @mouseenter="setMentionSelectedIndex(index)"
            >
              <span class="mention-icon">{{ suggestion.icon }}</span>
              <div class="mention-content">
                <span class="mention-label">{{ suggestion.label }}</span>
                <span v-if="suggestion.description" class="mention-desc">{{ suggestion.description }}</span>
              </div>
            </div>
            <div v-if="mentionHasMore" class="mention-more">
              {{ t('mentions.moreItems', { count: mentionTotalCount - 50 }) }}
            </div>
          </div>
        </div>
        <div class="mention-hint">
          <span
            v-if="mentionMenuType !== null && !skillMenuStandalone"
            class="mention-back-btn"
            @mousedown.prevent="mentionGoBack(); focusInput()"
          >
            ← {{ t('mentions.back') }}
          </span>
          <span class="mention-hint-keys">
            <span>↑↓</span> {{ t('mentions.navigate') }}
            <span>Tab/Enter</span> {{ t('mentions.select') }}
            <span>Esc</span> {{ t('mentions.close') }}
          </span>
        </div>
      </div>
      </Teleport>

      <!-- 两行模式底栏 -->
      <div v-if="isTwoRow" class="input-bottom-bar">
        <div class="input-footer-left">
          <button
            v-if="showInlineSkillPicker"
            type="button"
            class="upload-btn composer-skill-picker-btn"
            :class="{ 'is-open': skillMenuStandalone }"
            :aria-label="t('ai.conversationSkillAdd')"
            :title="t('ai.conversationSkillAdd')"
            @mousedown.prevent
            @click="openSkillPicker"
          >
            <Sparkles :size="14" :stroke-width="1.75" />
          </button>
          <button
            class="upload-btn"
            :disabled="isAttaching"
            :title="t('ai.attach')"
            @click="selectAttachment"
          >
            <span v-if="isAttaching" class="upload-spinner"></span>
            <Plus v-else :size="18" />
          </button>
          <slot name="footer-left" />
          <span
            v-if="consumedTokenLabel"
            class="session-token-chip"
            :aria-label="consumedTokenTitle"
            @mouseenter="showConsumedTip($event, consumedTokenTitle, 'top')"
            @mouseleave="hideConsumedTip"
          >{{ consumedTokenLabel }}</span>
        </div>
        <div class="input-footer-right">
          <slot name="footer-right" />
          <button
            v-if="voiceInputEnabled && (!isLoading || isAgentRunning)"
            class="voice-btn"
            :class="{ recording: isRecording, transcribing: isTranscribing, ptt: isPushToTalk, unavailable: !audioAvailable }"
            :disabled="!audioAvailable || isTranscribing || isSpeechInitializing"
            :title="!audioAvailable ? t('ai.noAudioDevice') : isRecording ? t('ai.stopRecording') : (isTranscribing ? t('ai.transcribing') : t('ai.startRecording'))"
            @click="handleRecordClick"
          >
            <Loader2 v-if="isTranscribing || isSpeechInitializing" :size="18" class="spin" />
            <MicOff v-else-if="isRecording || !audioAvailable" :size="18" />
            <Mic v-else :size="18" />
          </button>
          <button v-if="ttsIsSpeaking" class="tts-stop-btn" @click="ttsStop" :title="t('ai.stopTts')">
            <Volume2 :size="18" class="tts-speaking-icon" />
          </button>
          <button v-if="isLoading && !isAgentRunning && !isEditingFollowUp" class="stop-btn" @click="stopGeneration" :title="t('ai.stopGeneration')">
            <Square :size="16" fill="currentColor" />
          </button>
          <button
            v-else-if="isEditingFollowUp"
            class="send-btn send-btn-edit-follow-up"
            :disabled="isAttaching"
            :title="sendButtonTitle"
            @click="handleSendClick"
          >
            <Check :size="18" />
          </button>
          <button
            v-else-if="isAgentRunning && canSubmitMessage"
            class="send-btn send-btn-supplement"
            :disabled="isAttaching"
            :title="sendButtonTitle"
            @click="handleSendClick"
          >
            <ArrowUp :size="18" />
          </button>
          <button v-else-if="isAgentRunning && canSendEmpty" class="send-btn send-btn-default" :disabled="isAttaching" :title="t('ai.useDefault')" @click="handleSendClick">
            <Check :size="18" />
          </button>
          <button v-else-if="isAgentRunning" class="stop-btn" @click="abortAgent" :title="t('ai.stopAgent')">
            <Square :size="16" fill="currentColor" />
          </button>
          <button v-else class="send-btn send-btn-agent" :disabled="isAttaching || !canSubmitMessage" :title="sendButtonTitle" @click="handleSendClick">
            <ArrowUp :size="18" />
          </button>
        </div>
      </div>

      <!-- 单行模式右侧按钮 -->
      <template v-else>
        <slot name="inner-right" />

        <button
          v-if="!overlay && voiceInputEnabled && (!isLoading || isAgentRunning)"
          class="voice-btn"
          :class="{ recording: isRecording, transcribing: isTranscribing, ptt: isPushToTalk, unavailable: !audioAvailable }"
          :disabled="!audioAvailable || isTranscribing || isSpeechInitializing"
          :title="!audioAvailable ? t('ai.noAudioDevice') : isRecording ? t('ai.stopRecording') : (isTranscribing ? t('ai.transcribing') : t('ai.startRecording'))"
          @click="handleRecordClick"
        >
          <Loader2 v-if="isTranscribing || isSpeechInitializing" :size="18" class="spin" />
          <MicOff v-else-if="isRecording || !audioAvailable" :size="18" />
          <Mic v-else :size="18" />
        </button>

        <button
          v-if="ttsIsSpeaking"
          class="tts-stop-btn"
          @click="ttsStop"
          :title="t('ai.stopTts')"
        >
          <Volume2 :size="18" class="tts-speaking-icon" />
        </button>

        <button
          v-if="isLoading && !isAgentRunning && !isEditingFollowUp"
          class="stop-btn"
          @click="stopGeneration"
          :title="t('ai.stopGeneration')"
        >
          <Square :size="16" fill="currentColor" />
        </button>
        <button
          v-else-if="isEditingFollowUp"
          class="send-btn send-btn-edit-follow-up"
          :disabled="isAttaching"
          :title="sendButtonTitle"
          @click="handleSendClick"
        >
          <Check :size="18" />
        </button>
        <button
          v-else-if="isAgentRunning && canSubmitMessage"
          class="send-btn send-btn-supplement"
          :disabled="isAttaching"
          :title="sendButtonTitle"
          @click="handleSendClick"
        >
          <ArrowUp :size="18" />
        </button>
        <button
          v-else-if="isAgentRunning && canSendEmpty"
          class="send-btn send-btn-default"
          :disabled="isAttaching"
          :title="t('ai.useDefault')"
          @click="handleSendClick"
        >
          <Check :size="18" />
        </button>
        <button
          v-else-if="isAgentRunning"
          class="stop-btn"
          @click="abortAgent"
          :title="t('ai.stopAgent')"
        >
          <Square :size="16" fill="currentColor" />
        </button>
        <button
          v-else
          class="send-btn send-btn-agent"
          :disabled="isAttaching || !canSubmitMessage"
          :title="sendButtonTitle"
          @click="handleSendClick"
        >
          <ArrowUp :size="18" />
        </button>
      </template>
    </div>
  </div>
  </div>
  <HoverTipOverlay :tip="consumedHoverTip" />
  <HoverTipOverlay :tip="skillChipHoverTip" />
</template>

<style scoped>
.context-mini {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px;
  cursor: help;
}

.context-mini::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--bg-tertiary);
  border-radius: 1px;
}

.context-mini-bar {
  position: absolute;
  top: 0;
  left: 0;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
  transition: width 0.3s ease, left 0.3s ease, background 0.3s ease;
}

.context-mini-bar.cached { background: #2dd4bf; }
.context-mini-bar.warning { background: var(--color-warning); }
.context-mini-bar.danger { background: var(--color-error); }

.context-mini-tip {
  z-index: 10050;
  box-sizing: border-box;
  /* 简洁态贴合改前 tip：小字号、紧凑 padding、单行 */
  padding: 4px 8px;
  font-size: 10px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  white-space: nowrap;
  overflow: visible;
  pointer-events: auto;
}

.context-mini-tip.is-detail {
  padding: 8px 12px;
  font-size: 11px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  white-space: normal;
  overflow-x: visible;
  overflow-y: auto;
}

.ctx-usage-simple {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: max-content;
  max-width: none;
}

.ctx-usage-simple-line {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ctx-usage-detail-toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.55;
}

.ctx-usage-detail-toggle:hover,
.ctx-usage-detail-toggle.open {
  color: var(--text-primary);
  opacity: 1;
  background: var(--bg-tertiary);
}

.ctx-usage-detail {
  width: 100%;
  margin-top: 2px;
}

.ctx-usage-segments {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-tertiary);
  margin: 8px 0 6px;
}

.ctx-usage-seg {
  height: 100%;
  /* 非零块至少 3px；比例由 inline flex-grow=chars 决定 */
  min-width: 3px;
  flex-shrink: 1;
}

.ctx-usage-list,
.ctx-usage-children {
  list-style: none;
  margin: 0;
  padding: 0;
}

.ctx-usage-item + .ctx-usage-item {
  margin-top: 6px;
}

.ctx-usage-row {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) 4em;
  align-items: center;
  column-gap: 8px;
  padding: 4px 0;
}

.ctx-usage-row:not(.child) .ctx-usage-name {
  font-weight: 600;
  color: var(--text-primary);
}

/* 二级：缩进 + 弱化字重/颜色 */
.ctx-usage-row.child {
  grid-template-columns: 6px minmax(0, 1fr) 4em;
  margin-left: 16px;
  padding: 2px 0 2px 8px;
  border-left: 1px solid var(--border-color);
  column-gap: 8px;
}

.ctx-usage-row.child .ctx-usage-name {
  font-weight: 400;
  font-size: 10.5px;
  color: var(--text-secondary);
}

.ctx-usage-row.child .ctx-usage-swatch {
  width: 6px;
  height: 6px;
  opacity: 0.9;
}

.ctx-usage-row.child .ctx-usage-pct-col {
  opacity: 0.85;
}

.ctx-usage-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  justify-self: center;
}

.ctx-usage-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ctx-usage-pct-col {
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--text-secondary);
  text-align: right;
  white-space: nowrap;
}

.ctx-usage-children {
  margin-top: 2px;
  margin-bottom: 2px;
}

.uploaded-docs {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.uploaded-docs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.uploaded-docs-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.btn-clear-docs {
  padding: 2px 4px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.6;
  transition: all 0.2s;
}

.btn-clear-docs:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.uploaded-docs-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.uploaded-doc-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 11px;
  max-width: 200px;
}

.doc-parse-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 0 0 6px 6px;
  transition: width 0.2s ease;
  pointer-events: none;
}

.uploaded-doc-item.has-error {
  border-color: rgba(var(--color-error-rgb), 0.5);
  background: rgba(var(--color-error-rgb), 0.05);
}

.doc-icon {
  font-size: 12px;
  flex-shrink: 0;
}

.doc-name {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100px;
}

.doc-size {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.doc-error {
  flex-shrink: 0;
  cursor: help;
  position: relative;
}

.doc-error::after {
  content: attr(data-tooltip);
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  background: rgba(30, 30, 30, 0.95);
  color: #fff;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  max-width: 280px;
  min-width: 120px;
  z-index: 1000;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(var(--color-error-rgb), 0.3);
}

.doc-error::before {
  content: '';
  position: absolute;
  bottom: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent;
  border-top-color: rgba(30, 30, 30, 0.95);
  z-index: 1001;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.2s ease, visibility 0.2s ease;
  pointer-events: none;
}

.doc-error:hover::after,
.doc-error:hover::before {
  opacity: 1;
  visibility: visible;
}

.btn-remove-doc {
  padding: 2px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.5;
  transition: all 0.2s;
  flex-shrink: 0;
}

.btn-remove-doc:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.composer-quote-snips {
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.composer-quote-snips-header {
  margin-bottom: 6px;
}

.composer-quote-snips-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.composer-quote-snips-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.composer-skill-chips {
  --skill-fx-fill-start: color-mix(in srgb, var(--accent-decorative-primary) 22%, var(--bg-hover));
  --skill-fx-fill-peak: color-mix(in srgb, var(--accent-decorative-primary) 28%, var(--bg-hover));
  --skill-fx-edge: rgba(var(--accent-decorative-rgb), 0.85);
  --skill-fx-glow: rgba(var(--accent-decorative-rgb), 0.42);
  --skill-fx-sheen: rgba(var(--accent-decorative-rgb), 0.38);
  --skill-fx-stroke: rgba(var(--accent-decorative-rgb), 0.95);
  --skill-fx-shot: rgba(var(--accent-decorative-rgb), 0.95);
  --skill-fx-mark: rgba(var(--accent-decorative-rgb), 0.9);
  --skill-fx-mark-color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 1px 2px 7px;
}

[data-ui-theme="light"] .composer-skill-chips,
[data-ui-theme="sponsor-sakura"] .composer-skill-chips {
  --skill-fx-fill-start: color-mix(in srgb, var(--accent-primary) 36%, var(--bg-surface));
  --skill-fx-fill-peak: color-mix(in srgb, var(--accent-primary) 54%, var(--bg-surface));
  --skill-fx-edge: var(--accent-primary);
  --skill-fx-glow: rgba(var(--accent-rgb), 0.32);
  --skill-fx-sheen: rgba(255, 255, 255, 0.82);
  --skill-fx-stroke: var(--accent-primary);
  --skill-fx-shot: var(--accent-primary);
  --skill-fx-mark: rgba(var(--accent-rgb), 0.55);
  --skill-fx-mark-color: var(--accent-primary);
}

.composer-skill-chips-mark {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 2px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.composer-skill-chips-mark:hover,
.composer-skill-chips-mark.is-open {
  color: var(--text-secondary);
}

.composer-skill-chips.is-empowering .composer-skill-chips-mark {
  animation: skill-mark-emit 0.9s ease-out;
}

.composer-skill-chips.is-empowering .composer-skill-chips-mark::after {
  content: '';
  position: absolute;
  left: 10px;
  top: 50%;
  width: 22px;
  height: 2px;
  margin-top: -1px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--skill-fx-shot), transparent);
  pointer-events: none;
  animation: skill-energy-shot 0.42s ease-out both;
}

.composer-skill-chips-track {
  position: relative;
  flex: 1;
  min-width: 0;
}

.composer-skill-chips-track::before,
.composer-skill-chips-track::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 20px;
  pointer-events: none;
  z-index: 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.composer-skill-chips-track::before {
  left: 0;
  background: linear-gradient(to right, var(--bg-surface), transparent);
}

.composer-skill-chips-track::after {
  right: 0;
  background: linear-gradient(to left, var(--bg-surface), transparent);
}

.composer-skill-chips-track.can-scroll-left::before,
.composer-skill-chips-track.can-scroll-right::after {
  opacity: 1;
}

.composer-skill-chips-scroller {
  display: flex;
  flex-wrap: nowrap;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
  touch-action: pan-x;
  user-select: none;
  overscroll-behavior-x: contain;
}

.composer-skill-chips-scroller::-webkit-scrollbar {
  display: none;
}

.composer-skill-chips-track.can-scroll-left .composer-skill-chips-scroller,
.composer-skill-chips-track.can-scroll-right .composer-skill-chips-scroller {
  cursor: grab;
}

.composer-skill-chips.is-dragging .composer-skill-chips-scroller {
  cursor: grabbing;
}

.composer-skill-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 4px;
  max-width: 10.5rem;
  padding: 2px 7px 2px 5px;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  font-size: var(--fs-meta);
  color: var(--text-secondary);
}

@property --skill-stroke {
  syntax: '<number>';
  inherits: false;
  initial-value: 0;
}

.composer-skill-chip.is-new {
  overflow: hidden;
  animation: skill-chip-insert 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--skill-insert-delay, 0ms);
}

.composer-skill-chip.is-new::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(
    90deg,
    transparent 0%,
    var(--skill-fx-sheen) 42%,
    color-mix(in srgb, var(--skill-fx-sheen) 22%, transparent) 72%,
    transparent 100%
  );
  background-size: 55% 100%;
  background-repeat: no-repeat;
  background-position: -60% 0;
  animation: skill-chip-sheen 0.7s ease-out both;
  animation-delay: calc(var(--skill-insert-delay, 0ms) + 120ms);
  pointer-events: none;
  z-index: 0;
}

.composer-skill-chip.is-new::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(
    from 220deg,
    var(--skill-fx-stroke) calc(var(--skill-stroke) * 1%),
    transparent 0
  );
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: skill-chip-stroke 0.56s ease-out both;
  animation-delay: calc(var(--skill-insert-delay, 0ms) + 160ms);
  pointer-events: none;
  z-index: 2;
}

.composer-skill-chip.is-unavailable {
  opacity: 0.5;
  color: var(--text-muted);
}

@keyframes skill-chip-insert {
  0% {
    max-width: 0;
    padding-left: 0;
    padding-right: 0;
    opacity: 0.75;
    transform: translateX(-10px);
    color: var(--text-primary);
    background: var(--skill-fx-fill-start);
    box-shadow: inset 2px 0 0 var(--skill-fx-edge);
    filter: none;
  }
  38% {
    max-width: 10.5rem;
    padding-left: 5px;
    padding-right: 7px;
    opacity: 1;
    transform: translateX(2px);
    color: var(--text-primary);
    background: var(--skill-fx-fill-peak);
    box-shadow: inset 2px 0 0 var(--skill-fx-edge);
    filter: drop-shadow(0 0 8px var(--skill-fx-glow));
  }
  52% {
    max-width: 10.5rem;
    padding-left: 5px;
    padding-right: 7px;
    transform: none;
    filter: drop-shadow(0 0 5px var(--skill-fx-glow));
  }
  100% {
    max-width: 10.5rem;
    padding-left: 5px;
    padding-right: 7px;
    opacity: 1;
    transform: none;
    color: var(--text-secondary);
    background: var(--bg-hover);
    box-shadow: none;
    filter: none;
  }
}

@keyframes skill-chip-sheen {
  0% {
    background-position: -60% 0;
    opacity: 0.95;
  }
  72% {
    background-position: 140% 0;
    opacity: 0.65;
  }
  100% {
    background-position: 140% 0;
    opacity: 0;
  }
}

@keyframes skill-chip-stroke {
  0% {
    --skill-stroke: 0;
    opacity: 1;
  }
  68% {
    --skill-stroke: 100;
    opacity: 1;
  }
  100% {
    --skill-stroke: 100;
    opacity: 0;
  }
}

@keyframes skill-mark-emit {
  0% {
    color: var(--text-muted);
    filter: none;
    transform: scale(1);
  }
  12% {
    color: var(--skill-fx-mark-color);
    filter: drop-shadow(0 0 8px var(--skill-fx-mark));
    transform: scale(1.22);
  }
  28% {
    transform: scale(1);
  }
  100% {
    color: var(--text-muted);
    filter: none;
    transform: none;
  }
}

@keyframes skill-energy-shot {
  0% {
    opacity: 0;
    transform: translateX(0) scaleX(0.35);
  }
  22% {
    opacity: 1;
    transform: translateX(6px) scaleX(1);
  }
  100% {
    opacity: 0;
    transform: translateX(34px) scaleX(0.4);
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-skill-chip.is-new,
  .composer-skill-chip.is-new::before,
  .composer-skill-chip.is-new::after,
  .composer-skill-chips.is-empowering .composer-skill-chips-mark,
  .composer-skill-chips.is-empowering .composer-skill-chips-mark::after {
    animation: none;
  }
}

.composer-skill-chip-label {
  position: relative;
  z-index: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-skill-chip-remove {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-full);
}

.composer-skill-chip-remove:hover,
.composer-skill-chip-remove:focus-visible {
  color: var(--text-primary);
}

@media (hover: hover) {
  .composer-skill-chip-remove {
    opacity: 0.45;
  }

  .composer-skill-chip:hover .composer-skill-chip-remove,
  .composer-skill-chip-remove:focus-visible {
    opacity: 1;
  }
}

.composer-quote-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 8px;
  border-radius: 999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-primary);
}

.composer-quote-chip-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-quote-chip-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.7;
}

.composer-quote-chip-remove:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
}

.follow-up-queue {
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  container-type: inline-size;
  container-name: follow-up-queue;
}

.follow-up-queue-header {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.follow-up-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  padding: 3px 6px;
  margin: 0 -6px;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-primary);
}

.follow-up-row:hover {
  background: var(--bg-secondary);
}

.follow-up-row-dragging {
  opacity: 0.45;
}

.follow-up-row-drag-over {
  box-shadow: inset 0 2px 0 var(--accent-primary);
}

.follow-up-row-editing {
  color: var(--text-muted);
  font-style: italic;
}

.follow-up-row-grip {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  margin-top: 2px;
  color: var(--text-muted);
  cursor: grab;
  opacity: 0.55;
}

.follow-up-row-grip-disabled {
  cursor: default;
  opacity: 0.3;
}

.follow-up-row:active .follow-up-row-grip {
  cursor: grabbing;
}

.follow-up-row-text {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.follow-up-row-text-editing {
  -webkit-line-clamp: 1;
}

.follow-up-row-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 2px;
}

.follow-up-row-icon-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0.75;
}

.follow-up-row-icon-btn:hover,
.follow-up-row-icon-btn:focus-visible {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* × 只在指到那一条时露出来，多条排队时不铺一列叉 */
.follow-up-row-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.follow-up-row:hover .follow-up-row-remove,
.follow-up-row-remove:focus-visible {
  opacity: 0.7;
}

.follow-up-row-remove:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
}

.follow-up-edit-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-tertiary));
  border-top: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-color));
  font-size: 12px;
  color: var(--text-primary);
}

.follow-up-edit-banner-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.follow-up-edit-banner-cancel {
  flex-shrink: 0;
  padding: 2px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}

.follow-up-edit-banner-cancel:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ai-input {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border-color);
  background: linear-gradient(180deg, var(--bg-tertiary) 0%, var(--bg-primary) 100%);
}

/* embedded：空态仅保留内层 input-container；有附件时由 composer-root 统一外框 */
.composer-root:not(.composer-root-embedded):not(.composer-root-overlay) {
  display: contents;
}

.composer-root.composer-root-overlay {
  display: flex;
  flex-direction: column;
  width: min(560px, 100%);
  margin: 0 auto;
}

.composer-root-overlay-filled {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.composer-root-overlay-filled .uploaded-docs,
.composer-root-overlay-filled .composer-quote-snips,
.composer-root-overlay-filled .follow-up-queue,
.composer-root-overlay-filled .follow-up-edit-banner {
  border-top: none;
  background: transparent;
}

.ai-input.ai-input-overlay {
  padding: 0;
  gap: 6px;
  border-top: none;
  background: transparent;
}

.composer-root-overlay:not(.composer-root-overlay-filled) .input-container {
  padding: 6px 8px 6px 12px;
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.composer-root-overlay .input-container-two-row {
  padding: 6px 8px 7px;
}

.composer-root-overlay .input-bottom-bar {
  margin-top: 2px;
}

.composer-root-overlay-filled .ai-input-overlay {
  padding: 8px;
  border-top: 1px solid var(--border-color);
}

.composer-root-overlay-filled .input-container {
  box-shadow: none;
}

.composer-root-embedded-filled {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  overflow: hidden;
}

.composer-root-embedded-filled .uploaded-docs,
.composer-root-embedded-filled .composer-quote-snips,
.composer-root-embedded-filled .follow-up-queue {
  border-top: none;
  background: transparent;
  padding: 11px 11px 0;
}

/* 附件区与下方分割线之间留足间距（文档列表不要紧贴分隔线） */
.composer-root-embedded-filled .uploaded-docs:has(~ .ai-input-embedded),
.composer-root-embedded-filled .composer-quote-snips:has(~ .ai-input-embedded),
.composer-root-embedded-filled .follow-up-queue:has(~ .ai-input-embedded) {
  padding-bottom: 11px;
}

.composer-root-embedded-filled .uploaded-docs + .composer-quote-snips,
.composer-root-embedded-filled .follow-up-queue + .composer-quote-snips,
.composer-root-embedded-filled .uploaded-docs + .follow-up-queue {
  padding-top: 8px;
}

.composer-root-embedded-filled .uploaded-docs ~ .ai-input-embedded,
.composer-root-embedded-filled .composer-quote-snips ~ .ai-input-embedded,
.composer-root-embedded-filled .follow-up-queue ~ .ai-input-embedded {
  border-top: 1px solid var(--border-color);
}

.ai-input.ai-input-embedded {
  border-top: none;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 0;
}

.composer-root-embedded-filled .ai-input-embedded {
  padding: 11px 11px 11px;
}

.composer-root-embedded-filled .ai-input-embedded .image-preview-strip {
  padding-top: 0;
  padding-left: 0;
  padding-right: 0;
}

.ai-input-embedded textarea:focus,
.ai-input-embedded textarea:focus-visible {
  border: none;
  outline: none;
  box-shadow: none;
}

.input-container {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 10px;
  background: var(--bg-surface);
  border: none;
  border-radius: 16px;
  transition: box-shadow 0.2s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.03);
}

.input-container.has-skill-chips:not(.input-container-two-row) {
  flex-wrap: wrap;
}

.input-container.has-skill-chips:not(.input-container-two-row) .composer-skill-chips {
  flex: 1 0 100%;
}

.input-container-two-row.has-skill-chips {
  grid-template-rows: auto auto auto;
}

/* 两行模式：grid 替代 flex-column，避免 textarea scrollHeight 测量失真 */
.input-container-two-row {
  display: grid;
  grid-template-rows: auto auto;
  align-items: stretch;
  gap: 0;
  /* 四边等距：主操作键落在右下角，右和下不等距时它到两条边的距离就对不齐。
     文字要的额外内缩由 textarea 自己的 padding 给，不靠这里加偏心。
     数值与外框圆角联动，改动见下方按钮圆角的同心说明。 */
  padding: 8px;
}

.input-container-two-row .input-textarea-wrap {
  width: 100%;
}

.input-textarea-wrap {
  flex: 1;
  min-width: 0;
  position: relative;
}

.slash-mirror {
  position: absolute;
  inset: 0;
  padding: 7px 4px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.4286;
  white-space: pre-wrap;
  word-wrap: break-word;
  overflow: hidden;
  pointer-events: none;
  color: var(--text-primary);
}

.slash-token {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.14);
  border-radius: 4px;
  font-weight: 600;
}

.ai-input textarea.has-slash-overlay {
  color: transparent;
  caret-color: var(--text-primary);
}

.slash-hint {
  margin: 0 0 8px;
  padding: 2px;
  border-radius: 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
}

.slash-hint-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}

.slash-hint-item.active {
  background: rgba(var(--accent-rgb), 0.15);
}

.slash-hint-name {
  flex-shrink: 0;
  color: var(--accent-primary);
  font-weight: 600;
  font-size: 13px;
}

.slash-hint-desc {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-hint-key {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.input-container-two-row textarea {
  width: 100%;
  padding: 7px 4px;
  min-height: 0;
  height: 20px; /* 单行初始高度，mountd 后由 measureTextareaHeight 重算 */
}

.input-bottom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
}

.input-footer-left {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.session-token-chip {
  flex-shrink: 0;
  padding: 2px 4px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  cursor: help;
  user-select: none;
  white-space: nowrap;
}

.input-footer-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.input-container:has(textarea:focus) {
  box-shadow: 0 0 0 2px var(--accent-primary), 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.05);
}

/* flash-hint：场景卡片填入 prompt 后的一次性脉冲，提醒用户"输入框已就绪，按 Enter 发送"。
   动画期间盖过 :has(textarea:focus) 的 box-shadow（因 specificity + 动画在同 selector 上覆盖），
   1.5s 后 class 自动移除，恢复默认 / focus 态外观。 */
.input-container.flash-hint {
  animation: composerFlashHint 1.5s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes composerFlashHint {
  0% {
    box-shadow:
      0 0 0 0 rgba(var(--accent-decorative-rgb), 0.6),
      0 0 0 0 rgba(var(--accent-decorative-rgb), 0),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
  25% {
    box-shadow:
      0 0 0 4px rgba(var(--accent-decorative-rgb), 0.55),
      0 0 22px 2px rgba(var(--accent-decorative-rgb), 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
  100% {
    box-shadow:
      0 0 0 2px var(--accent-primary),
      0 4px 12px rgba(0, 0, 0, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.05);
  }
}

/* Composer 一行里的所有按钮共用同一个 32px / 8px 方格，主操作键也在这个格子里。
   尺寸不齐时最重要的那个反而最小，一行读起来就是拼的。

   圆角 8px 不是随手取的：按钮要跟外框圆角同心，半径必须等于外框半径减去两者
   的间距（16 − 8）。取大了角会鼓出父级弧线，取小了显方——两条弧线不平行，
   看上去就是「差一点」，但很难指出差在哪。外框圆角或内边距一改，这里得跟着改。 */
.upload-btn,
.voice-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  box-sizing: border-box;
  background: transparent;
  border: none;
  color: var(--text-muted);
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.12s ease;
}

/* 悬停只换颜色、按下才缩——与主操作键同一套手感。
   悬停放大会让一行图标此起彼伏地跳。 */
.upload-btn:hover:not(:disabled),
.voice-btn:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--accent-primary);
}

.upload-btn:active:not(:disabled),
.voice-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.upload-btn:disabled,
.voice-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.upload-btn.composer-skill-picker-btn.is-open {
  background: rgba(var(--accent-rgb), 0.12);
  color: var(--accent-primary);
}

.upload-spinner,
.mention-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(var(--accent-rgb), 0.2);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.voice-btn.recording {
  color: var(--color-error);
  background: rgba(255, 100, 100, 0.15);
  animation: pulse-recording 1.5s ease-in-out infinite;
}

.voice-btn.transcribing {
  color: var(--accent-primary);
}

.voice-btn .spin {
  animation: spin 1s linear infinite;
}

@keyframes pulse-recording {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255, 100, 100, 0.4); }
  50% { box-shadow: 0 0 0 6px rgba(255, 100, 100, 0); }
}

.ai-input textarea {
  display: block;
  width: 100%;
  padding: 7px 4px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-primary);
  background: transparent;
  border: none;
  resize: none;
  outline: none;
  line-height: 1.4286;
  min-height: 20px;
  max-height: 360px;
  overflow-y: auto;
  margin: 0;
}

.ai-input textarea::placeholder {
  color: var(--text-muted);
  opacity: 0.7;
}

/* 焦点环由外层 .input-container:has(textarea:focus) 统一提供，
   textarea 内部不再叠加全局 textarea:focus 光晕，避免出现两层焦点。 */
.ai-input textarea:focus {
  border-color: transparent;
  box-shadow: none;
  outline: none;
}

/*
 * 主操作键（发送 / 停止）的外观只有一处定义，变体只改 --btn-tint。
 *
 * 刻意做成纯平：一块实色、无渐变、无投影、无内高光。32px 上渐变跨不出层次、
 * 黑投影在深色底上看不见，这些只会让边缘发灰、像早年的拟物按钮。这个尺寸的
 * 立体感只能靠色块与底色的对比，不靠打光。
 */
.send-btn,
.stop-btn {
  flex-shrink: 0;
  align-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.12s ease;
  --btn-tint: #5a7bff;
  color: #fff;
  background: var(--btn-tint);
}

/* 白箭头描边越细越挺；2.25 那档在小尺寸上会糊成一团。
   只作用于发送键——停止键是实心方块，与描边无关。 */
.send-btn svg {
  width: 16px;
  height: 16px;
  stroke-width: 2;
}

/* 实心方块比同尺寸的线稿箭头重得多，得收得比箭头更小才等重 */
.stop-btn svg {
  width: 12px;
  height: 12px;
}

.send-btn:hover:not(:disabled),
.stop-btn:hover:not(:disabled) {
  background: color-mix(in srgb, #fff 14%, var(--btn-tint));
}

/* 按下用缩放而不是位移：一行按钮里只有它上下跳会显得散 */
.send-btn:active:not(:disabled),
.stop-btn:active:not(:disabled) {
  transform: scale(0.94);
  background: color-mix(in srgb, #000 8%, var(--btn-tint));
}

.send-btn:focus-visible,
.stop-btn:focus-visible {
  outline: 2px solid var(--btn-tint);
  outline-offset: 2px;
}

/* 不可用时整块退成中性灰，不做「暗一点的绿」——半透明的品牌色压在深色底上
   会变成一坨发闷的橄榄色，读起来像坏了，而不是「还不能发」。
   顺带让空输入框安静下来：没话可发时它不该是全场最亮的东西。 */
.send-btn:disabled {
  cursor: not-allowed;
  background: color-mix(in srgb, var(--text-muted) 14%, transparent);
  color: var(--text-muted);
}

.send-btn-agent,
.send-btn-default {
  --btn-tint: var(--color-success);
}

.send-btn-supplement {
  --btn-tint: var(--color-warning);
}

.stop-btn {
  --btn-tint: var(--color-error);
}

.ai-input-editing-follow-up {
  border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-primary) 28%, transparent);
}

.composer-root-embedded-filled:has(.ai-input-editing-follow-up) {
  border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-primary) 22%, transparent);
}

.tts-stop-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  background: rgba(var(--accent-rgb), 0.14);
  color: var(--accent-primary);
  transition: background 0.15s ease, transform 0.12s ease;
}

.tts-stop-btn:hover {
  background: rgba(var(--accent-rgb), 0.24);
}

.tts-stop-btn:active {
  transform: scale(0.94);
}

@keyframes tts-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.tts-speaking-icon {
  animation: tts-pulse 1.5s ease-in-out infinite;
}

.mention-menu {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 400;
}

.mention-menu.place-below {
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.mention-menu-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.mention-menu-header.has-search {
  flex-wrap: wrap;
}

.mention-skill-search {
  flex: 1 1 8rem;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: var(--fs-meta);
  font-weight: 400;
}

.mention-skill-search:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.mention-skill-search::placeholder {
  color: var(--text-muted);
}

.mention-path {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  font-family: var(--font-mono);
  flex-shrink: 1;
  min-width: 0;
  max-width: 85%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: right;
}

.mention-loading,
.mention-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.mention-list-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.mention-list-wrap::before,
.mention-list-wrap::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 18px;
  pointer-events: none;
  z-index: 1;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.mention-list-wrap::before {
  top: 0;
  background: linear-gradient(to bottom, var(--bg-primary), transparent);
}

.mention-list-wrap::after {
  bottom: 0;
  background: linear-gradient(to top, var(--bg-primary), transparent);
}

.mention-list-wrap.can-scroll-up::before,
.mention-list-wrap.can-scroll-down::after {
  opacity: 1;
}

.mention-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
}

.mention-item.active {
  background: rgba(var(--accent-rgb), 0.15);
}

.mention-more {
  padding: 8px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
  border-top: 1px solid var(--border-color);
  background: var(--bg-tertiary);
}

.mention-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.mention-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-desc {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
}

.mention-back-btn {
  cursor: pointer;
  padding: 4px 10px;
  background: var(--bg-surface);
  border-radius: 6px;
  font-size: 11px;
  color: var(--text-secondary);
  transition: all 0.15s;
  flex-shrink: 0;
}

.mention-back-btn:hover {
  background: var(--accent-primary);
  color: #fff;
}

.mention-hint-keys {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mention-hint-keys span {
  padding: 2px 6px;
  background: var(--bg-surface);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
}

.image-preview-strip {
  display: flex;
  gap: 8px;
  padding: 8px 12px 4px;
  overflow-x: auto;
  flex-shrink: 0;
}

.image-preview-item {
  position: relative;
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  background: var(--bg-surface);
}

.image-thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  cursor: pointer;
}

.image-remove-btn {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  opacity: 0;
  transition: opacity 0.15s;
}

.image-preview-item:hover .image-remove-btn {
  opacity: 1;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
