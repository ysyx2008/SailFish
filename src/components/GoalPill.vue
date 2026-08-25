<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pause, Play, X } from 'lucide-vue-next'
import type { GoalContract } from '@shared/types'

const props = defineProps<{
  agentKey: string
  sessionId?: string
  visible?: boolean
}>()

const { t } = useI18n()
const goal = ref<GoalContract | undefined>()

const load = async () => {
  if (!props.agentKey) {
    goal.value = undefined
    return
  }
  goal.value = await window.electronAPI.goal.get(props.agentKey, props.sessionId) ?? undefined
}

watch(() => [props.agentKey, props.sessionId], () => { void load() }, { immediate: true })

onMounted(() => {
  void load()
  unsubscribe = window.electronAPI.goal.onUpdated((payload) => {
    if (payload.agentKey === props.agentKey) {
      goal.value = payload.goal
    }
  })
})

let unsubscribe: (() => void) | undefined
onUnmounted(() => unsubscribe?.())

const statusLabel = computed(() => {
  if (!goal.value) return ''
  return t(`goal.status.${goal.value.status}`)
})

const usageLabel = computed(() => {
  if (!goal.value) return ''
  if (goal.value.tokenBudget !== undefined) {
    return `${goal.value.tokensUsed} / ${goal.value.tokenBudget}`
  }
  return `${goal.value.tokensUsed}`
})

const canPause = computed(() => goal.value?.status === 'active')
const canResume = computed(() => {
  const status = goal.value?.status
  return status === 'paused' || status === 'blocked' || status === 'usage_limited'
})

const pause = async () => {
  await window.electronAPI.goal.pause(props.agentKey)
}

const resume = async () => {
  await window.electronAPI.goal.resume({ agentKey: props.agentKey })
}

const clear = async () => {
  if (!window.confirm(t('goal.clearConfirm'))) return
  await window.electronAPI.goal.clear(props.agentKey)
}
</script>

<template>
  <div v-if="visible !== false && goal" class="goal-pill">
    <div class="goal-pill-main">
      <span class="goal-pill-status" :data-status="goal.status">{{ statusLabel }}</span>
      <span class="goal-pill-text" :title="goal.objective">{{ goal.objective }}</span>
      <span class="goal-pill-usage">{{ usageLabel }}</span>
    </div>
    <div class="goal-pill-actions">
      <button v-if="canPause" type="button" :title="t('goal.pause')" @click="pause">
        <Pause :size="14" />
      </button>
      <button v-if="canResume" type="button" :title="t('goal.resume')" @click="resume">
        <Play :size="14" />
      </button>
      <button type="button" :title="t('goal.clear')" @click="clear">
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.goal-pill {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 0 12px 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--bg-secondary, rgba(127, 127, 127, 0.12));
  font-size: 12px;
}
.goal-pill-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.goal-pill-status {
  flex: 0 0 auto;
  font-weight: 600;
}
.goal-pill-status[data-status='blocked'] {
  color: var(--warning, #c9862c);
}
.goal-pill-status[data-status='achieved'] {
  color: var(--success, #3c9d4e);
}
.goal-pill-status[data-status='usage_limited'],
.goal-pill-status[data-status='budget_limited'] {
  color: var(--danger, #c45454);
}
.goal-pill-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.goal-pill-usage {
  flex: 0 0 auto;
  opacity: 0.7;
}
.goal-pill-actions {
  display: flex;
  gap: 4px;
}
.goal-pill-actions button {
  border: none;
  background: transparent;
  color: inherit;
  padding: 2px;
  cursor: pointer;
  opacity: 0.75;
}
.goal-pill-actions button:hover {
  opacity: 1;
}
</style>
