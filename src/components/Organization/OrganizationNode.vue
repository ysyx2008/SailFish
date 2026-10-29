<script setup lang="ts">
/**
 * 组织图上的一个人。所有层级共用这一张卡片。
 * 身份决定节点结构，状态决定描边和底色；两者互不覆盖。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, ShieldCheck } from 'lucide-vue-next'
import type { OrgNode } from '../../utils/organization-view'
import { avatarInitial } from '../../utils/expert-team-view'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = defineProps<{ node: OrgNode }>()
const { t } = useI18n()

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
    class="org-node"
    :class="[`is-${node.bucket}`, { 'is-lead': node.member.lead }]"
    :data-status="node.bucket"
    :title="tip"
    :aria-label="tip"
  >
    <span v-if="node.member.lead" class="org-node-rank">
      <Crown :size="11" aria-hidden="true" />
      {{ t('ai.organization.lead') }}
    </span>
    <span class="org-avatar" aria-hidden="true">
      {{ avatarInitial(node.member.name) }}
    </span>
    <span class="org-node-text">
      <span class="org-node-name">
        <span class="org-node-name-text">{{ node.member.name }}</span>
        <ShieldCheck v-if="node.member.reviewer" :size="12" class="org-reviewer" :aria-label="t('ai.organization.reviewer')" />
      </span>
      <span v-if="node.member.role || node.member.description" class="org-node-sub">
        {{ node.member.role || node.member.description }}
      </span>
    </span>
    <OrganizationStatusBadge :bucket="node.bucket" :label="statusLabel" compact />
  </div>
</template>

<style scoped>
.org-node {
  --node-tone: var(--text-secondary);
  position: relative;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 190px;
  max-width: 240px;
  padding: 10px;
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
.org-node.is-running { --node-tone: var(--accent-primary); }
.org-node.is-waiting { --node-tone: var(--color-warning, #e5c07b); }
.org-node.is-completed { --node-tone: var(--color-success, #98c379); }
.org-node.is-failed { --node-tone: var(--color-danger, #e06c75); }
.org-node.is-interrupted { border-style: dashed; }

/* 组长始终有独立身份栏和双层框，完成变绿后仍认得身份。 */
.org-node.is-lead {
  min-width: 220px;
  max-width: 260px;
  padding: 30px 12px 12px;
  border-width: 2px;
  border-radius: 10px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--node-tone) 9%, transparent), 0 4px 10px #00000012;
}
.org-node-rank {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 21px;
  padding: 0 11px;
  border-bottom: 1px solid color-mix(in srgb, var(--node-tone) 24%, transparent);
  border-radius: 8px 8px 0 0;
  background: color-mix(in srgb, var(--node-tone) 10%, transparent);
  color: var(--text-secondary);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.org-avatar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid color-mix(in srgb, var(--node-tone) 30%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--node-tone) 12%, transparent);
  color: var(--text-primary);
  font-size: 11px;
  font-weight: 600;
}
.is-lead .org-avatar { width: 34px; height: 34px; border-radius: 9px 3px; font-size: 14px; }
.is-lead .org-node-name { font-size: 13px; }

.org-node-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: 1.25;
}
.org-node-name {
  display: flex;
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
.org-node-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--text-secondary);
}
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
