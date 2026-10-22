<script setup lang="ts">
/**
 * 派专家团那一步下面的一行：群聊几条、最新是谁说了什么。点开看完整群聊。
 * 高度固定，群聊不在对话里展开。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, ChevronRight } from 'lucide-vue-next'
import type { ExpertTeamView } from '@shared/types'
import { latestPreview } from '../../utils/expert-team-view'

const props = defineProps<{
  team: ExpertTeamView
}>()
const emit = defineEmits<{ open: [] }>()
const { t } = useI18n()

const preview = computed(() => latestPreview(props.team.messages, { leader: t('ai.expertTeam.leader') }))
const count = computed(() => props.team.messages.length + (props.team.earlierOmitted ?? 0))
const headline = computed(() => preview.value ? t('ai.expertTeam.cardCount', { count: count.value }) : t('ai.expertTeam.cardEmpty'))
const latest = computed(() => preview.value ? t('ai.expertTeam.cardLatest', preview.value) : '')
</script>

<template>
  <button type="button" class="expert-team-card" :title="`${headline} ${latest}`.trim()" @click="emit('open')">
    <span class="expert-team-card-icon"><MessagesSquare :size="13" /></span>
    <span class="expert-team-card-head">{{ headline }}</span>
    <span v-if="latest" class="expert-team-card-latest">{{ latest }}</span>
    <span v-else class="expert-team-card-latest" />
    <span v-if="team.waitingLeader" class="expert-team-card-badge">{{ t('ai.expertTeam.waitingLeader') }}</span>
    <ChevronRight :size="13" class="expert-team-card-chevron" />
  </button>
</template>

<style scoped>
.expert-team-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 10px 0 6px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.expert-team-card:hover {
  background: var(--bg-tertiary);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45);
}

.expert-team-card-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
}

.expert-team-card-head {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--text-primary);
}

.expert-team-card-latest {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}

.expert-team-card-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--color-warning, #e5c07b);
  background: rgba(var(--color-warning-rgb, 229, 192, 123), 0.12);
}

.expert-team-card-chevron {
  flex-shrink: 0;
  opacity: 0.6;
}
</style>
