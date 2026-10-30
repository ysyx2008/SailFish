<script setup lang="ts">
/**
 * 项目组织图：秘书在最上面，名下按团分组，组长名下再分组，一层层缩进。
 * 点某个团的「群聊」打开那个团的完整群聊。内容随派出组长的那一步实时更新。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Network, UserRound } from 'lucide-vue-next'
import { useTerminalStore } from '../../stores/terminal'
import { teamViewForStep, teamMemberSnapshot, teamSources } from '../../utils/team-view'
import { buildOrgTree, organizationAttention } from '../../utils/organization-view'
import type { ArtifactPanelBindings } from '@sailfish/workbench-assistant/artifact/composer-quote'
import OrganizationBranch from './OrganizationBranch.vue'
import OrganizationTeamArtifacts from './OrganizationTeamArtifacts.vue'
import type { TeamArtifactSource } from '@shared/types'
import OrganizationMemberDetail from './OrganizationMemberDetail.vue'
import { provideTeamViewport } from './team-viewport'
import { useTeamSnapshot } from './team-snapshot'
import TeamPanelHeader from './TeamPanelHeader.vue'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = withDefaults(defineProps<{
  tabId: string
  /** 派出组长的那一步 */
  stepId: string
  /** panel：右侧面板；overlay：覆盖对话。两种模式共用标题旁关闭和铺满入口。 */
  mode?: 'panel' | 'overlay'
  focusActive?: boolean
  /** 每次从横幅进入都会给新请求，可直达同一成员或回到总览。 */
  entry?: { member?: string }
  artifactBindings?: ArtifactPanelBindings
}>(), { mode: 'overlay', focusActive: undefined })
const emit = defineEmits<{ close: []; toggleFocus: []; overview: []; openTeam: [team: { name: string; owner?: string }] }>()

const { t } = useI18n()
const terminalStore = useTerminalStore()

const state = computed(() => terminalStore.tabs.find(tab => tab.id === props.tabId)?.agentState)
const currentOrganization = computed(() => teamViewForStep(state.value?.steps ?? [], props.stepId, state.value?.sessionId))
const organization = useTeamSnapshot(() => currentOrganization.value, () => JSON.stringify([props.tabId, props.stepId, currentOrganization.value?.sessionId]))
provideTeamViewport(computed(() => (organization.value?.total ?? 0) > 200))
const plan = computed(() => {
  let latest
  for (const step of teamSources(state.value?.steps ?? [], props.stepId)) {
    if (step.type === 'plan_archived') latest = undefined
    else if (step.plan) latest = step.plan
  }
  return latest
})
const currentPlanStep = computed(() => plan.value?.steps.find(step => step.status === 'in_progress'))
const tree = computed(() => organization.value ? buildOrgTree(organization.value) : [])
/** 全组织的概览：在干几人、做完几人、几人出问题 */
const attention = computed(() => organization.value ? organizationAttention(organization.value) : null)
const stats = computed(() => {
  const org = organization.value
  if (!org) return null
  const problems = Math.max(
    org.problems ?? 0,
    org.members.filter(m => m.status === 'failed' || m.status === 'interrupted').length,
  )
  return {
    live: org.live,
    problems,
    done: Math.max(0, org.total - org.live - problems),
  }
})

const artifactTeam = ref<TeamArtifactSource | null>(null)
const memberName = ref<string | null>(props.entry?.member ?? null)
const member = computed(() => currentOrganization.value?.members.find(member => member.name === memberName.value))
function showOverview() {
  memberName.value = null
  emit('overview')
}
const memberSnapshot = computed(() => memberName.value ? teamMemberSnapshot(state.value?.steps ?? [], props.stepId, memberName.value) : undefined)
watch([() => props.tabId, () => props.stepId, () => props.entry], () => { artifactTeam.value = null; memberName.value = props.entry?.member ?? null })
const bodyRef = ref<HTMLElement | null>(null)
const rootRef = ref<HTMLElement | null>(null)
const localFocus = ref(false)
const focusTarget = ref<HTMLElement | null>(null)
const focusBounds = ref<Record<string, string>>({})
const focused = computed(() => props.focusActive ?? localFocus.value)
let focusObserver: ResizeObserver | undefined
const syncFocusBounds = () => {
  const box = focusTarget.value?.getBoundingClientRect()
  if (box) focusBounds.value = { position: 'fixed', inset: 'auto', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }
}
const toggleFocus = () => {
  if (props.focusActive !== undefined) { emit('toggleFocus'); return }
  if (!localFocus.value) {
    focusTarget.value = rootRef.value?.closest<HTMLElement>('.tab-view') ?? rootRef.value?.parentElement ?? null
    if (!focusTarget.value) return
    syncFocusBounds()
    focusObserver = new ResizeObserver(syncFocusBounds)
    focusObserver.observe(focusTarget.value)
    window.addEventListener('resize', syncFocusBounds)
  } else {
    focusObserver?.disconnect()
    window.removeEventListener('resize', syncFocusBounds)
  }
  localFocus.value = !localFocus.value
}
onBeforeUnmount(() => {
  focusObserver?.disconnect()
  window.removeEventListener('resize', syncFocusBounds)
})

/** 树比面板宽时，把初始横向滚动放到中间，根节点不会一打开就在视口外 */
const centerTree = () => {
  const body = bodyRef.value
  if (!body) return
  const overflow = body.scrollWidth - body.clientWidth
  body.scrollLeft = overflow > 0 ? overflow / 2 : 0
}
watch(focused, async () => {
  await nextTick()
  centerTree()
})

onMounted(() => {
  // 各层分支在自己 mounted 里已经自底向上量完并撑好；这里量的是最终宽度
  centerTree()
})
</script>

<template>
  <Teleport :disabled="!localFocus" :to="focusTarget || 'body'">
  <section ref="rootRef" class="organization-chart" :class="[`is-${mode}`, { 'is-focus': focused }]" :style="localFocus ? focusBounds : undefined">
    <OrganizationTeamArtifacts v-if="artifactTeam" :artifact-bindings="artifactBindings" :tab-id="tabId" :step-id="stepId" :team="artifactTeam" :focus-active="focused" @close="artifactTeam = null" @toggle-focus="toggleFocus" />
    <OrganizationMemberDetail v-else-if="member" :step-id="stepId" :session-id="currentOrganization?.sessionId" :member="member" :snapshot="memberSnapshot" :focus-active="focused" @close="showOverview" @artifacts="artifactTeam = { member: member.name }" @toggle-focus="toggleFocus" />
    <template v-else>
    <TeamPanelHeader class="oc-header" :title="t('ai.organization.title')" :close-label="t('ai.organization.close')" :meta="organization ? t('ai.organization.metaSimple', { total: organization.total, teams: organization.teams.length + (organization.omittedTeams ?? 0) }) : undefined" :focused="focused" :focus-label="focused ? t('canvas.splitDocument') : t('ai.organization.focus')" @close="emit('close')" @toggle-focus="toggleFocus">
      <template #icon><Network :size="14" /></template>
    </TeamPanelHeader>

    <div v-if="plan" class="oc-progress"><strong>{{ plan.title }}</strong><span v-if="currentPlanStep">{{ currentPlanStep.title }}</span></div>
    <div v-if="organization && stats && (stats.live > 0 || stats.done > 0 || stats.problems > 0)" class="oc-summary">
      <OrganizationStatusBadge
        v-if="stats.live > 0"
        bucket="running"
        :label="t('ai.organization.summaryLive', { live: stats.live })"
        compact
      />
      <OrganizationStatusBadge
        v-if="stats.done > 0"
        bucket="completed"
        :label="t('ai.organization.summaryDone', { count: stats.done })"
        compact
      />
      <OrganizationStatusBadge
        v-if="stats.problems > 0"
        bucket="problem"
        :label="t('ai.organization.summaryProblem', { count: stats.problems })"
        compact
      />
      <OrganizationStatusBadge v-if="attention?.rejected" bucket="problem" :label="t('ai.organization.summaryRejected', { count: attention.rejected })" compact />
      <OrganizationStatusBadge v-if="attention?.pending" bucket="waiting" :label="t('ai.organization.summaryPending', { count: attention.pending })" compact />
      <OrganizationStatusBadge v-if="attention?.waiting" bucket="waiting" :label="t('ai.organization.summaryWaiting', { count: attention.waiting })" compact />
    </div>

    <div ref="bodyRef" class="oc-body">
      <div v-if="!organization" class="oc-empty">{{ t('ai.organization.empty') }}</div>
      <template v-else>
        <div class="oc-tree">
          <div class="oc-secretary">
            <span class="oc-secretary-avatar" aria-hidden="true"><UserRound :size="15" /></span>
            <span class="oc-secretary-name">{{ t('ai.organization.secretary') }}</span>
          </div>
          <OrganizationBranch :groups="tree" @open-team="emit('openTeam', $event)" @open-artifacts="artifactTeam = $event" @open-member="memberName = $event" />
        </div>
        <p v-if="organization.omitted" class="oc-omitted">
          {{ t('ai.organization.omitted', { count: organization.omitted, path: organization.boardPath ?? '' }) }}
        </p>
        <p v-if="organization.omittedTeams" class="oc-omitted">
          {{ t('ai.organization.omittedTeams', { count: organization.omittedTeams, path: organization.boardPath ?? '' }) }}
        </p>
      </template>
    </div>
    </template>
  </section>
  </Teleport>
</template>

<style scoped>
.organization-chart {
  /* 连线是这张图的主干，比普通边框实一点；不支持 color-mix 时退回边框色 */
  --org-line: var(--border-color);
  --org-line: color-mix(in srgb, var(--text-secondary) 45%, transparent);
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.organization-chart.is-overlay {
  position: absolute;
  inset: 0;
  z-index: 29;
  /* 盖在对话顶栏上：顶栏是拖窗口的区域，不声明的话点返回等于拖窗口 */
  -webkit-app-region: no-drag;
}
/* 右侧面板和对话之间画一道分界，和群聊面板一致 */
.organization-chart.is-panel {
  border-left: 1px solid var(--border-color);
}
.organization-chart.is-focus { border-left: none; }
.organization-chart.is-focus .oc-body { padding-bottom: var(--assistant-focus-overlay, 22px); }

.oc-progress { flex-shrink: 0; padding: 10px 14px; border-bottom: 1px solid var(--border-color); display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.oc-progress span { color: var(--text-secondary); }
.oc-summary {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--border-color);
}

.oc-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 12px 22px;
}
.oc-empty { padding: 24px 0; text-align: center; color: var(--text-secondary); font-size: 12px; }

/* 整棵树按内容宽度居中；比面板宽时横向滚动，不换行，连线才不会跨行断开 */
.oc-tree {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: max-content;
  margin: 0 auto;
}

.oc-secretary {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 24px 10px 12px;
  border-radius: 14px 4px;
  border: 2px solid color-mix(in srgb, var(--accent-primary) 65%, var(--border-color));
  background: color-mix(in srgb, var(--accent-primary) 9%, var(--bg-primary));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-primary) 8%, transparent);
  font-size: 13px;
  font-weight: 600;
}
.oc-secretary-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 8px 2px;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
}
.oc-omitted { margin-top: 14px; font-size: 11px; color: var(--text-secondary); word-break: break-all; text-align: center; }
</style>
