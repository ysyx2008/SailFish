<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import { themes, type ThemeName, sponsorThemes } from '../../themes'
import { uiThemes, type UiThemeName } from '../../themes/ui-themes'
import { oemConfig } from '../../config/oem.config'

const { t } = useI18n()
const configStore = useConfigStore()

// 赞助状态和功能开关
const isSponsor = computed(() => configStore.isSponsor)
const showSponsor = computed(() => oemConfig.features.showSponsor)

// 检查主题是否为赞助者专属
const isSponsorTheme = (themeName: ThemeName): boolean => {
  return sponsorThemes.includes(themeName)
}

// 检查主题是否被锁定
const isThemeLocked = (themeName: ThemeName): boolean => {
  if (!showSponsor.value) return false  // OEM 版本隐藏赞助功能，不锁定
  return isSponsorTheme(themeName) && !isSponsor.value
}

// 终端主题
const currentTheme = computed(() => configStore.currentTheme)
const themeList = Object.keys(themes) as ThemeName[]

const setTheme = async (themeName: string) => {
  const theme = themeName as ThemeName
  if (isThemeLocked(theme)) {
    // 提示用户去支持
    alert(t('sponsor.unlockHint'))
    return
  }
  await configStore.setTheme(themeName)
}

// UI 主题
const currentUiTheme = computed(() => configStore.uiTheme)
const uiThemeList: UiThemeName[] = ['dark', 'light', 'blue']

const setUiTheme = async (themeName: UiThemeName) => {
  await configStore.setUiTheme(themeName)
}

// UI 主题预览样式
const getUiThemePreviewStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.bgPrimary,
    borderColor: theme.borderColor
  }
}

const getUiThemeHeaderStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.bgSecondary,
    borderColor: theme.borderColor
  }
}

const getUiThemeSidebarStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.bgSecondary,
    borderColor: theme.borderColor
  }
}

const getUiThemeTextStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    color: theme.textPrimary
  }
}

const getUiThemeMutedStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    color: theme.textMuted
  }
}

const getUiThemeAccentStyle = (themeName: UiThemeName) => {
  const theme = uiThemes[themeName]
  return {
    background: theme.accentPrimary
  }
}
</script>

<template>
  <div class="theme-settings">
    <!-- UI 主题选择 -->
    <div class="settings-section">
      <h4>{{ t('themeSettings.uiTheme') }}</h4>
      <p class="section-desc">{{ t('themeSettings.selectUiTheme') }}</p>

      <div class="ui-theme-grid">
        <div
          v-for="themeName in uiThemeList"
          :key="themeName"
          class="ui-theme-card"
          :class="{ active: currentUiTheme === themeName }"
          @click="setUiTheme(themeName)"
        >
          <div class="ui-theme-preview" :style="getUiThemePreviewStyle(themeName)">
            <!-- 模拟界面布局 -->
            <div class="preview-header" :style="getUiThemeHeaderStyle(themeName)">
              <div class="preview-dots">
                <span class="dot red"></span>
                <span class="dot yellow"></span>
                <span class="dot green"></span>
              </div>
              <span class="preview-title" :style="getUiThemeTextStyle(themeName)">Terminal</span>
            </div>
            <div class="preview-body">
              <div class="preview-sidebar" :style="getUiThemeSidebarStyle(themeName)">
                <div class="sidebar-item" :style="getUiThemeAccentStyle(themeName)"></div>
                <div class="sidebar-item" :style="getUiThemeMutedStyle(themeName)"></div>
                <div class="sidebar-item" :style="getUiThemeMutedStyle(themeName)"></div>
              </div>
              <div class="preview-content">
                <div class="content-line" :style="getUiThemeTextStyle(themeName)"></div>
                <div class="content-line short" :style="getUiThemeMutedStyle(themeName)"></div>
              </div>
            </div>
          </div>
          <div class="ui-theme-info">
            <span class="theme-name">{{ t(`themeSettings.uiThemes.${themeName}`) }}</span>
            <span v-if="currentUiTheme === themeName" class="theme-active">✓</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 终端主题选择 -->
    <div class="settings-section">
      <h4>{{ t('themeSettings.title') }}</h4>
      <p class="section-desc">{{ t('themeSettings.selectTheme') }}</p>

      <div class="theme-grid">
        <div
          v-for="themeName in themeList"
          :key="themeName"
          class="theme-card"
          :class="{ 
            active: currentTheme === themeName,
            locked: isThemeLocked(themeName as ThemeName)
          }"
          @click="setTheme(themeName)"
        >
          <div class="theme-preview" :style="{
            background: themes[themeName].background,
            color: themes[themeName].foreground,
            opacity: isThemeLocked(themeName as ThemeName) ? 0.5 : 1
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
            <!-- 锁定遮罩 -->
            <div v-if="isThemeLocked(themeName as ThemeName)" class="theme-lock-overlay">
              <div class="lock-icon">🔒</div>
              <div class="lock-hint">{{ t('sponsor.exclusive') }}</div>
            </div>
          </div>
          <div class="theme-info">
            <span class="theme-name">
              {{ themeName }}
              <span v-if="isSponsorTheme(themeName as ThemeName) && !isThemeLocked(themeName as ThemeName)" class="exclusive-badge">
                {{ t('sponsor.exclusive') }}
              </span>
            </span>
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

/* UI 主题网格 */
.ui-theme-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.ui-theme-card {
  border: 2px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  transition: all 0.2s ease;
}

.ui-theme-card:hover {
  border-color: var(--text-muted);
}

.ui-theme-card.active {
  border-color: var(--accent-primary);
}

.ui-theme-preview {
  height: 80px;
  border-radius: 4px 4px 0 0;
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid;
}

.preview-dots {
  display: flex;
  gap: 4px;
}

.preview-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.preview-dots .dot.red {
  background: #ff5f57;
}

.preview-dots .dot.yellow {
  background: #febc2e;
}

.preview-dots .dot.green {
  background: #28c840;
}

.preview-title {
  font-size: 8px;
  font-weight: 500;
}

.preview-body {
  display: flex;
  height: calc(100% - 22px);
}

.preview-sidebar {
  width: 30%;
  padding: 6px 4px;
  border-right: 1px solid;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-item {
  height: 6px;
  border-radius: 2px;
  opacity: 0.6;
}

.sidebar-item:first-child {
  opacity: 1;
}

.preview-content {
  flex: 1;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.content-line {
  height: 4px;
  border-radius: 2px;
  background: currentColor;
  opacity: 0.3;
}

.content-line.short {
  width: 60%;
}

.ui-theme-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
}

/* 终端主题网格 */
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
  position: relative;
}

.theme-card:hover:not(.locked) {
  border-color: var(--text-muted);
}

.theme-card.active {
  border-color: var(--accent-primary);
}

.theme-card.locked {
  cursor: not-allowed;
  opacity: 0.7;
}

.theme-card.locked:hover {
  border-color: var(--border-color);
}

.theme-preview {
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
  position: relative;
}

.theme-lock-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 6px;
}

.lock-icon {
  font-size: 24px;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.3));
}

.lock-hint {
  font-size: 11px;
  color: #ffd700;
  font-weight: 600;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
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
  display: flex;
  align-items: center;
  gap: 6px;
}

.exclusive-badge {
  font-size: 10px;
  padding: 2px 6px;
  background: linear-gradient(135deg, rgba(255, 215, 0, 0.2) 0%, rgba(255, 165, 0, 0.2) 100%);
  border: 1px solid rgba(255, 215, 0, 0.4);
  border-radius: 10px;
  color: #ffd700;
  font-weight: 600;
}

.theme-active {
  color: var(--accent-success);
  font-weight: 600;
}
</style>
