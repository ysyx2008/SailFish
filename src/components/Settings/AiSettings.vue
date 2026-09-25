<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, X, ExternalLink, Eye, Copy, GripVertical, RefreshCw, ChevronDown, Camera } from 'lucide-vue-next'
import { useConfigStore, type AiProfile, type AiModelType, type ApiFormat } from '../../stores/config'
import { showAlert, showConfirm } from '../../composables/useConfirm'
import type { FetchedAiModel } from '@shared/types'
import { AI_TEMPLATES, RECOMMENDED_MIN_CONTEXT } from '../../config/ai-templates'
import { v4 as uuidv4 } from 'uuid'
import { SettingsPage, SettingsGroup, SettingRow, SettingToggle } from './kit'
import AppSelect from '../common/AppSelect.vue'

const { t, locale } = useI18n()

const configStore = useConfigStore()

const showForm = ref(false)
const isCopyMode = ref(false)

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

const editingProfile = ref<AiProfile | null>(null)

const formData = ref<Partial<AiProfile>>({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  proxy: '',
  contextLength: 128000,
  maxOutputTokens: undefined,
  temperature: undefined,
  modelType: 'general' as AiModelType,
  visionProfileId: undefined,
  apiFormat: 'auto' as ApiFormat
})

const profiles = computed(() => configStore.aiProfiles)
const activeProfileId = computed(() => configStore.activeAiProfileId)

const resetForm = () => {
  formData.value = {
    name: '',
    apiUrl: '',
    apiKey: '',
    model: '',
    proxy: '',
    contextLength: 128000,
    maxOutputTokens: undefined,
    temperature: undefined,
    modelType: 'general' as AiModelType,
    visionProfileId: undefined,
    apiFormat: 'auto' as ApiFormat
  }
  editingProfile.value = null
}

// 可选的视觉模型列表（排除正在编辑的自身）
const visionProfileOptions = computed(() => {
  return profiles.value.filter(p => 
    p.modelType === 'vision' && p.id !== editingProfile.value?.id
  )
})
const modelTypeOptions = computed(() => [
  { value: 'general', label: t('aiSettings.modelTypeGeneral') },
  { value: 'vision', label: t('aiSettings.modelTypeVision') },
])
const visionSelectOptions = computed(() => [
  { value: '', label: t('aiSettings.visionProfileNone') },
  ...visionProfileOptions.value.map(vp => ({ value: vp.id, label: `${vp.name} (${vp.model})` })),
])
const apiFormatOptions = computed(() => [
  { value: 'auto', label: t('aiSettings.apiFormatAuto') },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
])

const contextLengthInK = computed({
  get: () => {
    const v = formData.value.contextLength
    return v ? Math.round(v / 1000) : undefined
  },
  set: (val: number | undefined) => {
    formData.value.contextLength = val ? val * 1000 : undefined
  }
})

const contextLengthTooSmall = computed(() => {
  const v = formData.value.contextLength
  return typeof v === 'number' && v > 0 && v < RECOMMENDED_MIN_CONTEXT
})

const openNewProfile = () => {
  resetForm()
  isCopyMode.value = false
  showForm.value = true
}

const openEditProfile = (profile: AiProfile) => {
  editingProfile.value = profile
  formData.value = { ...profile }
  isCopyMode.value = false
  showForm.value = true
}

// 基于现有配置创建新配置：预填内容、名称附"副本"后缀，由用户确认后保存为新配置
const openCopyProfile = (profile: AiProfile) => {
  editingProfile.value = null
  const { id: _id, ...rest } = profile
  formData.value = {
    ...rest,
    name: `${profile.name} ${t('aiSettings.copySuffix')}`,
  }
  isCopyMode.value = true
  showForm.value = true
}

// ==================== API Key 测试 ====================
type TestState = 'idle' | 'testing' | 'success' | 'error'
const testState = ref<TestState>('idle')
const testMessage = ref('')

const testApiKey = async () => {
  if (testState.value === 'testing') return
  testState.value = 'testing'
  testMessage.value = ''
  try {
    const result = await window.electronAPI.ai.testApiKey({
      apiUrl: formData.value.apiUrl,
      apiKey: formData.value.apiKey,
      model: formData.value.model,
      proxy: formData.value.proxy,
      apiFormat: formData.value.apiFormat,
    })
    testState.value = result.success ? 'success' : 'error'
    testMessage.value = result.success
      ? t('aiSettings.testSuccess', { ms: result.latencyMs ?? 0 })
      : (result.message || t('aiSettings.testConnectionFailed'))
  } catch (e) {
    // IPC 层异常时不展示 Error invoking remote method 原始堆栈文案
    console.warn('testApiKey IPC error:', e)
    testState.value = 'error'
    testMessage.value = t('aiSettings.testConnectionFailed')
  }
}

// 表单字段变化时重置测试状态
watch(
  () => [formData.value.apiUrl, formData.value.apiKey, formData.value.model, formData.value.proxy],
  () => {
    testState.value = 'idle'
    testMessage.value = ''
  }
)

// ==================== 模型列表拉取 ====================
const fetchedModels = ref<FetchedAiModel[]>([])
const isFetchingModels = ref(false)
const fetchModelsError = ref('')
const showModelDropdown = ref(false)

const fetchModels = async () => {
  if (isFetchingModels.value || !formData.value.apiUrl) return
  isFetchingModels.value = true
  fetchModelsError.value = ''
  fetchedModels.value = []
  try {
    const result = await window.electronAPI.ai.fetchModels({
      apiUrl: formData.value.apiUrl,
      apiKey: formData.value.apiKey,
      proxy: formData.value.proxy,
      apiFormat: formData.value.apiFormat,
    })
    if (result.error) {
      fetchModelsError.value = result.error
    } else {
      fetchedModels.value = result.models
      if (result.models.length > 0) showModelDropdown.value = true
    }
  } catch (e) {
    fetchModelsError.value = e instanceof Error ? e.message : String(e)
  } finally {
    isFetchingModels.value = false
  }
}

const selectModel = (model: FetchedAiModel) => {
  formData.value.model = model.id
  if (model.supportsVision) {
    formData.value.modelType = 'vision'
  }
  if (model.contextLength) {
    formData.value.contextLength = model.contextLength
  }
  if (model.maxOutputTokens) {
    formData.value.maxOutputTokens = model.maxOutputTokens
  }
  showModelDropdown.value = false
}

// 失焦时延迟关闭下拉：留出时间让下拉项的 click 先触发（否则 blur 先关闭会吞掉点击）
const hideModelDropdownDelayed = () => {
  setTimeout(() => { showModelDropdown.value = false }, 150)
}

// 切换 apiUrl 时清空已拉取的列表
watch(() => formData.value.apiUrl, () => {
  fetchedModels.value = []
  fetchModelsError.value = ''
  showModelDropdown.value = false
})

const saveProfile = async () => {
  if (!formData.value.name || !formData.value.apiUrl || !formData.value.model) {
    return
  }

  // API Key 未填写时给予提示确认（必须用应用内弹窗：Windows 上原生 confirm
  // 关掉后窗口看似在前台，页面实际收不到点击，要 Alt+Tab 才恢复）
  if (!formData.value.apiKey) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('aiSettings.confirmNoApiKeyTitle'),
      message: t('aiSettings.confirmNoApiKey'),
      detail: t('aiSettings.confirmNoApiKeyDetail'),
    })
    if (!confirmed) {
      return
    }
  }

  // 窗口偏小时拦一下。只在「这次保存才把它配成小窗口」时打断——已经在用小模型的人
  // 回来改个 temperature 不该被反复拦（见 AISERVICE_SPEC）
  if (contextLengthTooSmall.value && editingProfile.value?.contextLength !== formData.value.contextLength) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('aiSettings.confirmSmallContextTitle'),
      message: t('aiSettings.confirmSmallContext', { size: contextLengthInK.value }),
      detail: t('aiSettings.confirmSmallContextDetail'),
      confirmText: t('aiSettings.confirmSmallContextConfirm'),
      cancelText: t('aiSettings.confirmSmallContextCancel'),
    })
    if (!confirmed) {
      return
    }
  }

  // v-model.number 清空时返回空字符串，需要还原为 undefined
  const data = { ...formData.value }
  if (typeof data.temperature !== 'number' || isNaN(data.temperature)) {
    data.temperature = undefined
  }

  if (editingProfile.value) {
    await configStore.updateAiProfile({
      ...editingProfile.value,
      ...data
    } as AiProfile)
  } else {
    await configStore.addAiProfile({
      id: uuidv4(),
      ...data
    } as AiProfile)
  }

  showForm.value = false
  resetForm()
}

const deleteProfile = async (profile: AiProfile) => {
  if (profiles.value.length <= 1) {
    await showAlert(t('aiSettings.deleteProfile'), t('aiSettings.cannotDeleteLast'))
    return
  }
  if (profile.id === activeProfileId.value) {
    await showAlert(t('aiSettings.deleteProfile'), t('aiSettings.cannotDeleteActive'))
    return
  }
  const active = profiles.value.find(p => p.id === activeProfileId.value)
  if (active?.visionProfileId === profile.id) {
    await showAlert(t('aiSettings.deleteProfile'), t('aiSettings.cannotDeleteActiveVision'))
    return
  }

  const referrers = profiles.value.filter(p => p.id !== profile.id && p.visionProfileId === profile.id)
  const names = referrers.map(p => p.name).join(locale.value.startsWith('zh') ? '、' : ', ')
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('aiSettings.deleteProfile'),
    message: referrers.length
      ? t('aiSettings.confirmDeleteReferenced', { name: profile.name, names })
      : t('aiSettings.confirmDeleteProfile'),
    detail: referrers.length ? t('aiSettings.confirmDeleteReferencedDetail') : undefined,
  })
  if (!confirmed) return
  await configStore.deleteAiProfile(profile.id)
}

const setActive = async (profileId: string) => {
  await configStore.setActiveAiProfile(profileId)
}

// ==================== 拖拽排序 ====================
// insertIndex 语义：0..profiles.length，表示插入到该索引之前（= profiles.length 表示追加到末尾）
const dragIndex = ref<number | null>(null)
const insertIndex = ref<number | null>(null)

// 当前是否显示落点指示：需要有拖拽来源、有目标位置、且位置不是"原地放下"
const showInsertLine = computed(() => {
  const from = dragIndex.value
  const ins = insertIndex.value
  if (from === null || ins === null) return false
  return ins !== from && ins !== from + 1
})

const handleProfileDragStart = (index: number, event: DragEvent) => {
  dragIndex.value = index
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', index.toString())
  }
}

const handleProfileDragOver = (index: number, event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  // 根据光标 Y 位置判断插入点：上半区 → 插入到当前行之前，下半区 → 之后
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const isTopHalf = event.clientY < rect.top + rect.height / 2
  insertIndex.value = isTopHalf ? index : index + 1
}

const handleProfileDrop = async (event: DragEvent) => {
  event.preventDefault()
  const from = dragIndex.value
  const ins = insertIndex.value
  dragIndex.value = null
  insertIndex.value = null
  if (from === null || ins === null) return
  if (ins === from || ins === from + 1) return
  // 先删后插：目标实际索引需要减去被移出的位置
  const to = ins > from ? ins - 1 : ins
  await configStore.reorderAiProfiles(from, to)
}

const handleProfileDragEnd = () => {
  dragIndex.value = null
  insertIndex.value = null
}

// Steam 版本：不提供任何 AI/API 配置入口，仅展示说明（__STEAM_BUILD__ 由 vite define 注入）
const isSteamBuild = __STEAM_BUILD__

// 非 Steam 版显示全部模板；Steam 版不展示配置 UI，此处仅用于非 Steam
// 模板数据来自 src/config/ai-templates.ts（单一数据源）
const templates = computed(() => AI_TEMPLATES)

const applyTemplate = (template: typeof templates.value[0]) => {
  formData.value.name = template.name
  formData.value.apiUrl = template.apiUrl
  formData.value.model = template.model
  formData.value.contextLength = template.contextLength
  formData.value.modelType = template.modelType || 'general'
  formData.value.visionProfileId = undefined
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
  <SettingsPage :title="t('settings.tabs.ai')">
    <template v-if="!isSteamBuild" #actions>
      <button class="btn btn-primary btn-sm" @click="openNewProfile">
        <Plus :size="14" />
        {{ t('aiSettings.addProfile') }}
      </button>
    </template>

    <!-- Steam 版：仅显示说明，不提供任何 AI/API 配置入口 -->
    <SettingsGroup v-if="isSteamBuild">
      <p class="steam-notice">{{ t('aiSettings.steamNoAiConfig') }}</p>
    </SettingsGroup>

    <!-- 非 Steam 版：完整 AI 模型配置 -->
    <template v-if="!isSteamBuild">
      <!-- 列表项自带边框与选中态，外面不再套卡片 -->
      <SettingsGroup
        variant="plain"
        :title="t('aiSettings.groupProfiles')"
        :desc="t('aiSettings.apiKeyNotRequired')"
      >
        <!-- 配置列表 -->
        <div class="profile-list">
          <div
            v-for="(profile, index) in profiles"
            :key="profile.id"
            class="profile-item"
            :class="{
              active: profile.id === activeProfileId,
              dragging: dragIndex === index,
              'insert-before': showInsertLine && insertIndex === index,
              'insert-after': showInsertLine && insertIndex === profiles.length && index === profiles.length - 1,
            }"
            draggable="true"
            @dragstart="handleProfileDragStart(index, $event)"
            @dragover="handleProfileDragOver(index, $event)"
            @drop="handleProfileDrop($event)"
            @dragend="handleProfileDragEnd"
          >
            <div class="drag-handle" :title="t('aiSettings.dragToReorder')">
              <GripVertical :size="14" />
            </div>
            <div class="profile-radio">
              <input
                type="radio"
                :id="profile.id"
                :checked="profile.id === activeProfileId"
                @change="setActive(profile.id)"
              />
            </div>
            <div class="profile-info" @click="setActive(profile.id)">
              <div class="profile-name">
                {{ profile.name }}
                <span v-if="profile.modelType === 'vision'" class="model-type-badge vision">
                  <Eye :size="10" />
                  {{ t('aiSettings.modelTypeVision') }}
                </span>
              </div>
              <div class="profile-detail">{{ profile.model }} · {{ profile.apiUrl }}</div>
            </div>
            <div class="profile-actions">
              <button class="btn-icon btn-sm" @click="openEditProfile(profile)" :title="t('aiSettings.editProfile')">
                <Pencil :size="14" />
              </button>
              <button class="btn-icon btn-sm" @click="openCopyProfile(profile)" :title="t('aiSettings.copyProfile')">
                <Copy :size="14" />
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
      </SettingsGroup>
    </template>

    <!-- 添加/编辑表单弹窗 -->
    <Teleport to="body">
      <Transition name="profile-modal">
        <div v-if="showForm" class="profile-modal-overlay settings-scope">
          <div class="profile-modal">
            <div class="form-header">
              <h4>{{ editingProfile ? t('aiSettings.editProfile') : (isCopyMode ? t('aiSettings.copyProfile') : t('aiSettings.addProfile')) }}</h4>
              <button class="btn-icon" @click="showForm = false" :title="t('common.close')">
                <X :size="16" />
              </button>
            </div>

            <!-- 快速模板 -->
            <div class="templates" v-if="!editingProfile && !isCopyMode">
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
                <div class="model-input-row">
                  <div class="model-combobox" @mouseleave="() => {}">
                    <input
                      v-model="formData.model"
                      type="text"
                      class="input"
                      :placeholder="t('aiSettings.modelPlaceholder')"
                      @focus="showModelDropdown = fetchedModels.length > 0"
                      @blur="hideModelDropdownDelayed"
                    />
                    <button
                      v-if="fetchedModels.length > 0"
                      class="model-dropdown-toggle"
                      @click="showModelDropdown = !showModelDropdown"
                      :title="t('aiSettings.toggleModelList')"
                    >
                      <ChevronDown :size="14" />
                    </button>
                    <div v-if="showModelDropdown && fetchedModels.length > 0" class="model-dropdown">
                      <div
                        v-for="m in fetchedModels"
                        :key="m.id"
                        class="model-dropdown-item"
                        :class="{ active: formData.model === m.id }"
                        @click="selectModel(m)"
                      >
                        <span class="model-id">{{ m.id }}</span>
                        <span v-if="m.supportsVision" class="model-vision-badge" :title="t('aiSettings.supportsVision')">
                          <Camera :size="11" />
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    class="btn-fetch-models"
                    :class="{ loading: isFetchingModels }"
                    :disabled="isFetchingModels || !formData.apiUrl"
                    @click="fetchModels"
                    :title="t('aiSettings.fetchModels')"
                  >
                    <RefreshCw :size="14" :class="{ spinning: isFetchingModels }" />
                  </button>
                </div>
                <span v-if="fetchModelsError" class="form-hint" style="color: var(--color-danger, #ef4444)">{{ fetchModelsError }}</span>
                <span v-else-if="fetchedModels.length > 0 && !showModelDropdown" class="form-hint">
                  {{ t('aiSettings.fetchedModelsCount', { count: fetchedModels.length }) }}
                </span>
              </div>
              <div class="form-row">
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.contextLength') }}（K）</label>
                  <input v-model.number="contextLengthInK" type="number" class="input" placeholder="128" min="1" max="2000" />
                  <span v-if="contextLengthTooSmall" class="form-hint context-too-small">
                    {{ t('aiSettings.contextLengthTooSmall') }}
                  </span>
                  <span v-else class="form-hint">DeepSeek/Qwen/Claude/Gemini(1000)、GPT-5.6(1050)</span>
                </div>
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.maxOutputTokens') }}（{{ t('aiSettings.maxOutputTokensHint') }}）</label>
                  <input v-model.number="formData.maxOutputTokens" type="number" class="input" placeholder="32768" min="1" max="1000000" />
                  <span class="form-hint">{{ t('aiSettings.maxOutputTokensTip') }}</span>
                </div>
                <div class="form-group flex-1">
                  <label class="form-label">Temperature（{{ t('aiSettings.temperatureHint') }}）</label>
                  <input v-model.number="formData.temperature" type="number" class="input" placeholder="0.7" min="0" max="2" step="0.1" />
                  <span class="form-hint">{{ t('aiSettings.temperatureTip') }}</span>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('aiSettings.proxy') }}</label>
                <input v-model="formData.proxy" type="text" class="input" :placeholder="t('aiSettings.proxyPlaceholder')" />
              </div>
              <div class="form-row">
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.modelType') }}</label>
                  <AppSelect
                    :model-value="formData.modelType || 'general'"
                    :options="modelTypeOptions"
                    size="field"
                    block
                    @update:model-value="formData.modelType = $event as AiModelType"
                  />
                  <span class="form-hint">{{ t('aiSettings.modelTypeHint') }}</span>
                </div>
                <div class="form-group flex-1" v-if="formData.modelType !== 'vision'">
                  <label class="form-label">{{ t('aiSettings.visionProfile') }}</label>
                  <AppSelect
                    :model-value="formData.visionProfileId || ''"
                    :options="visionSelectOptions"
                    size="field"
                    block
                    @update:model-value="formData.visionProfileId = $event || undefined"
                  />
                  <span class="form-hint">{{ t('aiSettings.visionProfileHint') }}</span>
                </div>
                <div class="form-group flex-1">
                  <label class="form-label">{{ t('aiSettings.apiFormat') }}</label>
                  <AppSelect
                    :model-value="formData.apiFormat || 'auto'"
                    :options="apiFormatOptions"
                    size="field"
                    block
                    @update:model-value="formData.apiFormat = $event as ApiFormat"
                  />
                  <span class="form-hint">{{ t('aiSettings.apiFormatHint') }}</span>
                </div>
              </div>
            </div>
            <div class="form-footer">
              <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
              <span v-if="testMessage" class="test-result" :class="testState">{{ testMessage }}</span>
              <div class="footer-right">
                <button
                  class="btn btn-test"
                  :class="{ testing: testState === 'testing', success: testState === 'success', error: testState === 'error' }"
                  :disabled="testState === 'testing' || !formData.apiUrl || !formData.model"
                  @click="testApiKey"
                >
                  <span v-if="testState === 'testing'">{{ t('aiSettings.testKeyTesting') }}</span>
                  <span v-else>{{ t('aiSettings.testKey') }}</span>
                </button>
                <button class="btn btn-primary" @click="saveProfile">{{ t('common.save') }}</button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 两个自动切换开关合成一组：各自独占一张卡片时，两条设置之间的空白
         比它们本身还宽，看不出是相关的一对 -->
    <SettingsGroup v-if="!isSteamBuild" :title="t('aiSettings.groupAuto')">
      <SettingRow
        clickable
        :label="t('aiSettings.autoVisionModel')"
        :desc="t('aiSettings.autoVisionModelDesc')"
      >
        <SettingToggle
          :model-value="configStore.autoVisionModel"
          @update:model-value="configStore.setAutoVisionModel($event)"
        />
      </SettingRow>

      <SettingRow
        clickable
        :label="t('aiSettings.autoFailoverModel')"
        :desc="t('aiSettings.autoFailoverModelDesc')"
      >
        <SettingToggle
          :model-value="configStore.autoFailoverModel"
          @update:model-value="configStore.setAutoFailoverModel($event)"
        />
      </SettingRow>
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.steam-notice {
  margin: 0;
  padding: var(--sp-4) 0;
  font-size: var(--fs-desc);
  line-height: 1.5;
  color: var(--text-secondary);
}

.profile-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 列表项直接铺在面板底上（不再套外层卡片），所以用卡片底色把自己抬起来——
   沿用面板同色只剩一圈细线，看不出是一张张可选的配置 */
.profile-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease, opacity 0.2s ease;
}

.profile-item:hover {
  border-color: var(--accent-primary);
}

.profile-item.active {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.1);
}

.profile-item.dragging {
  opacity: 0.1;
}

/* 落点指示线：3px 发光横线，跨过行间 gap */
.profile-item.insert-before::before,
.profile-item.insert-after::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  height: 3px;
  background: var(--accent-primary);
  border-radius: 2px;
  pointer-events: none;
  z-index: 2;
}

.profile-item.insert-before::before {
  top: -6px;
}

.profile-item.insert-after::after {
  bottom: -6px;
}

.drag-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  cursor: grab;
  opacity: 0.6;
  transition: opacity 0.2s ease;
  flex-shrink: 0;
}

.profile-item:hover .drag-handle {
  opacity: 1;
}

.profile-item.dragging .drag-handle {
  cursor: grabbing;
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
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.model-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 6px;
  font-size: 10px;
  font-weight: 500;
  border-radius: 8px;
}

.model-type-badge.vision {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.15);
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

/* 弹窗 */
.profile-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.profile-modal {
  width: 90%;
  max-width: 560px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.profile-modal .form-body {
  overflow-y: auto;
}

/* 弹窗动画 */
.profile-modal-enter-active,
.profile-modal-leave-active {
  transition: opacity 0.2s ease;
}

.profile-modal-enter-active .profile-modal,
.profile-modal-leave-active .profile-modal {
  transition: transform 0.2s ease;
}

.profile-modal-enter-from,
.profile-modal-leave-to {
  opacity: 0;
}

.profile-modal-enter-from .profile-modal {
  transform: scale(0.95) translateY(10px);
}

.profile-modal-leave-to .profile-modal {
  transform: scale(0.95) translateY(10px);
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
  font-size: 16px;
  font-weight: 600;
  margin: 0;
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
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.template-btn:hover {
  background: var(--bg-hover);
}

.form-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.input {
  padding: 8px 12px;
  font-size: 13px;
  background: var(--bg-secondary);
  border-radius: 6px;
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
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.get-key-btn:hover {
  background: var(--bg-hover);
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

.context-too-small {
  color: var(--color-warning);
  line-height: 1.5;
}

.form-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.form-footer .test-result {
  flex: 1;
  text-align: right;
}

.btn-test {
  white-space: nowrap;
  flex-shrink: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}

.btn-test:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.btn-test.testing {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-test.success {
  border-color: var(--color-success, #22c55e);
  color: var(--color-success, #22c55e);
}

.btn-test.error {
  border-color: var(--color-danger, #ef4444);
  color: var(--color-danger, #ef4444);
}

.test-result {
  font-size: 12px;
  line-height: 1.4;
  word-break: break-word;
}

.test-result.success {
  color: var(--color-success, #22c55e);
}

.test-result.error {
  color: var(--color-danger, #ef4444);
}

/* 模型输入行 */
.model-input-row {
  display: flex;
  gap: 6px;
  align-items: flex-start;
}

.model-combobox {
  position: relative;
  flex: 1;
}

.model-combobox .input {
  width: 100%;
  padding-right: 28px;
}

.model-dropdown-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 2px;
  display: flex;
  align-items: center;
}

.model-dropdown-toggle:hover {
  color: var(--text-primary);
}

.model-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  z-index: 100;
  max-height: 220px;
  overflow-y: auto;
}

.model-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 13px;
  gap: 6px;
}

.model-dropdown-item:hover,
.model-dropdown-item.active {
  background: var(--bg-secondary);
}

.model-id {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.model-vision-badge {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  color: var(--accent-primary, #4a9eff);
  opacity: 0.85;
}

.btn-fetch-models {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background 0.15s, color 0.15s;
}

.btn-fetch-models:hover:not(:disabled) {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.btn-fetch-models:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 0.8s linear infinite;
}

/* 开关走 main.css 的 .settings-scope 规范，本页不再重复定义 */
</style>
