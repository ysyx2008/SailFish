<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcuts } from '../../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

const isMac = navigator.platform.toLowerCase().includes('mac')

type ShortcutAction = keyof KeyboardShortcuts

interface ShortcutGroup {
  label: string
  actions: ShortcutAction[]
}

const shortcutGroups = computed<ShortcutGroup[]>(() => [
  {
    label: t('shortcutSettings.groups.create'),
    actions: ['newAssistantTab', 'newLocalTerminal', 'newSshConnection'],
  },
  {
    label: t('shortcutSettings.groups.view'),
    actions: ['toggleSidebar', 'toggleAiPanel', 'toggleKnowledge', 'openFileManager'],
  },
  {
    label: t('shortcutSettings.groups.edit'),
    actions: ['clearTerminal', 'batchCommand', 'openSettings', 'aiDebugConsole'],
  },
])

const allActions = computed(() => shortcutGroups.value.flatMap(g => g.actions))

const recordingAction = ref<ShortcutAction | null>(null)
const conflictMessage = ref<string>('')

function acceleratorToKeys(accelerator: string): string[] {
  if (!accelerator) return []
  const parts = accelerator.split('+')
  return parts.map(part => {
    if (isMac) {
      if (part === 'CmdOrCtrl') return '⌘'
      if (part === 'Shift') return '⇧'
      if (part === 'Alt') return '⌥'
    } else {
      if (part === 'CmdOrCtrl') return 'Ctrl'
    }
    if (part === ',') return ','
    return part
  })
}

function keyEventToAccelerator(e: KeyboardEvent): string | null {
  if (['Control', 'Meta', 'Shift', 'Alt'].includes(e.key)) {
    return null
  }

  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')

  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key === ',') key = ','
  else if (key === '.') key = '.'
  else if (key === '=') key = '='
  else if (key === '-') key = '-'
  else if (key.startsWith('F') && key.length > 1 && !isNaN(Number(key.slice(1)))) {
    // F1-F12
  } else if (key.length === 1) {
    key = key.toUpperCase()
  } else {
    switch (key) {
      case 'ArrowUp': key = 'Up'; break
      case 'ArrowDown': key = 'Down'; break
      case 'ArrowLeft': key = 'Left'; break
      case 'ArrowRight': key = 'Right'; break
      case 'Escape': key = 'Escape'; break
      case 'Enter': key = 'Enter'; break
      case 'Backspace': key = 'Backspace'; break
      case 'Delete': key = 'Delete'; break
      case 'Tab': key = 'Tab'; break
      default: return null
    }
  }

  parts.push(key)

  if (parts.length === 1 && !key.startsWith('F')) {
    return null
  }

  return parts.join('+')
}

function findConflict(accelerator: string, excludeAction: ShortcutAction): ShortcutAction | null {
  if (!accelerator) return null
  for (const action of allActions.value) {
    if (action === excludeAction) continue
    if (configStore.keyboardShortcuts[action] === accelerator) {
      return action
    }
  }
  return null
}

function startRecording(action: ShortcutAction) {
  recordingAction.value = action
  conflictMessage.value = ''
}

function handleKeydown(e: KeyboardEvent, action: ShortcutAction) {
  if (recordingAction.value !== action) return

  e.preventDefault()
  e.stopPropagation()

  if (e.key === 'Escape') {
    recordingAction.value = null
    conflictMessage.value = ''
    return
  }

  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      const newShortcuts = { ...configStore.keyboardShortcuts, [action]: '' }
      configStore.setKeyboardShortcuts(newShortcuts)
      recordingAction.value = null
      conflictMessage.value = ''
      return
    }
  }

  const accelerator = keyEventToAccelerator(e)
  if (!accelerator) return

  const conflict = findConflict(accelerator, action)
  if (conflict) {
    conflictMessage.value = t('shortcutSettings.conflict', {
      action: t(`shortcutSettings.actions.${conflict}`)
    })
    return
  }

  conflictMessage.value = ''
  const newShortcuts = { ...configStore.keyboardShortcuts, [action]: accelerator }
  configStore.setKeyboardShortcuts(newShortcuts)
  recordingAction.value = null
}

function handleBlur(action: ShortcutAction) {
  if (recordingAction.value === action) {
    recordingAction.value = null
    conflictMessage.value = ''
  }
}

function resetShortcut(action: ShortcutAction, e: Event) {
  e.stopPropagation()
  const newShortcuts = {
    ...configStore.keyboardShortcuts,
    [action]: DEFAULT_KEYBOARD_SHORTCUTS[action]
  }
  configStore.setKeyboardShortcuts(newShortcuts)
  conflictMessage.value = ''
}

function resetAll() {
  if (confirm(t('shortcutSettings.resetAllConfirm'))) {
    configStore.setKeyboardShortcuts({ ...DEFAULT_KEYBOARD_SHORTCUTS })
    conflictMessage.value = ''
    recordingAction.value = null
  }
}

const isModified = computed(() => {
  return allActions.value.some(
    action => configStore.keyboardShortcuts[action] !== DEFAULT_KEYBOARD_SHORTCUTS[action]
  )
})

function isActionModified(action: ShortcutAction): boolean {
  return configStore.keyboardShortcuts[action] !== DEFAULT_KEYBOARD_SHORTCUTS[action]
}
</script>

<template>
  <div class="shortcut-settings">
    <div class="settings-header-bar">
      <div>
        <h4>{{ t('shortcutSettings.title') }}</h4>
        <p class="section-desc">{{ t('shortcutSettings.description') }}</p>
      </div>
      <button
        v-if="isModified"
        class="btn-reset-all"
        @click="resetAll"
      >{{ t('shortcutSettings.resetAll') }}</button>
    </div>

    <Transition name="fade">
      <div v-if="conflictMessage" class="conflict-alert">
        {{ conflictMessage }}
      </div>
    </Transition>

    <div
      v-for="(group, gi) in shortcutGroups"
      :key="gi"
      class="shortcut-group"
    >
      <div class="group-label">{{ group.label }}</div>
      <div class="group-card">
        <div
          v-for="(action, ai) in group.actions"
          :key="action"
          class="shortcut-row"
          :class="{ 'first-row': ai === 0 }"
        >
          <span class="shortcut-label">
            {{ t(`shortcutSettings.actions.${action}`) }}
          </span>
          <div class="shortcut-right">
            <button
              v-if="isActionModified(action)"
              class="btn-inline"
              :title="t('shortcutSettings.reset')"
              @click="resetShortcut(action, $event)"
            >↺</button>
            <div
              class="shortcut-slot"
              :class="{
                recording: recordingAction === action,
                empty: !configStore.keyboardShortcuts[action] && recordingAction !== action,
                modified: isActionModified(action),
              }"
              tabindex="0"
              @click="startRecording(action)"
              @keydown="handleKeydown($event, action)"
              @blur="handleBlur(action)"
            >
              <template v-if="recordingAction === action">
                <span class="recording-dot"></span>
                <span class="recording-label">{{ t('shortcutSettings.recording') }}</span>
              </template>
              <template v-else-if="configStore.keyboardShortcuts[action]">
                <kbd
                  v-for="(key, i) in acceleratorToKeys(configStore.keyboardShortcuts[action])"
                  :key="i"
                  class="key"
                >{{ key }}</kbd>
              </template>
              <template v-else>
                <span class="empty-hint">—</span>
              </template>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcut-settings {
  max-width: 480px;
}

/* 头部 */
.settings-header-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.settings-header-bar h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.btn-reset-all {
  flex-shrink: 0;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.btn-reset-all:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
}

/* 分组 */
.shortcut-group {
  margin-bottom: 12px;
}

.group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0 2px 5px;
}

.group-card {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
}

/* 行 */
.shortcut-row {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  transition: background 0.1s;
}

.shortcut-row:not(.first-row) {
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--border-color) 40%, transparent);
}

.shortcut-row:hover {
  background: var(--bg-hover);
}

.shortcut-label {
  flex: 1;
  font-size: 13px;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shortcut-right {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 恢复按钮 */
.btn-inline {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  font-size: 13px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.12s;
}

.shortcut-row:hover .btn-inline {
  opacity: 1;
}

.btn-inline:hover {
  color: var(--accent-primary);
  background: var(--bg-primary);
}

/* 快捷键槽位 */
.shortcut-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 80px;
  height: 26px;
  padding: 0 8px;
  border-radius: 5px;
  border: 1px solid transparent;
  cursor: pointer;
  outline: none;
  transition: all 0.15s;
  user-select: none;
}

.shortcut-slot:hover {
  background: var(--bg-primary);
}

.shortcut-slot:focus {
  border-color: var(--accent-primary);
}

.shortcut-slot.recording {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 100, 149, 237), 0.08);
}

.shortcut-slot.empty {
  border: 1px dashed color-mix(in srgb, var(--border-color) 60%, transparent);
  opacity: 0.5;
}

.shortcut-slot.empty:hover {
  opacity: 1;
  border-color: var(--text-muted);
}

/* 录制状态 */
.recording-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-primary);
  animation: blink 1s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.recording-label {
  font-size: 11px;
  color: var(--accent-primary);
}

.empty-hint {
  font-size: 12px;
  color: var(--text-muted);
}

/* 按键 */
.key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 18px;
  padding: 0 4px;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-bottom-width: 2px;
  border-radius: 3px;
  line-height: 1;
}

/* 冲突提示 */
.conflict-alert {
  margin-bottom: 12px;
  padding: 7px 10px;
  font-size: 12px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.06);
  border: 1px solid rgba(245, 158, 11, 0.12);
  border-radius: 6px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
