<script setup lang="ts">
/** 独立团队内的对象详情：标题/关闭固定，内容由页签选择。 */
import { computed, nextTick, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessagesSquare, UserRound } from 'lucide-vue-next'
import type { OrganizationMemberView, SubAgentResult, TeamArtifactSource } from '@shared/types'
import type { ArtifactPanelBindings } from '@sailfish/workbench-assistant/artifact/composer-quote'
import TeamPanelHeader from './TeamPanelHeader.vue'
import OrganizationMemberDetail from './OrganizationMemberDetail.vue'
import OrganizationTeamArtifacts from './OrganizationTeamArtifacts.vue'
import ExpertTeamChat from '../ExpertTeam/ExpertTeamChat.vue'

const props = defineProps<{
  tabId: string; stepId: string; source: TeamArtifactSource; sessionId?: string
  member?: OrganizationMemberView; snapshot?: SubAgentResult
  activeTab: 'activity' | 'artifacts'; artifactBindings?: ArtifactPanelBindings
}>()
const emit = defineEmits<{ close: []; 'update:activeTab': [tab: 'activity' | 'artifacts'] }>()
const { t } = useI18n()
const viewId = useId()
const tab = computed(() => props.activeTab)
const artifactsOpened = ref(props.activeTab === 'artifacts')
const artifactsPanel = ref<InstanceType<typeof OrganizationTeamArtifacts> | null>(null)
function closeLayer() {
  if (tab.value === 'artifacts' && artifactsPanel.value?.closePreview()) return
  emit('close')
}
defineExpose({ closeLayer })
const memberView = computed(() => 'member' in props.source)
const title = computed(() => 'member' in props.source ? props.source.member : t('ai.organization.teamTitle', { team: props.source.name }))
function selectTab(next: 'activity' | 'artifacts') {
  emit('update:activeTab', next)
  if (next === 'artifacts') artifactsOpened.value = true
}
watch(tab, next => { if (next === 'artifacts') artifactsOpened.value = true })
function stepTab(event: KeyboardEvent) {
  const list = event.currentTarget as HTMLElement
  const next = tab.value === 'activity' ? 'artifacts' : 'activity'
  selectTab(next)
  void nextTick(() => list.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus())
}
</script>

<template>
  <section class="org-object-detail">
    <TeamPanelHeader class="od-header" :title="title" :close-label="t(memberView ? 'ai.organization.closeMember' : 'ai.expertTeam.close')" :meta="'name' in source ? source.owner : undefined" hide-focus @close="emit('close')">
      <template #icon><UserRound v-if="memberView" :size="14" /><MessagesSquare v-else :size="14" /></template>
    </TeamPanelHeader>
    <div class="od-tabs" role="tablist" :aria-label="t('ai.organization.detailTabs')" @keydown.left.prevent="stepTab" @keydown.right.prevent="stepTab">
      <button :id="`${viewId}-activity`" type="button" role="tab" :aria-selected="tab === 'activity'" :aria-controls="`${viewId}-activity-panel`" :tabindex="tab === 'activity' ? 0 : -1" @click="selectTab('activity')">{{ t(memberView ? 'ai.organization.detailActivity' : 'ai.organization.detailChat') }}</button>
      <button :id="`${viewId}-artifacts`" type="button" role="tab" :aria-selected="tab === 'artifacts'" :aria-controls="`${viewId}-artifacts-panel`" :tabindex="tab === 'artifacts' ? 0 : -1" @click="selectTab('artifacts')">{{ t('ai.organization.detailArtifacts') }}</button>
    </div>
    <div class="od-content">
      <div v-show="tab === 'activity'" :id="`${viewId}-activity-panel`" class="od-pane" role="tabpanel" :aria-labelledby="`${viewId}-activity`" :inert="tab !== 'activity' || undefined">
        <OrganizationMemberDetail v-if="memberView && member" embedded :step-id="stepId" :session-id="sessionId" :member="member" :snapshot="snapshot" :focus-active="false" />
        <ExpertTeamChat v-else-if="'name' in source" embedded mode="panel" :tab-id="tabId" :step-id="stepId" :team-name="source.name" :team-owner="source.owner" :focus-active="false" />
      </div>
      <div v-show="tab === 'artifacts'" :id="`${viewId}-artifacts-panel`" class="od-pane" role="tabpanel" :aria-labelledby="`${viewId}-artifacts`" :inert="tab !== 'artifacts' || undefined">
        <OrganizationTeamArtifacts v-if="artifactsOpened" ref="artifactsPanel" embedded :active="tab === 'artifacts'" :artifact-bindings="artifactBindings" :tab-id="tabId" :step-id="stepId" :team="source" :focus-active="false" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.org-object-detail { display: flex; flex-direction: column; flex: 1; height: 100%; min-width: 0; min-height: 0; }
.od-tabs { display: flex; box-sizing: border-box; min-height: var(--team-subheader-height, 32px); flex-shrink: 0; gap: 18px; padding: 0 14px; border-bottom: 1px solid var(--border-color); }
.od-tabs button { display: flex; align-items: center; padding: 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-secondary); font-size: 12px; line-height: 16px; cursor: pointer; }
.od-tabs button[aria-selected="true"] { border-bottom-color: var(--accent-primary); color: var(--text-primary); }
.od-tabs button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.od-content { display: flex; flex: 1; min-height: 0; min-width: 0; box-sizing: border-box; }
.od-pane { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.od-pane :deep(.om-body) { padding-bottom: 14px; }
</style>
