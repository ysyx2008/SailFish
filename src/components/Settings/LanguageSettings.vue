<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import { SUPPORTED_LOCALES, type LocaleType } from '../../i18n'

const { t } = useI18n()
const configStore = useConfigStore()

const currentLanguage = computed(() => configStore.language)

const changeLanguage = async (lang: LocaleType) => {
  await configStore.setLanguage(lang)
}
</script>

<template>
  <div class="language-settings">
    <div class="settings-section">
      <h3 class="section-title">{{ t('languageSettings.selectLanguage') }}</h3>
      <div class="language-list">
        <div
          v-for="locale in SUPPORTED_LOCALES"
          :key="locale.value"
          class="language-item"
          :class="{ active: currentLanguage === locale.value }"
          @click="changeLanguage(locale.value)"
        >
          <div class="language-info">
            <span class="language-name">{{ locale.label }}</span>
            <span class="language-code">{{ locale.value }}</span>
          </div>
          <div v-if="currentLanguage === locale.value" class="check-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
        </div>
      </div>
      <p class="hint">{{ t('languageSettings.restartHint') }}</p>
    </div>
  </div>
</template>

<style scoped>
.language-settings {
  padding: 0;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 16px;
}

.language-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.language-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.language-item:hover {
  background: var(--bg-hover);
  border-color: var(--accent-primary);
}

.language-item.active {
  border-color: var(--accent-primary);
  background: rgba(137, 180, 250, 0.1);
}

.language-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.language-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.language-code {
  font-size: 12px;
  color: var(--text-muted);
}

.check-icon {
  color: var(--accent-primary);
}

.hint {
  margin-top: 12px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
