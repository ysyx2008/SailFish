<script setup lang="ts">
/**
 * 对话顶部挂着的「派出去的人」：每一批一行，不随对话滚走。
 * 点一行展开成对话里那一处同样的内容（盖在对话上面，不把对话往下挤），点别处或再点一下收起。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, MessagesSquare, Check, TriangleAlert } from 'lucide-vue-next'
import type { AgentStep } from '@shared/types'
import { describeDock } from '../utils/sub-agent-summary'
import SubAgentGroup from './SubAgentGroup.vue'

const props = defineProps<{
  /** 该挂着的几批人（派出那几步），由外面按「还没干完 / 你还没再说话」挑好 */
  steps: readonly AgentStep[]
}>()
const emit = defineEmits<{ openTeam: [stepId: string] }>()
const { t } = useI18n()

const root = ref<HTMLElement | null>(null)
const openStepId = ref<string | null>(null)

const items = computed(() => props.steps.map(step => {
  const team = step.expertTeam
  return {
    step,
    ...describeDock(t, step.subAgents ?? []),
    teamCount: team ? team.messages.length + (team.earlierOmitted ?? 0) : 0,
    hasTeam: !!team,
  }
}))

const toggle = (stepId: string) => {
  openStepId.value = openStepId.value === stepId ? null : stepId
}

// 展开着的那一批不再挂了（你说话了、被收起），面板跟着收
watch(() => props.steps.map(s => s.id), ids => {
  if (openStepId.value && !ids.includes(openStepId.value)) openStepId.value = null
})

const onPointerDown = (event: PointerEvent) => {
  if (!openStepId.value) return
  if (root.value && event.target instanceof Node && root.value.contains(event.target)) return
  openStepId.value = null
}
const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') openStepId.value = null
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div v-if="items.length > 0" ref="root" class="sub-agent-dock">
    <div v-for="item in items" :key="item.step.id" class="dock-row">
      <button
        type="button"
        class="dock-bar"
        :class="[item.kind, { open: openStepId === item.step.id }]"
        :title="openStepId === item.step.id ? t('ai.subAgentDock.collapse') : t('ai.subAgentDock.expand')"
        @click="toggle(item.step.id)"
      >
        <span class="dock-icon">
          <span v-if="item.kind === 'working'" class="dock-spinner" />
          <Check v-else-if="item.kind === 'done'" :size="13" />
          <TriangleAlert v-else :size="13" />
        </span>
        <span class="dock-headline">{{ item.headline }}</span>
        <ChevronDown :size="13" class="dock-chevron" :class="{ open: openStepId === item.step.id }" />
      </button>
      <button
        v-if="item.hasTeam"
        type="button"
        class="dock-team"
        @click="emit('openTeam', item.step.id)"
      >
        <MessagesSquare :size="13" />
        <span>{{ item.teamCount > 0 ? t('ai.expertTeam.cardCount', { count: item.teamCount }) : t('ai.subAgentDock.teamChat') }}</span>
      </button>
      <div v-if="openStepId === item.step.id" class="dock-panel">
        <SubAgentGroup
          :step-id="item.step.id"
          :sub-agents="item.step.subAgents ?? []"
          :expert-team="item.step.expertTeam"
          always-open
          @open-team="emit('openTeam', item.step.id)"
        />
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
  gap: 4px;
  padding: 6px 12px;
  background: var(--bg-primary);
  border-bottom: 1px solid var(--border-color);
  z-index: 9;
}

.dock-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dock-bar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px 0 8px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.dock-bar:hover,
.dock-bar.open {
  background: var(--bg-tertiary);
}

.dock-bar.working {
  border-color: rgba(var(--color-info-rgb), 0.4);
}

.dock-bar.done {
  border-color: rgba(var(--color-success-rgb), 0.3);
}

.dock-bar.problem {
  border-color: rgba(var(--color-warning-rgb), 0.4);
}

.dock-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
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

.dock-team {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--accent-primary);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.dock-team:hover {
  background: var(--bg-tertiary);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45);
}

/* 展开的内容盖在对话上面，不把对话往下挤 */
.dock-panel {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  max-height: min(60vh, 520px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  z-index: 20;
}
</style>
