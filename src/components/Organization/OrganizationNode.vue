<script setup lang="ts">
/**
 * 组织图上的一个人。所有层级共用这一张卡片，保证同一层和跨层看起来是同一种东西。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Crown, ShieldCheck } from 'lucide-vue-next'
import type { OrgNode } from '../../utils/organization-view'
import { avatarHue, avatarInitial } from '../../utils/expert-team-view'

const props = defineProps<{ node: OrgNode }>()
const { t } = useI18n()

const avatarStyle = (name: string) => ({ background: `hsl(${avatarHue(name)} 45% 38%)` })
const tip = computed(() => [
  props.node.member.name,
  props.node.member.role,
  props.node.member.lead ? t('ai.organization.lead') : '',
  props.node.member.reviewer ? t('ai.organization.reviewer') : '',
  t(`ai.expertTeam.status.${props.node.bucket}`),
  props.node.member.description,
].filter(Boolean).join(' · '))
</script>

<template>
  <div class="org-node" :class="[`is-${node.bucket}`, { 'is-lead': node.member.lead }]" :title="tip">
    <span class="org-avatar" :style="avatarStyle(node.member.name)" aria-hidden="true">
      {{ avatarInitial(node.member.name) }}
      <i class="org-dot" :class="`is-${node.bucket}`" />
    </span>
    <span class="org-node-text">
      <span class="org-node-name">
        <span class="org-node-name-text">{{ node.member.name }}</span>
        <Crown v-if="node.member.lead" :size="11" class="org-crown" :aria-label="t('ai.organization.lead')" />
      </span>
      <span class="org-node-sub">
        <template v-if="node.member.role">{{ node.member.role }} · </template>{{ t(`ai.expertTeam.status.${node.bucket}`) }}
      </span>
    </span>
    <ShieldCheck v-if="node.member.reviewer" :size="13" class="org-reviewer" :aria-label="t('ai.organization.reviewer')" />
  </div>
</template>

<style scoped>
.org-node {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 150px;
  max-width: 224px;
  padding: 5px 10px 5px 6px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-surface, var(--bg-secondary));
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
}
.org-node.is-lead { border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.55); }

.org-avatar {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

.org-dot {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--bg-surface, var(--bg-primary));
  background: var(--text-secondary);
}
.org-dot.is-running { background: var(--accent-primary); }
.org-dot.is-waiting { background: var(--color-warning, #e5c07b); }
.org-dot.is-completed { background: var(--color-success, #98c379); }
.org-dot.is-failed { background: var(--color-danger, #e06c75); }
.org-dot.is-interrupted { background: var(--text-secondary); }

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
.org-node-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-secondary);
}
.org-reviewer { flex-shrink: 0; color: var(--accent-primary); }
</style>
