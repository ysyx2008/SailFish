<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSftp, type SftpFileInfo, type SftpConnectionConfig } from '../../composables/useSftp'
import FileList from './FileList.vue'
import PathBreadcrumb from './PathBreadcrumb.vue'
import FileContextMenu from './FileContextMenu.vue'
import TransferQueue from './TransferQueue.vue'
import FilePropertiesDialog from './FilePropertiesDialog.vue'
import { toast } from '../../composables/useToast'
import { showConfirm } from '../../composables/useConfirm'

const { t } = useI18n()

const props = defineProps<{
  config: SftpConnectionConfig
}>()

const emit = defineEmits<{
  close: []
}>()

// SFTP 状态
const {
  sessionId,
  isConnected,
  isConnecting,
  isLoading,
  currentPath,
  files,
  transfers,
  error,
  connectionInfo,
  canGoBack,
  canGoForward,
  connect,
  disconnect,
  navigateTo,
  refresh,
  goBack,
  goForward,
  goUp,
  goHome,
  uploadFile,
  uploadFiles,
  downloadFile,
  createDirectory,
  deleteFile,
  deleteDirectory,
  rename,
  readTextFile,
  selectAndUpload,
  selectAndDownload,
  cancelTransfer,
  clearCompletedTransfers,
  clearAllTransfers,
  formatSize,
  formatTime,
  formatPermissions
} = useSftp()

// 右键菜单状态
const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  file: null as SftpFileInfo | null
})

// 新建文件夹弹窗
const showNewFolderDialog = ref(false)
const newFolderName = ref('')
const newFolderInputRef = ref<HTMLInputElement | null>(null)

// 重命名弹窗
const showRenameDialog = ref(false)
const renameFile = ref<SftpFileInfo | null>(null)
const renameName = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

// 预览弹窗
const showPreviewDialog = ref(false)
const previewFile = ref<SftpFileInfo | null>(null)
const previewContent = ref('')
const previewLoading = ref(false)

// 属性/权限弹窗
const showPropertiesDialog = ref(false)
const propertiesFile = ref<SftpFileInfo | null>(null)
const propertiesMode = ref<'properties' | 'chmod'>('properties')

// 连接
onMounted(async () => {
  await connect(props.config)
})

// 断开连接时清理
onUnmounted(() => {
  disconnect()
})

// ESC 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (contextMenu.value.show) {
      contextMenu.value.show = false
    } else if (showNewFolderDialog.value) {
      showNewFolderDialog.value = false
    } else if (showRenameDialog.value) {
      showRenameDialog.value = false
    } else if (showPreviewDialog.value) {
      showPreviewDialog.value = false
    } else if (showPropertiesDialog.value) {
      showPropertiesDialog.value = false
    } else {
      emit('close')
    }
  }
}

watch(() => showNewFolderDialog.value, async (show) => {
  if (show) {
    await new Promise(r => setTimeout(r, 50))
    newFolderInputRef.value?.focus()
  }
})

watch(() => showRenameDialog.value, async (show) => {
  if (show) {
    await new Promise(r => setTimeout(r, 50))
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

// 右键菜单
const handleContextMenu = (event: MouseEvent, file: SftpFileInfo) => {
  contextMenu.value = {
    show: true,
    x: event.clientX,
    y: event.clientY,
    file
  }
}

const closeContextMenu = () => {
  contextMenu.value.show = false
}

// 下载文件
const handleDownload = (file: SftpFileInfo) => {
  selectAndDownload(file)
}

// 删除
const handleDelete = async (file: SftpFileInfo) => {
  const type = file.isDirectory ? '文件夹' : '文件'
  const confirmed = await showConfirm({
    title: `删除${type}`,
    message: `确定要删除此${type}吗？此操作无法撤销。`,
    type: 'danger',
    confirmText: '删除',
    cancelText: '取消',
    fileInfo: {
      name: file.name,
      type,
      size: file.isDirectory ? undefined : formatSize(file.size)
    }
  })
  
  if (confirmed) {
    let success: boolean
    if (file.isDirectory) {
      success = await deleteDirectory(file.path)
    } else {
      success = await deleteFile(file.path)
    }
    
    if (success) {
      toast.success(`${type}已删除`)
    } else {
      toast.error(`删除${type}失败`)
    }
  }
}

// 重命名
const handleRename = (file: SftpFileInfo) => {
  renameFile.value = file
  renameName.value = file.name
  showRenameDialog.value = true
}

const confirmRename = async () => {
  if (renameFile.value && renameName.value.trim()) {
    const success = await rename(renameFile.value.path, renameName.value.trim())
    if (success) {
      showRenameDialog.value = false
      renameFile.value = null
      renameName.value = ''
      toast.success('重命名成功')
    } else {
      toast.error('重命名失败')
    }
  }
}

// 新建文件夹
const openNewFolderDialog = () => {
  newFolderName.value = ''
  showNewFolderDialog.value = true
}

const confirmNewFolder = async () => {
  if (newFolderName.value.trim()) {
    const success = await createDirectory(newFolderName.value.trim())
    if (success) {
      showNewFolderDialog.value = false
      newFolderName.value = ''
      toast.success('文件夹已创建')
    } else {
      toast.error('创建文件夹失败')
    }
  }
}

// 预览文件
const handlePreview = async (file: SftpFileInfo) => {
  previewFile.value = file
  previewContent.value = ''
  previewLoading.value = true
  showPreviewDialog.value = true

  const content = await readTextFile(file.path)
  previewContent.value = content || '无法读取文件内容'
  previewLoading.value = false
}

// 拖拽上传
const handleDrop = async (fileList: FileList) => {
  const paths: string[] = []
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i]
    // Electron 环境下可以获取文件路径
    if ((file as any).path) {
      paths.push((file as any).path)
    }
  }
  if (paths.length > 0) {
    await uploadFiles(paths)
  }
}

// 查看属性
const handleProperties = (file: SftpFileInfo) => {
  propertiesFile.value = file
  propertiesMode.value = 'properties'
  showPropertiesDialog.value = true
}

// 修改权限
const handleChmod = (file: SftpFileInfo) => {
  propertiesFile.value = file
  propertiesMode.value = 'chmod'
  showPropertiesDialog.value = true
}

// 关闭属性弹窗
const closePropertiesDialog = () => {
  showPropertiesDialog.value = false
  propertiesFile.value = null
}

// 应用权限更改
const applyChmod = async (path: string, mode: string) => {
  if (!sessionId.value) return
  
  try {
    const result = await window.electronAPI.sftp.chmod(sessionId.value, path, mode)
    if (result.success) {
      toast.success('权限已修改')
      await refresh()
    } else {
      toast.error(result.error || '修改权限失败')
    }
  } catch (e) {
    toast.error('修改权限失败')
  }
}

// 取消传输
const handleCancelTransfer = async (transferId: string) => {
  const success = await cancelTransfer(transferId)
  if (success) {
    toast.info('传输已取消')
  }
}

// 重试传输
const handleRetryTransfer = async (transfer: { direction: string; localPath: string; remotePath: string }) => {
  if (transfer.direction === 'upload') {
    const transferId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await uploadFile(transfer.localPath, transfer.remotePath)
  } else {
    const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`
    await downloadFile(transfer.remotePath, transfer.localPath)
  }
}

// 清除已完成的传输
const handleClearTransfers = () => {
  clearCompletedTransfers()
}

// 清除所有传输
const handleClearAllTransfers = () => {
  clearAllTransfers()
}
</script>

<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="file-explorer-modal">
      <!-- 标题栏 -->
      <div class="explorer-header">
        <div class="header-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span v-if="connectionInfo">
            SFTP - {{ connectionInfo.username }}@{{ connectionInfo.host }}
          </span>
          <span v-else>{{ t('fileExplorer.sftpFileManager') }}</span>
        </div>
        <button class="btn-icon" @click="$emit('close')" :title="t('fileExplorer.close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- 连接中状态 -->
      <div v-if="isConnecting" class="connecting-state">
        <div class="spinner"></div>
        <span>{{ t('fileExplorer.connecting') }}</span>
      </div>

      <!-- 连接错误 -->
      <div v-else-if="error && !isConnected" class="error-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <p>{{ t('fileExplorer.connectionFailed') }}</p>
        <p class="error-message">{{ error }}</p>
        <button class="btn btn-primary" @click="connect(props.config)">{{ t('fileExplorer.retry') }}</button>
      </div>

      <!-- 已连接 -->
      <template v-else-if="isConnected">
        <!-- 工具栏 -->
        <div class="explorer-toolbar">
          <div class="toolbar-nav">
            <button
              class="btn-icon"
              :disabled="!canGoBack"
              @click="goBack"
              :title="t('fileExplorer.goBack')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <button
              class="btn-icon"
              :disabled="!canGoForward"
              @click="goForward"
              :title="t('fileExplorer.goForward')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
            <button
              class="btn-icon"
              :disabled="currentPath === '/'"
              @click="goUp"
              :title="t('fileExplorer.goUp')"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="18 15 12 9 6 15"/>
              </svg>
            </button>
            <button class="btn-icon" @click="goHome" :title="t('fileExplorer.goHome')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                <polyline points="9 22 9 12 15 12 15 22"/>
              </svg>
            </button>
          </div>

          <PathBreadcrumb :path="currentPath" @navigate="navigateTo" />

          <div class="toolbar-actions">
            <button class="btn-icon" @click="refresh" :title="t('fileExplorer.refresh')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
            <button class="btn-icon" @click="openNewFolderDialog" :title="t('fileExplorer.newFolder')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="11" x2="12" y2="17"/>
                <line x1="9" y1="14" x2="15" y2="14"/>
              </svg>
            </button>
            <button class="btn btn-sm btn-primary" @click="selectAndUpload">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              上传
            </button>
          </div>
        </div>

        <!-- 文件列表 -->
        <FileList
          :files="files"
          :loading="isLoading"
          :format-size="formatSize"
          :format-time="formatTime"
          :format-permissions="formatPermissions"
          @navigate="navigateTo"
          @download="handleDownload"
          @contextmenu="handleContextMenu"
          @drop="handleDrop"
        />

        <!-- 传输队列 -->
        <TransferQueue 
          :transfers="transfers"
          @cancel="handleCancelTransfer"
          @retry="handleRetryTransfer"
          @clear="handleClearTransfers"
          @clear-all="handleClearAllTransfers"
        />
      </template>

      <!-- 右键菜单 -->
      <FileContextMenu
        :show="contextMenu.show"
        :x="contextMenu.x"
        :y="contextMenu.y"
        :file="contextMenu.file"
        @close="closeContextMenu"
        @download="handleDownload"
        @delete="handleDelete"
        @rename="handleRename"
        @refresh="refresh"
        @new-folder="openNewFolderDialog"
        @preview="handlePreview"
        @properties="handleProperties"
        @chmod="handleChmod"
      />

      <!-- 属性/权限弹窗 -->
      <FilePropertiesDialog
        :show="showPropertiesDialog"
        :file="propertiesFile"
        :mode="propertiesMode"
        @close="closePropertiesDialog"
        @chmod="applyChmod"
      />

      <!-- 新建文件夹弹窗 -->
      <div v-if="showNewFolderDialog" class="dialog-overlay" @click.self="showNewFolderDialog = false">
        <div class="dialog">
          <div class="dialog-header">
            <h3>新建文件夹</h3>
          </div>
          <div class="dialog-body">
            <input
              ref="newFolderInputRef"
              v-model="newFolderName"
              type="text"
              class="input"
              placeholder="文件夹名称"
              @keyup.enter="confirmNewFolder"
            />
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showNewFolderDialog = false">取消</button>
            <button class="btn btn-primary" @click="confirmNewFolder" :disabled="!newFolderName.trim()">
              创建
            </button>
          </div>
        </div>
      </div>

      <!-- 重命名弹窗 -->
      <div v-if="showRenameDialog" class="dialog-overlay" @click.self="showRenameDialog = false">
        <div class="dialog">
          <div class="dialog-header">
            <h3>重命名</h3>
          </div>
          <div class="dialog-body">
            <input
              ref="renameInputRef"
              v-model="renameName"
              type="text"
              class="input"
              placeholder="新名称"
              @keyup.enter="confirmRename"
            />
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showRenameDialog = false">取消</button>
            <button class="btn btn-primary" @click="confirmRename" :disabled="!renameName.trim()">
              确定
            </button>
          </div>
        </div>
      </div>

      <!-- 预览弹窗 -->
      <div v-if="showPreviewDialog" class="dialog-overlay preview-overlay" @click.self="showPreviewDialog = false">
        <div class="dialog preview-dialog">
          <div class="dialog-header">
            <h3>{{ previewFile?.name }}</h3>
            <button class="btn-icon" @click="showPreviewDialog = false">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="dialog-body preview-body">
            <div v-if="previewLoading" class="preview-loading">
              <div class="spinner"></div>
              <span>加载中...</span>
            </div>
            <pre v-else class="preview-content">{{ previewContent }}</pre>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.file-explorer-modal {
  width: 800px;
  max-width: 90vw;
  height: 600px;
  max-height: 85vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 标题栏 */
.explorer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.header-title svg {
  color: var(--accent-warning);
}

/* 工具栏 */
.explorer-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.toolbar-nav {
  display: flex;
  gap: 2px;
}

.toolbar-nav .btn-icon:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 连接状态 */
.connecting-state,
.error-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  color: var(--text-muted);
}

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-state svg {
  color: var(--accent-error);
  opacity: 0.6;
}

.error-state p {
  margin: 0;
}

.error-message {
  font-size: 12px;
  color: var(--accent-error);
}

/* 弹窗 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.dialog {
  width: 360px;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.dialog-header h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-body {
  padding: 20px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

/* 预览弹窗 */
.preview-overlay {
  z-index: 2100;
}

.preview-dialog {
  width: 700px;
  max-width: 85vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.preview-body {
  flex: 1;
  padding: 0;
  overflow: hidden;
  max-height: 500px;
}

.preview-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-muted);
}

.preview-content {
  margin: 0;
  padding: 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  overflow: auto;
  max-height: 100%;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
