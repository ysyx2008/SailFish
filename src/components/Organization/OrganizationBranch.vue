<script setup lang="ts">
/**
 * 组织图的一层子分支：父亲下面横着排开的几个分支，父到子用直角连线接起来。
 * 团是一个纵向列（团头 + 成员自上而下）；散人是独立分支，和团平级，自己可以再往下长。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare } from 'lucide-vue-next'
import type { OrganizationTeamView } from '@shared/types'
import type { OrgGroup, OrgNode, OrgStatusBucket } from '../../utils/organization-view'
import OrganizationNode from './OrganizationNode.vue'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = withDefaults(defineProps<{
  groups: readonly OrgGroup[]
  /** 从秘书名下那一层算 0，每往下长一层加一，仅用于测试和排查 */
  depth?: number
}>(), { depth: 0 })
const emit = defineEmits<{ openTeam: [team: { name: string; owner?: string }] }>()
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

/** 散人拆成平级的兄弟分支；团整体是一个纵向列 */
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

/**
 * 父节点要压在最左、最右两个子级中心连线的中点上。左右子树宽度不等时，
 * 包围盒中心会偏离这个中点：给窄的一侧补一半差值，包围盒就对称了，
 * 父节点和它下来的竖干自然落在总线中点。补的是可伸缩的空白，不会把行撑得像等宽那么大。
 * 只量分支本身（不含补出来的空白），内容变了能重新量。
 */
const rowRef = ref<HTMLElement | null>(null)
let balanceLeft = 0
let balanceRight = 0

const branchWidth = (cell: HTMLElement): number =>
  cell.firstElementChild?.getBoundingClientRect().width ?? 0

/** 直接写行内 padding：子组件先 mounted，父组件量的时候子级已经补好，一次成型，不跨帧跳 */
const applyBalance = (left: number, right: number) => {
  if (Math.abs(left - balanceLeft) <= 0.5 && Math.abs(right - balanceRight) <= 0.5) return
  balanceLeft = left
  balanceRight = right
  const el = rowRef.value
  if (!el) return
  el.style.paddingLeft = left > 0 ? `${left}px` : ''
  el.style.paddingRight = right > 0 ? `${right}px` : ''
}

const measure = () => {
  const el = rowRef.value
  if (!el) return
  const items = Array.from(el.children) as HTMLElement[]
  const diff = items.length < 2 ? 0 : branchWidth(items[0]) - branchWidth(items[items.length - 1])
  applyBalance(diff < 0 ? -diff / 2 : 0, diff > 0 ? diff / 2 : 0)
}

let rowObserver: ResizeObserver | null = null
onMounted(() => {
  if (rowRef.value) {
    rowObserver = new ResizeObserver(measure)
    rowObserver.observe(rowRef.value)
  }
  measure()
})
onBeforeUnmount(() => {
  rowObserver?.disconnect()
  rowObserver = null
})
watch(cells, async () => {
  await nextTick()
  measure()
})
</script>

<template>
  <div ref="rowRef" class="org-children" :data-depth="depth">
    <div v-for="cell in cells" :key="cell.key" class="org-cell" :class="{ 'is-team': cell.kind === 'team' }">
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
          <div v-for="node in cell.nodes" :key="node.member.id" class="org-member">
            <OrganizationNode :node="node" />
            <OrganizationBranch
              v-if="node.groups.length"
              :groups="node.groups"
              :depth="depth + 1"
              @open-team="emit('openTeam', $event)"
            />
          </div>
        </div>
      </div>
      <div v-else class="org-branch">
        <OrganizationNode :node="cell.node" />
        <OrganizationBranch
          v-if="cell.node.groups.length"
          :groups="cell.node.groups"
          :depth="depth + 1"
          @open-team="emit('openTeam', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 一层分支：横着排；每个分支自己带「总线—短竖线—子节点」的连线 */
.org-children {
  --org-gap: 20px;
  --org-stem: 22px;
  position: relative;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  gap: var(--org-gap);
  /* 补出来的左右 padding 不算进内容宽度，分支排布不受影响 */
  box-sizing: content-box;
  width: max-content;
  padding-top: var(--org-stem);
}

/* 父节点往下到横总线的竖干 */
.org-children::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 2px;
  height: var(--org-stem);
  margin-left: -1px;
  background: var(--org-line, var(--border-color));
}

.org-cell {
  position: relative;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: var(--org-stem);
}

/* 横总线到子节点的短竖线 */
.org-cell::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 2px;
  height: var(--org-stem);
  margin-left: -1px;
  background: var(--org-line, var(--border-color));
}

/* 横总线：相邻分支各画一半，在间距中间接上 */
.org-cell::after {
  content: '';
  position: absolute;
  top: 0;
  left: calc(var(--org-gap) / -2);
  right: calc(var(--org-gap) / -2);
  height: 2px;
  background: var(--org-line, var(--border-color));
}
.org-cell:first-child::after { left: 50%; }
.org-cell:last-child::after { right: 50%; }
.org-cell:only-child::after { display: none; }

.org-branch {
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* 团是中性的队伍底板，状态色留给成员；验收结论独立强调。 */
.org-team {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 240px;
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

.org-team-chat {
  margin-left: auto;
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
.org-team-chat:hover { color: var(--text-primary); border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.45); }

.org-team-members {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.org-team-members > .org-member {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
}
/* 只把本团成员卡片拉满列宽，团成员自己带的下级分支不受影响 */
.org-team-members > .org-member > .org-node {
  width: 100%;
  max-width: 260px;
}
</style>
