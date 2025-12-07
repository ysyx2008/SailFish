<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useConfigStore, type AiProfile } from '../stores/config'
import { v4 as uuidv4 } from 'uuid'

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

const aiTemplates = [
  {
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-3.5-turbo',
    desc: 'OpenAI 官方 API，支持 GPT-3.5、GPT-4 等模型'
  },
  {
    name: '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-turbo',
    desc: '阿里云通义千问，国内访问速度快'
  },
  {
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    desc: 'DeepSeek 大模型，性价比高'
  },
  {
    name: 'Ollama 本地',
    apiUrl: 'http://localhost:11434/v1/chat/completions',
    model: 'llama2',
    desc: '本地部署的 Ollama，数据不出本地'
  }
]

const applyAiTemplate = (template: typeof aiTemplates[0]) => {
  aiFormData.value.name = template.name
  aiFormData.value.apiUrl = template.apiUrl
  aiFormData.value.model = template.model
}

const saveAiConfig = async () => {
  if (!aiFormData.value.name || !aiFormData.value.apiUrl || !aiFormData.value.model) {
    alert('请填写完整的配置信息')
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
    alert('保存失败')
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
    // 导入第一个找到的路径
    const result = await window.electronAPI.xshell.importDirectory(scanResult.value.paths[0])
    
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
      importResult.value = {
        success: false,
        sessions: 0,
        errors: result.errors || ['导入失败']
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
        errors: importResponse.errors || ['导入失败']
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

const saveKnowledgeSettings = async () => {
  try {
    await window.electronAPI.knowledge.updateSettings({
      enabled: knowledgeEnabled.value
    })
    return true
  } catch (error) {
    console.error('保存知识库设置失败:', error)
    return false
  }
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
    await saveKnowledgeSettings()
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
            <h2>欢迎使用旗鱼终端</h2>
            <p class="step-intro">AI 驱动的智能终端工具，让运维更高效</p>
          </div>
          <div class="welcome-content">
            <div class="welcome-intro">
              <p class="intro-text">
                旗鱼终端是一款专为运维人员设计的智能终端工具，集成了强大的 AI 能力，让您的工作更加高效便捷。
                通过简单的引导，我们将帮助您完成初始配置，快速开始使用。
              </p>
            </div>
            <div class="feature-list">
              <div class="feature-item">
                <span class="feature-icon">💬</span>
                <div class="feature-text">
                  <h3>AI 对话助手</h3>
                  <p>在终端中直接与 AI 对话，询问命令用法、排查问题、获取帮助。支持多种大模型，包括 OpenAI、通义千问、DeepSeek 等，也支持本地部署的 Ollama。</p>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">⚡</span>
                <div class="feature-text">
                  <h3>Agent 自动执行</h3>
                  <p>AI Agent 可以理解您的自然语言指令，自动执行复杂的运维任务。支持命令执行、文件操作、系统监控等，让 AI 成为您的得力助手。</p>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">🖥️</span>
                <div class="feature-text">
                  <h3>SSH 会话管理</h3>
                  <p>统一管理多台服务器，支持分组、跳板机、快速连接。可以一键导入 Xshell 会话配置，快速迁移现有环境。</p>
                </div>
              </div>
              <div class="feature-item">
                <span class="feature-icon">📚</span>
                <div class="feature-text">
                  <h3>本地知识库</h3>
                  <p>上传文档到本地知识库，AI 对话时自动检索相关内容，提供更精准的答案。支持 PDF、Word、文本等多种格式，使用轻量级向量模型，无需额外下载。</p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤2: 配置大模型 -->
        <div v-if="currentStep === 2" class="step-panel">
          <div class="step-header">
            <h2>配置大模型</h2>
            <p class="step-intro">配置大语言模型，让终端更智能</p>
          </div>
          <div class="config-content">
            <div class="config-intro">
              <p>大模型是 AI 功能的核心，您需要配置至少一个模型才能使用 AI 对话和 Agent 功能。</p>
              <p class="hint">支持 OpenAI 兼容接口，包括 vLLM、FastChat、Ollama 等私有化部署方案。</p>
            </div>

            <!-- 已配置的模型列表 -->
            <div v-if="configStore.aiProfiles.length > 0" class="configured-models">
              <h3 class="section-title">已配置的模型</h3>
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
                  <div v-if="profile.id === configStore.activeAiProfileId" class="active-badge">当前使用</div>
                </div>
              </div>
            </div>

            <!-- 添加新模型 -->
            <div class="add-model-section">
              <h3 class="section-title">添加新模型</h3>
              <div class="templates">
                <span class="template-label">快速模板：</span>
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
                  <label class="form-label">配置名称 *</label>
                  <input v-model="aiFormData.name" type="text" class="input" placeholder="例如：公司内网模型" />
                </div>
                <div class="form-group">
                  <label class="form-label">API 地址 *</label>
                  <input v-model="aiFormData.apiUrl" type="text" class="input" placeholder="http://10.0.1.100:8080/v1/chat/completions" />
                </div>
                <div class="form-group">
                  <label class="form-label">API Key</label>
                  <input v-model="aiFormData.apiKey" type="password" class="input" placeholder="sk-...（本地部署可留空）" />
                </div>
                <div class="form-group">
                  <label class="form-label">模型名称 *</label>
                  <input v-model="aiFormData.model" type="text" class="input" placeholder="例如：qwen-72b, gpt-3.5-turbo" />
                </div>
                <button class="btn btn-primary" @click="saveAiConfig">保存配置</button>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤3: 导入主机 -->
        <div v-if="currentStep === 3" class="step-panel">
          <div class="step-header">
            <h2>导入 SSH 主机</h2>
            <p class="step-intro">快速导入已有的 SSH 主机配置</p>
          </div>
          <div class="import-content">
            <div class="import-intro">
              <p>如果您之前使用 Xshell，可以一键导入所有会话配置，快速迁移到旗鱼终端。</p>
            </div>
            <div v-if="scanning" class="scanning">
              <div class="spinner"></div>
              <span>正在扫描 Xshell 会话目录...</span>
            </div>
            <div v-else-if="scanResult">
              <div v-if="scanResult.found" class="scan-result">
                <div class="result-info">
                  <span class="result-icon">✓</span>
                  <span>找到 {{ scanResult.sessionCount }} 个会话</span>
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
                    {{ importing ? '导入中...' : importResult?.success ? '已导入' : '一键导入' }}
                  </button>
                  <button
                    class="btn btn-outline"
                    @click="manualImport"
                    :disabled="importing"
                  >
                    手动选择目录
                  </button>
                </div>
                <div v-if="importResult" class="import-result">
                  <div v-if="importResult.success" class="success-message">
                    ✓ 成功导入 {{ importResult.sessions }} 个主机
                  </div>
                  <div v-else class="error-message">
                    ✗ 导入失败：{{ importResult.errors.join(', ') }}
                  </div>
                </div>
              </div>
              <div v-else class="no-sessions">
                <span class="no-sessions-icon">📭</span>
                <p class="no-sessions-title">未找到 Xshell 会话目录</p>
                <p class="no-sessions-hint">您可以手动选择目录导入，或稍后在设置中添加主机</p>
                <button class="btn btn-primary no-sessions-btn" @click="manualImport" :disabled="importing">
                  {{ importing ? '导入中...' : '手动选择目录' }}
                </button>
                <div v-if="importResult && !importResult.success" class="error-message">
                  ✗ 导入失败：{{ importResult.errors.join(', ') }}
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤4: 知识库 -->
        <div v-if="currentStep === 4" class="step-panel">
          <div class="step-header">
            <h2>启用本地知识库</h2>
            <p class="step-intro">启用本地知识库，让 AI 更懂你的文档</p>
          </div>
          <div class="knowledge-content">
            <div class="knowledge-info">
              <div class="info-box">
                <span class="info-icon">📚</span>
                <div class="info-text">
                  <h3>知识库功能</h3>
                  <ul>
                    <li>上传文档到本地知识库，支持 PDF、Word、文本等多种格式</li>
                    <li>AI 对话时自动检索相关内容，提供更精准的答案</li>
                    <li>使用轻量级向量模型（all-MiniLM-L6-v2），已随软件打包，无需额外下载</li>
                    <li>支持语义搜索和重排序，提高检索准确性</li>
                  </ul>
                </div>
              </div>
              <div class="knowledge-switch">
                <label class="switch-label">
                  <span>启用知识库</span>
                  <label class="switch">
                    <input type="checkbox" v-model="knowledgeEnabled" />
                    <span class="slider"></span>
                  </label>
                </label>
                <p class="switch-hint">开启后可将对话中上传的文档保存供Agent使用</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 步骤5: MCP 服务 -->
        <div v-if="currentStep === 5" class="step-panel">
          <div class="step-header">
            <h2>配置 MCP 服务</h2>
            <p class="step-intro">连接 MCP 服务器，扩展 AI 能力</p>
          </div>
          <div class="mcp-content">
            <div class="mcp-intro">
              <p>MCP (Model Context Protocol) 是一种协议，允许 AI 访问外部工具和资源。</p>
              <p class="hint">您可以稍后在设置中添加 MCP 服务器，现在可以跳过此步骤。</p>
            </div>
            <div v-if="loadingMcp" class="loading">
              <div class="spinner"></div>
              <span>加载中...</span>
            </div>
            <div v-else-if="mcpServers.length > 0" class="mcp-servers">
              <h3 class="section-title">已配置的 MCP 服务器</h3>
              <div class="server-list">
                <div
                  v-for="server in mcpServers"
                  :key="server.id"
                  class="server-item"
                >
                  <div class="server-info">
                    <div class="server-name">{{ server.name }}</div>
                    <div class="server-detail">{{ server.transport === 'stdio' ? '标准输入输出' : 'SSE' }}</div>
                  </div>
                  <div class="server-status" :class="{ enabled: server.enabled }">
                    {{ server.enabled ? '已启用' : '未启用' }}
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="no-mcp">
              <span class="no-mcp-icon">🔌</span>
              <p>尚未配置 MCP 服务器</p>
              <p class="hint">您可以在设置中添加 MCP 服务器，扩展 AI 的功能</p>
            </div>
          </div>
        </div>

        <!-- 步骤6: 完成 -->
        <div v-if="currentStep === 6" class="step-panel">
          <div class="step-header">
            <h2>一切就绪！</h2>
            <p class="step-intro">开始使用旗鱼终端吧</p>
          </div>
          <div class="complete-content">
            <div class="summary">
              <div class="summary-item" :class="{ active: summary.aiConfigured }">
                <span class="summary-icon">{{ summary.aiConfigured ? '✓' : '○' }}</span>
                <span>大模型{{ summary.aiConfigured ? '已配置' : '未配置' }}</span>
              </div>
              <div class="summary-item" :class="{ active: summary.hostsImported > 0 }">
                <span class="summary-icon">{{ summary.hostsImported > 0 ? '✓' : '○' }}</span>
                <span>已导入 {{ summary.hostsImported }} 个主机</span>
              </div>
              <div class="summary-item" :class="{ active: summary.knowledgeEnabled }">
                <span class="summary-icon">{{ summary.knowledgeEnabled ? '✓' : '○' }}</span>
                <span>知识库{{ summary.knowledgeEnabled ? '已启用' : '未启用' }}</span>
              </div>
              <div class="summary-item" :class="{ active: summary.mcpConfigured }">
                <span class="summary-icon">{{ summary.mcpConfigured ? '✓' : '○' }}</span>
                <span>MCP 服务{{ summary.mcpConfigured ? '已配置' : '未配置' }}</span>
              </div>
            </div>
            <div class="complete-tips">
              <p>💡 提示：您可以在设置中随时修改这些配置</p>
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
          上一步
        </button>
        <div class="footer-center" v-if="currentStep === 1">
          <button
            class="btn btn-outline"
            @click="skipWizard"
          >
            跳过引导
          </button>
        </div>
        <div class="footer-right">
          <button
            v-if="canSkip && currentStep !== 1"
            class="btn btn-outline"
            @click="skipStep"
          >
            跳过
          </button>
          <button
            class="btn btn-primary"
            @click="nextStep"
          >
            {{ currentStep === totalSteps ? '完成' : '下一步' }}
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
