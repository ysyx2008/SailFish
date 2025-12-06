<script setup lang="ts">
import { ref, onMounted } from 'vue'

interface ModelInfo {
  id: 'lite' | 'standard' | 'large'
  name: string
  huggingfaceId: string
  size: number
  dimensions: number
  bundled: boolean
}

interface ModelStatus {
  id: 'lite' | 'standard' | 'large'
  available: boolean
  downloading: boolean
  progress?: number
  error?: string
}

interface KnowledgeSettings {
  enabled: boolean
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | 'lite' | 'standard' | 'large'
  embeddingMcpServerId?: string
  autoSaveUploads: boolean
  maxChunkSize: number
  chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
  searchTopK: number
  enableRerank: boolean
  mcpKnowledgeServerId?: string
}

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
}

const settings = ref<KnowledgeSettings>({
  enabled: false,
  embeddingMode: 'local',
  localModel: 'auto',
  autoSaveUploads: false,
  maxChunkSize: 512,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true
})

const models = ref<ModelInfo[]>([])
const modelStatuses = ref<ModelStatus[]>([])
const mcpServers = ref<McpServerStatus[]>([])
const loading = ref(true)
const saving = ref(false)
const downloadingModel = ref<string | null>(null)
const downloadProgress = ref(0)

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

// 获取模型状态
const getModelStatus = (id: string): ModelStatus | undefined => {
  return modelStatuses.value.find(s => s.id === id)
}

// 模型描述
const modelDescriptions: Record<string, string> = {
  lite: '轻量快速，适合低配电脑',
  standard: '中文优化，平衡性能',
  large: '精度最高，适合高配电脑'
}

// 加载设置
const loadSettings = async () => {
  try {
    loading.value = true
    
    // 获取知识库设置
    settings.value = await window.electronAPI.knowledge.getSettings()
    
    // 获取模型列表
    models.value = await window.electronAPI.knowledge.getModels()
    
    // 获取模型状态
    modelStatuses.value = await window.electronAPI.knowledge.getModelStatuses()
    
    // 获取 MCP 服务器状态
    mcpServers.value = await window.electronAPI.mcp.getServerStatuses()
  } catch (error) {
    console.error('加载设置失败:', error)
  } finally {
    loading.value = false
  }
}

// 保存设置
const saveSettings = async () => {
  try {
    saving.value = true
    await window.electronAPI.knowledge.updateSettings(settings.value)
  } catch (error) {
    console.error('保存设置失败:', error)
  } finally {
    saving.value = false
  }
}

// 下载模型
const downloadModel = async (modelId: 'lite' | 'standard' | 'large') => {
  try {
    downloadingModel.value = modelId
    downloadProgress.value = 0
    
    // 监听下载进度
    const unsubscribe = window.electronAPI.knowledge.onDownloadProgress((data) => {
      if (data.modelId === modelId) {
        downloadProgress.value = data.percent
      }
    })
    
    const result = await window.electronAPI.knowledge.downloadModel(modelId)
    
    unsubscribe()
    
    if (result.success) {
      // 刷新模型状态
      modelStatuses.value = await window.electronAPI.knowledge.getModelStatuses()
    } else {
      alert(`下载失败: ${result.error}`)
    }
  } catch (error) {
    console.error('下载模型失败:', error)
  } finally {
    downloadingModel.value = null
    downloadProgress.value = 0
  }
}

// 切换模型
const switchModel = async (modelId: 'lite' | 'standard' | 'large') => {
  const status = getModelStatus(modelId)
  if (!status?.available) {
    alert('请先下载该模型')
    return
  }
  
  settings.value.localModel = modelId
  await saveSettings()
}

onMounted(() => {
  loadSettings()
})
</script>

<template>
  <div class="knowledge-settings">
    <div v-if="loading" class="loading">
      加载中...
    </div>
    
    <template v-else>
      <!-- 启用开关 -->
      <div class="setting-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">启用知识库</label>
            <p class="setting-desc">开启后可将文档存储到本地知识库，AI 对话时自动检索相关内容</p>
          </div>
          <label class="switch">
            <input 
              type="checkbox" 
              v-model="settings.enabled"
              @change="saveSettings"
            />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <template v-if="settings.enabled">
        <!-- Embedding 模式 -->
        <div class="setting-group">
          <h4 class="group-title">向量嵌入</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">嵌入模式</label>
              <p class="setting-desc">选择使用本地模型或 MCP 服务生成向量</p>
            </div>
            <select 
              v-model="settings.embeddingMode" 
              class="select"
              @change="saveSettings"
            >
              <option value="local">本地模型</option>
              <option value="mcp">MCP 服务</option>
            </select>
          </div>

          <!-- 本地模型选择 -->
          <div v-if="settings.embeddingMode === 'local'" class="models-section">
            <div class="setting-row">
              <div class="setting-info">
                <label class="setting-label">模型选择</label>
                <p class="setting-desc">自动模式会根据系统配置选择最佳模型</p>
              </div>
              <select 
                v-model="settings.localModel" 
                class="select"
                @change="saveSettings"
              >
                <option value="auto">自动选择</option>
                <option value="lite">轻量模型</option>
                <option value="standard">标准模型</option>
                <option value="large">高精模型</option>
              </select>
            </div>

            <div class="model-cards">
              <div 
                v-for="model in models" 
                :key="model.id"
                class="model-card"
                :class="{ 
                  active: settings.localModel === model.id,
                  available: getModelStatus(model.id)?.available
                }"
              >
                <div class="model-header">
                  <span class="model-name">{{ model.name }}</span>
                  <span v-if="model.bundled" class="model-badge bundled">已打包</span>
                  <span v-else-if="getModelStatus(model.id)?.available" class="model-badge available">已下载</span>
                  <span v-else class="model-badge">需下载</span>
                </div>
                <div class="model-info">
                  <span>{{ formatSize(model.size) }}</span>
                  <span>{{ model.dimensions }} 维</span>
                </div>
                <p class="model-desc">{{ modelDescriptions[model.id] }}</p>
                <div class="model-actions">
                  <template v-if="getModelStatus(model.id)?.available">
                    <button 
                      class="btn btn-sm"
                      :class="{ 'btn-primary': settings.localModel === model.id }"
                      @click="switchModel(model.id)"
                      :disabled="settings.localModel === model.id"
                    >
                      {{ settings.localModel === model.id ? '使用中' : '使用' }}
                    </button>
                  </template>
                  <template v-else-if="downloadingModel === model.id">
                    <div class="download-progress">
                      <div class="progress-bar">
                        <div class="progress-fill" :style="{ width: `${downloadProgress}%` }"></div>
                      </div>
                      <span class="progress-text">{{ downloadProgress.toFixed(0) }}%</span>
                    </div>
                  </template>
                  <template v-else>
                    <button 
                      class="btn btn-sm btn-outline"
                      @click="downloadModel(model.id)"
                    >
                      下载
                    </button>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <!-- MCP Embedding 服务选择 -->
          <div v-if="settings.embeddingMode === 'mcp'" class="setting-row">
            <div class="setting-info">
              <label class="setting-label">Embedding 服务</label>
              <p class="setting-desc">选择提供向量嵌入功能的 MCP 服务器</p>
            </div>
            <select 
              v-model="settings.embeddingMcpServerId" 
              class="select"
              @change="saveSettings"
            >
              <option value="">未选择</option>
              <option 
                v-for="server in mcpServers.filter(s => s.connected)" 
                :key="server.id"
                :value="server.id"
              >
                {{ server.name }}
              </option>
            </select>
          </div>
        </div>

        <!-- MCP 知识库 -->
        <div class="setting-group">
          <h4 class="group-title">外部知识库</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">MCP 知识库服务</label>
              <p class="setting-desc">可选接入外部知识库 MCP 服务，与本地知识库协同搜索</p>
            </div>
            <select 
              v-model="settings.mcpKnowledgeServerId" 
              class="select"
              @change="saveSettings"
            >
              <option value="">不使用</option>
              <option 
                v-for="server in mcpServers.filter(s => s.connected)" 
                :key="server.id"
                :value="server.id"
              >
                {{ server.name }}
              </option>
            </select>
          </div>
        </div>

        <!-- 搜索设置 -->
        <div class="setting-group">
          <h4 class="group-title">搜索设置</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">返回结果数</label>
              <p class="setting-desc">每次搜索返回的最大结果数量</p>
            </div>
            <input 
              type="number" 
              v-model.number="settings.searchTopK" 
              class="input input-sm"
              min="1"
              max="50"
              @change="saveSettings"
            />
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">启用重排序</label>
              <p class="setting-desc">使用 LLM 对搜索结果进行重新排序，提高准确性</p>
            </div>
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="settings.enableRerank"
                @change="saveSettings"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- 文档处理 -->
        <div class="setting-group">
          <h4 class="group-title">文档处理</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">自动保存上传文档</label>
              <p class="setting-desc">上传的文档自动保存到知识库</p>
            </div>
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="settings.autoSaveUploads"
                @change="saveSettings"
              />
              <span class="slider"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">分块策略</label>
              <p class="setting-desc">长文档的切分方式</p>
            </div>
            <select 
              v-model="settings.chunkStrategy" 
              class="select"
              @change="saveSettings"
            >
              <option value="paragraph">按段落</option>
              <option value="semantic">语义分块</option>
              <option value="fixed">固定大小</option>
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">最大分块大小</label>
              <p class="setting-desc">每个分块的最大 token 数</p>
            </div>
            <input 
              type="number" 
              v-model.number="settings.maxChunkSize" 
              class="input input-sm"
              min="128"
              max="2048"
              step="64"
              @change="saveSettings"
            />
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.knowledge-settings {
  width: 100%;
}

.loading {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.setting-group {
  margin-bottom: 24px;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 20px;
  align-items: start;
  padding: 12px 0;
}

.setting-info {
  min-width: 200px;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.setting-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.5;
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

.select {
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  min-width: 140px;
}

.input {
  padding: 8px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  width: 80px;
}

.input-sm {
  width: 80px;
}

/* 模型卡片 */
.models-section {
  margin-top: 8px;
}

.model-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-top: 10px;
}

.model-card {
  padding: 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s;
}

.model-card.active {
  border-color: var(--accent-primary);
  background: var(--bg-hover);
}

.model-card.available {
  opacity: 1;
}

.model-card:not(.available) {
  opacity: 0.7;
}

.model-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  gap: 6px;
}

.model-name {
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.model-badge {
  font-size: 9px;
  padding: 2px 5px;
  border-radius: 3px;
  background: var(--bg-secondary);
  color: var(--text-muted);
  white-space: nowrap;
}

.model-badge.bundled {
  background: var(--accent-primary);
  color: white;
}

.model-badge.available {
  background: var(--success-color, #10b981);
  color: white;
}

.model-info {
  display: flex;
  gap: 8px;
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 6px;
}

.model-desc {
  font-size: 10px;
  color: var(--text-secondary);
  margin: 0 0 8px;
  line-height: 1.3;
}

.model-actions {
  display: flex;
  justify-content: flex-end;
}

.btn {
  padding: 5px 10px;
  font-size: 11px;
  border-radius: 4px;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.btn-sm {
  padding: 4px 8px;
}

.btn-primary {
  background: var(--accent-primary);
  color: white;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.btn-outline:hover {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 下载进度 */
.download-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.progress-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-secondary);
  border-radius: 2px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s;
}

.progress-text {
  font-size: 10px;
  color: var(--text-muted);
  min-width: 30px;
}
</style>

