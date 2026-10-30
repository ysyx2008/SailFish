<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { Crown, ShieldCheck } from 'lucide-vue-next'
import type { OrgNode } from '../../utils/organization-view'
import OrganizationStatusBadge from './OrganizationStatusBadge.vue'
import { useTeamVisibility } from './team-viewport'
defineProps<{ node: OrgNode }>()
const emit = defineEmits<{ open: [] }>()
const { t, locale } = useI18n()
const { element, visible } = useTeamVisibility()
</script>

<template>
  <button ref="element" v-memo="[visible, visible ? node : null, locale]" type="button" class="tmt-member" :data-member="node.member.name" :aria-label="[node.member.name, node.member.role, node.member.description, t(`ai.expertTeam.status.${node.bucket}`)].filter(Boolean).join(' · ')" @click="emit('open')">
    <template v-if="visible">
    <span class="tmt-name-row">
      <Crown v-if="node.member.lead" :size="12" :aria-label="t('ai.organization.lead')" />
      <span class="tmt-name">{{ node.member.name }}</span>
      <ShieldCheck v-if="node.member.reviewer" :size="12" :aria-label="t('ai.organization.reviewer')" />
      <span v-if="node.member.role" class="tmt-role">{{ node.member.role }}</span>
    </span>
    <span v-if="node.member.description" class="tmt-duty" :title="node.member.description">{{ node.member.description }}</span>
    <OrganizationStatusBadge class="tmt-status" :bucket="node.bucket" :label="t(`ai.expertTeam.status.${node.bucket}`)" compact />
    </template>
  </button>
</template>

<style scoped>
.tmt-member { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; row-gap: 3px; align-items: center; box-sizing: border-box; width: 100%; height: 48px; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--text-primary); text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
.tmt-member:hover { background: var(--bg-tertiary); }
.tmt-member:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.tmt-name-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tmt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tmt-role { min-width: 0; color: var(--text-secondary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tmt-name-row > svg { flex-shrink: 0; color: var(--text-secondary); }
.tmt-duty { grid-column: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-size: 11px; }
.tmt-status { grid-column: 2; grid-row: 1 / span 2; }
</style>
