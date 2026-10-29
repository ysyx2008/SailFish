<script setup lang="ts">
/**
 * 项目组织图：秘书在最上面，名下按团分组，组长名下再分组，一层层缩进。
 * 点某个团的「群聊」打开那个团的完整群聊。内容随派出组长的那一步实时更新。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Maximize2, Minimize2, X, Network, UserRound } from 'lucide-vue-next'
import { useTerminalStore } from '../../stores/terminal'
import { buildOrgTree } from '../../utils/organization-view'
import type { ArtifactPanelBindings } from '@sailfish/workbench-assistant/artifact/composer-quote'
import OrganizationBranch from './OrganizationBranch.vue'
import OrganizationTeamArtifacts from './OrganizationTeamArtifacts.vue'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = withDefaults(defineProps<{
  tabId: string
  /** 派出组长的那一步 */
  stepId: string
  /** panel：右侧面板；overlay：覆盖对话。两种模式共用标题旁关闭和铺满入口。 */
  mode?: 'panel' | 'overlay'
  focusActive?: boolean
  artifactBindings?: ArtifactPanelBindings
}>(), { mode: 'overlay', focusActive: undefined })
const emit = defineEmits<{ close: []; toggleFocus: []; openTeam: [team: { name: string; owner?: string }] }>()

const { t } = useI18n()
const terminalStore = useTerminalStore()

const organization = computed(() => terminalStore.tabs
  .find(tab => tab.id === props.tabId)?.agentState?.steps
  .find(s => s.id === props.stepId)?.organization)
const tree = computed(() => organization.value ? buildOrgTree(organization.value) : [])
/** 全组织的概览：在干几人、做完几人、几人出问题 */
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

const artifactTeam = ref<{ name: string; owner?: string } | null>(null)
watch([() => props.tabId, () => props.stepId], () => { artifactTeam.value = null })
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
    <template v-else>
    <header class="oc-header">
      <div class="oc-tab">
      <span class="oc-title-icon" aria-hidden="true"><Network :size="14" /></span>
      <div class="oc-title">
        <span class="oc-title-name">{{ t('ai.organization.title') }}</span>
      </div>
      <button
        type="button"
        class="oc-icon-btn oc-close-btn"
        :title="t('ai.organization.close')"
        :aria-label="t('ai.organization.close')"
        @click="emit('close')"
      >
        <X :size="12" />
      </button>
      </div>
      <span v-if="organization" class="oc-title-meta">{{ t('ai.organization.metaSimple', { total: organization.total, teams: organization.teams.length + (organization.omittedTeams ?? 0) }) }}</span>
      <div class="oc-header-fill" />
      <button type="button" class="oc-icon-btn oc-focus-btn" :aria-pressed="focused" :title="focused ? t('canvas.splitDocument') : t('ai.organization.focus')" :aria-label="focused ? t('canvas.splitDocument') : t('ai.organization.focus')" @click="toggleFocus">
        <Minimize2 v-if="focused" :size="14" />
        <Maximize2 v-else :size="14" />
      </button>
    </header>

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
    </div>

    <div ref="bodyRef" class="oc-body">
      <div v-if="!organization" class="oc-empty">{{ t('ai.organization.empty') }}</div>
      <template v-else>
        <div class="oc-tree">
          <div class="oc-secretary">
            <span class="oc-secretary-avatar" aria-hidden="true"><UserRound :size="15" /></span>
            <span class="oc-secretary-name">{{ t('ai.organization.secretary') }}</span>
          </div>
          <OrganizationBranch :groups="tree" @open-team="emit('openTeam', $event)" @open-artifacts="artifactTeam = $event" />
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
.organization-chart.is-focus .oc-header { padding-left: max(12px, var(--shell-inset-left, 0px)); padding-right: calc(max(8px, var(--shell-inset-right, 0px)) + 36px); }
.organization-chart.is-focus .oc-body { padding-bottom: var(--assistant-focus-overlay, 22px); }

.oc-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  padding: 0 calc(max(8px, var(--shell-inset-right, 0px)) + 30px) 0 12px;
  background: var(--bg-tertiary, var(--bg-secondary, #252525));
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}
.oc-header .oc-icon-btn {
  -webkit-app-region: no-drag;
}
.oc-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.oc-icon-btn:hover { background: var(--bg-secondary); color: var(--text-primary); }
.oc-tab { display: flex; align-items: center; gap: 7px; min-width: 0; height: 28px; padding: 0 5px 0 9px; border-radius: 8px; background: var(--bg-secondary); -webkit-app-region: no-drag; }
.oc-tab .oc-close-btn { width: 18px; height: 18px; flex-shrink: 0; }
.oc-header-fill { flex: 1; align-self: stretch; }
.oc-focus-btn { width: 22px; height: 22px; flex-shrink: 0; border: 1px solid var(--border-color); border-radius: 5px; }
.oc-title-icon { display: inline-flex; color: var(--accent-primary); }
.oc-title { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.oc-title-name { font-size: 12px; font-weight: 500; white-space: nowrap; }
.oc-title-meta { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

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
