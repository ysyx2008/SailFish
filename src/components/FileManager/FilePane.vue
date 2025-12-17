<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLocalFs, type LocalFileInfo } from '../../composables/useLocalFs'
import { useSftp, type SftpFileInfo, type SftpConnectionConfig } from '../../composables/useSftp'
import DirectoryTree from './DirectoryTree.vue'
import DualPaneFileList from './DualPaneFileList.vue'
import PathBreadcrumb from '../FileExplorer/PathBreadcrumb.vue'
import { showConfirm } from '../../composables/useConfirm'
import { toast } from '../../composables/useToast'

const { t } = useI18n()

type FileInfo = LocalFileInfo | SftpFileInfo

const props = defineProps<{
  type: 'local' | 'remote'
  sftpConfig?: SftpConnectionConfig
  initialPath?: string
  active: boolean
}>()

const emit = defineEmits<{
  focus: []
  selectionChange: [files: FileInfo[]]
  dropFiles: [files: FileInfo[], targetPath: string]
}>()

// 本地文件系统
const localFs = props.type === 'local' ? useLocalFs() : null

// SFTP
const sftp = props.type === 'remote' ? useSftp() : null

// 统一的状态
const isConnected = computed(() => {
  if (props.type === 'local') return true
  return sftp?.isConnected.value ?? false
})

const isConnecting = computed(() => {
  if (props.type === 'local') return false
  return sftp?.isConnecting.value ?? false
})

const isLoading = computed(() => {
  if (props.type === 'local') return localFs?.isLoading.value ?? false
  return sftp?.isLoading.value ?? false
})

const currentPath = computed(() => {
  if (props.type === 'local') return localFs?.currentPath.value ?? ''
  return sftp?.currentPath.value ?? ''
})

const files = computed(() => {
  if (props.type === 'local') return (localFs?.files.value ?? []) as FileInfo[]
  return (sftp?.files.value ?? []) as FileInfo[]
})

const error = computed(() => {
  if (props.type === 'local') return localFs?.error.value
  return sftp?.error.value
})

const canGoBack = computed(() => {
  if (props.type === 'local') return localFs?.canGoBack.value ?? false
  return sftp?.canGoBack.value ?? false
})

const canGoForward = computed(() => {
  if (props.type === 'local') return localFs?.canGoForward.value ?? false
  return sftp?.canGoForward.value ?? false
})

const canGoUp = computed(() => {
  if (props.type === 'local') return localFs?.canGoUp.value ?? false
  return currentPath.value !== '/'
})

// 树视图展开状态
const showTree = ref(true)

// 选中的文件
const selectedFiles = ref<FileInfo[]>([])

// 右键菜单
const contextMenu = ref({
  show: false,
  x: 0,
  y: 0,
  file: null as FileInfo | null
})

// 新建文件夹弹窗
const showNewFolderDialog = ref(false)
const newFolderName = ref('')
const newFolderInputRef = ref<HTMLInputElement | null>(null)

// 重命名弹窗
const showRenameDialog = ref(false)
const renameFile = ref<FileInfo | null>(null)
const renameName = ref('')
const renameInputRef = ref<HTMLInputElement | null>(null)

// 初始化
onMounted(async () => {
  if (props.type === 'local') {
    await localFs?.initialize()
    if (props.initialPath) {
      await localFs?.navigateTo(props.initialPath)
    }
  } else if (props.type === 'remote' && props.sftpConfig) {
    await sftp?.connect(props.sftpConfig)
  }
})

// 监听 SFTP 配置变化
watch(() => props.sftpConfig, async (newConfig) => {
  if (props.type === 'remote' && newConfig) {
    await sftp?.disconnect()
    await sftp?.connect(newConfig)
  }
}, { deep: true })

// 清理
onUnmounted(() => {
  if (props.type === 'remote') {
    sftp?.disconnect()
  }
})

// 导航
const navigateTo = async (path: string) => {
  if (props.type === 'local') {
    await localFs?.navigateTo(path)
  } else {
    await sftp?.navigateTo(path)
  }
}

const refresh = async () => {
  if (props.type === 'local') {
    await localFs?.refresh()
  } else {
    await sftp?.refresh()
  }
}

const goBack = async () => {
  if (props.type === 'local') {
    await localFs?.goBack()
  } else {
    await sftp?.goBack()
  }
}

const goForward = async () => {
  if (props.type === 'local') {
    await localFs?.goForward()
  } else {
    await sftp?.goForward()
  }
}

const goUp = async () => {
  if (props.type === 'local') {
    await localFs?.goUp()
  } else {
    await sftp?.goUp()
  }
}

const goHome = async () => {
  if (props.type === 'local') {
    await localFs?.goHome()
  } else {
    await sftp?.goHome()
  }
}

// 文件操作
const createDirectory = async (name: string): Promise<boolean> => {
  if (props.type === 'local') {
    return localFs?.createDirectory(name) ?? false
  } else {
    return sftp?.createDirectory(name) ?? false
  }
}

const deleteItem = async (file: FileInfo): Promise<boolean> => {
  if (props.type === 'local') {
    if (file.isDirectory) {
      return localFs?.deleteDirectory(file.path) ?? false
    }
    return localFs?.deleteFile(file.path) ?? false
  } else {
    if (file.isDirectory) {
      return sftp?.deleteDirectory(file.path) ?? false
    }
    return sftp?.deleteFile(file.path) ?? false
  }
}

const renameItem = async (oldPath: string, newName: string): Promise<boolean> => {
  if (props.type === 'local') {
    return localFs?.rename(oldPath, newName) ?? false
  } else {
    return sftp?.rename(oldPath, newName) ?? false
  }
}

// 格式化函数
const formatSize = (bytes: number): string => {
  if (props.type === 'local') {
    return localFs?.formatSize(bytes) ?? '-'
  }
  return sftp?.formatSize(bytes) ?? '-'
}

const formatTime = (timestamp: number): string => {
  if (props.type === 'local') {
    return localFs?.formatTime(timestamp) ?? ''
  }
  return sftp?.formatTime(timestamp) ?? ''
}

const formatPermissions = (perms: { user: string; group: string; other: string }): string => {
  if (props.type === 'local') {
    return localFs?.formatPermissions(perms) ?? ''
  }
  return sftp?.formatPermissions(perms) ?? ''
}

// 双击处理
const handleDoubleClick = (file: FileInfo) => {
  if (file.isDirectory) {
    navigateTo(file.path)
  } else if (props.type === 'local') {
    localFs?.openFile(file.path)
  }
}

// 选择变化
const handleSelectionChange = (files: FileInfo[]) => {
  selectedFiles.value = files
  emit('selectionChange', files)
}

// 右键菜单
const handleContextMenu = (event: MouseEvent, file: FileInfo) => {
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

// 新建文件夹
const openNewFolderDialog = () => {
  newFolderName.value = ''
  showNewFolderDialog.value = true
  setTimeout(() => newFolderInputRef.value?.focus(), 50)
}

const confirmNewFolder = async () => {
  if (newFolderName.value.trim()) {
    await createDirectory(newFolderName.value.trim())
    showNewFolderDialog.value = false
  }
}

// 重命名
const openRenameDialog = (file: FileInfo) => {
  renameFile.value = file
  renameName.value = file.name
  showRenameDialog.value = true
  setTimeout(() => {
    renameInputRef.value?.focus()
    renameInputRef.value?.select()
  }, 50)
}

const confirmRename = async () => {
  if (renameFile.value && renameName.value.trim()) {
    await renameItem(renameFile.value.path, renameName.value.trim())
    showRenameDialog.value = false
    renameFile.value = null
  }
}

// 删除
const handleDelete = async (file: FileInfo) => {
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
    await deleteItem(file)
    toast.success(`${type}已删除`)
  }
}

// 拖拽处理
const handleDrop = (files: FileInfo[], targetPath: string) => {
  emit('dropFiles', files, targetPath)
}

// 暴露方法给父组件
const triggerRename = () => {
  if (selectedFiles.value.length === 1) {
    openRenameDialog(selectedFiles.value[0])
  }
}

const triggerDelete = () => {
  selectedFiles.value.forEach(file => handleDelete(file))
}

const getCurrentPath = () => currentPath.value
const getSessionId = () => sftp?.sessionId.value ?? ''

// 计算属性获取sessionId（供DirectoryTree使用）
const sftpSessionId = computed(() => sftp?.sessionId.value ?? '')

defineExpose({
  refresh,
  triggerRename,
  triggerDelete,
  getCurrentPath,
  getSessionId,
  isConnected
})
</script>

<template>
  <div 
    class="file-pane"
    :class="{ active, local: type === 'local', remote: type === 'remote' }"
    @click="$emit('focus')"
  >
    <!-- 连接中状态（仅远程） -->
    <div v-if="type === 'remote' && isConnecting" class="connecting-state">
      <div class="spinner"></div>
      <span>正在连接...</span>
    </div>

    <!-- 未连接状态（仅远程） -->
    <div v-else-if="type === 'remote' && !isConnected && !isConnecting" class="disconnected-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
        <line x1="6" y1="6" x2="6" y2="6"/>
        <line x1="6" y1="18" x2="6" y2="18"/>
      </svg>
      <p>未连接到远程服务器</p>
      <p class="error-message" v-if="error">{{ error }}</p>
    </div>

    <!-- 已连接/本地 -->
    <template v-else>
      <!-- 工具栏 -->
      <div class="pane-toolbar">
        <div class="toolbar-nav">
          <button class="btn-icon" :disabled="!canGoBack" @click="goBack" title="后退">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <button class="btn-icon" :disabled="!canGoForward" @click="goForward" title="前进">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
          <button class="btn-icon" :disabled="!canGoUp" @click="goUp" title="上级目录">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
          <button class="btn-icon" @click="goHome" title="主目录">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </button>
          <button class="btn-icon" @click="refresh" title="刷新 (F5)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
        <div class="toolbar-title">
          <svg v-if="type === 'local'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
            <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
            <line x1="6" y1="6" x2="6" y2="6"/>
            <line x1="6" y1="18" x2="6" y2="18"/>
          </svg>
          <span>{{ type === 'local' ? '本地' : 'SFTP 远程' }}</span>
        </div>
        <div class="toolbar-actions">
          <button class="btn-icon" @click="showTree = !showTree" :title="showTree ? '隐藏目录树' : '显示目录树'">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="btn-icon" @click="openNewFolderDialog" title="新建文件夹">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/>
              <line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 路径导航 -->
      <div class="pane-path">
        <PathBreadcrumb :path="currentPath" @navigate="navigateTo" />
      </div>

      <!-- 内容区域 -->
      <div class="pane-content">
        <!-- 目录树 -->
        <DirectoryTree
          v-if="showTree"
          :type="type"
          :current-path="currentPath"
          :session-id="sftpSessionId"
          @navigate="navigateTo"
        />

        <!-- 文件列表 -->
        <DualPaneFileList
          :files="files"
          :loading="isLoading"
          :format-size="formatSize"
          :format-time="formatTime"
          :format-permissions="formatPermissions"
          :pane-type="type"
          @navigate="navigateTo"
          @double-click="handleDoubleClick"
          @selection-change="handleSelectionChange"
          @contextmenu="handleContextMenu"
          @drop="handleDrop"
        />
      </div>
    </template>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <div
        v-if="contextMenu.show"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="context-menu-item" @click="() => { handleDoubleClick(contextMenu.file!); closeContextMenu() }">
          <span>{{ contextMenu.file?.isDirectory ? '打开' : '打开文件' }}</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" @click="() => { openRenameDialog(contextMenu.file!); closeContextMenu() }">
          <span>重命名 (F2)</span>
        </div>
        <div class="context-menu-item danger" @click="() => { handleDelete(contextMenu.file!); closeContextMenu() }">
          <span>删除 (Del)</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" @click="() => { refresh(); closeContextMenu() }">
          <span>刷新 (F5)</span>
        </div>
        <div class="context-menu-item" @click="() => { openNewFolderDialog(); closeContextMenu() }">
          <span>新建文件夹</span>
        </div>
      </div>
      <div v-if="contextMenu.show" class="context-menu-overlay" @click="closeContextMenu"></div>
    </Teleport>

    <!-- 新建文件夹弹窗 -->
    <Teleport to="body">
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
    </Teleport>

    <!-- 重命名弹窗 -->
    <Teleport to="body">
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
    </Teleport>
  </div>
</template>

<style scoped>
.file-pane {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-tertiary);
  overflow: hidden;
  border-radius: 0;
}

/* 工具栏 */
.pane-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.toolbar-nav {
  display: flex;
  gap: 4px;
}

.toolbar-title {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  pointer-events: none;
}

.toolbar-title svg {
  opacity: 0.7;
}

.toolbar-actions {
  display: flex;
  gap: 4px;
}

/* 路径导航区域 */
.pane-path {
  display: flex;
  align-items: center;
  height: 36px;
  padding: 0 10px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
}

.toolbar-nav .btn-icon:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 内容区域 */
.pane-content {
  flex: 1;
  display: flex;
  overflow: hidden;
}

/* 连接状态 */
.connecting-state,
.disconnected-state {
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

.disconnected-state svg {
  opacity: 0.5;
}

.error-message {
  font-size: 12px;
  color: var(--accent-error);
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  min-width: 160px;
  padding: 4px 0;
  z-index: 10000;
}

.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.context-menu-item {
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s;
}

.context-menu-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.context-menu-item.danger:hover {
  background: rgba(244, 63, 94, 0.1);
  color: var(--accent-error);
}

.context-menu-separator {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0;
}

/* 弹窗 */
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
}

.dialog {
  width: 360px;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.dialog-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.dialog-header h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
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
</style>

