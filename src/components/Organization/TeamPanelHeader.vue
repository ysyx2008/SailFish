<script setup lang="ts">
/** 团队各层面板共用产出物页签式标题栏；导航语义由宿主保留。 */
import { ArrowLeft, X, Maximize2, Minimize2 } from 'lucide-vue-next'
defineProps<{ title: string; closeLabel: string; backLabel?: string; meta?: string; focused?: boolean; hideFocus?: boolean; focusLabel?: string }>()
const emit = defineEmits<{ close: []; back: []; toggleFocus: [] }>()
</script>

<template>
  <header class="team-panel-header" :class="{ 'is-focus': focused }">
    <button v-if="backLabel" type="button" class="tph-icon tph-back" :title="backLabel" :aria-label="backLabel" @click="emit('back')"><ArrowLeft :size="14" /></button>
    <div class="tph-tab">
      <span v-if="$slots.icon" class="tph-title-icon" aria-hidden="true"><slot name="icon" /></span>
      <span class="tph-title" :title="title">{{ title }}</span>
      <button type="button" class="tph-icon tph-close" :title="closeLabel" :aria-label="closeLabel" @click="emit('close')"><X :size="12" /></button>
    </div>
    <span v-if="meta" class="tph-meta" :title="meta">{{ meta }}</span>
    <div class="tph-fill" />
    <div v-if="$slots.actions" class="tph-actions"><slot name="actions" /></div>
    <button v-if="focused !== undefined && !hideFocus" type="button" class="btn-icon btn-icon-header tph-focus" :aria-pressed="focused" :title="focusLabel" :aria-label="focusLabel" @click="emit('toggleFocus')"><Minimize2 v-if="focused" :size="14" /><Maximize2 v-else :size="14" /></button>
  </header>
</template>

<style scoped>
.team-panel-header { display: flex; align-items: center; gap: 12px; box-sizing: border-box; flex-shrink: 0; height: var(--workbench-panel-header-height, 38px); min-height: var(--workbench-panel-header-height, 38px); padding: 0 calc(max(8px, var(--shell-inset-right, 0px)) + 30px) 0 12px; background: var(--bg-tertiary, var(--bg-secondary, #252525)); border-bottom: 1px solid var(--border-color); color: var(--text-primary); user-select: none; -webkit-app-region: drag; }
.team-panel-header.is-focus { padding-left: max(12px, var(--shell-inset-left, 0px)); padding-right: calc(max(8px, var(--shell-inset-right, 0px)) + 36px); }
.tph-tab { display: inline-flex; align-items: center; gap: 7px; box-sizing: border-box; min-width: 0; max-width: 320px; height: 28px; padding: 0 5px 0 9px; border-radius: 8px; background: color-mix(in srgb, var(--text-primary, #eee) 14%, transparent); font-size: 12px; font-weight: 500; line-height: 1.2; -webkit-app-region: no-drag; }
.tph-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tph-title-icon { display: inline-flex; align-items: center; flex-shrink: 0; color: var(--accent-primary); }
.tph-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 11px; }
.tph-fill { flex: 1 1 auto; min-width: 0; align-self: stretch; }
.tph-icon { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; width: 22px; height: 22px; flex-shrink: 0; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--text-secondary); cursor: pointer; -webkit-app-region: no-drag; }
.tph-icon:hover { background: var(--bg-hover, rgba(255,255,255,.08)); color: var(--text-primary); }
.tph-icon:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
.tph-close { width: 18px; height: 18px; border-radius: 6px; color: inherit; }
.tph-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; -webkit-app-region: no-drag; }
</style>
