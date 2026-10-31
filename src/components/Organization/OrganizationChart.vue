<script setup lang="ts">
/**
 * 项目组织图：直属成员直接展示，负责人名下分区，一层层缩进。
 * 点某个团的「群聊」打开那个团的完整群聊。内容随派出组长的那一步实时更新。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Network } from 'lucide-vue-next'
import { useTerminalStore } from '../../stores/terminal'
import { teamViewForStep, teamMemberSnapshot, teamSources } from '../../utils/team-view'
import { buildOrgTree, organizationAttention } from '../../utils/organization-view'
import type { ArtifactPanelBindings } from '@sailfish/workbench-assistant/artifact/composer-quote'
import { closeFocusedArtifact, isCloseArtifactShortcut, registerFocusedArtifactCloser } from '@sailfish/workbench-assistant/artifact'
import OrganizationBranch from './OrganizationBranch.vue'
import type { TeamArtifactSource } from '@shared/types'
import OrganizationDetailPanel from './OrganizationDetailPanel.vue'
import { provideTeamViewport } from './team-viewport'
import { useTeamSnapshot } from './team-snapshot'
import TeamPanelHeader from './TeamPanelHeader.vue'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = withDefaults(defineProps<{
  tabId: string
  /** 派出组长的那一步 */
  stepId: string
  /** panel：工作台宿主；overlay：终端/联络覆盖层。总览固定铺满，关闭返回原工作面。 */
  mode?: 'panel' | 'overlay'
  focusActive?: boolean
  /** 每次从横幅进入都会给新请求，可直达同一成员或回到总览。 */
  entry?: { member?: string }
  artifactBindings?: ArtifactPanelBindings
}>(), { mode: 'overlay', focusActive: undefined })
const emit = defineEmits<{ close: []; overview: [] }>()

const { t } = useI18n()
const terminalStore = useTerminalStore()

const state = computed(() => terminalStore.tabs.find(tab => tab.id === props.tabId)?.agentState)
const currentOrganization = computed(() => teamViewForStep(state.value?.steps ?? [], props.stepId, state.value?.sessionId))
const organization = useTeamSnapshot(() => currentOrganization.value, () => JSON.stringify([props.tabId, props.stepId, currentOrganization.value?.sessionId]))
provideTeamViewport(computed(() => (organization.value?.total ?? 0) > 200))
const plan = computed(() => {
  let latest
  for (const step of teamSources(state.value?.steps ?? [], props.stepId, state.value?.sessionId)) {
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

const detail = ref<TeamArtifactSource | null>(props.entry?.member ? { member: props.entry.member } : null)
const detailTab = ref<'activity' | 'artifacts'>('activity')
const detailPanel = ref<InstanceType<typeof OrganizationDetailPanel> | null>(null)
let detailTrigger: HTMLElement | null = null
const memberName = computed(() => detail.value && 'member' in detail.value ? detail.value.member : null)
const member = computed(() => currentOrganization.value?.members.find(member => member.name === memberName.value))
function showOverview() {
  const trigger = detailTrigger
  detailTrigger = null
  detail.value = null
  emit('overview')
  void nextTick(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }) })
}
function openDetail(next: TeamArtifactSource, tab: 'activity' | 'artifacts' = 'activity') {
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.oc-overview')) detailTrigger = active
  detail.value = next
  detailTab.value = tab
}
const memberSnapshot = computed(() => memberName.value ? teamMemberSnapshot(state.value?.steps ?? [], props.stepId, memberName.value, state.value?.sessionId) : undefined)
watch([() => props.tabId, () => props.stepId, () => props.entry], () => {
  detail.value = props.entry?.member ? { member: props.entry.member } : null
  detailTab.value = 'activity'
  detailTrigger = null
})
watch([memberName, member], () => {
  if (memberName.value && !member.value) showOverview()
}, { immediate: true, flush: 'post' })
const rootRef = ref<HTMLElement | null>(null)
const localFocus = ref(false)
const focusTarget = ref<HTMLElement | null>(null)
const focusBounds = ref<Record<string, string>>({})
const focused = computed(() => props.focusActive ?? localFocus.value)
function closeLayer(): boolean {
  if (!rootRef.value?.getClientRects().length) return false
  if (document.activeElement?.closest('[aria-modal="true"], dialog[open]')) return false
  if (detail.value) detailPanel.value?.closeLayer()
  else emit('close')
  return true
}
function onCloseKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || !rootRef.value?.getClientRects().length) return
  if (document.activeElement?.closest('[aria-modal="true"], dialog[open]')) return
  const escape = event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  if (!escape && !isCloseArtifactShortcut(event)) return
  const handled = event.repeat || (escape ? closeLayer() : closeFocusedArtifact())
  if (handled) { event.preventDefault(); event.stopImmediatePropagation() }
}
let releaseCloser: (() => void) | undefined
let focusObserver: ResizeObserver | undefined
const syncFocusBounds = () => {
  const box = focusTarget.value?.getBoundingClientRect()
  if (box) focusBounds.value = { position: 'fixed', inset: 'auto', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` }
}
onMounted(() => {
  releaseCloser = registerFocusedArtifactCloser(closeLayer)
  document.addEventListener('keydown', onCloseKey, true)
  // 无工作台宿主的覆盖层固定铺满所属工作区，关闭时由卸载清理。
  if (props.focusActive === undefined) {
    focusTarget.value = rootRef.value?.closest<HTMLElement>('.tab-view') ?? rootRef.value?.parentElement ?? null
    if (!focusTarget.value) return
    syncFocusBounds()
    focusObserver = new ResizeObserver(syncFocusBounds)
    focusObserver.observe(focusTarget.value)
    window.addEventListener('resize', syncFocusBounds)
    localFocus.value = true
  }
})
onBeforeUnmount(() => {
  releaseCloser?.()
  document.removeEventListener('keydown', onCloseKey, true)
  focusObserver?.disconnect()
  window.removeEventListener('resize', syncFocusBounds)
})

</script>

<template>
  <Teleport :disabled="!localFocus" :to="focusTarget || 'body'">
  <section ref="rootRef" class="organization-chart" :class="[`is-${mode}`, { 'is-focus': focused }]" :style="localFocus ? focusBounds : undefined">
    <div class="oc-workspace">
    <div class="oc-overview">
    <TeamPanelHeader class="oc-header" :title="t('ai.organization.title')" :close-label="t('ai.organization.close')" :meta="organization ? t('ai.organization.metaSimple', { total: organization.total, teams: organization.teams.length + (organization.omittedTeams ?? 0) }) : undefined" :focused="focused" hide-focus @close="emit('close')">
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

    <div class="oc-body">
      <div v-if="!organization" class="oc-empty">{{ t('ai.organization.empty') }}</div>
      <template v-else>
        <div class="oc-tree">
          <OrganizationBranch :groups="tree" @open-team="openDetail($event)" @open-artifacts="openDetail($event, 'artifacts')" @open-member="openDetail({ member: $event })" />
        </div>
        <p v-if="organization.omitted" class="oc-omitted">
          {{ t('ai.organization.omitted', { count: organization.omitted, path: organization.boardPath ?? '' }) }}
        </p>
        <p v-if="organization.omittedTeams" class="oc-omitted">
          {{ t('ai.organization.omittedTeams', { count: organization.omittedTeams, path: organization.boardPath ?? '' }) }}
        </p>
      </template>
    </div>
    </div>
    <aside v-if="detail" class="oc-detail">
      <OrganizationDetailPanel :key="JSON.stringify([currentOrganization?.sessionId, stepId, detail])" ref="detailPanel" v-model:active-tab="detailTab" :source="detail" :member="member" :snapshot="memberSnapshot" :session-id="currentOrganization?.sessionId" :artifact-bindings="artifactBindings" :tab-id="tabId" :step-id="stepId" @close="showOverview" />
    </aside>
    </div>
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
.oc-workspace { display: flex; flex: 1; min-width: 0; min-height: 0; }
.oc-overview { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.oc-detail { display: flex; flex-direction: column; flex: 0 0 clamp(300px, 42%, 560px); max-width: 65%; min-width: 0; min-height: 0; border-left: 1px solid var(--border-color); background: var(--bg-primary); }

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

/* 用可用面板宽度排布，铺满和恢复分栏时由网格自然重排。 */
.oc-tree {
  width: 100%;
  min-width: 280px;
}

.oc-omitted { margin-top: 14px; font-size: 11px; color: var(--text-secondary); word-break: break-all; text-align: center; }
</style>
