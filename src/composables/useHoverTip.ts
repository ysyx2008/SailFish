import { onUnmounted, ref } from 'vue'

/** bottom-start：放在下方、左端与锚点对齐——锚点贴着窗口左缘时，居中摆放会伸出窗口 */
export type HoverTipPlacement = 'left' | 'top' | 'bottom' | 'bottom-start'

export interface HoverTipState {
  text: string
  x: number
  y: number
  placement: HoverTipPlacement
  wrap?: boolean
}

export interface HoverTipShowOptions {
  placement?: HoverTipPlacement
  /** 0 = 即时（文件图标）；按钮建议 500–700ms，接近系统 title 延迟 */
  delayMs?: number
  /** 较长说明换行，避免被单行截断 */
  wrap?: boolean
}

export interface UseHoverTipOptions {
  placement?: HoverTipPlacement
  delayMs?: number
  wrap?: boolean
}

function resolveOptions(
  defaults: UseHoverTipOptions,
  override?: HoverTipPlacement | HoverTipShowOptions
): Required<HoverTipShowOptions> {
  if (typeof override === 'string') {
    return { placement: override, delayMs: defaults.delayMs ?? 0, wrap: defaults.wrap ?? false }
  }
  return {
    placement: override?.placement ?? defaults.placement ?? 'left',
    delayMs: override?.delayMs ?? defaults.delayMs ?? 0,
    wrap: override?.wrap ?? defaults.wrap ?? false
  }
}

function computeTipPosition(
  el: HTMLElement,
  placement: HoverTipPlacement
): Pick<HoverTipState, 'x' | 'y' | 'placement'> {
  const rect = el.getBoundingClientRect()
  let x = rect.left - 8
  let y = rect.top + rect.height / 2

  if (placement === 'top') {
    x = rect.left + rect.width / 2
    y = rect.top - 8
  } else if (placement === 'bottom') {
    x = rect.left + rect.width / 2
    y = rect.bottom + 8
  } else if (placement === 'bottom-start') {
    x = rect.left
    y = rect.bottom + 8
  }

  return { x, y, placement }
}

export function useHoverTip(options: UseHoverTipOptions | HoverTipPlacement = 'left') {
  const defaults: UseHoverTipOptions = typeof options === 'string'
    ? { placement: options, delayMs: 0 }
    : options

  const hoverTip = ref<HoverTipState | null>(null)
  let showTimer: ReturnType<typeof setTimeout> | null = null

  function clearShowTimer() {
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
  }

  function showTip(
    e: MouseEvent,
    text: string,
    override?: HoverTipPlacement | HoverTipShowOptions
  ) {
    const el = e.currentTarget as HTMLElement | null
    if (!el) return

    clearShowTimer()
    hoverTip.value = null

    const { placement, delayMs, wrap } = resolveOptions(defaults, override)
    const reveal = () => {
      showTimer = null
      hoverTip.value = { text, wrap, ...computeTipPosition(el, placement) }
    }

    if (delayMs <= 0) {
      reveal()
    } else {
      showTimer = setTimeout(reveal, delayMs)
    }
  }

  function hideTip() {
    clearShowTimer()
    hoverTip.value = null
  }

  onUnmounted(hideTip)

  return { hoverTip, showTip, hideTip }
}

/** 工具栏/图标按钮：延迟显示，避免误触即时弹出 */
export const BUTTON_HOVER_TIP_DELAY_MS = 650
