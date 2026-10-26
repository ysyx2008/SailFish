<script setup lang="ts">
/**
 * 组织图里一位主人（秘书或组长）名下的几组人。组长名下又是一个同样的分支，自己调用自己。
 */
import { useI18n } from 'vue-i18n'
import { Crown, MessagesSquare, ShieldCheck } from 'lucide-vue-next'
import type { OrgGroup, OrgNode } from '../../utils/organization-view'
import { avatarHue, avatarInitial } from '../../utils/expert-team-view'

defineProps<{ groups: readonly OrgGroup[] }>()
const emit = defineEmits<{ openTeam: [teamName: string] }>()
const { t } = useI18n()

const avatarStyle = (name: string) => ({ background: `hsl(${avatarHue(name)} 42% 32%)` })
const tip = (node: OrgNode) => [
  node.member.name,
  node.member.role,
  node.member.lead ? t('ai.organization.lead') : '',
  node.member.reviewer ? t('ai.organization.reviewer') : '',
  t(`ai.expertTeam.status.${node.bucket}`),
  node.member.description,
].filter(Boolean).join(' · ')
</script>

<template>
  <div class="org-groups">
    <div v-for="(group, index) in groups" :key="group.team?.name ?? `loose-${index}`" class="org-group" :class="{ 'is-team': !!group.team }">
      <div v-if="group.team" class="org-team-head">
        <span class="org-team-name">{{ t('ai.organization.teamTitle', { team: group.team.name }) }}</span>
        <span class="org-review" :class="`is-${group.team.review}`">{{ t(`ai.organization.review.${group.team.review}`) }}</span>
        <button
          type="button"
          class="org-team-chat"
          :title="t('ai.organization.openTeamChat')"
          @click="emit('openTeam', group.team.name)"
        >
          <MessagesSquare :size="12" />
          <span>{{ t('ai.organization.teamChat', { count: group.team.messageCount }) }}</span>
        </button>
      </div>
      <ul class="org-nodes">
        <li v-for="node in group.nodes" :key="node.member.id" class="org-node">
          <div class="org-chip" :class="[`is-${node.bucket}`, { 'is-lead': node.member.lead }]" :title="tip(node)">
            <span class="org-avatar" :style="avatarStyle(node.member.name)" aria-hidden="true">
              <Crown v-if="node.member.lead" :size="12" />
              <template v-else>{{ avatarInitial(node.member.name) }}</template>
              <i class="org-dot" :class="`is-${node.bucket}`" />
            </span>
            <span class="org-chip-text">
              <span class="org-chip-name">{{ node.member.name }}</span>
              <span class="org-chip-sub">
                <template v-if="node.member.role">{{ node.member.role }} · </template>{{ t(`ai.expertTeam.status.${node.bucket}`) }}
              </span>
            </span>
            <ShieldCheck v-if="node.member.reviewer" :size="13" class="org-reviewer" :aria-label="t('ai.organization.reviewer')" />
          </div>
          <OrganizationBranch v-if="node.groups.length" :groups="node.groups" class="org-sub" @open-team="emit('openTeam', $event)" />
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.org-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.org-group.is-team {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  padding: 6px 8px 8px;
}

.org-team-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}

.org-team-name {
  font-weight: 600;
  color: var(--text-primary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.org-review {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}
.org-review.is-pass { color: var(--color-success, #98c379); background: rgba(var(--color-success-rgb, 152, 195, 121), 0.14); }
.org-review.is-reject { color: var(--color-danger, #e06c75); background: rgba(var(--color-danger-rgb, 224, 108, 117), 0.14); }
.org-review.is-pending { color: var(--color-warning, #e5c07b); background: rgba(var(--color-warning-rgb, 229, 192, 123), 0.12); }

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

.org-nodes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px 8px;
  align-items: flex-start;
}

.org-node {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.org-node:has(> .org-sub) { flex-basis: 100%; }

.org-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 220px;
  padding: 4px 9px 4px 5px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  font-size: 12px;
  color: var(--text-primary);
}
.org-chip.is-lead { border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.5); }

.org-avatar {
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
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
  border: 1.5px solid var(--bg-primary);
  background: var(--text-secondary);
}
.org-dot.is-running { background: var(--accent-primary); }
.org-dot.is-waiting { background: var(--color-warning, #e5c07b); }
.org-dot.is-completed { background: var(--color-success, #98c379); }
.org-dot.is-failed { background: var(--color-danger, #e06c75); }
.org-dot.is-interrupted { background: var(--text-secondary); }

.org-chip-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.org-chip-name, .org-chip-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-chip-sub { font-size: 11px; color: var(--text-secondary); }
.org-reviewer { flex-shrink: 0; color: var(--accent-primary); }

/* 组长名下缩进一格，左边一条线表示隶属 */
.org-sub {
  margin-left: 14px;
  padding-left: 12px;
  border-left: 2px solid var(--border-color);
}
</style>
