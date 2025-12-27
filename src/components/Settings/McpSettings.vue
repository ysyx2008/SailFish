<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, toRaw } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Play, Pause, Pencil, Trash2, X } from 'lucide-vue-next'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()

// 类型定义
interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
}

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
  error?: string
  toolCount: number
  resourceCount: number
  promptCount: number
}

interface McpTool {
  serverId: string
  serverName: string
  name: string
  description: string
}

interface McpResource {
  serverId: string
  serverName: string
  uri: string
  name: string
  description?: string
}

interface McpPrompt {
  serverId: string
  serverName: string
  name: string
  description?: string
}

// 状态
const servers = ref<McpServerConfig[]>([])
const serverStatuses = ref<McpServerStatus[]>([])
const showForm = ref(false)
const editingServer = ref<McpServerConfig | null>(null)
const testResult = ref<{ success: boolean; message: string } | null>(null)
const testing = ref(false)
const connecting = ref<string | null>(null)

// 详情弹窗
const showDetails = ref(false)
const selectedServer = ref<McpServerConfig | null>(null)
const serverTools = ref<McpTool[]>([])
const serverResources = ref<McpResource[]>([])
const serverPrompts = ref<McpPrompt[]>([])

// 表单数据
const formData = ref<Partial<McpServerConfig>>({
  name: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: '',
  headers: {}
})

// 用于编辑 args 和 env 的辅助字段
const argsText = ref('')
const envText = ref('')

// 模板类型
interface McpTemplate {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  args: string[]
  env?: Record<string, string>
}

// 获取预设模板
const getTemplates = (): McpTemplate[] => [
  {
    name: t('mcpSettings.templates.filesystem'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir']
  },
  {
    name: t('mcpSettings.templates.github'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: t('mcpSettings.placeholders.githubToken') }
  },
  {
    name: t('mcpSettings.templates.postgres'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb']
  },
  {
    name: t('mcpSettings.templates.sqlite'),
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '/path/to/database.db']
  }
]

const templates = computed(() => getTemplates())

// 计算属性
const connectedCount = computed(() => {
  return serverStatuses.value.filter(s => s.connected).length
})

// 加载服务器配置
const loadServers = async () => {
  servers.value = await window.electronAPI.mcp.getServers()
  await refreshStatuses()
}

// 刷新连接状态
const refreshStatuses = async () => {
  serverStatuses.value = await window.electronAPI.mcp.getServerStatuses()
}

// 获取服务器状态
const getServerStatus = (serverId: string): McpServerStatus | undefined => {
  return serverStatuses.value.find(s => s.id === serverId)
}

// 重置表单
const resetForm = () => {
  formData.value = {
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: '',
    headers: {}
  }
  argsText.value = ''
  envText.value = ''
  editingServer.value = null
  testResult.value = null
}

// 打开新建表单
const openNewServer = () => {
  resetForm()
  showForm.value = true
}

// 打开编辑表单
const openEditServer = (server: McpServerConfig) => {
  editingServer.value = server
  formData.value = { ...server }
  argsText.value = (server.args || []).join('\n')
  envText.value = Object.entries(server.env || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  testResult.value = null
  showForm.value = true
}

// 应用模板
const applyTemplate = (template: McpTemplate) => {
  formData.value.name = template.name
  formData.value.transport = template.transport
  formData.value.command = template.command
  formData.value.args = [...template.args]
  formData.value.env = template.env ? { ...template.env } : {}
  argsText.value = template.args.join('\n')
  envText.value = template.env
    ? Object.entries(template.env).map(([k, v]) => `${k}=${v}`).join('\n')
    : ''
}

// 解析 args 文本
const parseArgs = () => {
  formData.value.args = argsText.value
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// 解析 env 文本
const parseEnv = () => {
  const env: Record<string, string> = {}
  envText.value.split('\n').forEach(line => {
    const trimmed = line.trim()
    if (trimmed && trimmed.includes('=')) {
      const [key, ...valueParts] = trimmed.split('=')
      env[key.trim()] = valueParts.join('=').trim()
    }
  })
  formData.value.env = env
}

// 测试连接
const testConnection = async () => {
  if (!formData.value.name) {
    testResult.value = { success: false, message: t('mcpSettings.pleaseInputServerName') }
    return
  }

  parseArgs()
  parseEnv()

  // 使用 toRaw 转换响应式对象，避免 IPC 克隆错误
  const testConfig: McpServerConfig = {
    id: editingServer.value?.id || `test_${Date.now()}`,
    name: formData.value.name,
    enabled: true,
    transport: formData.value.transport || 'stdio',
    command: formData.value.command,
    args: toRaw(formData.value.args) || [],
    env: toRaw(formData.value.env) || {},
    cwd: formData.value.cwd,
    url: formData.value.url,
    headers: toRaw(formData.value.headers) || {}
  }

  testing.value = true
  testResult.value = null

  try {
    const result = await window.electronAPI.mcp.testConnection(testConfig)
    if (result.success) {
      testResult.value = {
        success: true,
        message: t('mcpSettings.connectionSuccess', { tools: result.toolCount, resources: result.resourceCount, prompts: result.promptCount })
      }
    } else {
      testResult.value = { success: false, message: result.error || t('mcpSettings.connectionFailed') }
    }
  } catch (error) {
    testResult.value = {
      success: false,
      message: error instanceof Error ? error.message : t('mcpSettings.testFailed')
    }
  } finally {
    testing.value = false
  }
}

// 保存服务器
const saveServer = async () => {
  if (!formData.value.name) return

  parseArgs()
  parseEnv()

  // 使用 toRaw 转换响应式对象，避免 IPC 克隆错误
  const rawArgs = toRaw(formData.value.args) || []
  const rawEnv = toRaw(formData.value.env) || {}
  const rawHeaders = toRaw(formData.value.headers) || {}

  const server: McpServerConfig = {
    id: editingServer.value?.id || uuidv4(),
    name: formData.value.name,
    enabled: formData.value.enabled ?? true,
    transport: formData.value.transport || 'stdio',
    command: formData.value.command,
    args: rawArgs,
    env: Object.keys(rawEnv).length > 0 ? rawEnv : undefined,
    cwd: formData.value.cwd || undefined,
    url: formData.value.url,
    headers: Object.keys(rawHeaders).length > 0 ? rawHeaders : undefined
  }

  if (editingServer.value) {
    await window.electronAPI.mcp.updateServer(server)
  } else {
    await window.electronAPI.mcp.addServer(server)
  }

  await loadServers()
  showForm.value = false
  resetForm()
}

// 删除服务器
const deleteServer = async (server: McpServerConfig) => {
  if (confirm(t('mcpSettings.confirmDelete', { name: server.name }))) {
    await window.electronAPI.mcp.deleteServer(server.id)
    await loadServers()
  }
}

// 切换启用状态
const toggleEnabled = async (server: McpServerConfig) => {
  // 深拷贝避免 IPC 克隆错误
  const updated = JSON.parse(JSON.stringify({ ...server, enabled: !server.enabled }))
  await window.electronAPI.mcp.updateServer(updated)
  
  // 如果禁用，断开连接
  if (!updated.enabled) {
    await window.electronAPI.mcp.disconnect(server.id)
  }
  
  await loadServers()
}

// 连接服务器
const connectServer = async (server: McpServerConfig) => {
  connecting.value = server.id
  try {
    // 深拷贝避免 IPC 克隆错误
    const plainServer = JSON.parse(JSON.stringify(server))
    const result = await window.electronAPI.mcp.connect(plainServer)
    if (!result.success) {
      alert(`${t('mcpSettings.connectFailed')}: ${result.error}`)
    }
  } catch (error) {
    alert(`${t('mcpSettings.connectFailed')}: ${error instanceof Error ? error.message : t('common.unknown')}`)
  } finally {
    connecting.value = null
    await refreshStatuses()
  }
}

// 断开服务器
const disconnectServer = async (server: McpServerConfig) => {
  await window.electronAPI.mcp.disconnect(server.id)
  await refreshStatuses()
}

// 查看服务器详情
const viewServerDetails = async (server: McpServerConfig) => {
  selectedServer.value = server
  
  // 获取工具/资源/提示
  const allTools = await window.electronAPI.mcp.getAllTools()
  const allResources = await window.electronAPI.mcp.getAllResources()
  const allPrompts = await window.electronAPI.mcp.getAllPrompts()
  
  serverTools.value = allTools.filter(t => t.serverId === server.id)
  serverResources.value = allResources.filter(r => r.serverId === server.id)
  serverPrompts.value = allPrompts.filter(p => p.serverId === server.id)
  
  showDetails.value = true
}

// 连接所有启用的服务器
const connectAllEnabled = async () => {
  const results = await window.electronAPI.mcp.connectEnabledServers()
  const failed = results.filter(r => !r.success)
  if (failed.length > 0) {
    alert(`${t('mcpSettings.partialConnectFailed')}:\n${failed.map(f => `${f.id}: ${f.error}`).join('\n')}`)
  }
  await refreshStatuses()
}

// 事件监听清理函数
let unsubConnected: (() => void) | null = null
let unsubDisconnected: (() => void) | null = null
let unsubError: (() => void) | null = null

onMounted(async () => {
  await loadServers()
  
  // 订阅 MCP 事件
  unsubConnected = window.electronAPI.mcp.onConnected(async () => {
    await refreshStatuses()
  })
  
  unsubDisconnected = window.electronAPI.mcp.onDisconnected(async () => {
    await refreshStatuses()
  })
  
  unsubError = window.electronAPI.mcp.onError(async (data) => {
    console.error('MCP Error:', data)
    await refreshStatuses()
  })
})

onUnmounted(() => {
  unsubConnected?.()
  unsubDisconnected?.()
  unsubError?.()
})
</script>

<template>
  <div class="mcp-settings">
    <div class="settings-section">
      <div class="section-header">
        <div class="header-left">
          <h4>{{ t('mcpSettings.title') }}</h4>
          <span class="connection-badge" v-if="connectedCount > 0">
            {{ connectedCount }} {{ t('mcpSettings.connected') }}
          </span>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" @click="connectAllEnabled" v-if="servers.some(s => s.enabled)">
            {{ t('common.connect') }}
          </button>
          <button class="btn btn-primary btn-sm" @click="openNewServer">
            <Plus :size="14" />
            {{ t('mcpSettings.addServer') }}
          </button>
        </div>
      </div>
      <p class="section-desc">
        {{ t('mcpSettings.description') }}
      </p>

      <!-- 服务器列表 -->
      <div class="server-list">
        <div
          v-for="server in servers"
          :key="server.id"
          class="server-item"
          :class="{ 
            disabled: !server.enabled,
            connected: getServerStatus(server.id)?.connected 
          }"
        >
          <div class="server-toggle">
            <input
              type="checkbox"
              :checked="server.enabled"
              @change="toggleEnabled(server)"
              :title="t('mcpSettings.toggleEnable')"
            />
          </div>
          <div class="server-info" @click="server.enabled && viewServerDetails(server)">
            <div class="server-name">
              {{ server.name }}
              <span class="server-status" v-if="getServerStatus(server.id)?.connected">
                ● {{ t('mcpSettings.connected') }}
              </span>
            </div>
            <div class="server-detail">
              {{ server.transport === 'stdio' ? server.command : server.url }}
              <template v-if="getServerStatus(server.id)?.connected">
                · {{ t('mcpSettings.toolsCount', { count: getServerStatus(server.id)?.toolCount }) }}
              </template>
            </div>
          </div>
          <div class="server-actions">
            <template v-if="server.enabled">
              <button 
                v-if="!getServerStatus(server.id)?.connected"
                class="btn-icon btn-sm" 
                @click="connectServer(server)"
                :disabled="connecting === server.id"
                :title="t('common.connect')"
              >
                <Play v-if="connecting !== server.id" :size="14" />
                <span v-else class="spinner"></span>
              </button>
              <button 
                v-else
                class="btn-icon btn-sm" 
                @click="disconnectServer(server)"
                :title="t('common.disconnect')"
              >
                <Pause :size="14" />
              </button>
            </template>
            <button class="btn-icon btn-sm" @click="openEditServer(server)" :title="t('common.edit')">
              <Pencil :size="14" />
            </button>
            <button class="btn-icon btn-sm" @click="deleteServer(server)" :title="t('common.delete')">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
        <div v-if="servers.length === 0" class="empty-servers">
          <p>{{ t('mcpSettings.noServers') }}</p>
          <p class="tip">{{ t('mcpSettings.addServer') }}</p>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单 -->
    <div v-if="showForm" class="server-form">
      <div class="form-header">
        <h4>{{ editingServer ? t('mcpSettings.editServer') : t('mcpSettings.addServer') }}</h4>
        <button class="btn-icon" @click="showForm = false" :title="t('common.close')">
          <X :size="16" />
        </button>
      </div>

      <!-- 快速模板 -->
      <div class="templates" v-if="!editingServer">
        <span class="template-label">{{ t('mcpSettings.quickFill') }}</span>
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
          <label class="form-label">{{ t('mcpSettings.serverName') }} *</label>
          <input v-model="formData.name" type="text" class="input" :placeholder="t('mcpSettings.serverNamePlaceholder2')" />
        </div>

        <div class="form-group">
          <label class="form-label">{{ t('mcpSettings.transport') }}</label>
          <div class="transport-select">
            <label class="radio-item">
              <input type="radio" v-model="formData.transport" value="stdio" />
              <span>{{ t('mcpSettings.transportStdioLabel') }}</span>
            </label>
            <label class="radio-item">
              <input type="radio" v-model="formData.transport" value="sse" />
              <span>{{ t('mcpSettings.transportSseLabel') }}</span>
            </label>
          </div>
        </div>

        <template v-if="formData.transport === 'stdio'">
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.command') }} *</label>
            <input v-model="formData.command" type="text" class="input" :placeholder="t('mcpSettings.commandPlaceholder2')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.argsPerLine') }}</label>
            <textarea v-model="argsText" class="input textarea" placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/dir" rows="3"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.envPerLine') }}</label>
            <textarea v-model="envText" class="input textarea" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxxx&#10;API_KEY=sk-xxxx" rows="2"></textarea>
            <span class="form-hint">{{ t('mcpSettings.envHint') }}</span>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.workingDir') }}</label>
            <input v-model="formData.cwd" type="text" class="input" :placeholder="t('mcpSettings.workingDirPlaceholder')" />
          </div>
        </template>

        <template v-else>
          <div class="form-group">
            <label class="form-label">{{ t('mcpSettings.sseUrl') }} *</label>
            <input v-model="formData.url" type="text" class="input" :placeholder="t('mcpSettings.urlPlaceholder')" />
          </div>
        </template>

        <!-- 测试结果 -->
        <div v-if="testResult" class="test-result" :class="{ success: testResult.success, error: !testResult.success }">
          {{ testResult.message }}
        </div>
      </div>

      <div class="form-footer">
        <button class="btn" @click="testConnection" :disabled="testing">
          {{ testing ? t('mcpSettings.testing') : t('mcpSettings.testConnection') }}
        </button>
        <div class="form-footer-right">
          <button class="btn" @click="showForm = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="saveServer">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 服务器详情弹窗 -->
    <div v-if="showDetails && selectedServer" class="details-modal" @click.self="showDetails = false">
      <div class="details-content">
        <div class="details-header">
          <h4>{{ selectedServer.name }}</h4>
          <button class="btn-icon" @click="showDetails = false">
            <X :size="16" />
          </button>
        </div>
        <div class="details-body">
          <!-- 工具列表 -->
          <div class="details-section">
            <h5>{{ t('mcpSettings.tools') }} ({{ serverTools.length }})</h5>
            <div v-if="serverTools.length > 0" class="details-list">
              <div v-for="tool in serverTools" :key="tool.name" class="details-item">
                <div class="item-name">{{ tool.name }}</div>
                <div class="item-desc">{{ tool.description }}</div>
              </div>
            </div>
            <div v-else class="empty-list">{{ t('mcpSettings.noToolsAvailable') }}</div>
          </div>

          <!-- 资源列表 -->
          <div class="details-section">
            <h5>{{ t('mcpSettings.resources') }} ({{ serverResources.length }})</h5>
            <div v-if="serverResources.length > 0" class="details-list">
              <div v-for="resource in serverResources" :key="resource.uri" class="details-item">
                <div class="item-name">{{ resource.name }}</div>
                <div class="item-desc">{{ resource.uri }}</div>
              </div>
            </div>
            <div v-else class="empty-list">{{ t('mcpSettings.noResources') }}</div>
          </div>

          <!-- 提示模板列表 -->
          <div class="details-section">
            <h5>{{ t('mcpSettings.prompts') }} ({{ serverPrompts.length }})</h5>
            <div v-if="serverPrompts.length > 0" class="details-list">
              <div v-for="prompt in serverPrompts" :key="prompt.name" class="details-item">
                <div class="item-name">{{ prompt.name }}</div>
                <div class="item-desc">{{ prompt.description }}</div>
              </div>
            </div>
            <div v-else class="empty-list">{{ t('mcpSettings.noPrompts') }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mcp-settings {
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

.connection-badge {
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

/* 服务器列表 */
.server-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.server-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.server-item:hover {
  border-color: var(--accent-primary);
}

.server-item.disabled {
  opacity: 0.5;
}

.server-item.connected {
  border-color: var(--accent-green);
}

.server-toggle input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.server-info {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.server-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.server-status {
  font-size: 11px;
  color: var(--accent-green);
}

.server-detail {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.server-actions {
  display: flex;
  gap: 4px;
}

.empty-servers {
  padding: 30px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-servers .tip {
  font-size: 12px;
  margin-top: 8px;
}

/* 表单 */
.server-form {
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

.form-body {
  padding: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.input {
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
}

.input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.textarea {
  font-family: var(--font-mono);
  resize: vertical;
  min-height: 60px;
}

.transport-select {
  display: flex;
  gap: 16px;
}

.radio-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.radio-item input {
  cursor: pointer;
}

.test-result {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 6px;
  font-size: 12px;
}

.test-result.success {
  background: rgba(166, 227, 161, 0.1);
  color: var(--accent-green);
  border: 1px solid var(--accent-green);
}

.test-result.error {
  background: rgba(243, 139, 168, 0.1);
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
}

.form-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

.form-footer-right {
  display: flex;
  gap: 8px;
}

/* 详情弹窗 */
.details-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.details-content {
  width: 500px;
  max-width: 90vw;
  max-height: 70vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.details-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.details-header h4 {
  font-size: 16px;
  font-weight: 600;
}

.details-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.details-section {
  margin-bottom: 20px;
}

.details-section:last-child {
  margin-bottom: 0;
}

.details-section h5 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.details-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.details-item {
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
}

.item-name {
  font-size: 13px;
  font-weight: 500;
  font-family: var(--font-mono);
  color: var(--accent-primary);
}

.item-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

.empty-list {
  font-size: 12px;
  color: var(--text-muted);
  padding: 12px;
  text-align: center;
  background: var(--bg-tertiary);
  border-radius: 6px;
}

/* 加载动画 */
.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
