<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import KnowledgeManager from '../KnowledgeManager.vue'

const { t } = useI18n()

const api = window.electronAPI as any

interface KnowledgeSettings {
  enabled: boolean
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | 'lite' | 'standard' | 'large'
  embeddingMcpServerId?: string
  autoSaveUploads: boolean
  chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
  searchTopK: number
  enableRerank: boolean
  enableHostMemory: boolean
  mcpKnowledgeServerId?: string
}

interface McpServerStatus {
  id: string
  name: string
  connected: boolean
}

interface KnowledgeDocument {
  id: string
  filename: string
  content: string
  fileSize: number
  fileType: string
  hostId?: string
  chunkCount: number
  createdAt: number
}

const settings = ref<KnowledgeSettings>({
  enabled: true,
  embeddingMode: 'local',
  localModel: 'lite',
  autoSaveUploads: true,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true,
  enableHostMemory: true
})

const mcpServers = ref<McpServerStatus[]>([])
const documents = ref<KnowledgeDocument[]>([])
const loading = ref(true)
const saving = ref(false)
const showDocManager = ref(false)

const isKnowledgeInitialized = ref(false)

const loadSettings = async () => {
  try {
    loading.value = true
    
    isKnowledgeInitialized.value = await api.knowledge.isInitialized()
    
    settings.value = await api.knowledge.getSettings()
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    mcpServers.value = await api.mcp.getServerStatuses()
    
    if (settings.value.enabled) {
      await loadDocuments()
    }
  } catch (error) {
    console.error('加载设置失败:', error)
  } finally {
    loading.value = false
  }
}

let unsubscribeKnowledgeReady: (() => void) | null = null

const loadDocuments = async () => {
  try {
    documents.value = await api.knowledge.getDocuments() || []
  } catch (error) {
    console.error('加载文档列表失败:', error)
  }
}

const saveSettings = async () => {
  try {
    saving.value = true
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    const plainSettings = JSON.parse(JSON.stringify(settings.value))
    
    const result = await api.knowledge.updateSettings(plainSettings)
    if (!result.success) {
      console.error('保存设置失败:', result.error)
    }
    
    if (settings.value.enabled) {
      await loadDocuments()
    }
  } catch (error) {
    console.error('保存设置异常:', error)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  loadSettings()
  
  unsubscribeKnowledgeReady = api.knowledge.onReady(() => {
    isKnowledgeInitialized.value = true
    loadSettings()
  })
})

onUnmounted(() => {
  unsubscribeKnowledgeReady?.()
})
</script>

<template>
  <div class="knowledge-settings">
    <div v-if="loading" class="loading">
      {{ t('common.loading') }}
    </div>
    
    <template v-else>
      <!-- 初始化状态提示 -->
      <div v-if="settings.enabled && !isKnowledgeInitialized" class="init-status">
        <Loader2 class="spinner" :size="16" />
        <span>{{ t('knowledgeSettings.initializing') }}</span>
      </div>

      <!-- 启用开关 -->
      <div class="setting-group">
        <div class="setting-row">
          <div class="setting-info">
            <label class="setting-label">{{ t('knowledgeSettings.enable') }}</label>
            <p class="setting-desc">{{ t('knowledgeSettings.enableHint') }}</p>
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
        <!-- 文档管理 -->
        <div class="setting-group">
          <div class="doc-summary">
            <span class="doc-stat">
              📄 {{ t('knowledgeSettings.docCount', { count: documents.length }) }}
            </span>
            <button class="btn btn-sm" @click="showDocManager = true; loadDocuments()">
              {{ t('knowledgeSettings.manageDoc') }}
            </button>
          </div>
        </div>

        <!-- 自动入库设置 -->
        <div class="setting-group">
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">{{ t('knowledgeSettings.autoSaveUploads') }}</label>
              <p class="setting-desc">{{ t('knowledgeSettings.autoSaveUploadsDesc') }}</p>
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
              <label class="setting-label">{{ t('knowledgeSettings.enableHostMemory') }}</label>
              <p class="setting-desc">{{ t('knowledgeSettings.enableHostMemoryDesc') }}</p>
            </div>
            <label class="switch">
              <input 
                type="checkbox" 
                v-model="settings.enableHostMemory"
                @change="saveSettings"
              />
              <span class="slider"></span>
            </label>
          </div>
        </div>

        <!-- MCP 知识库 -->
        <div class="setting-group">
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">{{ t('knowledgeSettings.mcpKnowledgeService') }}</label>
              <p class="setting-desc">{{ t('knowledgeSettings.mcpKnowledgeDesc') }}</p>
            </div>
            <select 
              v-model="settings.mcpKnowledgeServerId" 
              class="select"
              @change="saveSettings"
            >
              <option value="">{{ t('knowledgeSettings.notUse') }}</option>
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
      </template>
    </template>

    <!-- 文档管理弹窗 -->
    <KnowledgeManager v-if="showDocManager" @close="showDocManager = false" />
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

.init-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.init-status .spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.setting-group {
  margin-bottom: 24px;
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

.doc-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.doc-stat {
  font-size: 13px;
  color: var(--text-secondary);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn:hover {
  background: var(--bg-hover);
}

.btn-sm {
  padding: 6px 12px;
  font-size: 12px;
}
</style>
