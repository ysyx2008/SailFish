<script setup lang="ts">
/**
 * 派出组长那一步下面的一行：组织多少人、几个团、几个在干。点开看组织图。
 * 高度固定，组织图不在对话里展开。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Network, ChevronRight } from 'lucide-vue-next'
import type { OrganizationView } from '@shared/types'
import { organizationAttention } from '../../utils/organization-view'

const props = defineProps<{ organization: OrganizationView }>()
const emit = defineEmits<{ open: [] }>()
const { t } = useI18n()

const headline = computed(() => t('ai.organization.cardHeadline', { total: props.organization.total }))
/** members 只放得下前面一部分；live / total 是真实合计，干完和出问题按看得到的成员数 */
const counts = computed(() => {
  let completed = 0
  let problem = 0
  for (const member of props.organization.members) {
    if (member.status === 'completed') completed++
    else if (member.status === 'failed' || member.status === 'interrupted') problem++
  }
  return { completed, problem }
})
const detail = computed(() => {
  const { completed } = counts.value
  const attention = organizationAttention(props.organization)
  // 失败 / 打断用全组织的数：成员太多没放全时，没放进来的人出问题也要算
  const problem = Math.max(counts.value.problem, props.organization.problems ?? 0)
  const teamCount = props.organization.teams.length + (props.organization.omittedTeams ?? 0)
  const parts = [
    teamCount > 0 ? t('ai.organization.cardTeams', { count: teamCount }) : '',
    props.organization.live > 0 ? t('ai.organization.cardLive', { live: props.organization.live }) : '',
    // 成员没放全时干完的数只是看得到的那些，不写出来免得当成全组织
    completed > 0 && !props.organization.omitted ? t('ai.organization.cardCompleted', { count: completed }) : '',
    problem > 0 ? t('ai.organization.cardProblem', { count: problem }) : '',
    attention.rejected ? t('ai.organization.summaryRejected', { count: attention.rejected }) : '',
    attention.pending ? t('ai.organization.summaryPending', { count: attention.pending }) : '',
    attention.waiting ? t('ai.organization.summaryWaiting', { count: attention.waiting }) : '',
  ].filter(Boolean)
  // 都干完了才写「都干完了」；有人失败或被打断时仍显示计数，成员没放全时也不下这个结论
  if (props.organization.live === 0 && problem === 0 && !props.organization.omitted && !attention.rejected && !attention.pending && !attention.waiting) {
    parts.push(t('ai.organization.cardAllDone'))
  }
  return parts.join(' · ')
})
</script>

<template>
  <button type="button" class="organization-card" :title="`${headline} ${detail}`" @click="emit('open')">
    <span class="organization-card-icon"><Network :size="13" /></span>
    <span class="organization-card-head">{{ headline }}</span>
    <span class="organization-card-detail">{{ detail }}</span>
    <ChevronRight :size="13" class="organization-card-chevron" />
  </button>
</template>

<style scoped>
.organization-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  margin-top: 6px;
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
.organization-card:hover {
  background: var(--bg-tertiary);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45);
}
.organization-card-icon {
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
.organization-card-head { flex-shrink: 0; font-weight: 600; color: var(--text-primary); }
.organization-card-detail {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.organization-card-chevron { flex-shrink: 0; opacity: 0.6; }
</style>
