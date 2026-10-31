<script setup lang="ts">
/** 团队成果清单；预览复用产出物面板与同一份草稿存储。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, FileText, FolderOpen, RefreshCw, Files } from 'lucide-vue-next'
import { resolveCanvasArtifactId, type OrganizationArtifactView, type TeamArtifactSource } from '@shared/types'
import { checkFilePathExists, requireArtifactDesktopHost, useAssistantArtifactStore } from '@sailfish/workbench-assistant/artifact'
import type { ArtifactPanelBindings } from '@sailfish/workbench-assistant/artifact/composer-quote'
import { loadArtifactContentFromDisk } from '@sailfish/workbench-assistant/artifact/domain/artifact-content-loader'
import ArtifactPanel from '@sailfish/workbench-assistant/artifact/components/ArtifactPanel.vue'
import { teamViewForStep } from '../../utils/team-view'
import TeamPanelHeader from './TeamPanelHeader.vue'
import { useTerminalStore } from '../../stores/terminal'

const props = defineProps<{ tabId: string; stepId: string; team: TeamArtifactSource; focusActive: boolean; artifactBindings?: ArtifactPanelBindings; backLabel?: string; embedded?: boolean; active?: boolean }>()
const emit = defineEmits<{ close: []; back: []; toggleFocus: [] }>()
const { t } = useI18n()
const refreshLabel = computed(() => t(props.embedded ? 'ai.organization.refreshResults' : 'ai.organization.refreshArtifacts'))
const terminalStore = useTerminalStore()
const artifactStore = useAssistantArtifactStore()
const items = ref<OrganizationArtifactView[]>([])
const loading = ref(false)
const failed = ref(false)
const openError = ref('')
let openRequest = 0
const preview = ref(false)
const previewId = ref<string>()
let previewContext: { id: string; owned: boolean; wasVisible: boolean; activeBefore?: string } | undefined
function releasePreview() {
  const context = previewContext
  previewContext = undefined
  if (!context) return
  const stillSelected = artifactStore.getActiveArtifact(props.tabId)?.id === context.id
  if (context.owned) artifactStore.closeTab(props.tabId, context.id)
  if (stillSelected) {
    if (context.activeBefore && artifactStore.getOpenArtifacts(props.tabId).some(item => item.id === context.activeBefore)) {
      artifactStore.setActiveArtifact(props.tabId, context.activeBefore)
    }
    if (!context.wasVisible) artifactStore.minimizePanel(props.tabId)
  }
  requireArtifactDesktopHost().persistArtifacts(props.tabId)
}
const panel = ref<{ flushDraft: () => void; deactivate?: () => void } | null>(null)
watch(() => props.active, active => {
  if (active === false) { openRequest++; panel.value?.deactivate?.() }
  else if (active && !preview.value && !loading.value) void refresh()
})
const state = computed(() => terminalStore.tabs.find(tab => tab.id === props.tabId)?.agentState)
const view = computed(() => teamViewForStep(state.value?.steps ?? [], props.stepId, state.value?.sessionId))
const sessionId = computed(() => view.value?.sessionId)
const sourceName = computed(() => 'member' in props.team ? props.team.member : props.team.name)
const sourceOwner = computed(() => 'name' in props.team ? props.team.owner : undefined)
const groups = computed(() => [
  { key: 'members', label: t(props.embedded ? 'ai.organization.detailArtifacts' : 'ai.organization.teamArtifacts'), items: items.value.filter(item => !item.producerRole) },
  { key: 'lead', label: t('ai.organization.leadArtifacts'), items: items.value.filter(item => item.producerRole === 'lead') },
].filter(group => group.items.length))
const ids = computed(() => items.value.map(item => resolveCanvasArtifactId(item.data)))
let request = 0
async function refresh(clearOpenError = false) {
  const current = ++request
  const session = sessionId.value
  loading.value = true
  failed.value = false
  if (clearOpenError) openError.value = ''
  try {
    const result = session ? await window.electronAPI.history.readTeamArtifacts(session, { ...props.team }) : []
    if (current === request) items.value = result
  } catch {
    if (current === request) failed.value = true
  } finally {
    if (current === request) loading.value = false
  }
}
watch([sessionId, () => props.stepId, sourceName, sourceOwner], () => {
  openRequest++
  panel.value?.flushDraft()
  releasePreview()
  preview.value = false
  openError.value = ''
  items.value = []
  void refresh()
}, { immediate: true })
const working = computed(() => view.value?.members.some(member =>
  ('member' in props.team ? member.name === props.team.member : member.name === props.team.owner || (member.parent === props.team.owner && member.team === props.team.name))
  && (member.status === 'running' || member.status === 'pending')) ?? false)
watch(working, (now, before) => {
  // 最后一个人收工后不再轮询，退出前仍须读到这次交回的成果。
  if (before && !now && !preview.value) void refresh()
})
watch(preview, (now, before) => {
  if (before && !now) { panel.value?.flushDraft(); releasePreview(); if (items.value.length) void refresh() }
})
const poll = setInterval(() => {
  if (props.active !== false && working.value && !loading.value && !preview.value) void refresh()
}, 3000)
onBeforeUnmount(() => { panel.value?.flushDraft(); releasePreview(); request++; openRequest++; clearInterval(poll) })
function back() {
  openRequest++
  panel.value?.flushDraft()
  if (preview.value) { preview.value = false; releasePreview() }
  else emit('back')
}
function close() { openRequest++; panel.value?.flushDraft(); emit('close') }
function toggleFocus() { panel.value?.flushDraft(); emit('toggleFocus') }
async function open(item: OrganizationArtifactView) {
  const current = ++openRequest
  openError.value = ''
  const filePath = item.data.filePath
  if (filePath && !(await checkFilePathExists(filePath))) {
    if (current === openRequest) openError.value = t('ai.organization.artifactUnavailable', { path: filePath })
    return
  }
  if (current !== openRequest) return
  const id = resolveCanvasArtifactId(item.data)
  const existing = artifactStore.getArtifactById(props.tabId, id)
  if (props.embedded) previewContext = {
    id,
    owned: !artifactStore.getOpenArtifacts(props.tabId).some(item => item.id === id),
    wasVisible: artifactStore.isVisible(props.tabId),
    activeBefore: artifactStore.getActiveArtifact(props.tabId)?.id,
  }
  // 更新标题等元数据时沿用同一份草稿，不用历史快照冲掉用户内容。
  artifactStore.open(props.tabId, { ...item.data, action: 'open', content: existing ? undefined : item.data.content, activate: false })
  artifactStore.setActiveArtifact(props.tabId, id)
  previewId.value = id
  preview.value = true
  try {
    if (existing && !artifactStore.isArtifactDirty(props.tabId, id)) {
      const artifact = artifactStore.getArtifactById(props.tabId, id)!
      const content = filePath
        ? await loadArtifactContentFromDisk(artifact, { previewArtifact: window.electronAPI.localFs.previewArtifact, readFile: window.electronAPI.localFs.readFile })
        : item.data.content
      if (current === openRequest && typeof content === 'string') artifactStore.ingestExternalContent(props.tabId, id, content)
    }
  } catch {
    if (current === openRequest) {
      openError.value = t('ai.organization.artifactUnavailable', { path: filePath || titleOf(item) })
      preview.value = false
    }
  }
  if (current === openRequest) requireArtifactDesktopHost().persistArtifacts(props.tabId)
}

watch(() => artifactStore.getOpenArtifacts(props.tabId).some(a => props.embedded && previewId.value ? a.id === previewId.value : ids.value.includes(a.id)), hasOpen => {
  if (preview.value && !hasOpen) preview.value = false
})
watch(() => artifactStore.isVisible(props.tabId), visible => {
  if (!visible) preview.value = false
})
const titleOf = (item: OrganizationArtifactView) => item.kind === 'result'
  ? t('ai.organization.memberResult', { name: item.member })
  : item.data.title || item.data.filePath?.split(/[\\/]/).pop() || item.member
</script>

<template>
  <section class="org-artifacts" :class="{ 'is-focus': focusActive, 'is-embedded': embedded }">
    <div v-if="embedded" class="oa-tools" :class="{ 'is-preview': preview }">
      <button v-if="preview" type="button" class="btn-header oa-preview-back" @click="back"><ArrowLeft :size="14" />{{ t('ai.organization.backToResults') }}</button>
      <button v-else type="button" class="btn-icon btn-icon-header oa-refresh" :disabled="loading" :title="refreshLabel" @click="refresh(true)"><RefreshCw :size="14" /></button>
    </div>
    <TeamPanelHeader v-if="!embedded" class="oa-header" :title="`${sourceName} · ${t('ai.organization.teamArtifacts')}`" :close-label="t('ai.organization.closeArtifacts')" :back-label="preview ? t('ai.organization.backToArtifacts') : backLabel ?? t('ai.organization.backToChart')" :meta="'name' in team ? sourceOwner || t('ai.organization.secretary') : undefined" :focused="focusActive" :hide-focus="preview" :focus-label="focusActive ? t('canvas.splitDocument') : t('ai.organization.focus')" @close="close" @back="back" @toggle-focus="toggleFocus">
      <template #icon><Files :size="14" /></template>
      <template v-if="!preview" #actions><button type="button" class="btn-icon btn-icon-header oa-refresh" :disabled="loading" :title="t('ai.organization.refreshArtifacts')" @click="refresh(true)"><RefreshCw :size="14" /></button></template>
    </TeamPanelHeader>
    <ArtifactPanel v-if="preview" ref="panel" v-bind="artifactBindings" :tab-id="tabId" :artifact-ids="embedded && previewId ? [previewId] : ids" :embedded="embedded" :focus-active="focusActive" @close-preview="back" @toggle-focus="toggleFocus" />
    <div v-else class="oa-list">
      <p v-if="openError" class="oa-error" role="alert">{{ openError }}</p>
      <p v-if="failed" class="oa-empty">{{ t('ai.organization.artifactsLoadFailed') }} <button type="button" @click="refresh(true)">{{ refreshLabel }}</button></p>
      <p v-else-if="loading && !items.length" class="oa-empty">{{ t('common.loading') }}</p>
      <div v-else-if="!items.length" class="oa-empty"><FolderOpen :size="26" /><p>{{ t(embedded ? 'ai.organization.noResults' : 'ai.organization.noArtifacts') }}</p></div>
      <section v-for="group in groups" :key="group.key" class="oa-group">
      <h3 v-if="groups.length > 1 || group.key === 'lead'" class="oa-group-title">{{ group.label }}</h3>
      <button v-for="item in group.items" :key="resolveCanvasArtifactId(item.data)" type="button" class="oa-item" @click="open(item)">
        <FileText :size="19" />
        <span class="oa-item-body"><strong>{{ titleOf(item) }}</strong><span class="oa-member">{{ t('ai.organization.artifactBy', { name: item.member }) }}</span><span v-if="item.data.filePath" class="oa-path">{{ item.data.filePath }}</span></span>
      </button>
      </section>
    </div>
  </section>
</template>

<style scoped>
.org-artifacts { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; height: 100%; background: var(--bg-primary); }
.oa-list { flex: 1; overflow: auto; padding: 14px; }
.is-focus .oa-list { padding-bottom: var(--assistant-focus-overlay, 22px); }
.oa-error { padding: 10px; color: var(--color-error, #e06c75); font-size: 12px; overflow-wrap: anywhere; }
.oa-group-title { margin: 4px 0 10px; font-size: 12px; font-weight: 500; color: var(--text-secondary); }
.oa-group + .oa-group { margin-top: 20px; }
.oa-item { display: flex; align-items: flex-start; gap: 10px; width: 100%; margin-bottom: 8px; padding: 12px; text-align: left; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-primary); cursor: pointer; }
.oa-item:hover { border-color: var(--accent-primary); }
.oa-item-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.oa-item strong { font-size: 13px; overflow-wrap: anywhere; }
.oa-member, .oa-path { color: var(--text-secondary); font-size: 11px; overflow-wrap: anywhere; }
.oa-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 60px 12px; color: var(--text-secondary); font-size: 13px; }
.org-artifacts :deep(.canvas-panel) { flex: 1; min-height: 0; }
.oa-tools { display: flex; flex-shrink: 0; justify-content: flex-end; padding: 7px 14px; border-bottom: 1px solid var(--border-color); }
.oa-tools.is-preview { justify-content: flex-start; }
.is-embedded .oa-list { padding-bottom: 14px; }
</style>
