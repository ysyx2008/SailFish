<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, X, ExternalLink } from 'lucide-vue-next'
import { useConfigStore, type AiProfile, type AgentMbtiType } from '../../stores/config'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()

const configStore = useConfigStore()

const showForm = ref(false)
const debugMode = computed(() => configStore.agentDebugMode)
const editingProfile = ref<AiProfile | null>(null)

const formData = ref<Partial<AiProfile>>({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  proxy: '',
  contextLength: 8000
})

const profiles = computed(() => configStore.aiProfiles)
const activeProfileId = computed(() => configStore.activeAiProfileId)
const currentMbti = computed(() => configStore.agentMbti)

// MBTI 类型数据 (排除 null，因为这是选项列表)
// 使用 computed 以便翻译能够响应语言切换
const mbtiTypes = computed(() => [
  // 分析师型 (NT)
  { type: 'INTJ' as const, name: t('aiSettings.mbtiTypes.INTJ.name'), desc: t('aiSettings.mbtiTypes.INTJ.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'INTP' as const, name: t('aiSettings.mbtiTypes.INTP.name'), desc: t('aiSettings.mbtiTypes.INTP.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'ENTJ' as const, name: t('aiSettings.mbtiTypes.ENTJ.name'), desc: t('aiSettings.mbtiTypes.ENTJ.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  { type: 'ENTP' as const, name: t('aiSettings.mbtiTypes.ENTP.name'), desc: t('aiSettings.mbtiTypes.ENTP.desc'), group: t('aiSettings.mbtiGroups.analyst') },
  // 外交官型 (NF)
  { type: 'INFJ' as const, name: t('aiSettings.mbtiTypes.INFJ.name'), desc: t('aiSettings.mbtiTypes.INFJ.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'INFP' as const, name: t('aiSettings.mbtiTypes.INFP.name'), desc: t('aiSettings.mbtiTypes.INFP.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'ENFJ' as const, name: t('aiSettings.mbtiTypes.ENFJ.name'), desc: t('aiSettings.mbtiTypes.ENFJ.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  { type: 'ENFP' as const, name: t('aiSettings.mbtiTypes.ENFP.name'), desc: t('aiSettings.mbtiTypes.ENFP.desc'), group: t('aiSettings.mbtiGroups.diplomat') },
  // 哨兵型 (SJ)
  { type: 'ISTJ' as const, name: t('aiSettings.mbtiTypes.ISTJ.name'), desc: t('aiSettings.mbtiTypes.ISTJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ISFJ' as const, name: t('aiSettings.mbtiTypes.ISFJ.name'), desc: t('aiSettings.mbtiTypes.ISFJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ESTJ' as const, name: t('aiSettings.mbtiTypes.ESTJ.name'), desc: t('aiSettings.mbtiTypes.ESTJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  { type: 'ESFJ' as const, name: t('aiSettings.mbtiTypes.ESFJ.name'), desc: t('aiSettings.mbtiTypes.ESFJ.desc'), group: t('aiSettings.mbtiGroups.sentinel') },
  // 探险家型 (SP)
  { type: 'ISTP' as const, name: t('aiSettings.mbtiTypes.ISTP.name'), desc: t('aiSettings.mbtiTypes.ISTP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
  { type: 'ISFP' as const, name: t('aiSettings.mbtiTypes.ISFP.name'), desc: t('aiSettings.mbtiTypes.ISFP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
  { type: 'ESTP' as const, name: t('aiSettings.mbtiTypes.ESTP.name'), desc: t('aiSettings.mbtiTypes.ESTP.desc'), group: t('aiSettings.mbtiGroups.explorer') },
  { type: 'ESFP' as const, name: t('aiSettings.mbtiTypes.ESFP.name'), desc: t('aiSettings.mbtiTypes.ESFP.desc'), group: t('aiSettings.mbtiGroups.explorer') }
])

const setMbti = async (mbti: AgentMbtiType) => {
  await configStore.setAgentMbti(mbti)
}

const resetForm = () => {
  formData.value = {
    name: '',
    apiUrl: '',
    apiKey: '',
    model: '',
    proxy: '',
    contextLength: 8000
  }
  editingProfile.value = null
}

const openNewProfile = () => {
  resetForm()
  showForm.value = true
}

const openEditProfile = (profile: AiProfile) => {
  editingProfile.value = profile
  formData.value = { ...profile }
  showForm.value = true
}

const saveProfile = async () => {
  if (!formData.value.name || !formData.value.apiUrl || !formData.value.model) {
    return
  }

  // API Key 未填写时给予提示确认
  if (!formData.value.apiKey) {
    const confirmed = confirm(t('aiSettings.confirmNoApiKey'))
    if (!confirmed) {
      return
    }
  }

  if (editingProfile.value) {
    await configStore.updateAiProfile({
      ...editingProfile.value,
      ...formData.value
    } as AiProfile)
  } else {
    await configStore.addAiProfile({
      id: uuidv4(),
      ...formData.value
    } as AiProfile)
  }

  showForm.value = false
  resetForm()
}

const deleteProfile = async (profile: AiProfile) => {
  if (confirm(t('aiSettings.confirmDeleteProfile'))) {
    await configStore.deleteAiProfile(profile.id)
  }
}

const setActive = async (profileId: string) => {
  await configStore.setActiveAiProfile(profileId)
}

// 预设模板
const templates = computed(() => [
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    name: 'Qwen',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key'
  },
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    name: 'Ollama',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama2',
    keyUrl: 'https://ollama.com/'
  }
])

const applyTemplate = (template: typeof templates.value[0]) => {
  formData.value.name = template.name
  formData.value.apiUrl = template.apiUrl
  formData.value.model = template.model
}

// 当前选中的模板对应的 keyUrl
const currentKeyUrl = computed(() => {
  const template = templates.value.find(t => t.apiUrl === formData.value.apiUrl)
  return template?.keyUrl || null
})

const openKeyUrl = (url: string) => {
  window.open(url, '_blank')
}
</script>

<template>
  <div class="ai-settings">
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.title') }}</h4>
        <button class="btn btn-primary btn-sm" @click="openNewProfile">
          <Plus :size="14" />
          {{ t('aiSettings.addProfile') }}
        </button>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.apiKeyNotRequired') }}
      </p>

      <!-- 配置列表 -->
      <div class="profile-list">
        <div
          v-for="profile in profiles"
          :key="profile.id"
          class="profile-item"
          :class="{ active: profile.id === activeProfileId }"
        >
          <div class="profile-radio">
            <input
              type="radio"
              :id="profile.id"
              :checked="profile.id === activeProfileId"
              @change="setActive(profile.id)"
            />
          </div>
          <div class="profile-info" @click="setActive(profile.id)">
            <div class="profile-name">{{ profile.name }}</div>
            <div class="profile-detail">{{ profile.model }} · {{ profile.apiUrl }}</div>
          </div>
          <div class="profile-actions">
            <button class="btn-icon btn-sm" @click="openEditProfile(profile)" :title="t('aiSettings.editProfile')">
              <Pencil :size="14" />
            </button>
            <button class="btn-icon btn-sm" @click="deleteProfile(profile)" :title="t('aiSettings.deleteProfile')">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
        <div v-if="profiles.length === 0" class="empty-profiles">
          <p>{{ t('aiSettings.noProfiles') }}</p>
          <p class="tip">{{ t('aiSettings.addProfile') }}</p>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单 -->
    <div v-if="showForm" class="profile-form">

      <div class="form-header">
        <h4>{{ editingProfile ? t('aiSettings.editProfile') : t('aiSettings.addProfile') }}</h4>
        <button class="btn-icon" @click="showForm = false" :title="t('common.close')">
          <X :size="16" />
        </button>
      </div>

      <!-- 快速模板 -->
      <div class="templates" v-if="!editingProfile">
        <span class="template-label">{{ t('setup.aiConfig.quickTemplates') }}</span>
        <button
          v-for="template in templates"
          :key="template.name"
          class="template-btn"
          @click="applyTemplate(template)"
        >
          {{ template.name }}
        </button>
      </div>

      <div class="form-body">
        <div class="form-group">
          <label class="form-label">{{ t('aiSettings.profileName') }} *</label>
          <input v-model="formData.name" type="text" class="input" :placeholder="t('aiSettings.profileNamePlaceholder')" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('aiSettings.apiUrl') }} *</label>
          <input v-model="formData.apiUrl" type="text" class="input" :placeholder="t('aiSettings.apiUrlPlaceholder')" />
        </div>
        <div class="form-group">
          <div class="form-label-row">
            <label class="form-label">{{ t('aiSettings.apiKey') }}</label>
            <button
              v-if="currentKeyUrl"
              class="get-key-btn"
              @click="openKeyUrl(currentKeyUrl)"
              :title="t('aiSettings.getApiKey')"
            >
              <ExternalLink :size="12" />
              <span>{{ t('aiSettings.getApiKey') }}</span>
            </button>
          </div>
          <input v-model="formData.apiKey" type="password" class="input" :placeholder="t('aiSettings.apiKeyPlaceholder')" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('aiSettings.model') }} *</label>
          <input v-model="formData.model" type="text" class="input" :placeholder="t('aiSettings.modelPlaceholder')" />
        </div>
        <div class="form-row">
          <div class="form-group flex-1">
            <label class="form-label">{{ t('aiSettings.contextLength') }}（{{ t('aiSettings.contextLengthHint') }}）</label>
            <input v-model.number="formData.contextLength" type="number" class="input" placeholder="8000" />
            <span class="form-hint">GPT-3.5(4K/16K)、GPT-4(8K/128K)、Claude(200K)、Qwen(32K)</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('aiSettings.proxy') }}</label>
          <input v-model="formData.proxy" type="text" class="input" :placeholder="t('aiSettings.proxyPlaceholder')" />
        </div>
      </div>
      <div class="form-footer">
        <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="saveProfile">{{ t('common.save') }}</button>
      </div>
    </div>

    <!-- Agent 调试模式 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.agentDebugMode') }}</h4>
        <label class="toggle-switch">
          <input 
            type="checkbox" 
            :checked="debugMode" 
            @change="configStore.setAgentDebugMode(($event.target as HTMLInputElement).checked)"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.agentDebugModeDesc') }}
      </p>
    </div>

    <!-- Agent 风格设置 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('aiSettings.agentPersonality') }}</h4>
        <button 
          v-if="currentMbti" 
          class="btn btn-sm" 
          @click="setMbti(null)"
        >
          {{ t('common.reset') }}
        </button>
      </div>
      <p class="section-desc">
        {{ t('aiSettings.agentPersonalityDesc') }}
      </p>

      <div class="mbti-grid">
        <div
          v-for="item in mbtiTypes"
          :key="item.type"
          class="mbti-card"
          :class="{ active: currentMbti === item.type }"
          @click="setMbti(item.type)"
        >
          <div class="mbti-type">{{ item.type }}</div>
          <div class="mbti-name">{{ item.name }}</div>
          <div class="mbti-desc">{{ item.desc }}</div>
          <div class="mbti-group">{{ item.group }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-settings {
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
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.profile-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.profile-item:hover {
  border-color: var(--accent-primary);
}

.profile-item.active {
  border-color: var(--accent-primary);
  background: rgba(137, 180, 250, 0.1);
}

.profile-radio input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.profile-info {
  flex: 1;
  min-width: 0;
}

.profile-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.profile-detail {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.profile-actions {
  display: flex;
  gap: 4px;
}

.empty-profiles {
  padding: 30px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-profiles .tip {
  font-size: 12px;
  margin-top: 8px;
}

/* 表单 */
.profile-form {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-color);
}

.form-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.templates {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.template-label {
  font-size: 12px;
  color: var(--text-muted);
}

.template-btn {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.template-btn:hover {
  background: var(--accent-primary);
  color: var(--bg-primary);
}

.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.get-key-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.get-key-btn:hover {
  background: var(--accent-primary);
  color: white;
}

.form-body {
  padding: 16px;
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

.form-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

/* MBTI 选择 */
.mbti-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.mbti-card {
  display: flex;
  flex-direction: column;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: center;
}

.mbti-card:hover {
  border-color: var(--accent-primary);
  background: var(--bg-surface);
}

.mbti-card.active {
  border-color: var(--accent-primary);
  background: rgba(137, 180, 250, 0.15);
}

.mbti-type {
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-primary);
  font-family: var(--font-mono);
  letter-spacing: 1px;
}

.mbti-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-top: 4px;
}

.mbti-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.4;
}

.mbti-group {
  font-size: 10px;
  color: var(--text-muted);
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color);
  opacity: 0.7;
}

/* Toggle Switch */
.toggle-switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 24px;
  transition: 0.3s;
}

.toggle-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 2px;
  bottom: 2px;
  background-color: var(--text-muted);
  border-radius: 50%;
  transition: 0.3s;
}

.toggle-switch input:checked + .toggle-slider {
  background-color: var(--accent-primary);
  border-color: var(--accent-primary);
}

.toggle-switch input:checked + .toggle-slider:before {
  transform: translateX(20px);
  background-color: white;
}
</style>

