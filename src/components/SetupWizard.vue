<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink } from 'lucide-vue-next'
import { useConfigStore, type AiProfile } from '../stores/config'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()

const emit = defineEmits<{
  complete: []
}>()

const configStore = useConfigStore()

// 步骤管理
const currentStep = ref(1)
const totalSteps = 6

// 步骤1: 欢迎
// 无需数据

// 步骤2: 配置大模型
const aiFormData = ref<Partial<AiProfile>>({
  name: '',
  apiUrl: '',
  apiKey: '',
  model: '',
  contextLength: 8000
})

const aiTemplates = computed(() => [
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo',
    desc: t('aiSettings.templates.openai'),
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    name: t('aiSettings.templates.qwen').includes('Qwen') ? 'Qwen' : '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-turbo',
    desc: t('aiSettings.templates.qwen'),
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key'
  },
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    desc: t('aiSettings.templates.deepseek'),
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  {
    name: 'Ollama',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama2',
    desc: t('aiSettings.templates.ollama'),
    keyUrl: 'https://ollama.com/'
  }
])

// 当前选中的模板对应的 keyUrl
const currentKeyUrl = computed(() => {
  const template = aiTemplates.value.find(t => t.apiUrl === aiFormData.value.apiUrl)
  return template?.keyUrl || null
})

const openKeyUrl = (url: string) => {
  window.open(url, '_blank')
}

const applyAiTemplate = (template: typeof aiTemplates.value[0]) => {
  aiFormData.value.name = template.name
  aiFormData.value.apiUrl = template.apiUrl
  aiFormData.value.model = template.model
}

const saveAiConfig = async () => {
  if (!aiFormData.value.name || !aiFormData.value.apiUrl || !aiFormData.value.model) {
    alert(t('setup.aiConfig.fillRequired'))
    return false
  }

  try {
    await configStore.addAiProfile({
      id: uuidv4(),
      ...aiFormData.value
    } as AiProfile)
    // 清空表单
    aiFormData.value = {
      name: '',
      apiUrl: '',
      apiKey: '',
      model: '',
      contextLength: 8000
    }
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
const knowledgeEnabled = ref(false)
const knowledgePassword = ref('')
const knowledgePasswordConfirm = ref('')
const knowledgePasswordError = ref('')
const savingKnowledge = ref(false)

const saveKnowledgeSettings = async () => {
  // 如果要启用知识库，需要先设置密码
  if (knowledgeEnabled.value) {
    if (knowledgePassword.value.length < 4) {
      knowledgePasswordError.value = t('setup.knowledge.passwordMinLength')
      return false
    }
    if (knowledgePassword.value !== knowledgePasswordConfirm.value) {
      knowledgePasswordError.value = t('setup.knowledge.passwordMismatch')
      return false
    }
    
    try {
      savingKnowledge.value = true
      // 先设置密码
      const passwordResult = await window.electronAPI.knowledge.setPassword(knowledgePassword.value)
      if (!passwordResult.success) {
        knowledgePasswordError.value = passwordResult.error || t('setup.knowledge.saveFailed')
        return false
      }
      
      // 再启用知识库
      await window.electronAPI.knowledge.updateSettings({
        enabled: true
      })
      return true
    } catch (error) {
      console.error('保存知识库设置失败:', error)
      knowledgePasswordError.value = t('setup.knowledge.saveFailed')
      return false
    } finally {
      savingKnowledge.value = false
    }
  }
  
  // 不启用知识库，直接返回
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

// 步骤6: 完成
const summary = computed(() => {
  return {
    aiConfigured: configStore.aiProfiles.length > 0,
    hostsImported: importResult.value?.sessions || 0,
    knowledgeEnabled: knowledgeEnabled.value,
    mcpConfigured: mcpServers.value.length > 0
  }
})

// 导航
const canGoPrev = computed(() => {
  return currentStep.value > 1
})

const canSkip = computed(() => {
  return currentStep.value >= 2 && currentStep.value <= 5
})

const skipWizard = async () => {
  // 直接完成向导
  await configStore.setSetupCompleted(true)
  emit('complete')
}

const nextStep = async () => {
  // 保存当前步骤的数据
  if (currentStep.value === 4) {
    const success = await saveKnowledgeSettings()
    if (!success) {
      // 保存失败，不前进
      return
    }
  }

  if (currentStep.value < totalSteps) {
    currentStep.value++
    // 如果进入 MCP 步骤，加载服务器列表
    if (currentStep.value === 5) {
      await loadMcpServers()
    }
  } else {
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

const skipStep = async () => {
  await nextStep()
}

// 初始化
onMounted(async () => {
  // 自动扫描 Xshell
  await scanXshell()
})
</script>

<template>
  <div class="setup-wizard">
    <div class="wizard-container">
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
            <div class="feature-list">
              <div class="feature-item">
                <span class="feature-icon">💬</span>
                <div class="feature-text">
                  <h3>{{ t('setup.welcome.features.aiChat.title') }}</h3>
                  <p>{{ t('setup.welcome.features.aiChat.desc') }}</p>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">⚡</span>
                <div class="feature-text">
                  <h3>{{ t('setup.welcome.features.agent.title') }}</h3>
                  <p>{{ t('setup.welcome.features.agent.desc') }}</p>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">🖥️</span>
                <div class="feature-text">
                  <h3>{{ t('setup.welcome.features.ssh.title') }}</h3>
                  <p>{{ t('setup.welcome.features.ssh.desc') }}</p>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">📚</span>
                <div class="feature-text">
                  <h3>{{ t('setup.welcome.features.knowledge.title') }}</h3>
                  <p>{{ t('setup.welcome.features.knowledge.desc') }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤2: 配置大模型 -->
        <div v-if="currentStep === 2" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.aiConfig.title') }}</h2>
            <p class="step-intro">{{ t('setup.aiConfig.subtitle') }}</p>
          </div>
          <div class="config-content">
            <div class="config-intro">
              <p>{{ t('setup.aiConfig.intro') }}</p>
              <p class="hint">{{ t('setup.aiConfig.hint') }}</p>
            </div>

            <!-- 已配置的模型列表 -->
            <div v-if="configStore.aiProfiles.length > 0" class="configured-models">
              <h3 class="section-title">{{ t('setup.aiConfig.configuredModels') }}</h3>
              <div class="model-list">
                <div
                  v-for="profile in configStore.aiProfiles"
                  :key="profile.id"
                  class="model-item"
                  :class="{ active: profile.id === configStore.activeAiProfileId }"
                >
                  <div class="model-info">
                    <div class="model-name">{{ profile.name }}</div>
                    <div class="model-detail">{{ profile.model }} · {{ profile.apiUrl }}</div>
                  </div>
                  <div v-if="profile.id === configStore.activeAiProfileId" class="active-badge">{{ t('aiSettings.currentlyUsing') }}</div>
                </div>
              </div>
            </div>

            <!-- 添加新模型 -->
            <div class="add-model-section">
              <h3 class="section-title">{{ t('setup.aiConfig.addNewModel') }}</h3>
              <div class="templates">
                <span class="template-label">{{ t('setup.aiConfig.quickTemplates') }}</span>
                <div class="template-grid">
                  <button
                    v-for="template in aiTemplates"
                    :key="template.name"
                    class="template-card"
                    @click="applyAiTemplate(template)"
                  >
                    <div class="template-name">{{ template.name }}</div>
                    <div class="template-desc">{{ template.desc }}</div>
                  </button>
                </div>
              </div>
              <div class="config-form">
                <div class="form-group">
                  <label class="form-label">{{ t('aiSettings.profileName') }} *</label>
                  <input v-model="aiFormData.name" type="text" class="input" :placeholder="t('aiSettings.profileNamePlaceholder')" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{ t('aiSettings.apiUrl') }} *</label>
                  <input v-model="aiFormData.apiUrl" type="text" class="input" :placeholder="t('aiSettings.apiUrlPlaceholder')" />
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
                  <input v-model="aiFormData.apiKey" type="password" class="input" :placeholder="t('aiSettings.apiKeyPlaceholder')" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{ t('aiSettings.model') }} *</label>
                  <input v-model="aiFormData.model" type="text" class="input" :placeholder="t('aiSettings.modelPlaceholder')" />
                </div>
                <button class="btn btn-primary" @click="saveAiConfig">{{ t('aiSettings.saveProfile') }}</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤3: 导入主机 -->
        <div v-if="currentStep === 3" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.import.title') }}</h2>
            <p class="step-intro">{{ t('setup.import.subtitle') }}</p>
          </div>
          <div class="import-content">
            <div class="import-intro">
              <p>{{ t('setup.import.intro') }}</p>
            </div>
            <div v-if="scanning" class="scanning">
              <div class="spinner"></div>
              <span>{{ t('setup.import.scanning') }}</span>
            </div>
            <div v-else-if="scanResult">
              <div v-if="scanResult.found" class="scan-result">
                <div class="result-info">
                  <span class="result-icon">✓</span>
                  <span>{{ t('setup.import.found', { count: scanResult.sessionCount }) }}</span>
                </div>
                <div class="result-paths">
                  <div v-for="(path, idx) in scanResult.paths" :key="idx" class="path-item">
                    {{ path }}
                  </div>
                </div>
                <div class="import-actions">
                  <button
                    class="btn btn-primary"
                    @click="importXshell"
                    :disabled="importing || importResult?.success"
                  >
                    {{ importing ? t('setup.import.importing') : importResult?.success ? t('setup.import.imported') : t('setup.import.import') }}
                  </button>
                  <button
                    class="btn btn-outline"
                    @click="manualImport"
                    :disabled="importing"
                  >
                    {{ t('setup.import.manualSelect') }}
                  </button>
                </div>
                <div v-if="importResult" class="import-result">
                  <div v-if="importResult.success" class="success-message">
                    ✓ {{ t('setup.import.importSuccess', { count: importResult.sessions }) }}
                  </div>
                  <div v-else class="error-message">
                    ✗ {{ t('setup.import.importFailed') }}：{{ importResult.errors.join(', ') }}
                  </div>
                </div>
              </div>
              <div v-else class="no-sessions">
                <span class="no-sessions-icon">📭</span>
                <p class="no-sessions-title">{{ t('setup.import.notFound') }}</p>
                <p class="no-sessions-hint">{{ t('setup.import.notFoundHint') }}</p>
                <button class="btn btn-primary no-sessions-btn" @click="manualImport" :disabled="importing">
                  {{ importing ? t('setup.import.importing') : t('setup.import.manualSelect') }}
                </button>
                <div v-if="importResult && !importResult.success" class="error-message">
                  ✗ {{ t('setup.import.importFailed') }}：{{ importResult.errors.join(', ') }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤4: 知识库 -->
        <div v-if="currentStep === 4" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.knowledge.title') }}</h2>
            <p class="step-intro">{{ t('setup.knowledge.subtitle') }}</p>
          </div>
          <div class="knowledge-content">
            <div class="knowledge-info">
              <div class="info-box">
                <span class="info-icon">📚</span>
                <div class="info-text">
                  <h3>{{ t('setup.knowledge.features.title') }}</h3>
                  <ul>
                    <li>{{ t('setup.knowledge.features.item1') }}</li>
                    <li>{{ t('setup.knowledge.features.item2') }}</li>
                    <li>{{ t('setup.knowledge.features.item3') }}</li>
                    <li>{{ t('setup.knowledge.features.item4') }}</li>
                  </ul>
                </div>
              </div>
              <div class="knowledge-switch">
                <label class="switch-label">
                  <span>{{ t('setup.knowledge.enableSwitch') }}</span>
                  <label class="switch">
                    <input type="checkbox" v-model="knowledgeEnabled" />
                    <span class="slider"></span>
                  </label>
                </label>
                <p class="switch-hint">{{ t('setup.knowledge.enableHint') }}</p>
              </div>
              
              <!-- 密码设置（启用时显示） -->
              <div v-if="knowledgeEnabled" class="password-setup">
                <div class="password-intro">
                  <span class="password-icon">🔐</span>
                  <p>{{ t('setup.knowledge.passwordIntro') }}</p>
                </div>
                <div class="password-form">
                  <div class="form-group">
                    <label class="form-label">{{ t('setup.knowledge.passwordLabel') }} *</label>
                    <input 
                      type="password" 
                      v-model="knowledgePassword" 
                      class="input" 
                      :placeholder="t('setup.knowledge.passwordPlaceholder')"
                    />
                  </div>
                  <div class="form-group">
                    <label class="form-label">{{ t('setup.knowledge.confirmPasswordLabel') }} *</label>
                    <input 
                      type="password" 
                      v-model="knowledgePasswordConfirm" 
                      class="input" 
                      :placeholder="t('setup.knowledge.confirmPasswordPlaceholder')"
                    />
                  </div>
                  <p v-if="knowledgePasswordError" class="password-error">{{ knowledgePasswordError }}</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤5: MCP 服务 -->
        <div v-if="currentStep === 5" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.mcp.title') }}</h2>
            <p class="step-intro">{{ t('setup.mcp.subtitle') }}</p>
          </div>
          <div class="mcp-content">
            <div class="mcp-intro">
              <p>{{ t('setup.mcp.intro') }}</p>
              <p class="hint">{{ t('setup.mcp.hint') }}</p>
            </div>
            <div v-if="loadingMcp" class="loading">
              <div class="spinner"></div>
              <span>{{ t('common.loading') }}</span>
            </div>
            <div v-else-if="mcpServers.length > 0" class="mcp-servers">
              <h3 class="section-title">{{ t('setup.mcp.configuredServers') }}</h3>
              <div class="server-list">
                <div
                  v-for="server in mcpServers"
                  :key="server.id"
                  class="server-item"
                >
                  <div class="server-info">
                    <div class="server-name">{{ server.name }}</div>
                    <div class="server-detail">{{ server.transport === 'stdio' ? t('mcpSettings.transportStdio') : t('mcpSettings.transportSse') }}</div>
                  </div>
                  <div class="server-status" :class="{ enabled: server.enabled }">
                    {{ server.enabled ? t('common.enabled') : t('common.disabled') }}
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="no-mcp">
              <span class="no-mcp-icon">🔌</span>
              <p>{{ t('setup.mcp.noServers') }}</p>
              <p class="hint">{{ t('setup.mcp.noServersHint') }}</p>
            </div>
          </div>
        </div>

        <!-- 步骤6: 完成 -->
        <div v-if="currentStep === 6" class="step-panel">
          <div class="step-header">
            <h2>{{ t('setup.complete.title') }}</h2>
            <p class="step-intro">{{ t('setup.complete.subtitle') }}</p>
          </div>
          <div class="complete-content">
            <div class="summary">
              <div class="summary-item" :class="{ active: summary.aiConfigured }">
                <span class="summary-icon">{{ summary.aiConfigured ? '✓' : '○' }}</span>
                <span>{{ summary.aiConfigured ? t('setup.complete.summary.aiConfigured') : t('setup.complete.summary.aiNotConfigured') }}</span>
              </div>
              <div class="summary-item" :class="{ active: summary.hostsImported > 0 }">
                <span class="summary-icon">{{ summary.hostsImported > 0 ? '✓' : '○' }}</span>
                <span>{{ t('setup.complete.summary.hostsImported', { count: summary.hostsImported }) }}</span>
              </div>
              <div class="summary-item" :class="{ active: summary.knowledgeEnabled }">
                <span class="summary-icon">{{ summary.knowledgeEnabled ? '✓' : '○' }}</span>
                <span>{{ summary.knowledgeEnabled ? t('setup.complete.summary.knowledgeEnabled') : t('setup.complete.summary.knowledgeNotEnabled') }}</span>
              </div>
              <div class="summary-item" :class="{ active: summary.mcpConfigured }">
                <span class="summary-icon">{{ summary.mcpConfigured ? '✓' : '○' }}</span>
                <span>{{ summary.mcpConfigured ? t('setup.complete.summary.mcpConfigured') : t('setup.complete.summary.mcpNotConfigured') }}</span>
              </div>
            </div>
            <div class="complete-tips">
              <p>💡 {{ t('setup.complete.tip') }}</p>
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
            v-if="canSkip && currentStep !== 1"
            class="btn btn-outline"
            @click="skipStep"
          >
            {{ t('common.skip') }}
          </button>
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
  max-width: 700px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 16px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border-color);
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

.feature-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.feature-item {
  display: flex;
  gap: 16px;
  padding: 20px;
  background: var(--bg-tertiary);
  border-radius: 12px;
  border: 1px solid var(--border-color);
}

.feature-icon {
  font-size: 32px;
  flex-shrink: 0;
}

.feature-text h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.feature-text p {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.6;
}

/* 配置大模型 */
.config-content {
  margin-top: 24px;
}

.config-intro {
  margin-bottom: 24px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.config-intro p {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.config-intro p:last-child {
  margin-bottom: 0;
}

.hint {
  font-size: 12px;
  color: var(--text-muted);
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.configured-models {
  margin-bottom: 32px;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.model-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.model-item.active {
  border-color: var(--accent-primary);
  background: rgba(137, 180, 250, 0.1);
}

.model-info {
  flex: 1;
  min-width: 0;
}

.model-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.model-detail {
  font-size: 12px;
  color: var(--text-muted);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.active-badge {
  padding: 4px 8px;
  font-size: 11px;
  background: var(--accent-primary);
  color: white;
  border-radius: 4px;
}

.add-model-section {
  margin-top: 24px;
}

.templates {
  margin-bottom: 20px;
}

.template-label {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.template-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.template-card {
  padding: 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.template-card:hover {
  border-color: var(--accent-primary);
  background: var(--bg-hover);
}

.template-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.template-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
}

.config-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
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

.summary {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.summary-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  font-size: 14px;
  color: var(--text-secondary);
}

.summary-item.active {
  border-color: #10b981;
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
}

.summary-icon {
  font-size: 18px;
  font-weight: 600;
}

.complete-tips {
  text-align: center;
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  font-size: 13px;
  color: var(--text-muted);
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
