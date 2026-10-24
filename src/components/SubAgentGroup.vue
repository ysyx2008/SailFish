<script lang="ts">
import { reactive } from 'vue'

// 展开状态按「派出那一步」记在模块里：对话里和顶部挂着的是同一批人，两处一起展开、一起收起；
// 对话列表滚出屏幕再回来，也不丢
const subAgentExpandState = reactive(new Map<string, boolean>())
const subAgentListOpen = reactive(new Map<string, boolean>())
const subAgentPages = reactive(new Map<string, number>())
</script>

<script setup lang="ts">
/**
 * 派出的一批伙计 / 专家：折叠计数行、每人一张卡（点开看过程和结果）、专家团小卡片。
 * 对话里派出那一处和顶部挂着的那一行展开后，用的都是这个。
 */
import { useI18n } from 'vue-i18n'
import type { SubAgentResult, ExpertTeamView } from '@shared/types'
import { SUB_AGENT_FOLD_THRESHOLD, SUB_AGENT_PAGE_SIZE, formatSubAgentSummary, sortSubAgentsByBucket } from '../utils/sub-agent-summary'
import { toolDisplayName } from '../utils/tool-display'
import ExpertTeamCard from './ExpertTeam/ExpertTeamCard.vue'

const props = defineProps<{
  stepId: string
  subAgents: readonly SubAgentResult[]
  expertTeam?: ExpertTeamView
  /** 人多时也直接列出来，不先收成一行计数（顶部挂着那一行展开时用） */
  alwaysOpen?: boolean
  /** 不画外框和卡片框，一人一行、行间一条细线（放在已经有框的容器里时用） */
  plain?: boolean
  /** 不显示专家团那张小卡片（外面已经有群聊入口时） */
  hideTeamCard?: boolean
}>()
const emit = defineEmits<{ openTeam: [] }>()
const { t } = useI18n()

const isSubAgentExpanded = (key: string): boolean => subAgentExpandState.get(key) === true
const toggleSubAgentExpand = (key: string) => {
  subAgentExpandState.set(key, !isSubAgentExpanded(key))
}

// 伙计多了折叠成一行计数；点开按状态分组，一次显示一页
const isFolded = () => props.subAgents.length > SUB_AGENT_FOLD_THRESHOLD
const isListOpen = (): boolean => props.alwaysOpen === true || subAgentListOpen.get(props.stepId) === true
const toggleList = () => {
  subAgentListOpen.set(props.stepId, !isListOpen())
}
const showMore = () => {
  subAgentPages.set(props.stepId, (subAgentPages.get(props.stepId) ?? 1) + 1)
}
const shownLimit = (): number => {
  if (!isFolded()) return props.subAgents.length
  if (!isListOpen()) return 0
  return (subAgentPages.get(props.stepId) ?? 1) * SUB_AGENT_PAGE_SIZE
}
const visibleSubAgents = (): SubAgentResult[] => {
  if (!isFolded()) return [...props.subAgents]
  return sortSubAgentsByBucket(props.subAgents).slice(0, shownLimit())
}
const hiddenCount = (): number => {
  if (!isFolded() || !isListOpen()) return 0
  return Math.max(0, props.subAgents.length - shownLimit())
}
const summaryText = (): string => formatSubAgentSummary(t, props.subAgents)

/** 子 Agent 当前活动摘要（最新的 running 或最后一个已完成步骤的 tool+args） */
const getSubAgentActivity = (sa: SubAgentResult): string | null => {
  if (!sa.steps || sa.steps.length === 0) return null
  const running = [...sa.steps].reverse().find(s => s.status === 'running')
  const step = running || sa.steps[sa.steps.length - 1]
  const parts = [toolDisplayName(t, step.tool)]
  if (step.args) parts.push(step.args)
  return parts.join(' ')
}
</script>

<template>
  <div v-if="subAgents.length > 0" class="sub-agents-group" :class="{ plain }">
    <div v-if="isFolded() && !alwaysOpen" class="sub-agent-summary" @click="toggleList()">
      <span class="sub-agent-expand-icon" :class="{ expanded: isListOpen() }">▶</span>
      <span>{{ summaryText() }}</span>
    </div>
    <div
      v-for="sa in visibleSubAgents()"
      :key="sa.id"
      class="sub-agent-card"
      :class="[sa.status, { waiting: sa.status === 'running' && sa.waitingForModel }]"
    >
      <div class="sub-agent-header" @click="toggleSubAgentExpand(stepId + ':' + sa.id)">
        <span class="sub-agent-status-icon">
          <span v-if="sa.status === 'pending' || (sa.status === 'running' && sa.waitingForModel)" class="sa-icon-pending">○</span>
          <span v-else-if="sa.status === 'running'" class="sa-icon-running">◌</span>
          <span v-else-if="sa.status === 'completed'" class="sa-icon-completed">✓</span>
          <span v-else-if="sa.status === 'interrupted'" class="sa-icon-failed">⏹</span>
          <span v-else class="sa-icon-failed">✗</span>
        </span>
        <span class="sub-agent-header-text">
          <span class="sub-agent-desc"><span v-if="sa.role" class="sub-agent-role">{{ sa.role }}</span>{{ sa.name ? `${sa.name} · ${sa.description}` : sa.description }}</span>
          <span v-if="sa.status === 'running' && getSubAgentActivity(sa)" class="sub-agent-activity">⟳ {{ getSubAgentActivity(sa) }}</span>
          <span v-if="sa.blockedReason" class="sub-agent-activity">{{ sa.blockedReason }}</span>
        </span>
        <span class="sub-agent-status-text">
          {{ sa.status === 'running' && sa.waitingForModel ? t('ai.subAgentWaitingModel') : t(`ai.subAgent${sa.status.charAt(0).toUpperCase() + sa.status.slice(1)}`) }}
        </span>
        <span v-if="sa.prompt || sa.result || sa.error || (sa.steps && sa.steps.length > 0)" class="sub-agent-expand-icon" :class="{ expanded: isSubAgentExpanded(stepId + ':' + sa.id) }">▶</span>
      </div>
      <div v-if="isSubAgentExpanded(stepId + ':' + sa.id)" class="sub-agent-detail">
        <div v-if="sa.prompt" class="sub-agent-prompt">{{ sa.prompt }}</div>
        <div v-if="sa.steps && sa.steps.length > 0" class="sub-agent-steps">
          <div v-for="(step, stepIdx) in sa.steps" :key="stepIdx" class="sa-step" :class="step.status">
            <span class="sa-step-icon">
              <span v-if="step.status === 'running'" class="sa-step-running">⟳</span>
              <span v-else-if="step.status === 'completed'" class="sa-step-done">✓</span>
              <span v-else class="sa-step-fail">✗</span>
            </span>
            <span class="sa-step-tool">{{ toolDisplayName(t, step.tool) }}</span>
            <span v-if="step.args" class="sa-step-args" :title="step.args">{{ step.args }}</span>
          </div>
        </div>
        <div v-if="sa.result" class="sub-agent-result">
          <pre>{{ sa.result }}</pre>
        </div>
        <div v-if="sa.error" class="sub-agent-result">
          <pre class="sub-agent-error">{{ sa.error }}</pre>
        </div>
      </div>
    </div>
    <button v-if="hiddenCount() > 0" type="button" class="sub-agent-more" @click="showMore()">
      {{ t('ai.subAgentShowMore', { count: Math.min(SUB_AGENT_PAGE_SIZE, hiddenCount()), rest: hiddenCount() }) }}
    </button>
    <ExpertTeamCard v-if="expertTeam && !hideTeamCard" :team="expertTeam" @open="emit('openTeam')" />
  </div>
</template>

<style scoped>
.sub-agents-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  background: rgba(0, 0, 0, 0.15);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.sub-agent-card {
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.sub-agent-card.running {
  border-color: rgba(var(--color-info-rgb), 0.4);
}

.sub-agent-card.completed {
  border-color: rgba(var(--color-success-rgb), 0.3);
}

.sub-agent-card.failed {
  border-color: rgba(var(--color-error-rgb), 0.3);
}

.sub-agent-card.running.waiting {
  border-color: rgba(255, 255, 255, 0.08);
}

.sub-agent-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
  border-radius: 6px;
}

.sub-agent-summary:hover {
  background: rgba(255, 255, 255, 0.04);
}

.sub-agent-more {
  align-self: flex-start;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  cursor: pointer;
}

.sub-agent-more:hover {
  background: rgba(255, 255, 255, 0.04);
}

.sub-agent-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
}

.sub-agent-header .sub-agent-status-icon,
.sub-agent-header .sub-agent-status-text,
.sub-agent-header .sub-agent-expand-icon {
  margin-top: 1px;
}

.sub-agent-header:hover {
  background: rgba(255, 255, 255, 0.04);
}

.sub-agent-status-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  font-size: 12px;
}

.sa-icon-pending {
  color: var(--text-muted);
}

.sa-icon-running {
  color: var(--color-info);
  animation: sa-spin 1.2s linear infinite;
}

.sa-icon-completed {
  color: var(--color-success);
}

.sa-icon-failed {
  color: var(--color-error);
}

@keyframes sa-spin {
  0% { opacity: 0.4; }
  50% { opacity: 1; }
  100% { opacity: 0.4; }
}

.sub-agent-header-text {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}

.sub-agent-desc {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sub-agent-role {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 11px;
  line-height: 16px;
  vertical-align: 1px;
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.12);
}

.sub-agent-activity {
  font-size: 11px;
  color: var(--color-info);
  opacity: 0.8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: sa-spin 1.5s ease-in-out infinite;
}

.sub-agent-status-text {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
}

.sub-agent-card.running .sub-agent-status-text {
  color: var(--color-info);
}

.sub-agent-card.running.waiting .sub-agent-status-text {
  color: var(--text-muted);
}

.sub-agent-card.completed .sub-agent-status-text {
  color: var(--color-success);
}

.sub-agent-card.failed .sub-agent-status-text {
  color: var(--color-error);
}

.sub-agent-expand-icon {
  flex-shrink: 0;
  font-size: 9px;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.sub-agent-expand-icon.expanded {
  transform: rotate(90deg);
}

.sub-agent-detail {
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: rgba(0, 0, 0, 0.1);
}

.sub-agent-prompt {
  padding: 6px 10px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.sub-agent-steps {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sa-step {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-muted);
}

.sa-step-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 10px;
}

.sa-step-running { color: var(--color-info); }
.sa-step-done { color: var(--color-success); }
.sa-step-fail { color: var(--color-error); }

.sa-step-tool {
  flex-shrink: 0;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 11px;
}

.sa-step-args {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  white-space: pre-wrap;
  word-break: break-all;
}

.sub-agent-result {
  padding: 6px 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.04);
}

.sub-agent-result pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 300px;
  overflow-y: auto;
}

.sub-agent-result pre.sub-agent-error {
  color: var(--color-error);
}

/* 平铺：放在已经有框的面板里，一人一行 */
.sub-agents-group.plain {
  gap: 0;
  padding: 0;
  background: none;
  border: none;
  border-radius: 0;
}

.sub-agents-group.plain .sub-agent-card {
  border: none;
  background: transparent;
  border-radius: 8px;
}

.sub-agents-group.plain .sub-agent-card + .sub-agent-card {
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 0;
}

.sub-agents-group.plain .sub-agent-header {
  padding: 8px 10px;
  border-radius: 8px;
}

.sub-agents-group.plain .sub-agent-detail {
  margin: 0 6px 6px;
  border-top: none;
  border-radius: 6px;
}
</style>
