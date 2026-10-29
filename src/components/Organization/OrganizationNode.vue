<script setup lang="ts">
/**
 * 组织图上的一个人。所有层级共用这一张卡片。
 * 状态放在卡片右侧的彩色标签里，颜色、图标和文字一起看，扫一眼就知道谁在干、谁做完了。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, ShieldCheck } from 'lucide-vue-next'
import type { OrgNode } from '../../utils/organization-view'
import { avatarHue, avatarInitial } from '../../utils/expert-team-view'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

const props = defineProps<{ node: OrgNode }>()
const { t } = useI18n()

const avatarStyle = (name: string) => ({ background: `hsl(${avatarHue(name)} 45% 38%)` })
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
    <span class="org-avatar" :style="avatarStyle(node.member.name)" aria-hidden="true">
      {{ avatarInitial(node.member.name) }}
    </span>
    <span class="org-node-text">
      <span class="org-node-name">
        <span class="org-node-name-text">{{ node.member.name }}</span>
        <Crown v-if="node.member.lead" :size="11" class="org-crown" :aria-label="t('ai.organization.lead')" />
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
  --org-accent: var(--border-color);
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 170px;
  max-width: 230px;
  padding: 6px 8px 6px 7px;
  border: 1px solid var(--border-color);
  border-left: 2px solid var(--org-accent);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  transition: border-color 0.15s ease;
}
.org-node.is-running { --org-accent: var(--accent-primary); }
.org-node.is-waiting { --org-accent: var(--color-warning, #e5c07b); }
.org-node.is-completed { --org-accent: var(--color-success, #98c379); }
.org-node.is-failed { --org-accent: var(--color-danger, #e06c75); }
.org-node.is-interrupted { --org-accent: var(--text-secondary); }

.org-avatar {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

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
.org-crown { flex-shrink: 0; color: var(--accent-primary); }
.org-reviewer { flex-shrink: 0; color: var(--color-success, #98c379); }
.org-node-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--text-secondary);
}
</style>
