<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, RefreshCw, X } from 'lucide-vue-next'
import { useUpdateNotify } from '../../composables/useUpdateNotify'

const { t } = useI18n()
const { model, runPrimary, runSecondary, runChangelog, runDismiss } = useUpdateNotify()

const title = computed(() => {
  const version = model.version
  if (model.phase === 'downloading') {
    return t('about.downloadingUpdate')
  }
  if (model.phase === 'ready') {
    return t('about.updateReady', { version })
  }
  return t('about.newVersionAvailable', { version })
})

const message = computed(() => {
  const version = model.version
  // available：优先展示版本摘要；download/ready 用操作向提示，避免 changelog 挤掉进度说明
  if (model.phase === 'available' && model.summary) return model.summary
  if (model.phase === 'downloading') {
    return t('about.updateNotifyDownloadingHint', { version })
  }
  if (model.phase === 'ready') {
    return model.installOnQuitEnabled
      ? t('about.updateNotifyReadyHint', { version })
      : t('about.updateNotifyReadyHintNoQuit', { version })
  }
  if (model.isMac) {
    return t('about.updateNotifyMacHint', { version })
  }
  return t('about.updateNotifyAvailableHint', { version })
})

const primaryLabel = computed(() => {
  if (model.phase === 'ready') return t('about.installAndRestart')
  if (model.isMac) return t('about.goToDownload')
  return t('about.downloadUpdate')
})

const secondaryLabel = computed(() => {
  if (model.phase === 'downloading') return ''
  if (model.phase === 'ready' && model.installOnQuitEnabled) {
    return t('about.installOnQuit')
  }
  return t('about.updateLater')
})

const showPrimary = computed(() => model.phase !== 'downloading')
const showSecondary = computed(() => model.phase !== 'downloading' && !!secondaryLabel.value)

function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const progressText = computed(() => {
  if (model.phase !== 'downloading') return ''
  const pct = Number.isFinite(model.percent) ? model.percent.toFixed(0) : '0'
  return `${pct}% · ${formatBytes(model.transferred)} / ${formatBytes(model.total)}`
})
</script>

<template>
  <Teleport to="body">
    <Transition name="update-notify">
      <aside
        v-if="model.visible"
        class="update-notify-card"
        role="status"
        aria-live="polite"
      >
        <header class="update-notify-header">
          <span class="update-notify-icon">
            <RefreshCw v-if="model.phase === 'ready'" :size="16" />
            <Download v-else :size="16" />
          </span>
          <div class="update-notify-titles">
            <div class="update-notify-title">{{ title }}</div>
            <div class="update-notify-message">{{ message }}</div>
          </div>
          <button
            type="button"
            class="update-notify-close"
            :aria-label="t('common.close')"
            @click="runDismiss"
          >
            <X :size="14" />
          </button>
        </header>

        <div v-if="model.phase === 'downloading'" class="update-notify-progress">
          <div class="progress-track">
            <div
              class="progress-fill"
              :style="{ width: `${Math.min(100, Math.max(0, model.percent || 0))}%` }"
            />
          </div>
          <div class="progress-meta">{{ progressText }}</div>
        </div>

        <footer class="update-notify-actions">
          <button
            v-if="showPrimary"
            type="button"
            class="btn primary"
            :disabled="model.primaryBusy"
            @click="runPrimary"
          >
            {{ primaryLabel }}
          </button>
          <button
            v-if="showSecondary"
            type="button"
            class="btn secondary"
            :disabled="model.primaryBusy"
            @click="runSecondary"
          >
            {{ secondaryLabel }}
          </button>
          <button
            type="button"
            class="btn link"
            :disabled="model.primaryBusy"
            @click="runChangelog"
          >
            {{ t('about.viewChangelog') }}
          </button>
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.update-notify-card {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 10000;
  width: min(380px, calc(100vw - 40px));
  padding: 14px 14px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.25));
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.28);
  pointer-events: auto;
}

.update-notify-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.update-notify-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-top: 1px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent-primary) 18%, transparent);
  color: var(--accent-primary);
  flex-shrink: 0;
}

.update-notify-titles {
  flex: 1;
  min-width: 0;
}

.update-notify-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.35;
}

.update-notify-message {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary, var(--text-muted));
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.update-notify-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
}
.update-notify-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.update-notify-progress {
  margin-top: 12px;
}

.progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--bg-tertiary, rgba(127, 127, 127, 0.2));
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent-primary);
  transition: width 0.2s ease;
}

.progress-meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}

.update-notify-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
  align-items: center;
}

.btn {
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  padding: 7px 12px;
  transition: opacity 0.15s, background 0.15s;
}
.btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.btn.primary {
  background: var(--accent-primary);
  color: #fff;
}
.btn.primary:hover:not(:disabled) {
  opacity: 0.9;
}
.btn.secondary {
  background: var(--bg-tertiary, rgba(127, 127, 127, 0.18));
  color: var(--text-primary);
}
.btn.secondary:hover:not(:disabled) {
  background: var(--bg-hover);
}
.btn.link {
  margin-left: auto;
  padding: 7px 4px;
  background: transparent;
  color: var(--accent-primary);
}
.btn.link:hover:not(:disabled) {
  opacity: 0.85;
}

.update-notify-enter-active,
.update-notify-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.update-notify-enter-from,
.update-notify-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
