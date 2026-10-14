<script setup lang="ts">
/**
 * 本地联系人面板 —— 秘书菜单打开，占主区（与待办同一位置）
 * 列表 + 右侧详情；详情改动自动保存。同名允许，新增时已有同名的先给出来，可打开那条或照样新增
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { BookUser, Loader2, Plus, Search, X } from 'lucide-vue-next'
import type { Contact, ContactChannel, ContactChannelKind, ContactKind, ContactUpdatePatch } from '@sailfish/shared-types'
import AppSelect from '../common/AppSelect.vue'
import { showConfirm } from '../../composables/useConfirm'
import { toast } from '../../composables/useToast'

const { t, locale } = useI18n()
const emit = defineEmits<{ close: [] }>()
const api = window.electronAPI.contact

interface ChannelDraft {
  kind: ContactChannelKind
  value: string
  platform: string
  label?: string
}

interface ContactDraft {
  name: string
  aliasesText: string
  kind: ContactKind
  organization: string
  role: string
  note: string
  channels: ChannelDraft[]
}

const CHANNEL_KINDS: ContactChannelKind[] = ['email', 'phone', 'im']

const loading = ref(true)
const contacts = ref<Contact[]>([])
const query = ref('')
const searchHitIds = ref<string[] | null>(null)
const newName = ref('')
const creating = ref(false)
/** 新增时已有同名的那几位；输入框改了就作废 */
const sameNameCandidates = ref<Contact[]>([])

const selectedId = ref<string | null>(null)
const draft = ref<ContactDraft | null>(null)
const saving = ref(false)
/** 详情打开期间秘书改过这条，而用户手上还有没存的改动 */
const changedElsewhere = ref(false)

let lastSyncedUpdatedAt = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let unsubChanged: (() => void) | null = null

const selected = computed(() => contacts.value.find(c => c.id === selectedId.value) ?? null)

const sortedContacts = computed(() =>
  [...contacts.value].sort((a, b) => a.name.localeCompare(b.name, locale.value))
)

const visibleContacts = computed(() => {
  if (searchHitIds.value === null) return sortedContacts.value
  const hits = new Set(searchHitIds.value)
  return sortedContacts.value.filter(c => hits.has(c.id))
})

/** 同名时靠单位或角色分辨 */
function contactLabel(contact: Contact): string {
  const hint = contact.organization || contact.role
  return hint ? `${contact.name} · ${hint}` : contact.name
}

function channelKindLabel(kind: ContactChannelKind): string {
  return t(`contactPanel.channelKind.${kind}`)
}

function channelText(channel: ContactChannel): string {
  return channel.kind === 'im' && channel.platform ? `${channel.platform} ${channel.value}` : channel.value
}

function rowSubtitle(contact: Contact): string {
  const parts = [contact.organization, contact.role]
  if (contact.channels?.length) parts.push(channelText(contact.channels[0]))
  return parts.filter(Boolean).join(' · ')
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()) || d.getTime() === 0) return '—'
  return d.toLocaleString(locale.value, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function draftFrom(contact: Contact): ContactDraft {
  return {
    name: contact.name,
    aliasesText: (contact.aliases ?? []).join('、'),
    kind: contact.kind,
    organization: contact.organization ?? '',
    role: contact.role ?? '',
    note: contact.note ?? '',
    channels: (contact.channels ?? []).map(c => ({
      kind: c.kind,
      value: c.value,
      platform: c.platform ?? '',
      label: c.label,
    })),
  }
}

function patchFrom(d: ContactDraft): ContactUpdatePatch {
  const channels: ContactChannel[] = []
  for (const c of d.channels) {
    const value = c.value.trim()
    if (!value) continue
    const channel: ContactChannel = { kind: c.kind, value }
    if (c.kind === 'im' && c.platform.trim()) channel.platform = c.platform.trim()
    if (c.label) channel.label = c.label
    channels.push(channel)
  }
  return {
    name: d.name.trim(),
    kind: d.kind,
    organization: d.organization.trim(),
    role: d.role.trim(),
    note: d.note.trim(),
    aliases: d.aliasesText.split(/[,，、;；\n]/).map(s => s.trim()).filter(Boolean),
    channels,
  }
}

function snapshotOf(contact: Contact): string {
  return JSON.stringify(patchFrom(draftFrom(contact)))
}

/** 草稿所依据的那一版；用户改没改，要跟它比，不能跟列表里（可能已被秘书改过的）最新版比 */
const baseSnapshot = ref('')

/** 用户手上有没存的改动（按保存时会发出的内容比，空白差异不算） */
const draftDirty = computed(() => {
  if (!draft.value) return false
  return JSON.stringify(patchFrom(draft.value)) !== baseSnapshot.value
})

function applyDraft(contact: Contact) {
  baseSnapshot.value = snapshotOf(contact)
  draft.value = draftFrom(contact)
  lastSyncedUpdatedAt = contact.updatedAt
  changedElsewhere.value = false
}

async function loadContacts() {
  try {
    contacts.value = await api.list()
  } catch {
    toast.error(t('contactPanel.loadFailed'))
    return
  } finally {
    loading.value = false
  }
  syncSelectionAfterReload()
  if (query.value.trim()) await runSearch()
}

function cancelPendingSave() {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
}

function syncSelectionAfterReload() {
  if (!selectedId.value) return
  const item = selected.value
  if (!item) {
    closeDetail(false)
    return
  }
  if (saving.value || item.updatedAt === lastSyncedUpdatedAt) return
  if (draftDirty.value) {
    // 等用户表态：接着改或关掉详情才用他的版本覆盖
    cancelPendingSave()
    changedElsewhere.value = true
    return
  }
  applyDraft(item)
}

async function runSearch() {
  const q = query.value.trim()
  if (!q) {
    searchHitIds.value = null
    return
  }
  const hits = await api.search(q)
  if (query.value.trim() === q) searchHitIds.value = hits.map(c => c.id)
}

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void runSearch() }, 150)
})

function selectContact(contact: Contact) {
  if (selectedId.value === contact.id) return
  void flushSave()
  selectedId.value = contact.id
  applyDraft(contact)
}

function closeDetail(flush = true) {
  if (flush) void flushSave()
  selectedId.value = null
  draft.value = null
  changedElsewhere.value = false
}

watch(draft, () => {
  if (!draftDirty.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistDraft() }, 500)
}, { deep: true })

/** 离开这条（切换、关闭）时：没存的改动立刻存，包括之前存失败或等用户表态的 */
function flushSave(): Promise<void> {
  cancelPendingSave()
  return persistDraft()
}

async function persistDraft() {
  saveTimer = null
  const id = selectedId.value
  const d = draft.value
  if (!id || !d || !draftDirty.value) return
  if (!d.name.trim()) return
  const patch = patchFrom(d)
  const sent = JSON.stringify(patch)
  saving.value = true
  try {
    const result = await api.update(id, patch)
    if (result.type === 'missing') {
      if (selectedId.value === id) {
        toast.error(t('contactPanel.goneElsewhere'))
        closeDetail(false)
      }
      return
    }
    const index = contacts.value.findIndex(c => c.id === id)
    if (index >= 0) contacts.value[index] = result.contact
    if (selectedId.value !== id) return
    const saved = snapshotOf(result.contact)
    // 存进去的和发出去的不一样（如重复的联系方式被去掉），且用户这期间没再改：草稿跟上存下来的样子
    if (saved !== sent && draft.value && JSON.stringify(patchFrom(draft.value)) === sent) {
      applyDraft(result.contact)
      return
    }
    changedElsewhere.value = false
    lastSyncedUpdatedAt = result.contact.updatedAt
    baseSnapshot.value = saved
  } catch {
    toast.error(t('contactPanel.saveFailed'))
  } finally {
    saving.value = false
  }
}

function discardMyChanges() {
  cancelPendingSave()
  if (selected.value) applyDraft(selected.value)
}

watch(newName, () => {
  sameNameCandidates.value = []
})

async function handleCreate(confirmedDifferent = false) {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    const result = await api.create({ name }, { confirmedDifferent })
    if (result.type === 'possibleSame') {
      sameNameCandidates.value = result.candidates
      return
    }
    newName.value = ''
    query.value = ''
    searchHitIds.value = null
    await loadContacts()
    selectContact(result.contact)
  } catch {
    toast.error(t('contactPanel.createFailed'))
  } finally {
    creating.value = false
  }
}

function openCandidate(candidate: Contact) {
  const existing = contacts.value.find(c => c.id === candidate.id)
  newName.value = ''
  if (!existing) return
  query.value = ''
  searchHitIds.value = null
  selectContact(existing)
}

async function handleDelete() {
  const item = selected.value
  if (!item) return
  const ok = await showConfirm({
    title: t('contactPanel.deleteTitle'),
    message: t('contactPanel.deleteMessage', { name: item.name }),
    type: 'danger',
    confirmText: t('contactPanel.delete'),
    cancelText: t('contactPanel.cancel'),
  })
  if (!ok) return
  cancelPendingSave()
  await api.delete(item.id)
  closeDetail(false)
  await loadContacts()
}

function addChannel() {
  draft.value?.channels.push({ kind: 'email', value: '', platform: '' })
}

function removeChannel(index: number) {
  draft.value?.channels.splice(index, 1)
}

function onRowKeydown(contact: Contact, ev: KeyboardEvent) {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault()
    selectContact(contact)
  }
}

function onPanelKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  if (document.querySelector('.modal-overlay, .credential-overlay, .setup-wizard, .confirm-overlay, .app-select-menu')) return
  ev.preventDefault()
  ev.stopImmediatePropagation()
  if (selectedId.value) {
    closeDetail()
    return
  }
  emit('close')
}

onMounted(() => {
  unsubChanged = api.onChanged(() => { void loadContacts() })
  document.addEventListener('keydown', onPanelKeydown, true)
  void loadContacts()
})

onUnmounted(() => {
  document.removeEventListener('keydown', onPanelKeydown, true)
  unsubChanged?.()
  if (searchTimer) clearTimeout(searchTimer)
  void flushSave()
})
</script>

<template>
  <div class="contact-panel" :class="{ 'detail-open': !!draft }">
    <div class="contact-main">
      <div class="contact-chrome">
        <header class="contact-header">
          <div class="contact-mark">
            <BookUser :size="18" :stroke-width="1.75" />
          </div>
          <div class="contact-header-text">
            <div class="contact-title-row">
              <h1>{{ t('contactPanel.title') }}</h1>
              <span v-if="!loading" class="count-pill">{{ contacts.length }}</span>
            </div>
            <p class="contact-header-desc">{{ t('contactPanel.desc') }}</p>
          </div>
        </header>

        <div class="contact-tools">
          <label class="tool-field search-field">
            <Search :size="14" class="tool-icon" />
            <input
              v-model="query"
              class="tool-input"
              type="search"
              :placeholder="t('contactPanel.searchPlaceholder')"
            />
          </label>
          <form class="tool-field create-field" @submit.prevent="handleCreate()">
            <input
              v-model="newName"
              class="tool-input"
              type="text"
              :placeholder="t('contactPanel.newPlaceholder')"
              :disabled="creating"
            />
            <button
              type="submit"
              class="add-btn"
              :disabled="!newName.trim() || creating"
              :title="t('contactPanel.add')"
            >
              <Loader2 v-if="creating" :size="16" class="spin" />
              <Plus v-else :size="16" />
            </button>
          </form>
        </div>
        <div v-if="sameNameCandidates.length" class="notice same-name-notice">
          <span>{{ t('contactPanel.sameNameExists', { name: newName.trim() }) }}</span>
          <button
            v-for="candidate in sameNameCandidates"
            :key="candidate.id"
            type="button"
            class="link-btn"
            @click="openCandidate(candidate)"
          >
            {{ contactLabel(candidate) }}
          </button>
          <button type="button" class="link-btn strong" :disabled="creating" @click="handleCreate(true)">
            {{ t('contactPanel.createAnyway') }}
          </button>
        </div>
      </div>

      <div class="contact-scroll">
        <div v-if="loading" class="contact-empty">
          <Loader2 :size="22" class="spin" />
        </div>

        <div v-else-if="contacts.length === 0" class="contact-empty">
          <div class="contact-empty-mark">
            <BookUser :size="28" :stroke-width="1.5" />
          </div>
          <p class="contact-empty-title">{{ t('contactPanel.emptyTitle') }}</p>
          <p class="contact-empty-hint">{{ t('contactPanel.emptyHint') }}</p>
        </div>

        <div v-else-if="visibleContacts.length === 0" class="contact-empty">
          <p class="contact-empty-hint">{{ t('contactPanel.noMatch') }}</p>
        </div>

        <ul v-else class="contact-list">
          <li
            v-for="contact in visibleContacts"
            :key="contact.id"
            class="contact-row"
            :class="{ selected: contact.id === selectedId }"
            tabindex="0"
            @click="selectContact(contact)"
            @keydown="onRowKeydown(contact, $event)"
          >
            <div class="row-line">
              <span class="row-name">{{ contact.name }}</span>
              <span v-if="contact.kind === 'org'" class="kind-tag">{{ t('contactPanel.kind.org') }}</span>
              <span v-if="contact.aliases?.length" class="row-aliases">{{ contact.aliases.join('、') }}</span>
            </div>
            <div v-if="rowSubtitle(contact)" class="row-sub">{{ rowSubtitle(contact) }}</div>
          </li>
        </ul>
      </div>
    </div>

    <aside v-if="draft && selected" class="contact-detail">
      <div class="detail-top">
        <h2>{{ t('contactPanel.detailTitle') }}</h2>
        <div class="detail-top-actions">
          <span v-if="saving" class="saving-hint">{{ t('contactPanel.saving') }}</span>
          <button type="button" class="icon-close" :title="t('contactPanel.closeDetail')" @click="closeDetail()">
            <X :size="16" />
          </button>
        </div>
      </div>

      <div class="detail-body">
        <div v-if="changedElsewhere" class="notice">
          <span>{{ t('contactPanel.changedElsewhere') }}</span>
          <button type="button" class="link-btn" @click="discardMyChanges">{{ t('contactPanel.reloadIt') }}</button>
        </div>

        <label class="field">
          <span class="field-label">{{ t('contactPanel.fieldName') }}</span>
          <input v-model="draft.name" class="field-input" type="text" />
          <span v-if="!draft.name.trim()" class="field-error">{{ t('contactPanel.nameRequired') }}</span>
        </label>
        <label class="field">
          <span class="field-label">{{ t('contactPanel.fieldAliases') }}</span>
          <input
            v-model="draft.aliasesText"
            class="field-input"
            type="text"
            :placeholder="t('contactPanel.aliasesPlaceholder')"
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span class="field-label">{{ t('contactPanel.fieldKind') }}</span>
            <AppSelect
              :model-value="draft.kind"
              size="field"
              block
              :options="[
                { value: 'person', label: t('contactPanel.kind.person') },
                { value: 'org', label: t('contactPanel.kind.org') },
              ]"
              @update:model-value="draft.kind = $event as ContactKind"
            />
          </label>
          <label class="field">
            <span class="field-label">{{ t('contactPanel.fieldRole') }}</span>
            <input v-model="draft.role" class="field-input" type="text" />
          </label>
        </div>

        <label class="field">
          <span class="field-label">{{ t('contactPanel.fieldOrganization') }}</span>
          <input v-model="draft.organization" class="field-input" type="text" />
        </label>

        <div class="field">
          <span class="field-label">{{ t('contactPanel.fieldChannels') }}</span>
          <div v-for="(channel, index) in draft.channels" :key="index" class="channel-row">
            <div class="channel-kind">
              <AppSelect
                :model-value="channel.kind"
                size="field"
                block
                :options="CHANNEL_KINDS.map(k => ({ value: k, label: channelKindLabel(k) }))"
                @update:model-value="channel.kind = $event as ContactChannelKind"
              />
            </div>
            <input
              v-if="channel.kind === 'im'"
              v-model="channel.platform"
              class="field-input channel-platform"
              type="text"
              :placeholder="t('contactPanel.platformPlaceholder')"
            />
            <input v-model="channel.value" class="field-input channel-value" type="text" />
            <button
              type="button"
              class="icon-close"
              :title="t('contactPanel.removeChannel')"
              @click="removeChannel(index)"
            >
              <X :size="14" />
            </button>
          </div>
          <button type="button" class="link-btn add-channel" @click="addChannel">
            <Plus :size="13" />
            {{ t('contactPanel.addChannel') }}
          </button>
        </div>

        <label class="field">
          <span class="field-label">{{ t('contactPanel.fieldNote') }}</span>
          <textarea
            v-model="draft.note"
            class="field-textarea"
            rows="4"
            :placeholder="t('contactPanel.notePlaceholder')"
          />
        </label>

        <dl class="meta-grid">
          <div class="meta-cell">
            <dt>{{ t('contactPanel.fieldCreated') }}</dt>
            <dd>{{ formatAbsolute(selected.createdAt) }}</dd>
          </div>
          <div class="meta-cell">
            <dt>{{ t('contactPanel.fieldUpdated') }}</dt>
            <dd>{{ formatAbsolute(selected.updatedAt) }}</dd>
          </div>
        </dl>
      </div>

      <div class="detail-footer">
        <button type="button" class="footer-btn danger" @click="handleDelete">
          {{ t('contactPanel.delete') }}
        </button>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.contact-panel {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-primary);
  color: var(--text-primary);
}

.contact-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.contact-chrome {
  flex-shrink: 0;
  padding: 16px 20px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.contact-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}

.contact-mark {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 28%, transparent);
}

.contact-header-text { min-width: 0; }
.contact-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.contact-header h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
.count-pill {
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  display: inline-flex;
  align-items: center;
}
.contact-header-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.contact-tools {
  display: grid;
  grid-template-columns: 3fr 2fr;
  gap: 8px;
}
.tool-field {
  display: flex;
  align-items: center;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
}
.tool-field:focus-within {
  border-color: color-mix(in srgb, var(--accent-primary) 55%, var(--border-color));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 14%, transparent);
}
.tool-icon {
  margin-left: 10px;
  flex-shrink: 0;
  color: var(--text-muted);
}
.tool-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}
.add-btn {
  width: 36px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-left: 1px solid var(--border-color);
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
  color: var(--accent-primary);
  cursor: pointer;
}
.add-btn:hover:not(:disabled) {
  background: var(--accent-primary);
  color: #fff;
}
.add-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.contact-scroll {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 10px 20px 24px;
  scrollbar-gutter: stable;
}
.contact-scroll::-webkit-scrollbar { width: 8px; }
.contact-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--text-muted) 35%, transparent);
  border-radius: 4px;
}

.contact-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 200px;
  color: var(--text-muted);
}
.contact-empty-mark {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: 1px dashed var(--border-color);
}
.contact-empty-title { margin: 0; font-size: 14px; color: var(--text-secondary); }
.contact-empty-hint { margin: 0; font-size: 12px; }

.contact-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  overflow: hidden;
}
.contact-row {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
  cursor: pointer;
  outline: none;
  transition: background 0.1s ease;
}
.contact-row:last-child { border-bottom: none; }
.contact-row:hover { background: color-mix(in srgb, var(--text-primary) 3.5%, transparent); }
.contact-row:focus-visible { background: color-mix(in srgb, var(--text-primary) 5%, transparent); }
.contact-row.selected { background: color-mix(in srgb, var(--accent-primary) 10%, transparent); }
.contact-row.selected::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 2px;
  background: var(--accent-primary);
}
.row-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.row-name {
  font-size: 13px;
  font-weight: 550;
  color: var(--text-primary);
  white-space: nowrap;
}
.kind-tag {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  line-height: 16px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.row-aliases,
.row-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-muted);
}

.contact-detail {
  width: 360px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--border-color);
  background: var(--bg-secondary);
}
.detail-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
}
.detail-top h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.detail-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.saving-hint {
  font-size: 11px;
  color: var(--text-muted);
}
.icon-close {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.icon-close:hover {
  background: color-mix(in srgb, var(--text-primary) 7%, transparent);
  color: var(--text-primary);
}

.detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.field-label {
  font-size: 11px;
  font-weight: 550;
  color: var(--text-muted);
}
.field-error {
  font-size: 11px;
  color: var(--brand-alert);
}
.field-input,
.field-textarea {
  width: 100%;
  box-sizing: border-box;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  padding: 7px 9px;
  outline: none;
}
.field-input:focus,
.field-textarea:focus {
  border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color));
}
.field-textarea {
  resize: vertical;
  min-height: 84px;
  line-height: 1.45;
  font-family: inherit;
}

.channel-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.channel-kind { width: 104px; min-width: 0; flex-shrink: 0; }
.channel-platform { width: 80px; flex-shrink: 0; }
.channel-value { flex: 1; min-width: 0; }
.add-channel { align-self: flex-start; }

.notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 8px 10px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
}
.same-name-notice { margin-top: 8px; }
.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-primary);
  cursor: pointer;
  font-size: 12px;
}
.link-btn.strong { font-weight: 600; }
.link-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.meta-grid {
  margin: 4px 0 0;
  padding: 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--text-primary) 3%, transparent);
  border: 1px solid color-mix(in srgb, var(--border-color) 80%, transparent);
  display: grid;
  gap: 8px;
}
.meta-cell {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 8px;
  font-size: 11px;
}
.meta-cell dt { margin: 0; color: var(--text-muted); }
.meta-cell dd {
  margin: 0;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.detail-footer {
  display: flex;
  gap: 6px;
  padding: 10px 14px 14px;
  border-top: 1px solid var(--border-color);
}
.footer-btn {
  flex: 1;
  min-width: 0;
  height: 30px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
}
.footer-btn.danger:hover {
  color: var(--brand-alert);
  border-color: color-mix(in srgb, var(--brand-alert) 35%, var(--border-color));
  background: color-mix(in srgb, var(--brand-alert) 8%, transparent);
}

.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .contact-panel.detail-open { position: relative; }
  .contact-detail {
    position: absolute;
    inset: 0;
    width: auto;
    z-index: 5;
  }
}
</style>
