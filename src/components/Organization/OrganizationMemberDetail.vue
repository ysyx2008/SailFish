<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Files, UserRound } from 'lucide-vue-next'
import type { OrganizationMemberView, SubAgentResult } from '@shared/types'
import { isSubAgentExpanded, memberDetailStepId, subAgentExpansionKey } from '../../utils/sub-agent-expansion'
import TeamPanelHeader from './TeamPanelHeader.vue'
import SubAgentGroup from '../SubAgentGroup.vue'

const props = defineProps<{ sessionId?: string; member: OrganizationMemberView; snapshot?: SubAgentResult; focusActive: boolean; stepId?: string; inline?: boolean }>()
const emit = defineEmits<{ close: []; artifacts: []; toggleFocus: [] }>()
const { t } = useI18n()
const detailStepId = computed(() => memberDetailStepId(props.sessionId, props.stepId, props.member.name))
const active = computed(() => !props.inline || isSubAgentExpanded(subAgentExpansionKey(detailStepId.value, props.member.id)))
const loaded = ref<SubAgentResult>()
const failed = ref(false)
const loading = ref(false)
const working = computed(() => props.member.status === 'running' || props.member.status === 'pending')
const steps = computed(() => {
  const saved = loaded.value?.steps
  if (!saved?.length) return props.snapshot?.steps
  if (!working.value) return saved
  const merged = [...saved]
  for (const step of props.snapshot?.steps ?? []) {
    if (!step.id) continue // 旧记录没有身份时不猜测是哪一次调用。
    const index = merged.findIndex(previous => previous.id === step.id)
    if (index < 0) merged.push(step)
    else merged[index] = step
  }
  return merged
})
const details = computed<SubAgentResult>(() => ({ ...loaded.value, ...props.snapshot,
  id: props.member.id, name: props.member.name, description: props.member.description, role: props.member.role,
  steps: steps.value,
  result: props.snapshot?.result ?? loaded.value?.result,
  error: props.snapshot?.error ?? loaded.value?.error,
  status: props.member.status, waitingForModel: props.member.waitingForModel,
}))
let request = 0
async function refresh() {
  const current = ++request
  loading.value = true
  failed.value = false
  try {
    const result = props.sessionId ? await window.electronAPI.history.readTeamMember(props.sessionId, props.member.name) : undefined
    if (current === request) loaded.value = result
  } catch { if (current === request) failed.value = true }
  finally { if (current === request) loading.value = false }
}
watch([() => props.sessionId, () => props.stepId, () => props.member.name, active], ([session, step, name, enabled], previous) => {
  request++
  loading.value = false
  if (!previous || previous[0] !== session || previous[1] !== step || previous[2] !== name) { loaded.value = undefined; failed.value = false }
  if (enabled) void refresh()
}, { immediate: true })
watch(working, (now, before) => { if (active.value && !now && before) void refresh() })
let timer: ReturnType<typeof setInterval> | undefined
watch([active, working], ([enabled, running]) => {
  clearInterval(timer)
  timer = enabled && running ? setInterval(() => { if (!loading.value) void refresh() }, 2000) : undefined
}, { immediate: true })
onBeforeUnmount(() => { request++; clearInterval(timer) })
</script>

<template>
  <section class="org-member-detail" :class="{ 'is-inline': inline }">
    <TeamPanelHeader v-if="!inline" class="om-header" :title="member.name" :close-label="t('ai.organization.closeMember')" :back-label="t('ai.organization.backToChart')" :focused="focusActive" :focus-label="focusActive ? t('canvas.splitDocument') : t('ai.organization.focus')" @close="emit('close')" @back="emit('close')" @toggle-focus="emit('toggleFocus')">
      <template #icon><UserRound :size="14" /></template>
      <template #actions><button type="button" class="om-artifacts" @click="emit('artifacts')"><Files :size="14" />{{ t('ai.organization.teamArtifacts') }}</button></template>
    </TeamPanelHeader>
    <div class="om-body">
      <p v-if="!inline" class="om-responsibility"><span>{{ t('ai.organization.responsibility') }}</span>{{ member.description }}</p>
      <p v-if="!inline && failed" role="alert">{{ t('ai.organization.memberLoadFailed') }} <button type="button" @click="refresh">{{ t('ai.organization.retry') }}</button></p>
      <p v-else-if="!inline && loading && !loaded && !snapshot">{{ t('common.loading') }}</p>
      <SubAgentGroup :step-id="detailStepId" :sub-agents="[details]" always-open plain hide-team-card :expand-details="!inline" :details-available="inline">
        <template v-if="inline" #detail-status>
          <p v-if="failed" class="inline-status" role="alert">{{ t('ai.organization.memberLoadFailed') }} <button type="button" @click.stop="refresh">{{ t('ai.organization.retry') }}</button></p>
          <p v-else-if="loading && !loaded" class="inline-status">{{ t('common.loading') }}</p>
          <p v-else-if="!details.steps?.length && !details.result && !details.error && !details.prompt" class="inline-status">{{ t('ai.organization.noMemberProcess') }}</p>
        </template>
      </SubAgentGroup>
      <p v-if="!inline && !loading && !failed && !details.steps?.length && !details.result && !details.error" class="om-empty">{{ t('ai.organization.noMemberProcess') }}</p>
    </div>
  </section>
</template>

<style scoped>
.org-member-detail { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.om-body button { color: var(--text-secondary); background: transparent; border: 0; cursor: pointer; }
.om-body { overflow: auto; padding: 14px; padding-bottom: var(--assistant-focus-overlay, 22px); }
.om-responsibility { margin: 0 0 14px; white-space: pre-wrap; font-size: 12px; line-height: 1.6; }
.om-responsibility span { display: block; margin-bottom: 4px; color: var(--text-muted); font-size: 11px; }
.om-empty { color: var(--text-muted); font-size: 12px; }
.org-member-detail.is-inline { height: auto; }
.is-inline .om-body { overflow: visible; padding: 0; }
.inline-status { padding: 8px 10px; margin: 0; color: var(--text-muted); font-size: 12px; }
</style>
