<script setup lang="ts">
import { ref, computed, watch, inject, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, X } from 'lucide-vue-next'
import { useTerminalStore, type SplitPane, type LayoutDrag } from '../stores/terminal'
import { getAllTerminalPanes, type PaneEdge } from '../stores/split-pane-tree'
import { PANE_SLOT_REGISTRY_KEY, type PaneSlotRegistry } from './pane-slot-registry'

const { t } = useI18n()
const terminalStore = useTerminalStore()

const props = defineProps<{
  tabId: string
  layout: SplitPane
  isActive: boolean
  /** 终端页才开四边落点；助手入座的终端不要 */
  enableLayoutDrag?: boolean
}>()

// SplitPaneView 内部不再渲染 Terminal：
//   Terminal 实例由 TerminalTabView 顶层按 ptyId 维护，通过 Teleport 投影到这里
//   渲染的占位 div。这样布局如何变化都不会销毁 Terminal 组件实例 / xterm 实例，
//   从根本上保护终端内容。
//
//   占位 div 的 element 引用通过 paneSlotRegistry 注册到 TerminalTabView，
//   后者用 element 引用作为 Teleport 的 :to——而非 selector 字符串——
//   element 变化时 Vue 自动 patch DOM 到新位置，避免孤儿化。
const paneSlotRegistry = inject<PaneSlotRegistry>(PANE_SLOT_REGISTRY_KEY)
const slotElRef = ref<HTMLElement | null>(null)

watch([slotElRef, () => props.layout.ptyId], ([el, ptyId]) => {
  if (el && ptyId && paneSlotRegistry) {
    paneSlotRegistry.register(ptyId, el)
  }
}, { immediate: true, flush: 'post' })

// ==================== 布局判断 ====================

const isTerminal = computed(() => props.layout.type === 'terminal')
const isSplit = computed(() => props.layout.type === 'split')
const direction = computed<'horizontal' | 'vertical'>(() => props.layout.direction || 'horizontal')
const children = computed(() => props.layout.children || [])

const paneStyle = computed(() => {
  if (props.layout.size) {
    return { flex: `${props.layout.size} 1 0%` }
  }
  return { flex: '1 1 0%' }
})

// 单窗格判定：当前 tab 总共只有一个终端窗格
// 单窗格场景下，"激活"概念无意义（没法切换），不再显示焦点框；关闭按钮也无意义（关掉等于关 tab）
const isSinglePane = computed(() => {
  const tab = terminalStore.tabs.find(t => t.id === props.tabId)
  if (!tab?.splitLayout) return true
  return getAllTerminalPanes(tab.splitLayout).length <= 1
})

// 终端窗格被激活的视觉高亮（单窗格不显示）
const isPaneActive = computed(() => isTerminal.value && !isSinglePane.value && (props.layout.isActive ?? false))

// 窗格顶部的连接名标签：只在分屏时出现——单窗格没有第二扇要区分，标签只是碍事
const connectionName = computed(() => terminalStore.getPaneConnectionName(props.layout))
const showConnectionLabel = computed(() =>
  isTerminal.value
  && !isSinglePane.value
  && Boolean(props.layout.ptyId || props.layout.isConnecting || props.layout.connectionError)
)
const paneConnecting = computed(() =>
  Boolean(props.layout.isConnecting || terminalStore.isPtyReconnecting(props.layout.ptyId))
)
const paneReadyForTerminal = computed(() =>
  Boolean(props.layout.ptyId) && !paneConnecting.value && !props.layout.connectionError
)

async function retryPaneConnect() {
  if (!props.layout.ptyId) return
  await terminalStore.reconnectSsh(props.tabId, props.layout.ptyId)
}

// ==================== 容器引用（用于拖拽时计算容器尺寸）====================

const containerRef = ref<HTMLElement | null>(null)

// ==================== 点击激活窗格 ====================

function handlePaneClick() {
  if (!isTerminal.value) return
  if (props.layout.isActive) return
  console.log('[SplitPaneView] handlePaneClick → activate pane', { paneId: props.layout.id, ptyId: props.layout.ptyId })
  terminalStore.setActivePaneInTab(props.tabId, props.layout.id)
}

// ==================== 关闭窗格 ====================

async function handleClosePane(e: Event) {
  e.stopPropagation()
  await terminalStore.closePane(props.tabId, props.layout.id)
}

// 右键菜单由 Terminal 组件统一接管（含分屏选项与快捷键标注）；
// SplitPaneView 不再弹自己的菜单，避免分屏后两套菜单叠加。

// ==================== 分割线拖拽 ====================

const isResizing = ref(false)
const resizingIndex = ref(-1)
let resizeStartCoord = 0
let resizeStartSizes: [number, number] = [50, 50]
let resizeContainerSize = 0

function startResize(index: number, e: MouseEvent) {
  if (!containerRef.value) return
  if (!props.layout.children || index < 0 || index >= props.layout.children.length - 1) return

  const left = props.layout.children[index]
  const right = props.layout.children[index + 1]
  resizeStartSizes = [left.size ?? 50, right.size ?? 50]

  const rect = containerRef.value.getBoundingClientRect()
  if (direction.value === 'horizontal') {
    resizeStartCoord = e.clientX
    resizeContainerSize = rect.width
  } else {
    resizeStartCoord = e.clientY
    resizeContainerSize = rect.height
  }
  if (resizeContainerSize <= 0) return

  isResizing.value = true
  resizingIndex.value = index

  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = direction.value === 'horizontal' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
  e.preventDefault()
}

function handleResize(e: MouseEvent) {
  if (!isResizing.value || resizingIndex.value < 0 || !props.layout.children) return
  if (resizeContainerSize <= 0) return

  const cur = direction.value === 'horizontal' ? e.clientX : e.clientY
  const delta = cur - resizeStartCoord

  // size 是 flex-grow 比例，相邻两窗格之和近似当前两窗格占据的总份额
  const total = resizeStartSizes[0] + resizeStartSizes[1]
  const deltaPct = (delta / resizeContainerSize) * total

  let leftSize = resizeStartSizes[0] + deltaPct
  let rightSize = resizeStartSizes[1] - deltaPct

  // 各自最小 10，最大 90，溢出归还到对侧
  const min = 10
  if (leftSize < min) {
    rightSize -= (min - leftSize)
    leftSize = min
  }
  if (rightSize < min) {
    leftSize -= (min - rightSize)
    rightSize = min
  }

  const left = props.layout.children[resizingIndex.value]
  const right = props.layout.children[resizingIndex.value + 1]
  terminalStore.updatePaneSize(props.tabId, left.id, leftSize)
  terminalStore.updatePaneSize(props.tabId, right.id, rightSize)
}

function stopResize() {
  isResizing.value = false
  resizingIndex.value = -1

  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
})

// ==================== 四边落点 ====================

const dropEdge = ref<PaneEdge | null>(null)

const canShowDropZones = computed(() => {
  if (!props.enableLayoutDrag || !isTerminal.value) return false
  const drag = terminalStore.layoutDrag
  if (!drag) return false
  if (drag.kind === 'pane') {
    if (drag.tabId !== props.tabId) return false
    if (drag.paneId === props.layout.id) return false
  }
  return true
})

/** 四边各占四成，中间只留约两成空着，别大半扇都松手没反应 */
const DROP_EDGE_RATIO = 0.4

function hitTestEdge(e: DragEvent, el: HTMLElement): PaneEdge | null {
  const rect = el.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const bandX = Math.max(24, rect.width * DROP_EDGE_RATIO)
  const bandY = Math.max(24, rect.height * DROP_EDGE_RATIO)
  const hits: { edge: PaneEdge; dist: number }[] = []
  if (x <= bandX) hits.push({ edge: 'left', dist: x })
  if (rect.width - x <= bandX) hits.push({ edge: 'right', dist: rect.width - x })
  if (y <= bandY) hits.push({ edge: 'top', dist: y })
  if (rect.height - y <= bandY) hits.push({ edge: 'bottom', dist: rect.height - y })
  if (hits.length === 0) return null
  return hits.reduce((a, b) => (a.dist <= b.dist ? a : b)).edge
}

function handleLayoutDragOver(e: DragEvent) {
  if (!canShowDropZones.value || !containerRef.value) return
  const edge = hitTestEdge(e, containerRef.value)
  dropEdge.value = edge
  if (!edge) return
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = terminalStore.layoutDrag?.kind === 'pane' ? 'move' : 'copy'
  }
}

function handleLayoutDragLeave(e: DragEvent) {
  const next = e.relatedTarget as Node | null
  if (next && containerRef.value?.contains(next)) return
  dropEdge.value = null
}

function readDropDrag(e: DragEvent): LayoutDrag | null {
  if (terminalStore.layoutDrag) return terminalStore.layoutDrag
  const dt = e.dataTransfer
  if (!dt) return null
  const types = [...(dt.types || [])]
  if (types.includes('application/x-session')) {
    const sessionId = dt.getData('text/plain')
    if (sessionId) return { kind: 'ssh-session', sessionId }
  }
  const text = dt.getData('text/plain')
  if (text === 'new-local') return { kind: 'new-local' }
  if (text) return { kind: 'pane', tabId: props.tabId, paneId: text }
  return null
}

async function handleLayoutDrop(e: DragEvent) {
  const resolvedEdge = dropEdge.value
    ?? (containerRef.value ? hitTestEdge(e, containerRef.value) : null)
  dropEdge.value = null
  if (!resolvedEdge) return
  e.preventDefault()
  e.stopPropagation()

  const drag = readDropDrag(e)
  terminalStore.endLayoutDrag()
  if (!drag) return

  if (drag.kind === 'pane') {
    terminalStore.movePaneInTab(props.tabId, drag.paneId, props.layout.id, resolvedEdge)
    return
  }
  if (drag.kind === 'new-local') {
    const opened = await terminalStore.splitAtEdge(props.tabId, props.layout.id, resolvedEdge, { kind: 'local' })
    if (!opened) {
      const err = terminalStore.getLastSplitError()
      if (err) console.warn('[SplitPaneView] splitAtEdge local failed:', err)
    }
    return
  }
  if (drag.kind === 'ssh-session') {
    terminalStore.requestSshSplitAtEdge({
      sessionId: drag.sessionId,
      tabId: props.tabId,
      paneId: props.layout.id,
      edge: resolvedEdge
    })
  }
}

function handlePaneDragStart(e: DragEvent) {
  if (!props.enableLayoutDrag || isSinglePane.value || !props.layout.id) return
  terminalStore.beginLayoutDrag({
    kind: 'pane',
    tabId: props.tabId,
    paneId: props.layout.id
  })
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', props.layout.id)
  }
}

function handlePaneDragEnd() {
  dropEdge.value = null
  setTimeout(() => terminalStore.endLayoutDrag(), 0)
}
</script>

<template>
  <div
    ref="containerRef"
    class="split-pane"
    :class="[direction, { terminal: isTerminal, 'pane-active': isPaneActive }]"
    :style="paneStyle"
    @click="handlePaneClick"
    @dragover="handleLayoutDragOver"
    @dragleave="handleLayoutDragLeave"
    @drop="handleLayoutDrop"
  >
    <!-- 终端窗格：仅渲染占位 div，Terminal 由 TerminalTabView 通过 Teleport 投入 -->
    <template v-if="isTerminal">
      <div
        v-if="showConnectionLabel"
        class="pane-connection-label"
        :class="{ 'is-handle': enableLayoutDrag }"
        :title="enableLayoutDrag ? t('terminal.split.dragToRearrange') : connectionName"
        :draggable="enableLayoutDrag ? 'true' : 'false'"
        @dragstart.stop="handlePaneDragStart"
        @dragend="handlePaneDragEnd"
      >{{ connectionName }}</div>
      <div
        v-if="canShowDropZones"
        class="pane-drop-catcher"
        @dragover="handleLayoutDragOver"
        @dragleave="handleLayoutDragLeave"
        @drop="handleLayoutDrop"
      />
      <div
        v-if="canShowDropZones && dropEdge"
        class="pane-drop-edge"
        :class="dropEdge"
      />
      <button
        v-if="(layout.ptyId || paneConnecting || layout.connectionError) && !isSinglePane"
        class="pane-close-btn"
        :title="t('common.close')"
        @click="handleClosePane"
      >
        <X :size="14" />
      </button>
      <div
        v-if="paneConnecting"
        class="pane-status pane-connecting"
      >
        <div class="loading-spinner"></div>
        <span>{{ t('terminal.connecting') }}</span>
        <button
          class="btn btn-sm"
          @click="handleClosePane"
        >{{ t('terminal.cancelConnect') }}</button>
      </div>
      <div
        v-else-if="layout.connectionError"
        class="pane-status pane-error"
      >
        <AlertCircle :size="32" />
        <span class="error-title">{{ t('terminal.connectionFailed') }}</span>
        <span class="error-detail">{{ layout.connectionError }}</span>
        <button
          v-if="layout.terminalType === 'ssh' && layout.ptyId"
          class="btn btn-sm"
          @click.stop="retryPaneConnect"
        >{{ t('terminal.reconnect') }}</button>
      </div>
      <div
        v-else-if="paneReadyForTerminal"
        ref="slotElRef"
        class="pane-slot"
      ></div>
    </template>

    <!-- 分割容器（递归渲染子窗格）-->
    <template v-else-if="isSplit">
      <template v-for="(child, index) in children" :key="child.id">
        <SplitPaneView
          :tab-id="tabId"
          :layout="child"
          :is-active="isActive"
          :enable-layout-drag="enableLayoutDrag"
        />
        <div
          v-if="index < children.length - 1"
          class="split-handle"
          :class="[direction, { resizing: isResizing && resizingIndex === index }]"
          @mousedown="startResize(index, $event)"
        ></div>
      </template>
    </template>

  </div>
</template>

<style scoped>
.split-pane {
  display: flex;
  position: relative;
  overflow: hidden;
}

.split-pane.horizontal {
  flex-direction: row;
}

.split-pane.vertical {
  flex-direction: column;
}

.split-pane.terminal {
  min-width: 200px;
  min-height: 100px;
}

/* 占位 div：撑满 .split-pane.terminal，作为 Teleport 的目标
   Terminal 组件被 TerminalTabView 顶层 Teleport 投入这里 */
.pane-slot {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 激活窗格视觉高亮 */
.split-pane.terminal.pane-active::before {
  content: '';
  position: absolute;
  inset: 0;
  border: 2px solid var(--accent-primary, #4299e1);
  pointer-events: none;
  z-index: 5;
  border-radius: 2px;
  box-sizing: border-box;
}

/* 连接名标签：浮在终端内容之上（不占布局高度，不挤掉终端一行）。
   平时半透明，底下的字还能看见；鼠标进入这一格才变成实心。
   用文字色作底、背景色作字，避免和窗格底色混成一块。
   点击穿透到终端，以免挡住点选；拖拽分屏时才自己接收鼠标。 */
.pane-connection-label {
  position: absolute;
  top: 4px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70%;
  padding: 1px 8px;
  border-radius: 4px;
  background: var(--text-primary);
  color: var(--bg-primary);
  font-size: 11px;
  font-weight: 500;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  opacity: 0.45;
  transition: opacity 0.15s ease;
  z-index: 6;
}

.split-pane.terminal:hover .pane-connection-label {
  opacity: 1;
}

.pane-connection-label.is-handle {
  pointer-events: auto;
  cursor: grab;
}

.pane-connection-label.is-handle:active {
  cursor: grabbing;
}

.pane-drop-catcher {
  position: absolute;
  inset: 0;
  z-index: 7;
}

.pane-drop-edge {
  position: absolute;
  background: var(--accent-primary, #4299e1);
  opacity: 0.32;
  pointer-events: none;
  z-index: 8;
}

.pane-drop-edge.left {
  left: 0;
  top: 0;
  bottom: 0;
  width: 40%;
}

.pane-drop-edge.right {
  right: 0;
  top: 0;
  bottom: 0;
  width: 40%;
}

.pane-drop-edge.top {
  left: 0;
  right: 0;
  top: 0;
  height: 40%;
}

.pane-drop-edge.bottom {
  left: 0;
  right: 0;
  bottom: 0;
  height: 40%;
}

/* 关闭按钮（默认隐藏，hover 时显示）*/
.pane-close-btn {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  color: rgba(255, 255, 255, 0.85);
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease;
  z-index: 6;
}

.split-pane.terminal:hover .pane-close-btn {
  opacity: 1;
}

.pane-close-btn:hover {
  background: var(--accent-error, #e53e3e);
  color: #fff;
}

/* 分割线 */
.split-handle {
  flex-shrink: 0;
  background: var(--border-color, #404040);
  position: relative;
  z-index: 10;
  transition: background 0.15s ease;
}

.split-handle.horizontal {
  width: 4px;
  cursor: col-resize;
}

.split-handle.vertical {
  height: 4px;
  cursor: row-resize;
}

.split-handle:hover,
.split-handle.resizing {
  background: var(--accent-primary, #4299e1);
}

.pane-status {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 16px;
  color: var(--text-muted);
  z-index: 3;
}

.pane-status .loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--bg-surface);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: pane-spin 1s linear infinite;
}

@keyframes pane-spin {
  to { transform: rotate(360deg); }
}

.pane-error svg {
  color: var(--accent-error);
  opacity: 0.8;
}

.pane-error .error-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.pane-error .error-detail {
  font-size: 12px;
  color: var(--text-secondary);
  max-width: 360px;
  text-align: center;
  line-height: 1.5;
  padding: 8px 12px;
  background: var(--bg-surface);
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  word-break: break-word;
}

</style>
