<script setup lang="ts">
import { ref, onMounted } from 'vue'

// 获取 API（类型在 preload 中定义）
const api = window.electronAPI as any

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
  localModel: 'lite', // 固定使用轻量模型
  autoSaveUploads: false,
  maxChunkSize: 512,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true
})

const mcpServers = ref<McpServerStatus[]>([])
const loading = ref(true)
const saving = ref(false)

// 加载设置
const loadSettings = async () => {
  try {
    loading.value = true
    
    // 获取知识库设置
    settings.value = await api.knowledge.getSettings()
    // 强制使用轻量模型
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    // 获取 MCP 服务器状态
    mcpServers.value = await api.mcp.getServerStatuses()
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
    // 强制使用轻量模型
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    // 转换为普通对象（Vue 响应式对象不能直接通过 IPC 发送）
    const plainSettings = JSON.parse(JSON.stringify(settings.value))
    
    const result = await api.knowledge.updateSettings(plainSettings)
    if (!result.success) {
      console.error('保存设置失败:', result.error)
    }
  } catch (error) {
    console.error('保存设置异常:', error)
  } finally {
    saving.value = false
  }
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
        <!-- 向量嵌入说明 -->
        <div class="setting-group">
          <h4 class="group-title">向量嵌入</h4>
          
          <div class="info-box">
            <span class="info-icon">📦</span>
            <div class="info-content">
              <p class="info-title">使用内置轻量模型</p>
              <p class="info-desc">采用 all-MiniLM-L6-v2 模型（21MB），已随软件打包，无需额外下载</p>
            </div>
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
              <p class="setting-desc">每个分块的最大 token 数（128-4096）</p>
            </div>
            <input 
              type="number" 
              v-model.number="settings.maxChunkSize" 
              class="input input-sm"
              min="128"
              max="4096"
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

/* 信息框 */
.info-box {
  display: flex;
  gap: 12px;
  padding: 14px;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(59, 130, 246, 0.1));
  border: 1px solid rgba(16, 185, 129, 0.2);
  border-radius: 8px;
}

.info-icon {
  font-size: 24px;
}

.info-content {
  flex: 1;
}

.info-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.info-desc {
  font-size: 12px;
  color: var(--text-secondary);
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
</style>
