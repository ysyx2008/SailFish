<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2 } from 'lucide-vue-next'
import KnowledgeManager from '../KnowledgeManager.vue'

const { t } = useI18n()

// 获取 API（类型在 preload 中定义）
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
  enabled: false,
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

// 知识库初始化状态
const isKnowledgeInitialized = ref(false)

// 密码相关状态
const passwordInfo = ref<{ hasPassword: boolean; isUnlocked: boolean; createdAt?: number }>({
  hasPassword: false,
  isUnlocked: false
})
const showPasswordDialog = ref(false)
const passwordDialogMode = ref<'set' | 'verify' | 'change' | 'clear'>('set')
const passwordInput = ref('')
const newPasswordInput = ref('')
const confirmPasswordInput = ref('')
const passwordError = ref('')
const passwordLoading = ref(false)


// 加载设置
const loadSettings = async () => {
  try {
    loading.value = true
    
    // 检查知识库初始化状态
    isKnowledgeInitialized.value = await api.knowledge.isInitialized()
    
    // 获取知识库设置
    settings.value = await api.knowledge.getSettings()
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    
    // 获取 MCP 服务器状态
    mcpServers.value = await api.mcp.getServerStatuses()
    
    // 获取文档列表
    if (settings.value.enabled) {
      await loadDocuments()
    }
  } catch (error) {
    console.error('加载设置失败:', error)
  } finally {
    loading.value = false
  }
}

// 监听知识库就绪事件
let unsubscribeKnowledgeReady: (() => void) | null = null

// 加载文档列表
const loadDocuments = async () => {
  try {
    documents.value = await api.knowledge.getDocuments() || []
  } catch (error) {
    console.error('加载文档列表失败:', error)
  }
}

// 保存设置
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
    
    // 如果启用了知识库，加载文档列表
    if (settings.value.enabled) {
      await loadDocuments()
    }
  } catch (error) {
    console.error('保存设置异常:', error)
  } finally {
    saving.value = false
  }
}

// 加载密码状态
const loadPasswordInfo = async () => {
  try {
    passwordInfo.value = await api.knowledge.getPasswordInfo()
  } catch (error) {
    console.error('加载密码状态失败:', error)
  }
}

// 是否正在启用知识库（用于密码设置流程）
const pendingEnable = ref(false)

// 处理启用开关变化
const handleEnableChange = async () => {
  // 如果是要启用知识库
  if (settings.value.enabled) {
    // 如果还没有设置密码，先弹出密码设置对话框
    if (!passwordInfo.value.hasPassword) {
      pendingEnable.value = true
      openPasswordDialog('set')
      // 暂时恢复为未启用状态，等密码设置成功后再启用
      settings.value.enabled = false
      return
    }
    // 如果已有密码但未解锁，需要验证密码才能启用
    if (passwordInfo.value.hasPassword && !passwordInfo.value.isUnlocked) {
      pendingEnable.value = true
      openPasswordDialog('verify')
      // 暂时恢复为未启用状态，等密码验证成功后再启用
      settings.value.enabled = false
      return
    }
  }
  // 直接保存设置（禁用知识库或已有密码且已解锁）
  await saveSettings()
}

// 打开密码对话框
const openPasswordDialog = (mode: 'set' | 'verify' | 'change' | 'clear') => {
  passwordDialogMode.value = mode
  passwordInput.value = ''
  newPasswordInput.value = ''
  confirmPasswordInput.value = ''
  passwordError.value = ''
  showPasswordDialog.value = true
}

// 关闭密码对话框
const closePasswordDialog = () => {
  showPasswordDialog.value = false
  // 如果是启用流程中取消了，清除 pending 状态
  if (pendingEnable.value) {
    pendingEnable.value = false
  }
}

// 处理密码提交
const handlePasswordSubmit = async () => {
  passwordError.value = ''
  
  if (passwordDialogMode.value === 'set') {
    // 设置新密码
    if (passwordInput.value.length < 4) {
      passwordError.value = '密码长度至少为 4 位'
      return
    }
    if (passwordInput.value !== confirmPasswordInput.value) {
      passwordError.value = '两次输入的密码不一致'
      return
    }
    
    try {
      passwordLoading.value = true
      const result = await api.knowledge.setPassword(passwordInput.value)
      if (result.success) {
        showPasswordDialog.value = false
        await loadPasswordInfo()
        // 如果是启用流程中设置密码，现在正式启用知识库
        if (pendingEnable.value) {
          pendingEnable.value = false
          settings.value.enabled = true
          await saveSettings()
        }
      } else {
        passwordError.value = result.error || '设置密码失败'
      }
    } catch (error) {
      passwordError.value = '设置密码失败'
    } finally {
      passwordLoading.value = false
    }
  } else if (passwordDialogMode.value === 'verify') {
    // 验证密码（解锁）
    if (!passwordInput.value) {
      passwordError.value = '请输入密码'
      return
    }
    
    try {
      passwordLoading.value = true
      const result = await api.knowledge.verifyPassword(passwordInput.value)
      if (result.success) {
        showPasswordDialog.value = false
        await loadPasswordInfo()
        // 如果是启用流程中验证密码，现在正式启用知识库
        if (pendingEnable.value) {
          pendingEnable.value = false
          settings.value.enabled = true
          await saveSettings()
        }
        // 解锁后加载文档
        await loadDocuments()
      } else {
        passwordError.value = result.error || '密码错误'
      }
    } catch (error) {
      passwordError.value = '验证失败'
    } finally {
      passwordLoading.value = false
    }
  } else if (passwordDialogMode.value === 'change') {
    // 修改密码
    if (!passwordInput.value) {
      passwordError.value = '请输入当前密码'
      return
    }
    if (newPasswordInput.value.length < 4) {
      passwordError.value = '新密码长度至少为 4 位'
      return
    }
    if (newPasswordInput.value !== confirmPasswordInput.value) {
      passwordError.value = '两次输入的新密码不一致'
      return
    }
    
    try {
      passwordLoading.value = true
      const result = await api.knowledge.changePassword(passwordInput.value, newPasswordInput.value)
      if (result.success) {
        showPasswordDialog.value = false
        await loadPasswordInfo()
        alert('密码修改成功')
      } else {
        passwordError.value = result.error || '修改密码失败'
      }
    } catch (error) {
      passwordError.value = '修改密码失败'
    } finally {
      passwordLoading.value = false
    }
  } else if (passwordDialogMode.value === 'clear') {
    // 清除密码
    if (!passwordInput.value) {
      passwordError.value = '请输入当前密码'
      return
    }
    
    try {
      passwordLoading.value = true
      // 清除密码时会自动解密所有加密数据
      const result = await api.knowledge.clearPassword(passwordInput.value)
      
      if (result.success) {
        showPasswordDialog.value = false
        await loadPasswordInfo()
        // 显示结果信息
        if (result.decryptedCount && result.decryptedCount > 0) {
          alert(`✅ ${result.message || `已解密 ${result.decryptedCount} 条数据，密码已清除`}\n\n知识库数据将不再加密保护，但所有数据已保留。`)
        } else {
          alert('密码已清除，知识库数据将不再加密保护')
        }
      } else {
        passwordError.value = result.error || '清除密码失败'
      }
    } catch (error) {
      passwordError.value = '清除密码失败'
    } finally {
      passwordLoading.value = false
    }
  }
}

// 锁定知识库
const lockKnowledge = async () => {
  await api.knowledge.lock()
  await loadPasswordInfo()
}

// 密码输入框引用
const passwordInputRef = ref<HTMLInputElement | null>(null)

// ESC 关闭密码弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPasswordDialog.value) {
    e.stopImmediatePropagation() // 阻止其他监听器被调用，防止同时关闭父级弹窗
    closePasswordDialog()
  }
}

// 监听弹窗打开，自动聚焦到密码输入框
watch(showPasswordDialog, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    passwordInputRef.value?.focus()
  }
})

onMounted(() => {
  loadSettings()
  loadPasswordInfo()
  // 使用捕获阶段，确保在父组件之前处理事件
  document.addEventListener('keydown', handleKeydown, true)
  
  // 监听知识库就绪事件
  unsubscribeKnowledgeReady = api.knowledge.onReady(() => {
    isKnowledgeInitialized.value = true
    // 重新加载设置以获取最新状态
    loadSettings()
  })
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
  // 清理知识库就绪事件监听
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
              @change="handleEnableChange"
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

        <!-- 安全设置 -->
        <div class="setting-group">
          <h4 class="group-title">🔐 {{ t('knowledgeSettings.securitySettings') }}</h4>
          
          <div class="setting-row">
            <div class="setting-info">
              <label class="setting-label">{{ t('knowledgeSettings.knowledgePassword') }}</label>
              <p class="setting-desc">
                {{ passwordInfo.hasPassword 
                  ? (passwordInfo.isUnlocked ? t('knowledgeSettings.passwordUnlocked') : t('knowledgeSettings.passwordLocked'))
                  : t('knowledgeSettings.noPasswordSet') }}
              </p>
            </div>
            <div class="password-actions">
              <template v-if="!passwordInfo.hasPassword">
                <button class="btn btn-sm" @click="openPasswordDialog('set')">
                  🔑 {{ t('knowledgeSettings.setPassword') }}
                </button>
              </template>
              <template v-else-if="!passwordInfo.isUnlocked">
                <button class="btn btn-sm btn-primary" @click="openPasswordDialog('verify')">
                  🔓 {{ t('knowledgeSettings.unlock') }}
                </button>
              </template>
              <template v-else>
                <button class="btn btn-sm" @click="openPasswordDialog('change')">
                  ✏️ {{ t('knowledgeSettings.changePassword') }}
                </button>
                <button class="btn btn-sm" @click="lockKnowledge">
                  🔒 {{ t('knowledgeSettings.lock') }}
                </button>
                <button class="btn btn-sm btn-danger" @click="openPasswordDialog('clear')">
                  🗑️ {{ t('knowledgeSettings.clearPasswordBtn') }}
                </button>
              </template>
            </div>
          </div>
          
          <div v-if="passwordInfo.hasPassword && !passwordInfo.isUnlocked" class="warning-box">
            <span class="warning-icon">⚠️</span>
            <span>{{ t('knowledgeSettings.lockedWarning') }}</span>
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
    
    <!-- 密码对话框 -->
    <Teleport to="body">
      <div v-if="showPasswordDialog" class="doc-modal-overlay" @click.self="closePasswordDialog">
        <div class="password-modal">
          <div class="password-modal-header">
            <h3>
              {{ pendingEnable 
                 ? (passwordDialogMode === 'verify' ? '🔐 ' + t('knowledgeSettings.passwordDialogVerifyTitle') : '🔐 ' + t('knowledgeSettings.passwordDialogSetTitle'))
                 : passwordDialogMode === 'set' ? '🔑 ' + t('knowledgeSettings.passwordDialogSetTitle')
                 : passwordDialogMode === 'verify' ? '🔓 ' + t('knowledgeSettings.passwordDialogVerifyTitle')
                 : passwordDialogMode === 'clear' ? '🗑️ ' + t('knowledgeSettings.passwordDialogClearTitle')
                 : '✏️ ' + t('knowledgeSettings.passwordDialogChangeTitle') }}
            </h3>
            <button class="password-close-btn" @click="closePasswordDialog">&times;</button>
          </div>
          
          <div class="password-modal-content">
            <p v-if="passwordDialogMode === 'set'" class="password-hint">
              {{ t('knowledgeSettings.setPasswordHint') }}
            </p>
            <p v-if="passwordDialogMode === 'verify'" class="password-hint">
              {{ t('knowledgeSettings.verifyPasswordHint') }}
            </p>
            <p v-if="passwordDialogMode === 'clear'" class="password-hint password-hint-warning">
              ⚠️ {{ t('knowledgeSettings.clearPasswordWarning') }}
            </p>
            
            <div class="password-field">
              <label>{{ passwordDialogMode === 'change' || passwordDialogMode === 'clear' ? t('knowledgeSettings.currentPassword') : t('knowledgeSettings.password') }}</label>
              <input 
                ref="passwordInputRef"
                type="password" 
                v-model="passwordInput" 
                :placeholder="passwordDialogMode === 'verify' || passwordDialogMode === 'clear' ? t('knowledgeSettings.enterPassword') : t('knowledgeSettings.enterPasswordMinLength')"
                @keyup.enter="handlePasswordSubmit"
              />
            </div>
            
            <template v-if="passwordDialogMode === 'change'">
              <div class="password-field">
                <label>{{ t('knowledgeSettings.newPassword') }}</label>
                <input 
                  type="password" 
                  v-model="newPasswordInput" 
                  :placeholder="t('knowledgeSettings.enterNewPasswordMinLength')"
                />
              </div>
            </template>
            
            <template v-if="passwordDialogMode === 'set' || passwordDialogMode === 'change'">
              <div class="password-field">
                <label>{{ passwordDialogMode === 'change' ? t('knowledgeSettings.confirmNewPassword') : t('knowledgeSettings.confirmPassword') }}</label>
                <input 
                  type="password" 
                  v-model="confirmPasswordInput" 
                  :placeholder="t('knowledgeSettings.reenterPassword')"
                  @keyup.enter="handlePasswordSubmit"
                />
              </div>
            </template>
            
            <p v-if="passwordError" class="password-error">{{ passwordError }}</p>
          </div>
          
          <div class="password-modal-footer">
            <button class="btn btn-sm" @click="closePasswordDialog">{{ pendingEnable ? t('knowledgeSettings.cancelEnable') : t('knowledgeSettings.cancel') }}</button>
            <button 
              class="btn btn-sm" 
              :class="passwordDialogMode === 'clear' ? 'btn-danger' : 'btn-primary'"
              @click="handlePasswordSubmit"
              :disabled="passwordLoading"
            >
              {{ passwordLoading ? t('knowledgeSettings.processing') : 
                 passwordDialogMode === 'set' ? t('knowledgeSettings.setPassword') : 
                 passwordDialogMode === 'verify' ? t('knowledgeSettings.unlock') : 
                 passwordDialogMode === 'clear' ? t('knowledgeSettings.confirmClear') : t('knowledgeSettings.changePassword') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 文档管理弹窗 - 使用独立的 KnowledgeManager 组件 -->
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

/* 文档摘要 */
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

/* 文档管理弹窗 */
.doc-modal-overlay {
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

.btn-danger {
  background: var(--bg-tertiary);
  border-color: var(--accent-error);
  color: var(--accent-error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 密码相关样式 */
.password-actions {
  display: flex;
  gap: 8px;
}

.btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.warning-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--accent-warning);
  border-radius: 8px;
  font-size: 13px;
  color: var(--accent-warning);
  margin-top: 12px;
}

.warning-icon {
  font-size: 16px;
}

.password-modal {
  width: 90%;
  max-width: 400px;
  background: var(--bg-secondary);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
}

.password-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.password-modal-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.password-close-btn {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 20px;
  cursor: pointer;
  transition: all 0.2s;
}

.password-close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.password-modal-content {
  padding: 20px;
}

.password-hint {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px;
  line-height: 1.5;
}

.password-hint-warning {
  color: var(--accent-error);
  background: rgba(239, 68, 68, 0.1);
  padding: 12px;
  border-radius: 6px;
  border: 1px solid rgba(239, 68, 68, 0.2);
}

.password-field {
  margin-bottom: 16px;
}

.password-field label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.password-field input {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  box-sizing: border-box;
}

.password-field input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.password-error {
  font-size: 13px;
  color: var(--accent-error);
  margin: 0;
}

.password-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
}

</style>
