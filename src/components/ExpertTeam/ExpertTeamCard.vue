<script setup lang="ts">
/**
 * 派专家团那一步下面的一行：群里几条、最新一条说了什么。点开看完整群聊。
 * 高度固定，群聊不在对话里展开。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, ChevronRight } from 'lucide-vue-next'
import type { ExpertTeamView, SubAgentResult } from '@shared/types'
import { latestPreview } from '../../utils/expert-team-view'

const props = defineProps<{
  team: ExpertTeamView
  agents: readonly SubAgentResult[]
}>()
const emit = defineEmits<{ open: [] }>()
const { t } = useI18n()

const text = computed(() => {
  const preview = latestPreview(props.team.messages, props.agents, {
    leader: t('ai.expertTeam.leader'),
    toNobody: t('ai.expertTeam.toNobody'),
    listSeparator: t('ai.expertTeam.listSeparator'),
  })
  if (!preview) return t('ai.expertTeam.cardEmpty')
  const count = props.team.messages.length + (props.team.earlierOmitted ?? 0)
  return t('ai.expertTeam.cardLatest', { count, ...preview })
})
</script>

<template>
  <button type="button" class="expert-team-card" :title="text" @click="emit('open')">
    <MessagesSquare :size="13" class="expert-team-card-icon" />
    <span class="expert-team-card-text">{{ text }}</span>
    <span v-if="team.waitingLeader" class="expert-team-card-badge">{{ t('ai.expertTeam.waitingLeader') }}</span>
    <ChevronRight :size="13" class="expert-team-card-icon" />
  </button>
</template>

<style scoped>
.expert-team-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.expert-team-card:hover {
  background: rgba(255, 255, 255, 0.06);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.35);
}

.expert-team-card-icon {
  flex-shrink: 0;
  opacity: 0.75;
}

.expert-team-card-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.expert-team-card-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--color-warning, #e5c07b);
  background: rgba(var(--color-warning-rgb, 229, 192, 123), 0.12);
}
</style>
