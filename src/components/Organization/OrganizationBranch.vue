<script setup lang="ts">
/**
 * 一层真实归属：同级成员网格换行，有下级的负责人和小组各占完整分区。
 * 缩进与分区边线表达管理关系，不把换行后的成员连接成虚假的新层级。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, Files } from 'lucide-vue-next'
import type { OrganizationTeamView } from '@shared/types'
import type { OrgGroup, OrgNode, OrgStatusBucket } from '../../utils/organization-view'
import OrganizationNode from './OrganizationNode.vue'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = withDefaults(defineProps<{
  groups: readonly OrgGroup[]
  /** 从秘书名下那一层算 0，每往下长一层加一，仅用于测试和排查 */
  depth?: number
}>(), { depth: 0 })
const emit = defineEmits<{ openMember: [name: string]; openTeam: [team: { name: string; owner?: string }]; openArtifacts: [team: { name: string; owner?: string }] }>()
const { t } = useI18n()

interface MeterPart { kind: 'completed' | 'running' | 'waiting' | 'failed' | 'interrupted'; count: number }
interface TeamSummary {
  owner: string
  members: string
  bucket: OrgStatusBucket
  label: string
  meterLabel: string
  parts: MeterPart[]
  total: number
}
interface NodeCell { kind: 'node'; key: string; node: OrgNode }
interface TeamCell { kind: 'team'; key: string; team: OrganizationTeamView; nodes: OrgNode[]; summary: TeamSummary }
type Cell = NodeCell | TeamCell

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
    total: nodes.length,
  }
}

const openTeam = (team: OrganizationTeamView) => emit('openTeam', { name: team.name, owner: team.owner })

/** 散人保留真实同级关系；团保留自己的成员集合与群聊入口。 */
const cells = computed<Cell[]>(() => {
  const out: Cell[] = []
  for (const group of props.groups) {
    if (group.team) {
      out.push({
        kind: 'team',
        // 不同组长手下可能有同名团，key 带上组长
        key: `team-${group.team.owner ?? ''}-${group.team.name}`,
        team: group.team,
        nodes: group.nodes,
        summary: summarize(group.team, group.nodes),
      })
      continue
    }
    for (const node of group.nodes) {
      out.push({ kind: 'node', key: `node-${node.member.id}`, node })
    }
  }
  return out
})

</script>

<template>
  <div class="org-children" :data-depth="depth">
    <div v-for="cell in cells" :key="cell.key" class="org-cell" :class="{ 'is-team': cell.kind === 'team', 'has-children': cell.kind === 'node' && cell.node.groups.length > 0 }">
      <div
        v-if="cell.kind === 'team'"
        class="org-team"
        :class="`is-${cell.summary.bucket}`"
        :title="t('ai.organization.openTeamChat')"
        @click.stop="openTeam(cell.team)"
      >
        <div class="org-team-head">
          <span class="org-team-name">{{ t('ai.organization.teamTitle', { team: cell.team.name }) }}</span>
          <span class="org-review" :class="`is-${cell.team.review}`">{{ t(`ai.organization.review.${cell.team.review}`) }}</span>
          <button type="button" class="org-team-artifacts" :title="t('ai.organization.openTeamArtifacts')" @click.stop="emit('openArtifacts', { name: cell.team.name, owner: cell.team.owner })">
            <Files :size="12" /><span>{{ t('ai.organization.teamArtifacts') }}</span>
          </button>
          <button
            type="button"
            class="org-team-chat"
            :title="t('ai.organization.openTeamChat')"
            @click.stop="openTeam(cell.team)"
          >
            <MessagesSquare :size="12" />
            <span>{{ t('ai.organization.teamChat', { count: cell.team.messageCount }) }}</span>
          </button>
        </div>
        <div class="org-team-meta">
          <span class="org-team-owner">{{ cell.summary.owner }}</span>
          <span class="org-team-count">{{ cell.summary.members }}</span>
          <OrganizationStatusBadge v-if="cell.team.waitingLeader" bucket="waiting" :label="t('ai.organization.waitingLeader')" compact />
          <OrganizationStatusBadge
            :bucket="cell.summary.bucket"
            :label="cell.summary.label"
            compact
          />
        </div>
        <div
          v-if="cell.summary.total > 0 && cell.summary.bucket !== 'completed'"
          class="org-team-meter"
          role="img"
          :aria-label="cell.summary.meterLabel"
        >
          <i
            v-for="part in cell.summary.parts"
            :key="part.kind"
            class="org-meter-part"
            :class="`is-${part.kind}`"
            :style="{ flexGrow: part.count }"
          />
        </div>
        <div class="org-team-members">
          <div v-for="node in cell.nodes" :key="node.member.id" class="org-member" :class="{ 'has-children': node.groups.length > 0 }">
            <OrganizationNode :node="node" @open="emit('openMember', node.member.name)" />
            <OrganizationBranch
              v-if="node.groups.length"
              :groups="node.groups"
              :depth="depth + 1"
              @open-member="emit('openMember', $event)"
              @open-team="emit('openTeam', $event)"
              @open-artifacts="emit('openArtifacts', $event)"
            />
          </div>
        </div>
      </div>
      <div v-else class="org-branch">
        <OrganizationNode :node="cell.node" @open="emit('openMember', cell.node.member.name)" />
        <OrganizationBranch
          v-if="cell.node.groups.length"
          :groups="cell.node.groups"
          :depth="depth + 1"
          @open-member="emit('openMember', $event)"
              @open-team="emit('openTeam', $event)"
              @open-artifacts="emit('openArtifacts', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 同级换行；实际负责人分区占整行，避免窄列递归挤压下级。 */
.org-children {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
  align-items: start;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
}
.org-cell {
  min-width: 0;
}
.org-cell.is-team, .org-cell.has-children { grid-column: 1 / -1; }

.org-branch {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}
.org-branch > .org-node { width: 100%; max-width: 280px; }
.org-cell.has-children > .org-branch {
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-secondary) 25%, var(--bg-primary));
}
.org-cell.has-children > .org-branch > .org-node { max-width: 240px; }
.org-branch > .org-children, .org-member > .org-children {
  padding-left: 16px;
  border-left: 2px solid var(--org-line, var(--border-color));
}

/* 团是中性的队伍底板，状态色留给成员；验收结论独立强调。 */
.org-team {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-secondary) 45%, var(--bg-primary));
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.org-team:hover { border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.4); }

.org-team-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  padding-bottom: 9px;
  border-bottom: 1px solid var(--border-color);
}
.org-team-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-primary);
}
.org-team-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
  font-size: 11px;
  line-height: 1.3;
  color: var(--text-secondary);
}
.org-team-owner {
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

.org-team-members {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
  align-items: start;
  gap: 10px;
}
.org-team-members > .org-member {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  width: 100%;
}
/* 只把本团成员卡片拉满列宽，团成员自己带的下级分支不受影响 */
.org-team-members > .org-member > .org-node {
  width: 100%;
  max-width: 280px;
}
.org-member.has-children { grid-column: 1 / -1; }
</style>
