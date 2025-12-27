<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { AlertCircle, Terminal as TerminalIcon } from 'lucide-vue-next'
import { useTerminalStore } from '../stores/terminal'
import Terminal from './Terminal.vue'

const { t } = useI18n()
const terminalStore = useTerminalStore()

</script>

<template>
  <div class="terminal-container">
    <template v-if="terminalStore.tabs.length > 0">
      <div
        v-for="tab in terminalStore.tabs"
        :key="tab.id"
        class="terminal-wrapper"
        :class="{ active: tab.id === terminalStore.activeTabId }"
      >
        <Terminal
          v-if="tab.ptyId"
          :tab-id="tab.id"
          :pty-id="tab.ptyId"
          :type="tab.type"
          :is-active="tab.id === terminalStore.activeTabId"
        />
        <div v-else-if="tab.isLoading" class="terminal-loading">
          <div class="loading-spinner"></div>
          <span>{{ tab.loadingMessage || t('terminal.connecting') }}</span>
        </div>
        <div v-else class="terminal-error">
          <AlertCircle :size="48" />
          <span class="error-title">{{ t('terminal.connectionFailed') }}</span>
          <span v-if="tab.connectionError" class="error-detail">{{ tab.connectionError }}</span>
          <button class="btn btn-sm" @click="terminalStore.closeTab(tab.id)">{{ t('common.close') }}</button>
        </div>
      </div>
    </template>
    <div v-else class="terminal-empty">
      <div class="empty-content">
        <TerminalIcon :size="64" :stroke-width="1.5" style="opacity: 0.5" />
        <h3>{{ t('terminal.welcome.title') }}</h3>
        <p>{{ t('terminal.welcome.hint') }}</p>
        <button class="btn btn-primary" @click="terminalStore.createTab('local')">
          {{ t('terminal.newLocalTerminal') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  overflow: hidden;
}

.terminal-wrapper {
  display: none;
  flex: 1;
  overflow: hidden;
}

.terminal-wrapper.active {
  display: flex;
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
  to {
    transform: rotate(360deg);
  }
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

.terminal-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.empty-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  text-align: center;
}

.empty-content h3 {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-content p {
  font-size: 14px;
  color: var(--text-muted);
}
</style>

