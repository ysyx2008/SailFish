<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, TriangleAlert, Network } from 'lucide-vue-next'
import type { AgentStep } from '@shared/types'
import { describeOrgDock } from '../utils/organization-view'
import { teamCards, teamSources } from '../utils/team-view'

const props = defineProps<{ steps: readonly AgentStep[]; teamSteps?: readonly AgentStep[]; attached?: boolean; openTeamStepId?: string | null; organizationStep?: AgentStep }>()
const emit = defineEmits<{ openTeam: [stepId: string]; toggleTeam: [stepId: string]; openOrganization: [stepId: string] }>()
const { t } = useI18n()
const items = computed(() => {
  const sources = props.teamSteps ?? props.steps
  return [...teamCards(sources)]
    .filter(([id]) => teamSources(sources, id).some(source => props.steps.some(step => step.id === source.id)))
    .map(([id, org]) => ({ id, ...describeOrgDock(t, org) }))
})
</script>

<template>
  <div v-if="items.length" class="sub-agent-dock" :class="{ attached }">
    <div v-for="item in items" :key="item.id" class="dock-row">
      <button type="button" class="dock-bar" :class="item.kind" @click="emit('openOrganization', item.id)">
        <span class="dock-icon"><span v-if="item.kind === 'working'" class="dock-spinner" /><Check v-else-if="item.kind === 'done'" :size="13" /><TriangleAlert v-else :size="13" /></span>
        <span class="dock-headline">{{ item.headline }}</span>
        <span class="dock-team"><Network :size="12" /><span>{{ t('ai.organization.openChart') }}</span></span>
      </button>
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
}

.dock-bar {
  width: 100%;
  font: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px 0 9px;
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
.dock-bar:focus-visible {
  background: var(--bg-tertiary);
  outline: none;
}

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

/* 群聊：行尾一个小按钮，开着时亮着，再点收起 */
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
</style>
