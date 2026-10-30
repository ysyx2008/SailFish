<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert, Network, ChevronDown } from 'lucide-vue-next'
import type { AgentStep } from '@shared/types'
import { buildOrgTree, describeOrgDock } from '../utils/organization-view'
import { teamCards, teamSources, teamMemberSnapshots } from '../utils/team-view'
import { provideTeamViewport } from './Organization/team-viewport'
import { useTeamSnapshot } from './Organization/team-snapshot'
import TeamMemberTree from './Organization/TeamMemberTree.vue'

const props = defineProps<{ steps: readonly AgentStep[]; teamSteps?: readonly AgentStep[]; sessionId?: string; attached?: boolean }>()
const emit = defineEmits<{ openOrganization: [stepId: string, member?: string] }>()
const { t } = useI18n()
const root = ref<HTMLElement | null>(null)
const opened = ref<string | null>(null)
const items = computed(() => {
  const sources = props.teamSteps ?? props.steps
  return [...teamCards(sources, props.sessionId)]
    .filter(([id]) => teamSources(sources, id, props.sessionId).some(source => props.steps.some(step => step.id === source.id)))
    .map(([id, org]) => ({ id, ...describeOrgDock(t, org), org }))
})
const selected = computed(() => items.value.find(item => item.id === opened.value))
const snapshots = computed(() => selected.value ? teamMemberSnapshots(props.teamSteps ?? props.steps, selected.value.id, props.sessionId) : undefined)
const snapshotFor = (name: string) => snapshots.value?.get(name)
const listSnapshot = useTeamSnapshot(() => selected.value?.org, () => opened.value)
provideTeamViewport(computed(() => (listSnapshot.value?.total ?? 0) > 200))
const tree = computed(() => listSnapshot.value ? buildOrgTree(listSnapshot.value) : [])
watch(items, () => { if (!selected.value) opened.value = null })
function open(stepId: string, member?: string) {
  opened.value = null
  emit('openOrganization', stepId, member)
}
function onPointer(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) opened.value = null
}
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !opened.value || !root.value?.getClientRects().length) return
  event.preventDefault()
  event.stopPropagation()
  root.value?.querySelector<HTMLButtonElement>('.dock-toggle[aria-expanded="true"]')?.focus()
  opened.value = null
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('keydown', onKey, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointer, true)
  document.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <div v-if="items.length" ref="root" class="sub-agent-dock" :class="{ attached }">
    <div v-for="item in items" :key="item.id" class="dock-row">
      <div class="dock-bar" :class="[item.kind, { open: opened === item.id }]">
        <button type="button" class="dock-toggle" :aria-expanded="opened === item.id" @click="opened = opened === item.id ? null : item.id">
          <span class="dock-icon"><span v-if="item.kind === 'working'" class="dock-spinner" /><Check v-else-if="item.kind === 'done'" :size="13" /><TriangleAlert v-else :size="13" /></span>
          <span class="dock-headline">{{ item.headline }}</span>
          <ChevronDown :size="13" class="dock-chevron" :class="{ open: opened === item.id }" />
        </button>
        <button type="button" class="dock-team" @click="open(item.id)"><Network :size="12" /><span>{{ t('ai.organization.openChart') }}</span></button>
      </div>
    </div>
    <div v-if="selected" class="dock-panel">
      <TeamMemberTree :groups="tree" :step-id="selected.id" :session-id="listSnapshot?.sessionId" :snapshot-for="snapshotFor" @open="open(selected.id, $event)" />
    </div>
  </div>
</template>

<style scoped>
.sub-agent-dock {
  position: relative;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 9;
}

/* 在计划卡下面：和计划卡合成一块（计划卡的底边线交给这一块），与计划卡之间留出和左右一样的空隙 */
.sub-agent-dock.attached {
  padding-top: 0;
}

.dock-row {
  min-width: 0;
}

.dock-bar {
  width: 100%;
  font: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  padding: 0 4px 0 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s ease;
}


.dock-bar:hover,
.dock-bar.open,
.dock-bar:focus-within {
  background: var(--bg-tertiary);
  outline: none;
}

.dock-toggle { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; height: 100%; padding: 0 7px 0 9px; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.dock-toggle:focus-visible, .dock-team:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; border-radius: 6px; }

.dock-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
}

.dock-bar.working .dock-icon {
  color: var(--color-info);
}

.dock-bar.done .dock-icon {
  color: var(--color-success);
}

.dock-bar.problem .dock-icon {
  color: var(--color-warning);
}

.dock-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(var(--color-info-rgb), 0.2);
  border-top-color: var(--color-info);
  border-radius: 50%;
  animation: dock-spin 1s linear infinite;
}

@keyframes dock-spin {
  to { transform: rotate(360deg); }
}

.dock-headline {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.dock-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.dock-chevron.open {
  transform: rotate(180deg);
}

/* 全景入口独立于名单展开按钮 */
.dock-team {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--accent-primary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.dock-team:hover {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
}

.dock-team.active {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.2);
}

/* 展开的内容盖在对话上面（栏的下沿开始），不把对话往下挤，也不盖住栏里别的行 */
.dock-panel {
  position: absolute;
  left: 12px;
  right: 12px;
  top: calc(100% + 4px);
  max-height: min(60vh, 520px);
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 20;
}
</style>
