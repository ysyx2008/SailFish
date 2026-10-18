<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Pin, PinOff, Loader2, CircleDot, SquareTerminal } from 'lucide-vue-next'
import type { AgentHistorySummary } from '@shared/types'
import type { HistoryConversationTabStatus } from '../stores/terminal'
import { resolveConversationDisplayTitle } from '../utils/conversation-title'
import { resolveAssignedByPresentation } from '../utils/assigned-by-presentation'
import OriginMark from './OriginMark.vue'

const props = defineProps<{
  record: AgentHistorySummary
  isPinned?: boolean
  isOpening?: boolean
  isActive?: boolean
  tabStatus?: HistoryConversationTabStatus
  statusTooltip?: string
  isEditing?: boolean
  editingTitle?: string
  formattedTime: string
}>()

const emit = defineEmits<{
  open: []
  'toggle-pin': [event: MouseEvent]
  'context-menu': [event: MouseEvent]
  'commit-rename': []
  'cancel-rename': []
  'update:editingTitle': [value: string]
}>()

const { t } = useI18n()

const tabStatus = computed(() => props.tabStatus ?? 'closed')
const showStatusIcon = computed(() => tabStatus.value !== 'closed')
const isOpenInTab = computed(() => tabStatus.value === 'open' || tabStatus.value === 'running')

const handleItemClick = () => {
  if (props.isOpening || props.isEditing) return
  emit('open')
}

const handleContextMenu = (event: MouseEvent) => {
  if (props.isEditing) return
  event.preventDefault()
  emit('context-menu', event)
}

const normalizeTitle = (text: string): string => text.trim().replace(/\s+/g, ' ')

/** 没有标题的老记录会回退成任务原文，悬停提示不该跟着变成一整段 */
const TOOLTIP_TITLE_MAX = 120

const displayTitle = computed(() =>
  normalizeTitle(resolveConversationDisplayTitle(props.record))
)

/**
 * 终端会话与助手会话混在一条列表里，形态得能一眼看出。本机与远程共用一个终端图标，
 * 认出「这条来自终端」就够了；是哪台机器交给悬停提示，主机名太长不占行宽。
 *
 * 只在记录拿得出终端编号时才标：早期助手会话被误存成了本地终端，而它们没有编号，
 * 老记录的索引里也从未存过这个字段——宁可不标，也不标错。
 */
const hasTerminalEvidence = computed(() => !!props.record.terminalId)
const isSshConversation = computed(
  () => props.record.terminalType === 'ssh' && hasTerminalEvidence.value
)
const isTerminalConversation = computed(
  () => (props.record.terminalType === 'local' && hasTerminalEvidence.value) || isSshConversation.value
)

const originTooltip = computed(() => {
  if (isSshConversation.value) {
    return props.record.sshHost || t('welcome.sshConnect')
  }
  return t('welcome.localTerminal')
})

/**
 * 谁派的（目前只有联络）：和终端图标同一个位置、同一种做法。
 * 只认记录里记着的出身——这个功能之前派的任务当时没记，宁可不标，也不标错。
 * 它回答「当初是谁建的」，与终端图标回答的「在哪台机器上跑」是两件事；
 * 联络现在只能建无终端的任务，两者不会同时出现。
 */
const assignedByPresentation = computed(() => resolveAssignedByPresentation(props.record.assignedBy))

/**
 * 悬停提示不放任务原文：终端会话开头常是整段粘贴进来的终端输出，鼠标一停就糊住半个窗口。
 * 终端会话给主机——行里看不到它，其余只把被行宽截掉的标题补全。
 */
const itemTooltip = computed(() => {
  if (isTerminalConversation.value) return originTooltip.value
  return displayTitle.value.length > TOOLTIP_TITLE_MAX
    ? `${displayTitle.value.slice(0, TOOLTIP_TITLE_MAX)}…`
    : displayTitle.value
})

const editInputRef = ref<HTMLInputElement | null>(null)

watch(
  () => props.isEditing,
  async (editing) => {
    if (!editing) return
    await nextTick()
    const input = editInputRef.value
    if (!input) return
    input.focus()
    input.select()
  },
  { flush: 'post' }
)

const handleRenameKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    emit('commit-rename')
  } else if (event.key === 'Escape') {
    emit('cancel-rename')
  }
}
</script>

<template>
  <div
    class="conversation-row"
    :class="{
      'is-pinned': isPinned,
      'is-opening': isOpening,
      'is-active': isActive,
      'is-open-in-tab': isOpenInTab,
      'needs-attention': tabStatus === 'attention',
    }"
  >
    <div class="leading-slot">
      <button
        type="button"
        class="pin-btn"
        :class="{ 'is-visible': isPinned }"
        :title="isPinned ? t('welcome.conversations.unpin') : t('welcome.conversations.pin')"
        @click="emit('toggle-pin', $event)"
      >
        <PinOff v-if="isPinned" :size="12" />
        <Pin v-else :size="12" />
      </button>
      <span
        v-if="showStatusIcon"
        class="status-indicator"
        :class="`status-${tabStatus}`"
        :title="statusTooltip"
        :aria-label="statusTooltip"
        role="img"
      >
        <Loader2 v-if="tabStatus === 'running'" class="status-spinner" :size="11" />
        <span v-else-if="tabStatus === 'attention'" class="attention-dot" />
        <CircleDot v-else :size="11" :stroke-width="2" />
      </span>
    </div>
    <button
      type="button"
      class="conversation-item"
      :disabled="isOpening"
      :title="itemTooltip"
      @click="handleItemClick"
      @contextmenu="handleContextMenu"
    >
      <OriginMark
        v-if="isTerminalConversation && !isEditing"
        :icon="SquareTerminal"
        :hint="originTooltip"
      />
      <OriginMark
        v-if="assignedByPresentation && !isEditing"
        :icon="assignedByPresentation.icon"
        :hint="t(assignedByPresentation.hintKey)"
      />
      <input
        v-if="isEditing"
        ref="editInputRef"
        :value="editingTitle"
        class="title-input"
        :placeholder="t('welcome.conversations.renameClearHint')"
        @input="emit('update:editingTitle', ($event.target as HTMLInputElement).value)"
        @click.stop
        @keydown="handleRenameKeydown"
        @blur="emit('commit-rename')"
      />
      <span
        v-else
        class="item-title"
      >{{ displayTitle }}</span>
      <span class="item-time">{{ formattedTime }}</span>
    </button>
  </div>
</template>

<style scoped>
.conversation-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 6px 0 0;
  box-sizing: border-box;
  border-radius: 5px;
  cursor: grab;
  transition: background 0.12s ease, opacity 0.12s ease;
}

.conversation-row.is-opening {
  opacity: 0.55;
  pointer-events: none;
}

.conversation-row:hover {
  background: color-mix(in srgb, var(--bg-surface) 75%, transparent);
}

/* 当前这条只用一条竖条标住，不铺背景：侧栏上半的固定入口用整块背景表示「你在哪个地方」，
   人在终端看着终端会话时两处会同时亮，语汇分开才不像两个选中项在打架 */
.conversation-row.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 2px;
  height: 14px;
  transform: translateY(-50%);
  border-radius: 1px;
  background: var(--accent-primary);
}

.conversation-row.is-active .item-title,
.conversation-row.is-active:hover .item-title {
  color: var(--text-primary);
  font-weight: 500;
}

.conversation-row:hover .pin-btn {
  opacity: 0.65;
}

.conversation-row:hover .status-indicator {
  opacity: 0;
  pointer-events: none;
}

.conversation-row:hover .item-title {
  color: var(--text-primary);
}

.conversation-row.is-open-in-tab .item-title {
  color: var(--text-primary);
}

.conversation-row.is-open-in-tab:hover .item-title {
  color: var(--text-primary);
}

.conversation-row.needs-attention {
  background: rgba(var(--color-warning-rgb), 0.1);
}

.conversation-row.needs-attention .item-title {
  color: var(--color-warning);
}

/* 置顶与状态图标共用左侧 20px 槽位（始终保留缩进，与改版前 pin 列一致） */
.leading-slot {
  position: relative;
  flex-shrink: 0;
  width: 20px;
  height: 28px;
}

.pin-btn {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  z-index: 2;
  transition: opacity 0.12s ease, color 0.12s ease, background 0.12s ease;
}

.pin-btn.is-visible {
  opacity: 0.55;
}

.pin-btn:hover {
  opacity: 1 !important;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--bg-hover, var(--bg-surface)) 80%, transparent);
}

.status-indicator {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  transition: opacity 0.12s ease;
}

.status-open {
  color: var(--accent-primary);
  opacity: 0.85;
}

.status-running {
  color: var(--accent-primary);
}

.status-attention {
  color: var(--color-warning);
}

.status-spinner {
  animation: spin 1s linear infinite;
}

.attention-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-warning);
  animation: attention-pulse 1.5s ease-in-out infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@keyframes attention-pulse {
  0%, 100% {
    box-shadow: 0 0 0 0 rgba(var(--color-warning-rgb), 0.45);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(var(--color-warning-rgb), 0);
  }
}

.conversation-item {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0;
  font-family: inherit;
  text-align: left;
  background: transparent;
  border: none;
  border-radius: 5px;
  cursor: pointer;
}

.conversation-item:disabled {
  cursor: wait;
}

/* 来历图标平时压低对比度；鼠标在行上、或这行是当前对话时亮起来 */
.conversation-row:hover :deep(.origin-mark),
.conversation-row.is-active :deep(.origin-mark) {
  color: var(--text-secondary);
  opacity: 1;
}

.item-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.2;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.12s ease;
}

.title-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 4px;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--accent-primary);
  border-radius: 4px;
  box-sizing: border-box;
}

.item-time {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
