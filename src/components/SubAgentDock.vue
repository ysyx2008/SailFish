<script lang="ts">
import { reactive } from 'vue'
// 和早期名单一样，关闭浮层后保留“显示更多”的范围；不同来源团队各自记。
const memberPages = reactive(new Map<string, number>())
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert, Network, ChevronDown } from 'lucide-vue-next'
import type { AgentStep } from '@shared/types'
import { describeOrgDock } from '../utils/organization-view'
import { teamCards, teamSources, teamMemberSnapshots } from '../utils/team-view'
import { provideTeamViewport } from './Organization/team-viewport'
import { useTeamSnapshot } from './Organization/team-snapshot'
import TeamMemberTree from './Organization/TeamMemberTree.vue'
import { teamMemberList } from '../utils/team-member-list'
import { SUB_AGENT_PAGE_SIZE } from '../utils/sub-agent-summary'

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
const listKey = computed(() => JSON.stringify([listSnapshot.value?.sessionId ?? props.sessionId, listSnapshot.value?.teamId ?? selected.value?.id]))
const list = computed(() => listSnapshot.value ? teamMemberList(listSnapshot.value, (memberPages.get(listKey.value) ?? 1) * SUB_AGENT_PAGE_SIZE) : { groups: [], shown: 0, hidden: 0, unavailable: 0 })
function showMore() { memberPages.set(listKey.value, (memberPages.get(listKey.value) ?? 1) + 1) }
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
        <button type="button" class="dock-toggle" :aria-expanded="opened === item.id" :title="opened === item.id ? t('ai.subAgentDock.collapse') : t('ai.subAgentDock.expand')" @click="opened = opened === item.id ? null : item.id">
          <span class="dock-icon"><span v-if="item.kind === 'working'" class="dock-spinner" /><Check v-else-if="item.kind === 'done'" :size="13" /><TriangleAlert v-else :size="13" /></span>
          <span class="dock-headline">{{ item.headline }}</span>
          <ChevronDown :size="13" class="dock-chevron" :class="{ open: opened === item.id }" />
        </button>
        <button type="button" class="dock-team" @click="open(item.id)"><Network :size="12" /><span>{{ t('ai.organization.openChart') }}</span></button>
      </div>
      <div v-if="opened === item.id" class="dock-panel">
        <TeamMemberTree :groups="list.groups" :step-id="item.id" :session-id="listSnapshot?.sessionId" :snapshot-for="snapshotFor" @open="open(item.id, $event)" />
        <button v-if="list.hidden > 0" type="button" class="dock-more" @click="showMore">{{ t('ai.subAgentShowMore', { count: Math.min(SUB_AGENT_PAGE_SIZE, list.hidden), rest: list.hidden }) }}</button>
        <p v-if="list.unavailable > 0" class="dock-unavailable">{{ t('ai.organization.listUnavailable', { count: list.unavailable }) }}</p>
      </div>
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
  position: relative;
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

/* 名单紧贴所属团队横幅，浮在下方内容上，不把对话往下挤。 */
.dock-panel {
  position: absolute;
  left: 0;
  right: 0;
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
.dock-unavailable { margin: 6px 10px; color: var(--text-muted); font-size: 11px; }
.dock-more { display: block; margin: 4px 0 0; padding: 4px 10px; font: inherit; font-size: 12px; color: var(--text-secondary); background: transparent; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; cursor: pointer; }
.dock-more:hover { background: rgba(255,255,255,0.04); }
.dock-more:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
</style>
