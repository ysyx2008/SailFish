<script setup lang="ts">
/**
 * 真终端宿主：分屏占位 + Teleport 实例池。
 * 终端页与助手换台共用，不含 AI 侧栏。
 */
import { shallowRef, triggerRef, computed, watch, provide } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, X } from 'lucide-vue-next'
import { useTerminalStore, isLocalOrSshTab } from '../stores/terminal'
import type { SplitPane, TerminalTab } from '../stores/terminal'
import { getAllTerminalPanes } from '../stores/split-pane-tree'
import Terminal from './Terminal.vue'
import SplitPaneView from './SplitPaneView.vue'
import { PANE_SLOT_REGISTRY_KEY, type PaneSlotRegistry } from './pane-slot-registry'

const { t } = useI18n()
const terminalStore = useTerminalStore()

const props = defineProps<{
  tab: { id: string }
  isActive: boolean
  /** 终端页连接失败时可关页；助手换台不要关对话 */
  showCloseOnError?: boolean
  /** 助手换台：简洁标题栏，可拖窗口、可关回对话台 */
  showStageChrome?: boolean
}>()

const emit = defineEmits<{
  sendToAi: [text: string]
}>()

// store 里找不到时兜底用 props.tab（组件只在有 tab 时才渲染，兜底分支几乎不触发）
const liveTab = computed<TerminalTab>(
  () => terminalStore.tabs.find(t => t.id === props.tab.id) ?? (props.tab as TerminalTab)
)

const terminalPanes = computed<SplitPane[]>(() => {
  if (!liveTab.value.splitLayout) return []
  return getAllTerminalPanes(liveTab.value.splitLayout).filter(p =>
    Boolean(p.ptyId) && !p.isConnecting && !p.connectionError
  )
})

const paneSlotElements = shallowRef<Record<string, HTMLElement>>({})

function registerPaneSlot(ptyId: string, el: HTMLElement) {
  if (paneSlotElements.value[ptyId] === el) return
  paneSlotElements.value = { ...paneSlotElements.value, [ptyId]: el }
  triggerRef(paneSlotElements)
}

provide<PaneSlotRegistry>(PANE_SLOT_REGISTRY_KEY, {
  register: registerPaneSlot,
  unregister: () => { /* no-op */ }
})

const stageTitle = computed(() => {
  const panes = terminalPanes.value
  const active = panes.find(p => p.isActive) ?? panes[0]
  return active
    ? terminalStore.getPaneConnectionName(active)
    : t('terminal.localTerminal')
})

async function closeHostedTerminal() {
  const ids = terminalPanes.value.map(p => p.id)
  for (const id of ids) {
    await terminalStore.closePane(props.tab.id, id)
  }
}

watch(terminalPanes, (panes) => {
  const validPtyIds = new Set(panes.map(p => p.ptyId).filter(Boolean) as string[])
  const next: Record<string, HTMLElement> = {}
  let changed = false
  for (const [ptyId, el] of Object.entries(paneSlotElements.value)) {
    if (validPtyIds.has(ptyId)) {
      next[ptyId] = el
    } else {
      changed = true
    }
  }
  if (changed) {
    paneSlotElements.value = next
    triggerRef(paneSlotElements)
  }
})
</script>

<template>
  <div class="terminal-pane-host">
    <div v-if="showStageChrome" class="stage-header">
      <span class="stage-title">{{ stageTitle }}</span>
      <button
        type="button"
        class="stage-close"
        :title="t('terminal.hosted.close')"
        :aria-label="t('terminal.hosted.close')"
        @click="closeHostedTerminal"
      >
        <X :size="14" />
      </button>
    </div>

    <SplitPaneView
      v-if="liveTab.splitLayout"
      :tab-id="liveTab.id"
      :layout="liveTab.splitLayout"
      :is-active="isActive"
      :enable-layout-drag="isLocalOrSshTab(liveTab)"
    />

    <div v-else-if="liveTab.isLoading" class="terminal-loading">
      <div class="loading-spinner"></div>
      <span>{{ liveTab.loadingMessage || t('terminal.connecting') }}</span>
      <button
        class="btn btn-sm"
        @click="terminalStore.closeTab(liveTab.id, true)"
      >{{ t('terminal.cancelConnect') }}</button>
    </div>

    <div v-else class="terminal-error">
      <AlertCircle :size="48" />
      <span class="error-title">{{ t('terminal.connectionFailed') }}</span>
      <span v-if="liveTab.connectionError" class="error-detail">{{ liveTab.connectionError }}</span>
      <button
        v-if="liveTab.hostKeyChanged"
        class="btn btn-sm"
        @click="terminalStore.rememberChangedHostKey(liveTab.id)"
      >{{ t('terminal.rememberNewHostKey') }}</button>
      <button
        v-if="showCloseOnError"
        class="btn btn-sm"
        @click="terminalStore.closeTab(liveTab.id)"
      >{{ t('common.close') }}</button>
    </div>

    <template v-for="pane in terminalPanes" :key="pane.ptyId">
      <Teleport
        v-if="pane.ptyId && paneSlotElements[pane.ptyId]"
        :to="paneSlotElements[pane.ptyId]"
      >
        <Terminal
          :tab-id="liveTab.id"
          :pty-id="pane.ptyId"
          :type="(pane.terminalType as 'local' | 'ssh')"
          :is-active="isActive && (pane.isActive ?? false)"
          @send-to-ai="emit('sendToAi', $event)"
        />
      </Teleport>
    </template>
  </div>
</template>

<style scoped>
.terminal-pane-host {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-width: 0;
  min-height: 0;
  height: 100%;
}

.terminal-pane-host > :deep(.split-pane) {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}

.stage-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  box-sizing: border-box;
  height: var(--workbench-panel-header-height, 38px);
  min-height: var(--workbench-panel-header-height, 38px);
  padding: 0 8px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}

.stage-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stage-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  -webkit-app-region: no-drag;
}

.stage-close:hover {
  background: rgba(var(--accent-error-rgb, 243, 139, 168), 0.2);
  color: var(--accent-error);
}

.stage-close:active {
  transform: scale(0.9);
}

.terminal-loading,
.terminal-error {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--text-muted);
}

.loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--bg-surface);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.terminal-error svg {
  color: var(--accent-error);
  opacity: 0.8;
}

.terminal-error .error-title {
  font-size: 16px;
  font-weight: 500;
  color: var(--text-primary);
}

.terminal-error .error-detail {
  font-size: 13px;
  color: var(--text-secondary);
  max-width: 400px;
  text-align: center;
  line-height: 1.5;
  padding: 8px 16px;
  background: var(--bg-surface);
  border-radius: 6px;
  border: 1px solid var(--border-primary);
}
</style>
