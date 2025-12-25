<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

// 本地编辑状态
const localRules = ref('')
const isSaving = ref(false)
const hasChanges = computed(() => localRules.value !== configStore.aiRules)

// 初始化时加载当前规则
onMounted(() => {
  localRules.value = configStore.aiRules
})

// 保存规则
const saveRules = async () => {
  if (!hasChanges.value) return
  isSaving.value = true
  try {
    await configStore.setAiRules(localRules.value)
  } finally {
    isSaving.value = false
  }
}

// 重置为已保存的内容
const resetRules = () => {
  localRules.value = configStore.aiRules
}

// 示例规则
const exampleRules = computed(() => [
  t('aiRulesSettings.examples.virtualEnv'),
  t('aiRulesSettings.examples.language'),
  t('aiRulesSettings.examples.safety'),
  t('aiRulesSettings.examples.style')
])

const insertExample = (example: string) => {
  if (localRules.value) {
    localRules.value += '\n' + example
  } else {
    localRules.value = example
  }
}
</script>

<template>
  <div class="ai-rules-settings">
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiRulesSettings.title') }}</h4>
      </div>
      <p class="section-desc">
        {{ t('aiRulesSettings.description') }}
      </p>

      <!-- 规则编辑区 -->
      <div class="rules-editor">
        <textarea
          v-model="localRules"
          class="rules-textarea"
          :placeholder="t('aiRulesSettings.placeholder')"
          rows="12"
        ></textarea>
        <div class="editor-footer">
          <div class="char-count">
            {{ localRules.length }} {{ t('aiRulesSettings.characters') }}
          </div>
          <div class="editor-actions">
            <button 
              class="btn btn-outline" 
              @click="resetRules"
              :disabled="!hasChanges"
            >
              {{ t('common.reset') }}
            </button>
            <button 
              class="btn btn-primary" 
              @click="saveRules"
              :disabled="!hasChanges || isSaving"
            >
              {{ isSaving ? t('common.saving') : t('common.save') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 保存状态提示 -->
      <div v-if="!hasChanges && localRules" class="save-status saved">
        ✓ {{ t('aiRulesSettings.saved') }}
      </div>
      <div v-else-if="hasChanges" class="save-status unsaved">
        ● {{ t('aiRulesSettings.unsaved') }}
      </div>
    </div>

    <!-- 示例规则 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiRulesSettings.examplesTitle') }}</h4>
      </div>
      <p class="section-desc">
        {{ t('aiRulesSettings.examplesDesc') }}
      </p>
      <div class="examples-list">
        <div 
          v-for="(example, index) in exampleRules" 
          :key="index" 
          class="example-item"
          @click="insertExample(example)"
        >
          <span class="example-text">{{ example }}</span>
          <button class="btn-icon btn-sm" :title="t('aiRulesSettings.insertExample')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 使用说明 -->
    <div class="settings-section tips-section">
      <div class="section-header">
        <h4>💡 {{ t('aiRulesSettings.tipsTitle') }}</h4>
      </div>
      <ul class="tips-list">
        <li>{{ t('aiRulesSettings.tips.tip1') }}</li>
        <li>{{ t('aiRulesSettings.tips.tip2') }}</li>
        <li>{{ t('aiRulesSettings.tips.tip3') }}</li>
        <li>{{ t('aiRulesSettings.tips.tip4') }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ai-rules-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
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
  margin-bottom: 8px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

/* 规则编辑器 */
.rules-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.rules-textarea {
  width: 100%;
  min-height: 200px;
  padding: 12px;
  font-size: 13px;
  font-family: var(--font-mono);
  line-height: 1.6;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  resize: vertical;
  transition: border-color 0.2s ease;
}

.rules-textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.rules-textarea::placeholder {
  color: var(--text-muted);
  font-family: inherit;
}

.editor-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.char-count {
  font-size: 11px;
  color: var(--text-muted);
}

.editor-actions {
  display: flex;
  gap: 8px;
}

.editor-actions .btn {
  padding: 6px 14px;
  font-size: 12px;
}

/* 保存状态 */
.save-status {
  margin-top: 8px;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 4px;
  display: inline-block;
}

.save-status.saved {
  color: #4caf50;
  background: rgba(76, 175, 80, 0.1);
}

.save-status.unsaved {
  color: #ff9800;
  background: rgba(255, 152, 0, 0.1);
}

/* 示例列表 */
.examples-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.example-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.example-item:hover {
  border-color: var(--accent-primary);
  background: var(--bg-surface);
}

.example-text {
  font-size: 12px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-right: 8px;
}

/* 使用提示 */
.tips-section {
  background: linear-gradient(135deg, rgba(137, 180, 250, 0.08) 0%, rgba(137, 180, 250, 0.02) 100%);
  border: 1px solid rgba(137, 180, 250, 0.2);
}

.tips-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.tips-list li {
  position: relative;
  padding-left: 20px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.tips-list li:last-child {
  margin-bottom: 0;
}

.tips-list li::before {
  content: '•';
  position: absolute;
  left: 6px;
  color: var(--accent-primary);
}
</style>

