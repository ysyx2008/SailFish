<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, DEFAULT_KEYBOARD_SHORTCUTS, type KeyboardShortcuts } from '../../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

const isMac = navigator.platform.toLowerCase().includes('mac')

type ShortcutAction = keyof KeyboardShortcuts

const shortcutActions: ShortcutAction[] = [
  'newLocalTerminal',
  'newSshConnection',
  'batchCommand',
  'openFileManager',
  'toggleSidebar',
  'toggleAiPanel',
  'toggleKnowledge',
  'clearTerminal',
  'openSettings',
  'aiDebugConsole',
]

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
    // F1-F12, keep as-is
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
  for (const action of shortcutActions) {
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

function clearShortcut(action: ShortcutAction, e: Event) {
  e.stopPropagation()
  const newShortcuts = { ...configStore.keyboardShortcuts, [action]: '' }
  configStore.setKeyboardShortcuts(newShortcuts)
  conflictMessage.value = ''
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
  }
}

const isModified = computed(() => {
  return shortcutActions.some(
    action => configStore.keyboardShortcuts[action] !== DEFAULT_KEYBOARD_SHORTCUTS[action]
  )
})
</script>

<template>
  <div class="shortcut-settings">
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('shortcutSettings.title') }}</h4>
        <button
          v-if="isModified"
          class="btn-reset-all"
          @click="resetAll"
        >
          {{ t('shortcutSettings.resetAll') }}
        </button>
      </div>
      <p class="section-description">{{ t('shortcutSettings.description') }}</p>

      <div class="shortcut-list">
        <div
          v-for="action in shortcutActions"
          :key="action"
          class="shortcut-row"
        >
          <span class="shortcut-label">{{ t(`shortcutSettings.actions.${action}`) }}</span>
          <div class="shortcut-input-area">
            <div
              class="shortcut-recorder"
              :class="{
                recording: recordingAction === action,
                empty: !configStore.keyboardShortcuts[action],
              }"
              tabindex="0"
              @click="startRecording(action)"
              @keydown="handleKeydown($event, action)"
            >
              <template v-if="recordingAction === action">
                <span class="recording-text">{{ t('shortcutSettings.recording') }}</span>
              </template>
              <template v-else-if="configStore.keyboardShortcuts[action]">
                <kbd
                  v-for="(key, i) in acceleratorToKeys(configStore.keyboardShortcuts[action])"
                  :key="i"
                  class="keycap"
                >{{ key }}</kbd>
              </template>
              <template v-else>
                <span class="empty-text">—</span>
              </template>
            </div>
            <div class="shortcut-actions">
              <button
                v-if="configStore.keyboardShortcuts[action]"
                class="btn-action"
                :title="t('shortcutSettings.clear')"
                @click="clearShortcut(action, $event)"
              >✕</button>
              <button
                v-if="configStore.keyboardShortcuts[action] !== DEFAULT_KEYBOARD_SHORTCUTS[action]"
                class="btn-action"
                :title="t('shortcutSettings.reset')"
                @click="resetShortcut(action, $event)"
              >↺</button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="conflictMessage" class="conflict-alert">
        ⚠️ {{ conflictMessage }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.shortcut-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.section-description {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.btn-reset-all {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-reset-all:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
  background: var(--bg-hover);
}

.shortcut-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 6px;
  transition: background 0.1s ease;
}

.shortcut-row:hover {
  background: var(--bg-hover);
}

.shortcut-label {
  font-size: 13px;
  color: var(--text-primary);
  min-width: 160px;
}

.shortcut-input-area {
  display: flex;
  align-items: center;
  gap: 6px;
}

.shortcut-recorder {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 140px;
  min-height: 30px;
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  cursor: pointer;
  outline: none;
  transition: all 0.15s ease;
  justify-content: center;
}

.shortcut-recorder:hover {
  border-color: var(--text-muted);
}

.shortcut-recorder:focus,
.shortcut-recorder.recording {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(var(--accent-rgb, 100, 149, 237), 0.2);
}

.shortcut-recorder.recording {
  background: rgba(var(--accent-rgb, 100, 149, 237), 0.05);
}

.shortcut-recorder.empty {
  border-style: dashed;
}

.recording-text {
  font-size: 12px;
  color: var(--accent-primary);
  font-style: italic;
}

.empty-text {
  font-size: 13px;
  color: var(--text-muted);
}

.keycap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  font-size: 11px;
  font-family: var(--font-mono, monospace);
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  box-shadow: 0 1px 0 var(--border-color);
  line-height: 1;
}

.shortcut-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.shortcut-row:hover .shortcut-actions {
  opacity: 1;
}

.btn-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-action:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.conflict-alert {
  margin-top: 12px;
  padding: 8px 12px;
  font-size: 12px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.1);
  border: 1px solid rgba(245, 158, 11, 0.2);
  border-radius: 6px;
}
</style>
