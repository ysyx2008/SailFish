<script setup lang="ts">
/** 快捷名单复用全景图层级；成员行按同一视口策略绘制。 */
import { MessagesSquare } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { SubAgentResult } from '@shared/types'
import type { OrgGroup } from '../../utils/organization-view'
import TeamMemberRow from './TeamMemberRow.vue'
defineProps<{ groups: OrgGroup[]; stepId: string; sessionId?: string; snapshotFor?: (name: string) => SubAgentResult | undefined }>()
const emit = defineEmits<{ open: [name: string] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="team-member-tree">
    <li v-for="group in groups" :key="JSON.stringify([group.team?.teamId, group.team?.owner, group.team?.name])" class="tmt-group">
      <div v-if="group.team" class="tmt-group-title"><MessagesSquare :size="12" aria-hidden="true" /><span>{{ t('ai.organization.teamTitle', { team: group.team.name }) }}</span></div>
      <ul class="tmt-members">
        <li v-for="node in group.nodes" :key="node.member.id" class="tmt-node">
          <TeamMemberRow :node="node" :step-id="stepId" :session-id="sessionId" :snapshot-for="snapshotFor" @open="emit('open', node.member.name)" />
          <TeamMemberTree v-if="node.groups.length" :groups="node.groups" :step-id="stepId" :session-id="sessionId" :snapshot-for="snapshotFor" @open="emit('open', $event)" />
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
ul { list-style: none; margin: 0; padding: 0; }
.tmt-node + .tmt-node { border-top: 1px solid rgba(255, 255, 255, 0.05); }
.tmt-group + .tmt-group { margin-top: 4px; }
.tmt-group-title { display: flex; align-items: center; gap: 5px; padding: 6px 8px 3px; color: var(--text-muted); font-size: 11px; }
.tmt-group-title span { overflow-wrap: anywhere; }
.tmt-node > .team-member-tree { margin: 0 0 3px 15px; padding-left: 8px; border-left: 1px solid var(--border-color); }
</style>
