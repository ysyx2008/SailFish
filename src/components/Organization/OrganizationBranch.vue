<script setup lang="ts">
/** 横向管理树：小组只作同列分组，不增加管理节点。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Minus, Plus, Scan } from 'lucide-vue-next'
import type { OrgGroup } from '../../utils/organization-view'
import { layoutOrganization, visibleOrgLines, type OrgViewport } from '../../utils/organization-layout'
import OrganizationNode from './OrganizationNode.vue'
import OrganizationTeamHeader from './OrganizationTeamHeader.vue'
const props = defineProps<{ groups: readonly OrgGroup[]; selected?: string | null }>()
const emit = defineEmits<{ openMember: [name: string]; openTeam: [team: { name: string; owner?: string }]; openArtifacts: [team: { name: string; owner?: string }] }>()
const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const width = ref(1000)
const zoom = ref(1)
const height = ref(800)
const viewport = ref<OrgViewport>({ left: 0, top: 0, right: 1200, bottom: 900 })
const layout = computed(() => layoutOrganization(props.groups, width.value))
const fitZoom = computed(() => Math.min(1, Math.max(1, width.value - 16) / Math.max(1, layout.value.width), height.value / Math.max(1, layout.value.height)))
const minZoom = computed(() => Math.min(0.1, fitZoom.value))
const lines = computed(() => visibleOrgLines(layout.value.lines, viewport.value))
let scroller: HTMLElement | null = null
let observer: ResizeObserver | undefined
let frame = 0
function updateViewport() {
  if (!scroller || !root.value) return
  const scrollBox = scroller.getBoundingClientRect(), mapBox = root.value.getBoundingClientRect(), scale = zoom.value
  width.value = Math.max(1, scroller.clientWidth - 32)
  height.value = Math.max(1, scroller.clientHeight - 60)
  viewport.value = {
    left: (scrollBox.left - mapBox.left - 8) / scale - 300,
    top: (scrollBox.top - mapBox.top - 8) / scale - 300,
    right: (scrollBox.right - mapBox.left - 8) / scale + 300,
    bottom: (scrollBox.bottom - mapBox.top - 8) / scale + 300,
  }
}
function scheduleViewport() {
  if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateViewport() })
}
function setZoom(value: number) {
  if (!scroller) return
  const before = zoom.value, next = Math.max(minZoom.value, Math.min(1.5, value))
  const x = (scroller.scrollLeft + scroller.clientWidth / 2) / before, y = (scroller.scrollTop + scroller.clientHeight / 2) / before
  zoom.value = next
  void nextTick(() => {
    if (!scroller) return
    scroller.scrollLeft = x * next - scroller.clientWidth / 2
    scroller.scrollTop = y * next - scroller.clientHeight / 2
    updateViewport()
  })
}
function fit() {
  if (!scroller) return
  zoom.value = fitZoom.value
  void nextTick(() => { if (scroller) { scroller.scrollLeft = 0; scroller.scrollTop = 0 }; updateViewport() })
}
let drag: { id: number; x: number; y: number; left: number; top: number } | null = null
let moved = false
function startDrag(event: PointerEvent) {
  if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest('.org-node, .org-team, button') || !scroller) return
  moved = false
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop }
}
function moveDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id || !scroller) return
  if (!(event.buttons & 1)) { endDrag(event); return }
  if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 4) { moved = true; scroller.setPointerCapture(event.pointerId); scroller.classList.add('is-panning') }
  if (moved) { scroller.scrollLeft = drag.left - (event.clientX - drag.x); scroller.scrollTop = drag.top - (event.clientY - drag.y); event.preventDefault() }
}
function endDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.id) return
  drag = null
  if (event.type !== 'pointerup') moved = false
  if (scroller?.hasPointerCapture(event.pointerId)) scroller.releasePointerCapture(event.pointerId)
  scroller?.classList.remove('is-panning')
}
function stopDraggedClick(event: MouseEvent) {
  if (moved) { moved = false; event.preventDefault(); event.stopImmediatePropagation() }
}
watch(layout, () => { void nextTick(scheduleViewport) })
onMounted(() => {
  scroller = root.value?.closest<HTMLElement>('.oc-body') ?? null
  if (!scroller) return
  observer = new ResizeObserver(scheduleViewport)
  observer.observe(scroller)
  scroller.addEventListener('scroll', scheduleViewport, { passive: true })
  scroller.addEventListener('pointerdown', startDrag)
  scroller.addEventListener('pointermove', moveDrag)
  scroller.addEventListener('pointerup', endDrag)
  scroller.addEventListener('pointercancel', endDrag)
  scroller.addEventListener('lostpointercapture', endDrag)
  scroller.addEventListener('click', stopDraggedClick, true)
  updateViewport()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  scroller?.classList.remove('is-panning')
  scroller?.removeEventListener('scroll', scheduleViewport)
  scroller?.removeEventListener('pointerdown', startDrag)
  scroller?.removeEventListener('pointermove', moveDrag)
  scroller?.removeEventListener('pointerup', endDrag)
  scroller?.removeEventListener('pointercancel', endDrag)
  scroller?.removeEventListener('lostpointercapture', endDrag)
  scroller?.removeEventListener('click', stopDraggedClick, true)
})
</script>
<template>
  <div ref="root" class="org-map" :style="{ width: layout.width * zoom + 16 + 'px', height: layout.height * zoom + 16 + 'px' }">
    <div class="org-scene" :style="{ width: layout.width + 'px', height: layout.height + 'px', transform: `scale(${zoom})` }">
      <svg class="org-links" :width="layout.width" :height="layout.height" aria-hidden="true">
        <line v-for="(line, index) in lines" :key="index" v-bind="line" />
      </svg>
      <OrganizationTeamHeader v-for="item in layout.teams" :key="item.key" class="org-team-position" :style="{ left: item.x + 'px', top: item.y + 'px', width: item.width + 'px' }"
        :team="item.group.team!" :nodes="item.group.nodes"
        @open-team="emit('openTeam', { name: item.group.team!.name, owner: item.group.team!.owner })"
        @open-artifacts="emit('openArtifacts', { name: item.group.team!.name, owner: item.group.team!.owner })" />
      <OrganizationNode v-for="item in layout.members" :key="item.node.member.id" :node="item.node" :selected="selected === item.node.member.name"
        :data-depth="item.depth" :style="{ left: item.x + 'px', top: item.y + 'px', width: '240px' }" @open="emit('openMember', item.node.member.name)" />
    </div>
  </div>
  <div class="org-map-tools" @click.stop>
    <button type="button" :title="t('ai.organization.zoomOut')" :aria-label="t('ai.organization.zoomOut')" :disabled="zoom <= minZoom" @click="setZoom(zoom - 0.1)"><Minus :size="14" /></button>
    <button type="button" :title="t('ai.organization.resetZoom')" :aria-label="t('ai.organization.resetZoom')" @click="setZoom(1)">{{ Math.round(zoom * 1000) / 10 }}%</button>
    <button type="button" :title="t('ai.organization.zoomIn')" :aria-label="t('ai.organization.zoomIn')" :disabled="zoom >= 1.5" @click="setZoom(zoom + 0.1)"><Plus :size="14" /></button>
    <button type="button" :title="t('ai.organization.fitView')" :aria-label="t('ai.organization.fitView')" @click="fit"><Scan :size="14" /></button>
  </div>
</template>
<style scoped>
.org-map { position: relative; box-sizing: border-box; min-height: 100%; overflow: hidden; }
.org-scene { position: absolute; left: 8px; top: 8px; transform-origin: 0 0; }
.org-scene > .org-node, .org-team-position { position: absolute; }
.org-links { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.org-links line { stroke: var(--org-line, var(--border-color)); stroke-width: 1.3; fill: none; }
.org-map-tools { position: absolute; left: 18px; bottom: 14px; display: flex; gap: 2px; padding: 3px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 7px; z-index: 1; }
.org-map-tools button { display: inline-flex; align-items: center; justify-content: center; height: 26px; min-width: 26px; border: 0; border-radius: 4px; color: var(--text-secondary); background: transparent; font-size: 11px; cursor: pointer; }
.org-map-tools button:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.org-map-tools button:disabled { opacity: .4; cursor: default; }
.org-map-tools button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
</style>
