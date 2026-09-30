<script setup lang="ts">
/**
 * 助手工作台产出物面板
 *
 * 页签预览正在看的几份；关页签不从桌上拿走。换文件也可走对话区清单。
 */
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  FolderOpen,
  ChevronDown,
  Download,
  Maximize2,
  Minimize2,
  Smartphone,
  X
} from 'lucide-vue-next'
import type { CanvasArtifact } from '@shared/types'
import {
  artifactDisplayLabel,
  canSaveAsArtifact,
  defaultSaveFileName,
  isArtifactEditable,
  saveArtifact,
  saveArtifactAs,
  refreshFilePathExistsMap,
  type ArtifactSaveDeps,
  getArtifactContextMenuFlags,
  artifactHasFileActions,
  closeFocusedArtifact,
  createArtifactSaveBridge,
  isCloseArtifactShortcut,
  provideArtifactSaveBridge,
  registerFocusedArtifactCloser,
  useAssistantArtifactStore
} from '../index'
import { getRendererComponent } from '../renderers/ui-registry'
import ArtifactFileIcon from './ArtifactFileIcon.vue'
import { resolveSourceStepIdById } from '../domain/artifact-source'
import { requireArtifactDesktopHost } from '../host'
import {
  availableMenuExtent,
  boxFromRect,
  clampContextMenuPosition,
  intersectViewport,
  viewportBox
} from '../domain/context-menu-position'
import { useToast } from '@sailfish/workbench-sdk/toast'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../ui/useHoverTip'
import HoverTipOverlay from '../ui/HoverTipOverlay.vue'
import {
  ADD_COMPOSER_QUOTE_KEY,
  SET_COMPOSER_DRAFT_KEY,
  SUBMIT_COMPOSER_MESSAGE_KEY,
  type AddComposerQuoteFn,
  type SubmitComposerMessageFn
} from '../composer-quote'

const props = defineProps<{
  tabId: string
  /** 岗壳注入：滚到对话流指定 step（AiPanel.scrollToAgentStep） */
  scrollToAgentStep?: (stepId: string) => void | Promise<void>
  /** 岗壳注入：引用摘录到 Composer（AiPanel.addComposerQuote） */
  addComposerQuote?: AddComposerQuoteFn
  /** 岗壳注入：图片加入 Composer 待发送区（AiPanel.addComposerImage） */
  addComposerImage?: (image: { dataUrl: string; name: string; width?: number; height?: number; filePath?: string }) => void
  /** 岗壳注入：设置 Composer 草稿文本（AiPanel.setComposerDraft） */
  setComposerDraft?: (text: string) => void
  /** 岗壳注入：当场发出一条消息（右键快捷指令） */
  submitComposerMessage?: SubmitComposerMessageFn
  /** 文件在座时是否铺满（文档为主） */
  focusActive?: boolean
}>()

const emit = defineEmits<{
  toggleFocus: []
}>()

provide(ADD_COMPOSER_QUOTE_KEY, (snippet) => {
  props.addComposerQuote?.(snippet)
})
provide(SET_COMPOSER_DRAFT_KEY, (text) => {
  props.setComposerDraft?.(text)
})
provide(SUBMIT_COMPOSER_MESSAGE_KEY, (text) => {
  props.submitComposerMessage?.(text)
})

const { t } = useI18n()
const artifactStore = useAssistantArtifactStore()
const desktopHost = requireArtifactDesktopHost()
const { success: toastSuccess, error: toastError, info: toastInfo } = useToast()
const saveBridge = createArtifactSaveBridge()
provideArtifactSaveBridge(saveBridge)
const { hoverTip, hideTip } = useHoverTip({
  placement: 'bottom',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS
})

const artifacts = computed(() => artifactStore.getArtifacts(props.tabId))
const openTabs = computed(() => artifactStore.getOpenArtifacts(props.tabId))
const panelRoot = ref<HTMLElement | null>(null)
const panelHasFocus = ref(false)
const tabsEl = ref<HTMLElement | null>(null)
const tabsOverflow = ref(false)
const tabPickerRef = ref<HTMLElement | null>(null)
const tabPickerMenuRef = ref<HTMLElement | null>(null)
const showTabPicker = ref(false)
const tabPickerPos = ref({ top: 0, left: 0, maxWidth: 280, maxHeight: 360 })
let tabsResizeObserver: ResizeObserver | null = null
const activeArtifact = computed(() => artifactStore.getActiveArtifact(props.tabId))
const activeArtifactId = computed(() => activeArtifact.value?.id ?? null)
const renderer = computed(() => activeArtifact.value?.renderer ?? null)
const filePath = computed(() => activeArtifact.value?.filePath ?? null)
const isActiveEditable = computed(() =>
  activeArtifact.value ? isArtifactEditable(activeArtifact.value) : false
)
const activeRendererComponent = computed(() =>
  renderer.value ? getRendererComponent(renderer.value) : null
)
const activeSourceStepId = computed(() => activeArtifact.value?.sourceStepId ?? null)
const fileExistsMap = ref<Map<string, boolean>>(new Map())

function pathExistsOnDisk(path: string | null | undefined): boolean {
  if (!path) return false
  return fileExistsMap.value.get(path) !== false
}

const activeDirty = computed(() =>
  activeArtifactId.value ? saveBridge.isDirty(activeArtifactId.value) : false
)

const canOpenActive = computed(() => pathExistsOnDisk(filePath.value))
const canSaveAsActive = computed(() =>
  activeArtifact.value ? canSaveAsArtifact(activeArtifact.value) : false
)
const canSaveAll = computed(() =>
  artifacts.value.some(a =>
    isArtifactEditable(a) &&
    Boolean(a.filePath) &&
    fileExistsMap.value.get(a.filePath!) !== false &&
    saveBridge.isDirty(a.id)
  )
)
/** 保存：可编辑、磁盘文件仍在、且有未保存编辑 */
const canSaveActive = computed(() =>
  isActiveEditable.value &&
  Boolean(filePath.value) &&
  pathExistsOnDisk(filePath.value) &&
  activeDirty.value
)

const saveActiveTitle = computed(() => {
  if (!isActiveEditable.value) return ''
  if (!filePath.value) return t('canvas.saveNoPath')
  if (!activeDirty.value) return t('canvas.saveNoChanges')
  return t('canvas.saveShortcut')
})

const showOpenButton = computed(() => Boolean(filePath.value))
const showFileOverflowMenu = computed(() =>
  canOpenActive.value || canSaveAsActive.value || canSaveAll.value
)
const showFileActions = computed(() => showOpenButton.value || showFileOverflowMenu.value)

const fileMenuRef = ref<HTMLElement | null>(null)
const showFileMenuDropdown = ref(false)
const ctxMenuRef = ref<HTMLElement | null>(null)
const saving = ref(false)

type ContextTarget =
  | { kind: 'tab'; artifactId: string }
  | { kind: 'header' }
  | null

const ctxMenu = ref<{
  show: boolean
  x: number
  y: number
  target: ContextTarget
}>({
  show: false,
  x: 0,
  y: 0,
  target: null
})
const ctxArtifact = computed(() => {
  if (ctxMenu.value.target?.kind !== 'tab') return null
  return artifactStore.getArtifactById(props.tabId, ctxMenu.value.target.artifactId)
})

const ctxMenuFlags = computed(() => {
  const artifact = ctxArtifact.value
  if (!artifact) return null
  const path = artifact.filePath
  const fileExists = path ? fileExistsMap.value.get(path) !== false : false
  return getArtifactContextMenuFlags(artifact, openTabs.value.length, {
    isDirty: saveBridge.isDirty(artifact.id),
    fileExists
  })
})

async function updateFileExistsMap() {
  const remaining = artifactStore.getArtifacts(props.tabId)
  fileExistsMap.value = remaining.length > 0
    ? await refreshFilePathExistsMap(remaining)
    : new Map()
}

async function refreshFileStatus() {
  await artifactStore.syncArtifactsWithDisk(props.tabId)
  await updateFileExistsMap()
}

function toggleFileMenu() {
  const next = !showFileMenuDropdown.value
  showFileMenuDropdown.value = next
  if (next) {
    closeCtxMenu()
    closeSendMenu()
    closeTabPicker()
  }
}

function closeFileMenu() {
  showFileMenuDropdown.value = false
}

// ---- 发送到手机（IM 渠道直发，三态：可发 / 未连接 / 无会话） ----
interface ChannelSendTarget {
  platform: string
  connected: boolean
  hasContact: boolean
  contactName?: string
}
const sendMenuRef = ref<HTMLElement | null>(null)
const sendMenuDropdownRef = ref<HTMLElement | null>(null)
const showSendMenu = ref(false)
const sendMenuPos = ref({ top: 0, left: 0, width: 200 })
const sendTargets = ref<ChannelSendTarget[]>([])
const sendTargetsLoading = ref(false)
const sendingPlatform = ref<string | null>(null)
let offImConnectionChange: (() => void) | null = null
let offImSendFailure: (() => void) | null = null

const canSendActive = computed(() => Boolean(filePath.value) && pathExistsOnDisk(filePath.value))

function channelName(platform: string): string {
  return t(`settings.im.${platform}`)
}

function syncSendMenuPosition() {
  if (!showSendMenu.value) return
  const anchor = sendMenuRef.value
  if (!anchor) return
  const rect = anchor.getBoundingClientRect()
  const width = sendMenuPos.value.width
  // 与按钮右对齐，防出屏
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
  sendMenuPos.value = { top: rect.bottom + 4, left, width }
}

async function refreshSendTargets() {
  sendTargetsLoading.value = sendTargets.value.length === 0
  try {
    sendTargets.value = (await window.electronAPI?.im?.getChannelSendTargets?.()) ?? []
  } catch {
    sendTargets.value = []
  } finally {
    sendTargetsLoading.value = false
  }
}

async function toggleSendMenu() {
  if (showSendMenu.value) {
    closeSendMenu()
    return
  }
  showSendMenu.value = true
  closeFileMenu()
  closeCtxMenu()
  closeTabPicker()
  void nextTick(syncSendMenuPosition)
  void refreshSendTargets()
  // 菜单打开期间跟随连接状态变化自刷新（启动后渠道可能稍后才连上）
  offImConnectionChange = window.electronAPI?.im?.onConnectionChange?.(() => {
    void refreshSendTargets()
  }) ?? null
  offImSendFailure = window.electronAPI?.im?.onSendFailure?.(() => {
    void refreshSendTargets()
  }) ?? null
}

function closeSendMenu() {
  showSendMenu.value = false
  offImConnectionChange?.()
  offImConnectionChange = null
  offImSendFailure?.()
  offImSendFailure = null
}

function sendTargetTip(target: ChannelSendTarget): string | undefined {
  if (!target.connected) return t('canvas.sendChannelOfflineTip')
  if (!target.hasContact) return t('canvas.sendChannelNoSessionTip', { platform: channelName(target.platform) })
  return undefined
}

async function sendToChannel(target: ChannelSendTarget) {
  if (!target.connected || !target.hasContact || sendingPlatform.value) return
  const artifact = activeArtifact.value
  const path = filePath.value
  if (!artifact || !path) return
  sendingPlatform.value = target.platform
  try {
    const result = await window.electronAPI?.im?.sendFileToChannel?.(
      target.platform,
      path,
      defaultSaveFileName(artifact)
    )
    if (result?.success) {
      toastSuccess(t('canvas.sendToChannelSuccess', { platform: channelName(target.platform) }))
      closeSendMenu()
    } else {
      toastError(t('canvas.sendToChannelFailed', { platform: channelName(target.platform), error: result?.error || '' }))
    }
  } catch (err: any) {
    toastError(t('canvas.sendToChannelFailed', { platform: channelName(target.platform), error: err?.message || '' }))
  } finally {
    sendingPlatform.value = null
  }
}

function artifactTabLabel(artifact: Pick<CanvasArtifact, 'title' | 'filePath'>) {
  return artifactDisplayLabel(artifact, t('canvas.artifactUntitled'))
}

function getArtifactContent(artifact: CanvasArtifact): string {
  return saveBridge.getContent(artifact.id, artifact.content)
}

function buildSaveDeps(): ArtifactSaveDeps | null {
  const api = window.electronAPI
  if (!api?.localFs?.writeFile || !api.localFs.copyFile || !api.sftp?.selectSavePath) {
    return null
  }
  return {
    writeFile: (path, content) => api.localFs!.writeFile(path, content),
    copyFile: (src, dest) => api.localFs!.copyFile(src, dest),
    selectSavePath: (defaultName) => api.sftp!.selectSavePath(defaultName),
    getContent: (artifactId) => {
      const a = artifactStore.getArtifactById(props.tabId, artifactId)
      return a ? saveBridge.getContent(artifactId, a.content) : ''
    }
  }
}

function flushActiveDraft() {
  if (activeArtifactId.value) {
    saveBridge.flush(activeArtifactId.value)
  }
}

function closeArtifact(id: string, e?: Event) {
  e?.stopPropagation()
  saveBridge.flush(id)
  artifactStore.closeTab(props.tabId, id)
}

const CTX_MENU_ESTIMATE = { width: 280, height: 360 }

function placeCtxMenu(x: number, y: number, size = CTX_MENU_ESTIMATE) {
  if (!ctxMenu.value.show) return
  const placed = clampContextMenuPosition({
    x,
    y,
    menuWidth: size.width,
    menuHeight: size.height,
    viewport: viewportBox()
  })
  ctxMenu.value = {
    ...ctxMenu.value,
    x: placed.left,
    y: placed.top
  }
}

function refineCtxMenu(x: number, y: number) {
  void nextTick(() => {
    const el = ctxMenuRef.value
    if (!el || !ctxMenu.value.show) return
    const r = el.getBoundingClientRect()
    placeCtxMenu(x, y, { width: r.width, height: r.height })
  })
}

function isPanelFocusedNow(): boolean {
  if (panelHasFocus.value) return true
  // webview / 编辑器拿到焦点时，宿主 mousedown 可能到不了，以当前 activeElement 为准
  return isArtifactOwnedTarget(document.activeElement)
}

function tryCloseFocusedTab(): boolean {
  if (!isPanelFocusedNow()) return false
  if (!artifactStore.isVisible(props.tabId)) return false
  const id = activeArtifactId.value
  if (!id) return false
  closeArtifact(id)
  return true
}

function isArtifactOwnedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  if (panelRoot.value?.contains(target)) return true
  // 右键菜单 / 发送菜单 teleport 到 body，点它们仍算产出物有焦点
  if (fileMenuRef.value?.contains(target)) return true
  if (sendMenuRef.value?.contains(target)) return true
  if (sendMenuDropdownRef.value?.contains(target)) return true
  if (ctxMenuRef.value?.contains(target)) return true
  if (tabPickerMenuRef.value?.contains(target)) return true
  return false
}

function setPanelFocusedFromEvent(target: EventTarget | null) {
  panelHasFocus.value = isArtifactOwnedTarget(target)
}

function closeOthers(keepId: string) {
  flushActiveDraft()
  artifactStore.closeOthers(props.tabId, keepId)
}

function closeAllArtifacts() {
  flushActiveDraft()
  artifactStore.closeAll(props.tabId)
}

function selectTab(id: string) {
  artifactStore.setActiveArtifact(props.tabId, id)
}

const activeTabIndex = computed(() =>
  openTabs.value.findIndex((tab) => tab.id === activeArtifactId.value)
)

function stepTab(delta: 1 | -1) {
  const next = openTabs.value[activeTabIndex.value + delta]
  if (next) selectTab(next.id)
}

function toggleTabPicker() {
  const next = !showTabPicker.value
  showTabPicker.value = next
  if (next) {
    closeFileMenu()
    closeSendMenu()
    closeCtxMenu()
  }
}

function closeTabPicker() {
  showTabPicker.value = false
}

function syncTabPickerPosition() {
  if (!showTabPicker.value) return
  const anchorEl = tabPickerRef.value
  if (!anchorEl) return
  const anchor = boxFromRect(anchorEl.getBoundingClientRect())
  const view = intersectViewport(panelRoot.value?.getBoundingClientRect())
  const extent = availableMenuExtent({ anchor, viewport: view })
  const maxWidth = Math.min(560, extent.maxWidth)
  const maxHeight = Math.min(360, extent.maxHeight)
  const menu = tabPickerMenuRef.value
  const menuWidth = menu ? Math.min(menu.offsetWidth, maxWidth) : Math.min(280, maxWidth)
  const menuHeight = menu ? Math.min(menu.offsetHeight, maxHeight) : Math.min(160, maxHeight)
  const placed = clampContextMenuPosition({
    x: anchor.left,
    y: anchor.bottom + 6,
    menuWidth,
    menuHeight,
    viewport: view
  })
  tabPickerPos.value = { top: placed.top, left: placed.left, maxWidth, maxHeight }
}

function pickTab(id: string) {
  selectTab(id)
  closeTabPicker()
}

// 页签条挤不下时才给下拉，平时不占地方
function measureTabsOverflow() {
  const strip = tabsEl.value
  const overflow = strip ? strip.scrollWidth - strip.clientWidth > 1 : false
  tabsOverflow.value = overflow
  if (!overflow) closeTabPicker()
}

// 竖滚轮在横条上等于横滚，和浏览器页签条一致
function onTabsWheel(ev: WheelEvent) {
  const strip = tabsEl.value
  if (!strip || !tabsOverflow.value) return
  const delta = Math.abs(ev.deltaY) > Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX
  if (!delta) return
  ev.preventDefault()
  strip.scrollLeft += delta
}

function minimizePanel() {
  flushActiveDraft()
  for (const artifact of artifacts.value) {
    saveBridge.flush(artifact.id)
  }
  closeAllMenus()
  hideTip()
  artifactStore.minimizePanel(props.tabId)
}

function jumpToSource(stepId?: string) {
  const rawId = stepId ?? activeSourceStepId.value
  if (!rawId || !props.scrollToAgentStep) return
  closeAllMenus()
  const allSteps = desktopHost.getAgentSteps(props.tabId)
  const visibleStepId = resolveSourceStepIdById(rawId, allSteps)
  void props.scrollToAgentStep(visibleStepId)
}

/**
 * 截图反馈闭环：截取 webview 渲染结果 → 图片进 Composer 待发送区 + 草稿意图文本。
 * 用户补充意见后回车，Agent 读到截图与意见后修改，面板刷新即见新版。
 */
async function onCaptureFeedback(payload: { webContentsId: number; suggestedName: string }) {
  const api = window.electronAPI?.artifactPreview
  if (!api?.capture) {
    toastError(t('canvas.captureFeedbackFailed'))
    return
  }
  const res = await api.capture(payload)
  if (!res.success || !res.data) {
    toastError(res.error || t('canvas.captureFeedbackFailed'))
    return
  }
  const active = activeArtifact.value
  const name = payload.suggestedName || active?.title || 'artifact'
  props.addComposerImage?.({
    dataUrl: res.data.dataUrl,
    name: `${name}.png`,
    width: res.data.width,
    height: res.data.height,
    filePath: res.data.filePath,
  })
  props.setComposerDraft?.(t('canvas.captureFeedbackDraft', { title: active?.title || name }))
  toastSuccess(t('canvas.captureFeedbackReady'))
}

async function openFileFor(artifact: CanvasArtifact) {
  const path = artifact.filePath
  if (!path) return
  const api = window.electronAPI?.localFs
  if (!api?.openFile) {
    toastError(t('canvas.openFailed'))
    return
  }
  try {
    await api.openFile(path)
  } catch (err) {
    toastError(err instanceof Error ? err.message : t('canvas.openFailed'))
  }
}

async function openFile() {
  const active = activeArtifact.value
  if (active) await openFileFor(active)
}

async function showInFolderFor(artifact: CanvasArtifact) {
  const path = artifact.filePath
  if (!path) return
  const api = window.electronAPI?.localFs
  if (!api?.showInExplorer) {
    toastError(t('canvas.showInFolderFailed'))
    return
  }
  try {
    await api.showInExplorer(path)
  } catch (err) {
    toastError(err instanceof Error ? err.message : t('canvas.showInFolderFailed'))
  }
}

async function showInFolder() {
  const active = activeArtifact.value
  if (active) await showInFolderFor(active)
}

async function runSave(artifact: CanvasArtifact) {
  const deps = buildSaveDeps()
  if (!deps) {
    toastError(t('canvas.saveFailed'))
    return
  }
  saveBridge.flush(artifact.id)
  saving.value = true
  try {
    const res = await saveArtifact(artifact, deps)
    if (res.ok) {
      artifactStore.updateContent(props.tabId, getArtifactContent(artifact), artifact.id)
      artifactStore.markSavedToDisk(props.tabId, artifact.id, getArtifactContent(artifact))
      saveBridge.clearDirty(artifact.id)
      if (artifact.filePath) {
        fileExistsMap.value = new Map(fileExistsMap.value).set(artifact.filePath, true)
      }
      toastSuccess(t('canvas.savedToDisk'))
    } else {
      toastError(res.error || t('canvas.saveFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function runSaveAs(artifact: CanvasArtifact) {
  const deps = buildSaveDeps()
  if (!deps) {
    toastError(t('canvas.saveFailed'))
    return
  }
  saveBridge.flush(artifact.id)
  saving.value = true
  try {
    const res = await saveArtifactAs(artifact, deps)
    if (res.ok) {
      artifactStore.relocateArtifact(
        props.tabId,
        artifact.id,
        res.filePath,
        getArtifactContent(artifact)
      )
      saveBridge.clearDirty(artifact.id)
      await refreshFileStatus()
      toastSuccess(t('canvas.savedToDisk'))
    } else if (!res.canceled) {
      toastError(res.error || t('canvas.saveFailed'))
    }
  } finally {
    saving.value = false
  }
}

async function runSaveActive() {
  const active = activeArtifact.value
  if (!active || !canSaveActive.value) return
  await runSave(active)
}

async function runSaveAsActive() {
  const active = activeArtifact.value
  if (!active || !canSaveAsArtifact(active)) return
  await runSaveAs(active)
}

async function runSaveAll() {
  const deps = buildSaveDeps()
  if (!deps) {
    toastError(t('canvas.saveFailed'))
    return
  }
  for (const a of artifacts.value) {
    saveBridge.flush(a.id)
  }
  saving.value = true
  try {
    let saved = 0
    let failed = 0
    for (const a of artifacts.value) {
      if (!a.filePath || fileExistsMap.value.get(a.filePath) === false) continue
      if (a.renderer !== 'markdown' || !saveBridge.isDirty(a.id)) continue
      const res = await saveArtifact(a, deps)
      if (res.ok) {
        artifactStore.updateContent(props.tabId, getArtifactContent(a), a.id)
        artifactStore.markSavedToDisk(props.tabId, a.id, getArtifactContent(a))
        saveBridge.clearDirty(a.id)
        saved += 1
      } else {
        failed += 1
      }
    }
    if (saved === 0 && failed === 0) {
      toastInfo(t('canvas.saveAllNone'))
      return
    }
    if (failed === 0) {
      toastSuccess(t('canvas.saveAllDone', { count: saved }))
    } else {
      toastError(t('canvas.saveAllPartial', { saved, failed }))
    }
  } finally {
    saving.value = false
  }
}

function closeOverlayMenus() {
  closeFileMenu()
  closeSendMenu()
  closeCtxMenu()
  closeTabPicker()
}

function closeAllMenus() {
  closeOverlayMenus()
}

/** 任意浮层菜单打开时屏蔽 canvas-body 的指针事件，防止 iframe 合成层吞掉点击，导致菜单无法关闭 */
const anyMenuOpen = computed(() =>
  ctxMenu.value.show || showFileMenuDropdown.value || showSendMenu.value || showTabPicker.value
)

function openCtxMenu(e: MouseEvent, target: ContextTarget) {
  e.preventDefault()
  e.stopPropagation()
  closeFileMenu()
  closeTabPicker()
  const placed = clampContextMenuPosition({
    x: e.clientX,
    y: e.clientY,
    menuWidth: CTX_MENU_ESTIMATE.width,
    menuHeight: CTX_MENU_ESTIMATE.height,
    viewport: viewportBox()
  })
  ctxMenu.value = {
    show: true,
    x: placed.left,
    y: placed.top,
    target
  }
  refineCtxMenu(e.clientX, e.clientY)
}

function openHeaderCtxMenu(e: MouseEvent) {
  if (activeArtifactId.value) {
    openCtxMenu(e, { kind: 'tab', artifactId: activeArtifactId.value })
    return
  }
  openCtxMenu(e, { kind: 'header' })
}

function closeCtxMenu() {
  ctxMenu.value.show = false
  ctxMenu.value.target = null
}

function onDocumentMouseDown(e: MouseEvent) {
  setPanelFocusedFromEvent(e.target)
  const target = e.target as Node
  if (showFileMenuDropdown.value) {
    const el = fileMenuRef.value
    if (el && !el.contains(target)) closeFileMenu()
  }
  if (showTabPicker.value) {
    const anchor = tabPickerRef.value
    const menu = tabPickerMenuRef.value
    if (
      anchor && !anchor.contains(target) &&
      menu && !menu.contains(target)
    ) {
      closeTabPicker()
    }
  }
  if (showSendMenu.value) {
    const anchor = sendMenuRef.value
    const dropdown = sendMenuDropdownRef.value
    if (
      anchor && !anchor.contains(target) &&
      dropdown && !dropdown.contains(target)
    ) {
      closeSendMenu()
    }
  }
  if (ctxMenu.value.show) {
    const menu = ctxMenuRef.value
    if (menu && !menu.contains(target)) {
      closeCtxMenu()
    }
  }
}

function onDocumentFocusIn(e: FocusEvent) {
  setPanelFocusedFromEvent(e.target)
}

function onDocumentKeyDown(e: KeyboardEvent) {
  if (isCloseArtifactShortcut(e) && closeFocusedArtifact()) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  if (e.key !== 'Escape') return
  if (ctxMenu.value.show) {
    closeCtxMenu()
    return
  }
  if (showSendMenu.value) {
    closeSendMenu()
    return
  }
  if (showFileMenuDropdown.value) {
    closeFileMenu()
    return
  }
  if (showTabPicker.value) {
    closeTabPicker()
  }
}

watch(activeArtifactId, (next, prev) => {
  if (prev && prev !== next) {
    saveBridge.flush(prev)
  }
  void refreshFileStatus()
  scrollActiveTabIntoView()
})

watch(() => openTabs.value.length, () => {
  scrollActiveTabIntoView()
  void nextTick(measureTabsOverflow)
})

// 页签条挤不下时会横向滚动，当前页签必须自己露出来，否则会被右侧按钮挡掉
function scrollActiveTabIntoView() {
  const id = activeArtifactId.value
  if (!id) return
  void nextTick(() => {
    const strip = tabsEl.value
    const tab = strip?.querySelector<HTMLElement>(`[data-artifact-id="${CSS.escape(id)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

watch(showTabPicker, (open) => {
  if (open) {
    syncTabPickerPosition()
    void nextTick(syncTabPickerPosition)
    window.addEventListener('resize', syncTabPickerPosition)
    window.addEventListener('scroll', syncTabPickerPosition, true)
  } else {
    window.removeEventListener('resize', syncTabPickerPosition)
    window.removeEventListener('scroll', syncTabPickerPosition, true)
  }
})

watch(showSendMenu, (open) => {
  if (open) {
    void nextTick(syncSendMenuPosition)
    window.addEventListener('resize', syncSendMenuPosition)
    window.addEventListener('scroll', syncSendMenuPosition, true)
  } else {
    window.removeEventListener('resize', syncSendMenuPosition)
    window.removeEventListener('scroll', syncSendMenuPosition, true)
  }
})

watch(artifacts, () => {
  void refreshFileStatus()
}, { deep: true })

watch(
  () => artifactStore.lastDiskSync,
  (ev) => {
    if (!ev || ev.tabId !== props.tabId) return
    for (const artifact of ev.removed) {
      saveBridge.unregister(artifact.id)
    }
    void updateFileExistsMap()
  }
)

function onWindowFocus() {
  void refreshFileStatus()
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void refreshFileStatus()
  }
}

onMounted(() => {
  registerFocusedArtifactCloser(tryCloseFocusedTab)
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('focusin', onDocumentFocusIn, true)
  document.addEventListener('keydown', onDocumentKeyDown, true)
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('visibilitychange', onVisibilityChange)
  if (tabsEl.value) {
    tabsResizeObserver = new ResizeObserver(() => measureTabsOverflow())
    tabsResizeObserver.observe(tabsEl.value)
  }
  measureTabsOverflow()
  void refreshFileStatus()
  const active = artifactStore.getActiveArtifact(props.tabId)
  if (active && !active.content?.trim() && active.filePath) {
    void artifactStore.reloadArtifactContent(props.tabId, active.id)
  }
})

onUnmounted(() => {
  tabsResizeObserver?.disconnect()
  tabsResizeObserver = null
  registerFocusedArtifactCloser(null)
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('focusin', onDocumentFocusIn, true)
  document.removeEventListener('keydown', onDocumentKeyDown, true)
  window.removeEventListener('focus', onWindowFocus)
  window.removeEventListener('visibilitychange', onVisibilityChange)
  window.removeEventListener('resize', syncSendMenuPosition)
  window.removeEventListener('scroll', syncSendMenuPosition, true)
  window.removeEventListener('resize', syncTabPickerPosition)
  window.removeEventListener('scroll', syncTabPickerPosition, true)
  offImConnectionChange?.()
})

defineExpose({ minimizePanel })
</script>

<template>
  <div ref="panelRoot" class="canvas-panel" :class="{ 'is-focus': focusActive }">
    <div
      class="canvas-header"
      @contextmenu="openHeaderCtxMenu"
    >
      <div
        ref="tabsEl"
        class="artifact-tabs"
        :class="{ 'is-overflow': tabsOverflow }"
        role="tablist"
        @wheel="onTabsWheel"
        @keydown.left.prevent="stepTab(-1)"
        @keydown.right.prevent="stepTab(1)"
      >
        <button
          v-for="tab in openTabs"
          :key="tab.id"
          type="button"
          role="tab"
          class="artifact-tab"
          :class="{ active: tab.id === activeArtifactId }"
          :data-artifact-id="tab.id"
          :aria-selected="tab.id === activeArtifactId"
          :title="artifactTabLabel(tab)"
          @click="selectTab(tab.id)"
          @contextmenu="openCtxMenu($event, { kind: 'tab', artifactId: tab.id })"
        >
          <ArtifactFileIcon
            :file-path="tab.filePath"
            :renderer="tab.renderer"
            :size="16"
          />
          <span class="artifact-tab-label">{{ artifactTabLabel(tab) }}</span>
          <span
            class="artifact-tab-close"
            :title="t('canvas.closeArtifact')"
            @click="closeArtifact(tab.id, $event)"
          >
            <X :size="12" />
          </span>
        </button>
      </div>
      <div class="canvas-header-fill" aria-hidden="true" />
      <div v-if="tabsOverflow" ref="tabPickerRef" class="artifact-tab-picker">
        <button
          type="button"
          class="artifact-tab-nav-btn"
          :class="{ 'artifact-tab-nav-btn--open': showTabPicker }"
          :aria-expanded="showTabPicker"
          :title="t('canvas.openTabsMenu')"
          @click="toggleTabPicker"
        >
          <ChevronDown :size="14" />
        </button>
      </div>
      <div class="canvas-header-actions">
        <button
          v-if="isActiveEditable"
          type="button"
          class="canvas-text-btn canvas-save-text-btn"
          :disabled="saving || !canSaveActive"
          :title="saveActiveTitle"
          @click="runSaveActive"
        >
          {{ saving ? t('common.saving') : t('canvas.saveToDisk') }}
        </button>
        <div v-if="showFileActions" class="canvas-file-actions">
          <button
            v-if="showOpenButton"
            type="button"
            class="canvas-text-btn canvas-open-btn"
            :class="{ 'canvas-open-btn--with-menu': showFileOverflowMenu }"
            :disabled="!canOpenActive"
            :title="t('canvas.openFile')"
            @click="openFile()"
          >
            {{ t('canvas.openFile') }}
          </button>
          <div v-if="showFileOverflowMenu" ref="fileMenuRef" class="canvas-file-menu-wrap">
            <button
              type="button"
              class="canvas-text-btn canvas-file-overflow-btn"
              :class="{ 'canvas-file-overflow-btn--solo': !showOpenButton }"
              :aria-expanded="showFileMenuDropdown"
              :title="t('canvas.openMenu')"
              @click="toggleFileMenu"
            >
              <ChevronDown :size="12" />
            </button>
            <div v-if="showFileMenuDropdown" class="canvas-dropdown-menu" @click.stop>
              <button
                v-if="canOpenActive"
                type="button"
                class="canvas-dropdown-item"
                @click="showInFolder(); closeFileMenu()"
              >
                <FolderOpen :size="14" />
                <span>{{ t('canvas.showInFolder') }}</span>
              </button>
              <div v-if="canOpenActive && canSaveAsActive" class="canvas-dropdown-separator" />
              <button
                v-if="canSaveAsActive"
                type="button"
                class="canvas-dropdown-item"
                :disabled="saving"
                @click="runSaveAsActive(); closeFileMenu()"
              >
                <Download :size="14" />
                <span>{{ t('canvas.saveAs') }}</span>
              </button>
              <button
                v-if="canSaveAll"
                type="button"
                class="canvas-dropdown-item"
                :disabled="saving"
                @click="runSaveAll(); closeFileMenu()"
              >
                <span>{{ t('canvas.saveAll') }}</span>
              </button>
            </div>
          </div>
        </div>
        <div v-if="canSendActive" ref="sendMenuRef" class="canvas-file-menu-wrap">
          <button
            type="button"
            class="canvas-text-btn canvas-icon-btn"
            :aria-expanded="showSendMenu"
            :aria-label="t('canvas.sendToPhone')"
            :title="t('canvas.sendToPhone')"
            @click="toggleSendMenu"
          >
            <Smartphone :size="14" />
          </button>
        </div>
        <button
          type="button"
          class="canvas-text-btn canvas-icon-btn"
          :aria-pressed="focusActive"
          :aria-label="focusActive ? t('canvas.splitDocument') : t('canvas.focusDocument')"
          :title="focusActive ? t('canvas.splitDocument') : t('canvas.focusDocument')"
          @click="emit('toggleFocus')"
        >
          <Minimize2 v-if="focusActive" :size="14" />
          <Maximize2 v-else :size="14" />
        </button>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="showTabPicker"
        ref="tabPickerMenuRef"
        class="artifact-tab-picker-menu"
        role="menu"
        :aria-label="t('canvas.openTabsMenu')"
        :style="{
          top: `${tabPickerPos.top}px`,
          left: `${tabPickerPos.left}px`,
          maxWidth: `${tabPickerPos.maxWidth}px`,
          maxHeight: `${tabPickerPos.maxHeight}px`
        }"
        @click.stop
      >
        <div class="artifact-tab-picker-head">{{ t('canvas.openTabsMenu') }}</div>
        <div class="artifact-tab-picker-body">
          <button
            v-for="tab in openTabs"
            :key="tab.id"
            type="button"
            role="menuitem"
            class="artifact-tab-picker-item"
            :class="{ active: tab.id === activeArtifactId }"
            :title="artifactTabLabel(tab)"
            @click="pickTab(tab.id)"
          >
            <span class="artifact-tab-picker-icon">
              <ArtifactFileIcon
                :file-path="tab.filePath"
                :renderer="tab.renderer"
                :size="20"
              />
            </span>
            <span class="artifact-tab-picker-label">{{ artifactTabLabel(tab) }}</span>
          </button>
        </div>
      </div>
      <div
        v-if="showSendMenu"
        ref="sendMenuDropdownRef"
        class="canvas-dropdown-menu canvas-send-menu canvas-send-menu--floating"
        :style="{
          top: `${sendMenuPos.top}px`,
          left: `${sendMenuPos.left}px`,
          width: `${sendMenuPos.width}px`
        }"
        @click.stop
      >
        <div class="canvas-send-title">{{ t('canvas.sendToPhone') }}</div>
        <div v-if="sendTargetsLoading" class="canvas-send-loading">{{ t('common.loading') }}</div>
        <template v-else>
          <button
            v-for="target in sendTargets"
            :key="target.platform"
            type="button"
            class="canvas-dropdown-item canvas-send-item"
            :class="{ 'canvas-send-item--disabled': !target.connected || !target.hasContact }"
            :aria-disabled="!target.connected || !target.hasContact"
            :title="sendTargetTip(target)"
            @click="sendToChannel(target)"
          >
            <span class="canvas-send-platform">{{ channelName(target.platform) }}</span>
            <span v-if="sendingPlatform === target.platform" class="canvas-send-meta">
              {{ t('canvas.sending') }}
            </span>
            <span v-else-if="target.connected && target.hasContact && target.contactName" class="canvas-send-meta">
              {{ target.contactName }}
            </span>
            <span v-else-if="!target.connected" class="canvas-send-meta">
              {{ t('canvas.sendChannelOffline') }}
            </span>
            <span v-else-if="!target.hasContact" class="canvas-send-meta">
              {{ t('canvas.sendChannelNoSession') }}
            </span>
          </button>
        </template>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="ctxMenu.show"
        class="canvas-ctx-overlay"
        @mousedown="closeCtxMenu"
        @contextmenu.prevent="closeCtxMenu"
      />
      <div
        v-if="ctxMenu.show"
        ref="ctxMenuRef"
        class="canvas-ctx-menu"
        :style="{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }"
        @click.stop
        @contextmenu.prevent
      >
      <template v-if="ctxMenu.target?.kind === 'tab' && ctxArtifact && ctxMenuFlags">
        <div class="canvas-ctx-header" :title="artifactTabLabel(ctxArtifact)">{{ artifactTabLabel(ctxArtifact) }}</div>
        <div v-if="ctxArtifact.filePath" class="canvas-ctx-path" :title="ctxArtifact.filePath">
          {{ ctxArtifact.filePath }}
        </div>
        <div
          v-if="ctxArtifact.filePath || artifactHasFileActions(ctxMenuFlags)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="ctxMenuFlags.showOpen"
          type="button"
          class="canvas-ctx-item"
          @click="openFileFor(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.openFile') }}
        </button>
        <button
          v-if="ctxMenuFlags.showOpen"
          type="button"
          class="canvas-ctx-item"
          @click="showInFolderFor(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.showInFolder') }}
        </button>
        <div
          v-if="ctxMenuFlags.showOpen && (ctxMenuFlags.showSave || ctxMenuFlags.showSaveAs)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="ctxMenuFlags.showSave"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSave(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.saveToDisk') }}
        </button>
        <button
          v-if="ctxMenuFlags.showSaveAs"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAs(ctxArtifact); closeCtxMenu()"
        >
          {{ t('canvas.saveAs') }}
        </button>
        <button
          v-if="canSaveAll"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAll(); closeCtxMenu()"
        >
          {{ t('canvas.saveAll') }}
        </button>
        <div class="canvas-ctx-separator" />
        <button
          type="button"
          class="canvas-ctx-item"
          @click="closeArtifact(ctxArtifact.id); closeCtxMenu()"
        >
          {{ t('canvas.closeArtifact') }}
        </button>
        <button
          v-if="ctxMenuFlags.showCloseOthers"
          type="button"
          class="canvas-ctx-item"
          @click="closeOthers(ctxArtifact.id); closeCtxMenu()"
        >
          {{ t('canvas.closeOthers') }}
        </button>
        <button
          type="button"
          class="canvas-ctx-item danger"
          @click="closeAllArtifacts(); closeCtxMenu()"
        >
          {{ t('canvas.closeAll') }}
        </button>
        <template v-if="ctxMenuFlags.showJumpToSource">
          <div class="canvas-ctx-separator" />
          <button
            type="button"
            class="canvas-ctx-item"
            @click="jumpToSource(ctxArtifact.sourceStepId); closeCtxMenu()"
          >
            {{ t('canvas.jumpToSource') }}
          </button>
        </template>
      </template>
      <template v-else-if="ctxMenu.target?.kind === 'header'">
        <button
          v-if="canOpenActive"
          type="button"
          class="canvas-ctx-item"
          @click="openFile(); closeCtxMenu()"
        >
          {{ t('canvas.openFile') }}
        </button>
        <button
          v-if="canOpenActive"
          type="button"
          class="canvas-ctx-item"
          @click="showInFolder(); closeCtxMenu()"
        >
          {{ t('canvas.showInFolder') }}
        </button>
        <div
          v-if="canOpenActive && (isActiveEditable || canSaveAsActive || canSaveAll)"
          class="canvas-ctx-separator"
        />
        <button
          v-if="isActiveEditable"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving || !canSaveActive"
          :title="saveActiveTitle"
          @click="runSaveActive(); closeCtxMenu()"
        >
          {{ t('canvas.saveToDisk') }}
        </button>
        <button
          v-if="canSaveAsActive"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAsActive(); closeCtxMenu()"
        >
          {{ t('canvas.saveAs') }}
        </button>
        <button
          v-if="canSaveAll"
          type="button"
          class="canvas-ctx-item"
          :disabled="saving"
          @click="runSaveAll(); closeCtxMenu()"
        >
          {{ t('canvas.saveAll') }}
        </button>
        <div
          v-if="isActiveEditable || canSaveAsActive || canSaveAll"
          class="canvas-ctx-separator"
        />
        <button
          v-if="openTabs.length > 0"
          type="button"
          class="canvas-ctx-item danger"
          @click="closeAllArtifacts(); closeCtxMenu()"
        >
          {{ t('canvas.closeAll') }}
        </button>
        <template v-if="activeSourceStepId">
          <div class="canvas-ctx-separator" />
          <button
            type="button"
            class="canvas-ctx-item"
            @click="jumpToSource(); closeCtxMenu()"
          >
            {{ t('canvas.jumpToSource') }}
          </button>
        </template>
      </template>
      </div>
    </Teleport>

    <div v-if="activeArtifactId" class="canvas-body" :class="{ 'canvas-body--no-pointer': anyMenuOpen }">
      <div class="canvas-renderer-host">
        <component
          :is="activeRendererComponent"
          v-if="activeRendererComponent"
          :key="activeArtifactId"
          :tab-id="tabId"
          :artifact-id="activeArtifactId"
          @capture-feedback="onCaptureFeedback"
        />
        <div v-else class="canvas-unsupported">
          {{ t('canvas.unsupportedRenderer') }}
        </div>
      </div>
      <div v-if="focusActive" class="canvas-focus-spacer" aria-hidden="true" />
    </div>

    <HoverTipOverlay :tip="hoverTip" />
  </div>
</template>

<style scoped>
.canvas-panel {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--bg-primary, #1e1e1e);
  border-left: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.canvas-panel.is-focus {
  border-left: none;
}

/* 铺满后这排贴着窗口右沿。36px 只够清单按钮，Windows 三个窗口按钮还要另让开，否则会盖住保存/打开 */
.canvas-panel.is-focus .canvas-header {
  padding-right: calc(max(8px, var(--shell-inset-right, 0px)) + 36px);
}

.canvas-focus-spacer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: var(--assistant-focus-overlay, 160px);
  background: transparent;
  pointer-events: auto;
}

.canvas-header {
  display: flex;
  align-items: center;
  gap: 12px;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  padding: 0 38px 0 12px;
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  flex-shrink: 0;
  user-select: none;
  container-type: inline-size;
  container-name: artifact-header;
}

.artifact-tabs {
  display: flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  /* 只占页签自己的宽度，中间空白留给顶栏（窗口拖拽 / 双击最大化） */
  flex: 0 1 auto;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

/* 挤不下时右缘渐隐，让截断看起来是「还有更多」而不是画坏了 */
.artifact-tabs.is-overflow {
  mask-image: linear-gradient(to right, #000 calc(100% - 16px), transparent 100%);
}

.canvas-header-fill {
  flex: 1 1 auto;
  min-width: 0;
  align-self: stretch;
}

.artifact-tabs::-webkit-scrollbar {
  display: none;
}

.artifact-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  box-sizing: border-box;
  min-width: 120px;
  max-width: 220px;
  flex: 0 1 auto;
  height: 28px;
  padding: 0 5px 0 9px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  font-size: 12px;
  line-height: 1.2;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

/* 中性叠加层而非固定灰：按文字色混，深浅主题都成立 */
.artifact-tab:hover {
  background: color-mix(in srgb, var(--text-primary, #eee) 7%, transparent);
  color: var(--text-primary, #eee);
}

/* 挤压时先压别人：当前看的这个页签留住完整文件名 */
.artifact-tab.active,
.artifact-tab.active:hover {
  background: color-mix(in srgb, var(--text-primary, #eee) 14%, transparent);
  color: var(--text-primary, #eee);
  font-weight: 500;
  flex-shrink: 0;
}

.artifact-tab > :first-child {
  flex-shrink: 0;
  opacity: 0.75;
}

.artifact-tab.active > :first-child {
  opacity: 1;
}

.artifact-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 关闭常驻会让整条页签很吵：平时透明占位，指到或选中才显形，宽度不跳 */
.artifact-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 6px;
  color: inherit;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.12s, background 0.12s;
}

.artifact-tab:hover .artifact-tab-close,
.artifact-tab.active .artifact-tab-close,
.artifact-tab:focus-visible .artifact-tab-close {
  opacity: 0.55;
}

.artifact-tab-picker {
  position: relative;
  flex-shrink: 0;
  margin-left: -6px;
}

.artifact-tab-nav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #aaa);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.artifact-tab-nav-btn:hover,
.artifact-tab-nav-btn--open {
  background: color-mix(in srgb, var(--text-primary, #eee) 10%, transparent);
  color: var(--text-primary, #eee);
}

.artifact-tab-picker-menu {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: max-content;
  min-width: min(240px, 100%);
  padding: 8px;
  overflow: hidden;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: var(--bg-secondary, #252525);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.28);
}

.artifact-tab-picker-head {
  padding: 6px 8px 8px;
  color: var(--text-secondary, #aaa);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.artifact-tab-picker-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}

.artifact-tab-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 13px;
  line-height: 1.3;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.artifact-tab-picker-item:hover {
  background: var(--hover-bg, rgba(255, 255, 255, 0.07));
}

.artifact-tab-picker-item.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
}

.artifact-tab-picker-item.active .artifact-tab-picker-label {
  color: var(--accent-primary, #89b4fa);
}

.artifact-tab-picker-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
}

.artifact-tab-picker-label {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-tab .artifact-tab-close:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--text-primary, #eee) 16%, transparent);
}

.canvas-ctx-header {
  padding: 6px 14px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #eee);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.canvas-ctx-path {
  padding: 0 14px 6px;
  font-size: 10px;
  color: var(--text-secondary, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.canvas-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
}

.canvas-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 22px;
  padding: 0 8px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.14));
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, border-color 0.12s;
}

.canvas-icon-btn {
  width: 22px;
  padding: 0;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-secondary, #aaa);
}

.canvas-icon-btn:hover:not(:disabled) {
  color: var(--text-primary, #eee);
}

.canvas-text-btn:hover:not(:disabled) {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.canvas-header-actions .canvas-save-text-btn:hover:not(:disabled) {
  color: var(--accent-primary, #4d9eff);
  border-color: rgba(var(--accent-rgb, 77, 158, 255), 0.35);
}

.canvas-text-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-save-text-btn:not(:disabled) {
  border-color: rgba(var(--accent-rgb, 77, 158, 255), 0.35);
  color: var(--accent-primary, #4d9eff);
}

.canvas-file-actions {
  display: flex;
  align-items: center;
}

.canvas-open-btn--with-menu {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
  border-right: none;
}

.canvas-file-overflow-btn {
  padding: 0 5px;
  min-width: 22px;
  justify-content: center;
}

.canvas-file-overflow-btn:not(.canvas-file-overflow-btn--solo) {
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}

.canvas-file-menu-wrap {
  position: relative;
}

.canvas-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 160px;
  padding: 4px;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  z-index: 20;
}

.canvas-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s;
}

.canvas-dropdown-item:hover:not(:disabled) {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.canvas-dropdown-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-dropdown-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--border-color, rgba(255, 255, 255, 0.1));
}

.canvas-send-menu--floating {
  position: fixed;
  top: auto;
  right: auto;
  z-index: 10000;
  box-sizing: border-box;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}

.canvas-send-title {
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-height: 32px;
  margin: -4px -4px 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  color: var(--text-secondary, #aaa);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: center;
  user-select: none;
  pointer-events: none;
}

.canvas-send-loading {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-secondary, #999);
}

.canvas-send-item {
  justify-content: space-between;
}

.canvas-send-item--disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-send-item--disabled:hover {
  background: transparent;
}

.canvas-send-platform {
  flex-shrink: 0;
  white-space: nowrap;
}

.canvas-send-meta {
  margin-left: 12px;
  font-size: 11px;
  color: var(--text-secondary, #999);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.canvas-body {
  position: relative;
  flex: 1;
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.canvas-body--no-pointer {
  pointer-events: none;
}

.canvas-renderer-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.canvas-renderer-host > * {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.canvas-ctx-overlay {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.canvas-ctx-menu {
  position: fixed;
  z-index: 9999;
  box-sizing: border-box;
  min-width: 168px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px 0;
  background: var(--bg-secondary, #252525);
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
}

.canvas-ctx-item {
  display: block;
  width: 100%;
  padding: 7px 14px;
  border: none;
  background: transparent;
  color: var(--text-primary, #eee);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.canvas-ctx-item:hover:not(:disabled) {
  background: var(--hover-bg, rgba(255, 255, 255, 0.08));
}

.canvas-ctx-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.canvas-ctx-item.danger {
  color: var(--text-secondary, #ccc);
}

.canvas-ctx-item.danger:hover:not(:disabled) {
  background: rgba(244, 63, 94, 0.12);
  color: #f87171;
}

.canvas-ctx-separator {
  height: 1px;
  margin: 4px 0;
  background: var(--border-color, rgba(255, 255, 255, 0.1));
}

.canvas-unsupported {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 24px;
  color: var(--text-secondary, #aaa);
  font-size: 13px;
}
</style>
