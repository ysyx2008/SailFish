<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, X, ExternalLink, Heart, RefreshCw } from 'lucide-vue-next'
import { useConfigStore, type AiProfile, type AgentMbtiType } from '../../stores/config'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()

const configStore = useConfigStore()

const showForm = ref(false)

// ESC 关闭编辑表单
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showForm.value) {
    e.stopImmediatePropagation()
    showForm.value = false
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})
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

// Steam 版本：不提供任何 AI/API 配置入口，仅展示说明（__STEAM_BUILD__ 由 vite define 注入）
const isSteamBuild = __STEAM_BUILD__

// 所有可用的预设模板
const allTemplates = [
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    recommended: true,
    isLocal: false
  },
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo',
    keyUrl: 'https://platform.openai.com/api-keys',
    isLocal: false
  },
  {
    name: 'Qwen',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    isLocal: false
  },
  {
    name: 'Ollama',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama2',
    keyUrl: 'https://ollama.com/',
    isLocal: true  // 本地服务，Steam版可用
  }
]

// 非 Steam 版显示全部模板；Steam 版不展示配置 UI，此处仅用于非 Steam
const templates = computed(() => {
  return allTemplates
})

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

// ==================== 觉醒模式 ====================
const awakened = ref(false)
const heartbeatInterval = ref(30)
const awakenedRunning = ref(false)

// 检查执行状态
const patrolling = ref(false)
const patrolStatus = ref<'idle' | 'running' | 'done' | 'skipped' | 'error'>('idle')
const patrolMessage = ref('')
let patrolStatusTimer: ReturnType<typeof setTimeout> | null = null

function clearPatrolStatus() {
  if (patrolStatusTimer) clearTimeout(patrolStatusTimer)
  patrolStatusTimer = setTimeout(() => {
    patrolStatus.value = 'idle'
    patrolMessage.value = ''
  }, 8000)
}

async function loadAwakenSettings() {
  try {
    awakened.value = !!(await window.electronAPI.config.get('agentAwakened'))
    const interval = await window.electronAPI.config.get('watchHeartbeatInterval')
    if (interval && typeof interval === 'number') heartbeatInterval.value = interval
    const statusList = await window.electronAPI.sensor.getStatus()
    awakenedRunning.value = statusList.some((s: any) => s.id === 'heartbeat' && s.running)
  } catch { /* ignore */ }
}

async function toggleAwakened() {
  const prev = !awakened.value
  try {
    await window.electronAPI.sensor.setAwakened(awakened.value, heartbeatInterval.value)
    awakenedRunning.value = awakened.value
  } catch (e) {
    console.error('Failed to toggle awakened:', e)
    awakened.value = prev
  }
}

async function updateAwakenInterval() {
  if (heartbeatInterval.value < 1) heartbeatInterval.value = 1
  if (heartbeatInterval.value > 1440) heartbeatInterval.value = 1440
  if (awakened.value) {
    await window.electronAPI.sensor.setAwakened(true, heartbeatInterval.value)
  } else {
    await window.electronAPI.config.set('watchHeartbeatInterval', heartbeatInterval.value)
  }
}

let patrolTimeout: ReturnType<typeof setTimeout> | null = null

async function manualHeartbeat() {
  patrolling.value = true
  patrolStatus.value = 'running'
  patrolMessage.value = t('awaken.patrolRunning')
  if (patrolTimeout) clearTimeout(patrolTimeout)
  patrolTimeout = setTimeout(() => {
    if (patrolling.value) {
      patrolling.value = false
      patrolStatus.value = 'done'
      patrolMessage.value = t('awaken.patrolDone')
      clearPatrolStatus()
    }
  }, 5 * 60 * 1000)
  try {
    await window.electronAPI.sensor.triggerHeartbeat()
  } catch (e) {
    patrolling.value = false
    patrolStatus.value = 'error'
    patrolMessage.value = t('awaken.patrolError')
    clearPatrolStatus()
  }
}

// 监听关切执行事件，更新检查状态
let cleanupTaskStarted: (() => void) | null = null
let cleanupTaskCompleted: (() => void) | null = null

function setupPatrolListeners() {
  cleanupTaskStarted = window.electronAPI.watch.onTaskStarted((data) => {
    if (data.watchName === '日常检查' || data.watchId === '__daily_patrol__') {
      patrolling.value = true
      patrolStatus.value = 'running'
      patrolMessage.value = t('awaken.patrolRunning')
    }
  })
  cleanupTaskCompleted = window.electronAPI.watch.onTaskCompleted((data: { watchId: string; result?: { success: boolean; error?: string; skipped?: boolean; skipReason?: string } }) => {
    if (data.watchId === '__daily_patrol__') {
      patrolling.value = false
      if (patrolTimeout) { clearTimeout(patrolTimeout); patrolTimeout = null }
      if (data.result?.success) {
        if (data.result.skipped) {
          patrolStatus.value = 'skipped'
          patrolMessage.value = t('awaken.patrolSkipped')
        } else {
          patrolStatus.value = 'done'
          patrolMessage.value = t('awaken.patrolDone')
        }
      } else {
        patrolStatus.value = 'error'
        patrolMessage.value = data.result?.error || t('awaken.patrolError')
      }
      clearPatrolStatus()
    }
  })
}

onMounted(() => {
  loadAwakenSettings()
  setupPatrolListeners()
})

onUnmounted(() => {
  cleanupTaskStarted?.()
  cleanupTaskCompleted?.()
  if (patrolStatusTimer) clearTimeout(patrolStatusTimer)
  if (patrolTimeout) clearTimeout(patrolTimeout)
})
</script>

<template>
  <div class="ai-settings">
    <!-- Steam 版：仅显示说明，不提供任何 AI/API 配置入口 -->
    <div v-if="isSteamBuild" class="settings-section steam-notice">
      <p class="section-desc">{{ t('aiSettings.steamNoAiConfig') }}</p>
    </div>

    <!-- 非 Steam 版：完整 AI 模型配置 -->
    <template v-if="!isSteamBuild">
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
        <p class="model-recommendation">
          {{ t('aiSettings.modelRecommendation') }}
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
            :class="{ recommended: template.recommended }"
            @click="applyTemplate(template)"
          >
            {{ template.name }}
            <span v-if="template.recommended" class="recommended-badge">{{ t('aiSettings.recommended') }}</span>
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
    </template>

    <!-- Agent 风格设置、调试、日志（仅非 Steam 版） -->
    <template v-if="!isSteamBuild">
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

      <div class="settings-section">
        <div class="section-header">
          <div class="section-title-group">
            <h4>
              <Heart :size="14" style="margin-right: 4px;" />
              {{ t('awaken.title') }}
            </h4>
            <span class="status-badge" :class="{ active: awakenedRunning }">
              <span class="status-dot"></span>
              {{ awakenedRunning ? t('awaken.running') : t('awaken.stopped') }}
            </span>
          </div>
        </div>
        <p class="section-desc">{{ t('awaken.description') }}</p>

        <div class="setting-row">
          <div>
            <label class="form-label">{{ t('awaken.enable') }}</label>
            <p class="setting-desc">{{ t('awaken.enableDesc') }}</p>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" v-model="awakened" @change="toggleAwakened" />
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="setting-row" v-if="awakened">
          <div>
            <label class="form-label">{{ t('awaken.interval') }}</label>
            <p class="setting-desc">{{ t('awaken.intervalDesc') }}</p>
          </div>
          <div class="input-group-compact">
            <input
              type="number"
              v-model.number="heartbeatInterval"
              :min="1"
              :max="1440"
              class="input"
              style="width: 80px;"
              @change="updateAwakenInterval"
            />
            <span class="input-suffix">min</span>
          </div>
        </div>

        <div class="setting-row" v-if="awakened">
          <div>
            <label class="form-label">{{ t('awaken.manualTrigger') }}</label>
            <p class="setting-desc">{{ t('awaken.manualTriggerDesc') }}</p>
          </div>
          <button class="btn btn-sm" :disabled="patrolling" @click="manualHeartbeat">
            <RefreshCw v-if="patrolling" :size="14" class="spin" />
            <Heart v-else :size="14" />
            {{ patrolling ? t('awaken.patrolRunning') : t('awaken.trigger') }}
          </button>
        </div>

        <div v-if="patrolStatus !== 'idle'" class="patrol-status" :class="patrolStatus">
          <RefreshCw v-if="patrolStatus === 'running'" :size="13" class="spin" />
          <span>{{ patrolMessage }}</span>
        </div>
      </div>

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

      <div class="settings-section">
        <div class="section-header">
          <h4>{{ t('aiSettings.logLevel') }}</h4>
          <select 
            class="log-level-select"
            :value="configStore.logLevel"
            @change="configStore.setLogLevel(($event.target as HTMLSelectElement).value as import('../../utils/logger').LogLevel)"
          >
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
            <option value="silent">Silent</option>
          </select>
        </div>
        <p class="section-desc">
          {{ t('aiSettings.logLevelDesc') }}
        </p>
      </div>
    </template>
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
  margin-bottom: 8px;
}

.model-recommendation {
  font-size: 12px;
  color: var(--accent-primary);
  background: rgba(137, 180, 250, 0.1);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 16px;
  border-left: 3px solid var(--accent-primary);
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

.template-btn.recommended {
  border-color: #10b981;
  color: #10b981;
  background: rgba(16, 185, 129, 0.08);
}

.template-btn.recommended:hover {
  background: #10b981;
  color: white;
  border-color: #10b981;
}

.template-btn .recommended-badge {
  font-size: 10px;
  font-weight: 500;
  margin-left: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(16, 185, 129, 0.15);
}

.template-btn.recommended:hover .recommended-badge {
  background: rgba(255, 255, 255, 0.2);
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

.log-level-select {
  padding: 4px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-color, #555);
  background: var(--bg-secondary, #2a2a2a);
  color: var(--text-primary, #e0e0e0);
  font-size: 13px;
  cursor: pointer;
  outline: none;
}

.log-level-select:focus {
  border-color: var(--accent-primary);
}

.section-title-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 500;
  padding: 2px 10px;
  border-radius: 12px;
  background: rgba(110, 118, 129, 0.12);
  color: var(--text-muted);
}

.status-badge.active {
  background: rgba(63, 185, 80, 0.12);
  color: var(--success-color, #3fb950);
}

.status-badge .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.status-badge.active .status-dot {
  box-shadow: 0 0 6px var(--success-color, #3fb950);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.setting-desc {
  font-size: 11px;
  color: var(--text-muted);
  margin: 2px 0 0;
}

.input-group-compact {
  display: flex;
  align-items: center;
  gap: 4px;
}

.input-suffix {
  font-size: 12px;
  color: var(--text-muted);
}

/* 检查状态 */
.patrol-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  margin-top: 4px;
}

.patrol-status.running {
  color: var(--accent-primary);
  background: rgba(137, 180, 250, 0.1);
}

.patrol-status.done {
  color: var(--success-color, #3fb950);
  background: rgba(63, 185, 80, 0.08);
}

.patrol-status.skipped {
  color: var(--text-muted);
  background: rgba(110, 118, 129, 0.08);
}

.patrol-status.error {
  color: var(--error-color, #f85149);
  background: rgba(248, 81, 73, 0.08);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 1s linear infinite;
}
</style>

