<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, FolderOpen, Eye, X } from 'lucide-vue-next'

const { t } = useI18n()

// 用户技能类型
interface UserSkill {
  id: string
  name: string
  description: string
  version?: string
  enabled: boolean
  content: string
  filePath: string
  lastModified: number
}

// 状态
const skills = ref<UserSkill[]>([])
const loading = ref(false)
const skillsDir = ref('')

// ESC 关闭预览弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPreview.value) {
    e.stopImmediatePropagation()
    showPreview.value = false
    previewSkill.value = null
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})

// 预览弹窗
const showPreview = ref(false)
const previewSkill = ref<UserSkill | null>(null)
const previewContent = ref('')

// 计算属性
const enabledCount = computed(() => skills.value.filter(s => s.enabled).length)

// 加载技能列表
const loadSkills = async () => {
  loading.value = true
  try {
    skills.value = await window.electronAPI.userSkill.list()
    skillsDir.value = await window.electronAPI.userSkill.getSkillsDir()
  } catch (error) {
    console.error('Failed to load skills:', error)
  } finally {
    loading.value = false
  }
}

// 刷新技能列表
const refreshSkills = async () => {
  loading.value = true
  try {
    skills.value = await window.electronAPI.userSkill.refresh()
  } catch (error) {
    console.error('Failed to refresh skills:', error)
  } finally {
    loading.value = false
  }
}

// 切换技能启用状态
const toggleSkill = async (skill: UserSkill) => {
  const newEnabled = !skill.enabled
  const success = await window.electronAPI.userSkill.toggle(skill.id, newEnabled)
  if (success) {
    skill.enabled = newEnabled
  }
}

// 打开技能目录
const openFolder = async () => {
  await window.electronAPI.userSkill.openFolder()
}

// 查看技能内容
const viewSkill = async (skill: UserSkill) => {
  previewSkill.value = skill
  try {
    const content = await window.electronAPI.userSkill.getContent(skill.id)
    previewContent.value = content || skill.content
  } catch {
    previewContent.value = skill.content
  }
  showPreview.value = true
}

// 关闭预览
const closePreview = () => {
  showPreview.value = false
  previewSkill.value = null
  previewContent.value = ''
}

// 格式化时间
const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleString()
}

onMounted(() => {
  loadSkills()
})
</script>

<template>
  <div class="skill-settings">
    <div class="settings-section">
      <div class="section-header">
        <div class="header-left">
          <h4>{{ t('skillSettings.title') }}</h4>
          <span class="enabled-badge" v-if="enabledCount > 0">
            {{ enabledCount }} {{ t('skillSettings.enabled') }}
          </span>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" @click="refreshSkills" :disabled="loading" :title="t('skillSettings.refresh')">
            <RefreshCw :size="14" :class="{ spinning: loading }" />
          </button>
          <button class="btn btn-primary btn-sm" @click="openFolder">
            <FolderOpen :size="14" />
            {{ t('skillSettings.openFolder') }}
          </button>
        </div>
      </div>
      <p class="section-desc">
        {{ t('skillSettings.description') }}
      </p>

      <!-- 技能列表 -->
      <div class="skill-list">
        <div
          v-for="skill in skills"
          :key="skill.id"
          class="skill-item"
          :class="{ disabled: !skill.enabled }"
        >
          <div class="skill-toggle">
            <input
              type="checkbox"
              :checked="skill.enabled"
              @change="toggleSkill(skill)"
              :title="t('skillSettings.toggleEnable')"
            />
          </div>
          <div class="skill-info">
            <div class="skill-name">
              {{ skill.name }}
              <span class="skill-version" v-if="skill.version">v{{ skill.version }}</span>
            </div>
            <div class="skill-desc" v-if="skill.description">
              {{ skill.description }}
            </div>
          </div>
          <div class="skill-actions">
            <button class="btn-icon btn-sm" @click="viewSkill(skill)" :title="t('skillSettings.view')">
              <Eye :size="14" />
            </button>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-if="skills.length === 0 && !loading" class="empty-skills">
          <div class="empty-icon">📁</div>
          <p>{{ t('skillSettings.noSkills') }}</p>
          <p class="tip">{{ t('skillSettings.noSkillsTip') }}</p>
          <button class="btn btn-outline btn-sm" @click="openFolder">
            {{ t('skillSettings.openFolder') }}
          </button>
        </div>

        <!-- 加载中 -->
        <div v-if="loading && skills.length === 0" class="loading-skills">
          <div class="spinner"></div>
          <p>{{ t('skillSettings.loading') }}</p>
        </div>
      </div>

      <!-- 帮助信息 -->
      <div class="help-section">
        <h5>{{ t('skillSettings.howToAdd') }}</h5>
        <ol class="help-list">
          <li>{{ t('skillSettings.step1') }}</li>
          <li>{{ t('skillSettings.step2') }}</li>
          <li>{{ t('skillSettings.step3') }}</li>
        </ol>
        <div class="skill-format">
          <h6>{{ t('skillSettings.formatTitle') }}</h6>
          <pre class="format-example">---
name: {{ t('skillSettings.exampleName') }}
description: {{ t('skillSettings.exampleDesc') }}
version: 1.0
enabled: true
---

{{ t('skillSettings.exampleContent') }}</pre>
        </div>
      </div>
    </div>

    <!-- 预览弹窗 -->
    <div v-if="showPreview && previewSkill" class="preview-modal" @click.self="closePreview">
      <div class="preview-content">
        <div class="preview-header">
          <div class="preview-title">
            <h4>{{ previewSkill.name }}</h4>
            <span class="preview-version" v-if="previewSkill.version">v{{ previewSkill.version }}</span>
          </div>
          <button class="btn-icon" @click="closePreview">
            <X :size="16" />
          </button>
        </div>
        <div class="preview-meta">
          <span v-if="previewSkill.description">{{ previewSkill.description }}</span>
          <span class="preview-time">{{ t('skillSettings.lastModified') }}: {{ formatTime(previewSkill.lastModified) }}</span>
        </div>
        <div class="preview-body">
          <pre>{{ previewContent }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill-settings {
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

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.enabled-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent-green);
  color: var(--bg-primary);
  border-radius: 10px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

/* 技能列表 */
.skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.skill-item:hover {
  border-color: var(--accent-primary);
}

.skill-item.disabled {
  opacity: 0.5;
}

.skill-toggle input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-version {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: normal;
}

.skill-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-actions {
  display: flex;
  gap: 4px;
}

/* 空状态 */
.empty-skills {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-skills p {
  margin: 0 0 8px 0;
}

.empty-skills .tip {
  font-size: 12px;
  margin-bottom: 16px;
}

/* 加载中 */
.loading-skills {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 12px;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 帮助信息 */
.help-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.help-section h5 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}

.help-list {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 16px 20px;
  line-height: 1.8;
}

.skill-format {
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 12px;
}

.skill-format h6 {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--text-secondary);
}

.format-example {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-primary);
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

/* 预览弹窗 */
.preview-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.preview-content {
  width: 600px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.preview-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-title h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.preview-version {
  font-size: 12px;
  color: var(--text-muted);
}

.preview-meta {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preview-time {
  font-size: 11px;
}

.preview-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.preview-body pre {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 按钮样式 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 6px 10px;
  font-size: 12px;
}

.btn-primary {
  background: var(--accent-primary);
  color: var(--bg-primary);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
}

.btn-icon {
  padding: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
