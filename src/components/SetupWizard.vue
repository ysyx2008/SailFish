<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, FolderInput, Database, Plug, Check, ChevronDown, ChevronUp } from 'lucide-vue-next'
import { useConfigStore, type AiProfile } from '../stores/config'
import { v4 as uuidv4 } from 'uuid'

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

// 所有可用的 AI 模板
const allAiTemplates = [
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    descKey: 'aiSettings.templates.deepseek',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Qwen',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    descKey: 'aiSettings.templates.qwen',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Doubao',
    apiUrl: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    model: 'doubao-1.5-pro-32k',
    descKey: 'aiSettings.templates.doubao',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    contextLength: 32000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Zhipu',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-plus',
    descKey: 'aiSettings.templates.zhipu',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Kimi',
    apiUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-auto',
    descKey: 'aiSettings.templates.kimi',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    descKey: 'aiSettings.templates.openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Claude',
    apiUrl: 'https://api.anthropic.com/v1/chat/completions',
    model: 'claude-sonnet-4-6',
    descKey: 'aiSettings.templates.claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    contextLength: 200000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Gemini',
    apiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.0-flash',
    descKey: 'aiSettings.templates.gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    contextLength: 1000000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Grok',
    apiUrl: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-3-fast',
    descKey: 'aiSettings.templates.grok',
    keyUrl: 'https://console.x.ai/team/default/api-keys',
    contextLength: 131072,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Mistral',
    apiUrl: 'https://api.mistral.ai/v1/chat/completions',
    model: 'mistral-large-latest',
    descKey: 'aiSettings.templates.mistral',
    keyUrl: 'https://console.mistral.ai/api-keys',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: false
  },
  {
    name: 'Ollama',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'qwen2.5:7b',
    descKey: 'aiSettings.templates.ollama',
    keyUrl: 'https://ollama.com/',
    contextLength: 32000,
    isLocal: true,
    needsApiKey: false,
    isCustom: false
  },
  {
    name: 'Custom',
    apiUrl: '',
    model: '',
    descKey: 'aiSettings.templates.custom',
    keyUrl: '',
    contextLength: 128000,
    isLocal: false,
    needsApiKey: true,
    isCustom: true
  }
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
  const templates = allAiTemplates
  
  return templates.map((tpl, index) => ({
    index,
    name: tpl.isCustom ? t('aiSettings.templates.customName') : tpl.name,
    apiUrl: tpl.apiUrl,
    model: tpl.model,
    desc: t(tpl.descKey),
    keyUrl: tpl.keyUrl,
    contextLength: tpl.contextLength,
    needsApiKey: tpl.needsApiKey,
    isCustom: tpl.isCustom
  }))
})

// 检查模板是否已配置
const isTemplateConfigured = (templateName: string) => {
  return configStore.aiProfiles.some(p => p.name === templateName)
}

const selectTemplate = (index: number) => {
  selectedTemplateIndex.value = selectedTemplateIndex.value === index ? null : index
}

const openKeyUrl = (url: string, event: Event) => {
  event.stopPropagation()
  window.open(url, '_blank')
}

const saveTemplateConfig = async (template: typeof aiTemplates.value[0]) => {
  // 自定义模板使用自定义表单数据
  if (template.isCustom) {
    if (!customFormData.value.name || !customFormData.value.apiUrl || !customFormData.value.model) {
      alert(t('setup.aiConfig.fillRequired'))
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
      alert(t('setup.aiConfig.saveFailed'))
      return false
    }
  }
  
  // 预设模板
  const apiKey = templateApiKeys.value[template.index] || ''
  
  // 本地服务不需要API Key，云服务需要
  if (template.needsApiKey && !apiKey) {
    alert(t('setup.aiConfig.apiKeyRequired'))
    return false
  }

  try {
    await configStore.addAiProfile({
      id: uuidv4(),
      name: template.name,
      apiUrl: template.apiUrl,
      apiKey: apiKey,
      model: template.model,
      contextLength: template.contextLength
    } as AiProfile)
    // 清空输入并收起
    templateApiKeys.value[template.index] = ''
    selectedTemplateIndex.value = null
    return true
  } catch (error) {
    console.error('保存配置失败:', error)
    alert(t('setup.aiConfig.saveFailed'))
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

const skipWizard = async () => {
  // 直接完成向导
  await configStore.setSetupCompleted(true)
  emit('complete')
}

const nextStep = async () => {
  // 非 Steam 版第 2 步：必须至少配置一个 AI 模型才能继续
  if (!isSteamBuild && currentStep.value === 2 && configStore.aiProfiles.length === 0) {
    alert(t('setup.aiConfig.required'))
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
      <!-- 主内容 -->
      <div class="wizard-main">
        <!-- 步骤进度条 -->
        <div class="steps-progress">
          <div
            v-for="step in totalSteps"
            :key="step"
            class="step-indicator"
            :class="{ active: step === currentStep, completed: step < currentStep }"
          >
            <div class="step-number">{{ step }}</div>
            <div class="step-line" v-if="step < totalSteps"></div>
          </div>
        </div>

        <!-- 步骤内容 -->
        <div class="step-content">
        <!-- 步骤1: 欢迎 -->
        <div v-if="currentStep === 1" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.welcome.title') }}</h2>
            <p class="step-intro">{{ t('setup.welcome.subtitle') }}</p>
          </div>
          <div class="welcome-content">
            <div class="welcome-intro">
              <p class="intro-text">
                {{ t('setup.welcome.intro') }}
              </p>
            </div>
            <div class="feature-grid">
              <div class="feature-card">
                <span class="feature-icon">💬</span>
                <h3>{{ t('setup.welcome.features.aiChat.title') }}</h3>
              </div>
              <div class="feature-card">
                <span class="feature-icon">⚡</span>
                <h3>{{ t('setup.welcome.features.agent.title') }}</h3>
              </div>
              <div class="feature-card">
                <span class="feature-icon">🖥️</span>
                <h3>{{ t('setup.welcome.features.ssh.title') }}</h3>
              </div>
              <div class="feature-card">
                <span class="feature-icon">📚</span>
                <h3>{{ t('setup.welcome.features.knowledge.title') }}</h3>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤2: 配置大模型（仅非 Steam 版） -->
        <div v-if="currentStep === 2 && !isSteamBuild" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.aiConfig.title') }}</h2>
            <p class="step-intro">{{ t('setup.aiConfig.subtitleSimple') }}</p>
          </div>
          <div class="config-content">
            <!-- 已配置提示 -->
            <div v-if="configStore.aiProfiles.length > 0" class="configured-hint">
              <Check :size="18" class="configured-icon" />
              <span>{{ t('setup.aiConfig.alreadyConfigured', { name: configStore.aiProfiles[0].name }) }}</span>
            </div>

            <!-- 模板卡片列表 -->
            <div class="ai-template-list">
              <div
                v-for="template in aiTemplates"
                :key="template.name"
                class="ai-template-card"
                :class="{ 
                  selected: selectedTemplateIndex === template.index,
                  configured: isTemplateConfigured(template.name)
                }"
              >
                <div class="ai-template-header" @click="selectTemplate(template.index)">
                  <div class="ai-template-info">
                    <div class="ai-template-name">
                      {{ template.name }}
                      <span v-if="isTemplateConfigured(template.name)" class="configured-tag">
                        <Check :size="12" />
                        {{ t('setup.aiConfig.configured') }}
                      </span>
                    </div>
                    <div class="ai-template-desc">{{ template.desc }}</div>
                  </div>
                  <ChevronDown 
                    v-if="!isTemplateConfigured(template.name)"
                    :size="18" 
                    class="expand-arrow" 
                    :class="{ rotated: selectedTemplateIndex === template.index }"
                  />
                </div>
                
                <!-- 展开区域：API Key 输入 / 自定义表单 -->
                <div v-if="selectedTemplateIndex === template.index && !isTemplateConfigured(template.name)" class="ai-template-body">
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
        <div v-if="currentStep === (isSteamBuild ? 2 : 3)" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.complete.title') }}</h2>
            <p class="step-intro">{{ t('setup.complete.readyToUse') }}</p>
          </div>
          <div class="complete-content">
            <!-- 配置完成提示（Steam 版用精简文案） -->
            <div class="ready-banner">
              <div class="ready-icon">🎉</div>
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
              <div class="config-card" :class="{ expanded: expandedSection === 'import' }">
                <div class="config-card-header" @click="toggleSection('import')">
                  <FolderInput :size="20" class="card-icon" />
                  <div class="card-info">
                    <span class="card-title">{{ t('setup.import.title') }}</span>
                    <span class="card-desc">{{ t('setup.import.shortDesc') }}</span>
                  </div>
                  <div class="card-status" v-if="importResult?.success">
                    <Check :size="16" class="status-icon success" />
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

              <!-- 知识库 -->
              <div class="config-card" :class="{ expanded: expandedSection === 'knowledge' }">
                <div class="config-card-header" @click="toggleSection('knowledge')">
                  <Database :size="20" class="card-icon" />
                  <div class="card-info">
                    <span class="card-title">{{ t('setup.knowledge.title') }}</span>
                    <span class="card-desc">{{ t('setup.knowledge.shortDesc') }}</span>
                  </div>
                  <div class="card-status" v-if="knowledgeEnabled">
                    <Check :size="16" class="status-icon success" />
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

              <!-- MCP 服务 -->
              <div class="config-card" :class="{ expanded: expandedSection === 'mcp' }">
                <div class="config-card-header" @click="toggleSection('mcp'); loadMcpServers()">
                  <Plug :size="20" class="card-icon" />
                  <div class="card-info">
                    <span class="card-title">{{ t('setup.mcp.title') }}</span>
                    <span class="card-desc">{{ t('setup.mcp.shortDesc') }}</span>
                  </div>
                  <div class="card-status" v-if="mcpServers.length > 0">
                    <Check :size="16" class="status-icon success" />
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
            class="btn"
            @click="prevStep"
            :disabled="!canGoPrev"
          >
            {{ t('common.prev') }}
          </button>
          <div class="footer-center" v-if="currentStep === 1">
            <button
              class="btn btn-outline"
              @click="skipWizard"
            >
              {{ t('setup.welcome.skipWizard') }}
            </button>
          </div>
          <div class="footer-right">
            <button
              class="btn btn-primary"
              @click="nextStep"
            >
              {{ currentStep === totalSteps ? t('common.finish') : t('common.next') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.setup-wizard {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(8px);
}

.wizard-container {
  width: 90%;
  max-width: 640px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 16px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: row;
  overflow: hidden;
  border: 1px solid var(--border-color);
}

/* 左侧主内容区 */
.wizard-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* 步骤进度条 */
.steps-progress {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-wrap: wrap;
  gap: 4px;
}

.step-indicator {
  display: flex;
  align-items: center;
  position: relative;
}

.step-number {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 600;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border: 2px solid var(--border-color);
  transition: all 0.3s ease;
  z-index: 1;
}

.step-indicator.active .step-number {
  background: var(--accent-primary);
  color: white;
  border-color: var(--accent-primary);
  transform: scale(1.1);
}

.step-indicator.completed .step-number {
  background: #10b981;
  color: white;
  border-color: #10b981;
}

.step-line {
  width: 60px;
  height: 2px;
  background: var(--border-color);
  margin: 0 4px;
  transition: all 0.3s ease;
}

.step-indicator.completed .step-line {
  background: #10b981;
}

/* 步骤内容 */
.step-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px;
}

.step-panel {
  animation: fadeIn 0.3s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.step-header {
  text-align: center;
  margin-bottom: 32px;
}

.step-header h2 {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.step-intro {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

/* 欢迎页 */
.welcome-content {
  margin-top: 24px;
}

.welcome-intro {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border-left: 3px solid var(--accent-primary);
}

.intro-text {
  font-size: 14px;
  line-height: 1.8;
  color: var(--text-primary);
  margin: 0;
}

/* 精简的功能卡片网格 */
.feature-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.feature-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 16px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
  text-align: center;
}

.feature-card .feature-icon {
  font-size: 28px;
}

.feature-card h3 {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0;
}

/* 配置大模型 - 简化版 */
.config-content {
  margin-top: 24px;
}

/* 已配置提示 */
.configured-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 8px;
  margin-bottom: 20px;
  font-size: 13px;
  color: #10b981;
}

.configured-icon {
  flex-shrink: 0;
}

/* AI 模板卡片列表 */
.ai-template-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ai-template-card {
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.ai-template-card.selected {
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 1px var(--accent-primary);
}

.ai-template-card.configured {
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.05);
}


.ai-template-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  cursor: pointer;
  background: var(--bg-secondary);
  transition: background 0.2s ease;
}

.ai-template-card.configured .ai-template-header {
  cursor: default;
}

.ai-template-header:hover {
  background: var(--bg-tertiary);
}

.ai-template-info {
  flex: 1;
  min-width: 0;
}

.ai-template-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.configured-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 500;
  color: #10b981;
  background: rgba(16, 185, 129, 0.15);
  padding: 2px 8px;
  border-radius: 10px;
}

.ai-template-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.expand-arrow {
  color: var(--text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.expand-arrow.rotated {
  transform: rotate(180deg);
}

.ai-template-body {
  padding: 16px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.api-key-input-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.api-key-input-row .input {
  flex: 1;
}

.get-key-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--accent-primary);
  background: transparent;
  border: 1px solid var(--accent-primary);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s ease;
}

.get-key-link:hover {
  background: var(--accent-primary);
  color: white;
}

.local-hint {
  font-size: 13px;
  color: var(--text-secondary);
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
}

.btn-save {
  align-self: flex-start;
}

/* 自定义模板表单 */
.custom-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.custom-form .form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.custom-form .form-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.custom-form .input {
  padding: 8px 12px;
  font-size: 13px;
}

.ai-config-hint {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
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

.input {
  padding: 10px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

/* 导入主机 */
.import-content {
  margin-top: 24px;
}

.import-intro {
  margin-bottom: 20px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.scanning {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
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

@keyframes spin {
  to { transform: rotate(360deg); }
}

.scan-result {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.result-info {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: rgba(16, 185, 129, 0.1);
  border-radius: 8px;
  color: #10b981;
  font-size: 14px;
}

.result-icon {
  font-size: 18px;
}

.result-paths {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.path-item {
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  font-family: monospace;
  word-break: break-all;
}

.import-actions {
  display: flex;
  gap: 12px;
}

.no-sessions {
  text-align: center;
  padding: 60px 40px;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.no-sessions-icon {
  font-size: 64px;
  display: block;
  margin-bottom: 24px;
  opacity: 0.6;
  filter: grayscale(0.3);
}

.no-sessions-title {
  font-size: 18px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.no-sessions-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 32px;
  line-height: 1.6;
  max-width: 400px;
}

.no-sessions-btn {
  min-width: 160px;
  padding: 12px 24px;
  font-size: 14px;
  font-weight: 500;
}

.import-result {
  margin-top: 8px;
}

.success-message {
  padding: 12px;
  background: rgba(16, 185, 129, 0.1);
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 8px;
  color: #10b981;
  font-size: 13px;
}

.error-message {
  padding: 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  color: #ef4444;
  font-size: 13px;
}

/* 知识库 */
.knowledge-content {
  margin-top: 24px;
}

.knowledge-info {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.info-box {
  display: flex;
  gap: 16px;
  padding: 20px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
}

.info-icon {
  font-size: 32px;
  flex-shrink: 0;
}

.info-text h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.info-text ul {
  margin: 0;
  padding-left: 20px;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.8;
}

.knowledge-switch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 20px;
}

.switch-label {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.switch-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}

/* 密码设置 */
.password-setup {
  margin-top: 24px;
  padding: 20px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
}

.password-intro {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-color);
}

.password-icon {
  font-size: 24px;
  flex-shrink: 0;
}

.password-intro p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.6;
}

.password-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.password-error {
  font-size: 13px;
  color: var(--accent-error, #ef4444);
  margin: 0;
}

.switch {
  position: relative;
  display: inline-block;
  width: 44px;
  height: 24px;
}

.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background-color: var(--bg-tertiary);
  transition: 0.3s;
  border-radius: 24px;
}

.slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: 0.3s;
  border-radius: 50%;
}

input:checked + .slider {
  background-color: var(--accent-primary);
}

input:checked + .slider:before {
  transform: translateX(20px);
}

/* MCP 服务 */
.mcp-content {
  margin-top: 24px;
}

.mcp-intro {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.mcp-intro p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.mcp-intro p:last-child {
  margin-bottom: 0;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-secondary);
}

.mcp-servers {
  margin-top: 20px;
}

.server-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.server-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.server-info {
  flex: 1;
}

.server-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.server-detail {
  font-size: 12px;
  color: var(--text-muted);
}

.server-status {
  padding: 4px 8px;
  font-size: 11px;
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-muted);
}

.server-status.enabled {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.no-mcp {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.no-mcp-icon {
  font-size: 48px;
  display: block;
  margin-bottom: 16px;
}

/* 完成页 */
.complete-content {
  margin-top: 24px;
}

/* 准备就绪横幅 */
.ready-banner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(16, 185, 129, 0.05));
  border: 1px solid rgba(16, 185, 129, 0.3);
  border-radius: 12px;
  margin-bottom: 28px;
}

.ready-icon {
  font-size: 36px;
  flex-shrink: 0;
}

.ready-text h3 {
  font-size: 16px;
  font-weight: 600;
  color: #10b981;
  margin: 0 0 4px;
}

.ready-text p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}

/* 可选配置区域 */
.optional-section {
  margin-top: 8px;
}

.optional-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 6px;
}

.optional-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 16px;
}

/* 可折叠配置卡片 */
.config-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  margin-bottom: 10px;
  overflow: hidden;
  transition: border-color 0.2s ease;
}

.config-card.expanded {
  border-color: var(--accent-primary);
}

.config-card-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  cursor: pointer;
  background: var(--bg-secondary);
  transition: background 0.2s ease;
}

.config-card-header:hover {
  background: var(--bg-tertiary);
}

.config-card-header .card-icon {
  color: var(--accent-primary);
  flex-shrink: 0;
}

.config-card-header .card-info {
  flex: 1;
  min-width: 0;
}

.config-card-header .card-title {
  display: block;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.config-card-header .card-desc {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.config-card-header .card-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #10b981;
}

.config-card-header .status-icon.success {
  color: #10b981;
}

.config-card-header .expand-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.config-card-body {
  padding: 16px;
  background: var(--bg-primary);
  border-top: 1px solid var(--border-color);
}

/* 扫描和导入样式 */
.scan-prompt {
  text-align: center;
  padding: 8px 0;
}

.scan-result-compact {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.scan-result-compact .result-text {
  font-size: 13px;
  color: #10b981;
  margin: 0;
}

.scan-result-compact .import-actions {
  display: flex;
  gap: 8px;
}

.no-result {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.no-result p {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
}

/* 知识库切换 */
.knowledge-toggle {
  margin-bottom: 12px;
}

.password-form-compact .form-row {
  display: flex;
  gap: 8px;
}

.password-form-compact .input-sm {
  flex: 1;
  padding: 8px 10px;
  font-size: 12px;
}

.password-form-compact .password-error {
  margin-top: 8px;
}

/* 加载状态 */
.loading-compact {
  display: flex;
  justify-content: center;
  padding: 12px 0;
}

/* MCP 列表 */
.mcp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mcp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
}

.mcp-name {
  font-size: 13px;
  color: var(--text-primary);
}

.mcp-status {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-secondary);
  color: var(--text-muted);
}

.mcp-status.enabled {
  background: rgba(16, 185, 129, 0.15);
  color: #10b981;
}

.no-mcp-compact p {
  font-size: 13px;
  color: var(--text-muted);
  margin: 0;
}

/* 小按钮样式 */
.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}

/* 导航按钮 */
.wizard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 32px;
  background: var(--bg-secondary);
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
  padding: 10px 20px;
  font-size: 14px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
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
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-outline {
  background: transparent;
}
</style>
