<script setup lang="ts">
/**
 * 输入框文字里的一枚文件胶囊：图标 + 文件名 + 大小（解析中显示进度）+ ×。
 * 解析中与解析好用同一个外壳，只换文字与进度条，位置和高度不跳。
 * 单击留给编辑器（选中、退格删除）；双击打开、右键菜单交给外层。
 */
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import AttachmentFileIcon from './AttachmentFileIcon.vue'
import HoverTipOverlay from './HoverTipOverlay.vue'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../composables/useHoverTip'
import { CHIP_ACTION_ATTR } from '../composables/composer-chip-node'
import type { ChipDoc, ChipParsingDoc } from '../composables/useComposerAttachmentChips'

type ParsingView = ChipParsingDoc & { status?: string; percent?: number }
type ChipViewModel =
  | { kind: 'doc'; doc: ChipDoc & { fileType: string } }
  | { kind: 'parsing'; doc: ParsingView }

const props = defineProps<{
  view: ChipViewModel | null
  statusLabel: string
  /** 悬停时显示的完整说明（胶囊里的文件名可能被截断） */
  tip: string
  removeTitle: string
}>()

const emit = defineEmits<{
  remove: []
  /** 双击：打开这个文件 */
  open: []
  contextmenu: [event: MouseEvent]
}>()

const isParsing = computed(() => props.view?.kind === 'parsing')
const isFailed = computed(() => {
  const v = props.view
  if (!v) return false
  return v.kind === 'parsing' ? v.doc.status === 'failed' : !!v.doc.error
})
const progress = computed(() => {
  const v = props.view
  if (!v || v.kind !== 'parsing' || v.doc.status === 'failed') return null
  return Math.max(4, Math.min(100, v.doc.percent ?? 0))
})

const actionAttr = { [CHIP_ACTION_ATTR]: '' }

// Electron 下原生 title 不可靠，沿用项目里的悬浮提示
const { hoverTip, showTip, hideTip } = useHoverTip({
  placement: 'top',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS,
  wrap: true,
})
function onHover(e: MouseEvent) {
  if (props.tip) showTip(e, props.tip)
}
function onOpen() {
  hideTip()
  emit('open')
}
function onContextMenu(e: MouseEvent) {
  hideTip()
  emit('contextmenu', e)
}
</script>

<template>
  <span
    v-if="view"
    class="doc-chip"
    :class="{ 'is-parsing': isParsing, 'has-error': isFailed }"
    @mouseenter="onHover"
    @mouseleave="hideTip"
    @dblclick="onOpen"
    @contextmenu="onContextMenu"
  >
    <AttachmentFileIcon
      class="doc-icon"
      :file-type="view.kind === 'doc' ? view.doc.fileType : undefined"
      :filename="view.doc.filename"
      :file-path="view.kind === 'doc' ? view.doc.filePath : undefined"
      :size="14"
    />
    <span class="doc-name">{{ view.doc.filename }}</span>
    <span v-if="statusLabel" class="doc-size">{{ statusLabel }}</span>
    <span v-if="isFailed" class="doc-warn">⚠️</span>
    <button
      type="button"
      class="doc-remove"
      v-bind="actionAttr"
      :title="removeTitle"
      @mousedown.prevent
      @click.stop="hideTip(); emit('remove')"
    >
      <X :size="10" />
    </button>
    <span v-if="progress !== null" class="doc-parse-bar" :style="{ width: progress + '%' }" />
    <HoverTipOverlay :tip="hoverTip" />
  </span>
  <span v-else class="doc-chip is-pending" />
</template>

<style scoped>
.doc-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  height: 20px;
  box-sizing: border-box;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 12px;
  line-height: 1;
  max-width: 220px;
  vertical-align: middle;
  white-space: nowrap;
  overflow: hidden;
}

.doc-chip.is-pending {
  width: 60px;
}

.doc-chip.has-error {
  border-color: rgba(var(--color-error-rgb), 0.5);
  background: rgba(var(--color-error-rgb), 0.05);
}

/* 被退格键选中时的样子由 ComposerEditor 负责（它拥有那层外壳） */

.doc-icon {
  flex-shrink: 0;
}

.doc-name {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}

.doc-size {
  color: var(--text-muted);
  font-size: 10px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.doc-warn {
  flex-shrink: 0;
}

.doc-remove {
  display: inline-flex;
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

.doc-remove:hover {
  opacity: 1;
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.doc-parse-bar {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  background: var(--accent-primary);
  transition: width 0.2s ease;
  pointer-events: none;
}
</style>
