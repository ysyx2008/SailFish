<script setup lang="ts">
/**
 * 组织图上的一个人。所有层级共用这一张卡片。
 * 身份决定节点结构，状态决定描边和底色；两者互不覆盖。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, ShieldCheck } from 'lucide-vue-next'
import type { OrgNode } from '../../utils/organization-view'
import { toolDisplayName } from '../../utils/tool-display'
import { avatarInitial } from '../../utils/expert-team-view'
import { useTeamVisibility } from './team-viewport'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = defineProps<{ node: OrgNode; selected?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const { t, locale } = useI18n()
const { element, visible } = useTeamVisibility()
const activity = computed(() => {
  const step = props.node.member.activity
  return step ? [toolDisplayName(t, step.tool), step.args].filter(Boolean).join(' ') : ''
})
const hasActivity = computed(() => props.node.bucket === 'running' && !!activity.value)

const statusLabel = computed(() => t(`ai.expertTeam.status.${props.node.bucket}`))
const tip = computed(() => [
  props.node.member.name,
  props.node.member.role,
  props.node.member.lead ? t('ai.organization.lead') : '',
  props.node.member.reviewer ? t('ai.organization.reviewer') : '',
  statusLabel.value,
  props.node.member.description,
].filter(Boolean).join(' · '))
</script>

<template>
  <div
    ref="element"
    v-memo="[visible, visible ? node : null, locale, selected]"
    class="org-node"
    :class="[`is-${node.bucket}`, { 'is-lead': node.member.lead, 'is-selected': selected }]"
    :data-status="node.bucket"
    :data-member="node.member.name"
    :data-parent="node.member.parent ?? ''"
    :data-team="node.member.team ?? ''"
    :title="tip"
    :aria-label="tip"
    :aria-pressed="!!selected"
    role="button"
    tabindex="0"
    @click.stop="emit('open')"
    @keydown.enter.stop.prevent="emit('open')"
    @keydown.space.stop.prevent="emit('open')"
  >
    <template v-if="visible">
    <span class="org-node-heading">
    <span class="org-avatar" aria-hidden="true">
      {{ avatarInitial(node.member.name) }}
    </span>
      <span class="org-node-name">
        <span class="org-node-name-text">{{ node.member.name }}</span>
        <ShieldCheck v-if="node.member.reviewer" :size="12" class="org-reviewer" :aria-label="t('ai.organization.reviewer')" />
      </span>
      <span v-if="node.member.lead" class="org-node-rank"><Crown :size="10" aria-hidden="true" />{{ t('ai.organization.lead') }}</span>
    <OrganizationStatusBadge :bucket="node.bucket" :label="statusLabel" compact />
    </span>
    <span v-if="node.member.description" class="org-node-duty" :title="node.member.description">{{ node.member.description }}</span>
    <span v-if="hasActivity" class="org-node-activity" :title="activity">{{ activity }}</span>
    </template>
  </div>
</template>

<style scoped>
.org-node {
  --node-tone: var(--text-secondary);
  cursor: pointer;
  position: relative;
  box-sizing: border-box;
  display: inline-flex;
  flex-direction: column;
  width: 200px;
  /* 固定预留活动行；状态变化和屏外回收都不改变网格尺寸。 */
  height: 76px;
  min-width: 0;
  flex-shrink: 0;
  padding: 8px;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  border-color: color-mix(in srgb, var(--node-tone) 64%, var(--border-color));
  background: color-mix(in srgb, var(--node-tone) 7%, var(--bg-primary));
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--node-tone) 10%, transparent), 0 2px 5px #0000000c;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}
.org-node:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 3px; }
.org-node.is-selected { outline: 2px solid var(--accent-primary); outline-offset: 3px; }
.org-node:hover { filter: brightness(1.08); }
.org-node.is-running { --node-tone: var(--accent-primary); }
.org-node.is-waiting { --node-tone: var(--color-warning, #e5c07b); }
.org-node.is-completed { --node-tone: var(--color-success, #98c379); }
.org-node.is-failed { --node-tone: var(--color-danger, #e06c75); }
.org-node.is-interrupted { border-style: dashed; }

/* 组长用同行身份标记和双层边框区分，不再多占一条身份栏。 */
.org-node.is-lead {
  border-width: 2px;
  padding: 7px;
  border-radius: 8px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--node-tone) 9%, transparent), 0 2px 5px #00000012;
}
.org-node-heading { display: flex; align-items: center; gap: 7px; width: 100%; min-width: 0; min-height: 20px; line-height: 16px; }
.org-node-rank {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 3px;
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--node-tone) 10%, transparent);
  color: var(--text-secondary);
  font-size: 10px;
  line-height: 18px;
}

.org-avatar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  box-sizing: border-box;
  border: 1px solid color-mix(in srgb, var(--node-tone) 30%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--node-tone) 12%, transparent);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
}
.org-node-name {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-weight: 600;
}
.org-node-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-reviewer { flex-shrink: 0; color: var(--color-success, #98c379); }
.org-node-duty, .org-node-activity { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; line-height: 16px; }
.org-node-duty { margin-top: 4px; }
.org-node-activity { margin-top: 2px; }
.org-node-duty { color: var(--text-primary); }
.org-node-activity { color: var(--text-muted); }
/* 只让执行节点里的状态点呼吸，整张卡片和汇总行保持静止。 */
.org-node.is-running :deep(.org-status-dot) {
  animation: org-node-working 2.4s ease-in-out infinite;
}
@keyframes org-node-working {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 transparent; }
  50% { opacity: 0.65; box-shadow: 0 0 0 3px color-mix(in srgb, var(--node-tone) 15%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .org-node { transition: none; }
  .org-node.is-running :deep(.org-status-dot) { animation: none; }
}
</style>
