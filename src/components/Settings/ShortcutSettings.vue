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
        <p class="section-description">{{ t('shortcutSettings.description') }}</p>
      </div>
      <button
        v-if="isModified"
        class="btn-reset-all"
        @click="resetAll"
      >
        {{ t('shortcutSettings.resetAll') }}
      </button>
    </div>

    <div v-if="conflictMessage" class="conflict-alert">
      {{ conflictMessage }}
    </div>

    <div
      v-for="(group, gi) in shortcutGroups"
      :key="gi"
      class="shortcut-group"
    >
      <div class="group-label">{{ group.label }}</div>
      <div class="shortcut-list">
        <div
          v-for="action in group.actions"
          :key="action"
          class="shortcut-row"
          :class="{ modified: isActionModified(action) }"
        >
          <span class="shortcut-label">{{ t(`shortcutSettings.actions.${action}`) }}</span>
          <div class="shortcut-right">
            <div class="shortcut-actions">
              <button
                v-if="configStore.keyboardShortcuts[action]"
                class="btn-action"
                :title="t('shortcutSettings.clear')"
                @click="clearShortcut(action, $event)"
              >✕</button>
              <button
                v-if="isActionModified(action)"
                class="btn-action btn-reset"
                :title="t('shortcutSettings.reset')"
                @click="resetShortcut(action, $event)"
              >↺</button>
            </div>
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
                <span class="keycap-group">
                  <kbd
                    v-for="(key, i) in acceleratorToKeys(configStore.keyboardShortcuts[action])"
                    :key="i"
                    class="keycap"
                  >{{ key }}</kbd>
                </span>
              </template>
              <template v-else>
                <span class="empty-text">{{ t('shortcutSettings.clickToSet') }}</span>
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
  display: flex;
  flex-direction: column;
  gap: 0;
  max-width: 560px;
}

.settings-header-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 16px;
}

.settings-header-bar h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}

.section-description {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.btn-reset-all {
  flex-shrink: 0;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  margin-top: 2px;
}

.btn-reset-all:hover {
  color: var(--text-primary);
  border-color: var(--text-muted);
  background: var(--bg-hover);
}

/* 分组 */
.shortcut-group {
  margin-bottom: 6px;
}

.group-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 10px 10px 6px;
  user-select: none;
}

.shortcut-list {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
}

.shortcut-row {
  display: flex;
  align-items: center;
  padding: 0 14px;
  height: 40px;
  transition: background 0.1s ease;
}

.shortcut-row + .shortcut-row {
  border-top: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
}

.shortcut-row:hover {
  background: var(--bg-hover);
}

.shortcut-label {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
}

.shortcut-row.modified .shortcut-label {
  color: var(--accent-primary);
}

.shortcut-right {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 操作按钮 */
.shortcut-actions {
  display: flex;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.shortcut-row:hover .shortcut-actions {
  opacity: 1;
}

.btn-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 12px;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.btn-action:hover {
  color: var(--text-primary);
  background: var(--bg-primary);
}

.btn-action.btn-reset:hover {
  color: var(--accent-primary);
}

/* 录制区域 */
.shortcut-recorder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 120px;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--bg-primary);
  cursor: pointer;
  outline: none;
  transition: all 0.15s ease;
}

.shortcut-recorder:hover {
  border-color: var(--border-color);
}

.shortcut-recorder:focus,
.shortcut-recorder.recording {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 2px rgba(var(--accent-rgb, 100, 149, 237), 0.15);
}

.shortcut-recorder.recording {
  background: rgba(var(--accent-rgb, 100, 149, 237), 0.06);
}

.shortcut-recorder.empty {
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--border-color) 70%, transparent);
}

.shortcut-recorder.empty:hover {
  border-color: var(--text-muted);
  background: var(--bg-primary);
}

.recording-text {
  font-size: 11px;
  color: var(--accent-primary);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.empty-text {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.6;
}

/* 按键样式 */
.keycap-group {
  display: flex;
  align-items: center;
  gap: 3px;
}

.keycap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 20px;
  padding: 0 5px;
  font-size: 11px;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', var(--font-mono, monospace);
  font-weight: 500;
  color: var(--text-primary);
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border: 1px solid var(--border-color);
  border-bottom-width: 2px;
  border-radius: 4px;
  line-height: 1;
  text-align: center;
}

/* 冲突提示 */
.conflict-alert {
  margin-bottom: 10px;
  padding: 8px 12px;
  font-size: 12px;
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.15);
  border-radius: 6px;
}
</style>
