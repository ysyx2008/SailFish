<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Folder, X, XCircle, ChevronLeft, ChevronRight, ChevronUp, Home, RefreshCw, FolderPlus, Upload } from 'lucide-vue-next'
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
    // 按优先级关闭弹窗，并阻止事件传播
    if (contextMenu.value.show) {
      e.stopImmediatePropagation()
      contextMenu.value.show = false
    } else if (showNewFolderDialog.value) {
      e.stopImmediatePropagation()
      showNewFolderDialog.value = false
    } else if (showRenameDialog.value) {
      e.stopImmediatePropagation()
      showRenameDialog.value = false
    } else if (showPreviewDialog.value) {
      e.stopImmediatePropagation()
      showPreviewDialog.value = false
    } else if (showPropertiesDialog.value) {
      e.stopImmediatePropagation()
      showPropertiesDialog.value = false
    } else {
      e.stopImmediatePropagation()
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
  const type = file.isDirectory ? t('fileExplorer.folder') : t('fileExplorer.file')
  const confirmed = await showConfirm({
    title: t('fileExplorer.deleteTitle', { type }),
    message: t('fileExplorer.deleteMessage', { type }),
    type: 'danger',
    confirmText: t('fileExplorer.delete'),
    cancelText: t('fileExplorer.cancel'),
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
      toast.success(t('fileExplorer.deleted', { type }))
    } else {
      toast.error(t('fileExplorer.deleteFailed', { type }))
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
      toast.success(t('fileExplorer.renameSuccess'))
    } else {
      toast.error(t('fileExplorer.renameFailed'))
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
      toast.success(t('fileExplorer.folderCreated'))
    } else {
      toast.error(t('fileExplorer.folderCreateFailed'))
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
  previewContent.value = content || t('fileExplorer.cannotReadFile')
  previewLoading.value = false
}

// 拖拽上传
const handleDrop = async (fileList: FileList) => {
  const paths: string[] = []
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i]
    // 使用 Electron webUtils API 获取文件路径
    const filePath = window.electronAPI?.fileUtils?.getPathForFile(file)
    if (filePath) {
      paths.push(filePath)
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
      toast.success(t('fileExplorer.permissionChanged'))
      await refresh()
    } else {
      toast.error(result.error || t('fileExplorer.permissionChangeFailed'))
    }
  } catch (e) {
    toast.error(t('fileExplorer.permissionChangeFailed'))
  }
}

// 取消传输
const handleCancelTransfer = async (transferId: string) => {
  const success = await cancelTransfer(transferId)
  if (success) {
    toast.info(t('fileExplorer.transferCancelled'))
  }
}

// 重试传输
const handleRetryTransfer = async (transfer: { direction: string; localPath: string; remotePath: string }) => {
  if (transfer.direction === 'upload') {
    await uploadFile(transfer.localPath, transfer.remotePath)
  } else {
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
          <Folder :size="18" />
          <span v-if="connectionInfo">
            SFTP - {{ connectionInfo.username }}@{{ connectionInfo.host }}
          </span>
          <span v-else>{{ t('fileExplorer.sftpFileManager') }}</span>
        </div>
        <button class="btn-icon" @click="$emit('close')" :title="t('fileExplorer.close')">
          <X :size="16" />
        </button>
      </div>

      <!-- 连接中状态 -->
      <div v-if="isConnecting" class="connecting-state">
        <div class="spinner"></div>
        <span>{{ t('fileExplorer.connecting') }}</span>
      </div>

      <!-- 连接错误 -->
      <div v-else-if="error && !isConnected" class="error-state">
        <XCircle :size="48" :stroke-width="1.5" />
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
              <ChevronLeft :size="16" />
            </button>
            <button
              class="btn-icon"
              :disabled="!canGoForward"
              @click="goForward"
              :title="t('fileExplorer.goForward')"
            >
              <ChevronRight :size="16" />
            </button>
            <button
              class="btn-icon"
              :disabled="currentPath === '/'"
              @click="goUp"
              :title="t('fileExplorer.goUp')"
            >
              <ChevronUp :size="16" />
            </button>
            <button class="btn-icon" @click="goHome" :title="t('fileExplorer.goHome')">
              <Home :size="16" />
            </button>
          </div>

          <PathBreadcrumb :path="currentPath" @navigate="navigateTo" />

          <div class="toolbar-actions">
            <button class="btn-icon" @click="refresh" :title="t('fileExplorer.refresh')">
              <RefreshCw :size="16" />
            </button>
            <button class="btn-icon" @click="openNewFolderDialog" :title="t('fileExplorer.newFolder')">
              <FolderPlus :size="16" />
            </button>
            <button class="btn btn-sm btn-primary" @click="selectAndUpload">
              <Upload :size="14" />
              {{ t('fileExplorer.upload') }}
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
            <h3>{{ t('fileExplorer.newFolderTitle') }}</h3>
          </div>
          <div class="dialog-body">
            <input
              ref="newFolderInputRef"
              v-model="newFolderName"
              type="text"
              class="input"
              :placeholder="t('fileExplorer.folderNamePlaceholder')"
              @keyup.enter="confirmNewFolder"
            />
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showNewFolderDialog = false">{{ t('fileExplorer.cancel') }}</button>
            <button class="btn btn-primary" @click="confirmNewFolder" :disabled="!newFolderName.trim()">
              {{ t('fileExplorer.create') }}
            </button>
          </div>
        </div>
      </div>

      <!-- 重命名弹窗 -->
      <div v-if="showRenameDialog" class="dialog-overlay" @click.self="showRenameDialog = false">
        <div class="dialog">
          <div class="dialog-header">
            <h3>{{ t('fileExplorer.renameTitle') }}</h3>
          </div>
          <div class="dialog-body">
            <input
              ref="renameInputRef"
              v-model="renameName"
              type="text"
              class="input"
              :placeholder="t('fileExplorer.newNamePlaceholder')"
              @keyup.enter="confirmRename"
            />
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showRenameDialog = false">{{ t('fileExplorer.cancel') }}</button>
            <button class="btn btn-primary" @click="confirmRename" :disabled="!renameName.trim()">
              {{ t('fileExplorer.confirm') }}
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
              <X :size="16" />
            </button>
          </div>
          <div class="dialog-body preview-body">
            <div v-if="previewLoading" class="preview-loading">
              <div class="spinner"></div>
              <span>{{ t('fileExplorer.loading') }}</span>
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
