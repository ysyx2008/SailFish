<script setup lang="ts">
import type { Component } from 'vue'
import HoverTipOverlay from './HoverTipOverlay.vue'
import { useHoverTip } from '../composables/useHoverTip'

/**
 * 侧栏行首的来历小图标（终端 / 联络派的）。
 *
 * 说明鼠标一放上去就弹出：Electron 里浏览器自带的悬停提示不可靠，
 * 图标又只有十来个像素，用户多半以为没有说明。可悬停的范围比图形本身大一圈。
 * 图标贴着窗口左缘，说明从图标左端起放在下方；较长的主机名换行显示。
 */
const props = defineProps<{
  icon: Component
  hint: string
}>()

const { hoverTip, showTip, hideTip } = useHoverTip({ placement: 'bottom-start', delayMs: 0, wrap: true })
</script>

<template>
  <!-- title="" 让浏览器自带提示在图标上不出现，免得冒出整行标题的第二个提示 -->
  <span
    class="origin-mark"
    title=""
    role="img"
    :aria-label="props.hint"
    @mouseenter="showTip($event, props.hint)"
    @mouseleave="hideTip"
    @mousedown="hideTip"
  >
    <component :is="props.icon" :size="11" :stroke-width="2" />
    <HoverTipOverlay :tip="hoverTip" />
  </span>
</template>

<style scoped>
/* 图标压低对比度，只在需要辨认时才被注意到；留白放大可悬停的范围，用负边距抵掉，不改行内排版 */
.origin-mark {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 6px 5px;
  margin: -6px -5px;
  color: var(--text-muted);
  opacity: 0.75;
}
</style>
