/**
 * Agent 模式 composable
 * 处理 Agent 任务的运行、确认、事件监听等
 * 同时管理 AI 面板的滚动和终端状态
 */
import { ref, computed, watch, nextTick, onMounted, onUnmounted, Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore, COMPANION_TAB_AGENT_ID } from '../stores/terminal'
import { useConfigStore } from '../stores/config'
import { resolveConversationDisplayTitle } from '../utils/conversation-title'
import { applySearchMatch, isCurrentSearchRequest } from '../utils/history-search-stream'
import type { ExecutionMode, AttachmentInfo, AgentRecord, AgentHistorySummary, WorkbenchContext } from '@shared/types'
import type { AgentStep, AgentState, ParsedDocument } from '../stores/terminal'
import type { MessageScrollerHandle } from '../types/message-scroller'
import { createLogger } from '../utils/logger'
import { isAssistantConversationSurfaceVisible } from '../utils/agent-tab-ui-meta'
import { useTts } from './useTts'
import { shouldShowToolResultStep } from '../utils/tool-display'
import { foldProcessSteps, type ProcessFoldView, type ProcessStepRef, type StepPart } from '../utils/process-fold'
import { findTaskCompleteFooterIndex, groupAgentSteps, groupNeedsProcessCompleteFooter } from '../utils/agent-task-groups'
import { estimateMessageStepVirtualSize } from '../utils/thinking-block'
import { resolveWorkbenchAgentPrompt, resolveWorkbenchKind } from '../workbench'
import { showConfirm, showAlert } from './useConfirm'
import { toast } from './useToast'
import { resolveExactSlash } from './slash-commands'
import { formatAccelerator } from '../utils/shortcut'
import { coalescePendingHandoff, decideFollowUpDrain, mergePendingIntoQueue, optimisticPlaceholderConfirmedBy } from './follow-up-drain'

const log = createLogger('Agent')

function getLocalSystemInfo() {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('win')) {
    return { os: 'windows', shell: 'powershell', description: '' }
  } else if (platform.includes('mac')) {
    return { os: 'macos', shell: 'zsh', description: '' }
  }
  return { os: 'linux', shell: 'bash', description: '' }
}

const SCROLL_THRESHOLD = 100
const SCROLL_THROTTLE_MS = 1000
/** 现场灌入的主动提醒与刚落盘的那条时间可能差几十毫秒，按同文 + 短窗口去重 */
const COMPANION_PROACTIVE_DEDUP_MS = 5000

type CompanionStepLike = {
  id?: string
  type: string
  content: string
  timestamp?: number
}

function isDuplicateCompanionLiveStep(
  step: CompanionStepLike,
  mergedSteps: CompanionStepLike[],
  mergedIds: Set<string>
): boolean {
  if (step.id && mergedIds.has(step.id)) return true
  if (step.type !== 'proactive_notice') return false
  return mergedSteps.some(existing =>
    existing.type === 'proactive_notice'
    && existing.content === step.content
    && Math.abs((existing.timestamp ?? 0) - (step.timestamp ?? 0)) < COMPANION_PROACTIVE_DEDUP_MS
  )
}

export interface AgentTaskGroup {
  id: string
  /**
   * group 在 agentTaskGroups 数组中的 0-based 索引。
   * fork（"另开一聊"）时 untilTaskCount = index + 1，对齐后端按 user_task step 的切分。
   */
  index: number
  userTask: string
  images?: string[]
  attachments?: AttachmentInfo[]
  steps: AgentStep[]
  /** 这场已经收场后出现的过程（如人主动压缩），画在收场后面 */
  afterEndSteps: AgentStep[]
  finalResult?: string
  isCurrentTask: boolean
  isProactive?: boolean
  isOnboarding?: boolean
}

export interface FollowUpQueueItem {
  id: string
  message: string
  /** 传给模型的完整图片（含文档预览页） */
  images?: string[]
  previewImages?: string[]
  /** 仅输入框待发图片，编辑时填回用 */
  pendingImages?: string[]
  attachments?: AttachmentInfo[]
  /** 入队时的完整文档快照，编辑时填回输入框用 */
  parsedDocs?: ParsedDocument[]
  documentContext?: string
  workbenchContext?: WorkbenchContext
  /** 正在输入框里改这条——仍占队列位置，不参与 drain */
  editing?: boolean
}

export interface FollowUpQueueViewItem {
  id: string
  message: string
  editing?: boolean
}

export interface VirtualItem {
  id: string
  type: 'user_task' | 'step' | 'final_result' | 'proactive_message' | 'proactive_notice' | 'confirm' | 'waiting_input' | 'folded_turn'
  group?: AgentTaskGroup
  step?: AgentStep
  fold?: ProcessFoldView
  expanded?: boolean
  /** 这一格显示这条步骤的哪一半：只想的那截 / 只说出口的那句 / 整条 */
  part?: StepPart
  /** 折叠行点开后要显示的步骤。渲染在折叠行自己这一格里，高度才好平滑撑开 */
  children?: VirtualItem[]
  content?: string
  size: number
  isFirstStep?: boolean
  /** 成功收场：尾注挂在这一场的最后一格 */
  showTaskCompleteFooter?: boolean
}

export function useAgentMode(
  messagesRef: Ref<HTMLDivElement | null>,
  getDocumentContext: () => Promise<string>,
  getHostIdByTabId: (tabId: string) => Promise<string>,  // 根据 tabId 获取 hostId（不依赖 activeTab）
  autoProbeHostProfile: () => Promise<void>,
  tabId: Ref<string>,  // 每个 AiPanel 实例固定绑定的 tab ID
  imageCallbacks?: {
    getImages: () => string[]          // 全部图片（传给 AI 视觉模型）
    getPreviewImages?: () => string[]  // UI 展示用的预览图（仅 PDF 页面渲染），默认同 getImages
    getPendingImages?: () => string[]  // 仅输入框待发图片（不含文档页），编辑填回用
    clearImages: () => void
  },
  attachmentCallbacks?: {
    getAttachments: () => AttachmentInfo[]  // 获取当前已上传文件的元信息
    clearAttachments: () => void            // 清空已上传文件列表
    getParsedDocs?: () => ParsedDocument[]  // 入队/编辑时保留完整文档快照
  },
  scrollerRef?: Ref<MessageScrollerHandle | null>,
  tabActive?: Ref<boolean | undefined>
) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()
  const configStore = useConfigStore()
  const tts = useTts()
  const queueShortcutLabel = () => formatAccelerator(configStore.keyboardShortcuts.queueFollowUp)

  watch(
    () => [configStore.ttsSettings.enabled, configStore.ttsSettings.autoSpeak] as const,
    ([enabled, autoSpeak]) => {
      if (enabled && autoSpeak) {
        tts.enable()
      } else if (tts.isEnabled.value) {
        tts.stop()
        tts.isEnabled.value = false
      }
    },
    { immediate: true },
  )

  // 当前终端 ID（使用传入的 tabId，不再依赖 activeTabId）
  const currentTabId = tabId

  // ==================== 输入和滚动状态 ====================
  
  // 输入文本
  const inputText = ref('')

  /** 运行中 ⌘/Ctrl+Enter：等当前任务结束后作为下一件新任务，不插入当前执行 */
  const followUpQueue = ref<FollowUpQueueItem[]>([])
  const followUpQueueView = computed<FollowUpQueueViewItem[]>(() =>
    followUpQueue.value.map(({ id, message, editing }) => ({ id, message, editing }))
  )
  /** 正在输入框里改的那条排队 id；有值时回车/⌘回车都是保存回原位 */
  const editingFollowUpId = ref<string | null>(null)
  const editingFollowUpSnapshot = ref<FollowUpQueueItem | null>(null)
  const isEditingFollowUp = computed(() => editingFollowUpId.value != null)
  
  // 是否有新消息（用户不在底部时显示提示）
  const hasNewMessage = ref(false)
  
  // 标志：是否跳过 scroll 事件的状态更新（用于避免强制滚动时被 scroll 事件覆盖）
  let skipScrollUpdate = false

  // 用户主动跟底：发消息 / 点「新消息」后保持贴底跟随，直到用户明确上滚。
  // 虚拟列表 scrollHeight 异步修正时，scroll 事件会短暂误判「不在底部」；
  // 仅靠 checkIsNearBottom 会让 isUserNearBottom 抖动，hasNewMessage 闪烁并中断 ResizeObserver 跟底。
  let stickyFollowBottom = false
  let lastKnownScrollTop = 0
  let lastKnownScrollHeight = 0
  let lastAutoScrollAt = 0
  let scrollGraceTimer: ReturnType<typeof setTimeout> | null = null
  const AUTO_SCROLL_GRACE_MS = 150

  // 容器宽度变化驱动的 reflow 保护期截止时间戳。任何改变 AiPanel 宽度的操作
  // （产出物面板展开/收起、侧边栏、拖拽分隔条、窗口 resize、分屏）都会让聊天内容
  // reflow：同样内容变窄→变高，scrollHeight 变大但 scrollTop 不动，checkIsNearBottom()
  // 误判"离底"→污染 isUserNearBottom / 清掉 stickyFollowBottom → 流式 chunk 再来时
  // 停在上面一点并亮起「新消息」。reflow 期间 updateScrollPosition 跳过状态更新避免误判。
  let containerReflowGuardUntil = 0
  const CONTAINER_REFLOW_GUARD_MS = 500

  // hideUntilSettled 期间用 rAF 探测 scrollHeight 稳定后淡入；记录帧 / 定时器 id，
  // 组件卸载或重新触发时取消，避免卸载后 messagesRef 变 null 导致 tick 空转到兜底定时器。
  let pendingRevealFrame: number | null = null
  let pendingRevealTimer: ReturnType<typeof setTimeout> | null = null
  const cancelPendingReveal = () => {
    if (pendingRevealFrame !== null) {
      cancelAnimationFrame(pendingRevealFrame)
      pendingRevealFrame = null
    }
    if (pendingRevealTimer !== null) {
      clearTimeout(pendingRevealTimer)
      pendingRevealTimer = null
    }
  }

  // virtua 内置 scroll position adjustment，不再需要 FLIP / suppressFlip 机制。
  // suppressLayoutResizeCompensation 保留为空操作以兼容调用点；
  // 思考块展开的视区锚定由 anchorElementViewportY 负责。

  // 智能滚动节流状态
  let scrollPending = false
  let lastScrollTime = 0

  // Agent 执行模式设置
  const executionMode = ref<ExecutionMode>(
    configStore.executionMode === 'strict' || configStore.executionMode === 'free'
      ? configStore.executionMode
      : 'relaxed'
  )
  const commandTimeout = ref(10)     // 命令超时时间（秒），默认 10 秒
  const activeProfileId = ref<string>(configStore.activeAiProfileId || '')  // 当前终端选择的 AI 配置档案 ID（每个终端独立，初始值继承全局设置）
  const collapsedTaskIds = ref<Set<string>>(new Set())  // 已折叠的任务 ID
  const expandedProcessFoldIds = ref<Set<string>>(new Set())

  // 清理事件监听的函数
  let cleanupStepListener: (() => void) | null = null
  let cleanupStepRemovedListener: (() => void) | null = null
  let cleanupContextBarListener: (() => void) | null = null
  let cleanupModelFailoverListener: (() => void) | null = null
  let cleanupConfirmListener: (() => void) | null = null
  let cleanupConfirmResolvedListener: (() => void) | null = null
  let cleanupSecureInputListener: (() => void) | null = null
  let cleanupCompleteListener: (() => void) | null = null
  let cleanupErrorListener: (() => void) | null = null

  // 获取当前 tab（基于固定的 tabId）
  const currentTab = computed(() => {
    return terminalStore.tabs.find(t => t.id === currentTabId.value)
  })

  /** 设置里「启用 TTS + 自动朗读」且非远程会话时，对话流才喂给 TTS */
  const shouldAutoSpeak = computed(() =>
    configStore.ttsSettings.enabled
    && configStore.ttsSettings.autoSpeak
    && !currentTab.value?.isRemote
  )

  // ==================== 终端状态 ====================
  
  // 当前终端的 AI 加载状态（每个终端独立）
  const isLoading = computed(() => {
    return currentTab.value?.aiLoading || false
  })

  // 获取当前终端的系统信息。独立助手滑回对话台后不再展示这台终端的主机信息。
  const currentSystemInfo = computed(() => {
    const tab = currentTab.value
    if (!tab?.systemInfo) return null
    if (tab.type === 'assistant' && !tab.ptyId) return null
    return tab.systemInfo
  })

  // 获取当前终端选中的文本
  const terminalSelectedText = computed(() => {
    return currentTab.value?.selectedText || ''
  })

  // 获取最近的错误
  const lastError = computed(() => {
    return currentTab.value?.lastError
  })

  // ==================== 滚动相关 ====================
  
  // 用户是否在底部附近（从 store 获取，每个终端独立）
  const isUserNearBottom = computed(() => {
    const id = currentTabId.value
    if (!id) return true
    return terminalStore.getAiScrollNearBottom(id)
  })

  // 设置当前 tab 的 isUserNearBottom 状态
  const setIsUserNearBottom = (value: boolean) => {
    const id = currentTabId.value
    if (id) {
      terminalStore.setAiScrollNearBottom(id, value)
    }
  }

  // 检查用户是否在底部附近
  const checkIsNearBottom = () => {
    if (!messagesRef.value) return true
    const { scrollTop, scrollHeight, clientHeight } = messagesRef.value
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD
  }

  /**
   * scrollTop 下降是否由布局收缩/虚拟列表重测引起（浏览器 clamp scrollTop），
   * 而非用户主动上滚。ThinkingBlock 折叠、图片 reflow、item 估算→实测修正时常见。
   */
  const isLayoutInducedScrollUp = (el: HTMLElement): boolean => {
    const scrollTopDrop = lastKnownScrollTop - el.scrollTop
    if (scrollTopDrop <= 10) return false

    const scrollHeightDrop = lastKnownScrollHeight - el.scrollHeight
    if (scrollHeightDrop > 5 && scrollTopDrop <= scrollHeightDrop + 15) {
      return true
    }

    // sticky 跟底 / 程序化贴底后，scrollHeight 仍在变化时的 scroll 抖动，不计为用户离开
    if (
      stickyFollowBottom
      && Date.now() - lastAutoScrollAt < AUTO_SCROLL_GRACE_MS * 4
      && Math.abs(el.scrollHeight - lastKnownScrollHeight) > 5
    ) {
      return true
    }

    return false
  }

  const saveScrollTop = () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return
    const el = messagesRef.value
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    terminalStore.setAiScrollTop(id, el.scrollTop)
    if (maxScroll > 0) {
      terminalStore.setAiScrollRatio(id, el.scrollTop / maxScroll)
    }
    setIsUserNearBottom(checkIsNearBottom() || stickyFollowBottom)

    // 锚定复原：记"视口顶部那条 item 的 id + 距视口顶的 offset"。
    // findItemIndex 是 O(log n) 二分，每次 scroll 调用代价可忽略。
    const scroller = scrollerRef?.value
    if (scroller?.findItemIndex && scroller?.getItemOffset) {
      const idx = scroller.findItemIndex(el.scrollTop)
      const itemTop = scroller.getItemOffset(idx)
      const item = flattenedItems.value[idx]
      if (item?.id != null) {
        terminalStore.setAiScrollAnchor(id, { id: item.id, offset: el.scrollTop - itemTop })
      }
    }
  }

  const applySavedScrollTop = () => {
    if (!messagesRef.value) return
    const id = currentTabId.value
    if (!id) return
    const el = messagesRef.value
    const savedRatio = terminalStore.getAiScrollRatio(id)
    const saved = terminalStore.getAiScrollTop(id)
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    if (savedRatio !== undefined && maxScroll > 0) {
      el.scrollTop = savedRatio * maxScroll
    } else if (saved !== undefined) {
      el.scrollTop = saved
    }
  }

  /**
   * 锚定复原：用保存时的"视口顶 item id + offset"把那条消息钉回原视口位置。
   * scrollToIndex 内部用当前尺寸表算 itemPosition 再 scrollTop = itemPosition + offset，
   * offset 与上方 item 尺寸无关 → 即使上方估算→实测高度修正也不漂移。
   * 返回 false 时调用方回退到 ratio 复原。
   */
  const applyAnchorScrollTop = (): boolean => {
    const id = currentTabId.value
    if (!id) return false
    const anchor = terminalStore.getAiScrollAnchor(id)
    const scroller = scrollerRef?.value
    if (!anchor || !scroller?.scrollToIndex) return false
    const idx = flattenedItems.value.findIndex(i => i.id === anchor.id)
    if (idx < 0) return false
    scroller.scrollToIndex(idx, { align: 'start', offset: anchor.offset })
    return true
  }

  const restoreScrollTop = async () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return
    const hasAnchor = !!terminalStore.getAiScrollAnchor(id)
    const hasRatio = terminalStore.getAiScrollTop(id) !== undefined
      || terminalStore.getAiScrollRatio(id) !== undefined
    if (!hasAnchor && !hasRatio) return

    // 优先锚定复原（精确钉回原视口 item）；锚点失效（item 被删 / 库方法缺失）时回退 ratio
    const apply = () => {
      if (!applyAnchorScrollTop()) {
        applySavedScrollTop()
      }
    }

    apply()
    await nextTick()
    apply()
    requestAnimationFrame(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    })
    setTimeout(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    }, 150)
    // 虚拟列表 / Mermaid 等在 display:none 恢复后重测高度，晚到的 layout 需再对齐一次
    setTimeout(() => {
      apply()
      setIsUserNearBottom(checkIsNearBottom())
    }, 500)
  }

  /** 切回激活 tab：恢复滚动位置 */
  const restoreScrollPositionOnTabActivate = async () => {
    const id = currentTabId.value
    if (!id || !messagesRef.value) return

    await nextTick()

    if (terminalStore.getAiScrollNearBottom(id)) {
      scrollToHistoryBottomWithRetry()
    } else {
      await restoreScrollTop()
    }
  }

  /**
   * 历史恢复贴底期间隐藏消息列表，避免虚拟滚动尺寸重排造成的视觉弹跳。
   * opacity:0 不影响布局，待 scrollHeight 稳定后淡入。
   */
  const isHistoryScrollPending = ref(false)
  /** 历史冷加载 / 淡入后短窗口：禁指数追底，只硬钉（不延长打开等待） */
  let suppressFollowAnimUntil = 0

  /**
   * 历史对话滚到底部（重试 + 500ms 等待 mermaid/活图渲染后对齐）。
   * virtua 内置 scroll position adjustment，只需多次钉底即可。
   * @param opts.hideUntilSettled 历史冷加载路径传 true：额外 opacity:0，等 scrollHeight
   *        连续 2 rAF 稳定（或 520ms 兜底）后淡入；期间禁跟底滑动动画。
   */
  const scrollToHistoryBottomWithRetry = (opts?: { hideUntilSettled?: boolean }) => {
    const hide = opts?.hideUntilSettled === true
    if (hide) {
      // 冷加载：隐藏 + 禁跟底滑动，只硬钉；打开速度不变，避免测高过程中指数追底露馅
      isHistoryScrollPending.value = true
      suppressFollowAnimUntil = Math.max(suppressFollowAnimUntil, Date.now() + 600)
      cancelFollowScrollAnimation()
    }
    guardAfterAutoScroll()

    const apply = () => {
      // 历史路径一律硬钉，不走 animateFollowBottom
      pinFollowBottom()
    }
    void nextTick(() => {
      apply()
      setTimeout(() => {
        apply()
        saveScrollTop()
      }, 150)
      setTimeout(() => {
        apply()
        saveScrollTop()
      }, 500)

      if (!hide) return

      cancelPendingReveal()
      let revealed = false
      let lastH = -1
      let stable = 0
      const doReveal = () => {
        if (revealed) return
        revealed = true
        pendingRevealFrame = null
        pendingRevealTimer = null
        // 淡入前再硬钉一次；淡入后短窗口继续禁滑动（晚到的 mermaid/图片测高）
        pinFollowBottom()
        suppressFollowAnimUntil = Math.max(suppressFollowAnimUntil, Date.now() + 400)
        isHistoryScrollPending.value = false
      }
      pendingRevealTimer = setTimeout(doReveal, 520)
      const tick = () => {
        pendingRevealFrame = null
        if (revealed) return
        const el = messagesRef.value
        if (!el) return
        const h = el.scrollHeight
        if (h > 0 && h === lastH) stable++
        else stable = 0
        lastH = h
        if (stable >= 2) {
          doReveal()
        } else {
          pendingRevealFrame = requestAnimationFrame(tick)
        }
      }
      pendingRevealFrame = requestAnimationFrame(tick)
    })
  }

  /** 延长程序化贴底保护窗口，避免 scroll 事件在虚拟列表高度修正前误判离底 */
  const extendScrollGrace = () => {
    skipScrollUpdate = true
    if (scrollGraceTimer) clearTimeout(scrollGraceTimer)
    scrollGraceTimer = setTimeout(() => {
      scrollGraceTimer = null
      skipScrollUpdate = false
    }, AUTO_SCROLL_GRACE_MS)
  }

  /** ResizeObserver / scrollToBottom 程序化贴底后，短暂屏蔽 scroll 事件对跟底状态的污染 */
  const guardAfterAutoScroll = () => {
    lastAutoScrollAt = Date.now()
    stickyFollowBottom = true
    setIsUserNearBottom(true)
    hasNewMessage.value = false
    extendScrollGrace()
  }

  const shouldFollowBottom = () => stickyFollowBottom || isUserNearBottom.value

  /** 兼容保留：virtua 下视区锚定由调用方用 anchorElementViewportY 完成 */
  const suppressLayoutResizeCompensation = (_ms: number) => {
    // no-op
  }

  /** 把 anchorEl 钉回切换前的视口纵坐标，保持用户点击的那一行画面稳定 */
  const anchorElementViewportY = (anchorEl: HTMLElement, targetViewportTop: number) => {
    const el = messagesRef.value
    if (!el) return
    const delta = anchorEl.getBoundingClientRect().top - targetViewportTop
    if (Math.abs(delta) < 0.5) return
    el.scrollTop += delta
    lastKnownScrollTop = el.scrollTop
    lastKnownScrollHeight = el.scrollHeight
  }

  /**
   * 若 el 底部超出滚动容器视口，向下滚刚好露出（含 padding）。
   * @returns 是否发生了滚动
   */
  const ensureElementVisibleInViewport = (el: HTMLElement, padding = 16): boolean => {
    const container = messagesRef.value
    if (!container) return false
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const visibleBottom = containerRect.bottom - padding
    const overflow = elRect.bottom - visibleBottom
    if (overflow <= 0.5) return false
    container.scrollTop += overflow
    lastKnownScrollTop = container.scrollTop
    lastKnownScrollHeight = container.scrollHeight
    return true
  }

  // 容器宽度变化驱动的 reflow 进行中：此期间 scroll 事件算出的 checkIsNearBottom() 不可信
  // （scrollHeight 因宽度变化而变，与用户滚动意图无关），updateScrollPosition 应跳过状态更新。
  const isInContainerReflow = () => Date.now() < containerReflowGuardUntil

  /** Agent run 结束收口：清运行态 */
  const finalizeAgentRunWithScrollSettle = (tabId: string) => {
    terminalStore.finalizeAgentRunState(tabId)
  }

  /** 用户主动上滚离开底部：清除跟底粘性与 grace 窗口，避免流式 chunk 继续拽底 */
  const userScrolledAway = () => {
    stickyFollowBottom = false
    setIsUserNearBottom(false)
    // 不在这里亮起「新消息」：用户上滚不代表有新内容，只有 doScrollIfNeeded 发现
    // 实际有新内容到来且用户不在底部时才显示提示。
    if (scrollGraceTimer) {
      clearTimeout(scrollGraceTimer)
      scrollGraceTimer = null
    }
    skipScrollUpdate = false
    cancelFlipAnimation()
  }

  // 更新用户滚动位置状态（由组件的 scroll 事件调用）
  const updateScrollPosition = () => {
    const el = messagesRef.value
    if (!el) return

    const { scrollTop, scrollHeight } = el

    // 不在底部且 scrollTop 减小 → 用户上滚阅读，须优先于 skipScrollUpdate 早退
    // （拖滚动条上滚不会触发 wheel，但会触发 scroll；grace 期内早退会漏判）
    // 布局收缩/虚拟列表重测导致的 scrollTop clamp 不算用户上滚，避免误清 stickyFollowBottom。
    if (scrollTop < lastKnownScrollTop - 10 && !checkIsNearBottom()) {
      if (!isLayoutInducedScrollUp(el)) {
        userScrolledAway()
        lastKnownScrollTop = scrollTop
        lastKnownScrollHeight = scrollHeight
        saveScrollTop()
        return
      }
      lastKnownScrollTop = scrollTop
      lastKnownScrollHeight = scrollHeight
      return
    }

    // 跳过强制滚动期间的状态更新，避免被 scroll 事件覆盖
    if (skipScrollUpdate) return

    // 容器宽度变化驱动的 reflow 进行中：scrollHeight 因内容 reflow 而变，与用户滚动意图无关。
    // 此期间 checkIsNearBottom() 不可信，跳过状态更新，避免误判"离底"清掉 stickyFollowBottom。
    // 但保留"用户主动滚到底部→恢复跟底"的通道：reflow 期间用户仍可能主动滚到底，此时应恢复
    // stickyFollowBottom，避免 reflow 结束后第一次流式 chunk 因 sticky=false 而不贴底。
    if (isInContainerReflow()) {
      if (checkIsNearBottom()) {
        stickyFollowBottom = true
        setIsUserNearBottom(true)
      }
      lastKnownScrollTop = scrollTop
      lastKnownScrollHeight = scrollHeight
      return
    }

    const nearBottom = checkIsNearBottom()
    const outsideAutoScrollGrace = Date.now() - lastAutoScrollAt > AUTO_SCROLL_GRACE_MS
    const scrolledUpSignificantly =
      outsideAutoScrollGrace && scrollTop < lastKnownScrollTop - SCROLL_THRESHOLD

    if (nearBottom) {
      stickyFollowBottom = true
      hasNewMessage.value = false
    } else if (scrolledUpSignificantly) {
      if (!isLayoutInducedScrollUp(el)) {
        userScrolledAway()
        lastKnownScrollTop = scrollTop
        lastKnownScrollHeight = scrollHeight
        saveScrollTop()
        return
      }
    }

    lastKnownScrollTop = scrollTop
    lastKnownScrollHeight = scrollHeight
    setIsUserNearBottom(nearBottom || stickyFollowBottom)
    saveScrollTop()
  }

  // ==================== 跟底平滑滚动 ====================
  // 不用 translateY FLIP，也不用「from/to + 进度 p」的三次缓动：
  // 流式长高时重算 from/to 会放大瞬时速度，表现为流畅中突然微跳。
  // 改为每帧指数逼近当前底部：目标抬高只增加 remain，速度连续、无重定向尖峰。
  const FOLLOW_CATCHUP_RATE = 14 // ~250ms 收到 95%；略大则更跟手
  const FOLLOW_CATCHUP_BOOST_REMAIN = 280 // 落后较多时略加快，避免字快时拖尾
  let followAnimRaf: number | null = null
  let followAnimLastTs = 0

  const cancelFollowScrollAnimation = () => {
    if (followAnimRaf !== null) {
      cancelAnimationFrame(followAnimRaf)
      followAnimRaf = null
    }
    followAnimLastTs = 0
    const wrapper = followObservedTarget
    if (wrapper) {
      wrapper.style.transition = ''
      wrapper.style.transform = ''
    }
  }

  /** 兼容旧调用名 */
  const cancelFlipAnimation = cancelFollowScrollAnimation

  /** 硬切钉底（发消息 / 点新消息） */
  const pinFollowBottom = () => {
    cancelFollowScrollAnimation()
    const el = messagesRef.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    scrollerRef?.value?.scrollToBottom?.()
    lastKnownScrollTop = el.scrollTop
    lastKnownScrollHeight = el.scrollHeight
  }

  /** 跟底态：指数逼近底部；历史冷加载窗口内改硬钉，避免打开时露滑动 */
  const animateFollowBottom = () => {
    if (isHistoryScrollPending.value || Date.now() < suppressFollowAnimUntil) {
      pinFollowBottom()
      return
    }
    const el = messagesRef.value
    if (!el) return
    const target = Math.max(0, el.scrollHeight - el.clientHeight)
    if (target - el.scrollTop <= 0.5) return
    if (followAnimRaf !== null) return

    followAnimLastTs = 0
    const tick = (now: number) => {
      const box = messagesRef.value
      if (!box || !shouldFollowBottom()) {
        followAnimRaf = null
        followAnimLastTs = 0
        return
      }
      // 冷加载窗口中途切入：停动画、硬钉
      if (isHistoryScrollPending.value || Date.now() < suppressFollowAnimUntil) {
        followAnimRaf = null
        followAnimLastTs = 0
        pinFollowBottom()
        return
      }

      if (!followAnimLastTs) followAnimLastTs = now
      const dt = Math.min(0.048, (now - followAnimLastTs) / 1000)
      followAnimLastTs = now

      const latestTarget = Math.max(0, box.scrollHeight - box.clientHeight)
      const cur = box.scrollTop
      const remain = latestTarget - cur

      if (remain <= 0.5) {
        if (remain > 0) box.scrollTop = latestTarget
        lastKnownScrollTop = box.scrollTop
        lastKnownScrollHeight = box.scrollHeight
        followAnimRaf = null
        followAnimLastTs = 0
        return
      }

      // 1 - e^(-k dt)：逼近目标，不过冲；字快时 remain 大则自然加快
      const rate = remain > FOLLOW_CATCHUP_BOOST_REMAIN
        ? FOLLOW_CATCHUP_RATE * 1.35
        : FOLLOW_CATCHUP_RATE
      const alpha = 1 - Math.exp(-rate * dt)
      box.scrollTop = cur + remain * alpha
      lastKnownScrollTop = box.scrollTop
      lastKnownScrollHeight = box.scrollHeight
      followAnimRaf = requestAnimationFrame(tick)
    }

    followAnimRaf = requestAnimationFrame(tick)
  }

  const scrollToBottom = async () => {
    // 同步先设 sticky，避免 nextTick 前到达的 step 因 sticky=false 误判离底
    guardAfterAutoScroll()
    cancelFollowScrollAnimation()

    await nextTick()
    pinFollowBottom()

    guardAfterAutoScroll()
    requestAnimationFrame(() => saveScrollTop())
  }

  // 实际执行滚动：跟底意图交给 sticky；平滑追底由 followResizeObserver 单点完成。
  // 禁止在这里先硬钉底，否则 RO 看到 gap≈0，动画被跳过。
  const doScrollIfNeeded = async () => {
    lastScrollTime = Date.now()
    await nextTick()

    if (shouldFollowBottom()) {
      if (messagesRef.value) {
        stickyFollowBottom = true
        setIsUserNearBottom(true)
        hasNewMessage.value = false
        extendScrollGrace()
        // RO 漏触发时的兜底：下一帧仍离底再追一次
        requestAnimationFrame(() => {
          const el = messagesRef.value
          if (!el || !shouldFollowBottom()) return
          if (!checkIsNearBottom()) {
            animateFollowBottom()
            guardAfterAutoScroll()
          }
        })
      }
    } else {
      hasNewMessage.value = true
    }
  }

  // 智能滚动：只有用户在底部附近时才自动滚动（带节流）
  const scrollToBottomIfNeeded = async () => {
    const now = Date.now()
    
    // 节流：如果距离上次滚动时间过短，标记为待处理
    if (now - lastScrollTime < SCROLL_THROTTLE_MS) {
      if (!scrollPending) {
        scrollPending = true
        requestAnimationFrame(() => {
          scrollPending = false
          doScrollIfNeeded()
        })
      }
      return
    }
    
    await doScrollIfNeeded()
  }

  // ==================== 跟底态：内容高度变化时平滑追底 ====================
  // virtua 负责上方 item 高度修正的视区锚定，但不负责「最后一项流式长高时保持贴底」。
  // 这里只在 shouldFollowBottom 且内容变高时启动/维持指数追底。
  let followResizeObserver: ResizeObserver | null = null
  let followObservedTarget: HTMLElement | null = null
  let prevFollowContentHeight = 0

  const installFollowResizeObserver = () => {
    uninstallFollowResizeObserver()
    const el = messagesRef.value
    if (!el) return
    // Virtualizer 是滚动容器的最后一个子节点（WelcomePanel / Modal 在其前或 fixed）
    const target = el.lastElementChild as HTMLElement | null
    if (!target) return
    followObservedTarget = target
    prevFollowContentHeight = target.offsetHeight
    followResizeObserver = new ResizeObserver((entries) => {
      if (tabActive?.value === false) return
      if (!shouldFollowBottom()) return
      const newH = entries[0]?.contentRect.height ?? target.offsetHeight
      const grew = newH > prevFollowContentHeight + 0.5
      prevFollowContentHeight = newH
      if (!grew) return

      guardAfterAutoScroll()
      animateFollowBottom()
    })
    followResizeObserver.observe(target)
  }

  const uninstallFollowResizeObserver = () => {
    cancelFollowScrollAnimation()
    if (followResizeObserver && followObservedTarget) {
      followResizeObserver.unobserve(followObservedTarget)
    }
    followResizeObserver?.disconnect()
    followResizeObserver = null
    followObservedTarget = null
    prevFollowContentHeight = 0
  }

  // ==================== 容器宽度变化感知（保留） ====================
  // virtua 处理动态高度的 scroll adjustment；这里只处理宽度变化导致的 reflow。
  let containerWidthObserver: ResizeObserver | null = null
  let prevContainerWidth = 0

  const installContainerWidthObserver = () => {
    uninstallContainerWidthObserver()
    const el = messagesRef.value
    if (!el) return
    prevContainerWidth = el.clientWidth
    containerWidthObserver = new ResizeObserver(() => {
      if (tabActive?.value === false) return
      const newWidth = el.clientWidth
      if (newWidth === prevContainerWidth) return
      prevContainerWidth = newWidth

      containerReflowGuardUntil = Date.now() + CONTAINER_REFLOW_GUARD_MS

      if (!shouldFollowBottom()) return

      guardAfterAutoScroll()
      void scrollToBottom()
    })
    containerWidthObserver.observe(el)
  }

  const uninstallContainerWidthObserver = () => {
    containerWidthObserver?.disconnect()
    containerWidthObserver = null
    prevContainerWidth = 0
    containerReflowGuardUntil = 0
  }

  const onMessagesWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) {
      userScrolledAway()
    }
  }

  // messagesRef 由 AiPanel 赋值；跟随它生命周期挂载/卸载观察器
  watch(messagesRef, (el, oldEl) => {
    if (oldEl === el) return
    oldEl?.removeEventListener('wheel', onMessagesWheel)
    uninstallFollowResizeObserver()
    uninstallContainerWidthObserver()
    if (el) {
      lastKnownScrollTop = el.scrollTop
      lastKnownScrollHeight = el.scrollHeight
      el.addEventListener('wheel', onMessagesWheel, { passive: true })
      requestAnimationFrame(() => {
        installFollowResizeObserver()
        installContainerWidthObserver()
      })
    }
  }, { flush: 'post' })

  // 停止生成
  const stopGeneration = async () => {
    if (currentTabId.value) {
      // 传入 tabId 只中止当前终端的请求，不影响其他终端
      await window.electronAPI.ai.abort(currentTabId.value)
      terminalStore.setAiLoading(currentTabId.value, false)
    }
  }

  // Agent 状态
  const agentState = computed((): AgentState | undefined => {
    return currentTab.value?.agentState as AgentState | undefined
  })

  const isAgentRunning = computed(() => {
    return agentState.value?.isRunning || false
  })

  const pendingConfirm = computed(() => {
    return agentState.value?.pendingConfirm
  })

  const pendingSecureInput = computed(() => {
    return agentState.value?.pendingSecureInput
  })

  const agentUserTask = computed(() => {
    return agentState.value?.userTask
  })

  // 当前执行计划 - 从 steps 中提取最新的 plan
  const currentPlan = computed((): AgentPlan | undefined => {
    const steps = agentState.value?.steps || []
    // 倒序查找最新的 plan 相关步骤
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i]
      // 如果遇到 plan_archived，说明计划已被归档，当前无活跃计划
      if (step.type === 'plan_archived') {
        return undefined
      }
      // 如果遇到 plan_created 或 plan_updated 且有 plan 数据
      if ((step.type === 'plan_created' || step.type === 'plan_updated') && step.plan) {
        return step.plan as AgentPlan
      }
    }
    return undefined
  })

  // 切换任务步骤折叠状态
  const toggleStepsCollapse = (taskId: string) => {
    if (collapsedTaskIds.value.has(taskId)) {
      collapsedTaskIds.value.delete(taskId)
    } else {
      collapsedTaskIds.value.add(taskId)
    }
  }

  // 检查任务是否折叠
  const isStepsCollapsed = (taskId: string) => {
    return collapsedTaskIds.value.has(taskId)
  }

  const toggleProcessFold = (foldId: string) => {
    const next = new Set(expandedProcessFoldIds.value)
    if (next.has(foldId)) next.delete(foldId)
    else next.add(foldId)
    expandedProcessFoldIds.value = next
  }

  // 获取当前 tab 对应的 Agent 标识符（agentKey）。
  //
  // 概念模型：一个 tab = 一个 Agent + N 个终端窗格。
  //   - 终端 tab：agentKey = tab.id（稳定，不随分屏/focus 变化）
  //   - 助手 tab：agentKey = tab.agentId（前端生成的 UUID）
  //
  // 后端 AgentService 用 agentKey 在 Map 中索引 Agent 实例。Agent 内部通过每次 run 的
  // context.ptyId 知道要操作哪个窗格——窗格切换不影响 Agent 实例。
  const getAgentKey = (): string | undefined => {
    const tab = currentTab.value
    if (!tab) return undefined
    if (tab.type === 'assistant') return tab.agentId
    return tab.id
  }

  // 监听执行模式变化，实时更新运行中的 Agent
  watch(executionMode, async (newValue) => {
    const promises: Promise<unknown>[] = []

    // 远程 tab：同步到 WebChatService（运行时覆盖，不持久化）
    if (currentTab.value?.isRemote) {
      promises.push(
        window.electronAPI.webChat.setExecutionMode(newValue).catch(err => {
          log.error('Failed to sync execution mode to WebChatService:', err)
        })
      )
    }

    const key = getAgentKey()
    if (key && isAgentRunning.value) {
      promises.push(
        window.electronAPI.agent.updateConfig(key, { executionMode: newValue })
      )
    }

    await Promise.all(promises)
  })

  // 监听超时设置变化
  watch(commandTimeout, async (newValue) => {
    const key = getAgentKey()
    if (key && isAgentRunning.value) {
      await window.electronAPI.agent.updateConfig(key, { commandTimeout: newValue * 1000 })
    }
  })

  // 监听模型配置变化，实时同步到运行中的 Agent
  watch(activeProfileId, async (newValue) => {
    const key = getAgentKey()
    if (key && newValue) {
      // 切模型即刻同步后端绑定：不再要求 Agent 正在运行——否则空闲时 IM 联络进来
      // 会沿用上一次的 profileId（表现为「联络一直粘滞 DeepSeek」）。详见 agent/SPEC.md。
      await window.electronAPI.agent.updateConfig(key, { profileId: newValue })
    }
  })
  // 按任务分组的步骤（每个任务包含：用户任务 + 步骤块 + 最终结果）
  const agentTaskGroups = computed((): AgentTaskGroup[] => {
    const allSteps = agentState.value?.steps || []
    const { groups: drafts, orphanedStepCount } = groupAgentSteps(allSteps)
    const groups: AgentTaskGroup[] = drafts.map(draft => ({
      ...draft,
      isCurrentTask: false,
    }))

    // 标记最后一个未完成的任务为当前任务
    if (groups.length > 0) {
      const lastGroup = groups[groups.length - 1]
      if (!lastGroup.finalResult) {
        lastGroup.isCurrentTask = true
      }
    }

    
    // 不再删除"跟 finalResult 重复"的最后一个 message step：
    // 现在 message step 始终保留完整内容（思考块 + 正文），成功的 final_result 不再单独渲染卡片，
    // 删除 message step 反而会让正文连同思考块一起消失。失败/中断的 final_result 才独立成卡。
    
    // 诊断日志：仅在远程 tab 且有变化时打印
    const tab = currentTab.value
    if (tab?.isRemote) {
      const stepTypes = allSteps.map(s => s.type)
      const userTaskCount = stepTypes.filter(t => t === 'user_task').length
      const finalResultCount = stepTypes.filter(t => t === 'final_result').length
      log.debug(`[Groups] tabId=${tab.id}, totalSteps=${allSteps.length}, groups=${groups.length}, userTasks=${userTaskCount}, finals=${finalResultCount}, orphaned=${orphanedStepCount}, stepTypes=[${stepTypes.join(',')}]`)
    }
    
    return groups
  })

  const isStreamingOutput = (group: AgentTaskGroup): boolean => {
    if (group.steps.length === 0) return false
    const lastStep = group.steps[group.steps.length - 1]
    if (lastStep.type === 'message' && (lastStep.isStreaming || lastStep.content.length > 0)) {
      return true
    }
    if (lastStep.type === 'waiting' || lastStep.type === 'asking' || lastStep.type === 'waiting_password') {
      return true
    }
    return false
  }

  /** 当前任务尚无 Agent 产出步骤时，在列表内注入虚拟「正在准备...」（非居中） */
  const shouldInjectPreparingStep = (group: AgentTaskGroup): boolean => {
    if (!group.isCurrentTask || group.finalResult || !isAgentRunning.value) return false
    return !group.steps.some(s =>
      s.type === 'thinking' || s.type === 'message' || s.type === 'tool_call' ||
      s.type === 'waiting' || s.type === 'asking' || s.type === 'waiting_password' ||
      s.type === 'error'
    )
  }

  const flattenedItems = computed((): VirtualItem[] => {
    const items: VirtualItem[] = []

    for (const group of agentTaskGroups.value) {
      if (group.isProactive) {
        // 历史格式（user_task __proactive__ + final_result）走 proactive_message 虚拟项
        if (group.finalResult) {
          items.push({ id: `proactive_${group.id}`, type: 'proactive_message', group, size: 80 })
        }
        continue
      }

      if (!group.isOnboarding) {
        items.push({ id: `user_${group.id}`, type: 'user_task', group, size: 60 })
      }

      const debugMode = configStore.agentDebugMode
      const foldEnabled = !debugMode && configStore.foldAgentProcess && executionMode.value !== 'strict'
      const emitProcessSteps = (processSteps: AgentStep[]) => {
        if (processSteps.length === 0) return
        const visibleSteps = processSteps.filter(s => shouldShowToolResultStep(s, debugMode))
        const segments = foldProcessSteps(visibleSteps, { enabled: foldEnabled })

        let emittedFirst = false
        const toStepItem = (ref: ProcessStepRef<AgentStep>, isFirst: boolean): VirtualItem => {
          const { step, part } = ref
          if (step.type === 'proactive_notice') {
            return { id: step.id, type: 'proactive_notice', step, group, size: 80 }
          }
          const size = step.type === 'message'
            ? estimateMessageStepVirtualSize(step)
            : step.type === 'user_supplement' ? 60
            : step.type === 'asking' ? 120 : isFirst ? 46 : 40
          const id = part === 'thinking' ? `${step.id}#thinking` : step.id
          return { id, type: 'step', step, part, group, size, isFirstStep: isFirst }
        }
        const pushStepItem = (ref: ProcessStepRef<AgentStep>) => {
          const isFirst = !emittedFirst && ref.step.type !== 'proactive_notice'
          emittedFirst = true
          items.push(toStepItem(ref, isFirst))
        }

        for (const seg of segments) {
          if (seg.kind === 'open') {
            for (const ref of seg.steps) pushStepItem(ref)
            continue
          }
          const isFirst = !emittedFirst
          emittedFirst = true
          items.push({
            id: seg.fold.id,
            type: 'folded_turn',
            group,
            fold: seg.fold,
            expanded: expandedProcessFoldIds.value.has(seg.fold.id),
            children: seg.steps.map(ref => toStepItem(ref, false)),
            size: 30,
            isFirstStep: isFirst,
          })
        }
      }

      emitProcessSteps(group.steps)

      // 后端 initial thinking step 到达前，在步骤流末尾补虚拟「正在准备...」（左侧 ThinkingBlock）
      if (shouldInjectPreparingStep(group)) {
        const userTaskStep = agentState.value?.steps.find(s => s.id === group.id)
        const preparingStep: AgentStep = {
          id: `__preparing_${group.id}`,
          type: 'thinking',
          content: t('ai.preparing'),
          isStreaming: true,
          timestamp: userTaskStep?.timestamp ?? Date.now(),
        }
        const hasPriorAgentStep = group.steps.some(s => s.type !== 'user_supplement')
        items.push({
          id: preparingStep.id,
          type: 'step',
          step: preparingStep,
          group,
          size: 46,
          isFirstStep: !hasPriorAgentStep,
        })
      }

      if (group.finalResult) {
        // 失败 / 中断的 final_result 才作为独立卡片渲染（包含错误信息）；
        // 成功的 final_result 不再渲染——message step 已经完整呈现思考块 + 正文，
        // 独立"任务完成"卡反而会引起列表跳动。
        const isFailureFinal = group.finalResult.startsWith('❌') || group.finalResult.startsWith('⚠️')
        if (isFailureFinal) {
          // 若 group 没有其它步骤（典型的纯对话场景），让 final_result 承担"首条"标识，
          // 以便渲染 standalone 头像，避免从流式 → 完成时头像消失
          items.push({ id: `final_${group.id}`, type: 'final_result', group, size: 80, isFirstStep: group.steps.length === 0 })
        }
      }

      emitProcessSteps(group.afterEndSteps)

      if (groupNeedsProcessCompleteFooter(group)) {
        const footerIndex = findTaskCompleteFooterIndex(items, group.id)
        if (footerIndex >= 0) {
          const item = items[footerIndex]
          item.showTaskCompleteFooter = true
          item.size += 28
        }
      }
    }

    if (pendingConfirm.value) {
      items.push({ id: '__confirm__', type: 'confirm', size: 280 })
    }

    if (pendingSecureInput.value) {
      items.push({ id: '__secure_input__', type: 'waiting_input', size: 220 })
    }

    return items
  })

  // 运行 Agent 或发送补充消息
  const runAgent = async (
    overrideMessage?: string,
    options?: {
      workbenchContext?: WorkbenchContext
      enqueue?: boolean
      queuedPayload?: FollowUpQueueItem
    }
  ) => {
    const queued = options?.queuedPayload
    const hasImageData = (
      queued ? (queued.images?.length ?? 0) : (imageCallbacks?.getImages()?.length ?? 0)
    ) > 0
    const message = overrideMessage ?? inputText.value
    const putBackQueued = () => {
      if (!queued) return
      if (followUpQueue.value.some(entry => entry.id === queued.id)) return
      followUpQueue.value = [queued, ...followUpQueue.value]
    }
    // attachments 含已落盘图片元信息，不只是文档
    const hasAttachments = queued
      ? ((queued.parsedDocs?.length ?? 0) > 0 || (queued.attachments?.length ?? 0) > 0)
      : (
          (attachmentCallbacks?.getParsedDocs?.()?.length ?? 0) > 0 ||
          (attachmentCallbacks?.getAttachments()?.length ?? 0) > 0
        )
    if (
      (!message.trim() &&
        !hasImageData &&
        !hasAttachments &&
        !options?.workbenchContext?.selectionScope?.excerpt?.trim()) ||
      !currentTabId.value
    ) {
      putBackQueued()
      return
    }

    const tabId = currentTabId.value

    const isAssistantMode = currentTab.value?.type === 'assistant'

    // 如果 Agent 正在运行，发送补充消息而不是启动新任务
    // 用 getAgentKey() 拿 Agent 启动时绑定的稳定 key（不随激活窗格变化）
    const agentKey = getAgentKey()
    // 联络常驻线：界面旗标可能落后于后端（IM 已开工、桌面 isRunning 还没置上）。
    // 这时再走「新开一轮」会撞上 already running，回车后字就没了。
    const injectIntoCurrentRun = await checkInjectIntoCurrentRun()
    const compactSlash = resolveExactSlash(message)
    if (injectIntoCurrentRun) {
      // 排队项是「上一轮结束后的下一轮」，不是插进当前这场。
      // 这时若还判成「正在跑」，插进去会用已经清空的输入框，图和附件都丢，队列里也不见了。
      if (queued && !options?.enqueue) {
        putBackQueued()
        if (!isAgentRunning.value) scheduleNextFollowUp(tabId)
        return
      }
      if (compactSlash?.def.id === 'compact' && !options?.enqueue) {
        putBackQueued()
        toast.warning(t('ai.slashCompactRunning', { shortcut: queueShortcutLabel() }))
        return
      }
      if (options?.enqueue) {
        if (compactSlash?.def.id === 'compact') {
          followUpQueue.value = [
            ...followUpQueue.value,
            {
              id: `followup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              message
            }
          ]
          inputText.value = ''
          return
        }
        const attachments = attachmentCallbacks?.getAttachments() || []
        const parsedDocs = attachmentCallbacks?.getParsedDocs?.() || []
        const documentContext = await getDocumentContext()
        const images = imageCallbacks?.getImages() || []
        const previewImages = imageCallbacks?.getPreviewImages?.() || images
        const pendingImages = imageCallbacks?.getPendingImages?.() || []
        followUpQueue.value = [
          ...followUpQueue.value,
          {
            id: `followup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            message,
            images: images.length > 0 ? images : undefined,
            previewImages: previewImages.length > 0 ? previewImages : undefined,
            pendingImages: pendingImages.length > 0 ? pendingImages : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            parsedDocs: parsedDocs.length > 0 ? parsedDocs.map(d => ({ ...d })) : undefined,
            documentContext: documentContext || undefined,
            workbenchContext: options.workbenchContext
          }
        ]
        inputText.value = ''
        if (attachments.length > 0 || parsedDocs.length > 0) attachmentCallbacks?.clearAttachments()
        if (images.length > 0) imageCallbacks?.clearImages()
        return
      }

      if (!agentKey) return

      inputText.value = ''

      // 收集附件元信息、文档内容、图片（与新任务路径对齐）
      const supplementAttachments = attachmentCallbacks?.getAttachments() || []
      const images = imageCallbacks?.getImages() || []
      const previewImages = imageCallbacks?.getPreviewImages?.() || images
      const optimisticId = `__optimistic_user_supplement_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
      const parsedDocs = attachmentCallbacks?.getParsedDocs?.() || []

      // 输入框这边已经清掉了，先上墙，避免等 IPC / 步骤回调期间对话里什么都没有
      terminalStore.addAgentStep(tabId, {
        id: optimisticId,
        type: 'user_supplement',
        content: message,
        images: previewImages.length > 0 ? previewImages : undefined,
        attachments: supplementAttachments.length > 0 ? supplementAttachments : undefined,
        timestamp: Date.now(),
      })
      void scrollToBottom()

      let documentContext = ''
      let success = false
      try {
        documentContext = await getDocumentContext()
        success = await appendToCurrentConversation({
          message,
          attachments: supplementAttachments.length > 0 ? supplementAttachments : undefined,
          documentContext: documentContext || undefined,
          images: images.length > 0 ? images : undefined,
          workbenchContext: options?.workbenchContext
        })
      } catch (err) {
        log.warn('插入补充消息失败:', err)
      }

      if (success) {
        if (supplementAttachments.length > 0 || parsedDocs.length > 0) attachmentCallbacks?.clearAttachments()
        if (images.length > 0) imageCallbacks?.clearImages()
      } else {
        // 已经上墙的这句话不能悄悄拿掉。插不进当前这场，就排到下一轮，图一起带走。
        followUpQueue.value = [{
          id: `followup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          message,
          images: images.length > 0 ? images : undefined,
          previewImages: previewImages.length > 0 ? previewImages : undefined,
          attachments: supplementAttachments.length > 0 ? supplementAttachments : undefined,
          parsedDocs: parsedDocs.length > 0 ? parsedDocs.map(doc => ({ ...doc })) : undefined,
          documentContext: documentContext || undefined,
          workbenchContext: options?.workbenchContext,
        }, ...followUpQueue.value]
        if (supplementAttachments.length > 0 || parsedDocs.length > 0) attachmentCallbacks?.clearAttachments()
        if (images.length > 0) imageCallbacks?.clearImages()
        log.warn('这句话没插进当前这场，已留在对话里并排到下一轮')
        if (!isAgentRunning.value) scheduleNextFollowUp(tabId)
      }
      return
    }

    if (compactSlash?.def.id === 'compact') {
      if (!queued) inputText.value = ''
      const result = await compactContext(compactSlash.hint)
      if (!result.ok) {
        if (result.reason === 'running') {
          putBackQueued()
          toast.warning(t('ai.slashCompactRunning', { shortcut: queueShortcutLabel() }))
        } else if (result.reason === 'failed') {
          toast.error(t('ai.slashCompactFailed'))
        } else {
          toast.info(t('ai.slashCompactEmpty'))
        }
      }
      return
    }

    const startTime = Date.now()

    // 并发软上限检查：超过 MAX_CONCURRENT_AGENTS 时提示用户，但不强制阻止
    if (terminalStore.isAtConcurrencyLimit) {
      log.warn(`[concurrency] running=${terminalStore.runningAgentCount}, at limit, continuing anyway`)
      // toast 提示由调用方决定是否显示；这里仅记录日志，不阻塞手动操作
    }

    // 新任务开始，重置 TTS（会停止旧播报）
    if (shouldAutoSpeak.value) {
      tts.startNewTask()
    }

    // 获取 Agent 上下文。助手会话必须自报形态——漏了它，落盘的会话形态会被兜底成「本地终端」，
    // 之后再也分不清这条对话到底来自终端还是助手
    const hostedContext = isAssistantMode ? terminalStore.getAgentContext(tabId) : null
    const hostedPtyId = currentTab.value && isAssistantMode
      ? terminalStore.getActivePtyId(currentTab.value)
      : undefined
    const context = isAssistantMode
      ? {
          mode: (hostedContext?.mode === 'split' && (hostedContext.panes?.length ?? 0) > 1)
            ? 'split' as const
            : 'single' as const,
          terminalOutput: hostedContext?.terminalOutput ?? [],
          systemInfo: hostedContext?.systemInfo ?? getLocalSystemInfo(),
          terminalType: 'assistant' as const,
          ...(hostedPtyId ? { ptyId: hostedPtyId } : {}),
          ...(hostedContext && 'panes' in hostedContext && hostedContext.panes
            ? { panes: hostedContext.panes, activePaneId: hostedContext.activePaneId }
            : {}),
        }
      : terminalStore.getAgentContext(tabId)
    // 终端还在连接、甚至连不上时可以没有可用窗格——对话照样开跑，不能把字悄悄扔掉
    if (!isAssistantMode && !context) {
      log.error('无法获取终端上下文')
      putBackQueued()
      return
    }

    if (!queued) {
      inputText.value = ''
    }

    // 同步收集附件/图片（不阻塞 UI）；排队项只认入队时的快照，绝不回读输入框
    // ——否则排队期间用户新拖进来的图会被错挂到这条排队任务上
    const images = queued ? (queued.images ?? []) : (imageCallbacks?.getImages() || [])
    const previewImages = queued
      ? (queued.previewImages ?? [])
      : (imageCallbacks?.getPreviewImages?.() || images)
    // 图片路径挂在待发预览上；必须先取附件再清预览，否则路径到不了模型
    const attachments = queued ? (queued.attachments ?? []) : (attachmentCallbacks?.getAttachments() || [])
    if (!queued && images.length > 0) {
      imageCallbacks?.clearImages()
    }
    // getDocumentContext 依赖 uploadedDocs，须在其完成后再 clearAttachments

    // 立即进入运行态 + 乐观 user_task，用户消息与「正在准备...」零等待上墙
    // 上一轮的收尾若晚到，不能把这一轮的「正在跑」清掉，否则排队会以为又空了再开一条。
    const epoch = ++agentRunEpoch
    terminalStore.clearAgentState(tabId, true)
    const isNewSession = !agentState.value?.sessionId
    if (isNewSession) {
      terminalStore.setAgentSession(tabId, `session_${startTime}`, startTime)
    }
    const stableAgentKey = isAssistantMode
      ? currentTab.value?.agentId
      : tabId
    terminalStore.setAgentRunning(tabId, true, stableAgentKey, message)
    terminalStore.addAgentStep(tabId, {
      id: `__optimistic_user_task_${startTime}`,
      type: 'user_task',
      content: message,
      images: previewImages.length > 0 ? previewImages : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      timestamp: startTime,
    })
    guardAfterAutoScroll()
    void scrollToBottom()

    // 任务侧栏短标题：首条消息发出即异步生成，不阻塞 / 不等待 Agent
    // 联络常驻 tab 无侧栏标题；多轮续聊 / 已有自定义标题由后端跳过
    // 诞生引导：固定友好标题（LLM 会对 __…__ 跳过）
    if (
      isNewSession &&
      currentTab.value?.agentId !== COMPANION_TAB_AGENT_ID &&
      message.trim()
    ) {
      const sessionId = agentState.value?.sessionId
      if (sessionId) {
        if (message.trim() === '__onboarding__') {
          const friendlyTitle = t('ai.onboardingConversationTitle')
          terminalStore.setAgentSessionTitle(tabId, friendlyTitle)
          void window.electronAPI.history.setConversationTitle(sessionId, friendlyTitle)
            .catch(err => log.warn('setConversationTitle for onboarding failed:', err))
        } else {
          void window.electronAPI.history.generateConversationTitle(
            sessionId,
            message.trim(),
            activeProfileId.value || undefined
          ).then(title => {
            if (title) {
              terminalStore.setAgentSessionTitle(tabId, title)
            }
          }).catch(err => log.warn('generateConversationTitle failed:', err))
        }
      }
    }

    // 异步上下文在 UI 反馈之后并行获取，不阻塞首屏。
    // 放进同一段收尾里：这里失败也要把「正在跑」清掉，否则排队会一直等下去。
    try {
      const [hostId, documentContext] = await Promise.all([
        getHostIdByTabId(tabId),
        queued
          ? Promise.resolve(queued.documentContext || '')
          : getDocumentContext()
      ])

      if (!queued && attachments.length > 0) {
        attachmentCallbacks?.clearAttachments()
      }

      // 首次运行时自动探测主机信息（后台执行，不阻塞）
      autoProbeHostProfile().catch(e => {
        log.warn('主机探测失败:', e)
      })

      // 根据模式选择 API
      let result: { success: boolean; result?: string; error?: string; aborted?: boolean }

      // workbenchPrompt 对所有工作台类型都需要注入（local/ssh/assistant 各有专属 prompt；
      // companion 当前无）。先经 resolveWorkbenchKind 把 tab 映射成工作台类型再解析。
      const workbenchPrompt = currentTab.value
        ? resolveWorkbenchAgentPrompt(resolveWorkbenchKind(currentTab.value), currentTab.value)
        : undefined

      if (isAssistantMode && currentTab.value?.agentId) {
        // 两个分支的判断条件不同，类型上收不窄，这里显式认回助手形状（终端分支同理）
        const assistantContext = context as AgentContext
        result = await window.electronAPI.agent.runStandalone(
          currentTab.value.agentId,
          message,
          {
            ...assistantContext,
            hostId,
            documentContext,
            images: images.length > 0 ? images : undefined,
            previewImages: previewImages.length < images.length ? previewImages : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            remoteChannel: currentTab.value.remoteChannel,
            sessionId: agentState.value?.sessionId,
            sessionStartTime: agentState.value?.sessionStartTime,
            ...(workbenchPrompt ? { workbenchPrompt } : {}),
            ...(options?.workbenchContext ? { workbenchContext: options.workbenchContext } : {})
          },
          { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 },
          activeProfileId.value || undefined
        )
      } else {
        // 走到这里必是终端模式（上方已 return 掉拿不到终端上下文的情况），
        // 但两个分支的判断条件不同，类型上收不窄，这里显式认回终端形状
        const terminalContext = context as NonNullable<ReturnType<typeof terminalStore.getAgentContext>>
        // agentKey = tabId（Agent 索引主键），context.ptyId = 当前激活窗格 ptyId（Agent 操作目标）。
        // 这两个不再耦合：Agent 实例归 tab 所有，跨多个窗格的生命周期。
        result = await window.electronAPI.agent.run(
          tabId,
          message,
          {
            ...terminalContext,
            hostId,
            sshHost: currentTab.value?.sshConfig?.host,
            documentContext,
            images: images.length > 0 ? images : undefined,
            previewImages: previewImages.length < images.length ? previewImages : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            sessionId: agentState.value?.sessionId,
            sessionStartTime: agentState.value?.sessionStartTime,
            ...(workbenchPrompt ? { workbenchPrompt } : {}),
            ...(options?.workbenchContext ? { workbenchContext: options.workbenchContext } : {})
          },
          { executionMode: executionMode.value, commandTimeout: commandTimeout.value * 1000 },
          activeProfileId.value || undefined
        )
      }
      // 后端已通过 onStep 推送 final_result，这里只需设置 finalResult 状态
      if (!result.success) {
        const finalContent = result.aborted
          ? t('ai.taskAbortedMessage')
          : t('ai.agentExecutionFailed', { error: result.error })
        terminalStore.setAgentFinalResult(tabId, finalContent)
      } else if (result.result) {
        terminalStore.setAgentFinalResult(tabId, result.result)
      }
    } catch (error) {
      log.error('Agent 运行失败:', error)
      const raw = error instanceof Error ? error.message : String(error || '')
      // IPC 序列化失败等不应把脏堆栈甩给用户（对齐 AiSettings testConnectionFailed）
      const isIpcNoise =
        raw.includes('Error invoking remote method') ||
        (raw.includes('SyntaxError') && raw.includes('is not valid JSON'))
      const errorMessage = isIpcNoise ? t('ai.agentIpcFailed') : (raw || t('ai.unknownError'))
      const finalContent = t('ai.agentRunError', { error: errorMessage })
      
      // IPC 层面的错误（如连接断开），后端可能没来得及推送 final_result
      // 检查后端是否已推送过 final_result，避免重复
      const currentSteps = agentState.value?.steps || []
      if (!currentSteps.some(s => s.type === 'final_result')) {
        terminalStore.addAgentStep(tabId, {
          id: `final_result_${Date.now()}`,
          type: 'final_result',
          content: finalContent,
          timestamp: Date.now()
        })
      }
      terminalStore.setAgentFinalResult(tabId, finalContent)
    } finally {
      // 上一轮的收尾若晚于下一轮开工，不能清掉下一轮的运行态
      if (epoch === agentRunEpoch) {
        // 只固化这一轮自己的临时任务。别的临时消息还在等它自己的正式步骤，不能改掉编号。
        terminalStore.commitOptimisticAgentSteps(tabId, `__optimistic_user_task_${startTime}`)
        finalizeAgentRunWithScrollSettle(tabId)
      }
    }

    if (epoch === agentRunEpoch) {
      await scrollToBottomIfNeeded()
    }
  }

  const abortAgent = async () => {
    tts.stop()
    const agentKey = getAgentKey()
    if (!agentKey) return

    try {
      await window.electronAPI.agent.abort(agentKey)
    } catch (error) {
      log.error('中止 Agent 失败:', error)
    }
  }

  const removeFollowUp = (id: string) => {
    const wasEditing = editingFollowUpId.value === id
    if (wasEditing) {
      editingFollowUpId.value = null
      editingFollowUpSnapshot.value = null
    }
    followUpQueue.value = followUpQueue.value.filter(item => item.id !== id)
    const tabId = currentTabId.value
    if (wasEditing && tabId && !isAgentRunning.value) scheduleNextFollowUp(tabId)
  }

  const takeFollowUp = (id: string): FollowUpQueueItem | undefined => {
    const item = followUpQueue.value.find(entry => entry.id === id)
    if (!item) return undefined
    followUpQueue.value = followUpQueue.value.filter(entry => entry.id !== id)
    return item
  }

  const restoreFollowUp = (item: FollowUpQueueItem, index: number) => {
    const next = [...followUpQueue.value]
    next.splice(Math.min(Math.max(index, 0), next.length), 0, item)
    followUpQueue.value = next
  }

  const isBackendAgentBusy = async (key: string): Promise<boolean> => {
    try {
      const phase = await window.electronAPI.agent.getExecutionPhase(key)
      const name = typeof phase === 'string' ? phase : phase?.phase
      return !!name && name !== 'idle'
    } catch {
      return false
    }
  }

  const compactContext = async (hint?: string): Promise<
    | { ok: true; freedTokens: number }
    | { ok: false; reason: 'running' | 'empty' | 'failed' }
  > => {
    const agentKey = getAgentKey()
    const tab = currentTab.value
    const tabId = currentTabId.value
    if (!agentKey || !tab || !tabId || tab.isRemote) return { ok: false, reason: 'empty' }
    if (isAgentRunning.value) return { ok: false, reason: 'running' }
    const extra = hint?.trim()
    const title = extra
      ? `${t('ai.toolNames.compress_context')}：${extra}`
      : t('ai.toolNames.compress_context')
    const epoch = ++agentRunEpoch
    terminalStore.setAgentRunning(tabId, true, agentKey, title)
    try {
      return await window.electronAPI.agent.compactContext({
        agentKey,
        sessionId: agentState.value?.sessionId,
        sessionStartTime: agentState.value?.sessionStartTime,
        terminalType: tab.type,
        sshHost: tab.sshConfig?.host,
        hint
      })
    } finally {
      if (epoch === agentRunEpoch) {
        terminalStore.finalizeAgentRunState(tabId)
        if (!isAgentRunning.value) scheduleNextFollowUp(tabId)
      }
    }
  }

  const checkInjectIntoCurrentRun = async (): Promise<boolean> => {
    if (isAgentRunning.value) return true
    const key = getAgentKey()
    return currentTab.value?.agentId === COMPANION_TAB_AGENT_ID
      && !!key
      && agentTaskGroups.value.some(group => group.isCurrentTask)
      && await isBackendAgentBusy(key)
  }

  /** 追加进当前这场还在跑的对话；不中止任务、不另起一轮。 */
  const appendToCurrentConversation = async (payload: {
    message: string
    attachments?: AttachmentInfo[]
    documentContext?: string
    images?: string[]
    workbenchContext?: WorkbenchContext
    silent?: boolean
  }): Promise<boolean> => {
    const agentKey = getAgentKey()
    if (!agentKey) return false
    return window.electronAPI.agent.addMessage(
      agentKey,
      payload.message,
      payload.attachments,
      payload.documentContext,
      payload.images,
      payload.workbenchContext,
      payload.silent
    )
  }

  let followUpDrainTimer: ReturnType<typeof setTimeout> | null = null
  /** 后开的一轮序号更大。先结束的那一轮不能把后一轮的「正在跑」清掉。 */
  let agentRunEpoch = 0

  const cancelFollowUpDrain = () => {
    if (followUpDrainTimer) {
      clearTimeout(followUpDrainTimer)
      followUpDrainTimer = null
    }
  }

  /** 当前 run 结束后按顺序开下一件。延后取出，以便关 tab / 手动删掉 / 插入当前对话能拦住。 */
  const scheduleNextFollowUp = (tabId: string): boolean => {
    if (followUpDrainTimer || followUpQueue.value.length === 0) return false
    // 队首正在编辑：等改完再开；不跳过它去跑后面的
    if (followUpQueue.value[0]?.editing) return false
    terminalStore.requestAgentCompleteTabAttentionSkip(tabId)
    followUpDrainTimer = setTimeout(() => {
      followUpDrainTimer = null
      const next = followUpQueue.value[0]
      const decision = decideFollowUpDrain({
        hasQueued: !!next,
        headEditing: !!next?.editing,
        tabAlive: terminalStore.tabs.some(tab => tab.id === tabId),
        agentRunning: isAgentRunning.value,
      })
      // 还在忙就留在队列里。空闲的那一下会再来排，不能这一拍直接扔掉。
      if (decision === 'wait') {
        log.warn('排队的下一条先不开：上一轮结束时还显示在忙，等空闲后会自动开始')
        return
      }
      if (decision !== 'start' || !next) return
      if (!takeFollowUp(next.id)) return
      log.info('任务结束，启动排队中的下一条:', next.message)
      void runAgent(next.message, {
        workbenchContext: next.workbenchContext,
        queuedPayload: next
      })
    }, 100)
    return true
  }

  // 完成事件若没排上（或排上时还显示在忙），只要从「正在跑」回到空闲，就再试一次。
  watch(isAgentRunning, (running, wasRunning) => {
    if (!wasRunning || running) return
    const tabId = currentTabId.value
    if (tabId) scheduleNextFollowUp(tabId)
  })

  /** 把排队中的一条追加进当前这场（与回车补充同一条路）；闲着则马上开下一件。不打断正在跑的任务。 */
  const insertFollowUp = async (id: string) => {
    if (editingFollowUpId.value === id) return
    const index = followUpQueue.value.findIndex(entry => entry.id === id)
    const queuedItem = followUpQueue.value[index]
    if (
      queuedItem &&
      resolveExactSlash(queuedItem.message)?.def.id === 'compact' &&
      await checkInjectIntoCurrentRun()
    ) {
      toast.warning(t('ai.slashCompactCannotInsert'))
      return
    }
    const item = takeFollowUp(id)
    if (!item) return
    cancelFollowUpDrain()

    if (resolveExactSlash(item.message)?.def.id === 'compact') {
      log.info('插入排队压缩为下一件任务:', item.message)
      void runAgent(item.message, { queuedPayload: item })
      return
    }

    if (isAgentRunning.value) {
      const success = await appendToCurrentConversation({
        message: item.message,
        attachments: item.attachments,
        documentContext: item.documentContext,
        images: item.images,
        workbenchContext: item.workbenchContext
      })
      if (!success) restoreFollowUp(item, index)
      return
    }

    log.info('插入排队消息为下一件任务:', item.message)
    void runAgent(item.message, {
      workbenchContext: item.workbenchContext,
      queuedPayload: item
    })
  }

  /** 开始编辑：标记队列位为「编辑中」，返回快照供输入框填入。调用方须先确认输入框空闲。 */
  const beginEditFollowUp = (id: string): FollowUpQueueItem | null => {
    if (editingFollowUpId.value) return null
    const item = followUpQueue.value.find(entry => entry.id === id)
    if (!item || item.editing) return null
    cancelFollowUpDrain()
    editingFollowUpId.value = id
    editingFollowUpSnapshot.value = {
      ...item,
      images: item.images ? [...item.images] : undefined,
      previewImages: item.previewImages ? [...item.previewImages] : undefined,
      pendingImages: item.pendingImages ? [...item.pendingImages] : undefined,
      attachments: item.attachments ? item.attachments.map(a => ({ ...a })) : undefined,
      parsedDocs: item.parsedDocs ? item.parsedDocs.map(d => ({ ...d })) : undefined,
      workbenchContext: item.workbenchContext ? { ...item.workbenchContext } : undefined,
    }
    followUpQueue.value = followUpQueue.value.map(entry =>
      entry.id === id ? { ...entry, editing: true } : entry
    )
    return editingFollowUpSnapshot.value
  }

  /** 取消编辑：原样恢复，清除编辑标记；若手头已空闲则继续 drain */
  const cancelEditFollowUp = () => {
    const id = editingFollowUpId.value
    const snap = editingFollowUpSnapshot.value
    const tabId = currentTabId.value
    if (!id || !snap) {
      editingFollowUpId.value = null
      editingFollowUpSnapshot.value = null
      return
    }
    followUpQueue.value = followUpQueue.value.map(entry =>
      entry.id === id ? { ...snap, editing: undefined } : entry
    )
    editingFollowUpId.value = null
    editingFollowUpSnapshot.value = null
    if (tabId && !isAgentRunning.value) scheduleNextFollowUp(tabId)
  }

  /**
   * 保存编辑回原位。内容全空则删掉这条。
   * workbenchContext 沿用入队快照（编辑态不重新吃选区）。
   */
  const saveEditFollowUp = async (payload: {
    message: string
    images?: string[]
    previewImages?: string[]
    pendingImages?: string[]
    attachments?: AttachmentInfo[]
    parsedDocs?: ParsedDocument[]
    documentContext?: string
  }): Promise<boolean> => {
    const id = editingFollowUpId.value
    const snap = editingFollowUpSnapshot.value
    const tabId = currentTabId.value
    if (!id || !snap) return false

    const message = payload.message.trim()
    const images = payload.images?.length ? payload.images : undefined
    const previewImages = payload.previewImages?.length ? payload.previewImages : undefined
    const pendingImages = payload.pendingImages?.length ? payload.pendingImages : undefined
    const attachments = payload.attachments?.length ? payload.attachments : undefined
    const parsedDocs = payload.parsedDocs?.length
      ? payload.parsedDocs.map(d => ({ ...d }))
      : undefined
    const documentContext = payload.documentContext || undefined
    const empty = !message && !images?.length && !attachments?.length && !parsedDocs?.length

    if (empty) {
      followUpQueue.value = followUpQueue.value.filter(entry => entry.id !== id)
    } else {
      const updated: FollowUpQueueItem = {
        id,
        message,
        images,
        previewImages,
        pendingImages,
        attachments,
        parsedDocs,
        documentContext,
        workbenchContext: snap.workbenchContext,
      }
      followUpQueue.value = followUpQueue.value.map(entry =>
        entry.id === id ? updated : entry
      )
    }

    editingFollowUpId.value = null
    editingFollowUpSnapshot.value = null
    if (tabId && !isAgentRunning.value) scheduleNextFollowUp(tabId)
    return true
  }

  const reorderFollowUp = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    const list = [...followUpQueue.value]
    if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return
    const [moved] = list.splice(fromIndex, 1)
    if (!moved) return
    // drop 目标行 = 插到该行之前；from < to 时先 splice 会让目标左移一位
    list.splice(fromIndex < toIndex ? toIndex - 1 : toIndex, 0, moved)
    followUpQueue.value = list
  }

  // alwaysAllow: 会话内存白名单（路径类等仍可用；命令类 UI 已改为加入规则）
  const confirmToolCall = async (
    approved: boolean,
    opts?: { alwaysAllow?: boolean },
  ) => {
    const confirm = pendingConfirm.value as (typeof pendingConfirm.value & { ptyId?: string }) | undefined
    if (!confirm) return

    // 必须用 needConfirm 事件里的 agentKey（ptyId），不能依赖当前激活 tab 的 getAgentKey()
    const agentKey = confirm.ptyId ?? confirm.agentId ?? getAgentKey()
    if (!agentKey) return

    try {
      await window.electronAPI.agent.confirm({
        ptyId: agentKey,
        toolCallId: confirm.toolCallId,
        approved,
        modifiedArgs: undefined,
        alwaysAllow: opts?.alwaysAllow,
      })
      const ownerTabId = terminalStore.findTabIdByPtyId(agentKey)
        ?? terminalStore.findTabIdByAgentId(agentKey)
        ?? currentTabId.value
      if (ownerTabId) {
        terminalStore.setAgentPendingConfirm(ownerTabId, undefined)
      }
    } catch (error) {
      log.error('确认工具调用失败:', error)
    }
  }

  /** 未知命令：二次确认后写入用户命令规则，再允许本次执行 */
  const confirmTrustCommandAndAllow = async () => {
    const confirm = pendingConfirm.value
    const offer = confirm?.trustCommandOffer
    if (!offer) return
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('common.confirm'),
      message: t('ai.trustCommandConfirm', { cmd: offer.cmd }),
    })
    if (!confirmed) return
    try {
      const result = await window.electronAPI.commandRules.upsert({
        cmd: offer.cmd,
        baseLevel: offer.baseLevel,
        writesTo: offer.writesTo,
      })
      if (!result.ok) {
        await showAlert(t('common.error'), t('ai.trustCommandFailed'))
        return
      }
      await confirmToolCall(true)
    } catch (error) {
      log.error('信任命令并加入规则失败:', error)
      await showAlert(t('common.error'), t('ai.trustCommandFailed'))
    }
  }

  // 提交安全输入（用户在安全输入框里填了 key 并确认）
  const submitSecureInput = async (value: string) => {
    const req = pendingSecureInput.value
    if (!req) return
    const agentKey = getAgentKey()
    if (!agentKey) return
    try {
      await window.electronAPI.agent.resolveSecureInput({
        ptyId: req.ptyId || agentKey,
        requestId: req.requestId,
        value
      })
    } finally {
      if (currentTabId.value) {
        terminalStore.setAgentPendingSecureInput(currentTabId.value, undefined)
      }
    }
  }

  // 取消安全输入
  const cancelSecureInput = async () => {
    const req = pendingSecureInput.value
    if (!req) return
    const agentKey = getAgentKey()
    if (!agentKey) return
    try {
      await window.electronAPI.agent.resolveSecureInput({
        ptyId: req.ptyId || agentKey,
        requestId: req.requestId,
        cancelled: true
      })
    } finally {
      if (currentTabId.value) {
        terminalStore.setAgentPendingSecureInput(currentTabId.value, undefined)
      }
    }
  }

  // 发送 Agent 回复（用于用户点击选项快速回复）
  const sendAgentReply = async (message: string) => {
    if (!message.trim() || !currentTabId.value) return

    const key = getAgentKey()
    if (!isAgentRunning.value || !key) return

    await appendToCurrentConversation({ message, silent: true })
  }

  // 获取步骤类型的图标
  const getStepIcon = (type: AgentStep['type']): string => {
    switch (type) {
      case 'thinking': return '🤔'
      case 'tool_call': return '🔧'
      case 'tool_result': return '📋'
      case 'message': return '💬'
      case 'error': return '❌'
      case 'confirm': return '⚠️'
      case 'user_task': return '👤'
      case 'final_result': return '✅'
      case 'user_supplement': return '💡'
      case 'waiting': return '⏳'
      case 'asking': return '❓'
      case 'waiting_password': return '🔐'
      case 'plan_created': return '📋'
      case 'plan_updated': return '📋'
      case 'plan_archived': return '📦'
      case 'auto_review': return '✅'
      default: return '•'
    }
  }

  // 获取风险等级的颜色类
  const getRiskClass = (riskLevel?: string): string => {
    switch (riskLevel) {
      case 'safe': return 'risk-safe'
      case 'moderate': return 'risk-moderate'
      case 'dangerous': return 'risk-dangerous'
      case 'blocked': return 'risk-blocked'
      default: return ''
    }
  }

  /**
   * 根据工具步骤的执行结果返回竖条样式类。
   * 仅用于 tool_call 步骤：把"风险色"替换为"执行结果色"，和确认对话框里的风险红/黄/绿视觉解耦。
   *   - success === false → 红色（exec-failed）
   *   - success === true  → 绿色（exec-success）
   *   - undefined         → 空串（由上游的 risk-pending/无色样式兜底表示"运行中"）
   */
  const getExecStatusClass = (step: AgentStep): string => {
    if (step.success === false) return 'exec-failed'
    if (step.success === true) return 'exec-success'
    return ''
  }

  // 设置 Agent 事件监听
  // 注意：每个 AiPanel 实例都会注册监听器，所以需要确保只处理属于自己 tab 的事件
  const setupAgentListeners = () => {
    // 先清理旧的监听器，防止热重载时重复注册
    cleanupAgentListeners()
    // 将 agent 事件路由到 tab：终端 tab 用 ptyId（= tabId），助手 tab 用 tab.agentId
    const resolveTabIdForAgentEvent = (agentId: string, ptyId?: string): string | undefined => {
      if (ptyId) {
        return terminalStore.findTabIdByPtyId(ptyId)
          ?? terminalStore.findTabIdByAgentId(ptyId)
      }
      return terminalStore.findTabIdByAgentId(agentId)
    }

    const isEventForThisTab = (agentId: string, ptyId?: string): boolean => {
      const foundTabId = resolveTabIdForAgentEvent(agentId, ptyId)
      return foundTabId === currentTabId.value
    }
    
    // 监听步骤更新
    cleanupStepListener = window.electronAPI.agent.onStep((data: { agentId: string; ptyId?: string; step: AgentStep; wakeup?: boolean }) => {
      // 唤醒模式的 step 只给 Awaken 面板，不进入对话记录
      if (data.wakeup) return
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      
      const tabId = currentTabId.value
      // 只换掉被这条正式消息接住的临时气泡。另一句话、或图没带上的同一句，留在墙上。
      const confirmedIds = (agentState.value?.steps ?? [])
        .filter(step => optimisticPlaceholderConfirmedBy(step, data.step))
        .map(step => step.id)
      if (confirmedIds.length > 0) terminalStore.removeOptimisticAgentSteps(tabId, confirmedIds)

      // 「准备中 → 思考中」切换：乐观移除 startup 占位，避免「占位 + 新 message」中间态闪现。
      // 后端 removeStep IPC 到达时 removeAgentStep 幂等跳过。
      if (data.step.type === 'message' && data.step.isStreaming) {
        const startupStep = (agentState.value?.steps ?? [])
          .find(s => s.placeholder === 'startup')
        if (startupStep) {
          terminalStore.removeAgentStep(tabId, startupStep.id)
        }
      }

      terminalStore.addAgentStep(tabId, data.step)

      // TTS: 流式 message / final_result 喂给语音合成（远程会话不播报）
      if (shouldAutoSpeak.value && tts.isEnabled.value) {
        if (data.step.type === 'message' && data.step.content) {
          tts.feedContent(data.step.content)
        } else if (data.step.type === 'final_result' && data.step.content) {
          tts.flush()
          tts.feedContent(data.step.content)
          tts.flush()
        } else {
          tts.flush()
        }
      }
      
      // 使用智能滚动，不打断用户查看历史
      scrollToBottomIfNeeded()
    })

    // 监听步骤移除（后端撤销临时占位步骤，如初始"正在准备..."）
    cleanupStepRemovedListener = window.electronAPI.agent.onStepRemoved((data: { agentId: string; ptyId?: string; stepId: string }) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      terminalStore.removeAgentStep(currentTabId.value, data.stepId)
    })

    cleanupContextBarListener = window.electronAPI.agent.onContextBar((data) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      terminalStore.setAgentContextBar(currentTabId.value, data.contextBar)
    })

    cleanupModelFailoverListener = window.electronAPI.agent.onModelFailover((data) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      if (data.notice.usedId) {
        activeProfileId.value = data.notice.usedId
      }
      toast.warning(t('ai.modelFailover', { from: data.notice.fromName, name: data.notice.usedName }), 6000)
    })

    // 监听需要确认
    cleanupConfirmListener = window.electronAPI.agent.onNeedConfirm((data) => {
      // 类型转换，添加 ptyId 支持
      const eventData = data as { agentId: string; ptyId?: string; toolCallId: string; toolName: string; toolArgs: Record<string, unknown>; riskLevel: string }
      // 只处理属于当前 tab 的事件（使用 ptyId 可靠匹配）
      if (!isEventForThisTab(eventData.agentId, eventData.ptyId)) return
      
      terminalStore.setAgentPendingConfirm(currentTabId.value, data)

      // TTS 播报确认请求
      if (shouldAutoSpeak.value && tts.isEnabled.value) {
        tts.flush()
        const args = eventData.toolArgs
        const risk = eventData.riskLevel === 'dangerous' ? '注意，这是高风险操作。'
          : eventData.riskLevel === 'moderate' ? '这是中等风险操作。'
          : ''
        let action = ''
        if (args.command) {
          action = `我需要执行 ${args.command}`
        } else if (args.path) {
          action = `我需要操作文件 ${args.path}`
        } else {
          action = '接下来的操作'
        }
        tts.feedContent(`${risk}${action}，请确认。`)
        tts.flush()
      }

      // 需要确认时强制滚动，确保用户看到确认框
      // 多次滚动：虚拟列表测量实际高度需要时间，首次滚动可能基于估算值
      scrollToBottom()
      setTimeout(() => scrollToBottom(), 150)
    })

    // 监听确认已被其他渠道处理（如 IM 端确认后清除桌面确认框）
    cleanupConfirmResolvedListener = window.electronAPI.agent.onConfirmResolved((data) => {
      const foundTabId = terminalStore.findTabIdByAgentId(data.agentId)
      if (foundTabId === currentTabId.value) {
        terminalStore.setAgentPendingConfirm(currentTabId.value, undefined)
      }
    })

    // 监听安全输入请求（技能 API Key 等）
    cleanupSecureInputListener = window.electronAPI.agent.onNeedSecureInput((data) => {
      if (!isEventForThisTab(data.agentId, data.ptyId)) return
      terminalStore.setAgentPendingSecureInput(currentTabId.value, data)
      scrollToBottom()
      setTimeout(() => scrollToBottom(), 150)
    })

    // 监听完成
    cleanupCompleteListener = window.electronAPI.agent.onComplete((data: { agentId: string; ptyId?: string; result: string; pendingUserMessages?: Array<string | import('@shared/types').PendingUserHandoff> }) => {
      // 与 onStep 同一套路由：助手完成事件的 ptyId 是 agentId，不能只按终端窗格找
      const foundTabId = resolveTabIdForAgentEvent(data.agentId, data.ptyId)
      if (foundTabId !== currentTabId.value) return

      finalizeAgentRunWithScrollSettle(currentTabId.value)
      // 上一轮收尾时没吃进去的补充，排到队首，跟已经在排队的一起开下一轮。
      // 图和附件在这条交接里要留下；只剩文字的旧事件也能接着用。
      const pending = coalescePendingHandoff(data.pendingUserMessages)
      if (pending && foundTabId) {
        terminalStore.requestAgentCompleteTabAttentionSkip(foundTabId)
        followUpQueue.value = mergePendingIntoQueue(followUpQueue.value, pending, (item) => ({
          id: `followup_pending_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          message: item.message,
          images: item.images,
          previewImages: item.images,
          attachments: item.attachments,
          documentContext: item.documentContext,
          workbenchContext: item.workbenchContext,
        }))
      }

      if (foundTabId && scheduleNextFollowUp(foundTabId)) return

      // 任务在后台 tab 结束时，标签栏高亮（与待确认一致），便于多 tab 定位
      if (
        foundTabId &&
        !isAssistantConversationSurfaceVisible(foundTabId, terminalStore.conversationSurface)
      ) {
        terminalStore.setAgentCompletedUnseen(foundTabId, true)
      }
    })

    // 监听错误
    cleanupErrorListener = window.electronAPI.agent.onError((data: { agentId: string; ptyId?: string; error: string }) => {
      const foundTabId = resolveTabIdForAgentEvent(data.agentId, data.ptyId)
      if (foundTabId !== currentTabId.value) return

      finalizeAgentRunWithScrollSettle(currentTabId.value)
      // handleError 已通过 onStep 推送 error + final_result，此处不再重复 add error step。

      if (foundTabId && scheduleNextFollowUp(foundTabId)) return

      if (
        foundTabId &&
        !isAssistantConversationSurfaceVisible(foundTabId, terminalStore.conversationSurface)
      ) {
        terminalStore.setAgentCompletedUnseen(foundTabId, true)
      }
    })
  }

  // 清理 Agent 事件监听
  const cleanupAgentListeners = () => {
    if (cleanupStepListener) {
      cleanupStepListener()
      cleanupStepListener = null
    }
    if (cleanupStepRemovedListener) {
      cleanupStepRemovedListener()
      cleanupStepRemovedListener = null
    }
    if (cleanupContextBarListener) {
      cleanupContextBarListener()
      cleanupContextBarListener = null
    }
    if (cleanupModelFailoverListener) {
      cleanupModelFailoverListener()
      cleanupModelFailoverListener = null
    }
    if (cleanupConfirmListener) {
      cleanupConfirmListener()
      cleanupConfirmListener = null
    }
    if (cleanupConfirmResolvedListener) {
      cleanupConfirmResolvedListener()
      cleanupConfirmResolvedListener = null
    }
    if (cleanupSecureInputListener) {
      cleanupSecureInputListener()
      cleanupSecureInputListener = null
    }
    if (cleanupCompleteListener) {
      cleanupCompleteListener()
      cleanupCompleteListener = null
    }
    if (cleanupErrorListener) {
      cleanupErrorListener()
      cleanupErrorListener = null
    }
  }

  // ==================== 历史对话功能 ====================

  // 近期历史记录（用于欢迎页展示）
  const recentHistory = ref<AgentHistorySummary[]>([])
  const isLoadingHistory = ref(false)

  // 查看更多弹窗：一次拉取索引中的全部标题摘要，本地筛选 + 分页展示；点开行再 getAgentRecordById
  const showHistoryModal = ref(false)
  const historyModalSummaries = ref<AgentHistorySummary[]>([])
  const isLoadingAllHistory = ref(false)
  const HISTORY_PAGE_SIZE = 20
  const historyModalDisplayCount = ref(HISTORY_PAGE_SIZE)
  const historySearchKeyword = ref('')

  /**
   * 输入框实时：仅本地按摘要标题（首条 user_task）筛选已加载的 listAgentSummaries。
   * 回车 / 搜索按钮：置 true 并走 IPC 全文检索（整段对话中的用户消息与结果等）。
   */
  const historyFullTextSearchActive = ref(false)
  const historySearchResults = ref<AgentRecord[]>([])
  const historySearchTotalMatched = ref(0)
  const historySearchHasMore = ref(false)
  const isHistorySearchLoading = ref(false)
  const historySearchFetchLimit = ref(HISTORY_PAGE_SIZE)
  const historySearchRequestId = ref(0)

  const clearHistorySearchState = () => {
    historySearchResults.value = []
    historySearchTotalMatched.value = 0
    historySearchHasMore.value = false
    historySearchFetchLimit.value = HISTORY_PAGE_SIZE
  }

  const historyModalSearchRequestId = (reqId: number) => `history-modal-${reqId}`

  const abortInFlightHistorySearch = () => {
    void window.electronAPI.history.abortSearchAgentRecords()
  }

  const appendHistorySearchHit = (hit: AgentHistorySummary | AgentRecord) => {
    const next = applySearchMatch(historySearchResults.value, historySearchTotalMatched.value, hit as AgentRecord)
    historySearchResults.value = next.hits
    historySearchTotalMatched.value = next.liveCount
  }

  let cleanupHistorySearchMatch: (() => void) | null = null

  const executeHistorySearch = async (reqId: number) => {
    const kw = historySearchKeyword.value.trim()
    if (!kw) {
      if (reqId === historySearchRequestId.value) {
        isHistorySearchLoading.value = false
      }
      return
    }
    try {
      const res = await window.electronAPI.history.searchAgentRecords({
        keyword: kw,
        limit: historySearchFetchLimit.value,
        excludeWakeup: true,
        requestId: historyModalSearchRequestId(reqId),
      })
      if (reqId !== historySearchRequestId.value) return
      for (const record of res.records as AgentRecord[]) {
        appendHistorySearchHit(record)
      }
      historySearchTotalMatched.value = res.totalMatched
      historySearchHasMore.value = res.hasMore
    } catch (e) {
      log.error('搜索历史记录失败:', e)
      if (reqId !== historySearchRequestId.value) return
      if (historySearchResults.value.length === 0) {
        historySearchTotalMatched.value = 0
        historySearchHasMore.value = false
      }
    } finally {
      if (reqId === historySearchRequestId.value) {
        isHistorySearchLoading.value = false
      }
    }
  }

  const filteredHistorySummaries = computed(() => {
    const kw = historySearchKeyword.value.trim().toLowerCase()
    const base = historyModalSummaries.value
    if (!kw) return base
    return base.filter((s: AgentHistorySummary) => {
      const display = resolveConversationDisplayTitle(s)
      return [s.userTask, display].join(' ').toLowerCase().includes(kw)
    })
  })

  const allHistory = computed((): Array<AgentHistorySummary | AgentRecord> => {
    if (historyFullTextSearchActive.value) {
      return historySearchResults.value
    }
    return filteredHistorySummaries.value.slice(0, historyModalDisplayCount.value)
  })

  const hasMoreHistory = computed(() => {
    if (historyFullTextSearchActive.value) {
      return historySearchHasMore.value
    }
    return historyModalDisplayCount.value < filteredHistorySummaries.value.length
  })

  // 加载近期历史（最近 5 条，用于欢迎页）
  const loadRecentHistory = async () => {
    if (isLoadingHistory.value) return
    isLoadingHistory.value = true
    try {
      const summaries = await window.electronAPI.history.listAgentSummaries(true)
      recentHistory.value = summaries
        .sort((a, b) => (b.timestamp + b.duration) - (a.timestamp + a.duration))
        .slice(0, 5)
    } catch (e) {
      log.error('加载历史记录失败:', e)
    } finally {
      isLoadingHistory.value = false
    }
  }

  const loadMoreHistory = () => {
    if (historyFullTextSearchActive.value) {
      historySearchFetchLimit.value += HISTORY_PAGE_SIZE
      isHistorySearchLoading.value = true
      const reqId = historySearchRequestId.value
      void executeHistorySearch(reqId)
    } else {
      historyModalDisplayCount.value += HISTORY_PAGE_SIZE
    }
  }

  const setHistorySearchKeyword = (value: string) => {
    if (historyFullTextSearchActive.value) {
      historySearchRequestId.value += 1
      abortInFlightHistorySearch()
    }
    historySearchKeyword.value = value
    historyFullTextSearchActive.value = false
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
  }

  /** Enter / 搜索按钮：后端全文检索（非输入实时） */
  const flushHistorySearch = () => {
    const kw = historySearchKeyword.value.trim()
    if (!kw) {
      historySearchRequestId.value += 1
      historyFullTextSearchActive.value = false
      historyModalDisplayCount.value = HISTORY_PAGE_SIZE
      clearHistorySearchState()
      abortInFlightHistorySearch()
      return
    }
    historySearchRequestId.value += 1
    const reqId = historySearchRequestId.value
    historySearchFetchLimit.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = true
    // 立即清空旧结果，避免等待 IPC 时仍显示上一条全文结果，看起来像卡住
    historySearchResults.value = []
    historySearchTotalMatched.value = 0
    historySearchHasMore.value = false
    isHistorySearchLoading.value = true
    void executeHistorySearch(reqId)
  }

  const clearHistorySearch = () => {
    historySearchRequestId.value += 1
    historySearchKeyword.value = ''
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = false
    clearHistorySearchState()
    isHistorySearchLoading.value = false
    abortInFlightHistorySearch()
  }

  // 打开历史弹窗：单次 IPC 读全量摘要（来自 agent-index.json）
  const openHistoryModal = async () => {
    showHistoryModal.value = true
    historySearchRequestId.value += 1
    historySearchKeyword.value = ''
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = false
    clearHistorySearchState()
    isHistorySearchLoading.value = false
    abortInFlightHistorySearch()
    isLoadingAllHistory.value = true
    try {
      historyModalSummaries.value = await window.electronAPI.history.listAgentSummaries(true)
    } catch (e) {
      log.error('加载历史摘要失败:', e)
      historyModalSummaries.value = []
    } finally {
      isLoadingAllHistory.value = false
    }
  }

  // 关闭历史弹窗
  const closeHistoryModal = () => {
    showHistoryModal.value = false
    historyModalSummaries.value = []
    historySearchRequestId.value += 1
    historySearchKeyword.value = ''
    historyModalDisplayCount.value = HISTORY_PAGE_SIZE
    historyFullTextSearchActive.value = false
    clearHistorySearchState()
    isHistorySearchLoading.value = false
    abortInFlightHistorySearch()
  }

  // 加载历史记录到当前会话
  // 注意：仅把对话内容恢复到当前 tab 的 AiPanel，不改写 tab 标题。
  // 终端 tab 标题代表主机（本地/SSH），助手 tab 标题代表助手身份或用户手动重命名，
  // 加载历史对话不应覆盖既有标题；对话标题由侧栏/历史列表单独呈现。
  const loadHistoryRecord = async (record: AgentRecord) => {
    terminalStore.restoreAgentHistory(currentTabId.value, record)
    // 关闭弹窗（如果是从弹窗中选择的）
    closeHistoryModal()

    // 等待 Vue 响应式更新完成（Virtualizer 挂载 / 列表项更新）
    await nextTick()
    scrollToHistoryBottomWithRetry({ hideUntilSettled: true })
  }

  // 检查是否有现有对话（用于确认是否覆盖）
  const hasExistingConversation = computed(() => {
    const steps = agentState.value?.steps || []
    return steps.length > 0
  })

  // 格式化历史时间
  const formatHistoryTime = (timestamp: number): string => {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    
    if (isToday) {
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    } else {
      return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
  }

  // 远程 tab：从 IM 持久化配置加载执行模式
  const loadRemoteExecutionMode = async () => {
    if (!currentTab.value?.isRemote) return
    try {
      const config = await window.electronAPI.im.getConfig()
      if (config.executionMode && ['strict', 'relaxed', 'free'].includes(config.executionMode)) {
        executionMode.value = config.executionMode
      }
    } catch (err) {
      log.warn('Failed to load remote execution mode, using default:', err)
    }
  }

  // 联络常驻 tab：挂载时把合并视图上墙。已经恢复过、或正在跑任务则不动。
  // 现场已灌进的提醒/消息接到历史后面，按 id（及短时间窗内同文主动提醒）去重，
  // 不因为已经有几条提醒就放弃整段历史。
  const restoreCompanionHistoryIfNeeded = async () => {
    if (currentTab.value?.agentId !== COMPANION_TAB_AGENT_ID) return
    if (agentState.value?.loadedFromHistory) return
    if (isAgentRunning.value) return
    try {
      const merged = await window.electronAPI.history.getCompanionMergedView()
      if (!merged) return
      if (agentState.value?.loadedFromHistory) return
      if (isAgentRunning.value) return

      const liveSteps = agentState.value?.steps ?? []
      const mergedSteps = merged.steps ?? []
      const mergedIds = new Set(mergedSteps.map(s => s.id).filter(Boolean))
      const extraLive = liveSteps.filter(step => !isDuplicateCompanionLiveStep(step, mergedSteps, mergedIds))
      const steps = extraLive.length > 0
        ? [...mergedSteps, ...extraLive].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        : mergedSteps
      terminalStore.restoreAgentHistory(currentTabId.value, { ...merged, steps })
    } catch (err) {
      log.warn('[Companion] 恢复历史会话失败:', err)
    }
  }

  // 生命周期
  onMounted(() => {
    setupAgentListeners()
    loadRecentHistory()
    loadRemoteExecutionMode()
    void restoreCompanionHistoryIfNeeded()
    cleanupHistorySearchMatch = window.electronAPI.history.onSearchMatch((payload) => {
      if (!isCurrentSearchRequest(historyModalSearchRequestId(historySearchRequestId.value), payload.requestId)) return
      appendHistorySearchHit(payload.summary)
    })
  })

  onUnmounted(() => {
    cleanupAgentListeners()
    uninstallFollowResizeObserver()
    uninstallContainerWidthObserver()
    cancelPendingReveal()
    cleanupHistorySearchMatch?.()
    abortInFlightHistorySearch()
    cancelFollowUpDrain()
  })

  return {
    // 输入和终端状态
    inputText,
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
    scrollToBottomIfNeeded,
    suppressLayoutResizeCompensation,
    anchorElementViewportY,
    ensureElementVisibleInViewport,
    stopGeneration,
    // Agent 执行
    executionMode,
    commandTimeout,
    activeProfileId,
    collapsedTaskIds,
    agentState,
    isAgentRunning,
    pendingConfirm,
    pendingSecureInput,
    agentUserTask,
    currentPlan,
    agentTaskGroups,
    flattenedItems,
    isStreamingOutput,
    toggleStepsCollapse,
    isStepsCollapsed,
    toggleProcessFold,
    runAgent,
    compactContext,
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
    loadRecentHistory,
    loadMoreHistory,
    openHistoryModal,
    closeHistoryModal,
    loadHistoryRecord,
    hasExistingConversation,
    formatHistoryTime,
    getAgentKey,  // 获取当前 tab 对应的 Agent 标识符
    // TTS 语音播报
    ttsIsSpeaking: tts.isSpeaking,
    ttsIsEnabled: tts.isEnabled,
    ttsToggle: tts.toggle,
    ttsStop: tts.stop,
  }
}
