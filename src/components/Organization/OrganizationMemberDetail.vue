<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Files, UserRound } from 'lucide-vue-next'
import type { OrganizationMemberView, SubAgentResult } from '@shared/types'
import TeamPanelHeader from './TeamPanelHeader.vue'
import SubAgentGroup from '../SubAgentGroup.vue'

const props = defineProps<{ sessionId?: string; member: OrganizationMemberView; snapshot?: SubAgentResult; focusActive: boolean }>()
const emit = defineEmits<{ close: []; artifacts: []; toggleFocus: [] }>()
const { t } = useI18n()
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
watch([() => props.sessionId, () => props.member.name], () => { loaded.value = undefined; void refresh() }, { immediate: true })
watch(working, (now, before) => { if (!now && before) void refresh() })
const timer = setInterval(() => { if (working.value && !loading.value) void refresh() }, 2000)
onBeforeUnmount(() => { request++; clearInterval(timer) })
</script>

<template>
  <section class="org-member-detail">
    <TeamPanelHeader class="om-header" :title="member.name" :close-label="t('ai.organization.closeMember')" :back-label="t('ai.organization.backToChart')" :focused="focusActive" :focus-label="focusActive ? t('canvas.splitDocument') : t('ai.organization.focus')" @close="emit('close')" @back="emit('close')" @toggle-focus="emit('toggleFocus')">
      <template #icon><UserRound :size="14" /></template>
      <template #actions><button type="button" class="om-artifacts" @click="emit('artifacts')"><Files :size="14" />{{ t('ai.organization.teamArtifacts') }}</button></template>
    </TeamPanelHeader>
    <div class="om-body">
      <p class="om-responsibility"><span>{{ t('ai.organization.responsibility') }}</span>{{ member.description }}</p>
      <p v-if="failed" role="alert">{{ t('ai.organization.memberLoadFailed') }} <button type="button" @click="refresh">{{ t('ai.organization.retry') }}</button></p>
      <p v-else-if="loading && !loaded && !snapshot">{{ t('common.loading') }}</p>
      <SubAgentGroup :step-id="`member:${sessionId}:${member.name}`" :sub-agents="[details]" always-open plain hide-team-card expand-details />
      <p v-if="!loading && !failed && !details.steps?.length && !details.result && !details.error" class="om-empty">{{ t('ai.organization.noMemberProcess') }}</p>
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
</style>
