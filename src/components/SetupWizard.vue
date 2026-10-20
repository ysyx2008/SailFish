<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ExternalLink, FolderInput, Database, Plug, Check, ChevronDown, ChevronUp,
  ArrowLeft, ArrowRight, MessageSquare, Zap, Server, BookOpen, Plus, Sparkles,
} from 'lucide-vue-next'
import sailfishLogo from 'virtual:oem-app-logo'
import { useConfigStore, type AiProfile } from '../stores/config'
import { oemResolved } from '@shared/oem-resolve'
import { AI_TEMPLATES, RECOMMENDED_MIN_CONTEXT, isProfileOfTemplate, type AiTemplate } from '../config/ai-templates'
import { v4 as uuidv4 } from 'uuid'
import { showAlert, showConfirm } from '../composables/useConfirm'

const { t } = useI18n()

const emit = defineEmits<{
  complete: []
}>()

const configStore = useConfigStore()

// Steam 版本：不提供 AI 配置，向导仅欢迎 + 完成两步（__STEAM_BUILD__ 由 vite define 注入）
const isSteamBuild = __STEAM_BUILD__

// 步骤管理（Steam 版 2 步，非 Steam 版 3 步）
const currentStep = ref(1)
const totalSteps = isSteamBuild ? 2 : 3

// 完成页的可选配置展开状态
const expandedSection = ref<'import' | 'knowledge' | 'mcp' | null>(null)

const toggleSection = (section: 'import' | 'knowledge' | 'mcp') => {
  expandedSection.value = expandedSection.value === section ? null : section
}

// 步骤1: 欢迎
// 无需数据

// 步骤2: 配置大模型
// 当前选中的模板索引（用于展开输入API Key）
const selectedTemplateIndex = ref<number | null>(null)
// 每个模板的API Key输入
const templateApiKeys = ref<Record<number, string>>({})

// 自定义模板（非预设，仅向导内使用；字段与 AiTemplate 对齐）
const CUSTOM_AI_TEMPLATE: AiTemplate = {
  name: 'Custom',
  apiUrl: '',
  model: '',
  descKey: 'aiSettings.templates.custom',
  keyUrl: '',
  contextLength: 128000,
  isLocal: false,
  needsApiKey: true,
}

// 所有可用的 AI 模板（预设来自 src/config/ai-templates.ts，尾部追加自定义项）
const allAiTemplates: readonly (AiTemplate & { isCustom: boolean })[] = [
  ...AI_TEMPLATES.map(tpl => ({ ...tpl, isCustom: false })),
  { ...CUSTOM_AI_TEMPLATE, isCustom: true },
]

// 自定义模板的表单数据
const customFormData = ref({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: ''
})

// 非 Steam 版显示全部模板；Steam 版不展示 AI 配置步骤，此处仅用于非 Steam
const aiTemplates = computed(() => {
  return allAiTemplates.map((tpl, index) => ({
    index,
    name: tpl.isCustom ? t('aiSettings.templates.customName') : tpl.name,
    apiUrl: tpl.apiUrl,
    model: tpl.model,
    desc: t(tpl.descKey),
    keyUrl: tpl.keyUrl,
    contextLength: tpl.contextLength,
    needsApiKey: tpl.needsApiKey,
    modelType: tpl.modelType,
    isCustom: tpl.isCustom
  }))
})

// 这个模板对应的服务是否已有配置（按服务地址判断；名字、模型都可能被用户或厂商改过）
const isTemplateConfigured = (template: { apiUrl: string }) => {
  return configStore.aiProfiles.some(p => isProfileOfTemplate(p, template))
}

const selectTemplate = (index: number) => {
  selectedTemplateIndex.value = selectedTemplateIndex.value === index ? null : index
}

const openKeyUrl = (url: string, event: Event) => {
  event.stopPropagation()
  window.open(url, '_blank')
}

const saveTemplateConfig = async (template: typeof aiTemplates.value[0]) => {
  // 窗口偏小的模型在这里确认一次，规则与 AI 设置页保持一致：
  // 首次配置的人最需要提前知道，跑一半才发现不好用代价最大
  if (template.contextLength && template.contextLength < RECOMMENDED_MIN_CONTEXT) {
    const confirmed = await showConfirm({
      type: 'warning',
      title: t('aiSettings.confirmSmallContextTitle'),
      message: t('aiSettings.confirmSmallContext', { size: Math.round(template.contextLength / 1000) }),
      detail: t('aiSettings.confirmSmallContextDetail'),
      confirmText: t('aiSettings.confirmSmallContextConfirm'),
      cancelText: t('aiSettings.confirmSmallContextCancel'),
    })
    if (!confirmed) return false
  }

  // 自定义模板使用自定义表单数据
  if (template.isCustom) {
    if (!customFormData.value.name || !customFormData.value.apiUrl || !customFormData.value.model) {
      await showAlert(t('common.warning'), t('setup.aiConfig.fillRequired'))
      return false
    }
    
    try {
      await configStore.addAiProfile({
        id: uuidv4(),
        name: customFormData.value.name,
        apiUrl: customFormData.value.apiUrl,
        apiKey: customFormData.value.apiKey,
        model: customFormData.value.model,
        contextLength: template.contextLength
      } as AiProfile)
      // 清空表单并收起
      customFormData.value = { name: '', apiUrl: '', apiKey: '', model: '' }
      selectedTemplateIndex.value = null
      return true
    } catch (error) {
      console.error('保存配置失败:', error)
      await showAlert(t('common.error'), t('setup.aiConfig.saveFailed'))
      return false
    }
  }
  
  // 预设模板
  const apiKey = templateApiKeys.value[template.index] || ''
  
  // 本地服务不需要API Key，云服务需要
  if (template.needsApiKey && !apiKey) {
    await showAlert(t('common.warning'), t('setup.aiConfig.apiKeyRequired'))
    return false
  }

  try {
    await configStore.addAiProfile({
      id: uuidv4(),
      name: template.name,
      apiUrl: template.apiUrl,
      apiKey: apiKey,
      model: template.model,
      contextLength: template.contextLength,
      modelType: template.modelType || 'general',
    } as AiProfile)
    // 清空输入并收起
    templateApiKeys.value[template.index] = ''
    selectedTemplateIndex.value = null
    return true
  } catch (error) {
    console.error('保存配置失败:', error)
      await showAlert(t('common.error'), t('setup.aiConfig.saveFailed'))
      return false
  }
}

// 步骤3: 导入主机
const scanning = ref(false)
const scanResult = ref<{ found: boolean; paths: string[]; sessionCount: number } | null>(null)
const importing = ref(false)
const importResult = ref<{ success: boolean; sessions: number; errors: string[] } | null>(null)

const scanXshell = async () => {
  scanning.value = true
  try {
    const result = await window.electronAPI.xshell.scanDefaultPaths()
    scanResult.value = result
  } catch (error) {
    console.error('扫描失败:', error)
    scanResult.value = { found: false, paths: [], sessionCount: 0 }
  } finally {
    scanning.value = false
  }
}

const importXshell = async () => {
  if (!scanResult.value || !scanResult.value.found || scanResult.value.paths.length === 0) {
    return
  }

  importing.value = true
  try {
    // 导入所有找到的路径
    const result = await window.electronAPI.xshell.importDirectories(scanResult.value.paths)
    
    console.log('[SetupWizard] Xshell导入结果:', result)
    
    if (result.success && result.sessions.length > 0) {
      // 转换为 SSH 会话并保存
      const sessions = result.sessions.map(session => ({
        id: uuidv4(),
        name: session.name,
        host: session.host,
        port: session.port,
        username: session.username,
        authType: (session.privateKeyPath ? 'privateKey' : 'password') as 'password' | 'privateKey',
        password: session.password,
        privateKeyPath: session.privateKeyPath,
        group: session.group
      }))

      for (const session of sessions) {
        await configStore.addSshSession(session)
      }

      importResult.value = {
        success: true,
        sessions: sessions.length,
        errors: result.errors || []
      }
    } else {
      // 提供更详细的错误信息
      const debugInfo = result.debug 
        ? `(扫描 ${result.debug.totalFiles} 个文件, 成功 ${result.debug.parsedFiles}, 失败 ${result.debug.failedFiles})`
        : ''
      const errorMessages = result.errors?.length > 0 
        ? result.errors.slice(0, 5) // 只显示前5个错误
        : [t('setup.import.importFailed')]
      
      importResult.value = {
        success: false,
        sessions: 0,
        errors: [...errorMessages, debugInfo].filter(Boolean)
      }
    }
  } catch (error) {
    console.error('导入失败:', error)
    importResult.value = {
      success: false,
      sessions: 0,
      errors: [String(error)]
    }
  } finally {
    importing.value = false
  }
}

const manualImport = async () => {
  try {
    // 选择目录
    const result = await window.electronAPI.xshell.selectDirectory()
    if (result.canceled) return

    importing.value = true
    const importResponse = await window.electronAPI.xshell.importDirectory(result.dirPath)
    
    if (importResponse.success && importResponse.sessions.length > 0) {
      const sessions = importResponse.sessions.map(session => ({
        id: uuidv4(),
        name: session.name,
        host: session.host,
        port: session.port,
        username: session.username,
        authType: (session.privateKeyPath ? 'privateKey' : 'password') as 'password' | 'privateKey',
        password: session.password,
        privateKeyPath: session.privateKeyPath,
        group: session.group
      }))

      for (const session of sessions) {
        await configStore.addSshSession(session)
      }

      importResult.value = {
        success: true,
        sessions: sessions.length,
        errors: importResponse.errors || []
      }
    } else {
      importResult.value = {
        success: false,
        sessions: 0,
        errors: importResponse.errors || [t('setup.import.importFailed')]
      }
    }
  } catch (error) {
    console.error('手动导入失败:', error)
    importResult.value = {
      success: false,
      sessions: 0,
      errors: [String(error)]
    }
  } finally {
    importing.value = false
  }
}

// 步骤4: 知识库
const knowledgeEnabled = ref(true)
const savingKnowledge = ref(false)

const saveKnowledgeSettings = async () => {
  if (knowledgeEnabled.value) {
    try {
      savingKnowledge.value = true
      await window.electronAPI.knowledge.updateSettings({
        enabled: true
      })
      return true
    } catch (error) {
      console.error('保存知识库设置失败:', error)
      return false
    } finally {
      savingKnowledge.value = false
    }
  }
  
  return true
}

// 步骤5: MCP 服务
const mcpServers = ref<any[]>([])
const loadingMcp = ref(false)

const loadMcpServers = async () => {
  try {
    loadingMcp.value = true
    mcpServers.value = await window.electronAPI.mcp.getServers()
  } catch (error) {
    console.error('加载 MCP 服务器失败:', error)
  } finally {
    loadingMcp.value = false
  }
}

// 导航
const canGoPrev = computed(() => {
  return currentStep.value > 1
})

// 步骤条上每一步的名字（Steam 版没有「连接模型」这一步）
const stepLabels = computed(() => isSteamBuild
  ? [t('setup.steps.welcome'), t('setup.steps.ready')]
  : [t('setup.steps.welcome'), t('setup.steps.model'), t('setup.steps.ready')])

// 欢迎页的四个卖点：图标 + 一句话 + 色相（纯装饰）
const welcomeFeatures = computed(() => [
  { key: 'aiChat', icon: MessageSquare, hue: 212, title: t('setup.welcome.features.aiChat.title'), short: t('setup.welcome.features.aiChat.short') },
  { key: 'agent', icon: Zap, hue: 38, title: t('setup.welcome.features.agent.title'), short: t('setup.welcome.features.agent.short') },
  { key: 'ssh', icon: Server, hue: 160, title: t('setup.welcome.features.ssh.title'), short: t('setup.welcome.features.ssh.short') },
  { key: 'knowledge', icon: BookOpen, hue: 276, title: t('setup.welcome.features.knowledge.title'), short: t('setup.welcome.features.knowledge.short') },
])

// 服务头像的底色：按顺序错开色相，纯装饰
const providerHue = (index: number) => (index * 47 + 200) % 360

const skipWizard = async () => {
  // 直接完成向导
  await configStore.setSetupCompleted(true)
  emit('complete')
}

const nextStep = async () => {
  // 非 Steam 版第 2 步：必须至少配置一个 AI 模型才能继续。
  // 公司清单还没取到时不拦在手填这一步，登录或下次打开会再取。
  const oemCatalogPending = Boolean(oemResolved.models.catalogUrl) && configStore.aiProfiles.length === 0
  if (!isSteamBuild && currentStep.value === 2 && configStore.aiProfiles.length === 0 && !oemCatalogPending) {
    await showAlert(t('common.warning'), t('setup.aiConfig.required'))
    return
  }

  if (currentStep.value < totalSteps) {
    currentStep.value++
  } else {
    // 保存知识库设置（如果启用了的话）
    if (knowledgeEnabled.value) {
      await saveKnowledgeSettings()
    }
    // 完成向导
    await configStore.setSetupCompleted(true)
    emit('complete')
  }
}

const prevStep = () => {
  if (currentStep.value > 1) {
    currentStep.value--
  }
}

// 初始化
onMounted(async () => {
  // 不再自动扫描，用户展开导入区域时再扫描
})
</script>

<template>
  <div class="setup-wizard">
    <div class="wizard-container">
      <div class="wizard-main">
        <!-- 步骤条 -->
        <div class="steps-progress" role="list">
          <template v-for="(label, i) in stepLabels" :key="i">
            <div
              class="step-indicator"
              role="listitem"
              :class="{ active: i + 1 === currentStep, completed: i + 1 < currentStep }"
              :aria-current="i + 1 === currentStep ? 'step' : undefined"
            >
              <div class="step-number">
                <Check v-if="i + 1 < currentStep" :size="14" :stroke-width="3" />
                <span v-else>{{ i + 1 }}</span>
              </div>
              <span class="step-label">{{ label }}</span>
            </div>
            <div v-if="i < stepLabels.length - 1" class="step-line" aria-hidden="true" :class="{ filled: i + 1 < currentStep }">
              <span></span>
            </div>
          </template>
        </div>

        <!-- 步骤内容 -->
        <div class="step-content">
          <!-- 步骤1: 欢迎 -->
          <div v-if="currentStep === 1" :key="'welcome'" class="step-panel">
            <div class="hero">
              <div class="hero-logo">
                <img :src="sailfishLogo" alt="" draggable="false" />
              </div>
              <h2 class="hero-title">{{ t('setup.welcome.title') }}</h2>
              <p class="hero-subtitle">{{ t('setup.welcome.subtitle') }}</p>
            </div>
            <p class="intro-text">{{ t('setup.welcome.intro') }}</p>
            <div class="feature-grid">
              <div
                v-for="feature in welcomeFeatures"
                :key="feature.key"
                class="feature-card"
                :style="{ '--hue': feature.hue }"
              >
                <div class="feature-icon">
                  <component :is="feature.icon" :size="20" />
                </div>
                <div class="feature-text">
                  <h3>{{ feature.title }}</h3>
                  <p>{{ feature.short }}</p>
                </div>
              </div>
            </div>
          </div>

          <!-- 步骤2: 配置大模型（仅非 Steam 版） -->
          <div v-if="currentStep === 2 && !isSteamBuild" :key="'model'" class="step-panel">
            <div class="step-header">
              <h2>{{ t('setup.aiConfig.title') }}</h2>
              <p v-if="oemResolved.models.catalogUrl && configStore.aiProfiles.length === 0" class="step-intro">
                {{ configStore.oemModelNotice === 'need-login' ? t('setup.aiConfig.oemNeedLogin') : t('setup.aiConfig.oemUnavailable') }}
              </p>
              <p v-else class="step-intro">{{ t('setup.aiConfig.subtitleSimple') }}</p>
            </div>
            <div class="config-content">
              <!-- 已配置提示 -->
              <div v-if="configStore.aiProfiles.length > 0" class="configured-hint">
                <Check :size="16" :stroke-width="3" class="configured-icon" />
                <span>{{ t('setup.aiConfig.alreadyConfigured', { count: configStore.aiProfiles.length }) }}</span>
              </div>

              <!-- 模板卡片列表 -->
              <div class="ai-template-list">
                <div
                  v-for="template in aiTemplates"
                  :key="template.name"
                  class="ai-template-card"
                  :class="{
                    selected: selectedTemplateIndex === template.index,
                    configured: isTemplateConfigured(template)
                  }"
                >
                  <div class="ai-template-header" @click="selectTemplate(template.index)">
                    <div class="provider-avatar" :style="{ '--hue': providerHue(template.index) }">
                      <Plus v-if="template.isCustom" :size="18" />
                      <span v-else>{{ template.name.charAt(0).toUpperCase() }}</span>
                    </div>
                    <div class="ai-template-info">
                      <div class="ai-template-name">
                        {{ template.name }}
                        <span v-if="isTemplateConfigured(template)" class="configured-tag">
                          {{ t('setup.aiConfig.configured') }}
                        </span>
                      </div>
                      <div class="ai-template-desc">{{ template.desc }}</div>
                    </div>
                    <span v-if="isTemplateConfigured(template)" class="configured-check">
                      <Check :size="13" :stroke-width="3" />
                    </span>
                    <ChevronDown
                      v-else
                      :size="18"
                      class="expand-arrow"
                      :class="{ rotated: selectedTemplateIndex === template.index }"
                    />
                  </div>

                  <!-- 展开区域：API Key 输入 / 自定义表单 -->
                  <div v-if="selectedTemplateIndex === template.index && !isTemplateConfigured(template)" class="ai-template-body">
                    <div v-if="template.contextLength && template.contextLength < RECOMMENDED_MIN_CONTEXT" class="context-small-note">
                      {{ t('aiSettings.contextLengthTooSmall') }}
                    </div>
                    <!-- 自定义模板：完整表单 -->
                    <template v-if="template.isCustom">
                      <div class="custom-form">
                        <div class="form-group">
                          <label class="form-label">{{ t('aiSettings.profileName') }} *</label>
                          <input v-model="customFormData.name" type="text" class="input" :placeholder="t('setup.aiConfig.customNamePlaceholder')" />
                        </div>
                        <div class="form-group">
                          <label class="form-label">{{ t('aiSettings.apiUrl') }} *</label>
                          <input v-model="customFormData.apiUrl" type="text" class="input" :placeholder="t('setup.aiConfig.customUrlPlaceholder')" />
                        </div>
                        <div class="form-group">
                          <label class="form-label">{{ t('aiSettings.apiKey') }}</label>
                          <input v-model="customFormData.apiKey" type="password" class="input" :placeholder="t('setup.aiConfig.customKeyPlaceholder')" />
                        </div>
                        <div class="form-group">
                          <label class="form-label">{{ t('aiSettings.model') }} *</label>
                          <input v-model="customFormData.model" type="text" class="input" :placeholder="t('setup.aiConfig.customModelPlaceholder')" />
                        </div>
                      </div>
                    </template>
                    <!-- 预设模板：只需 API Key -->
                    <template v-else>
                      <div v-if="template.needsApiKey" class="api-key-input-row">
                        <input
                          type="password"
                          v-model="templateApiKeys[template.index]"
                          class="input"
                          :placeholder="t('setup.aiConfig.enterApiKey')"
                        />
                        <button
                          class="get-key-link"
                          @click="openKeyUrl(template.keyUrl, $event)"
                        >
                          <ExternalLink :size="14" />
                          {{ t('aiSettings.getApiKey') }}
                        </button>
                      </div>
                      <div v-else class="local-hint">
                        <span>{{ t('setup.aiConfig.localNoKey') }}</span>
                      </div>
                    </template>
                    <button
                      class="btn btn-primary btn-save"
                      @click="saveTemplateConfig(template)"
                    >
                      {{ t('setup.aiConfig.useThis') }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 底部提示 -->
              <p class="ai-config-hint">{{ t('setup.aiConfig.canChangeLater') }}</p>
            </div>
          </div>

          <!-- 步骤3（非 Steam）/ 步骤2（Steam）: 完成 + 可选配置 -->
          <div v-if="currentStep === (isSteamBuild ? 2 : 3)" :key="'ready'" class="step-panel">
            <div class="step-header">
              <div class="success-mark">
                <Check :size="30" :stroke-width="3" />
              </div>
              <h2>{{ t('setup.complete.title') }}</h2>
              <p class="step-intro">{{ t('setup.complete.readyToUse') }}</p>
            </div>
            <div class="complete-content">
              <!-- 配置完成提示（Steam 版用精简文案） -->
              <div class="ready-banner">
                <div class="ready-icon">
                  <Sparkles :size="20" />
                </div>
                <div class="ready-text">
                  <h3>{{ isSteamBuild ? t('setup.complete.steamReady') : t('setup.complete.aiReady') }}</h3>
                  <p>{{ isSteamBuild ? t('setup.complete.steamReadyDesc') : t('setup.complete.aiReadyDesc') }}</p>
                </div>
              </div>

              <!-- 可选配置卡片 -->
              <div class="optional-section">
                <h3 class="optional-title">{{ t('setup.complete.optionalConfig') }}</h3>
                <p class="optional-hint">{{ t('setup.complete.optionalHint') }}</p>

                <!-- 导入 SSH 主机 -->
                <div class="config-card" :class="{ expanded: expandedSection === 'import' }" :style="{ '--hue': 212 }">
                  <div class="config-card-header" @click="toggleSection('import')">
                    <span class="card-icon"><FolderInput :size="18" /></span>
                    <div class="card-info">
                      <span class="card-title">{{ t('setup.import.title') }}</span>
                      <span class="card-desc">{{ t('setup.import.shortDesc') }}</span>
                    </div>
                    <div class="card-status" v-if="importResult?.success">
                      <Check :size="14" :stroke-width="3" class="status-icon success" />
                      <span>{{ t('setup.import.importSuccess', { count: importResult.sessions }) }}</span>
                    </div>
                    <component :is="expandedSection === 'import' ? ChevronUp : ChevronDown" :size="18" class="expand-icon" />
                  </div>
                  <div v-if="expandedSection === 'import'" class="config-card-body">
                    <div v-if="scanning" class="scanning">
                      <div class="spinner"></div>
                      <span>{{ t('setup.import.scanning') }}</span>
                    </div>
                    <div v-else-if="!scanResult" class="scan-prompt">
                      <button class="btn btn-outline" @click="scanXshell">{{ t('setup.import.scanNow') }}</button>
                    </div>
                    <div v-else-if="scanResult.found" class="scan-result-compact">
                      <p class="result-text">{{ t('setup.import.found', { count: scanResult.sessionCount }) }}</p>
                      <div class="import-actions">
                        <button
                          class="btn btn-primary btn-sm"
                          @click="importXshell"
                          :disabled="importing || importResult?.success"
                        >
                          {{ importing ? t('setup.import.importing') : importResult?.success ? t('setup.import.imported') : t('setup.import.import') }}
                        </button>
                        <button class="btn btn-outline btn-sm" @click="manualImport" :disabled="importing">
                          {{ t('setup.import.manualSelect') }}
                        </button>
                      </div>
                    </div>
                    <div v-else class="no-result">
                      <p>{{ t('setup.import.notFound') }}</p>
                      <button class="btn btn-outline btn-sm" @click="manualImport" :disabled="importing">
                        {{ t('setup.import.manualSelect') }}
                      </button>
                    </div>
                  </div>
                </div>

                <!-- 知识库（Steam 版隐藏） -->
                <div v-if="!isSteamBuild" class="config-card" :class="{ expanded: expandedSection === 'knowledge' }" :style="{ '--hue': 160 }">
                  <div class="config-card-header" @click="toggleSection('knowledge')">
                    <span class="card-icon"><Database :size="18" /></span>
                    <div class="card-info">
                      <span class="card-title">{{ t('setup.knowledge.title') }}</span>
                      <span class="card-desc">{{ t('setup.knowledge.shortDesc') }}</span>
                    </div>
                    <div class="card-status" v-if="knowledgeEnabled">
                      <Check :size="14" :stroke-width="3" class="status-icon success" />
                      <span>{{ t('common.enabled') }}</span>
                    </div>
                    <component :is="expandedSection === 'knowledge' ? ChevronUp : ChevronDown" :size="18" class="expand-icon" />
                  </div>
                  <div v-if="expandedSection === 'knowledge'" class="config-card-body">
                    <div class="knowledge-toggle">
                      <label class="switch-label">
                        <span>{{ t('setup.knowledge.enableSwitch') }}</span>
                        <label class="switch">
                          <input type="checkbox" v-model="knowledgeEnabled" />
                          <span class="slider"></span>
                        </label>
                      </label>
                    </div>
                  </div>
                </div>

                <!-- MCP 服务（Steam 版隐藏） -->
                <div v-if="!isSteamBuild" class="config-card" :class="{ expanded: expandedSection === 'mcp' }" :style="{ '--hue': 276 }">
                  <div class="config-card-header" @click="toggleSection('mcp'); loadMcpServers()">
                    <span class="card-icon"><Plug :size="18" /></span>
                    <div class="card-info">
                      <span class="card-title">{{ t('setup.mcp.title') }}</span>
                      <span class="card-desc">{{ t('setup.mcp.shortDesc') }}</span>
                    </div>
                    <div class="card-status" v-if="mcpServers.length > 0">
                      <Check :size="14" :stroke-width="3" class="status-icon success" />
                      <span>{{ mcpServers.length }} {{ t('setup.mcp.servers') }}</span>
                    </div>
                    <component :is="expandedSection === 'mcp' ? ChevronUp : ChevronDown" :size="18" class="expand-icon" />
                  </div>
                  <div v-if="expandedSection === 'mcp'" class="config-card-body">
                    <div v-if="loadingMcp" class="loading-compact">
                      <div class="spinner"></div>
                    </div>
                    <div v-else-if="mcpServers.length > 0" class="mcp-list">
                      <div v-for="server in mcpServers" :key="server.id" class="mcp-item">
                        <span class="mcp-name">{{ server.name }}</span>
                        <span class="mcp-status" :class="{ enabled: server.enabled }">
                          {{ server.enabled ? t('common.enabled') : t('common.disabled') }}
                        </span>
                      </div>
                    </div>
                    <div v-else class="no-mcp-compact">
                      <p>{{ t('setup.mcp.noServersHint') }}</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 导航按钮 -->
        <div class="wizard-footer">
          <button
            class="btn btn-ghost"
            :class="{ hidden: !canGoPrev }"
            @click="prevStep"
            :disabled="!canGoPrev"
          >
            <ArrowLeft :size="16" />
            {{ t('common.prev') }}
          </button>
          <div class="footer-center" v-if="currentStep === 1">
            <button class="btn-link" @click="skipWizard">
              {{ t('setup.welcome.skipWizard') }}
            </button>
          </div>
          <div class="footer-right">
            <button
              class="btn btn-primary"
              @click="nextStep"
            >
              {{ currentStep === totalSteps ? t('common.finish') : t('common.next') }}
              <Check v-if="currentStep === totalSteps" :size="16" :stroke-width="3" />
              <ArrowRight v-else :size="16" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 首次引导。颜色全部取主题变量（强调色、背景、边框），换主题自动跟着变；
 * 带「--hue」的元素只是装饰用的点缀色，不承载含义。
 */
.setup-wizard {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    radial-gradient(60% 50% at 50% 0%, color-mix(in srgb, var(--accent-primary) 24%, transparent), transparent 70%),
    radial-gradient(45% 40% at 92% 100%, color-mix(in srgb, var(--accent-primary) 12%, transparent), transparent 70%),
    rgba(0, 0, 0, 0.74);
  backdrop-filter: blur(14px);
  animation: backdropIn 0.35s ease both;
}

.wizard-container {
  position: relative;
  display: flex;
  width: min(720px, 92vw);
  height: min(92vh, 680px);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  animation: containerIn 0.4s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* 顶部一团柔光，给整张卡一点层次 */
.wizard-container::before {
  content: '';
  position: absolute;
  inset: 0 0 auto 0;
  height: 240px;
  pointer-events: none;
  background: radial-gradient(70% 100% at 50% 0%, color-mix(in srgb, var(--accent-primary) 15%, transparent), transparent 75%);
}

.wizard-main {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* ───────── 步骤条 ───────── */
.steps-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 22px 24px 14px;
}

.step-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  transition: color 0.3s ease;
}

.step-number {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  transition: all 0.3s ease;
}

.step-label {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.step-indicator.active {
  color: var(--text-primary);
}

.step-indicator.active .step-number {
  background: var(--accent-primary);
  border-color: transparent;
  color: var(--accent-contrast, #fff);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-primary) 22%, transparent);
}

.step-indicator.completed {
  color: var(--text-secondary);
}

.step-indicator.completed .step-number {
  background: var(--color-success);
  border-color: transparent;
  color: var(--bg-primary);
}

.step-line {
  width: 56px;
  height: 2px;
  border-radius: 2px;
  background: var(--border-color);
  overflow: hidden;
}

.step-line > span {
  display: block;
  width: 0;
  height: 100%;
  background: var(--color-success);
  transition: width 0.4s ease;
}

.step-line.filled > span {
  width: 100%;
}

/* ───────── 内容区 ───────── */
.step-content {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 10px 40px 28px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
}

/* 内容少时垂直居中，多了就从顶上开始滚动 */
.step-panel {
  width: 100%;
  margin: auto 0;
  animation: panelIn 0.35s ease both;
}

.step-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin-bottom: 22px;
}

.step-header h2 {
  margin: 0 0 6px;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: var(--text-primary);
}

.step-intro {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

/* ───────── 欢迎页 ───────── */
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin-bottom: 18px;
}

.hero-logo {
  width: 68px;
  height: 68px;
  display: grid;
  place-items: center;
  margin-bottom: 14px;
  border-radius: 20px;
  background: linear-gradient(150deg, color-mix(in srgb, var(--accent-primary) 26%, var(--bg-surface)), var(--bg-surface));
  border: 1px solid color-mix(in srgb, var(--accent-primary) 35%, var(--border-color));
  box-shadow: 0 12px 32px color-mix(in srgb, var(--accent-primary) 28%, transparent);
  animation: float 5s ease-in-out infinite;
}

.hero-logo img {
  width: 42px;
  height: 42px;
  object-fit: contain;
}

.hero-title {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-primary);
  background: linear-gradient(135deg, var(--text-primary) 35%, var(--accent-primary));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}

.hero-subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.intro-text {
  max-width: 520px;
  margin: 0 auto 22px;
  text-align: center;
  font-size: 13px;
  line-height: 1.8;
  color: var(--text-secondary);
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.feature-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 14px;
}

.feature-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  color: color-mix(in srgb, hsl(var(--hue) 80% 55%) 72%, var(--text-primary));
  background: hsl(var(--hue) 75% 58% / 0.14);
}

.feature-text {
  min-width: 0;
}

.feature-text h3 {
  margin: 0 0 2px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.feature-text p {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--text-muted);
}

/* ───────── 配置大模型 ───────── */
.configured-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  margin: 0 auto 18px;
  padding: 7px 14px;
  font-size: 13px;
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 11%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
  border-radius: 999px;
}

.configured-icon {
  flex-shrink: 0;
}

.ai-template-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-template-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  overflow: hidden;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
}

.ai-template-card:not(.configured):hover {
  border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-color));
}

.ai-template-card.selected {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 16%, transparent);
}

.ai-template-card.configured {
  background: color-mix(in srgb, var(--color-success) 6%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--color-success) 38%, var(--border-color));
}

.ai-template-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  cursor: pointer;
}

.ai-template-card.configured .ai-template-header {
  cursor: default;
}

.provider-avatar {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  font-size: 16px;
  font-weight: 700;
  border-radius: 12px;
  color: color-mix(in srgb, hsl(var(--hue) 80% 55%) 72%, var(--text-primary));
  background: hsl(var(--hue) 75% 58% / 0.14);
  border: 1px solid hsl(var(--hue) 75% 58% / 0.22);
}

.ai-template-info {
  flex: 1;
  min-width: 0;
}

.ai-template-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.configured-tag {
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 14%, transparent);
  border-radius: 999px;
}

.ai-template-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.configured-check {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  color: var(--bg-primary);
  background: var(--color-success);
  border-radius: 50%;
}

.expand-arrow {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s ease;
}

.expand-arrow.rotated {
  transform: rotate(180deg);
}

.ai-template-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px 16px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-color);
  animation: bodyIn 0.22s ease both;
}

.api-key-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.api-key-input-row .input {
  flex: 1;
  min-width: 0;
}

.get-key-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 9px 14px;
  font-size: 12px;
  white-space: nowrap;
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid color-mix(in srgb, var(--accent-primary) 50%, transparent);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.get-key-link:hover {
  color: var(--accent-contrast, #fff);
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.local-hint {
  padding: 9px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: 10px;
}

.context-small-note {
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-warning);
  background: color-mix(in srgb, var(--color-warning) 8%, transparent);
  border-left: 3px solid color-mix(in srgb, var(--color-warning) 45%, transparent);
  border-radius: 6px;
}

.btn-save {
  align-self: flex-start;
}

.custom-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.form-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.input {
  padding: 10px 14px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.input:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 16%, transparent);
}

.ai-config-hint {
  margin: 18px 0 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

/* ───────── 完成页 ───────── */
.success-mark {
  position: relative;
  width: 64px;
  height: 64px;
  display: grid;
  place-items: center;
  margin: 16px 0;
  color: var(--bg-primary);
  background: linear-gradient(150deg, color-mix(in srgb, var(--color-success) 80%, #fff), var(--color-success));
  border-radius: 50%;
  box-shadow: 0 12px 32px color-mix(in srgb, var(--color-success) 35%, transparent);
}

.success-mark::after {
  content: '';
  position: absolute;
  inset: -8px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--color-success) 40%, transparent);
  animation: ring 2.4s ease-out infinite;
}

.ready-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 26px;
  padding: 16px 18px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--color-success) 12%, transparent), color-mix(in srgb, var(--color-success) 4%, transparent));
  border: 1px solid color-mix(in srgb, var(--color-success) 30%, transparent);
  border-radius: 14px;
}

.ready-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 16%, transparent);
  border-radius: 12px;
}

.ready-text h3 {
  margin: 0 0 3px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-success);
}

.ready-text p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.optional-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.optional-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--text-muted);
}

.config-card {
  margin-bottom: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  overflow: hidden;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.config-card:hover {
  border-color: color-mix(in srgb, var(--accent-primary) 40%, var(--border-color));
}

.config-card.expanded {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-primary) 14%, transparent);
}

.config-card-header {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 16px;
  cursor: pointer;
}

.config-card-header .card-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  color: color-mix(in srgb, hsl(var(--hue) 80% 55%) 72%, var(--text-primary));
  background: hsl(var(--hue) 75% 58% / 0.14);
  border-radius: 11px;
}

.config-card-header .card-info {
  flex: 1;
  min-width: 0;
}

.config-card-header .card-title {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.config-card-header .card-desc {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-muted);
}

.config-card-header .card-status {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  font-size: 12px;
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
  border-radius: 999px;
}

.config-card-header .expand-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.config-card-body {
  padding: 14px 16px 16px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-color);
  animation: bodyIn 0.22s ease both;
}

.scan-prompt {
  text-align: center;
  padding: 4px 0;
}

.scanning {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.scan-result-compact {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.scan-result-compact .result-text {
  margin: 0;
  font-size: 13px;
  color: var(--color-success);
}

.import-actions {
  display: flex;
  gap: 8px;
}

.no-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.no-result p {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.knowledge-toggle {
  margin: 2px 0;
}

.switch-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.switch {
  position: relative;
  display: inline-block;
  flex-shrink: 0;
  width: 44px;
  height: 24px;
}

.switch input {
  width: 0;
  height: 0;
  opacity: 0;
}

.slider {
  position: absolute;
  inset: 0;
  cursor: pointer;
  background-color: var(--bg-hover);
  border-radius: 24px;
  transition: background-color 0.25s ease;
}

.slider::before {
  content: '';
  position: absolute;
  left: 3px;
  bottom: 3px;
  width: 18px;
  height: 18px;
  background-color: #fff;
  border-radius: 50%;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transition: transform 0.25s ease;
}

.switch input:checked + .slider {
  background-color: var(--accent-primary);
}

.switch input:checked + .slider::before {
  transform: translateX(20px);
}

.loading-compact {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mcp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  background: var(--bg-secondary);
  border-radius: 10px;
}

.mcp-name {
  font-size: 13px;
  color: var(--text-primary);
}

.mcp-status {
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-radius: 999px;
}

.mcp-status.enabled {
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 14%, transparent);
}

.no-mcp-compact p {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
}

/* ───────── 底部导航 ───────── */
.wizard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 28px;
  background: color-mix(in srgb, var(--bg-secondary) 75%, transparent);
  border-top: 1px solid var(--border-color);
}

.footer-center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.footer-right {
  display: flex;
  gap: 12px;
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  color: var(--accent-contrast, #fff);
  background: linear-gradient(135deg, var(--accent-primary), color-mix(in srgb, var(--accent-primary) 70%, var(--accent-secondary)));
  border-color: transparent;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent-primary) 30%, transparent);
}

.btn-primary:hover:not(:disabled) {
  background: linear-gradient(135deg, var(--accent-primary), color-mix(in srgb, var(--accent-primary) 70%, var(--accent-secondary)));
  filter: brightness(1.08);
  transform: translateY(-1px);
}

.btn-outline {
  background: transparent;
}

.btn-ghost {
  color: var(--text-secondary);
  background: transparent;
  border-color: transparent;
}

/* 全局按钮自带一道斜向扫光，静止时在透明按钮上会露出一条淡淡的亮带 */
.btn-ghost::before,
.btn-outline::before {
  content: none;
}

.btn.hidden {
  visibility: hidden;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

.btn-link {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-muted);
  background: none;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.2s ease, background 0.2s ease;
}

.btn-link:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

/* ───────── 动画 ───────── */
@keyframes backdropIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes containerIn {
  from { opacity: 0; transform: translateY(14px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes panelIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes bodyIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}

@keyframes ring {
  0% { opacity: 0.9; transform: scale(0.9); }
  100% { opacity: 0; transform: scale(1.35); }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (forced-colors: active) {
  .hero-title {
    background: none;
    -webkit-text-fill-color: currentColor;
  }
}

@media (prefers-reduced-motion: reduce) {
  .setup-wizard,
  .wizard-container,
  .step-panel,
  .ai-template-body,
  .config-card-body,
  .hero-logo,
  .success-mark::after {
    animation: none;
  }
}

/* 窗口窄了：欢迎页卖点改单列，步骤条收紧 */
@media (max-width: 560px) {
  .step-content { padding: 8px 20px 20px; }
  .feature-grid { grid-template-columns: 1fr; }
  .step-line { width: 28px; }
  .wizard-footer { padding: 14px 20px; }
}
</style>
