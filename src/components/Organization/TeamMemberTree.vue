<script setup lang="ts">
/** 紧凑名单复用全景图的真实分组和状态；嵌套列表保持负责人层级。 */
import { useI18n } from 'vue-i18n'
import { Crown, ShieldCheck, Users } from 'lucide-vue-next'
import type { OrgGroup } from '../../utils/organization-view'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'

defineProps<{ groups: OrgGroup[] }>()
const emit = defineEmits<{ open: [name: string] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="team-member-tree">
    <li v-for="(group, index) in groups" :key="group.team?.name ?? index" class="tmt-group">
      <div v-if="group.team" class="tmt-group-title"><Users :size="12" aria-hidden="true" /><span>{{ group.team.name }}</span></div>
      <ul class="tmt-members">
        <li v-for="node in group.nodes" :key="node.member.id" class="tmt-node">
          <button type="button" class="tmt-member" @click="emit('open', node.member.name)">
            <span class="tmt-name-row">
              <Crown v-if="node.member.lead" :size="12" :aria-label="t('ai.organization.lead')" />
              <span class="tmt-name">{{ node.member.name }}</span>
              <ShieldCheck v-if="node.member.reviewer" :size="12" :aria-label="t('ai.organization.reviewer')" />
              <span v-if="node.member.role" class="tmt-role">{{ node.member.role }}</span>
            </span>
            <span v-if="node.member.description" class="tmt-duty" :title="node.member.description">{{ node.member.description }}</span>
            <OrganizationStatusBadge class="tmt-status" :bucket="node.bucket" :label="t(`ai.expertTeam.status.${node.bucket}`)" compact />
          </button>
          <TeamMemberTree v-if="node.groups.length" :groups="node.groups" @open="emit('open', $event)" />
        </li>
      </ul>
    </li>
  </ul>
</template>

<style scoped>
ul { list-style: none; margin: 0; padding: 0; }
.tmt-group + .tmt-group { margin-top: 4px; }
.tmt-group-title { display: flex; align-items: center; gap: 5px; padding: 6px 8px 3px; color: var(--text-muted); font-size: 11px; }
.tmt-group-title span { overflow-wrap: anywhere; }
.tmt-node > .team-member-tree { margin: 0 0 3px 15px; padding-left: 8px; border-left: 1px solid var(--border-color); }
.tmt-member { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; row-gap: 3px; align-items: center; width: 100%; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-primary); text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
.tmt-member:hover { background: var(--bg-tertiary); }
.tmt-member:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.tmt-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tmt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tmt-role { min-width: 0; color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tmt-name-row > svg { flex-shrink: 0; color: var(--text-secondary); }
.tmt-duty { grid-column: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 11px; }
.tmt-status { grid-column: 2; grid-row: 1 / span 2; }
</style>
