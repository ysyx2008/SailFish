<script setup lang="ts">
/**
 * WorkbenchShell —— 工作台通用布局外壳
 *
 * 负责「常驻锚点区 + 可显隐辅助区 + 可拖分隔条」这一固定布局模板，
 * 不认识具体内容（终端/聊天/文档），内容通过具名 slot 注入：
 *   - #anchor：常驻锚点区
 *   - #toggle：可显隐辅助区
 *
 * 行为对齐原 App.vue 的 assistant-split 实现（拖拽比例、过渡、热区均一致）。
 * 终端工作台因有 Terminal Teleport 保命池而走自定义渲染器逃生口，不使用本组件。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** 辅助区是否可见 */
  toggleVisible: boolean
  /** 辅助区占比（0-1） */
  toggleRatio: number
  /** 辅助区是否处于收起态（固定窄宽，不可拖拽） */
  toggleCollapsed?: boolean
  /** 收起态宽度（px） */
  collapsedWidth?: number
  /** 辅助区所在侧，默认右侧 */
  toggleSide?: 'left' | 'right'
  /** 拖拽比例下限 */
  minRatio?: number
  /** 拖拽比例上限 */
  maxRatio?: number
}>(), {
  toggleSide: 'right',
  toggleCollapsed: false,
  collapsedWidth: 40,
  minRatio: 0.2,
  maxRatio: 0.8,
})

const emit = defineEmits<{
  (e: 'update:toggleRatio', ratio: number): void
}>()

const shellRef = ref<HTMLElement | null>(null)
const isResizing = ref(false)
/** 仅开合时开过渡，避免拖宽/侧栏改宽时宽度动画跟手 */
const isAnimating = ref(false)
/** 辅助区展开时的像素宽：内容按这个宽度定住，开合时被裁而不是挤扁 */
const regionWidthPx = ref(0)

// 当前拖拽的清理函数
let activeCleanup: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let animTimer: ReturnType<typeof setTimeout> | null = null
let lastWindowInnerWidth = 0

const REGION_ANIM_MS = 400

function startRegionAnimation() {
  isAnimating.value = true
  if (animTimer) clearTimeout(animTimer)
  animTimer = setTimeout(() => {
    isAnimating.value = false
    animTimer = null
  }, REGION_ANIM_MS)
}

function syncRegionWidth() {
  const el = shellRef.value
  if (!el) return
  const w = el.getBoundingClientRect().width
  if (w <= 0) return
  const next = Math.round(w * props.toggleRatio)
  if (next === regionWidthPx.value) return
  regionWidthPx.value = next
}

/**
 * 用 Pointer Events + setPointerCapture 拖拽。
 * 产出物区常有 sandbox iframe（HTML/PPT），若只靠 document mouseup，
 * 指针滑入 iframe 后释放事件进子文档，父页面永远收不到 → 光标/拖拽卡住。
 */
function startResize(e: PointerEvent) {
  if (!props.toggleVisible || props.toggleCollapsed) return
  if (e.button !== 0) return
  e.preventDefault()

  const handle = e.currentTarget as HTMLElement
  const startX = e.clientX
  const container = shellRef.value
  if (!container) return
  const containerWidth = container.getBoundingClientRect().width
  if (containerWidth <= 0) return
  // 历史侧栏开合后，比例可能和眼前的像素宽对不上。以当前看到的宽度为起点，避免一拖就跳。
  const startRatio = regionWidthPx.value > 0
    ? regionWidthPx.value / containerWidth
    : props.toggleRatio

  // 右侧辅助区：分隔条右移（delta>0）应缩小辅助区比例；左侧辅助区方向相反
  const dir = props.toggleSide === 'left' ? -1 : 1
  const pointerId = e.pointerId

  // 若上一次拖拽异常未清理，先收尾
  activeCleanup?.()

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    const delta = ev.clientX - startX
    const newRatio = Math.max(
      props.minRatio,
      Math.min(props.maxRatio, startRatio - dir * delta / containerWidth)
    )
    emit('update:toggleRatio', newRatio)
  }

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    activeCleanup?.()
  }

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') activeCleanup?.()
  }

  const onWindowBlur = () => activeCleanup?.()

  const cleanup = () => {
    if (activeCleanup !== cleanup) return
    activeCleanup = null

    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onUp)
    handle.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('blur', onWindowBlur)
    try {
      if (handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId)
      }
    } catch {
      // capture 已失效时忽略
    }
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    isResizing.value = false
  }
  activeCleanup = cleanup

  isResizing.value = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  handle.setPointerCapture(pointerId)
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onUp)
  handle.addEventListener('pointercancel', onUp)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('blur', onWindowBlur)
}

watch(() => props.toggleRatio, syncRegionWidth)

watch(
  () => [props.toggleVisible, props.toggleCollapsed] as const,
  (next, prev) => {
    if (next[0] === prev[0] && next[1] === prev[1]) return
    startRegionAnimation()
  }
)

onMounted(() => {
  lastWindowInnerWidth = window.innerWidth
  syncRegionWidth()
  if (shellRef.value) {
    // 窗体缩放：按比例即时跟上。历史侧栏开合（窗体宽度没变）保持当时看到的宽度。
    resizeObserver = new ResizeObserver(() => {
      if (isResizing.value) return
      const windowWidth = window.innerWidth
      const windowResized = windowWidth !== lastWindowInnerWidth
      lastWindowInnerWidth = windowWidth
      if (regionWidthPx.value <= 0 || windowResized) {
        syncRegionWidth()
      }
    })
    resizeObserver.observe(shellRef.value)
  }
})

onUnmounted(() => {
  if (animTimer) clearTimeout(animTimer)
  resizeObserver?.disconnect()
  resizeObserver = null
  activeCleanup?.()
})

defineExpose({
  /** 宿主区域改宽而窗口未改宽时，按当前比例重新测量。 */
  refreshLayout: syncRegionWidth,
  /** 返回是否消费了当前拖动，供宿主的分层关闭快捷键优先处理。 */
  cancelResize: () => {
    const active = isResizing.value
    activeCleanup?.()
    return active
  },
})
</script>

<template>
  <div
    ref="shellRef"
    class="workbench-shell"
    :class="[`toggle-${toggleSide}`, { 'is-resizing': isResizing, 'is-animating': isAnimating }]"
    :style="{
      '--workbench-collapsed-width': `${collapsedWidth}px`,
      '--workbench-region-width': `${regionWidthPx}px`,
    }"
  >
    <div
      class="workbench-anchor"
    >
      <slot name="anchor" />
    </div>
    <div
      class="workbench-divider"
      :class="{ 'is-disabled': !toggleVisible || toggleCollapsed }"
      @pointerdown="startResize"
    ></div>
    <div
      class="workbench-region"
      :class="{
        'region-open': toggleVisible && !toggleCollapsed,
        'region-collapsed': toggleVisible && toggleCollapsed
      }"
      :inert="toggleVisible && !toggleCollapsed ? undefined : true"
    >
      <div class="workbench-region-inner">
        <slot name="toggle" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.workbench-shell {
  display: flex;
  flex-direction: row;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* AiPanel system-info-bar 与 ArtifactPanel canvas-header 共用，保证分屏顶栏底边对齐 */
  --workbench-panel-header-height: 38px;
  /* 顶栏内 model-select / 产出物文件选择触发器共用（native select 视觉略大于纯 11px 文本） */
  --workbench-header-select-font-size: 12px;
  --workbench-header-select-height: 22px;
}

/* 左侧辅助区：反转主轴，让 DOM 顺序 anchor→divider→region 在视觉上变成 region→divider→anchor */
.workbench-shell.toggle-left {
  flex-direction: row-reverse;
}

.workbench-anchor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 300px;
  overflow: hidden;
}

.workbench-divider {
  flex-shrink: 0;
  width: 0;
  position: relative;
  z-index: 2;
  cursor: col-resize;
  touch-action: none;
}

/* 零宽占位，::before 提供 5px 拖拽热区，不占视觉间隙 */
.workbench-divider::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -2px;
  width: 5px;
  background: transparent;
  transition: background 0.25s ease;
}

.workbench-divider.is-disabled {
  pointer-events: none;
}

.workbench-divider:hover::before,
.workbench-shell.is-resizing .workbench-divider::before {
  background: linear-gradient(
    180deg,
    transparent,
    rgba(var(--accent-rgb, 137, 180, 250), 0.35),
    transparent
  );
}

/* 拖拽时屏蔽两侧指针，防止 HTML/PPT iframe 再吞事件（与 capture 双保险） */
.workbench-shell.is-resizing .workbench-anchor,
.workbench-shell.is-resizing .workbench-region {
  pointer-events: none;
}

.workbench-region {
  display: flex;
  flex-direction: column;
  align-self: stretch;
  flex: 0 0 auto;
  width: 0;
  min-width: 0;
  max-width: 0;
  min-height: 0;
  overflow: hidden;
}

.workbench-shell.is-animating .workbench-region {
  /* 与历史侧栏同一套抽屉推拉：宽度收、内容被裁，不整块淡出 */
  transition: width var(--shell-drawer-duration, 0.36s) var(--shell-drawer-ease, cubic-bezier(0.16, 1, 0.3, 1));
}

.workbench-region.region-open {
  width: var(--workbench-region-width, 0px);
  max-width: none;
}

.workbench-region.region-collapsed {
  width: var(--workbench-collapsed-width, 40px);
  max-width: none;
}

.workbench-region-inner {
  display: flex;
  flex-direction: column;
  width: var(--workbench-region-width, 0px);
  min-width: var(--workbench-region-width, 0px);
  height: 100%;
  min-height: 0;
}

.workbench-shell.is-resizing .workbench-region {
  transition: none;
}
</style>

<style>
/* 顶栏模型选择与产出物文件名：同一套 metrics（scoped 子组件无法互引） */
.workbench-shell select.model-select.model-select-sm,
.workbench-shell .artifact-file-select {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  height: var(--workbench-header-select-height, 22px);
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  background-color: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: var(--workbench-header-select-font-size, 12px);
  font-weight: inherit;
  line-height: 1.25;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.workbench-shell select.model-select.model-select-sm {
  max-width: 140px;
  cursor: pointer;
  /* 去掉 macOS 原生 menulist 放大，使 CSS 字号与自定义按钮一致 */
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23888888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 2px center;
  background-size: 12px;
  padding-right: 18px;
}

.workbench-shell select.model-select.model-select-sm:hover {
  background-color: var(--bg-surface);
  color: var(--text-primary);
}

.workbench-shell .artifact-file-select {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: min(240px, 100%);
  min-width: 0;
  cursor: default;
  text-align: left;
}

.workbench-shell .artifact-file-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
  font-size: inherit;
  line-height: inherit;
}

/* 与 AiPanel system-info-bar 内 btn-icon-sm 一致（仅图标按钮，不含文字按钮） */
.workbench-shell button.btn-icon.btn-icon-sm {
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

.workbench-shell button.btn-icon.btn-icon-sm:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}
</style>
