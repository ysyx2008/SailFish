<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type LocalEncoding } from '../../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

const settings = ref({ ...configStore.terminalSettings })

// 保存设置
const saveSettings = async () => {
  configStore.terminalSettings.fontSize = settings.value.fontSize
  configStore.terminalSettings.fontFamily = settings.value.fontFamily
  configStore.terminalSettings.cursorBlink = settings.value.cursorBlink
  configStore.terminalSettings.cursorStyle = settings.value.cursorStyle
  configStore.terminalSettings.scrollback = settings.value.scrollback
  configStore.terminalSettings.localEncoding = settings.value.localEncoding
  configStore.terminalSettings.commandHighlight = settings.value.commandHighlight
  
  await window.electronAPI.config.set('terminalSettings', settings.value)
}

// 监听变化自动保存
watch(settings, saveSettings, { deep: true })

const fontFamilies = [
  { value: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace', label: 'Cascadia Code' },
  { value: '"Fira Code", "JetBrains Mono", Consolas, monospace', label: 'Fira Code' },
  { value: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono' },
  { value: 'Consolas, "Courier New", monospace', label: 'Consolas' },
  { value: '"Source Code Pro", monospace', label: 'Source Code Pro' },
  { value: '"Ubuntu Mono", monospace', label: 'Ubuntu Mono' }
]

// 本地终端编码选项
const encodingOptions: LocalEncoding[] = [
  'auto',
  'utf-8',
  'gbk',
  'gb2312',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'iso-8859-1',
  'iso-8859-15',
  'windows-1252',
  'koi8-r',
  'windows-1251'
]
</script>

<template>
  <div class="terminal-settings">
    <div class="settings-section">
      <h4>{{ t('terminalSettings.title') }}</h4>
      
      <div class="form-group">
        <label class="form-label">{{ t('terminalSettings.fontSize') }}</label>
        <div class="slider-group">
          <input
            v-model.number="settings.fontSize"
            type="range"
            min="10"
            max="24"
            step="1"
            class="slider"
          />
          <span class="slider-value">{{ settings.fontSize }}px</span>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">{{ t('terminalSettings.fontFamily') }}</label>
        <select v-model="settings.fontFamily" class="select">
          <option v-for="font in fontFamilies" :key="font.value" :value="font.value">
            {{ font.label }}
          </option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">{{ t('terminalSettings.cursorStyle') }}</label>
        <div class="radio-group">
          <label class="radio-item">
            <input v-model="settings.cursorStyle" type="radio" value="block" />
            <span class="cursor-preview block"></span>
            <span>{{ t('terminalSettings.cursorStyles.block') }}</span>
          </label>
          <label class="radio-item">
            <input v-model="settings.cursorStyle" type="radio" value="underline" />
            <span class="cursor-preview underline"></span>
            <span>{{ t('terminalSettings.cursorStyles.underline') }}</span>
          </label>
          <label class="radio-item">
            <input v-model="settings.cursorStyle" type="radio" value="bar" />
            <span class="cursor-preview bar"></span>
            <span>{{ t('terminalSettings.cursorStyles.bar') }}</span>
          </label>
        </div>
      </div>

      <div class="form-group">
        <label class="checkbox-item">
          <input v-model="settings.cursorBlink" type="checkbox" />
          <span>{{ t('terminalSettings.cursorBlink') }}</span>
        </label>
      </div>

      <div class="form-group">
        <label class="checkbox-item">
          <input v-model="settings.commandHighlight" type="checkbox" />
          <span>{{ t('terminalSettings.commandHighlight') }}</span>
        </label>
        <p class="form-hint">{{ t('terminalSettings.commandHighlightHint') }}</p>
      </div>
    </div>

    <div class="settings-section">
      <h4>{{ t('terminalSettings.scrollback') }}</h4>
      
      <div class="form-group">
        <label class="form-label">{{ t('terminalSettings.scrollback') }}</label>
        <div class="slider-group">
          <input
            v-model.number="settings.scrollback"
            type="range"
            min="1000"
            max="50000"
            step="1000"
            class="slider"
          />
          <span class="slider-value">{{ settings.scrollback }}</span>
        </div>
        <p class="form-hint">{{ t('terminalSettings.scrollbackHint') }}</p>
      </div>
    </div>

    <div class="settings-section">
      <h4>{{ t('terminalSettings.encoding') }}</h4>
      
      <div class="form-group">
        <label class="form-label">{{ t('terminalSettings.localEncoding') }}</label>
        <select v-model="settings.localEncoding" class="select">
          <option v-for="enc in encodingOptions" :key="enc" :value="enc">
            {{ t(`terminalSettings.encodings.${enc}`) }}
          </option>
        </select>
        <p class="form-hint">{{ t('terminalSettings.localEncodingHint') }}</p>
      </div>
    </div>

    <div class="settings-section preview-section">
      <h4>{{ t('themeSettings.preview') }}</h4>
      <div
        class="terminal-preview"
        :style="{
          fontFamily: settings.fontFamily,
          fontSize: settings.fontSize + 'px'
        }"
      >
        <div class="preview-line">
          <span class="green">user@qiyu</span>:<span class="blue">~</span>$ echo "Hello World"
        </div>
        <div class="preview-line">Hello World</div>
        <div class="preview-line">
          <span class="green">user@qiyu</span>:<span class="blue">~</span>$
          <span
            class="cursor"
            :class="[settings.cursorStyle, { blink: settings.cursorBlink }]"
          ></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.settings-section h4 {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 16px;
}

.slider-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  background: var(--bg-surface);
  border-radius: 2px;
  outline: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  background: var(--accent-primary);
  border-radius: 50%;
  cursor: pointer;
}

.slider-value {
  min-width: 60px;
  font-size: 13px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
}

.radio-group {
  display: flex;
  gap: 16px;
}

.radio-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}

.cursor-preview {
  width: 10px;
  height: 16px;
  background: var(--accent-primary);
}

.cursor-preview.block {
  width: 10px;
}

.cursor-preview.underline {
  height: 2px;
  align-self: flex-end;
}

.cursor-preview.bar {
  width: 2px;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}

.form-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 6px;
}

/* 预览 */
.terminal-preview {
  background: #1e1e2e;
  padding: 16px;
  border-radius: 6px;
  line-height: 1.5;
}

.preview-line {
  white-space: pre;
}

.preview-line .green {
  color: #a6e3a1;
}

.preview-line .blue {
  color: #89b4fa;
}

.cursor {
  display: inline-block;
  background: #cdd6f4;
  margin-left: 2px;
}

.cursor.block {
  width: 0.6em;
  height: 1.2em;
  vertical-align: text-bottom;
}

.cursor.underline {
  width: 0.6em;
  height: 2px;
  vertical-align: bottom;
}

.cursor.bar {
  width: 2px;
  height: 1.2em;
  vertical-align: text-bottom;
}

.cursor.blink {
  animation: blink 1s step-end infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>

