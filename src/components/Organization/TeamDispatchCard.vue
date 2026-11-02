<script setup lang="ts">
/** 对话中的小团队直接显示成员；大团队沿用紧凑入口。 */
import { computed } from 'vue'
import type { AgentStep, OrganizationView } from '@shared/types'
import { SUB_AGENT_FOLD_THRESHOLD } from '../../utils/sub-agent-summary'
import { teamMemberList } from '../../utils/team-member-list'
import { teamMemberSnapshots } from '../../utils/team-view'
import OrganizationCard from './OrganizationCard.vue'
import TeamMemberTree from './TeamMemberTree.vue'

const props = defineProps<{ organization: OrganizationView; stepId: string; steps: readonly AgentStep[]; sessionId?: string }>()
const emit = defineEmits<{ open: [member?: string] }>()
const inline = computed(() => props.organization.total > 0
  && props.organization.total <= SUB_AGENT_FOLD_THRESHOLD
  && !props.organization.omitted
  && props.organization.members.length === props.organization.total)
const list = computed(() => inline.value ? teamMemberList(props.organization, SUB_AGENT_FOLD_THRESHOLD) : undefined)
const snapshots = computed(() => inline.value ? teamMemberSnapshots(props.steps, props.stepId, props.sessionId) : undefined)
const snapshotFor = (name: string) => snapshots.value?.get(name)
</script>

<template>
  <div class="team-dispatch-card" :class="{ 'is-inline': inline }">
    <OrganizationCard :organization="organization" @open="emit('open')" />
    <TeamMemberTree v-if="list" :groups="list.groups" :step-id="stepId" :session-id="organization.sessionId ?? sessionId" :snapshot-for="snapshotFor" @open="emit('open', $event)" />
  </div>
</template>

<style scoped>
.is-inline > .team-member-tree {
  margin-top: 4px;
  padding: 4px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
}
</style>
