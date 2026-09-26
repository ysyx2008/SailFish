<script setup lang="ts">
/**
 * AI 面板组件
 * 重构版本：使用 composables 模块化管理逻辑
 * 每个 tab 独立实例，通过 tabId prop 绑定
 */
import { ref, reactive, computed, watch, inject, onMounted, onUnmounted, toRef, nextTick, withDefaults } from 'vue'
import { useI18n } from 'vue-i18n'
import { Upload, X, HelpCircle, ChevronDown, ChevronUp, MoreHorizontal } from 'lucide-vue-next'
import { Virtualizer } from 'virtua/vue'
import type { VirtualizerHandle } from 'virtua/vue'
import type { MessageScrollerHandle } from '../types/message-scroller'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { useComposerQuoteStore } from '../stores/composer-quote'
import AgentPlanView from './AgentPlanView.vue'
import AiComposer from './AiComposer.vue'
import DropOverlay from './DropOverlay.vue'
import AiProfileSelect from './AiProfileSelect.vue'
import ApprovalModeSelect from './ApprovalModeSelect.vue'
import { useApprovalUiState } from '../composables/useApprovalUiState'
import ThinkingBlock from './ThinkingBlock.vue'
import ProcessTurnFold from './ProcessTurnFold.vue'
import { createReusableTemplate } from '../utils/reusable-template'
import { buildPeekProcessView, countPeekNeedsYou, lastSpokenBody, resolveFocusPeek, resolvePeekOverlay } from '../utils/focus-peek'
import { describeLiveProcess, type ProcessFoldView } from '../utils/process-fold'
import { formatProcessFoldCaption, type ProcessFoldSay } from '../utils/process-fold-label'
import ToolCallContent from './ToolCallContent.vue'
import ImageContextMenu from './ImageContextMenu.vue'
import AttachmentContextMenu from './AttachmentContextMenu.vue'
import AttachmentFileIcon from './AttachmentFileIcon.vue'
import EChartsCanvas from './EChartsCanvas.vue'
import WelcomePanel from './WelcomePanel.vue'
import HistorySearchModal from './HistorySearchModal.vue'
import { optionHasMapSeries } from '@shared/chart-maps'
import { useImageActions } from '../composables/useImageActions'
import { useAttachmentActions } from '../composables/useAttachmentActions'
import { parseThinking } from '../utils/thinking-block'
import { createLogger } from '../utils/logger'
import sailfishLogo from '../../resources/logo.png'

const log = createLogger('AiPanel')

// 导入 composables
import {
  useMarkdown,
  useDocumentUpload,
  useImageUpload,
  useContextStats,
  useHostProfile,
  useAgentMode,
  useSpeechRecognition,
  SPEECH_PACK_NOT_INSTALLED,
  toast
} from '../composables'
import type { VirtualItem } from '../composables/useAgentMode'
import { mermaidSvgToDataUrl } from '../composables/useMarkdown'
import { showConfirm, showAlert } from '../composables/useConfirm'
import { planComposerPaste, ingestComposerAttachments } from '../composables/useComposerPaste'
import { useFileDropTarget } from '../composables/useFileDropTarget'
import { pickTaskCompleteLabel } from '../composables/useTaskCompleteLabel'
import { loadBondTrustLevel } from '../composables/useRandomPlaceholder'
import { isOemFeatureEnabled } from '@shared/oem-features'
import type { BondTrustLevel } from '@shared/types/bond'
import type { AgentRecord, AgentHistorySummary, AttachmentInfo, AskingStatus } from '@shared/types'
import { resolveConversationDisplayTitle } from '../utils/conversation-title'
import { COMPANION_AGENT_KEY, isAskingSettled, clampAskUserTimeout } from '@shared/types'

// Props - 每个 AiPanel 实例绑定到特定的 tab
const props = withDefaults(defineProps<{
  tabId: string
  /** 用户是否展开 AI 侧栏（终端 tab 可折叠；助手 tab 恒为 true） */
  visible?: boolean
  /** 所属 tab 是否为当前激活 tab（与 visible 解耦，避免切 tab 触发虚拟列表重绘） */
  tabActive?: boolean
  /**
   * 发送时取出的旁路工作台上下文（不上聊天气泡）。
   * 助手工作台用于 Markdown 选区作用域。
   */
  consumeWorkbenchContext?: () => import('@shared/types').WorkbenchContext | undefined
  /** 独立助手并排终端时藏头像，把对话区让出来 */
  hideAvatar?: boolean
  /** 文档铺满：藏对话流，只留一句提醒和输入 */
  peek?: boolean
}>(), {
  visible: true,
  tabActive: true,
  hideAvatar: false,
  peek: false,
})

// i18n
const { t, tm } = useI18n()

// Stores
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const composerQuoteStore = useComposerQuoteStore()
const showSettings = inject<() => void>('showSettings')
const openAppSettings = inject<(tab?: string, section?: string) => void>('openAppSettings')

const isStandaloneAssistant = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === props.tabId)
  return tab?.type === 'assistant'
})

const showAssistantAvatar = computed(() => isStandaloneAssistant.value && !props.hideAvatar)

/** 当前 tab 是否为联络（companion）tab -- 决定 WelcomePanel 走专属说明分支 */
const isCompanionTab = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === props.tabId)
  return tab?.type === 'assistant' && tab?.agentId === COMPANION_AGENT_KEY
})

// 步骤行模板：列表里平铺一份，折叠行内部再用一份，作用域不变
const [DefineStepRow, ReuseStepRow] = createReusableTemplate<{ item: VirtualItem }>()
const [DefineConfirmRow, ReuseConfirmRow] = createReusableTemplate()
const [DefineSecureRow, ReuseSecureRow] = createReusableTemplate()

// Refs
const messagesRef = ref<HTMLDivElement | null>(null)
const virtuaRef = ref<VirtualizerHandle | null>(null)
const scrollerRef = ref<MessageScrollerHandle | null>(null)
watch(virtuaRef, (h) => {
  if (!h) {
    scrollerRef.value = null
    return
  }
  // 组合包装，不 mutate virtua 暴露的 handle
  scrollerRef.value = {
    get cache() { return h.cache },
    get scrollOffset() { return h.scrollOffset },
    get scrollSize() { return h.scrollSize },
    get viewportSize() { return h.viewportSize },
    findItemIndex: (...args) => h.findItemIndex(...args),
    getItemOffset: (...args) => h.getItemOffset(...args),
    getItemSize: (...args) => h.getItemSize(...args),
    scrollToIndex: (...args) => h.scrollToIndex(...args),
    scrollTo: (...args) => h.scrollTo(...args),
    scrollBy: (...args) => h.scrollBy(...args),
    scrollToBottom: () => { h.scrollTo(h.scrollSize) },
  }
}, { immediate: true })
const highlightedSourceStepId = ref<string | null>(null)
const composerRef = ref<InstanceType<typeof AiComposer> | null>(null)
const secureInputValue = ref('')

const tryFocusComposer = () => {
  nextTick(() => composerRef.value?.focusInput())
}

watch(
  () => terminalStore.assistantComposerFocusSeq,
  () => {
    if (!props.tabActive || terminalStore.assistantComposerFocusTabId !== props.tabId) return
    tryFocusComposer()
  }
)

const handleScenarioSelect = (prompt: string) => {
  composerRef.value?.setText(prompt)
  composerRef.value?.flashHint()
}

// 统一附件选择（图片 + 文档，自动按类型分流）
const isAttaching = computed(() => isUploadingDocs.value || isProcessingImage.value)
const selectAttachment = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  // 同时接受图片和文档
  input.accept = ''
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return
    await ingestAttachmentFiles(input.files)
  }
  input.click()
}

// Plan 展开状态
const planExpanded = ref(false)

// 步骤中的计划展开状态（用于查看归档的计划）
const expandedPlanSteps = ref<Set<string>>(new Set())
const togglePlanExpand = (stepId: string) => {
  if (expandedPlanSteps.value.has(stepId)) {
    expandedPlanSteps.value.delete(stepId)
  } else {
    expandedPlanSteps.value.add(stepId)
  }
}

// Web 搜索结果展开状态（默认收起，用户点击展开后可见全部链接）
const expandedWebSearchSteps = ref<Set<string>>(new Set())
const toggleWebSearchExpand = (stepId: string) => {
  if (expandedWebSearchSteps.value.has(stepId)) {
    expandedWebSearchSteps.value.delete(stepId)
  } else {
    expandedWebSearchSteps.value.add(stepId)
  }
}

// 思考块展开状态（默认收起，按 stepId 管理；切换时 virtua 自动重测高度）
const expandedThinkingSteps = ref<Set<string>>(new Set())
const THINKING_EXPAND_TRANSITION_MS = 280
const isThinkingExpanded = (stepId: string): boolean => {
  return expandedThinkingSteps.value.has(stepId)
}
const toggleThinkingExpand = async (stepId: string, anchorEl?: HTMLElement) => {
  const viewportTop = anchorEl?.getBoundingClientRect().top
  const willExpand = !expandedThinkingSteps.value.has(stepId)
  // 贴底时跟底 RO 会自己追；再跑锚定会和追底抢滚动 → 抖动
  const nearBottom = isUserNearBottom.value

  if (anchorEl && viewportTop !== undefined && !nearBottom) {
    suppressLayoutResizeCompensation(THINKING_EXPAND_TRANSITION_MS + 120)
  }

  const next = new Set(expandedThinkingSteps.value)
  if (willExpand) {
    next.add(stepId)
  } else {
    next.delete(stepId)
  }
  expandedThinkingSteps.value = next

  if (!anchorEl || viewportTop === undefined) return
  if (nearBottom) return

  const stabilize = () => {
    if (willExpand) {
      const fullEl = anchorEl.closest('.thinking-block')?.querySelector('.thinking-full')
      if (fullEl instanceof HTMLElement && ensureElementVisibleInViewport(fullEl)) {
        return
      }
    }
    anchorElementViewportY(anchorEl, viewportTop)
  }

  await nextTick()
  requestAnimationFrame(() => {
    stabilize()
    requestAnimationFrame(stabilize)
  })
  window.setTimeout(stabilize, THINKING_EXPAND_TRANSITION_MS + 20)
}

// 任务完成尾注挂在这一场的最后一格（步骤或折叠行外面），不另起一行，避免完成那一刻列表跳动。
// 后头还有干活时，不挂在中途说过的那句话上。
const shouldShowTaskCompleteFooter = (item: {
  showTaskCompleteFooter?: boolean
}): boolean => item.showTaskCompleteFooter === true

const taskCompleteFooterLabels = new Map<string, string>()
const bondTrustForFooter = ref<BondTrustLevel>('stranger')
const bondTrustForFooterReady = ref(false)
/** 羁绊等级就绪时递增，驱动已渲染尾注用正确 trust 池重算文案 */
const taskCompleteFooterLabelEpoch = ref(0)

if (isOemFeatureEnabled('bond')) {
  void loadBondTrustLevel().then(level => {
    bondTrustForFooter.value = level
    bondTrustForFooterReady.value = true
    taskCompleteFooterLabels.clear()
    taskCompleteFooterLabelEpoch.value++
  })
} else {
  bondTrustForFooterReady.value = true
}

const getTaskCompleteFooterLabel = (groupId: string | undefined): string => {
  void taskCompleteFooterLabelEpoch.value
  if (!groupId) return t('ai.taskComplete')
  if (!bondTrustForFooterReady.value) return t('ai.taskComplete')
  if (!taskCompleteFooterLabels.has(groupId)) {
    taskCompleteFooterLabels.set(
      groupId,
      pickTaskCompleteLabel(tm('ai.taskCompletePools'), bondTrustForFooter.value, t, {
        funEnabled: isOemFeatureEnabled('bond'),
      })
    )
  }
  return taskCompleteFooterLabels.get(groupId)!
}

/**
 * group 操作菜单（含「另开一聊」）的可见性条件：
 *   - group 已完成（成功 / 失败 / 中断都允许；进行中的当前 task 无 finalResult，自然不显示）
 *   - 非 onboarding（引导对话不允许分叉）
 *
 * talk_to_user 主动消息（isProactive）完成后同样允许分叉。
 *
 * 注：Agent 运行中仍可对已完成 group 分叉（untilTaskCount 截断），与主对话并行探索。
 * 从历史记录打开的 tab（loadedFromHistory）也可分叉：后端会 fallback 到 HistoryService 读取会话。
 * footer 高度由 min-height 锁定，按钮不因运行状态显隐引起列表重排（见 agent/SPEC.md）。
 */
const canShowGroupMenu = (group: import('../composables').AgentTaskGroup | undefined): boolean => {
  if (!group) return false
  if (!group.finalResult) return false
  if (group.isOnboarding) return false
  return true
}

/** 当前 tab 是否为联络（companion）tab——决定 fork 菜单文案：companion 用「从这里创建任务」，
 *  task 用「另开一聊」。语义区分：companion 是升格成正式任务，task 是同质分叉。 */
const isCompanionSourceTab = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
  if (!tab) return false
  const sourceAgentKey = tab.type === 'assistant' ? (tab.agentId || tab.id) : tab.id
  return sourceAgentKey === '__companion__'
})

/** 当前 tab 的 agentState 来自历史恢复（用于滚动定位，与 fork 菜单可见性无关） */
const isLoadedFromHistory = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
  return !!tab?.agentState?.loadedFromHistory
})

// 任务完成尾注首次出现时给一次性 fade-in 动画。
//
// 问题：footer 是 `v-if` 控制，且外层用虚拟滚动，footer 滚出
// 视区后会被 unmount，滚回时 remount——如果 CSS 入场动画无条件挂在 .agent-final-footer
// 上，每次 remount 都会重播，造成"翻历史一路滑入闪烁"。
//
// 方案：用 Set 记录"已经播过入场动画的 group id"，class 只在 Set 不包含该 group 时
// 附加 → 第一次出现时播动画 → animationend 写入 Set → 之后无论怎么 remount 都不再
// 附加 class 也就不再播放。
//
// 历史冷加载：会话打开时尾注已在最终态，不应再播「完成瞬间」的淡入；渲染时写入 Set
// 并跳过 first-show，续聊后 remount 也不会误播。
const animatedFooters = new Set<string>()

const isFooterFirstShow = (groupId: string | undefined): boolean => {
  if (!groupId) return false
  if (animatedFooters.has(groupId)) return false
  if (isLoadedFromHistory.value) {
    animatedFooters.add(groupId)
    return false
  }
  return true
}

const markFooterAnimated = (groupId: string | undefined) => {
  if (groupId) animatedFooters.add(groupId)
}

// 正在 fork 的 group ID 集合：防止用户连续点击同一个按钮创建多个 fork tab
const forkingGroupIds = ref<Set<string>>(new Set())

// 当前展开操作菜单的 group ID（同一时间最多一个菜单展开）
// 菜单通过 Teleport 渲染到 body，避免被滚动容器 overflow 裁掉
const openGroupMenuId = ref<string | null>(null)
const groupMenuPosition = ref<{ top: number; right: number }>({ top: 0, right: 0 })

const toggleGroupMenu = (group: import('../composables').AgentTaskGroup | undefined, event: MouseEvent) => {
  if (!group) return
  if (openGroupMenuId.value === group.id) {
    openGroupMenuId.value = null
    return
  }
  // 以触发按钮的右下角对齐菜单（top = 按钮底部 + 4px gap，right = 视窗右边缘 - 按钮右边缘）
  const trigger = event.currentTarget as HTMLElement
  const rect = trigger.getBoundingClientRect()
  groupMenuPosition.value = {
    top: rect.bottom + 4,
    right: window.innerWidth - rect.right
  }
  openGroupMenuId.value = group.id
}

// 当前展开菜单对应的 group 引用（Teleport 菜单按钮的 onClick 用它）
const openGroupMenuGroup = computed(() =>
  agentTaskGroups.value.find(g => g.id === openGroupMenuId.value)
)

const handleForkFromGroup = async (group: import('../composables').AgentTaskGroup | undefined) => {
  if (!group) return
  if (!canShowGroupMenu(group)) return
  if (forkingGroupIds.value.has(group.id)) return
  openGroupMenuId.value = null
  forkingGroupIds.value.add(group.id)
  try {
    const newTabId = await terminalStore.forkToAssistantTab(currentTabId.value, {
      groupIndex: group.index,
      anchorTaskStepId: group.id,
    })
    if (!newTabId) {
      log.warn('Fork from group failed', { groupId: group.id, groupIndex: group.index })
      await showAlert(t('common.error'), t('ai.fork.failed'))
    }
  } finally {
    forkingGroupIds.value.delete(group.id)
  }
}

const closeGroupMenu = () => {
  if (openGroupMenuId.value !== null) openGroupMenuId.value = null
}

// 点击其他地方关闭菜单
const handleGlobalClickForGroupMenu = (e: MouseEvent) => {
  if (openGroupMenuId.value === null) return
  const target = e.target as HTMLElement | null
  if (target?.closest('.agent-group-menu') || target?.closest('.agent-group-menu-trigger')) return
  openGroupMenuId.value = null
}

// 滚动 / 窗口尺寸变化时关闭菜单：fixed 定位的菜单不会跟随滚动，留在原位会与触发按钮失去视觉关联
const handleScrollForGroupMenu = () => closeGroupMenu()

const askClock = ref(Date.now())
let askClockTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  document.addEventListener('mousedown', handleGlobalClickForGroupMenu)
  window.addEventListener('resize', closeGroupMenu)
  // 监听虚拟滚动容器的 scroll 事件（capture 阶段，覆盖各种内部滚动场景）
  document.addEventListener('scroll', handleScrollForGroupMenu, true)
  askClockTimer = setInterval(() => { askClock.value = Date.now() }, 1000)
})
onUnmounted(() => {
  document.removeEventListener('mousedown', handleGlobalClickForGroupMenu)
  window.removeEventListener('resize', closeGroupMenu)
  document.removeEventListener('scroll', handleScrollForGroupMenu, true)
  if (askClockTimer) clearInterval(askClockTimer)
})

// 识别 createRun 一开始插入的 startup 占位步骤（type='thinking' + isStreaming=true）。
// 文案由后端翻译后经 step.content 推送，前端只认结构、不再维护译文白名单。
// 其它 thinking step（如截断警告、参数错误）isStreaming 为 undefined，不会被误判。
const isInitialPreparingStep = (step: { type: string; isStreaming?: boolean }): boolean => {
  return step.type === 'thinking' && step.isStreaming === true
}

/** message step 的思考行：含已解析 thinking 块，或流式首 chunk 尚未包装 🤔 前的过渡态 */
const getMessageStepThinkingView = (step: { content: string; isStreaming?: boolean }) => {
  const parsed = parseThinking(step.content)
  if (parsed.thinking) {
    return {
      reasoning: parsed.thinking.reasoning,
      isStreaming: !parsed.thinking.isDone,
      label: undefined as string | undefined,
    }
  }
  return null
}

const getMessageStepBody = (step: { content: string }): string => {
  return parseThinking(step.content).body
}

const getMessageStepPresentation = (step: { content: string; isStreaming?: boolean }) => ({
  thinking: getMessageStepThinkingView(step),
  body: getMessageStepBody(step),
})

// 思考块完成时长缓存（按 stepId 索引）
// 虚拟列表中已完成的 ThinkingBlock 滚出视区后会被 unmount、滚回时 remount，
// 仅用 step.timestamp 重算会得到"从起点到现在"的错乱时长（变成几十~上百秒）。
// 此处用一个会话内的内存 Map 缓存：组件首次完成时 emit finalize 上报真实时长，remount 时回传，使用 reactive ref 触发模板更新
const thinkingDurations = ref<Map<string, number>>(new Map())
const getCachedThinkingDuration = (stepId: string): number | undefined => {
  return thinkingDurations.value.get(stepId)
}
const cacheThinkingDuration = (stepId: string, ms: number) => {
  // 同一 step 重复上报时仅在尚未缓存时写入，避免覆盖第一次的真实时长
  if (!thinkingDurations.value.has(stepId)) {
    const next = new Map(thinkingDurations.value)
    next.set(stepId, ms)
    thinkingDurations.value = next
  }
}

// 在默认浏览器中打开 URL（仅允许 http/https，防范 javascript:/data: 等协议）
const openWebSearchLink = (url: string) => {
  if (!url) return
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('[AiPanel] Blocked non-http(s) URL:', url)
      return
    }
    window.open(parsed.href, '_blank', 'noopener,noreferrer')
  } catch (e) {
    console.warn('[AiPanel] Invalid URL:', url, e)
  }
}

// 获取 URL 的主机名用于展示
const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

// 子 Agent 展开状态（默认收起，用户点击切换）
const subAgentExpandState = reactive(new Map<string, boolean>())
const isSubAgentExpanded = (key: string): boolean => {
  return subAgentExpandState.get(key) === true
}
const toggleSubAgentExpand = (key: string) => {
  subAgentExpandState.set(key, !isSubAgentExpanded(key))
}

/** 获取子 Agent 当前活动摘要（最新的 running 或最后一个已完成步骤的 tool+args） */
const getSubAgentActivity = (sa: import('@shared/types').SubAgentResult): string | null => {
  if (!sa.steps || sa.steps.length === 0) return null
  const running = [...sa.steps].reverse().find(s => s.status === 'running')
  const step = running || sa.steps[sa.steps.length - 1]
  const parts = [step.tool]
  if (step.args) parts.push(step.args)
  return parts.join(' ')
}


// ==================== 初始化 Composables ====================

// 当前终端 ID（使用 prop，每个实例固定绑定一个 tab）
const currentTabId = toRef(props, 'tabId')
const tabActive = toRef(props, 'tabActive')

// 文档上传（传入 currentTabId，每个终端独立管理文档）
const {
  uploadedDocs,
  parsingDocs,
  isUploadingDocs,
  handleDroppedFiles,
  removeUploadedDoc,
  clearUploadedDocs,
  formatFileSize,
  getDocumentContext,
  getDocPreviewImages,
  getAllDocImages,
  getDocImagesContext
} = useDocumentUpload(currentTabId)

// 图片上传（视觉理解）
const {
  pendingImages,
  isProcessingImage,
  handleDroppedImages,
  removeImage,
  clearImages,
  discardImages,
  getImageDataUrls,
  getImageAttachments,
  ensurePendingImagePaths,
  hasImages,
  loadPendingImages,
  addImageDataUrl
} = useImageUpload()

const hasImagesComputed = computed(() => hasImages())

/** 附件分流：图片 → 视觉区，其余 → 文档解析（粘贴 / 拖放 / 选择附件共用） */
const ingestAttachmentFiles = (files: FileList | File[]) =>
  ingestComposerAttachments(files, {
    ingestImages: handleDroppedImages,
    ingestDocuments: handleDroppedFiles
  })

const {
  isDragOver: isFileDragOver,
  handleDragEnter,
  handleDragOver,
  handleDragLeave,
  handleDrop,
} = useFileDropTarget(ingestAttachmentFiles)

// Markdown 渲染
const {
  renderMarkdown,
  renderMermaidBlocks,
  handleCodeBlockClick,
  handleFilePathContextMenu
} = useMarkdown()

// ==================== Mermaid 渲染调度 ====================
// 消息正文经 v-html 注入，mermaid 代码块被渲染成占位 div，真正画图需在 DOM 落地后触发。
// 用 MutationObserver 监听虚拟滚动容器的 DOM 变化（流式追加 / 滚动复用行 / 切 tab），
// debounce 后扫描并渲染未完成的 mermaid 块。renderMermaidBlocks 自身写入 SVG 会再次触发
// observer，但已渲染块带 data-mermaid-state="done" 不会重复 render，配合 debounce 不会死循环。
let mermaidObserver: MutationObserver | null = null
let mermaidScanTimer: ReturnType<typeof setTimeout> | null = null
let mermaidLastScan = 0

// 用 throttle（leading + trailing）而非纯 debounce：流式时 token 不断触发 MutationObserver，
// 纯 debounce 会被反复重置、一直等到流式停顿才渲染（表现为全程空白）。throttle 保证持续
// 流式中也按固定间隔出图，实现真正的「边出边画」。250ms 在跳动与即时性之间取平衡。
const MERMAID_SCAN_INTERVAL_MS = 250

const scheduleMermaidScan = (el: HTMLElement) => {
  const now = Date.now()
  const elapsed = now - mermaidLastScan
  if (elapsed >= MERMAID_SCAN_INTERVAL_MS) {
    mermaidLastScan = now
    void renderMermaidBlocks(el)
  } else if (!mermaidScanTimer) {
    mermaidScanTimer = setTimeout(() => {
      mermaidScanTimer = null
      mermaidLastScan = Date.now()
      void renderMermaidBlocks(el)
    }, MERMAID_SCAN_INTERVAL_MS - elapsed)
  }
}

const attachMermaidObserver = (el: HTMLElement) => {
  detachMermaidObserver()
  mermaidObserver = new MutationObserver(() => scheduleMermaidScan(el))
  mermaidObserver.observe(el, { childList: true, subtree: true })
  // 首次绑定时内容可能已存在（历史恢复 / 切回面板），主动扫一次
  scheduleMermaidScan(el)
}

const detachMermaidObserver = () => {
  if (mermaidObserver) {
    mermaidObserver.disconnect()
    mermaidObserver = null
  }
  if (mermaidScanTimer) {
    clearTimeout(mermaidScanTimer)
    mermaidScanTimer = null
  }
}

// 主机档案
const {
  currentHostProfile,
  isLoadingProfile,
  isProbing,
  getHostIdByTabId,
  loadHostProfile,
  refreshHostProfile,
  autoProbeHostProfile
} = useHostProfile()

// Agent 模式（包含输入、滚动、终端状态等所有功能）
const {
  isLoading,
  currentSystemInfo,
  terminalSelectedText,
  lastError,
  // 滚动相关
  hasNewMessage,
  isUserNearBottom,
  isHistoryScrollPending,
  updateScrollPosition,
  saveScrollTop,
  restoreScrollTop,
  restoreScrollPositionOnTabActivate,
  scrollToHistoryBottomWithRetry,
  scrollToBottom,
  suppressLayoutResizeCompensation,
  anchorElementViewportY,
  ensureElementVisibleInViewport,
  stopGeneration,
  // Agent 执行
  executionMode,
  activeProfileId,
  agentState,
  isAgentRunning,
  pendingConfirm,
  pendingSecureInput,
  agentUserTask,
  currentPlan,
  agentTaskGroups,
  flattenedItems,
  toggleProcessFold,
  runAgent,
  abortAgent,
  followUpQueueView,
  isEditingFollowUp,
  removeFollowUp,
  insertFollowUp,
  beginEditFollowUp,
  cancelEditFollowUp,
  saveEditFollowUp,
  reorderFollowUp,
  confirmToolCall,
  confirmTrustCommandAndAllow,
  submitSecureInput,
  cancelSecureInput,
  sendAgentReply,
  getStepIcon,
  getRiskClass,
  getExecStatusClass,
  // 历史对话功能
  recentHistory,
  isLoadingHistory,
  showHistoryModal,
  allHistory,
  isLoadingAllHistory,
  isHistorySearchLoading,
  historyFullTextSearchActive,
  historySearchTotalMatched,
  hasMoreHistory,
  historySearchKeyword,
  setHistorySearchKeyword,
  flushHistorySearch,
  clearHistorySearch,
  loadMoreHistory,
  openHistoryModal,
  closeHistoryModal,
  loadHistoryRecord,
  hasExistingConversation,
  formatHistoryTime,
  ttsIsSpeaking,
  ttsStop,
  compactContext,
} = useAgentMode(
  messagesRef,
  async () => {
    const textContext = await getDocumentContext()
    const scannedContext = getDocImagesContext()
    return [textContext, scannedContext].filter(Boolean).join('\n\n')
  },
  getHostIdByTabId,
  autoProbeHostProfile,
  currentTabId,
  {
    getImages: () => [...getImageDataUrls(), ...getAllDocImages()],
    getPreviewImages: () => [...getImageDataUrls(), ...getDocPreviewImages()],
    getPendingImages: () => getImageDataUrls(),
    clearImages
  },
  {
    getAttachments: () => [
      ...uploadedDocs.value.map(d => ({
        filename: d.filename,
        filePath: d.filePath,
        fileSize: d.fileSize,
        fileType: d.fileType,
        totalPages: d.totalPages || d.pageCount,
        previewPages: d.images?.length
      })),
      ...getImageAttachments(),
    ],
    clearAttachments: clearUploadedDocs,
    getParsedDocs: () => uploadedDocs.value.map(d => ({ ...d })),
  },
  scrollerRef,
  tabActive
)

// 语音识别
const {
  isRecording,
  isTranscribing,
  isInitializing: isSpeechInitializing,
  audioAvailable,
  modelAvailable,
  error: speechError,
  checkAndInitialize: initSpeech,
  refreshSpeechPackAvailability,
  startRecording,
  stopRecording,
  cancelRecording
} = useSpeechRecognition()

// 监听语音识别错误并显示提示
watch(speechError, (error) => {
  if (!error) return
  if (error === SPEECH_PACK_NOT_INSTALLED) {
    toast.show(t('ai.speechPackNotInstalled'), 'warning', 6000, true, {
      action: t('ai.speechPackOpenSettings'),
      onClick: () => openAppSettings?.('voice', 'speechPack'),
    })
    return
  }
  toast.error(t('ai.speechError', { error }))
})

// 处理录音按钮点击
const handleRecordClick = async () => {
  if (isRecording.value) {
    // 停止录音并转录
    const result = await stopRecording()
    if (result?.text) {
      composerRef.value?.appendText(result.text)
    }
  } else {
    // 开始录音
    await startRecording()
  }
}

// Push-to-Talk：按住配置的按键说话，松开后延迟停止录音（避免末尾语音丢失）
const isPushToTalk = ref(false)
let pttStopTimer: ReturnType<typeof setTimeout> | null = null
let pttStartTimer: ReturnType<typeof setTimeout> | null = null
const PTT_HOLD_THRESHOLD = 300

const clearPTTStopTimer = () => {
  if (pttStopTimer) {
    clearTimeout(pttStopTimer)
    pttStopTimer = null
  }
}

const clearPTTStartTimer = () => {
  if (pttStartTimer) {
    clearTimeout(pttStartTimer)
    pttStartTimer = null
  }
}

const MODIFIER_EVENT_PROPS: Record<string, keyof KeyboardEvent> = {
  Control: 'ctrlKey',
  Meta: 'metaKey',
  Shift: 'shiftKey',
  Alt: 'altKey',
}

function hasOtherModifiers(event: KeyboardEvent, pttKey: string): boolean {
  for (const [key, prop] of Object.entries(MODIFIER_EVENT_PROPS)) {
    if (key !== pttKey && event[prop as keyof KeyboardEvent]) return true
  }
  return false
}

const handlePTTKeyDown = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (!pttKey || !audioAvailable.value || !props.visible || !props.tabActive) return

  // 如果按下的不是 PTT 键，且当前正在 PTT 状态（计时器或录音中），则中止 PTT
  if (event.key !== pttKey) {
    if (isPushToTalk.value || pttStartTimer || isRecording.value) {
      clearPTTStartTimer()
      clearPTTStopTimer()
      isPushToTalk.value = false
      cancelRecording()
    }
    return
  }

  // 未安装语音模型时禁用 PTT 快捷键（麦克风按钮仍可点击引导安装；
  // Control 等键易被复制粘贴误触，避免反复 toast）。
  // null = 尚未查到 pack 状态，放行由 startRecording 内再判定，避免已装用户短暂误拦。
  if (modelAvailable.value === false) return

  // 以下是按下 PTT 键的处理逻辑
  if (event.repeat) return
  // 组合键（如 Ctrl+O）：PTT 为普通键时也必须忽略，否则仅 MODIFIER_KEYS.has(pttKey) 时才会走 hasOtherModifiers
  if (hasOtherModifiers(event, pttKey)) return
  if (pttStopTimer) {
    clearPTTStopTimer()
    return
  }
  if (pttStartTimer) return
  if (isRecording.value || isTranscribing.value || isSpeechInitializing.value) return

  isPushToTalk.value = true
  pttStartTimer = setTimeout(() => {
    pttStartTimer = null
    if (isPushToTalk.value) {
      startRecording()
    }
  }, PTT_HOLD_THRESHOLD)
}

const finishPTTRecording = async () => {
  pttStopTimer = null
  isPushToTalk.value = false
  const result = await stopRecording()
  if (!isMounted.value) return
  if (result?.text) {
    composerRef.value?.appendText(result.text)
  }
}

const handlePTTKeyUp = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (event.key !== pttKey || !isPushToTalk.value) return

  if (pttStartTimer) {
    clearPTTStartTimer()
    isPushToTalk.value = false
    return
  }

  clearPTTStopTimer()
  pttStopTimer = setTimeout(finishPTTRecording, 200)
}

const handlePTTWindowBlur = () => {
  if (isPushToTalk.value || pttStartTimer) {
    clearPTTStartTimer()
    clearPTTStopTimer()
    isPushToTalk.value = false
    cancelRecording()
  }
}

// 上下文统计（使用 per-tab 的 activeAiProfile）
const {
  contextStats
} = useContextStats(
  agentState,
  agentUserTask,
  computed(() => activeAiProfile.value)
)

const cacheBarWidth = computed(() => {
  const { percentage, cacheHitRate } = contextStats.value
  if (cacheHitRate === undefined || cacheHitRate <= 0) return 0
  return Math.round(cacheHitRate / 100 * percentage * 100) / 100
})

// ==================== 配置相关 ====================

const hasAiConfig = computed(() => configStore.hasAiConfig)
const aiProfiles = computed(() => configStore.aiProfiles)

// 当前终端的 AI 配置档案（基于 per-tab activeProfileId）
const activeAiProfile = computed(() =>
  aiProfiles.value.find(p => p.id === activeProfileId.value) || null
)

// 切换 AI 配置（只影响当前终端）
const changeAiProfile = (profileId: string) => {
  activeProfileId.value = profileId
}

// ==================== 历史对话相关 ====================

// 截断文本
const historyDisplayTitle = (record: { title?: string; userTask: string }): string =>
  resolveConversationDisplayTitle(record)

// 加载历史记录（带确认）。欢迎区与弹窗都先按标题点开，无 steps 时按 id 拉正文
const handleLoadHistory = async (row: AgentRecord | AgentHistorySummary) => {
  if (agentUserTask.value && hasExistingConversation.value) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('common.confirm'),
      message: t('ai.agentWelcome.confirmLoadHistory'),
    })
    if (!confirmed) {
      return
    }
  }
  const record: AgentRecord | undefined =
    'steps' in row && Array.isArray(row.steps)
      ? (row as AgentRecord)
      : ((await window.electronAPI.history.getAgentRecordById(row.id)) as AgentRecord | undefined)
  if (!record) {
    toast.error(t('ai.agentWelcome.historyRecordMissing'))
    return
  }
  await loadHistoryRecord(record)
}

function formatHugeOutputSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

async function exportHugeOutput(step: AgentStep) {
  const src = step.hugeOutput
  if (!src?.sourceFile || src.sourceLine == null) {
    toast.error(t('ai.hugeOutput.cannotExport'))
    return
  }
  try {
    const result = await window.electronAPI.history.exportHugeJsonlLine({
      sourceFile: src.sourceFile,
      sourceLine: src.sourceLine,
    })
    if (result.canceled) return
    if (!result.success) {
      toast.error(result.error || t('ai.hugeOutput.exportFailed'))
      return
    }
    toast.success(t('ai.hugeOutput.exported'))
  } catch (e) {
    log.error('export huge output failed:', e)
    toast.error(t('ai.hugeOutput.exportFailed'))
  }
}

// ==================== 确认框辅助函数 ====================

// 工具名称映射
const getToolDisplayName = (toolName: string) => {
  const key = `ai.toolNames.${toolName}`
  const translated = t(key)
  return translated !== key ? translated : toolName
}

// 格式化确认参数显示（简化显示）
const formatConfirmArgs = (confirm: typeof pendingConfirm.value) => {
  if (!confirm) return ''
  const args = confirm.toolArgs
  // 对于命令执行，只显示命令本身
  if (args.command) {
    return args.command as string
  }
  // 对于文件操作，显示路径
  if (args.path) {
    return args.path as string
  }
  // 邮件发送：结构化展示收件人/抄送/密送/主题/正文/附件
  if (confirm.toolName === 'email_send') {
    return formatEmailConfirmArgs(args)
  }
  // 其他情况显示 JSON
  return JSON.stringify(args, null, 2)
}

const autoReviewHandOverText = (reason?: string) => {
  const key = reason ? `ai.autoReviewReason.${reason}` : 'ai.autoReviewHandedOver'
  const translated = t(key)
  return translated !== key ? translated : t('ai.autoReviewHandedOver')
}

// 邮件发送确认卡片的结构化预览
const formatEmailConfirmArgs = (args: Record<string, unknown>): string => {
  const lines: string[] = []
  const to = typeof args.to === 'string' ? args.to : ''
  const subject = typeof args.subject === 'string' ? args.subject : ''
  const cc = typeof args.cc === 'string' ? args.cc : ''
  const bcc = typeof args.bcc === 'string' ? args.bcc : ''
  const body = typeof args.body === 'string' ? args.body : ''
  const html = typeof args.html === 'string' ? args.html : ''
  const attachments = Array.isArray(args.attachments) ? args.attachments.filter(Boolean) : []

  if (to) lines.push(`${t('email.to')}: ${to}`)
  if (cc) lines.push(`${t('email.cc')}: ${cc}`)
  if (bcc) lines.push(`${t('email.bcc')}: ${bcc}`)
  if (subject) lines.push(`${t('email.subject')}: ${subject}`)

  // 正文预览：html 优先标记为 HTML，否则展示纯文本（截断到 500 字符避免卡片过长）
  const PREVIEW_LIMIT = 500
  if (html) {
    const preview = html.length > PREVIEW_LIMIT ? html.slice(0, PREVIEW_LIMIT) + `… (${t('email.body_truncated')})` : html
    lines.push(`${t('email.body')} (HTML):`)
    lines.push(preview)
  } else if (body) {
    const preview = body.length > PREVIEW_LIMIT ? body.slice(0, PREVIEW_LIMIT) + `… (${t('email.body_truncated')})` : body
    lines.push(`${t('email.body')}:`)
    lines.push(preview)
  }

  if (attachments.length > 0) {
    lines.push(`${t('email.attachments')} (${attachments.length} ${t('email.files')}):`)
    attachments.forEach((filePath, i) => {
      lines.push(`  ${i + 1}. ${String(filePath)}`)
    })
  }

  return lines.join('\n')
}


const {
  approvalUiState,
  applyApprovalUiState,
  showFreeModeConfirm,
  confirmEnableFreeMode,
  cancelFreeMode,
} = useApprovalUiState(executionMode)

// 点击中的选项（用于即时视觉反馈，单选时使用）
const clickingOption = ref<string | null>(null)

// 用户已点选/回复、后端提问步还没标成已收到：本地立刻锁住，避免还能再点
const answeredAskStepId = ref<string | null>(null)

function hasUserReplyAfterAsk(
  step: { id: string },
  group?: { steps: { id: string; type: string }[] }
): boolean {
  if (!group) return false
  const idx = group.steps.findIndex(s => s.id === step.id)
  if (idx < 0) return false
  return group.steps.slice(idx + 1).some(s => s.type === 'user_supplement')
}

function isAskingInteractive(
  step: { id: string; askingStatus?: AskingStatus },
  group?: { steps: { id: string; type: string }[] }
): boolean {
  if (!isAgentRunning.value) return false
  if (isAskingSettled(step.askingStatus)) return false
  if (answeredAskStepId.value === step.id) return false
  if (hasUserReplyAfterAsk(step, group)) return false
  return true
}

function getAskingRecommended(step: { toolArgs?: { default_value?: unknown } }): string {
  const raw = step.toolArgs?.default_value
  return typeof raw === 'string' ? raw.trim() : ''
}

function getAskingOptions(step: { toolArgs?: { options?: unknown; default_value?: unknown } }): string[] {
  const raw = step.toolArgs?.options
  const options = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === 'string')
    : []
  const recommended = getAskingRecommended(step)
  if (!recommended || !options.includes(recommended)) return options.slice(0, 10)
  return [recommended, ...options.filter(option => option !== recommended)].slice(0, 10)
}

function isRecommendedAskOption(step: { toolArgs?: { default_value?: unknown } }, opt: string): boolean {
  const recommended = getAskingRecommended(step)
  return recommended !== '' && recommended === opt
}

function isAskOptionSelected(step: { id: string; toolResult?: string }, opt: string): boolean {
  if (getSelectedOptions(step.id).includes(opt)) return true
  if (clickingOption.value === opt && answeredAskStepId.value === step.id) return true
  return !!step.toolResult?.includes(opt)
}

function shouldShowAskingStatus(step: { toolResult?: string; askingStatus?: AskingStatus }): boolean {
  return step.askingStatus === 'timeout' || step.askingStatus === 'cancelled'
}

function getAskRemainingSeconds(step: { timestamp?: number; toolArgs?: { timeout?: unknown }; askingStatus?: AskingStatus }): number | null {
  if (step.askingStatus && step.askingStatus !== 'waiting') return null
  if (typeof step.timestamp !== 'number') return null
  const timeoutSec = clampAskUserTimeout(step.toolArgs?.timeout)
  return Math.max(0, timeoutSec - Math.floor((askClock.value - step.timestamp) / 1000))
}

function formatAskCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function markAskAnswered(stepId?: string | null) {
  if (stepId) answeredAskStepId.value = stepId
}

// 多选已选中的选项（stepId -> 已选选项数组）
const multiSelectOptions = ref<Map<string, string[]>>(new Map())

// 获取步骤的已选选项
const getSelectedOptions = (stepId: string): string[] => {
  return multiSelectOptions.value.get(stepId) || []
}

// 切换多选选项
const toggleMultiOption = (stepId: string, opt: string) => {
  const current = multiSelectOptions.value.get(stepId) || []
  const idx = current.indexOf(opt)
  if (idx === -1) {
    current.push(opt)
  } else {
    current.splice(idx, 1)
  }
  multiSelectOptions.value.set(stepId, [...current])
}

// 确认多选结果
const confirmMultiSelect = (stepId: string) => {
  const selected = multiSelectOptions.value.get(stepId) || []
  if (selected.length === 0) return
  if (answeredAskStepId.value === stepId) return
  markAskAnswered(stepId)
  sendAgentReply(JSON.stringify(selected))
}

// 处理选项点击（添加即时视觉反馈）
const handleOptionClick = (stepId: string, opt: string, allowMultiple: boolean) => {
  if (answeredAskStepId.value === stepId) return
  if (allowMultiple) {
    // 多选：切换选中状态
    toggleMultiOption(stepId, opt)
  } else {
    // 单选：直接发送
    clickingOption.value = opt
    markAskAnswered(stepId)
    sendAgentReply(opt)
  }
}

let visionWarningShown = false
const checkVisionSupport = async () => {
  if (visionWarningShown) return
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (!hasVision) {
    visionWarningShown = true
    const profile = activeAiProfile.value
    toast.warning(t('ai.visionNotSupported', { model: profile?.model || '' }), 6000)
  }
}

// 监听图片列表变化，有新图片时检测视觉支持
watch(() => pendingImages.value.length, (newLen, oldLen) => {
  if (newLen > oldLen) {
    checkVisionSupport()
  }
})

/**
 * 在发送前对"带图但当前模型不支持视觉"做硬拦截。
 * 返回 true 表示用户选择继续发送（带图字段会被后端剥掉），false 表示用户取消，调用方应中止发送。
 *
 * 提供三个动作：
 * - 取消（默认）：什么都不做
 * - 打开 AI 设置：跳到设置页让用户切换/关联视觉模型
 * - 仍然发送：继续走 runAgent，后端会自动剥图并注入提示，让 AI 主动告知用户「我没看到图」
 */
const guardVisionBeforeSend = async (): Promise<boolean> => {
  if (!hasImages()) return true
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (hasVision) return true

  const profile = activeAiProfile.value
  const proceed = await showConfirm({
    type: 'warning',
    title: t('ai.visionGuardTitle'),
    message: t('ai.visionGuardMessage', { model: profile?.model || t('ai.visionGuardCurrentModel') }),
    detail: t('ai.visionGuardDetail'),
    confirmText: t('ai.visionGuardSendAnyway'),
    cancelText: t('common.cancel'),
    neutralText: t('ai.visionGuardOpenSettings'),
    onNeutral: () => {
      showSettings?.()
    }
  })
  // 用户确认"仍然发送"——按钮文案承诺了"不带图"，所以这里立刻清掉 pendingImages，
  // 避免几 MB 的 base64 仍走渲染→主进程 IPC（后端虽然会兜底剥图，但传输已经发生了）。
  if (proceed) {
    discardImages()
    toast.info(t('ai.visionGuardImagesDropped'))
  }
  return proceed
}

// 粘贴：文本优先（有纯文本则默认贴字）；纯图/纯文件才拦截并走附件管道
const handlePaste = async (event: ClipboardEvent) => {
  const plan = planComposerPaste(event)
  if (plan.kind === 'default') return
  event.preventDefault()
  await ingestAttachmentFiles(plan.files)
}

const clearTabError = () => {
  if (currentTabId.value) {
    terminalStore.clearError(currentTabId.value)
  }
}

const handleComposerSubmit = async (
  message: string,
  options?: { workbenchContext?: import('@shared/types').WorkbenchContext; enqueue?: boolean }
) => {
  if (isEditingFollowUp.value) {
    await ensurePendingImagePaths()
    const pendingImagesOnly = getImageDataUrls()
    const images = [...pendingImagesOnly, ...getAllDocImages()]
    const previewImages = [...pendingImagesOnly, ...getDocPreviewImages()]
    const attachments = [
      ...uploadedDocs.value.map(d => ({
        filename: d.filename,
        filePath: d.filePath,
        fileSize: d.fileSize,
        fileType: d.fileType,
        totalPages: d.totalPages || d.pageCount,
        previewPages: d.images?.length
      })),
      ...getImageAttachments(),
    ]
    const documentContext = [
      await getDocumentContext(),
      getDocImagesContext()
    ].filter(Boolean).join('\n\n')
    await saveEditFollowUp({
      message,
      images: images.length > 0 ? images : undefined,
      previewImages: previewImages.length > 0 ? previewImages : undefined,
      pendingImages: pendingImagesOnly.length > 0 ? pendingImagesOnly : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      parsedDocs: uploadedDocs.value.length > 0 ? uploadedDocs.value.map(d => ({ ...d })) : undefined,
      documentContext: documentContext || undefined,
    })
    clearComposerDraft()
    clearImages()
    clearUploadedDocs()
    return
  }
  if (!(await guardVisionBeforeSend())) return
  await ensurePendingImagePaths()
  await runAgent(message, options)
}

const isComposerOccupiedForFollowUpEdit = () => {
  const hasText = !!composerRef.value?.getText()?.trim()
  const hasQuotes = composerQuoteStore.getSnippets(props.tabId).length > 0
  return hasText || pendingImages.value.length > 0 || uploadedDocs.value.length > 0 || hasQuotes
}

const handleBeginEditFollowUp = (id: string) => {
  if (isComposerOccupiedForFollowUpEdit()) {
    toast.warning(t('ai.followUpEditBlocked'))
    return
  }
  const item = beginEditFollowUp(id)
  if (!item) return
  composerRef.value?.setText(item.message)
  const restoreImages = item.pendingImages?.length
    ? item.pendingImages
    : (!item.parsedDocs?.length && item.images?.length ? item.images : [])
  if (restoreImages.length) {
    const imageAtts = (item.attachments ?? []).filter((a) => {
      const ext = (a.fileType || a.filename.split('.').pop() || '').toLowerCase().replace(/^\./, '')
      return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)
        || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename)
        || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filePath || '')
    })
    loadPendingImages(restoreImages.map((dataUrl, i) => {
      const att = imageAtts[i]
      return {
        id: `followup_edit_${item.id}_${i}`,
        dataUrl,
        name: att?.filename || `image_${i + 1}`,
        size: att?.fileSize ?? 0,
        filePath: att?.filePath,
        savedByApp: false,
      }
    }))
  } else {
    discardImages()
  }
  if (item.parsedDocs?.length && currentTabId.value) {
    terminalStore.setUploadedDocs(currentTabId.value, item.parsedDocs.map(d => ({ ...d })))
  } else {
    clearUploadedDocs()
  }
  nextTick(() => composerRef.value?.focusInput())
}

const handleCancelEditFollowUp = () => {
  cancelEditFollowUp()
  clearComposerDraft()
  discardImages()
  clearUploadedDocs()
  composerQuoteStore.clearSnippets(props.tabId)
}

const handleComposerEmptySubmit = async () => {
  if (isEditingFollowUp.value) {
    await handleComposerSubmit('')
  }
}

const clearComposerDraft = () => {
  composerRef.value?.clearText()
}

// ==================== 对外暴露的方法 ====================

/** 终端右键「发送到 AI」：加入引用胶囊（发送时再附带全文与行号），不自动跑 Agent */
function addQuotedTerminalSelection(text: string, tabTitle: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const label = tabTitle.trim() || t('ai.quoteSnippetTerminalTabFallback')
  addComposerQuote({
    label,
    sourcePath: null,
    sourceLinesAccurate: false,
    quoteOrigin: 'terminal',
    startLine: null,
    endLine: null,
    excerpt: trimmed
  })
}

/**
 * 通用「引用到 Composer」：终端选区 / 产出物 Markdown 选区经岗壳调用。
 * 不暴露 Pinia store；由 AiPanel 持有 composerQuoteStore。
 * 参数形状需与 `packages/workbench-assistant/src/artifact/composer-quote.ts` 的 ArtifactComposerQuote 保持同步。
 */
function addComposerQuote(snippet: {
  label: string
  sourcePath: string | null
  sourceLinesAccurate: boolean
  startLine: number | null
  endLine: number | null
  excerpt: string
  quoteOrigin?: 'canvas' | 'terminal'
}) {
  const trimmed = snippet.excerpt.trim()
  if (!trimmed) return
  composerQuoteStore.addSnippet(props.tabId, {
    ...snippet,
    excerpt: trimmed,
    quoteOrigin: snippet.quoteOrigin ?? 'canvas'
  })
  toast.success(t('ai.quoteSnippetAdded'))
  nextTick(() => composerRef.value?.focusInput())
}

/** @deprecated 请使用 addQuotedTerminalSelection；保留别名兼容旧调用 */
function analyzeText(text: string) {
  const tab = terminalStore.tabs.find((x) => x.id === props.tabId)
  addQuotedTerminalSelection(text, tab?.title ?? '')
}

/**
 * 产出物「截图反馈」：把预览截图加入 Composer 待发送图片区。
 * 由岗壳（AssistantWorkbench）从 ArtifactPanel 事件转发。
 */
async function addComposerImage(image: { dataUrl: string; name: string; width?: number; height?: number; filePath?: string }) {
  const added = await addImageDataUrl(image.dataUrl, image.name, image.width ?? 0, image.height ?? 0, image.filePath)
  if (!added) {
    toast.error(t('ai.composerImageLimit'))
    return
  }
  nextTick(() => composerRef.value?.focusInput())
}

/**
 * 设置 Composer 草稿文本，供「截图反馈」等面板动作注入意图。
 * 输入框已有内容时不覆盖（用户可能正在编辑），仅聚焦；不自动发送，用户确认后回车。
 */
function setComposerDraft(text: string) {
  const composer = composerRef.value
  if (!composer) return
  if (!composer.getText()?.trim()) {
    composer.setText(text)
  }
  nextTick(() => composer.focusInput())
}

function submitComposerMessage(text: string) {
  void composerRef.value?.submitPrepared?.(text)
}

// ==================== 定时任务 / 远程任务监听 ====================
// 监听定时任务 / 远程任务：当有 pendingSchedulerTask 时自动执行
// 触发时机：tab 切换到当前实例、或新的 pending task 被写入当前 tab
// 需要等待终端就绪（ptyId 已分配），否则 runAgent 会因 context.ptyId 为空而静默退出
const isMounted = ref(false)
watch(
  [
    () => terminalStore.activeTabId,
    () => terminalStore.pendingSchedulerTasks[currentTabId.value],
    isMounted,
    () => terminalStore.tabs.find(t => t.id === currentTabId.value)?.ptyId,
  ],
  ([_tabId, pendingTask, mounted, _ptyId]) => {
    if (!mounted || !pendingTask) return
    const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
    if (!tab?.ptyId && tab?.type !== 'assistant') return
    const task = terminalStore.consumePendingSchedulerTask(currentTabId.value)
    if (task) {
      console.log(`[AiPanel] 检测到待执行任务，自动执行: ${task.substring(0, 50)}...`)
      const latestProfileId = configStore.activeAiProfileId
      if (latestProfileId) {
        activeProfileId.value = latestProfileId
      }
      clearComposerDraft()
      void runAgent(task)
    }
  },
  { immediate: true }
)

// 欢迎页 composer handoff：文档已迁移到 tab，此处恢复图片并 runAgent
watch(
  [
    () => terminalStore.activeTabId,
    () => terminalStore.hubFocusedAssistantTabId,
    () => terminalStore.pendingComposerHandoffs[currentTabId.value],
    isMounted,
  ],
  async ([activeId, hubFocusedId, _handoff, mounted]) => {
    // 兼容 Hub 焦点模式（activeTabId 为空，hubFocusedAssistantTabId 为当前 tab）
    const isCurrentSurface = activeId === currentTabId.value || hubFocusedId === currentTabId.value
    if (!mounted || !isCurrentSurface) return
    const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
    if (tab?.type !== 'assistant') return
    const handoff = terminalStore.consumePendingComposerHandoff(currentTabId.value)
    if (!handoff) return

    if (handoff.images.length > 0) {
      loadPendingImages(handoff.images)
    }
    const latestProfileId = configStore.activeAiProfileId
    if (latestProfileId) {
      activeProfileId.value = latestProfileId
    }
    const { useConversationSkillsStore } = await import('../stores/conversation-skills')
    const skillsStore = useConversationSkillsStore()
    const finishWelcomeSkills = async () => {
      if (handoff.skillIds?.length) {
        await skillsStore.finishWelcomeHydration(currentTabId.value)
      }
    }
    if (!(await guardVisionBeforeSend())) {
      discardImages()
      await finishWelcomeSkills()
      return
    }
    clearComposerDraft()
    if (handoff.skillIds?.length) {
      for (const skillId of handoff.skillIds) {
        await skillsStore.pin(currentTabId.value, { id: skillId, name: skillId })
      }
      void finishWelcomeSkills()
    }
    void runAgent(handoff.message)
  },
  { immediate: true }
)

// 诞生引导：全局仅自动触发一次（独立助手任务 tab，不含联络）；
// 仅当前可见表面触发，避免 companion 后台挂载抢跑；用户跳过未完成 personality 也不再重复
let onboardingTriggered = false
watch(
  [
    isMounted,
    () => props.tabActive,
    () => configStore.agentOnboardingShown,
    () => configStore.agentOnboardingCompleted,
    isStandaloneAssistant,
    isCompanionTab,
  ],
  async ([mounted, tabActive, shown, completed, isAssistant, isCompanion]) => {
    if (!mounted || !tabActive || shown || completed || !isAssistant || isCompanion || onboardingTriggered) return
    if (terminalStore.consumeAssistantSkipOnboarding(currentTabId.value)) return
    if (!configStore.hasAiConfig) return
    onboardingTriggered = true
    await configStore.markAgentOnboardingShown()
    clearComposerDraft()
    await runAgent('__onboarding__')
  },
  { immediate: true }
)

// ==================== 诊断和分析（通过 Agent 执行） ====================

// 诊断错误（通过 Agent 执行）
const handleDiagnoseError = () => {
  const error = lastError.value
  if (!error || isLoading.value) return
  
  // 清除错误提示
  if (terminalStore.activeTab) {
    terminalStore.clearError(terminalStore.activeTab.id)
  }
  
  // 设置输入文本为诊断提示
  // 通过 Agent 执行分析
  clearComposerDraft()
  discardImages()
  void runAgent(`${t('ai.analyzeErrorPrompt')}\n\`\`\`\n${error.content}\n\`\`\``)
}

// 分析选中内容（通过 Agent 执行）
const handleAnalyzeSelection = () => {
  const selection = terminalSelectedText.value
  if (!selection || isLoading.value) return
  
  // 设置输入文本为分析提示
  // 通过 Agent 执行分析
  clearComposerDraft()
  discardImages()
  void runAgent(`${t('ai.analyzeOutputPrompt')}\n\`\`\`\n${selection}\n\`\`\``)
}

// ==================== 拖放处理（文档 / 图片附件） ====================

// ==================== 图片预览（支持缩放、拖拽、键盘导航） ====================
/** 活图渲染失败的 step id → 降级展示 step.images 静态 SVG 兜底 */
const echartsLiveFailedStepIds = reactive(new Set<string>())
const onEchartsLiveFailed = (stepId: string) => {
  echartsLiveFailedStepIds.add(stepId)
}

const previewImageUrl = ref<string | null>(null)
// 活图预览载荷：当点击"活图"（chart skill 投递的 echartsOption）时填入；
// 模态优先用 EChartsCanvas 渲染（保留 tooltip / dataZoom 等交互），否则降级到 <img>。
// 上下/左右导航触发时清空（导航目标可能是普通 SVG 图），让降级路径自然接管。
const previewEchartsPayload = ref<import('@shared/types').EChartsStepPayload | null>(null)
// 视口尺寸——给活图预览容器算"contain 进 90vw × 90vh 框"的具体 width/height。
// 不能纯靠 CSS（max-width/max-height + aspect-ratio）：父容器 .image-preview-modal-content
// 是 max-content sizing，子元素 EChartsCanvas 又要 width:100%——两边互相依赖塌陷为 0×0。
const winSize = ref({ w: 1024, h: 768 })
function updateWinSize() {
  if (typeof window !== 'undefined') {
    winSize.value = { w: window.innerWidth, h: window.innerHeight }
  }
}
// 大图预览的 EChartsCanvas 实例 ref——复制图片 / 另存为时通过 getDataURL() 拿当前
// (含用户交互后的 dataZoom 范围) 的高清 dataURL，比 step.images 里 SVG dataURL 更鲜活
const previewEchartsRef = ref<InstanceType<typeof EChartsCanvas> | null>(null)
// 弹窗根节点 ref。用于手动绑 wheel 事件并显式 { passive: false }——
// 模板里 @wheel.prevent 会让 Chrome 报"non-passive scroll-blocking"警告，
// 因为 Vue 的 patchEvent 不显式传 passive 参数。
const previewModalRef = ref<HTMLDivElement | null>(null)
const previewViewportRef = ref<HTMLDivElement | null>(null)
const previewScale = ref(1)
const previewTranslateX = ref(0)
const previewTranslateY = ref(0)
/** 用户是否改过缩放/平移（Esc 先还原，再关闭） */
const previewViewModified = ref(false)
const isDraggingImage = ref(false)
let dragStartX = 0
let dragStartY = 0
let dragStartTranslateX = 0
let dragStartTranslateY = 0

// 当前预览在 allPreviewImages 平铺列表中的位置，-1 表示不在对话图片列表中
const previewIdx = ref(-1)

interface PreviewItem {
  url: string
  echartsPayload?: import('@shared/types').EChartsStepPayload
}

// 收集所有对话中的图片，平铺成一维列表（不再按任务分组），上下翻页遍历整个列表。
// 一个 step 通常只有一张图但有一个 step.echartsOption——把 payload 关联到 step.images[0]，
// 后续图（如果有）走纯 <img> 兜底。
const allPreviewImages = computed((): PreviewItem[] => {
  const result: PreviewItem[] = []
  for (const group of agentTaskGroups.value) {
    if (group.images?.length) {
      for (const url of group.images) result.push({ url })
    }
    for (const step of group.steps) {
      if (!step.images?.length) continue
      const payload = step.echartsOption
      result.push({ url: step.images[0], echartsPayload: payload })
      for (let i = 1; i < step.images.length; i++) {
        result.push({ url: step.images[i] })
      }
    }
  }
  return result
})

const resetPreviewTransform = () => {
  previewScale.value = 1
  previewViewModified.value = false
  nextTick(() => centerPreviewContent())
}

const PREVIEW_MAX_WIDTH_VW = 0.9
const PREVIEW_MAX_HEIGHT_VH = 0.9
const PREVIEW_ABS_MAX_WIDTH = 1600

/** contain 进 max 区域，返回像素尺寸（小图不放大） */
const computePreviewContainSize = (contentW: number, contentH: number) => {
  const ratio = contentW / Math.max(1, contentH)
  const maxW = Math.min(winSize.value.w * PREVIEW_MAX_WIDTH_VW, PREVIEW_ABS_MAX_WIDTH, contentW)
  const maxH = Math.min(winSize.value.h * PREVIEW_MAX_HEIGHT_VH, contentH)
  let w = maxW
  let h = w / ratio
  if (h > maxH) {
    h = maxH
    w = h * ratio
  }
  return { w: Math.round(w), h: Math.round(h) }
}

/** 图片/活图在 viewport 内的 fit 尺寸（非 viewport 本身尺寸） */
const previewImgContentSize = ref<{ w: number; h: number } | null>(null)

const getPreviewContentSize = (): { w: number; h: number } | null => {
  if (previewEchartsPayload.value) {
    const { width: pw, height: ph } = previewEchartsPayload.value
    return computePreviewContainSize(pw, ph)
  }
  return previewImgContentSize.value
}

/** 默认视图：viewport 与内容同尺寸，translate 为 0 */
const centerPreviewContent = () => {
  previewTranslateX.value = 0
  previewTranslateY.value = 0
}

const updatePreviewImgContentSize = (img: HTMLImageElement) => {
  if (!img.naturalWidth) return
  previewImgContentSize.value = computePreviewContainSize(img.naturalWidth, img.naturalHeight)
}

const onPreviewImgLoad = (e: Event) => {
  const img = e.target as HTMLImageElement
  updatePreviewImgContentSize(img)
  if (!previewViewModified.value) {
    previewScale.value = 1
    nextTick(() => centerPreviewContent())
  }
}

const openImagePreview = (
  url: string,
  echartsPayload?: import('@shared/types').EChartsStepPayload
) => {
  previewImageUrl.value = url
  previewEchartsPayload.value = echartsPayload ?? null
  previewImgContentSize.value = null
  resetPreviewTransform()
  previewIdx.value = allPreviewImages.value.findIndex(it => it.url === url)
}

const closeImagePreview = () => {
  previewImageUrl.value = null
  previewEchartsPayload.value = null
  // previewEchartsRef.value 由 Vue 在子组件 unmount 时自动写回 null，无需手动清零
  isDraggingImage.value = false
}

// ==================== 图片右键菜单 ====================
const { copyImage } = useImageActions()
const imageContextMenu = reactive<{ show: boolean; x: number; y: number; url: string | null; defaultName: string }>({
  show: false, x: 0, y: 0, url: null, defaultName: 'image'
})

const openImageContextMenu = (e: MouseEvent, url: string, defaultName = 'image') => {
  e.preventDefault()
  e.stopPropagation()
  imageContextMenu.show = true
  imageContextMenu.x = e.clientX
  imageContextMenu.y = e.clientY
  imageContextMenu.url = url
  imageContextMenu.defaultName = defaultName
}

const getMermaidPreviewUrl = (target: EventTarget | null): string | null => {
  const block = (target as HTMLElement | null)?.closest?.(
    '.mermaid-block[data-mermaid-state="done"]'
  ) as HTMLElement | null
  if (!block) return null
  const svg = block.querySelector('svg') as SVGSVGElement | null
  if (!svg) return null
  return mermaidSvgToDataUrl(svg)
}

// Mermaid 图单击放大：复用图片预览弹窗（滚轮缩放、拖拽平移、双击重置）
const handleMermaidClick = (e: MouseEvent) => {
  const url = getMermaidPreviewUrl(e.target)
  if (!url) return
  e.preventDefault()
  e.stopPropagation()
  openImagePreview(url)
}

// Mermaid 图右键菜单：右击已渲染完成的图，把其 SVG 序列化成 data URL 后复用图片右键菜单（复制/下载）
const handleMermaidContextMenu = (e: MouseEvent) => {
  const url = getMermaidPreviewUrl(e.target)
  if (!url) return
  openImageContextMenu(e, url, 'diagram')
}

// 「活图」EChartsCanvas 触发右键菜单时,组件 emit 的载荷形如 { event, dataUrl }——
// 模板里直接写带 TS 类型的内联箭头函数会被 Vue 模板编译器拒（它不支持模板表达式里的
// 类型注解）；抽到 <script setup> 里做薄包装后模板写法回退到无类型的 @contextmenu="onEchartsContextMenu"
const onEchartsContextMenu = (payload: { event: MouseEvent; dataUrl: string }) => {
  openImageContextMenu(payload.event, payload.dataUrl)
}

const closeImageContextMenu = () => {
  imageContextMenu.show = false
  imageContextMenu.url = null
}

// ==================== 附件右键菜单 / 点击打开 ====================
const { openAttachment } = useAttachmentActions()
const attachmentContextMenu = reactive<{
  show: boolean
  x: number
  y: number
  filename: string | null
  filePath: string | null
}>({
  show: false, x: 0, y: 0, filename: null, filePath: null
})

const openAttachmentFile = (file: AttachmentInfo) => {
  void openAttachment(file)
}

const openAttachmentContextMenu = (e: MouseEvent, file: AttachmentInfo) => {
  e.preventDefault()
  e.stopPropagation()
  attachmentContextMenu.show = true
  attachmentContextMenu.x = e.clientX
  attachmentContextMenu.y = e.clientY
  attachmentContextMenu.filename = file.filename
  attachmentContextMenu.filePath = file.filePath ?? null
}

const closeAttachmentContextMenu = () => {
  attachmentContextMenu.show = false
  attachmentContextMenu.filename = null
  attachmentContextMenu.filePath = null
}

const navigatePreviewTo = (idx: number) => {
  const list = allPreviewImages.value
  if (idx < 0 || idx >= list.length) return
  const item = list[idx]
  previewIdx.value = idx
  previewImageUrl.value = item.url
  previewEchartsPayload.value = item.echartsPayload ?? null
  resetPreviewTransform()
}

const canGoUp = computed(() => previewIdx.value > 0)
const canGoDown = computed(() => previewIdx.value >= 0 && previewIdx.value < allPreviewImages.value.length - 1)

const goUp = () => navigatePreviewTo(previewIdx.value - 1)
const goDown = () => navigatePreviewTo(previewIdx.value + 1)

// 滚轮/触控板：Mac 双指滑动 → 平移；捏合（ctrlKey）或鼠标滚轮 → 缩放
const PREVIEW_PINCH_ZOOM_SENSITIVITY = 0.01 // 捏合灵敏度（越小越慢）
const PREVIEW_WHEEL_ZOOM_STEP = 0.1 // 鼠标滚轮每档缩放比例

const clampPreviewScale = (scale: number) => Math.max(0.1, Math.min(10, scale))

/** 以指针为锚点缩放（translate 与 mx/my 均在 previewViewport 坐标系内） */
const applyPreviewZoomAt = (newScale: number, clientX: number, clientY: number) => {
  const oldScale = previewScale.value
  newScale = clampPreviewScale(newScale)
  if (newScale === oldScale) return

  const viewport = previewViewportRef.value
  if (!viewport) {
    previewScale.value = newScale
    return
  }

  const vpRect = viewport.getBoundingClientRect()
  const mx = clientX - vpRect.left
  const my = clientY - vpRect.top
  const ratio = newScale / oldScale

  previewTranslateX.value = mx - (mx - previewTranslateX.value) * ratio
  previewTranslateY.value = my - (my - previewTranslateY.value) * ratio
  previewScale.value = newScale
  previewViewModified.value = true
}

const handlePreviewWheel = (e: WheelEvent) => {
  e.preventDefault()

  // macOS 双指捏合、Windows 精准触控板捏合、Ctrl+滚轮
  if (e.ctrlKey) {
    const factor = Math.exp(-e.deltaY * PREVIEW_PINCH_ZOOM_SENSITIVITY)
    applyPreviewZoomAt(previewScale.value * factor, e.clientX, e.clientY)
    return
  }

  // 触控板双指滑动（pixel 模式）：平移，与 macOS 预览/地图惯例一致
  if (e.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
    previewTranslateX.value -= e.deltaX
    previewTranslateY.value -= e.deltaY
    previewViewModified.value = true
    return
  }

  // 鼠标滚轮（line/page 模式）：缩放
  const delta = e.deltaY > 0 ? -PREVIEW_WHEEL_ZOOM_STEP : PREVIEW_WHEEL_ZOOM_STEP
  applyPreviewZoomAt(previewScale.value + delta * previewScale.value, e.clientX, e.clientY)
}

// 显式以 { passive: false } 绑定 wheel——告诉浏览器我们故意要 preventDefault（缩放/平移），
// 避免模板 @wheel.prevent 触发 "non-passive scroll-blocking" 警告。
// previewModalRef 是 v-if 元素，每次弹窗出现/关闭都会重新挂载/卸载。
watch(previewModalRef, (el, _old, onCleanup) => {
  if (!el) return
  el.addEventListener('wheel', handlePreviewWheel, { passive: false })
  onCleanup(() => el.removeEventListener('wheel', handlePreviewWheel))
})

// 双击重置
const handlePreviewDblClick = () => resetPreviewTransform()

// 拖拽平移
const handlePreviewMouseDown = (e: MouseEvent) => {
  if (e.button !== 0) return
  // 「活图」预览模态：mousedown 落在 EChartsCanvas 内部时直接放行——echarts 自己要用
  // mousedown 启动 dataZoom 拖动 / brush 框选 / legend 点击等核心交互，外层包装的
  // 「拖动平移」一旦抢断这个事件就把活图最值钱的能力废掉了。空白区域（图表四周的
  // padding）仍然走拖动平移，保持普通预览的视觉操作惯例。
  // 地图（map series）缩放/平移走外层 CSS transform（与 PNG/JPG 一致），不在 echarts roam。
  // 注意：用 closest 而不是 ===，因为 echarts SVG renderer 渲染出来的 <g><path> 等
  // 子节点是真正的事件 target，不是 .echarts-canvas 这个父容器
  const payload = previewEchartsPayload.value
  const isMapLiveChart = payload ? optionHasMapSeries(payload.option) : false
  if (
    payload &&
    !isMapLiveChart &&
    (e.target as HTMLElement | null)?.closest?.('.echarts-canvas')
  ) {
    return
  }
  e.preventDefault()
  isDraggingImage.value = true
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragStartTranslateX = previewTranslateX.value
  dragStartTranslateY = previewTranslateY.value
  
  const handleMouseMove = (ev: MouseEvent) => {
    if (!isDraggingImage.value) return
    previewTranslateX.value = dragStartTranslateX + (ev.clientX - dragStartX)
    previewTranslateY.value = dragStartTranslateY + (ev.clientY - dragStartY)
    previewViewModified.value = true
  }
  const handleMouseUp = () => {
    isDraggingImage.value = false
    document.removeEventListener('mousemove', handleMouseMove)
    document.removeEventListener('mouseup', handleMouseUp)
  }
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', handleMouseUp)
}

// 预览 transform：origin 0 0 + viewport 坐标，与 applyPreviewZoomAt 同一套数学
const previewTransformStyle = computed<Record<string, string>>(() => ({
  transform: `translate(${previewTranslateX.value}px, ${previewTranslateY.value}px) scale(${previewScale.value})`,
  transformOrigin: '0 0',
}))

// 内容层尺寸 + transform；viewport 随内容收缩，overflow:visible 保证放大不被裁切
const previewViewportStyle = computed<Record<string, string>>(() => {
  const size = getPreviewContentSize()
  if (!size) return { width: 'min(90vw, 400px)', height: 'min(90vh, 400px)' }
  return { width: `${size.w}px`, height: `${size.h}px` }
})

const previewContentBoxStyle = computed<Record<string, string>>(() => {
  const size = getPreviewContentSize()
  if (!size) return { ...previewTransformStyle.value }
  return {
    width: `${size.w}px`,
    height: `${size.h}px`,
    ...previewTransformStyle.value,
  }
})

watch(winSize, () => {
  if (!previewImageUrl.value || previewViewModified.value) return
  const img = previewViewportRef.value?.querySelector('img.image-preview-full') as HTMLImageElement | null
  if (img?.naturalWidth) updatePreviewImgContentSize(img)
  nextTick(() => centerPreviewContent())
})

watch(previewEchartsPayload, () => {
  if (previewImageUrl.value && !previewViewModified.value) {
    nextTick(() => centerPreviewContent())
  }
})

// 拖放放下（支持文档和图片）—— 由 useFileDropTarget 处理

// ==================== 键盘事件处理 ====================

const handleKeyDown = (e: KeyboardEvent) => {
  // 图片预览模式下的键盘操作
  if (previewImageUrl.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopImmediatePropagation()
      if (previewViewModified.value) {
        resetPreviewTransform()
      } else {
        closeImagePreview()
      }
      return
    }
    // Cmd/Ctrl+C 复制当前预览的大图（仅在没有文本选区时触发，避免覆盖正常的文本复制）
    if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
      const sel = window.getSelection()?.toString()
      if (!sel) {
        e.preventDefault()
        e.stopImmediatePropagation()
        // 「活图」预览时优先用 echarts 实例的 getDataURL 拿当前实时（含用户拖过的 dataZoom）
        // 高清 PNG，比把后端 SVG 兜底图再 canvas 转一遍质量更好；普通图沿用 previewImageUrl
        const url = previewEchartsRef.value?.getDataURL('png') || previewImageUrl.value
        if (url) copyImage(url).catch(() => { /* toast 已显示 */ })
        return
      }
    }
    // 缩放状态下左右方向键用于平移；上下方向键始终用于切图（平铺列表上下翻页）
    if (previewScale.value !== 1) {
      const PAN_STEP = 50
      if (e.key === 'ArrowLeft') { e.preventDefault(); previewTranslateX.value += PAN_STEP; previewViewModified.value = true; return }
      if (e.key === 'ArrowRight') { e.preventDefault(); previewTranslateX.value -= PAN_STEP; previewViewModified.value = true; return }
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); goUp(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); goDown(); return }
    return
  }
  // ESC 键关闭弹窗
  if (e.key === 'Escape') {
    if (showFreeModeConfirm.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      cancelFreeMode()
      return
    }
    if (showHistoryModal.value) {
      e.preventDefault()
      e.stopImmediatePropagation()
      closeHistoryModal()
    }
  }
}

// ==================== 生命周期 ====================

watch(messagesRef, (el, oldEl) => {
  if (oldEl) {
    oldEl.removeEventListener('scroll', updateScrollPosition)
    oldEl.removeEventListener('click', handleCodeBlockClick)
    oldEl.removeEventListener('click', handleMermaidClick)
    oldEl.removeEventListener('contextmenu', handleFilePathContextMenu)
    oldEl.removeEventListener('contextmenu', handleMermaidContextMenu)
  }
  if (el) {
    el.addEventListener('scroll', updateScrollPosition, { passive: true })
    el.addEventListener('click', handleCodeBlockClick)
    el.addEventListener('click', handleMermaidClick)
    el.addEventListener('contextmenu', handleFilePathContextMenu)
    el.addEventListener('contextmenu', handleMermaidContextMenu)
    attachMermaidObserver(el)
  } else {
    detachMermaidObserver()
  }
}, { flush: 'post' })

const getPreviewHints = (attachments?: { totalPages?: number; previewPages?: number; filename: string }[]) => {
  if (!attachments) return []
  return attachments.filter(a => a.totalPages && a.previewPages && a.totalPages! > a.previewPages!)
}

const scrollHistoryToBottom = () => {
  if (scrollerRef.value) {
    scrollerRef.value.scrollToBottom?.()
  } else {
    void scrollToBottom()
  }
}

/**
 * 滚到对话流中指定 Agent step 并短暂高亮。
 * 由岗壳（如 AssistantWorkbench）经 ref 调用；产出物「跳到生成处」走此接口。
 */
async function scrollToAgentStep(stepId: string) {
  // 目标可能收在某条折叠行里：先把那行点开，再滚到它所在的那一格
  const foldedIndex = flattenedItems.value.findIndex(
    item => item.type === 'folded_turn' && item.fold?.stepIds.includes(stepId)
  )
  if (foldedIndex >= 0) {
    const folded = flattenedItems.value[foldedIndex]
    if (folded.fold && !folded.expanded) {
      toggleProcessFold(folded.fold.id)
      await nextTick()
    }
    await nextTick()
    scrollerRef.value?.scrollToIndex?.(foldedIndex)
    highlightedSourceStepId.value = stepId
    window.setTimeout(() => {
      if (highlightedSourceStepId.value === stepId) {
        highlightedSourceStepId.value = null
      }
    }, 2500)
    return
  }

  const index = flattenedItems.value.findIndex(
    item => item.type === 'step' && item.step?.id === stepId
  )
  if (index < 0) return

  await nextTick()
  scrollerRef.value?.scrollToIndex?.(index)
  highlightedSourceStepId.value = stepId
  window.setTimeout(() => {
    if (highlightedSourceStepId.value === stepId) {
      highlightedSourceStepId.value = null
    }
  }, 2500)
}

function isPeekNeedsYouItem(item: VirtualItem): boolean {
  if (item.type === 'confirm' || item.type === 'waiting_input') return true
  if (item.step?.type === 'waiting_password') return true
  if (item.step?.type !== 'asking') return false
  const groupId = peekRunGroupId.value
  if (groupId && item.group?.id !== groupId) return false
  return isAskingInteractive(item.step, item.group)
}

const peekNeedsYou = computed(() => {
  if (pendingConfirm.value || pendingSecureInput.value) return true
  return flattenedItems.value.some(isPeekNeedsYouItem)
})

const peekFoldSay = computed<ProcessFoldSay>(() => ({
  working: t('ai.processFold.working'),
  thinking: t('ai.processFold.thinking'),
  thought: t('ai.processFold.thought'),
  colleagues: n => t('ai.processFold.colleagues', { n }),
  doing: kind => t(`ai.processFold.doing.${kind}`),
  counted: (kind, n) => t(`ai.processFold.${kind}`, { n }),
  sep: t('ai.processFold.sep'),
}))

const peekRunGroupId = computed(() => {
  const groups = agentTaskGroups.value
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i].isCurrentTask && !groups[i].finalResult) return groups[i].id
  }
  return isAgentRunning.value ? groups[groups.length - 1]?.id : undefined
})

const peekSpoken = computed(() => {
  const groups = agentTaskGroups.value
  if (groups.length === 0) return ''
  return lastSpokenBody(groups[groups.length - 1].steps || [])
})

const peekExpanded = ref(false)
function isPeekProcessItem(item: VirtualItem, groupId: string): boolean {
  if (item.group?.id !== groupId) return false
  if (item.type === 'folded_turn') return !!item.fold
  if (item.type !== 'step' || !item.step) return false
  if (isPeekNeedsYouItem(item)) return false
  if (item.part === 'body') return false
  const stepType = item.step.type
  return stepType === 'thinking' || stepType === 'tool_call' || stepType === 'tool_result' || item.part === 'thinking'
}

const peekProcessView = computed(() => {
  const groupId = peekRunGroupId.value
  const group = groupId
    ? agentTaskGroups.value.find(g => g.id === groupId)
    : undefined
  const items = groupId
    ? flattenedItems.value.filter(item => isPeekProcessItem(item, groupId))
    : []
  return buildPeekProcessView({
    isRunning: isAgentRunning.value,
    steps: [...(group?.steps || []), ...(group?.afterEndSteps || [])],
    items,
  })
})

const peekProcessFold = computed(() => peekProcessView.value.liveFold)

const peekLiveText = computed(() => {
  const liveFold = peekProcessFold.value?.fold
  if (liveFold) return formatProcessFoldCaption(liveFold, peekFoldSay.value)
  const steps = peekProcessView.value.liveSteps
  if (steps.length === 0) return ''
  return formatProcessFoldCaption(describeLiveProcess(steps), peekFoldSay.value)
})

const focusPeek = computed(() => resolveFocusPeek({
  needsYou: peekNeedsYou.value,
  isRunning: isAgentRunning.value,
  liveText: peekLiveText.value,
  spoken: peekSpoken.value,
}))

const displayItems = computed(() => {
  if (!props.peek) return flattenedItems.value
  if (peekNeedsYou.value) return flattenedItems.value.filter(isPeekNeedsYouItem)
  return []
})

const peekAskItems = computed(() =>
  displayItems.value.filter(item => item.type === 'step')
)

const peekSurface = computed(() => resolvePeekOverlay({
  needsYou: peekNeedsYou.value,
  needsYouCount: props.peek
    ? countPeekNeedsYou({
        interactiveAskCount: peekAskItems.value.length,
        hasConfirm: !!pendingConfirm.value,
        hasSecure: !!pendingSecureInput.value,
      })
    : 0,
  processCount: peekProcessView.value.items.length,
  isRunning: isAgentRunning.value,
  liveText: peekLiveText.value,
  spoken: peekSpoken.value,
}))
watch(
  () => props.peek && peekSurface.value === 'spoken',
  (shown) => { if (!shown) peekExpanded.value = false },
)

const peekFallbackFold = computed((): ProcessFoldView => {
  const groupId = peekRunGroupId.value
  const steps = peekProcessView.value.liveSteps
  const view = describeLiveProcess(steps)
  return {
    id: `peek-live-${groupId || 'run'}-${steps[0]?.id || 'start'}`,
    counts: view.counts,
    live: true,
    liveText: view.liveText,
    liveAction: view.liveAction,
    liveColleagueCount: view.liveColleagueCount,
    thinkingOnly: view.thinkingOnly,
    waitingHint: false,
    startedAt: steps[0]?.timestamp,
    stepIds: [],
  }
})

const peekFallbackChildren = computed(() => {
  const groupId = peekRunGroupId.value
  const group = groupId
    ? agentTaskGroups.value.find(g => g.id === groupId)
    : undefined
  if (!group) return []
  return peekProcessView.value.expandSteps.map((step, i) => ({
    id: `peek-step-${step.id}`,
    type: 'step' as const,
    step,
    group,
    size: 40,
    isFirstStep: i === 0,
  }))
})

const peekFallbackOpen = ref(false)
watch(() => peekFallbackFold.value.id, (id, prev) => {
  if (id !== prev) peekFallbackOpen.value = false
})

const peekProcessChildren = computed(() => peekFallbackChildren.value)

defineExpose({ analyzeText, addQuotedTerminalSelection, addComposerQuote, addComposerImage, setComposerDraft, submitComposerMessage, scrollToAgentStep })

/** 首次展示从历史恢复的对话（尚无已存滚动位置）→ 应滚到底部 */
const shouldScrollHistoryOnShow = () =>
  !!currentTabId.value &&
  isLoadedFromHistory.value &&
  terminalStore.getAiScrollTop(currentTabId.value) === undefined &&
  flattenedItems.value.length > 0

/** @deprecated virtua 无需手动 forceUpdate；保留空函数以兼容调用点，可后续清理 */
const warmupMessageList = () => {}

onMounted(() => {
  isMounted.value = true
  loadHostProfile()
  updateWinSize()
  window.addEventListener('resize', updateWinSize)
  document.addEventListener('keydown', handleKeyDown)
  // 捕获阶段：终端聚焦时 Ctrl+字母 的 keydown 可能无法冒泡到 document，导致无法用「第二键」取消以 Control 为 PTT 键时的长按计时
  document.addEventListener('keydown', handlePTTKeyDown, true)
  document.addEventListener('keyup', handlePTTKeyUp, true)
  window.addEventListener('blur', handlePTTWindowBlur)

  // 音频设备检测和 toast 已提升到 App.vue 全局执行一次。
  // 仅当 pack 已安装时预加载 worker；未装不主动 toast（麦克风点击仍会引导）。
  if (configStore.keyboardShortcuts.voiceInput && audioAvailable.value) {
    void refreshSpeechPackAvailability().then((ok) => {
      if (ok) void initSpeech()
    })
  }

  warmupMessageList()

  if (
    props.tabActive &&
    terminalStore.assistantComposerFocusTabId === props.tabId
  ) {
    tryFocusComposer()
  }

  // 首次挂载且无已存滚动位置时滚到底部（含从历史打开的新 tab）
  const shouldInitialScrollBottom =
    !!currentTabId.value &&
    terminalStore.getAiScrollTop(currentTabId.value) === undefined &&
    flattenedItems.value.length > 0

  if (shouldInitialScrollBottom) {
    scrollToHistoryBottomWithRetry({ hideUntilSettled: true })
  }
})

// 远程任务：首条 step 到达后滚到底部（非历史恢复场景）
watch(
  () => flattenedItems.value.length,
  (len, prev) => {
    if (len > 0 && (prev ?? 0) === 0 && !isLoadedFromHistory.value) {
      void nextTick(() => scrollHistoryToBottom())
    }
  }
)

onUnmounted(() => {
  clearPTTStopTimer()
  window.removeEventListener('resize', updateWinSize)
  document.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('keydown', handlePTTKeyDown, true)
  document.removeEventListener('keyup', handlePTTKeyUp, true)
  window.removeEventListener('blur', handlePTTWindowBlur)
  const el = messagesRef.value
  if (el) {
    el.removeEventListener('scroll', updateScrollPosition)
    el.removeEventListener('click', handleCodeBlockClick)
    el.removeEventListener('click', handleMermaidClick)
    el.removeEventListener('contextmenu', handleFilePathContextMenu)
    el.removeEventListener('contextmenu', handleMermaidContextMenu)
  }
  detachMermaidObserver()
})

// 监听 visible 变化（用户折叠/展开 AI 侧栏），保存和恢复滚动位置
watch(() => props.visible, async (visible, wasVisible) => {
  if (!visible && wasVisible) {
    // 面板隐藏时，保存当前滚动位置
    saveScrollTop()
  } else if (visible && wasVisible === false) {
    // 面板显示时：确认框滚底；首次展示历史对话滚底；否则恢复上次滚动位置
    warmupMessageList()
    await nextTick()
    if (pendingConfirm.value || pendingSecureInput.value) {
      // 确认框场景只滚不存，避免覆盖用户为阅读上下文手动上滚的位置
      scrollHistoryToBottom()
      setTimeout(() => scrollHistoryToBottom(), 150)
    } else if (shouldScrollHistoryOnShow()) {
      scrollToHistoryBottomWithRetry({ hideUntilSettled: true })
    } else {
      await restoreScrollTop()
    }
  }
}, { flush: 'post' })

// 切 tab：离开时在 DOM 仍可见阶段快照滚动（sync）；回到时在 v-show 展开后恢复（post）
watch(() => props.tabActive, (active, wasActive) => {
  if (!active && wasActive) {
    saveScrollTop()
  }
}, { flush: 'sync' })

watch(() => props.tabActive, async (active, wasActive) => {
  if (!active || wasActive !== false) return
  await nextTick()
  if (pendingConfirm.value || pendingSecureInput.value) {
    scrollHistoryToBottom()
    setTimeout(() => scrollHistoryToBottom(), 150)
  } else if (shouldScrollHistoryOnShow()) {
    scrollToHistoryBottomWithRetry({ hideUntilSettled: true })
  } else {
    await restoreScrollPositionOnTabActivate()
  }
}, { flush: 'post' })

// 监听 tabId 变化（用于分屏模式下切换激活窗格）
watch(() => props.tabId, async (newTabId, oldTabId) => {
  if (oldTabId && messagesRef.value) {
    terminalStore.setAiScrollTop(oldTabId, messagesRef.value.scrollTop)
  }

  if (newTabId) {
    await nextTick()
    await restoreScrollTop()
  }
}, { flush: 'post' })
</script>

<template>
  <div 
    class="ai-panel"
    :class="{
      'mode-strict': executionMode === 'strict',
      'mode-relaxed': executionMode === 'relaxed',
      'mode-free': executionMode === 'free',
      'is-peek': peek,
      'is-peek-needs-you': peek && peekNeedsYou
    }"
    @dragenter="handleDragEnter"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 拖放提示覆盖层 -->
    <DropOverlay
      v-if="isFileDragOver"
      :title="t('ai.dropToUpload')"
      :hint="t('ai.dropHint')"
    >
      <template #icon>
        <Upload :size="48" :stroke-width="1.5" />
      </template>
    </DropOverlay>

    <!-- 未配置 AI 提示 -->
    <div v-if="!hasAiConfig" class="ai-no-config">
      <HelpCircle :size="48" :stroke-width="1.5" />
      <p>{{ t('ai.noConfig') }}</p>
      <button class="btn btn-primary btn-sm" @click="showSettings?.()">
        {{ t('ai.goToSettings') }}
      </button>
    </div>

    <template v-else>
      <!-- 自由模式确认对话框 -->
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
            <button class="btn btn-sm btn-outline" @click="cancelFreeMode">
              {{ t('common.no') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="confirmEnableFreeMode">
              {{ t('common.yes') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 顶栏兼窗口拖动条；助手页没有主机信息时也要留着 -->
      <div v-if="!peek" class="system-info-bar">
        <div v-if="currentSystemInfo" class="system-info-left host-info-trigger">
          <span class="system-icon">💻</span>
          <span class="system-text">
            {{ currentSystemInfo.os === 'windows' ? 'Windows' : currentSystemInfo.os === 'macos' ? 'macOS' : 'Linux' }}
            · {{ currentSystemInfo.shell === 'powershell' ? 'PowerShell' : currentSystemInfo.shell === 'cmd' ? 'CMD' : currentSystemInfo.shell === 'bash' ? 'Bash' : currentSystemInfo.shell === 'zsh' ? 'Zsh' : currentSystemInfo.shell }}
          </span>
          <span class="hover-hint">▾</span>
        </div>
        <!-- 悬浮主机信息面板（固定锚定在信息栏左侧） -->
        <div v-if="currentSystemInfo" class="host-info-popover">
          <div class="popover-header">
            <span>🖥️ {{ t('ai.agentWelcome.hostInfo') }}</span>
            <button 
              class="refresh-btn" 
              @click.stop="refreshHostProfile" 
              :disabled="isProbing"
              :title="isProbing ? t('ai.agentWelcome.probing') : t('ai.agentWelcome.refreshHost')"
            >
              <span :class="{ spinning: isProbing }">🔄</span>
            </button>
          </div>
          <div v-if="currentHostProfile" class="popover-content">
            <div class="info-row">
              <span class="info-label">{{ t('ai.agentWelcome.hostname') }}:</span>
              <span class="info-value">{{ currentHostProfile.hostname || t('common.unknown') }}</span>
              <span v-if="currentHostProfile.username" class="info-secondary">@ {{ currentHostProfile.username }}</span>
            </div>
            <div v-if="currentHostProfile.osVersion || currentHostProfile.os" class="info-row">
              <span class="info-label">{{ t('ai.agentWelcome.system') }}:</span>
              <span class="info-value">{{ currentHostProfile.osVersion || currentHostProfile.os }}</span>
            </div>
            <div v-if="currentHostProfile.shell" class="info-row">
              <span class="info-label">{{ t('ai.agentWelcome.shell') }}:</span>
              <span class="info-value">{{ currentHostProfile.shell }}</span>
              <span v-if="currentHostProfile.packageManager" class="info-secondary">| {{ currentHostProfile.packageManager }}</span>
            </div>
            <div v-if="currentHostProfile.installedTools?.length" class="info-row tools-row">
              <span class="info-label">{{ t('ai.agentWelcome.tools') }}:</span>
              <span class="info-value tools-list">{{ currentHostProfile.installedTools.join(', ') }}</span>
            </div>
          </div>
          <div v-else-if="isLoadingProfile" class="popover-loading">
            {{ t('common.loading') }}
          </div>
          <div v-else class="popover-empty">
            {{ t('ai.agentWelcome.notProbed') }}
          </div>
        </div>
      </div>

      <!-- 错误诊断提示（Agent 执行时隐藏） -->
      <div v-if="lastError && !isAgentRunning" class="error-alert">
        <div class="error-alert-icon">⚠️</div>
        <div class="error-alert-content">
          <div class="error-alert-title">{{ t('ai.errorDetected') }}</div>
          <div class="error-alert-text">{{ lastError.content.slice(0, 80) }}{{ lastError.content.length > 80 ? '...' : '' }}</div>
        </div>
        <button class="error-alert-btn" @click="handleDiagnoseError" :disabled="isLoading">
          {{ t('ai.aiDiagnose') }}
        </button>
        <button class="error-alert-close" @click="terminalStore.clearError(currentTabId)" :title="t('ai.closeError')">
          <X :size="14" />
        </button>
      </div>

      <!-- 终端选中内容提示（Agent 执行时隐藏） -->
      <div v-if="terminalSelectedText && !lastError && !isAgentRunning" class="selection-alert">
        <div class="selection-alert-icon">📋</div>
        <div class="selection-alert-content">
          <div class="selection-alert-title">{{ t('ai.selectedContent') }}</div>
          <div class="selection-alert-text">{{ terminalSelectedText.slice(0, 60) }}{{ terminalSelectedText.length > 60 ? '...' : '' }}</div>
        </div>
        <button class="selection-alert-btn" @click="handleAnalyzeSelection" :disabled="isLoading">
          {{ t('ai.aiAnalyze') }}
        </button>
      </div>

      <!-- Plan 固定顶部区域 -->
      <div v-if="currentPlan && !peek" class="plan-sticky-header">
        <AgentPlanView 
          :plan="currentPlan" 
          :compact="!planExpanded" 
          @toggle="planExpanded = !planExpanded" 
        />
      </div>

      <!-- 消息列表（虚拟滚动） -->
      <div v-show="!peek" class="ai-messages-wrapper">
        <div
          ref="messagesRef"
          class="ai-messages"
          :class="{ 'standalone-mode': showAssistantAvatar, 'custom-avatar': showAssistantAvatar && configStore.agentAvatar }"
          :style="{
            '--assistant-avatar': showAssistantAvatar ? `url(${configStore.agentAvatar || sailfishLogo})` : undefined,
            opacity: isHistoryScrollPending ? 0 : undefined,
          }"
        >
            <!-- 欢迎页（无任务且无历史对话时显示） -->
            <WelcomePanel
              v-if="!peek && !isAgentRunning && !agentUserTask && agentTaskGroups.length === 0"
              :is-standalone-assistant="isStandaloneAssistant"
              :is-companion-tab="isCompanionTab"
              :tab-active="tabActive"
              :execution-mode="executionMode"
              :recent-history="recentHistory"
              :is-loading-history="isLoadingHistory"
              :format-history-time="formatHistoryTime"
              :resolve-title="historyDisplayTitle"
              @select-scenario="handleScenarioSelect"
              @load-history="handleLoadHistory"
              @open-history-modal="openHistoryModal"
            />
            <!-- 历史对话弹窗 -->
            <HistorySearchModal
              v-if="showHistoryModal"
              :all-history="allHistory"
              :is-loading-all-history="isLoadingAllHistory"
              :is-history-search-loading="isHistorySearchLoading"
              :history-full-text-search-active="historyFullTextSearchActive"
              :history-search-total-matched="historySearchTotalMatched"
              :history-search-keyword="historySearchKeyword"
              :has-more-history="hasMoreHistory"
              :format-history-time="formatHistoryTime"
              :resolve-title="historyDisplayTitle"
              @update:keyword="setHistorySearchKeyword"
              @search="flushHistorySearch"
              @clear-search="clearHistorySearch"
              @load-more="loadMoreHistory"
              @select="handleLoadHistory"
              @close="closeHistoryModal"
            />

          <!--
            单个步骤。同一段模板既要平铺在列表里、也要出现在折叠行内部，所以定义一次、两处复用；
            拆成独立组件的话，得把上百个局部函数与状态当 props 外挂。
            tool_call 步骤的左竖条按"执行结果"着色：
              - success === undefined  → 灰色占位（risk-pending），覆盖"流式生成 + 工具执行中"整段未完成期
              - success === true       → 绿色（exec-success）
              - success === false      → 红色（exec-failed）
            其他步骤类型保持现有风险色。
          -->
          <DefineStepRow v-slot="{ item }">
              <div
                class="agent-step-virtual"
                :class="{
                  'first-step': item.isFirstStep,
                  'agent-step-source-highlight': item.step!.id === highlightedSourceStepId && item.part !== 'thinking'
                }"
                :data-agent-step-id="item.part === 'thinking' ? undefined : item.step!.id"
              >
                <div 
                  class="agent-step-inline"
                  :class="[
                    isInitialPreparingStep(item.step!) ? 'message' : item.step!.type,
                    item.step!.type === 'tool_call' ? getExecStatusClass(item.step!) : getRiskClass(item.step!.riskLevel),
                    {
                      'step-rejected': item.step!.rejected === true,
                      'risk-pending': item.step!.type === 'tool_call' && item.step!.success === undefined
                    }
                  ]"
                >
                  <span class="step-icon">{{ item.part === 'thinking' ? getStepIcon('thinking') : isInitialPreparingStep(item.step!) ? getStepIcon('message') : getStepIcon(item.step!.type) }}</span>
                  <div class="step-content">
                    <!-- 初始"正在准备..."占位：借用 message step 的整套视觉壳（agent-message-stack + ThinkingBlock 流式态），
                         切换到真正的 message step 时只是 ThinkingBlock 文字内部的"正在准备..." → "思考中 N.Ns" 变化，外层布局完全不变 -->
                    <div v-if="isInitialPreparingStep(item.step!)" class="agent-message-stack">
                      <ThinkingBlock
                        reasoning=""
                        :is-streaming="true"
                        :expanded="false"
                        :started-at="item.step!.timestamp"
                        :label="item.step!.content"
                      />
                    </div>
                    <div v-else-if="item.step!.type === 'message'" class="agent-message-stack">
                      <!-- 一句话拆成两半时：想的那截收进折叠行、说出口的那句留在外面，各只渲染自己那半 -->
                      <template v-for="(pres, presIdx) in [getMessageStepPresentation(item.step!)]" :key="presIdx">
                      <ThinkingBlock
                        v-if="pres.thinking && item.part !== 'body'"
                        :reasoning="pres.thinking.reasoning"
                        :is-streaming="pres.thinking.isStreaming"
                        :label="pres.thinking.label"
                        :expanded="isThinkingExpanded(item.step!.id)"
                        :started-at="item.step!.timestamp"
                        :cached-duration-ms="getCachedThinkingDuration(item.step!.id)"
                        @toggle="toggleThinkingExpand(item.step!.id, $event)"
                        @finalize="cacheThinkingDuration(item.step!.id, $event)"
                      />
                      <div
                        v-if="pres.body && item.part !== 'thinking'"
                        class="step-text step-analysis markdown-content"
                        :class="{ 'is-streaming': item.step!.isStreaming }"
                        v-html="renderMarkdown(pres.body)"
                      ></div>
                      </template>
                      <!-- 任务完成尾注：长在这一场的最后一格上。这一格若是说过的话，尾注就在这句话下面；
                           后头还有干活，标记跟到那些后面，不浮在半截。任务完成那一刻从这一格末尾
                           "长出"几像素，不引起独立 item 出现/消失，避免列表重排跳动。
                           agent-final-footer--first-show 仅在该 group 第一次显示尾注时附加，触发一次性
                           fade-in 动画；animationend 后 markFooterAnimated 写入 Set，后续虚拟滚动 remount
                           不再附加 class，避免动画重播闪烁 -->
                      <div
                        v-if="item.part !== 'thinking' && shouldShowTaskCompleteFooter(item)"
                        class="agent-final-footer"
                        :class="{ 'agent-final-footer--first-show': isFooterFirstShow(item.group?.id) }"
                        @animationend="markFooterAnimated(item.group?.id)"
                      >
                        <span class="agent-final-footer-icon">✓</span>
                        <span>{{ getTaskCompleteFooterLabel(item.group?.id) }}</span>
                        <button
                          v-if="canShowGroupMenu(item.group)"
                          type="button"
                          class="agent-group-menu-trigger"
                          :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                          :title="t('ai.fork.tooltip')"
                          @click.stop="toggleGroupMenu(item.group, $event)"
                        >
                          <MoreHorizontal :size="14" />
                        </button>
                      </div>
                    </div>
                    <div v-else-if="item.step!.type === 'asking'" class="step-text asking-content">
                      <div class="asking-question">{{ item.step!.content }}</div>
                      <div class="asking-body">
                        <div v-if="getAskingOptions(item.step!).length > 0" class="asking-options">
                          <button 
                            v-for="(opt, optIdx) in getAskingOptions(item.step!)" 
                            :key="optIdx"
                            class="asking-option-btn"
                            :class="{ 
                              'selected': isAskOptionSelected(item.step!, opt)
                            }"
                            :disabled="!isAskingInteractive(item.step!, item.group)"
                            @click="handleOptionClick(item.step!.id, opt, !!item.step!.toolArgs?.allow_multiple)"
                          >
                            <span class="option-label">{{ String.fromCharCode(65 + optIdx) }}</span>
                            <span class="option-text">{{ opt }}</span>
                            <span v-if="isRecommendedAskOption(item.step!, opt)" class="option-recommended-badge">{{ t('ai.askingRecommended') }}</span>
                          </button>
                          <button 
                            v-if="item.step!.toolArgs?.allow_multiple"
                            class="asking-confirm-btn"
                            :disabled="!isAskingInteractive(item.step!, item.group) || getSelectedOptions(item.step!.id).length === 0"
                            @click="confirmMultiSelect(item.step!.id)"
                          >
                            {{ t('ai.confirmMultiSelect') }} ({{ getSelectedOptions(item.step!.id).length }})
                          </button>
                        </div>
                        <span
                          v-if="isAskingInteractive(item.step!, item.group) && getAskRemainingSeconds(item.step!) !== null"
                          class="asking-countdown"
                          :title="t('ai.askingCountdownTip')"
                        >{{ formatAskCountdown(getAskRemainingSeconds(item.step!)!) }}</span>
                      </div>
                      <div v-if="shouldShowAskingStatus(item.step!)" class="asking-status" :class="{ 
                        'status-waiting': item.step!.askingStatus === 'waiting',
                        'status-timeout': item.step!.askingStatus === 'timeout',
                        'status-cancelled': item.step!.askingStatus === 'cancelled'
                      }">
                        {{ item.step!.toolResult }}
                      </div>
                    </div>
                    <div v-else-if="item.step!.type === 'plan_created' || item.step!.type === 'plan_updated' || item.step!.type === 'plan_archived'" class="step-text plan-step-content">
                      <div class="plan-step-header" @click="togglePlanExpand(item.step!.id)">
                        <span class="plan-step-text">{{ item.step!.content }}</span>
                        <span class="plan-expand-icon" :class="{ expanded: expandedPlanSteps.has(item.step!.id) }">▶</span>
                      </div>
                      <div v-if="expandedPlanSteps.has(item.step!.id) && item.step!.plan" class="plan-step-details">
                        <AgentPlanView :plan="item.step!.plan" :compact="false" />
                      </div>
                    </div>
                    <div v-else-if="item.step!.webSearchResults && item.step!.webSearchResults.length > 0" class="step-text web-search-content">
                      <span class="web-search-header" @click="toggleWebSearchExpand(item.step!.id)">
                        <span class="web-search-summary">{{ t('ai.webSearch.foundResults', { count: item.step!.webSearchResults.length }) }}</span>
                        <span class="web-search-expand-icon" :class="{ expanded: expandedWebSearchSteps.has(item.step!.id) }">▶</span>
                      </span>
                      <ul v-if="expandedWebSearchSteps.has(item.step!.id)" class="web-search-list">
                        <li
                          v-for="(r, rIdx) in item.step!.webSearchResults"
                          :key="rIdx"
                          class="web-search-item"
                        >
                          <a
                            class="web-search-link"
                            href="#"
                            :title="r.url"
                            @click.prevent="openWebSearchLink(r.url)"
                          >{{ r.title || r.url }}</a>
                          <span class="web-search-host">{{ getHostname(r.url) }}</span>
                        </li>
                      </ul>
                    </div>
                    <!-- tool_call 步骤的 content 是「执行命令: <command>」「读取文件: <path>」这类
                         状态行，命令/路径里完全可能出现 #、*、--- 这类 Markdown 语法字符（如 shell
                         注释 `# 启动调试适配器`、option `--name`、heredoc `===` 等）。直接走
                         renderMarkdown 会把它们解析成标题、加粗、分隔线，破坏命令原貌，所以单独
                         走纯文本 + pre-wrap 渲染，保留原样的换行与符号。
                         例外：toolArgs 含 http(s) url 字段时把 URL 部分包成 <a>（自动通过
                         Electron setWindowOpenHandler 走系统浏览器），其余仍走纯文本——既能点击，
                         命令安全也不变。renderToolCallContent 把 content 拆成 [前缀, url, 后缀]，
                         三段都走 Vue 文本插值，零 XSS 风险。 -->
                    <ToolCallContent v-else-if="item.step!.type === 'tool_call'" :content="item.step!.content" :toolArgs="item.step!.toolArgs" />
                    <div v-else class="step-text markdown-content" v-html="renderMarkdown(item.step!.content)"></div>
                    <!-- 并行子 Agent 卡片组 -->
                    <div v-if="item.step!.subAgents && item.step!.subAgents.length > 0" class="sub-agents-group">
                      <div
                        v-for="sa in item.step!.subAgents"
                        :key="sa.id"
                        class="sub-agent-card"
                        :class="sa.status"
                      >
                        <div class="sub-agent-header" @click="toggleSubAgentExpand(item.step!.id + ':' + sa.id)">
                          <span class="sub-agent-status-icon">
                            <span v-if="sa.status === 'pending'" class="sa-icon-pending">○</span>
                            <span v-else-if="sa.status === 'running'" class="sa-icon-running">◌</span>
                            <span v-else-if="sa.status === 'completed'" class="sa-icon-completed">✓</span>
                            <span v-else-if="sa.status === 'interrupted'" class="sa-icon-failed">⏹</span>
                            <span v-else class="sa-icon-failed">✗</span>
                          </span>
                          <span class="sub-agent-header-text">
                            <span class="sub-agent-desc">{{ sa.name ? `${sa.name} · ${sa.description}` : sa.description }}</span>
                            <span v-if="sa.status === 'running' && getSubAgentActivity(sa)" class="sub-agent-activity">⟳ {{ getSubAgentActivity(sa) }}</span>
                            <span v-if="sa.blockedReason" class="sub-agent-activity">{{ sa.blockedReason }}</span>
                          </span>
                          <span class="sub-agent-status-text">
                            {{ t(`ai.subAgent${sa.status.charAt(0).toUpperCase() + sa.status.slice(1)}`) }}
                          </span>
                          <span v-if="sa.prompt || sa.result || sa.error || (sa.steps && sa.steps.length > 0)" class="sub-agent-expand-icon" :class="{ expanded: isSubAgentExpanded(item.step!.id + ':' + sa.id) }">▶</span>
                        </div>
                        <div v-if="isSubAgentExpanded(item.step!.id + ':' + sa.id)" class="sub-agent-detail">
                          <div v-if="sa.prompt" class="sub-agent-prompt">{{ sa.prompt }}</div>
                          <div v-if="sa.steps && sa.steps.length > 0" class="sub-agent-steps">
                            <div v-for="(step, stepIdx) in sa.steps" :key="stepIdx" class="sa-step" :class="step.status">
                              <span class="sa-step-icon">
                                <span v-if="step.status === 'running'" class="sa-step-running">⟳</span>
                                <span v-else-if="step.status === 'completed'" class="sa-step-done">✓</span>
                                <span v-else class="sa-step-fail">✗</span>
                              </span>
                              <span class="sa-step-tool">{{ step.tool }}</span>
                              <span v-if="step.args" class="sa-step-args" :title="step.args">{{ step.args }}</span>
                            </div>
                          </div>
                          <div v-if="sa.result" class="sub-agent-result">
                            <pre>{{ sa.result }}</pre>
                          </div>
                          <div v-if="sa.error" class="sub-agent-result">
                            <pre class="sub-agent-error">{{ sa.error }}</pre>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div v-if="item.step!.type === 'user_supplement' && item.step!.attachments && item.step!.attachments.length > 0" class="message-attachments">
                      <span
                        v-for="(file, fileIdx) in item.step!.attachments"
                        :key="fileIdx"
                        class="attachment-chip"
                        :class="{ clickable: !!file.filePath }"
                        :title="file.filePath || file.filename"
                        role="button"
                        tabindex="0"
                        @click="openAttachmentFile(file)"
                        @keydown.enter.prevent="openAttachmentFile(file)"
                        @keydown.space.prevent="openAttachmentFile(file)"
                        @contextmenu="openAttachmentContextMenu($event, file)"
                      >
                        <AttachmentFileIcon :file-type="file.fileType" :filename="file.filename" :file-path="file.filePath" :size="15" />
                        <span class="attachment-name">{{ file.filename }}</span>
                        <span class="attachment-size">{{ formatFileSize(file.fileSize) }}</span>
                      </span>
                    </div>
                    <!-- 拒绝步骤（rejected）的 content 与 toolResult 在语义上是同一句"用户拒绝…"，
                         不需要再下方重复一份 step-result。其他场景下 toolResult 与 content 不同则展示。 -->
                    <div v-if="item.step!.hugeOutput" class="huge-output-card">
                      <p class="huge-output-title">{{ t('ai.hugeOutput.title') }}</p>
                      <p class="huge-output-size">{{ t('ai.hugeOutput.size', { size: formatHugeOutputSize(item.step!.hugeOutput.bytes) }) }}</p>
                      <p v-if="!item.step!.hugeOutput.head && !item.step!.hugeOutput.tail" class="huge-output-empty">
                        {{ t('ai.hugeOutput.emptyBytes') }}
                      </p>
                      <template v-else>
                        <p v-if="item.step!.hugeOutput.head" class="huge-output-label">{{ t('ai.hugeOutput.head') }}</p>
                        <pre v-if="item.step!.hugeOutput.head" class="huge-output-peek">{{ item.step!.hugeOutput.head }}</pre>
                        <p class="huge-output-ellipsis">…</p>
                        <p v-if="item.step!.hugeOutput.tail" class="huge-output-label">{{ t('ai.hugeOutput.tail') }}</p>
                        <pre v-if="item.step!.hugeOutput.tail" class="huge-output-peek">{{ item.step!.hugeOutput.tail }}</pre>
                      </template>
                      <button
                        v-if="item.step!.hugeOutput.sourceFile != null && item.step!.hugeOutput.sourceLine != null"
                        type="button"
                        class="huge-output-save"
                        @click="exportHugeOutput(item.step!)"
                      >
                        {{ t('ai.hugeOutput.saveAs') }}
                      </button>
                    </div>
                    <div v-else-if="item.step!.toolResult && !item.step!.rejected && item.step!.toolResult !== item.step!.content && item.step!.type !== 'asking' && !item.step!.subAgents" class="step-result">
                      <pre>{{ item.step!.toolResult }}</pre>
                    </div>
                    <!-- 「活图」优先：chart skill 在 svg 模式下投递 echartsOption（同时也带 SVG 兜底到 step.images），
                         前端把它实例化成可交互的 ECharts，单击放大/右键复制走 EChartsCanvas 内部 getDataURL 的高清 PNG。
                         单击时把 step.images[0]（SVG dataURL）一起传给 openImagePreview，让导航定位能在 group 中找到当前位置。 -->
                    <div v-if="item.step!.echartsOption && !echartsLiveFailedStepIds.has(item.step!.id)" class="step-images">
                      <EChartsCanvas
                        :payload="item.step!.echartsOption"
                        :alt="item.step!.toolResult || 'chart'"
                        mode="thumb"
                        @preview="openImagePreview(item.step!.images?.[0] ?? '', item.step!.echartsOption)"
                        @contextmenu="onEchartsContextMenu"
                        @failed="onEchartsLiveFailed(item.step!.id)"
                      />
                    </div>
                    <div v-else-if="item.step!.images && item.step!.images.length > 0" class="step-images">
                      <img
                        v-for="(imgUrl, imgIdx) in item.step!.images"
                        :key="imgIdx"
                        :src="imgUrl"
                        :alt="item.step!.toolResult || `image ${imgIdx + 1}`"
                        class="step-image"
                        @click="openImagePreview(imgUrl)"
                        @contextmenu="openImageContextMenu($event, imgUrl)"
                      />
                    </div>
                    <div
                      v-if="item.step!.type !== 'message' && item.part !== 'thinking' && shouldShowTaskCompleteFooter(item)"
                      class="agent-final-footer"
                      :class="{ 'agent-final-footer--first-show': isFooterFirstShow(item.group?.id) }"
                      @animationend="markFooterAnimated(item.group?.id)"
                    >
                      <span class="agent-final-footer-icon">✓</span>
                      <span>{{ getTaskCompleteFooterLabel(item.group?.id) }}</span>
                      <button
                        v-if="canShowGroupMenu(item.group)"
                        type="button"
                        class="agent-group-menu-trigger"
                        :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                        :title="t('ai.fork.tooltip')"
                        @click.stop="toggleGroupMenu(item.group, $event)"
                      >
                        <MoreHorizontal :size="14" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
          </DefineStepRow>
          <DefineConfirmRow>
            <div v-if="pendingConfirm" class="agent-step-virtual">
              <div class="agent-confirm-inline" :class="getRiskClass(pendingConfirm.riskLevel)">
                <div class="confirm-header-inline">
                  <span class="confirm-icon">{{ pendingConfirm.riskLevel === 'dangerous' ? '🔴' : (pendingConfirm.riskLevel === 'moderate' ? '🟡' : '🟢') }}</span>
                  <span class="confirm-title">{{ t('ai.needConfirm') }}</span>
                  <span class="confirm-risk-badge" :class="getRiskClass(pendingConfirm.riskLevel)">
                    {{ pendingConfirm.riskLevel === 'dangerous' ? t('ai.highRisk') : (pendingConfirm.riskLevel === 'moderate' ? t('ai.mediumRisk') : t('ai.lowRisk')) }}
                  </span>
                </div>
                <div class="confirm-detail">
                  <div class="confirm-tool-name">{{ pendingConfirm.displayName || getToolDisplayName(pendingConfirm.toolName) }}</div>
                  <pre class="confirm-args-inline">{{ formatConfirmArgs(pendingConfirm) }}</pre>
                  <div v-if="pendingConfirm.reasons && pendingConfirm.reasons.length > 0" class="confirm-reasons">
                    <div class="confirm-reasons-title">{{ t('ai.riskReasons') }}</div>
                    <ul class="confirm-reasons-list">
                      <li v-for="(reason, idx) in pendingConfirm.reasons" :key="idx">{{ reason }}</li>
                    </ul>
                  </div>
                  <div v-if="pendingConfirm.autoReview" class="confirm-auto-review">
                    <div class="confirm-auto-review-title">{{ t('ai.autoReviewNote') }}</div>
                    <p v-if="pendingConfirm.autoReview.rationale" class="confirm-auto-review-rationale">{{ pendingConfirm.autoReview.rationale }}</p>
                    <p v-else class="confirm-auto-review-rationale">{{ autoReviewHandOverText(pendingConfirm.autoReview.reason) }}</p>
                  </div>
                </div>
                <div class="confirm-actions-inline">
                  <button class="btn btn-sm btn-outline-secondary" @click="confirmToolCall(false)">
                    {{ t('ai.reject') }}
                  </button>
                  <button
                    v-if="pendingConfirm.trustCommandOffer"
                    class="btn btn-sm"
                    :class="pendingConfirm.riskLevel === 'dangerous' ? 'btn-outline-danger' : (pendingConfirm.riskLevel === 'moderate' ? 'btn-outline-warning' : 'btn-outline-success')"
                    :title="t('ai.trustCommandHint', { cmd: pendingConfirm.trustCommandOffer.cmd })"
                    @click="confirmTrustCommandAndAllow"
                  >
                    {{ t('ai.trustCommand') }}
                    <span class="trust-cmd-tag">{{ pendingConfirm.trustCommandOffer.cmd }}</span>
                  </button>
                  <button
                    class="btn btn-sm"
                    :class="pendingConfirm.riskLevel === 'dangerous' ? 'btn-danger' : (pendingConfirm.riskLevel === 'moderate' ? 'btn-warning' : 'btn-success')"
                    @click="confirmToolCall(true)"
                  >
                    {{ t('ai.allowExecute') }}
                  </button>
                </div>
              </div>
            </div>
          </DefineConfirmRow>
          <DefineSecureRow>
            <div v-if="pendingSecureInput" class="agent-step-virtual">
              <div class="agent-secure-input-inline">
                <div class="secure-input-header">
                  <span class="secure-input-icon">🔑</span>
                  <span class="secure-input-title">{{ t('ai.secureInputTitle') }}</span>
                </div>
                <div class="secure-input-prompt">{{ pendingSecureInput.prompt }}</div>
                <div class="secure-input-body">
                  <input
                    type="password"
                    class="secure-input-field"
                    v-model="secureInputValue"
                    :ref="(el) => { if (el) (el as HTMLInputElement).focus() }"
                    :placeholder="t('ai.secureInputPlaceholder')"
                    @keyup.enter="submitSecureInput(secureInputValue); secureInputValue = ''"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck="false"
                  />
                </div>
                <div class="secure-input-actions">
                  <button class="btn btn-sm btn-outline-secondary" @click="cancelSecureInput(); secureInputValue = ''">
                    {{ t('ai.cancel') }}
                  </button>
                  <button
                    class="btn btn-sm btn-primary"
                    :disabled="!secureInputValue.trim()"
                    @click="submitSecureInput(secureInputValue); secureInputValue = ''"
                  >
                    {{ t('ai.confirm') }}
                  </button>
                </div>
              </div>
            </div>
          </DefineSecureRow>

          <Virtualizer
            ref="virtuaRef"
            :data="displayItems"
            :item-size="48"
            :buffer-size="400"
          >
            <template #default="{ item, index }">
              <div :key="item.id" :data-index="index">
              <!-- 主动消息（talk_to_user）— 历史格式 user_task __proactive__ + final_result -->
              <div v-if="item.type === 'proactive_message'" class="message assistant">
                <div class="message-wrapper">
                  <div class="message-content markdown-content" v-html="renderMarkdown(item.group!.finalResult!)"></div>
                  <div v-if="canShowGroupMenu(item.group)" class="agent-final-footer agent-final-footer--proactive">
                    <button
                      type="button"
                      class="agent-group-menu-trigger"
                      :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                      :title="t('ai.fork.tooltip')"
                      @click.stop="toggleGroupMenu(item.group, $event)"
                    >
                      <MoreHorizontal :size="14" />
                    </button>
                  </div>
                </div>
              </div>

              <!-- 主动消息（talk_to_user）— 新格式 proactive_notice step -->
              <div v-else-if="item.type === 'proactive_notice'" class="message assistant">
                <div class="message-wrapper">
                  <div class="message-content markdown-content" v-html="renderMarkdown(item.step?.content ?? '')"></div>
                </div>
              </div>

              <!-- 用户任务 -->
              <div v-else-if="item.type === 'user_task'" class="message user">
                <div class="message-wrapper">
                  <div class="message-content">
                    <span class="user-task-text">{{ item.group!.userTask }}</span>
                    <div v-if="item.group!.images && item.group!.images.length > 0" class="message-images">
                      <img
                        v-for="(imgUrl, imgIdx) in item.group!.images"
                        :key="imgIdx"
                        :src="imgUrl"
                        class="message-image"
                        @click="openImagePreview(imgUrl)"
                        @contextmenu="openImageContextMenu($event, imgUrl)"
                      />
                    </div>
                    <div 
                      v-for="hint in getPreviewHints(item.group!.attachments)"
                      :key="hint.filename"
                      class="image-preview-hint"
                    >
                      仅预览前 {{ hint.previewPages }} 页（共 {{ hint.totalPages }} 页）
                    </div>
                    <div v-if="item.group!.attachments && item.group!.attachments.length > 0" class="message-attachments">
                      <span 
                        v-for="(file, fileIdx) in item.group!.attachments" 
                        :key="fileIdx" 
                        class="attachment-chip"
                        :class="{ clickable: !!file.filePath }"
                        :title="file.filePath || file.filename"
                        role="button"
                        tabindex="0"
                        @click="openAttachmentFile(file)"
                        @keydown.enter.prevent="openAttachmentFile(file)"
                        @keydown.space.prevent="openAttachmentFile(file)"
                        @contextmenu="openAttachmentContextMenu($event, file)"
                      >
                        <AttachmentFileIcon :file-type="file.fileType" :filename="file.filename" :file-path="file.filePath" :size="15" />
                        <span class="attachment-name">{{ file.filename }}</span>
                        <span class="attachment-size">{{ formatFileSize(file.fileSize) }}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <div
                v-else-if="item.type === 'folded_turn' && item.fold"
                class="agent-step-virtual"
                :class="{ 'first-step': item.isFirstStep }"
              >
                <ProcessTurnFold
                  :fold="item.fold"
                  :expanded="item.expanded"
                  @toggle="toggleProcessFold(item.fold.id)"
                >
                  <ReuseStepRow v-for="child in item.children" :key="child.id" :item="child" />
                </ProcessTurnFold>
                <div
                  v-if="shouldShowTaskCompleteFooter(item)"
                  class="agent-final-footer"
                  :class="{ 'agent-final-footer--first-show': isFooterFirstShow(item.group?.id) }"
                  @animationend="markFooterAnimated(item.group?.id)"
                >
                  <span class="agent-final-footer-icon">✓</span>
                  <span>{{ getTaskCompleteFooterLabel(item.group?.id) }}</span>
                  <button
                    v-if="canShowGroupMenu(item.group)"
                    type="button"
                    class="agent-group-menu-trigger"
                    :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                    :title="t('ai.fork.tooltip')"
                    @click.stop="toggleGroupMenu(item.group, $event)"
                  >
                    <MoreHorizontal :size="14" />
                  </button>
                </div>
              </div>

              <ReuseStepRow v-else-if="item.type === 'step'" :item="item" />


              <!-- 最终结果：仅失败 / 中断时渲染独立卡片（含错误信息）；
                   成功时不渲染——message step 已经完整呈现思考块 + 正文，
                   独立的"任务完成"卡反而会引起列表跳动。 -->
              <div v-else-if="item.type === 'final_result' && (item.group!.finalResult!.startsWith('❌') || item.group!.finalResult!.startsWith('⚠️'))">
                <div class="message assistant">
                  <div class="message-wrapper agent-final-wrapper">
                    <div
                      class="message-content agent-final-content"
                      :class="{ 'is-error': item.group!.finalResult!.startsWith('❌'), 'is-aborted': item.group!.finalResult!.startsWith('⚠️') }"
                    >
                      <div class="agent-final-header">
                        <span class="final-icon">{{ item.group!.finalResult!.startsWith('❌') ? '❌' : '⚠️' }}</span>
                        <span class="final-title">{{ item.group!.finalResult!.startsWith('❌') ? t('ai.taskFailed') : t('ai.taskAborted') }}</span>
                      </div>
                      <div class="agent-final-body markdown-content" v-html="renderMarkdown(item.group!.finalResult!.replace(/^[❌⚠️]\s*(Agent\s*(执行失败|运行出错)[:\s]*)?/, ''))"></div>
                      <div v-if="canShowGroupMenu(item.group)" class="agent-final-footer agent-final-footer--in-card">
                        <button
                          type="button"
                          class="agent-group-menu-trigger"
                          :class="{ 'is-open': openGroupMenuId === item.group!.id }"
                          :title="t('ai.fork.tooltip')"
                          @click.stop="toggleGroupMenu(item.group, $event)"
                        >
                          <MoreHorizontal :size="14" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <ReuseConfirmRow v-else-if="item.type === 'confirm' && pendingConfirm" />
              <ReuseSecureRow v-else-if="item.type === 'waiting_input' && pendingSecureInput" />

            
              </div>
            </template>
          </Virtualizer>
        </div>


        <!-- 新消息指示器 -->
        <div v-if="hasNewMessage && !peek" class="new-message-indicator" @click="scrollToBottom" :title="t('ai.newMessage')">
          <ChevronDown :size="14" />
          <span>{{ t('ai.newMessage') }}</span>
        </div>
      </div>


      <div v-if="peek && peekSurface === 'needs-you'" class="ai-peek-needs-you">
        <ReuseConfirmRow v-if="pendingConfirm" />
        <ReuseSecureRow v-if="pendingSecureInput" />
        <ReuseStepRow
          v-for="item in peekAskItems"
          :key="item.id"
          :item="item"
        />
      </div>
      <div v-else-if="peek && peekSurface === 'process'" class="ai-peek-process">
        <ProcessTurnFold
          v-if="peekProcessFold?.fold"
          :fold="peekProcessFold.fold"
          :expanded="peekProcessFold.expanded"
          @toggle="peekProcessFold.fold?.id && toggleProcessFold(peekProcessFold.fold.id)"
        >
          <ReuseStepRow
            v-for="child in peekProcessChildren"
            :key="child.id"
            :item="child"
          />
        </ProcessTurnFold>
        <ProcessTurnFold
          v-else
          :fold="peekFallbackFold"
          :expanded="peekFallbackOpen"
          @toggle="peekFallbackOpen = !peekFallbackOpen"
        >
          <ReuseStepRow
            v-for="child in peekFallbackChildren"
            :key="child.id"
            :item="child"
          />
        </ProcessTurnFold>
      </div>
      <button
        v-else-if="peek && peekSurface === 'spoken'"
        type="button"
        class="ai-peek-card"
        :class="{ 'is-expanded': peekExpanded }"
        @click="peekExpanded = !peekExpanded"
      >
        <span
          class="ai-peek-text"
          :class="{ 'is-clamped': !peekExpanded }"
        >{{ focusPeek.text }}</span>
      </button>

      <AiComposer
        ref="composerRef"
        :current-tab-id="currentTabId"
        :visible="props.visible"
        :context-stats="contextStats"
        :cache-bar-width="cacheBarWidth"
        :uploaded-docs="uploadedDocs"
        :parsing-docs="parsingDocs"
        :pending-images="pendingImages"
        :is-attaching="isAttaching"
        :is-agent-running="isAgentRunning"
        :is-loading="isLoading"
        :can-send-empty="false"
        :has-images="hasImagesComputed"
        :is-recording="isRecording"
        :is-transcribing="isTranscribing"
        :is-push-to-talk="isPushToTalk"
        :audio-available="audioAvailable"
        :is-speech-initializing="isSpeechInitializing"
        :voice-input-enabled="!!configStore.keyboardShortcuts.voiceInput"
        :format-file-size="(size?: number) => formatFileSize(size ?? 0)"
        :open-image-preview="openImagePreview"
        :remove-image="removeImage"
        :select-attachment="selectAttachment"
        :remove-uploaded-doc="removeUploadedDoc"
        :clear-uploaded-docs="clearUploadedDocs"
        :handle-paste="handlePaste"
        :handle-record-click="handleRecordClick"
        :stop-generation="stopGeneration"
        :abort-agent="abortAgent"
        :tts-is-speaking="ttsIsSpeaking ?? false"
        :tts-stop="ttsStop"
        :submit-message="handleComposerSubmit"
        :submit-empty-message="handleComposerEmptySubmit"
        :compact-context="compactContext"
        :follow-up-queue="followUpQueueView"
        :is-editing-follow-up="isEditingFollowUp"
        :remove-follow-up="removeFollowUp"
        :insert-follow-up="insertFollowUp"
        :begin-edit-follow-up="handleBeginEditFollowUp"
        :cancel-edit-follow-up="handleCancelEditFollowUp"
        :reorder-follow-up="reorderFollowUp"
        :clear-tab-error="clearTabError"
        :consume-workbench-context="props.consumeWorkbenchContext"
        :overlay="peek"
      >
        <template #footer-left>
          <AiProfileSelect
            v-if="aiProfiles.length > 0"
            embedded
            :profiles="aiProfiles"
            :model-value="activeAiProfile?.id || ''"
            @update:model-value="changeAiProfile"
          />
        </template>
        <template #footer-right>
          <ApprovalModeSelect
            :model-value="approvalUiState"
            @update:model-value="applyApprovalUiState"
          />
        </template>
      </AiComposer>
    </template>
    <!-- 图片预览弹窗（支持缩放拖拽、键盘导航） -->
    <div 
      v-if="previewImageUrl" 
      ref="previewModalRef"
      class="image-preview-modal" 
      @click="closeImagePreview"
    >
      <!-- 上方导航箭头：上一张 -->
      <button v-if="canGoUp" class="image-preview-nav nav-up" @click.stop="goUp" :title="t('ai.imagePreview.prevImage')">
        <ChevronUp :size="24" />
      </button>
      <!-- 下方导航箭头：下一张 -->
      <button v-if="canGoDown" class="image-preview-nav nav-down" @click.stop="goDown" :title="t('ai.imagePreview.nextImage')">
        <ChevronDown :size="24" />
      </button>

      <div class="image-preview-modal-content" @click.stop>
        <button v-show="previewScale === 1" class="image-preview-close" @click.stop="closeImagePreview">
          <X :size="20" />
        </button>
        <div ref="previewViewportRef" class="image-preview-viewport" :style="previewViewportStyle">
        <!-- 「活图」预览：当点击的是 chart skill 投递的活图时，模态里也用 EChartsCanvas 渲染，
             保留 tooltip / dataZoom / legend toggle 等所有交互能力。复制图片 / 另存为通过
             previewEchartsRef.getDataURL() 拿当前实时（含用户拖过的 dataZoom 范围）高清 PNG。
             缩放和拖拽也作用在 EChartsCanvas 上——CSS transform 控制外层包装，echarts 实例
             保持原始尺寸不影响交互精度。-->
        <div
          v-if="previewEchartsPayload"
          class="image-preview-full image-preview-echarts"
          :class="{ 'dragging': isDraggingImage }"
          :style="previewContentBoxStyle"
          @mousedown="handlePreviewMouseDown"
          @dblclick="handlePreviewDblClick"
        >
          <EChartsCanvas
            ref="previewEchartsRef"
            :payload="previewEchartsPayload"
            mode="preview"
            @contextmenu="onEchartsContextMenu"
          />
        </div>
        <img
          v-else
          :src="previewImageUrl"
          class="image-preview-full"
          :class="{ 'dragging': isDraggingImage }"
          :style="previewContentBoxStyle"
          @load="onPreviewImgLoad"
          @mousedown="handlePreviewMouseDown"
          @dblclick="handlePreviewDblClick"
          @contextmenu="openImageContextMenu($event, previewImageUrl!)"
          draggable="false"
        />
        </div>
        <!-- 底部信息栏：图片位置 + 缩放比例 -->
        <div class="image-preview-info-bar">
          <span v-if="allPreviewImages.length > 1 && previewIdx >= 0" class="image-preview-counter">
            {{ previewIdx + 1 }} / {{ allPreviewImages.length }}
          </span>
          <span v-if="previewScale !== 1" class="image-preview-zoom-badge">
            {{ Math.round(previewScale * 100) }}%
          </span>
        </div>
      </div>
    </div>
  </div>

  <!-- group 操作菜单：Teleport 到 body 避免被滚动容器 overflow 裁掉 -->
  <Teleport to="body">
    <div
      v-if="openGroupMenuId && openGroupMenuGroup"
      class="agent-group-menu"
      :style="{ top: groupMenuPosition.top + 'px', right: groupMenuPosition.right + 'px' }"
    >
      <button
        type="button"
        class="agent-group-menu-item"
        :disabled="forkingGroupIds.has(openGroupMenuGroup.id)"
        @click="handleForkFromGroup(openGroupMenuGroup)"
      >
        {{ isCompanionSourceTab ? t('ai.fork.extractTaskAction', '从这里创建任务') : t('ai.fork.action') }}
      </button>
    </div>
  </Teleport>

  <!-- 图片右键菜单：所有 <img> 共用，包括小缩略图和大图预览 -->
  <ImageContextMenu
    :show="imageContextMenu.show"
    :x="imageContextMenu.x"
    :y="imageContextMenu.y"
    :url="imageContextMenu.url"
    :default-name="imageContextMenu.defaultName"
    @close="closeImageContextMenu"
  />
  <AttachmentContextMenu
    :show="attachmentContextMenu.show"
    :x="attachmentContextMenu.x"
    :y="attachmentContextMenu.y"
    :filename="attachmentContextMenu.filename"
    :file-path="attachmentContextMenu.filePath"
    @close="closeAttachmentContextMenu"
  />
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}

.ai-panel.is-peek {
  height: auto;
  background: transparent;
  pointer-events: auto;
}

.ai-peek-needs-you {
  width: min(800px, 100%);
  max-height: min(50vh, 420px);
  margin: 0 auto 8px;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--bg-secondary, rgba(30, 30, 30, 0.94));
  box-shadow: 0 10px 36px rgba(0, 0, 0, 0.28);
}

.ai-panel.is-peek .error-alert,
.ai-panel.is-peek .selection-alert {
  width: min(800px, 100%);
  margin: 0 auto 8px;
}

.ai-peek-process {
  position: relative;
  z-index: 6;
  width: min(560px, 100%);
  max-height: 40vh;
  margin: 0 auto 8px;
  padding: 10px 12px;
  overflow: auto;
  border-radius: 10px;
  background: var(--bg-secondary, rgba(30, 30, 30, 0.92));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
}

.ai-peek-process :deep(.process-fold__label) {
  color: var(--text-primary);
  font-size: 13px;
}

.ai-peek-process :deep(.process-fold__label.is-waiting-hint) {
  background: none;
  animation: none;
  -webkit-background-clip: unset;
  background-clip: unset;
  -webkit-text-fill-color: var(--text-primary);
}

.ai-peek-card {
  position: relative;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(560px, 100%);
  margin: 0 auto 8px;
  padding: 10px 12px;
  border: none;
  border-radius: 10px;
  background: var(--bg-secondary, rgba(30, 30, 30, 0.92));
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}

.ai-peek-card.is-expanded {
  align-items: flex-start;
}

.ai-peek-text {
  min-width: 0;
  flex: 1 1 auto;
}

.ai-peek-text.is-clamped {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-peek-card.is-expanded .ai-peek-text {
  white-space: pre-wrap;
  max-height: 40vh;
  overflow: auto;
}

.ai-peek-spinner {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--text-secondary, #aaa);
  border-top-color: transparent;
  border-radius: 50%;
  animation: ai-peek-spin 0.8s linear infinite;
}

@keyframes ai-peek-spin {
  to { transform: rotate(360deg); }
}

@keyframes panelEnter {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.model-select {
  padding: 4px 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  max-width: 160px;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.model-select:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

/* 聚焦态本身不叠加底色；鼠标离开后不会残留高亮，鼠标回到上方仍由 :hover 生效 */

/* 紧凑变体：嵌入 system-info-bar 时使用 */
.model-select-sm {
  padding: 2px 4px;
  font-size: var(--workbench-header-select-font-size, 12px);
  height: var(--workbench-header-select-height, 22px);
  max-width: 140px;
  border-radius: 4px;
}

.btn-icon-sm {
  width: 22px;
  height: 22px;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-icon-sm:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.ai-no-config {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 20px;
  color: var(--text-muted);
  text-align: center;
}

.system-info-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  padding: 0 12px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
  color: var(--text-muted);
  container-type: inline-size;
  container-name: infobar;
  white-space: nowrap;
  position: relative;
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.system-info-bar > * {
  -webkit-app-region: no-drag;
}

.system-info-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  white-space: nowrap;
}

/* 窄面板（如嵌入终端 tab 的 AI 侧栏）下隐藏辅助标签，只留图标/控件 */
@container infobar (max-width: 500px) {
  .system-info-left .system-text,
  .system-info-left .hover-hint {
    display: none;
  }
  .model-select-sm {
    max-width: 100px;
  }
}

@container infobar (max-width: 380px) {
  .model-select-sm {
    max-width: 70px;
  }
}

.system-icon {
  font-size: 12px;
}

.system-text {
  font-family: var(--font-mono);
}

/* 主机信息悬浮触发器 */
.host-info-trigger {
  position: relative;
  cursor: pointer;
  height: 22px;
  padding: 0 8px;
  border-radius: 5px;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.host-info-trigger:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.hover-hint {
  font-size: 8px;
  opacity: 0.5;
  margin-left: 2px;
  transition: all 0.2s ease;
}

.host-info-trigger:hover .hover-hint {
  opacity: 1;
  transform: translateY(1px);
}

/* 指向悬浮面板的三角形（挂在触发器上，天然对准 💻 图标） */
.host-info-trigger::after {
  content: '';
  position: absolute;
  top: calc(100% + 3px);
  left: 8px;
  width: 12px;
  height: 12px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  border-top: 1px solid var(--border-color);
  transform: rotate(45deg);
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), visibility 0.25s;
  z-index: 101;
  pointer-events: none;
}

/* 悬浮面板：固定锚定到信息栏左侧 */
.host-info-popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 12px;
  min-width: 380px;
  max-width: 380px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  z-index: 100;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-5px);
  transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1),
              visibility 0.25s,
              transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

/* 透明桥接区域，让鼠标能在触发器和面板之间移动而不丢失 hover */
.host-info-popover::before {
  content: '';
  position: absolute;
  top: -10px;
  left: 0;
  right: 0;
  height: 10px;
}

/* 悬停在触发器或面板上时，显示面板和箭头 */
.system-info-bar:has(.host-info-trigger:hover) .host-info-popover,
.system-info-bar:has(.host-info-popover:hover) .host-info-popover {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
}

.system-info-bar:has(.host-info-trigger:hover) .host-info-trigger::after,
.system-info-bar:has(.host-info-popover:hover) .host-info-trigger::after {
  opacity: 1;
  visibility: visible;
}

.popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.refresh-btn {
  padding: 4px 6px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.refresh-btn .spinning {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes gradient-flow {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}

.popover-content {
  padding: 14px 16px;
}

.info-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.5;
}

.info-row:last-child {
  margin-bottom: 0;
}

.info-row.tools-row {
  flex-wrap: wrap;
}

.info-label {
  color: var(--text-muted);
  flex-shrink: 0;
  min-width: 55px;
}

.info-value {
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.info-secondary {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
}

.info-value.tools-list {
  color: var(--accent-primary);
  word-break: break-word;
}

.popover-loading,
.popover-empty {
  padding: 16px 14px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

/* 错误诊断提示 */
/* 错误诊断提示 —— 走 --brand-alert（警戒红），跨主题固定，
   与通用 --color-error 区分，保证"错误警告"的视觉强度各主题一致 */
.error-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(var(--brand-alert-rgb), 0.15);
  border-bottom: 1px solid rgba(var(--brand-alert-rgb), 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.error-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.error-alert-content {
  flex: 1;
  min-width: 0;
}

.error-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-alert);
  margin-bottom: 2px;
}

.error-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.error-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: var(--brand-alert);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-btn:hover:not(:disabled) {
  background: var(--brand-alert-end);
}

.error-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.error-alert-close {
  padding: 4px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.error-alert-close:hover {
  opacity: 1;
  background: rgba(var(--brand-alert-rgb), 0.2);
}

/* 选中内容提示 */
.selection-alert {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(var(--color-info-rgb), 0.15);
  border-bottom: 1px solid rgba(var(--color-info-rgb), 0.3);
  flex-shrink: 0;
  z-index: 10;
}

.selection-alert-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.selection-alert-content {
  flex: 1;
  min-width: 0;
}

.selection-alert-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-info);
  margin-bottom: 2px;
}

.selection-alert-text {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.selection-alert-btn {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #fff;
  background: var(--color-info);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.selection-alert-btn:hover:not(:disabled) {
  background: var(--accent-secondary);
}

.selection-alert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Plan 固定顶部区域 */
.plan-sticky-header {
  flex-shrink: 0;
  padding: 8px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.ai-messages-wrapper {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.ai-messages {
  height: 100% !important;
  overflow-y: auto;
  padding: 12px;
  user-select: text;
  position: relative;
  /* virtua 自带 scroll adjustment；禁用浏览器 scroll anchoring 避免冲突 */
  overflow-anchor: none;
  /* 预留滚动条槽位，避免 Windows 经典滚动条出现/消失引发布局 reflow → 二次 ResizeObserver */
  scrollbar-gutter: stable;
  transition: box-shadow 0.3s ease, opacity 0.15s ease;
}

.agent-step-virtual {
  padding: 0 14px 4px;
  border-left: 2px solid var(--border-color);
}

/* 折叠行内部的步骤：竖线与缩进已由折叠行自己画，这里不再重复。
   写成两条同级选择器是为了压过后面 .standalone-mode 的 margin-left。 */
.process-fold__steps .agent-step-virtual,
.standalone-mode .process-fold__steps .agent-step-virtual {
  padding-left: 0;
  padding-right: 0;
  margin-left: 0;
  border-left: none;
}

.agent-step-virtual.agent-step-source-highlight {
  animation: agent-step-source-flash 2.5s ease-out;
}

@keyframes agent-step-source-flash {
  0%, 15% {
    background: rgba(96, 165, 250, 0.18);
    box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.35);
  }
  100% {
    background: transparent;
    box-shadow: none;
  }
}

.standalone-mode .agent-step-virtual {
  margin-left: 48px;
}

.standalone-mode .agent-step-virtual.first-step {
  position: relative;
  padding-top: 4px;
  /* 头像为 absolute，虚拟列表按内容盒测量高度时会偏小导致裁切 */
  min-height: 46px;
}

.standalone-mode .agent-step-virtual.first-step::before {
  content: '';
  position: absolute;
  left: calc(-48px - 2px);
  top: 4px;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  background-image: var(--assistant-avatar);
  background-size: 68%;
  background-position: center;
  background-repeat: no-repeat;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.standalone-mode.custom-avatar .agent-step-virtual.first-step::before {
  background-size: cover;
}

/* Agent 执行模式 - 严格模式绿色内阴影（仅左右两边）
   走 --brand-vital（活力绿），表示"每条命令都需确认的安全守护状态"；
   默认的 relaxed 模式不加任何视觉效果，作为无感知的基线。 */
.ai-panel.mode-strict .ai-messages {
  box-shadow: 
    inset 30px 0 30px -20px rgba(var(--brand-vital-rgb), 0.35),
    inset -30px 0 30px -20px rgba(var(--brand-vital-rgb), 0.35);
}

/* Agent 执行模式 - 自由模式红色内阴影 + 脉冲警示（仅左右两边）
   走 --brand-alert（警戒红），跨主题固定 */
.ai-panel.mode-free .ai-messages {
  box-shadow: 
    inset 40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4),
    inset -40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4);
  animation: free-mode-pulse 2s ease-in-out infinite;
}

@keyframes free-mode-pulse {
  0%, 100% {
    box-shadow: 
      inset 40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4),
      inset -40px 0 40px -25px rgba(var(--brand-alert-rgb), 0.4);
  }
  50% {
    box-shadow: 
      inset 50px 0 50px -30px rgba(var(--brand-alert-rgb), 0.5),
      inset -50px 0 50px -30px rgba(var(--brand-alert-rgb), 0.5);
  }
}

/* 新消息指示器 */
.new-message-indicator {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--accent-primary);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  border-radius: 20px;
  cursor: pointer;
  box-shadow: 0 2px 12px rgba(var(--accent-rgb), 0.4);
  transition: all 0.2s ease;
  animation: bounceIn 0.3s ease;
  z-index: 10;
  width: fit-content;
  margin: 0 auto;
}

.new-message-indicator:hover {
  background: var(--accent-secondary);
  transform: translateX(-50%) scale(1.05);
  box-shadow: 0 4px 16px rgba(var(--accent-rgb), 0.5);
}

.new-message-indicator:active {
  transform: translateX(-50%) scale(0.98);
}

@keyframes bounceIn {
  0% {
    opacity: 0;
    transform: translateX(-50%) translateY(10px);
  }
  100% {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
}

/* 上下文使用量迷你指示器 */
.context-mini {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 8px; /* 扩大悬停区域 */
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

.context-mini-bar.cached {
  background: #2dd4bf;
}

.context-mini-bar.warning {
  background: var(--color-warning);
}

.context-mini-bar.danger {
  background: var(--color-error);
}

.context-mini-tip {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 8px;
  font-size: 10px;
  color: var(--text-primary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s ease, visibility 0.15s ease;
  z-index: 100;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.context-mini:hover .context-mini-tip {
  opacity: 1;
  visibility: visible;
}

/* 旧的上下文样式（保留兼容） */
.context-stats {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  font-size: 11px;
}

.context-info {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.context-label {
  color: var(--text-secondary);
  font-weight: 500;
}

.context-separator {
  opacity: 0.5;
}

.context-bar {
  width: 60px;
  height: 4px;
  background: var(--bg-surface);
  border-radius: 2px;
  overflow: hidden;
}

.context-bar-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 2px;
  transition: width 0.3s ease, background 0.3s ease;
}

.context-bar-fill.warning {
  background: var(--color-warning);
}

.context-bar-fill.danger {
  background: var(--color-error);
}

.message {
  padding-bottom: 12px;
}

@keyframes messageEnter {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message.user {
  display: flex;
  justify-content: flex-end;
}

.message.assistant {
  display: flex;
  justify-content: flex-start;
}

.standalone-mode .message.assistant {
  align-items: flex-start;
}

.standalone-mode .message.assistant::before {
  content: '';
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  margin-right: 8px;
  margin-top: 2px;
  border-radius: 8px;
  background-image: var(--assistant-avatar);
  background-size: 68%;
  background-position: center;
  background-repeat: no-repeat;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  position: relative;
  z-index: 1;
}
.standalone-mode.custom-avatar .message.assistant::before {
  background-size: cover;
}

.message-wrapper {
  position: relative;
  max-width: 85%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.standalone-mode .message.assistant .message-wrapper {
  max-width: calc(85% - 42px);
}

.message.user .message-content {
  background: var(--chat-user-bubble-bg);
  /* 气泡文字色：主题可在自己块内覆盖 --chat-user-bubble-color
     （蓝主题深蓝底用白字），默认 fallback 继承正文色。 */
  color: var(--chat-user-bubble-color, var(--text-primary));
  border: 1px solid var(--chat-user-bubble-border);
  border-radius: 12px 12px 4px 12px;
  user-select: text;
  cursor: text;
}

.message.user .message-content .user-task-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.message.user .message-content :deep(a),
.message.user .message-content :deep(.file-path-link),
.message.user .message-content :deep(code.file-path-link) {
  color: inherit;
  text-decoration: underline;
  border-bottom: none;
}

.message.assistant .message-content {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-radius: 12px 12px 12px 4px;
  user-select: text;
  cursor: text;
}

.message-content {
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  word-wrap: break-word;
  user-select: text;
  cursor: text;
  /* 限制重绘范围，减少布局抖动 */
  contain: layout style;
}

.message-content pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  user-select: text;
  cursor: text;
}

/* message-content 设 cursor:text 时子链接需恢复手形光标（Markdown 正文样式见 styles/markdown-content.css） */
.message-content :deep(a[href]),
.message-content :deep(.file-path-link),
.message-content :deep(code.file-path-link),
.agent-final-body :deep(a[href]),
.agent-final-body :deep(.file-path-link),
.agent-final-body :deep(code.file-path-link) {
  cursor: pointer;
}


.copy-btn {
  align-self: flex-start;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  gap: 4px;
}

.copy-btn:hover {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--accent-primary);
}


@keyframes pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.7;
  }
}

/* ==================== Agent 模式样式 ==================== */

/* 严格模式开关 */
.strict-mode-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  user-select: none;
}

.toggle-label {
  font-size: 11px;
  color: var(--text-secondary);
}

.toggle-switch {
  position: relative;
  width: 32px;
  height: 18px;
  background: var(--bg-tertiary);
  border-radius: 9px;
  border: 1px solid var(--border-color);
  transition: all 0.2s;
}

.toggle-switch.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-dot {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.2s;
}

.toggle-switch.active .toggle-dot {
  transform: translateX(14px);
}


/* 自由模式确认对话框 */
.free-mode-confirm-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
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
  color: var(--brand-alert);
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
  color: var(--brand-alert);
  margin: 6px 0;
  line-height: 1.4;
}

.confirm-dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}

.btn-outline:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

/* 警告文本样式 */
.warning-text {
  color: var(--color-error) !important;
}

/* Agent 步骤（融入对话） */
.agent-steps-wrapper {
  max-width: 95% !important;
}

.agent-steps-content {
  padding: 12px 14px !important;
}

.agent-steps-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-primary);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
}

.agent-steps-header-inline:hover {
  opacity: 0.8;
}

.steps-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: auto;
}

.collapse-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.agent-steps-body {
  margin-top: 10px;
}


/* AI 思考中指示器（高度与 .agent-step-inline 一致，避免切换抖动） */
.agent-thinking-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}

.thinking-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(var(--brand-vital-rgb), 0.2);
  border-top-color: var(--brand-vital);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  box-shadow: 0 0 8px rgba(var(--brand-vital-rgb), 0.3);
}

.thinking-text {
  font-size: 13px;
  /* 渐变文字动画 */
  background: linear-gradient(
    90deg,
    rgba(var(--brand-vital-rgb), 0.75) 0%,
    rgba(var(--brand-vital-rgb), 1) 50%,
    rgba(var(--brand-vital-rgb), 0.75) 100%
  );
  background-size: 200% 100%;
  animation: gradient-flow 2s linear infinite;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  color: rgba(var(--brand-vital-rgb), 0.75);
  animation: pulse-text 2s ease-in-out infinite;
}

@keyframes pulse-text {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

/* Agent 最终回复 - 美化样式 */
.message.assistant:has(.agent-final-wrapper) {
  padding-top: 8px;
}

.agent-final-wrapper {
  background: transparent !important;
}

.message.assistant .agent-final-content {
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.agent-final-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(var(--brand-vital-rgb), 0.1);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  font-size: 13px;
  font-weight: 500;
}

/* 失败状态的样式 */
.agent-final-content.is-error .agent-final-header {
  background: rgba(var(--color-error-rgb), 0.1);
}

.agent-final-content.is-error {
  border-color: rgba(var(--color-error-rgb), 0.2);
}

.agent-final-content.is-aborted .agent-final-header {
  background: rgba(var(--color-warning-rgb), 0.1);
}

.agent-final-content.is-aborted {
  border-color: rgba(var(--color-warning-rgb), 0.2);
}

.final-icon {
  font-size: 16px;
}

.final-title {
  color: var(--text-primary);
}

.agent-final-body {
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
}

.agent-final-body :deep(p) {
  margin: 4px 0;
}

.agent-final-body :deep(p:first-child) {
  margin-top: 0;
}

.agent-final-body :deep(p:last-child) {
  margin-bottom: 0;
}

.agent-final-body :deep(strong) {
  color: var(--accent-primary);
}

.agent-final-body :deep(blockquote) {
  margin: 8px 0;
  padding: 10px 14px;
  border-left: 3px solid var(--color-success);
  background: rgba(var(--color-success-rgb), 0.08);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.agent-final-body :deep(blockquote p) {
  margin: 0;
}

.agent-final-body :deep(ul),
.agent-final-body :deep(ol) {
  margin: 8px 0;
  padding-left: 20px;
}

.agent-final-body :deep(li) {
  margin: 4px 0;
}

.agent-final-body :deep(code) {
  background: rgba(255, 255, 255, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.agent-final-body :deep(pre) {
  margin: 8px 0;
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  overflow-x: auto;
}

.agent-final-body :deep(pre code) {
  background: transparent;
  padding: 0;
}

/* 成功完成的静默尾注：在最终消息下方轻轻浮出一行，不再用整张绿色卡片。
   入场动画通过 agent-final-footer--first-show 一次性附加（仅 live 完成；历史冷加载跳过），
   animationend 后由 JS 把该 group id 加入 animatedFooters Set，class 不再附加 →
   后续虚拟滚动 unmount/mount 不会重播动画，避免"翻历史一路滑入闪烁"的回归。

   ⚠️ UX 不变量：footer 的虚拟列表 item size 必须恒定，与 footer 内
      任何子元素的存在与否无关。min-height 锁到当前最大子元素（22×22 操作
      按钮）高度。详见 electron/services/agent/SPEC.md §"任务完成尾注尺寸恒定"
      改动前必读，否则会重新引入 4dad4969 修复过的"任务完成时整屏上下闪烁"。
      入场动画用 opacity + translateY（compositor 层属性），不影响 box height，
      不破坏 item size 恒定不变量。 */
.agent-final-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-left: 2px;
  min-height: 22px;
  font-size: 11px;
  color: var(--text-muted);
}

.agent-final-footer--first-show {
  animation: agent-final-footer-enter 320ms cubic-bezier(0.32, 0.72, 0, 1) both;
}

@keyframes agent-final-footer-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.agent-final-footer-icon {
  color: var(--color-success);
  font-weight: 600;
}

/* group 操作菜单触发器（「...」图标按钮）：参照 Cursor 设计，平时极不起眼 */
.agent-group-menu-trigger {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  opacity: 0.35;
  cursor: pointer;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}

/* 鼠标 hover 到尾注/卡片/主动消息气泡任意位置时，按钮淡入显现 */
.agent-final-footer:hover .agent-group-menu-trigger,
.agent-final-content:hover .agent-group-menu-trigger,
.message.assistant .message-wrapper:hover .agent-group-menu-trigger {
  opacity: 0.7;
}

.agent-group-menu-trigger:hover,
.agent-group-menu-trigger.is-open {
  opacity: 1;
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 失败/中断卡片内的菜单容器：和卡片正文同样的左右内边距 */
.agent-final-footer--in-card {
  padding: 0 14px 12px;
  margin-top: 0;
  display: flex;
  justify-content: flex-end;
}

/* talk_to_user 主动消息气泡下方的操作菜单 */
.agent-final-footer--proactive {
  justify-content: flex-end;
  margin-top: 2px;
}

.agent-running-dot {
  width: 8px;
  height: 8px;
  background: var(--accent-primary);
  border-radius: 50%;
  animation: pulse-dot 1.5s ease-in-out infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

/* Agent 步骤消息（紧凑显示） */
.agent-step-message {
  margin-bottom: 4px !important;
}

.agent-step-message .message-wrapper {
  padding: 6px 0;
}

.agent-step-content-inline {
  display: flex;
  gap: 8px;
  padding: 8px 12px !important;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.agent-step-inline {
  display: flex;
  gap: 8px;
  padding: 8px 0;
  font-size: 12px;
  color: var(--text-secondary);
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.agent-step-inline:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.step-icon {
  flex-shrink: 0;
  font-size: 14px;
}

.step-content {
  flex: 1;
  min-width: 0;
  /* 限制重绘范围，减少流式输出时的布局抖动 */
  contain: layout style;
}

/* message step 的"思考块 + 正文"垂直栈：用 flex gap 接管两者间距，
   彻底消除原本依赖 margin collapse（思考块 +4 + 正文 -4 = 0）的不稳定布局。
   流式 → 完成切换时 marked 渲染节点变化会让 collapse 条件失效引起 ~4px 跳变，
   gap 与 margin collapse 互不干涉，间距永远恒定。 */
.agent-message-stack {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.agent-message-stack > .step-text.step-analysis {
  margin: 0;
}

.agent-message-stack :deep(.thinking-block) {
  margin: 0;
}

/* footer 自身的 margin-top: 6px 在 stack 内会和 gap 叠加；让 stack gap 接管 */
.agent-message-stack > .agent-final-footer {
  margin-top: 0;
}

.step-text {
  word-break: break-word;
  line-height: 1.5;
}

/* AI 分析文本样式 */
.step-text.step-analysis {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.03);
  padding: 8px 10px;
  border-radius: 6px;
  margin: -4px 0;
}

/* Agent 步骤中的 markdown 样式 */
.step-text.step-analysis.markdown-content {
  font-size: 13px;
}

/* 流式输出时的样式优化 */
.step-text.step-analysis.markdown-content.is-streaming {
  /* 不设置固定最小高度，让内容自然撑开，从单行开始按需增长 */
  min-height: auto;
  /* 提示浏览器内容会变化 */
  will-change: contents;
}

.step-text.step-analysis.markdown-content :deep(p) {
  margin: 4px 0;
}

.step-text.step-analysis.markdown-content :deep(strong) {
  color: var(--accent-primary);
}

/* 思考过程引用块样式 */
.step-text.step-analysis.markdown-content :deep(blockquote) {
  margin: 8px 0;
  padding: 10px 14px;
  border-left: 3px solid var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.1);
  border-radius: 0 6px 6px 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.step-text.step-analysis.markdown-content :deep(blockquote p) {
  margin: 0;
}

.step-text.step-analysis.markdown-content :deep(hr) {
  margin: 12px 0;
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.step-result {
  margin-top: 6px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  max-height: 120px;
  overflow-y: auto;
}

.step-result pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-muted);
}

.huge-output-card {
  margin-top: 6px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.huge-output-title {
  margin: 0 0 4px;
  color: var(--text-primary);
  font-weight: 500;
}

.huge-output-size,
.huge-output-empty,
.huge-output-label {
  margin: 4px 0;
}

.huge-output-peek {
  margin: 0;
  max-height: 72px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--font-mono);
  font-size: 11px;
}

.huge-output-ellipsis {
  margin: 4px 0;
  text-align: center;
}

.huge-output-save {
  margin-top: 8px;
  padding: 4px 10px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
}

.step-images {
  margin-top: 8px;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.step-image {
  max-width: 200px;
  max-height: 150px;
  border-radius: 6px;
  cursor: pointer;
  object-fit: contain;
  transition: transform 0.15s, box-shadow 0.15s;
}

.step-image:hover {
  transform: scale(1.03);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.agent-step-inline.thinking {
  color: rgba(var(--brand-vital-rgb), 0.85);
}

.agent-step-inline.thinking .step-icon {
  animation: pulse 1.5s ease-in-out infinite;
}

.agent-step-inline.thinking .step-text {
  animation: pulse-text 2s ease-in-out infinite;
}

.agent-step-inline.tool_call {
  color: var(--accent-primary);
}

.agent-step-inline.tool_call .step-text {
  color: var(--text-primary);
}

/* tool_call 步骤的 content（如「执行命令: kill ...\nsleep 1\n...」）走纯文本渲染，
   不经过 markdown，所以这里只负责保留原文的换行和缩进，不做任何加粗/标题样式。 */
.step-text.tool-call-content {
  white-space: pre-wrap;
  word-break: break-word;
}

/* tool_call 内被 ToolCallContent 自动识别出的外部 URL / 本地路径链接：与 markdown-content
   里同名样式的视觉保持一致（accent 色 + 悬停下划线），只是作用域不同。 */
.step-text.tool-call-content :deep(a.external-url-link),
.step-text.tool-call-content :deep(a.file-path-link) {
  cursor: pointer;
  color: var(--accent-primary);
  text-decoration: none;
  word-break: break-all;
}

.step-text.tool-call-content :deep(a.external-url-link:hover),
.step-text.tool-call-content :deep(a.file-path-link:hover) {
  text-decoration: underline;
}

.agent-step-inline.error {
  color: var(--color-error);
}

.agent-step-inline.message {
  color: var(--text-primary);
}

/* 用户补充消息：样式类似用户消息气泡，但略有区分 */
.agent-step-inline.user_supplement {
  display: flex;
  justify-content: flex-end;
  background: transparent;
  border-left: none;
  padding-left: 0;
  margin-left: 0;
}

.agent-step-inline.user_supplement .step-content {
  background: var(--chat-user-supplement-bubble-bg);
  color: var(--chat-user-bubble-color, var(--text-primary));
  border: 1px solid var(--chat-user-bubble-border);
  border-radius: 12px 12px 4px 12px;
  padding: 8px 12px;
  max-width: 80%;
}

.agent-step-inline.user_supplement .step-icon {
  display: none;
}

.agent-step-inline.user_supplement .step-content :deep(a),
.agent-step-inline.user_supplement .step-content :deep(.file-path-link),
.agent-step-inline.user_supplement .step-content :deep(code.file-path-link) {
  color: inherit;
  text-decoration: underline;
  border-bottom: none;
}

.agent-step-inline.waiting {
  background: rgba(var(--color-info-rgb), 0.1);
  border-left: 3px solid var(--color-info);
  /* 覆盖 :last-child 的 padding-bottom: 0，否则有底色的卡片上下不对称 */
  padding: 8px 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
  align-items: center;
}

.agent-step-inline.waiting .step-icon {
  color: var(--color-info);
  line-height: 1;
}

.agent-step-inline.auto_review {
  background: rgba(var(--color-info-rgb), 0.08);
  border-left: 3px solid var(--color-info);
  padding: 8px 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.auto_review .step-icon {
  color: var(--color-info);
  line-height: 1;
}

.agent-step-inline.asking {
  background: rgba(var(--accent-rgb), 0.08);
  border-left: 3px solid var(--accent-primary);
  padding-left: 10px;
  padding-bottom: 8px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
}

.agent-step-inline.asking .step-icon {
  color: var(--accent-primary);
}

.agent-step-inline.waiting_password {
  background: rgba(var(--color-warning-rgb), 0.12);
  border-left: 3px solid var(--color-warning);
  padding: 8px 10px;
  margin-left: -2px;
  border-radius: 4px;
  color: var(--text-primary);
  align-items: center;
  animation: password-pulse 2s ease-in-out infinite;
}

.agent-step-inline.waiting_password .step-icon {
  color: var(--color-warning);
  line-height: 1;
  animation: key-bounce 1s ease-in-out infinite;
}

@keyframes password-pulse {
  0%, 100% { 
    background: rgba(var(--color-warning-rgb), 0.12);
    border-left-color: var(--color-warning);
  }
  50% { 
    background: rgba(var(--color-warning-rgb), 0.2);
    border-left-color: var(--color-warning);
  }
}

@keyframes key-bounce {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

/* 提问内容样式 */
.asking-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.asking-question {
  white-space: pre-wrap;
  line-height: 1.5;
  color: var(--text-primary);
}

.asking-body {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-top: 2px;
}

.asking-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 0 1 400px;
  min-width: 0;
}

.asking-countdown {
  flex-shrink: 0;
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
  line-height: 1;
}

.asking-option-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
  background: rgba(var(--accent-rgb), 0.06);
  border: 1px solid rgba(var(--accent-rgb), 0.2);
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  text-align: left;
}

.asking-option-btn .option-label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
}

.asking-option-btn .option-text {
  flex: 1;
}

.asking-option-btn .option-recommended-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
}

.asking-option-btn:hover:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.12);
  border-color: rgba(var(--accent-rgb), 0.35);
}

.asking-option-btn:active:not(:disabled) {
  background: rgba(var(--accent-rgb), 0.18);
}

.asking-option-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-option-btn.selected,
.asking-option-btn.selected:disabled {
  opacity: 1;
  background: rgba(var(--brand-vital-rgb), 0.12);
  border-color: rgba(var(--brand-vital-rgb), 0.35);
  color: var(--brand-vital);
}

.asking-option-btn.selected .option-label {
  background: rgba(var(--brand-vital-rgb), 0.25);
  color: var(--brand-vital);
}

/* 多选确认按钮 */
.asking-confirm-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 16px;
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--color-info) 100%);
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.asking-confirm-btn:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent-secondary) 0%, var(--accent-primary) 100%);
  box-shadow: 0 2px 8px rgba(var(--color-info-rgb), 0.35);
}

.asking-confirm-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.asking-status {
  font-size: 11px;
  margin-top: 2px;
}

.asking-status.status-waiting {
  color: var(--text-muted);
}

.asking-status.status-done {
  color: var(--color-success);
}

.asking-status.status-timeout {
  color: var(--color-warning);
}

.asking-status.status-cancelled {
  color: var(--color-error);
}

/* 计划步骤样式 */
.plan-step-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plan-step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 8px;
  margin: -4px -8px;
  border-radius: 6px;
  transition: background 0.15s ease;
}

.plan-step-header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.plan-step-text {
  flex: 1;
  color: var(--text-primary);
}

.plan-expand-icon {
  font-size: 10px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.plan-expand-icon.expanded {
  transform: rotate(90deg);
}

.plan-step-details {
  margin-top: 8px;
  padding: 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

/* 归档计划的特殊样式 */
.agent-step-inline.plan_archived .plan-step-text {
  color: var(--text-muted);
}

.agent-step-inline.plan_archived .plan-step-header:hover .plan-step-text {
  color: var(--text-primary);
}

/* ==================== Web 搜索结果（精简：无卡片/无摘要，只保留标题+域名） ==================== */

.web-search-content {
  color: var(--text-muted);
}

.web-search-header {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.web-search-header:hover .web-search-summary,
.web-search-header:hover .web-search-expand-icon {
  color: var(--text-primary);
}

.web-search-summary {
  color: var(--text-muted);
}

.web-search-expand-icon {
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.web-search-expand-icon.expanded {
  transform: rotate(90deg);
}

.web-search-list {
  list-style: none;
  margin: 4px 0 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.web-search-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.web-search-link {
  color: var(--color-info, #4dabf7);
  text-decoration: none;
  word-break: break-word;
  min-width: 0;
  flex-shrink: 1;
}

.web-search-link:hover {
  text-decoration: underline;
}

.web-search-host {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
  white-space: nowrap;
}

/* ==================== 并行子 Agent 卡片组 ==================== */

.sub-agents-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding: 6px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.sub-agent-card {
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.sub-agent-card.running {
  border-color: rgba(var(--color-info-rgb), 0.4);
}

.sub-agent-card.completed {
  border-color: rgba(var(--color-success-rgb), 0.3);
}

.sub-agent-card.failed {
  border-color: rgba(var(--color-error-rgb), 0.3);
}

.sub-agent-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
}

.sub-agent-header .sub-agent-status-icon,
.sub-agent-header .sub-agent-status-text,
.sub-agent-header .sub-agent-expand-icon {
  margin-top: 1px;
}

.sub-agent-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.sub-agent-status-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 12px;
}

.sa-icon-pending {
  color: var(--text-muted);
}

.sa-icon-running {
  color: var(--color-info);
  animation: sa-spin 1.2s linear infinite;
}

.sa-icon-completed {
  color: var(--color-success);
}

.sa-icon-failed {
  color: var(--color-error);
}

@keyframes sa-spin {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}

.sub-agent-header-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.sub-agent-desc {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-agent-activity {
  font-size: 11px;
  color: var(--color-info);
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: sa-spin 1.5s ease-in-out infinite;
}

.sub-agent-status-text {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.sub-agent-card.running .sub-agent-status-text {
  color: var(--color-info);
}

.sub-agent-card.completed .sub-agent-status-text {
  color: var(--color-success);
}

.sub-agent-card.failed .sub-agent-status-text {
  color: var(--color-error);
}

.sub-agent-expand-icon {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.sub-agent-expand-icon.expanded {
  transform: rotate(90deg);
}

.sub-agent-detail {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.1);
}

.sub-agent-prompt {
  padding: 6px 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.sub-agent-steps {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sa-step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

.sa-step-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 10px;
}

.sa-step-running { color: var(--color-info); }
.sa-step-done { color: var(--color-success); }
.sa-step-fail { color: var(--color-error); }

.sa-step-tool {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.sa-step-args {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-all;
}

.sub-agent-result {
  padding: 6px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.sub-agent-result pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

.sub-agent-result pre.sub-agent-error {
  color: var(--color-error);
}



/* 风险等级颜色 */
.risk-safe {
  border-left: 3px solid var(--color-success);
  padding-left: 10px;
  margin-left: -2px;
}

.risk-moderate {
  border-left: 3px solid var(--color-warning);
  padding-left: 10px;
  margin-left: -2px;
}

.risk-dangerous {
  border-left: 3px solid var(--color-error);
  padding-left: 10px;
  margin-left: -2px;
}

/* 预创建的 tool_call 卡片还没拿到 riskLevel 时的占位：保持和 risk-* 同样的几何尺寸
   （3px 左边框 + 10px 内边距 + -2px 外边距），颜色选用中性边线色。执行器接管后会被
   getRiskClass(riskLevel) 覆写为正式的 safe/moderate/dangerous 颜色，位置完全不动。 */
.risk-pending {
  border-left: 3px solid var(--border-color);
  padding-left: 10px;
  margin-left: -2px;
}

.risk-blocked {
  border-left: 3px solid #6b7280;
  padding-left: 10px;
}

/* 执行结果色 —— 仅 tool_call 步骤使用。
   红=执行失败、绿=执行成功，和风险等级（确认对话框里的红/黄/绿）视觉完全解耦：
   风险色只在"等待用户确认"时出现，执行后的卡片只看结果。 */
.exec-failed {
  border-left: 3px solid var(--color-error);
  padding-left: 10px;
  margin-left: -2px;
}

.exec-success {
  border-left: 3px solid var(--color-success);
  padding-left: 10px;
  margin-left: -2px;
}

/* 拒绝执行的步骤：走灰色 + 半透明，和"失败红"在视觉上区分开。
   注意：这里 border-left 色故意不用 --color-error，避免"拒绝"看起来像"失败"。 */
.step-rejected {
  opacity: 0.6;
  border-left: 3px solid #6b7280 !important;
  padding-left: 10px;
  margin-left: -2px;
}

/* Agent 确认对话框（融入对话） */
.agent-confirm-inline {
  padding: 14px;
  border-radius: 10px;
}

/* ===== 高风险 - 红色系 ===== */
.agent-confirm-inline.risk-dangerous {
  background: linear-gradient(135deg, #3b1018 0%, #2a0a10 100%) !important;
  border: 2px solid var(--color-error) !important;
  box-shadow: 0 4px 20px rgba(var(--color-error-rgb), 0.2);
}

/* ===== 中风险 - 警示橙（走 --brand-caution，跨主题固定醒目橙黄，与高/低风险强弱阶梯对齐） ===== */
.agent-confirm-inline.risk-moderate {
  background: linear-gradient(135deg, #3d2810 0%, #2a1a08 100%) !important;
  border: 2px solid var(--brand-caution) !important;
  box-shadow: 0 4px 20px rgba(var(--brand-caution-rgb), 0.2);
}

/* ===== 低风险 - 绿色系（走 --brand-vital，跨主题固定活力绿） ===== */
.agent-confirm-inline.risk-safe {
  background: linear-gradient(135deg, #0f2920 0%, #081a14 100%) !important;
  border: 2px solid var(--brand-vital) !important;
  box-shadow: 0 4px 20px rgba(var(--brand-vital-rgb), 0.15);
}

.confirm-header-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.confirm-icon {
  font-size: 20px;
}

.confirm-title {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.confirm-risk-badge {
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 4px;
  margin-left: auto;
}

.confirm-risk-badge.risk-dangerous {
  background: var(--color-error);
  color: #fff;
}

.confirm-risk-badge.risk-moderate {
  background: var(--brand-caution);
  color: #000;
}

.confirm-risk-badge.risk-safe {
  background: var(--brand-vital);
  color: #fff;
}

.confirm-detail {
  margin-bottom: 12px;
}

.confirm-tool-name {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 6px;
}

.confirm-args-inline {
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  margin: 0;
  max-height: 240px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: #fff;
}

.confirm-reasons {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-left: 3px solid rgba(255, 193, 7, 0.6);
  border-radius: 4px;
}

.confirm-reasons-title {
  font-size: 11px;
  font-weight: 600;
  color: rgba(255, 193, 7, 0.9);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.confirm-reasons-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  line-height: 1.6;
}

.confirm-reasons-list li {
  margin-bottom: 2px;
}

.confirm-auto-review {
  margin-top: 10px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.2);
  border-left: 3px solid rgba(96, 165, 250, 0.7);
  border-radius: 4px;
}

.confirm-auto-review-title {
  font-size: 11px;
  font-weight: 600;
  color: rgba(147, 197, 253, 0.95);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.confirm-auto-review-rationale {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.75);
  line-height: 1.6;
  white-space: pre-wrap;
}

.confirm-actions-inline {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  flex-wrap: wrap;
  align-items: center;
}

.trust-cmd-tag {
  margin-left: 4px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.9em;
  opacity: 0.85;
}

/*
 * 浅色 color-scheme：确认卡改用语义 tint，避免深色孤岛。
 * 风险感仍靠边框色 + badge + 主按钮；正文跟主题文字色。
 * 深色主题保持上方暗底渐变不变。
 */
[data-color-scheme="light"] .agent-confirm-inline.risk-dangerous {
  background: rgba(var(--color-error-rgb), 0.08) !important;
  border-color: rgba(var(--color-error-rgb), 0.45) !important;
  box-shadow: none;
}

[data-color-scheme="light"] .agent-confirm-inline.risk-moderate {
  background: rgba(var(--brand-caution-rgb), 0.1) !important;
  border-color: rgba(var(--brand-caution-rgb), 0.5) !important;
  box-shadow: none;
}

[data-color-scheme="light"] .agent-confirm-inline.risk-safe {
  background: rgba(var(--brand-vital-rgb), 0.08) !important;
  border-color: rgba(var(--brand-vital-rgb), 0.45) !important;
  box-shadow: none;
}

[data-color-scheme="light"] .confirm-title {
  color: var(--text-primary);
}

[data-color-scheme="light"] .confirm-tool-name {
  color: var(--text-secondary);
}

[data-color-scheme="light"] .confirm-args-inline {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
  color: var(--text-primary);
}

[data-color-scheme="light"] .confirm-reasons {
  background: rgba(var(--brand-caution-rgb), 0.08);
  border-left-color: rgba(var(--brand-caution-rgb), 0.55);
}

[data-color-scheme="light"] .confirm-reasons-title {
  color: var(--brand-caution-end, var(--color-warning));
}

[data-color-scheme="light"] .confirm-reasons-list {
  color: var(--text-secondary);
}

[data-color-scheme="light"] .confirm-auto-review {
  background: rgba(var(--color-info-rgb), 0.08);
  border-left-color: rgba(var(--color-info-rgb), 0.55);
}

[data-color-scheme="light"] .confirm-auto-review-title {
  color: var(--color-info);
}

[data-color-scheme="light"] .confirm-auto-review-rationale {
  color: var(--text-secondary);
}

/* 拒绝按钮原先按深色卡写死白字；浅色 tint 下改为主题描边按钮 */
[data-color-scheme="light"] .agent-confirm-inline .btn-outline-secondary {
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

[data-color-scheme="light"] .agent-confirm-inline .btn-outline-secondary:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* ===== 安全输入框（API Key 等） ===== */
.agent-secure-input-inline {
  padding: 14px;
  border-radius: 10px;
  background: linear-gradient(135deg, #1a1a2e 0%, #0f0f1a 100%);
  border: 2px solid var(--accent-primary, #6c63ff);
  box-shadow: 0 4px 20px rgba(108, 99, 255, 0.2);
}

.secure-input-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.secure-input-icon {
  font-size: 18px;
}

.secure-input-title {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
}

.secure-input-prompt {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.85);
  margin-bottom: 12px;
  line-height: 1.5;
}

.secure-input-body {
  margin-bottom: 12px;
}

.secure-input-field {
  width: 100%;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  color: #fff;
  font-size: 14px;
  font-family: var(--font-mono);
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

.secure-input-field:focus {
  border-color: var(--accent-primary, #6c63ff);
  box-shadow: 0 0 0 2px rgba(108, 99, 255, 0.25);
}

.secure-input-field::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.secure-input-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline-secondary {
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.25);
  color: rgba(255, 255, 255, 0.8);
}

.btn-outline-secondary:hover {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.btn-warning {
  background: var(--color-warning);
  border: 1px solid var(--color-warning);
  color: #000;
}

.btn-warning:hover:not(:disabled) {
  background: var(--color-warning);
  border-color: var(--color-warning);
}

/* 强警示按钮（删除/自由模式开启等不可逆操作）—— 走 --brand-alert */
.btn-danger {
  background: var(--brand-alert);
  border: 1px solid var(--brand-alert);
  color: #fff;
}

.btn-danger:hover:not(:disabled) {
  background: var(--brand-alert-end);
  border-color: var(--brand-alert-end);
}

/* 低风险允许执行按钮 —— 走 --brand-vital，跨主题固定活力绿
   （AiPanel scoped，仅作用于 Agent 确认卡片内的"允许执行"按钮） */
.btn-success {
  background: var(--brand-vital);
  border: 1px solid var(--brand-vital);
  color: #fff;
}

.btn-success:hover:not(:disabled) {
  background: var(--brand-vital-end);
  border-color: var(--brand-vital-end);
}

/* Outline 按钮样式（用于「加入规则并允许」等次要操作） */
.btn-outline-warning {
  background: transparent;
  border: 1px solid var(--color-warning);
  color: var(--color-warning);
}

.btn-outline-warning:hover:not(:disabled) {
  background: rgba(var(--color-warning-rgb), 0.15);
  color: var(--color-warning);
}

.btn-outline-danger {
  background: transparent;
  border: 1px solid var(--color-error);
  color: var(--color-error);
}

.btn-outline-danger:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.15);
  color: var(--color-error);
}

/* 「加入规则并允许」按钮 —— 走 --brand-vital，与低风险信号保持一致 */
.btn-outline-success {
  background: transparent;
  border: 1px solid var(--brand-vital);
  color: var(--brand-vital);
}

.btn-outline-success:hover:not(:disabled) {
  background: rgba(var(--brand-vital-rgb), 0.15);
  color: var(--brand-vital);
}

/* ==================== @ 命令补全菜单样式 ==================== */

.mention-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  margin-bottom: 8px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 -4px 24px rgba(0, 0, 0, 0.4);
  max-height: 320px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 100;
  animation: mentionMenuSlideUp 0.15s ease-out;
}

@keyframes mentionMenuSlideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
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
  /* 从右到左显示，让省略号在左边，优先显示路径最后部分 */
  direction: rtl;
  text-align: right;
}

.mention-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(var(--accent-rgb), 0.2);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.mention-empty {
  padding: 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}

.mention-list {
  flex: 1;
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

/* ==================== 图片上传预览条 ==================== */
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

/* ==================== 聊天中的图片消息 ==================== */
.message-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.message-image {
  max-width: 200px;
  max-height: 150px;
  border-radius: 8px;
  object-fit: cover;
  cursor: pointer;
  border: 1px solid var(--border-color);
  transition: transform 0.15s, box-shadow 0.15s;
}

.image-preview-hint {
  font-size: 11px;
  color: inherit;
  margin-top: 4px;
  opacity: 0.7;
}

.message-image:hover {
  transform: scale(1.02);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.3);
}

/* ==================== 聊天中的文件附件 ==================== */
.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.attachment-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface, var(--bg-secondary));
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.35;
  user-select: none;
}

.attachment-chip.clickable {
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
}

.attachment-chip.clickable:hover {
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-hover, var(--bg-secondary)));
  border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-color));
  box-shadow: 0 1px 4px color-mix(in srgb, var(--accent-primary) 18%, transparent);
}

.attachment-chip.clickable:active {
  background: color-mix(in srgb, var(--accent-primary) 18%, var(--bg-hover, var(--bg-secondary)));
}

.attachment-chip.clickable:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 2px;
}

.attachment-name {
  color: var(--text-primary);
  word-break: break-all;
}

.attachment-size {
  color: var(--text-muted);
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 11px;
}

/* ==================== 图片预览弹窗（支持缩放拖拽） ==================== */
.image-preview-modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s ease;
  cursor: default;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.image-preview-modal-content {
  position: relative;
  max-width: 90vw;
  max-height: 90vh;
  overflow: visible;
}

.image-preview-viewport {
  position: relative;
  overflow: visible;
}

.image-preview-full {
  position: absolute;
  top: 0;
  left: 0;
  object-fit: contain;
  border-radius: 8px;
  cursor: grab;
  transform-origin: 0 0;
  transition: none;
  user-select: none;
  -webkit-user-drag: none;
}

.image-preview-full.dragging {
  cursor: grabbing;
}

/* 「活图」预览容器：width / height 由 previewEchartsBoxStyle (JS) 内联提供。
 *
 * 不能纯靠 CSS 实现 contain 进 90vw × 90vh：父容器 .image-preview-modal-content
 * 是 max-content sizing，没有具体 width；子组件 EChartsCanvas 又得 width:100%
 * 才能跟随。两边互相依赖会塌陷为 0×0（曾经踩过这个坑——大图打不开就是这个原因）。
 *
 * 现在父容器拿到 JS 算好的具体像素，子元素 100%/100% 跟随，echarts 内部 ResizeObserver
 * 在 winSize 变化时自动 resize，没有 aspect-ratio 重复约束的边界 case。
 */
.image-preview-echarts {
  border-radius: 8px;
  cursor: grab;
  transform-origin: 0 0;
  transition: none;
  user-select: none;
  background: var(--bg-primary, #1a1a1a);
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  overflow: visible;
}

.image-preview-close {
  position: absolute;
  top: -12px;
  right: -12px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s, opacity 0.15s;
  z-index: 1;
}

.image-preview-close:hover {
  background: rgba(255, 255, 255, 0.3);
}

/* 底部信息栏 */
.image-preview-info-bar {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  align-items: center;
  pointer-events: none;
}

.image-preview-counter,
.image-preview-zoom-badge {
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  backdrop-filter: blur(4px);
  white-space: nowrap;
}

/* 导航箭头按钮 */
.image-preview-nav {
  position: fixed;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  z-index: 10001;
  backdrop-filter: blur(4px);
}

.image-preview-nav:hover {
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
}

.nav-left {
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
}

.nav-right {
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
}

.nav-up {
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
}

.nav-down {
  bottom: 56px;
  left: 50%;
  transform: translateX(-50%);
}

</style>

<!-- 全局样式：菜单通过 Teleport 渲染到 body，scoped 样式不会作用到它，需要单独的非 scoped block -->
<style>
.agent-group-menu {
  position: fixed;
  min-width: 140px;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  z-index: 10000;
}

.agent-group-menu-item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.agent-group-menu-item:hover {
  background: var(--bg-hover);
}

.agent-group-menu-item:disabled {
  cursor: progress;
  opacity: 0.5;
  pointer-events: none;
}
</style>
