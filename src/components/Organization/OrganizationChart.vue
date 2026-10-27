<script setup lang="ts">
/**
 * 项目组织图：秘书在最上面，名下按团分组，组长名下再分组，一层层缩进。
 * 点某个团的「群聊」打开那个团的完整群聊。内容随派出组长的那一步实时更新。
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, X, Network, UserRound } from 'lucide-vue-next'
import { useTerminalStore } from '../../stores/terminal'
import { buildOrgTree } from '../../utils/organization-view'
import OrganizationBranch from './OrganizationBranch.vue'

const props = withDefaults(defineProps<{
  tabId: string
  /** 派出组长的那一步 */
  stepId: string
  /** panel：右侧面板，右上角关掉；overlay：盖在对话栏上，左上角返回对话 */
  mode?: 'panel' | 'overlay'
}>(), { mode: 'overlay' })
const emit = defineEmits<{ close: []; openTeam: [team: { name: string; owner?: string }] }>()

const { t } = useI18n()
const terminalStore = useTerminalStore()

const organization = computed(() => terminalStore.tabs
  .find(tab => tab.id === props.tabId)?.agentState?.steps
  .find(s => s.id === props.stepId)?.organization)
const tree = computed(() => organization.value ? buildOrgTree(organization.value) : [])

const bodyRef = ref<HTMLElement | null>(null)

/** 树比面板宽时，把初始横向滚动放到中间，根节点不会一打开就在视口外 */
const centerTree = () => {
  const body = bodyRef.value
  if (!body) return
  const overflow = body.scrollWidth - body.clientWidth
  if (overflow > 0) body.scrollLeft = overflow / 2
}

onMounted(() => {
  // 各层分支在自己 mounted 里已经自底向上量完并撑好；这里量的是最终宽度
  centerTree()
})
</script>

<template>
  <section class="organization-chart" :class="`is-${mode}`">
    <header class="oc-header">
      <button
        v-if="mode === 'overlay'"
        type="button"
        class="oc-icon-btn"
        :title="t('ai.organization.back')"
        :aria-label="t('ai.organization.back')"
        @click="emit('close')"
      >
        <ArrowLeft :size="15" />
      </button>
      <span class="oc-title-icon" aria-hidden="true"><Network :size="14" /></span>
      <div class="oc-title">
        <span class="oc-title-name">{{ t('ai.organization.title') }}</span>
        <span v-if="organization" class="oc-title-meta">
          {{ t('ai.organization.meta', { total: organization.total, live: organization.live, teams: organization.teams.length }) }}
        </span>
      </div>
      <button
        v-if="mode === 'panel'"
        type="button"
        class="oc-icon-btn"
        :title="t('ai.organization.close')"
        :aria-label="t('ai.organization.close')"
        @click="emit('close')"
      >
        <X :size="15" />
      </button>
    </header>

    <div ref="bodyRef" class="oc-body">
      <div v-if="!organization" class="oc-empty">{{ t('ai.organization.empty') }}</div>
      <template v-else>
        <div class="oc-tree">
          <div class="oc-secretary">
            <span class="oc-secretary-avatar" aria-hidden="true"><UserRound :size="15" /></span>
            <span class="oc-secretary-name">{{ t('ai.organization.secretary') }}</span>
          </div>
          <OrganizationBranch :groups="tree" @open-team="emit('openTeam', $event)" />
        </div>
        <p v-if="organization.omitted" class="oc-omitted">
          {{ t('ai.organization.omitted', { count: organization.omitted, path: organization.boardPath ?? '' }) }}
        </p>
        <p v-if="organization.omittedTeams" class="oc-omitted">
          {{ t('ai.organization.omittedTeams', { count: organization.omittedTeams, path: organization.boardPath ?? '' }) }}
        </p>
      </template>
    </div>
  </section>
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

.oc-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  padding: 0 10px;
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
.oc-title-icon { display: inline-flex; color: var(--accent-primary); }
.oc-title { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.oc-title-name { font-size: 13px; font-weight: 600; }
.oc-title-meta { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.oc-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 16px 24px;
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
  padding: 6px 14px 6px 6px;
  border-radius: 12px;
  border: 1px solid rgba(var(--accent-rgb, 137, 180, 250), 0.55);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.1);
  font-size: 13px;
  font-weight: 600;
}
.oc-secretary-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #fff;
  background: var(--accent-primary);
}
.oc-omitted { margin-top: 14px; font-size: 11px; color: var(--text-secondary); word-break: break-all; text-align: center; }
</style>
