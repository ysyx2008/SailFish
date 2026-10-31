<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, Files } from 'lucide-vue-next'
import type { OrganizationTeamView } from '@shared/types'
import type { OrgNode, OrgStatusBucket } from '../../utils/organization-view'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'
const props = defineProps<{ team: OrganizationTeamView; nodes: OrgNode[] }>()
const emit = defineEmits<{ openTeam: []; openArtifacts: [] }>()
const { t } = useI18n()
interface MeterPart { kind: 'completed' | 'running' | 'waiting' | 'failed' | 'interrupted'; count: number }
interface TeamSummary {
  owner: string
  members: string
  bucket: OrgStatusBucket
  label: string
  meterLabel: string
  parts: MeterPart[]
}

/** 团头的汇总：先看有没有人出问题，再看还有多少人在干，最后才是全组做完 */
function summarize(team: OrganizationTeamView, nodes: OrgNode[]): TeamSummary {
  let running = 0
  let waiting = 0
  let completed = 0
  let failed = 0
  let interrupted = 0
  for (const node of nodes) {
    if (node.bucket === 'completed') completed++
    else if (node.bucket === 'failed') failed++
    else if (node.bucket === 'interrupted') interrupted++
    else if (node.bucket === 'waiting') waiting++
    else running++
  }
  const problem = failed + interrupted
  const bucket: OrgStatusBucket = problem > 0
    ? 'problem'
    : running > 0
      ? 'running'
      : waiting > 0
        ? 'waiting'
        : completed > 0
          ? 'completed'
          : 'empty'
  const label = problem > 0
    ? t('ai.organization.teamProblem', { count: problem })
    : running > 0
      ? t('ai.organization.teamRunning', { count: running })
      : waiting > 0
        ? t('ai.organization.teamWaiting', { count: waiting })
        : completed > 0
          ? t('ai.organization.teamDone')
          : t('ai.organization.teamEmpty')
  const parts = ([
    { kind: 'completed', count: completed },
    { kind: 'running', count: running },
    { kind: 'waiting', count: waiting },
    { kind: 'failed', count: failed },
    { kind: 'interrupted', count: interrupted },
  ] as MeterPart[]).filter(part => part.count > 0)
  return {
    // 秘书自己的团没有组长，写「秘书」而不是「组长·秘书」
    owner: team.owner
      ? t('ai.organization.teamOwner', { name: team.owner })
      : t('ai.organization.secretary'),
    members: t('ai.organization.teamMembers', { count: nodes.length }),
    bucket,
    label,
    meterLabel: t('ai.organization.teamProgress', { completed, running: running + waiting, problem }),
    parts,
  }
}
const summary = computed(() => summarize(props.team, props.nodes))
</script>
<template>
  <section class="org-team" :class="`is-${summary.bucket}`" :data-owner="team.owner ?? ''" :data-team="team.name">
    <div class="org-team-head">
      <span class="org-team-name" :title="team.name">{{ t('ai.organization.teamTitle', { team: team.name }) }}</span>
      <span class="org-review" :class="`is-${team.review}`">{{ t(`ai.organization.review.${team.review}`) }}</span>
    </div>
    <div class="org-team-meta">
      <span class="org-team-owner" :title="summary.owner">{{ summary.owner }}</span>
      <span class="org-team-count">{{ summary.members }}</span>
      <OrganizationStatusBadge :bucket="summary.bucket" :label="summary.label" compact />
    </div>
    <div class="org-team-actions">
      <OrganizationStatusBadge v-if="team.waitingLeader" bucket="waiting" :label="t('ai.organization.waitingLeader')" compact />
      <button type="button" class="org-team-artifacts" :title="t('ai.organization.openTeamArtifacts')" @click.stop="emit('openArtifacts')"><Files :size="12" />{{ t('ai.organization.teamArtifacts') }}</button>
      <button type="button" class="org-team-chat" :title="t('ai.organization.openTeamChat')" @click.stop="emit('openTeam')"><MessagesSquare :size="12" />{{ t('ai.organization.teamChat', { count: team.messageCount }) }}</button>
    </div>
    <div class="org-team-meter" role="img" :aria-label="summary.meterLabel">
      <i v-for="part in summary.parts" :key="part.kind" class="org-meter-part" :class="`is-${part.kind}`" :style="{ flexGrow: part.count }" />
    </div>
  </section>
</template>
<style scoped>
/* 小组只作同列标题，状态与验收独立呈现，不用嵌套外框表示管理层级。 */
.org-team {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  height: 104px;
  gap: 7px;
  min-width: 0;
  padding: 8px;
  border-left: 2px solid var(--border-color);
}

.org-team-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}
.org-team-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-primary);
}
.org-team-meta {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.3;
  color: var(--text-secondary);
}
.org-team-owner {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.org-team-count { flex-shrink: 0; }
.org-team-meta .org-status-badge { margin-left: auto; }

.org-team-meter {
  display: flex;
  gap: 2px;
  height: 3px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--bg-tertiary);
}
.org-meter-part {
  display: block;
  flex-basis: 0;
  min-width: 4px;
  height: 100%;
  border-radius: 999px;
}
.org-meter-part.is-completed { background: var(--color-success, #98c379); }
.org-meter-part.is-running { background: var(--accent-primary); }
.org-meter-part.is-waiting { background: var(--color-warning, #e5c07b); }
.org-meter-part.is-failed { background: var(--color-danger, #e06c75); }
.org-meter-part.is-interrupted { background: var(--text-secondary); }

.org-review {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-secondary);
  padding: 3px 6px;
  border-radius: 4px;
}
.org-review.is-pass {
  color: var(--color-success, #98c379);
  background: color-mix(in srgb, var(--color-success, #98c379) 12%, transparent);
}
.org-review.is-reject {
  color: var(--color-danger, #e06c75);
  background: color-mix(in srgb, var(--color-danger, #e06c75) 14%, var(--bg-primary));
  border: 1px solid color-mix(in srgb, var(--color-danger, #e06c75) 60%, var(--border-color));
  font-weight: 600;
}
.org-review.is-pending {
  color: var(--color-warning, #e5c07b);
  background: color-mix(in srgb, var(--color-warning, #e5c07b) 10%, transparent);
}

.org-team-artifacts { margin-left: auto; }
.org-team-artifacts, .org-team-chat {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.org-team-artifacts:hover, .org-team-chat:hover { color: var(--text-primary); border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45); }
.org-team-actions { display: flex; align-items: center; gap: 6px; }
.org-team-actions > .org-status-badge { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 10px; }
</style>
