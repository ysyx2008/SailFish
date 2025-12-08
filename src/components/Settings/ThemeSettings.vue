<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import { themes, type ThemeName } from '../../themes'

const { t } = useI18n()
const configStore = useConfigStore()

const currentTheme = computed(() => configStore.currentTheme)

const themeList = Object.keys(themes) as ThemeName[]

const setTheme = async (themeName: string) => {
  await configStore.setTheme(themeName)
}
</script>

<template>
  <div class="theme-settings">
    <div class="settings-section">
      <h4>{{ t('themeSettings.title') }}</h4>
      <p class="section-desc">{{ t('themeSettings.selectTheme') }}</p>

      <div class="theme-grid">
        <div
          v-for="themeName in themeList"
          :key="themeName"
          class="theme-card"
          :class="{ active: currentTheme === themeName }"
          @click="setTheme(themeName)"
        >
          <div class="theme-preview" :style="{
            background: themes[themeName].background,
            color: themes[themeName].foreground
          }">
            <div class="preview-line">
              <span :style="{ color: themes[themeName].green }">user@host</span>
              <span :style="{ color: themes[themeName].foreground }">:</span>
              <span :style="{ color: themes[themeName].blue }">~</span>
              <span :style="{ color: themes[themeName].foreground }">$</span>
            </div>
            <div class="preview-line">
              <span :style="{ color: themes[themeName].yellow }">ls -la</span>
            </div>
            <div class="preview-line">
              <span :style="{ color: themes[themeName].cyan }">drwxr-xr-x</span>
              <span :style="{ color: themes[themeName].foreground }"> Documents</span>
            </div>
            <div class="preview-line">
              <span :style="{ color: themes[themeName].red }">-rw-r--r--</span>
              <span :style="{ color: themes[themeName].foreground }"> file.txt</span>
            </div>
          </div>
          <div class="theme-info">
            <span class="theme-name">{{ themeName }}</span>
            <span v-if="currentTheme === themeName" class="theme-active">✓</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.settings-section h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

.theme-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.theme-card {
  border: 2px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
}

.theme-card:hover {
  border-color: var(--text-muted);
}

.theme-card.active {
  border-color: var(--accent-primary);
}

.theme-preview {
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
}

.preview-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.theme-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

.theme-name {
  font-size: 12px;
  font-weight: 500;
  text-transform: capitalize;
}

.theme-active {
  color: var(--accent-success);
  font-weight: 600;
}
</style>

