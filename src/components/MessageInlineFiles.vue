<script setup lang="ts">
/**
 * 已发出的消息：文字里夹着文件胶囊（与输入框里的位置一致）。
 * 点胶囊打开文件，右键由外层处理；文件夹没有有意义的大小，不显示。
 */
import AttachmentFileIcon from './AttachmentFileIcon.vue'
import HoverTipOverlay from './HoverTipOverlay.vue'
import { BUTTON_HOVER_TIP_DELAY_MS, useHoverTip } from '../composables/useHoverTip'
import type { AttachmentInfo } from '@shared/types'
import type { InlineSegment } from '../composables/message-attachment-inline'

defineProps<{
  segments: InlineSegment<AttachmentInfo>[]
  formatFileSize: (size: number) => string
}>()

const emit = defineEmits<{
  open: [file: AttachmentInfo]
  contextmenu: [event: MouseEvent, file: AttachmentInfo]
}>()

// 文件名在胶囊里可能被截断；Electron 下原生 title 不可靠，沿用项目里的悬浮提示。
// 消息常贴着窗口上沿，提示往下开，不被裁掉
const { hoverTip, showTip, hideTip } = useHoverTip({
  placement: 'bottom',
  delayMs: BUTTON_HOVER_TIP_DELAY_MS,
  wrap: true,
})
</script>

<template>
  <span class="inline-files-text">
    <template v-for="(seg, i) in segments" :key="i">
      <template v-if="seg.type === 'text'">{{ seg.text }}</template>
      <span
        v-else
        class="inline-file-chip"
        :class="{ clickable: !!seg.file.filePath }"
        role="button"
        tabindex="0"
        @click="hideTip(); emit('open', seg.file)"
        @keydown.enter.prevent="emit('open', seg.file)"
        @keydown.space.prevent="emit('open', seg.file)"
        @mouseenter="showTip($event, seg.file.filePath || seg.file.filename)"
        @mouseleave="hideTip"
        @contextmenu="hideTip(); emit('contextmenu', $event, seg.file)"
      >
        <AttachmentFileIcon :file-type="seg.file.fileType" :filename="seg.file.filename" :file-path="seg.file.filePath" :size="14" />
        <span class="inline-file-name">{{ seg.file.filename }}</span>
        <span v-if="seg.file.fileType !== 'folder'" class="inline-file-size">{{ formatFileSize(seg.file.fileSize) }}</span>
      </span>
    </template>
    <HoverTipOverlay :tip="hoverTip" />
  </span>
</template>

<style scoped>
.inline-files-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.inline-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  margin: 1px 2px;
  padding: 1px 8px;
  vertical-align: middle;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-surface, var(--bg-secondary));
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  user-select: none;
}

.inline-file-chip.clickable {
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.inline-file-chip.clickable:hover {
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-hover, var(--bg-secondary)));
  border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-color));
}

.inline-file-chip.clickable:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 1px;
}

.inline-file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
}

.inline-file-size {
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
}
</style>
