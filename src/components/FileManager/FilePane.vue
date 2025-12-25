<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useLocalFs, type LocalFileInfo } from '../../composables/useLocalFs'
import { useSftp, type SftpFileInfo, type SftpConnectionConfig } from '../../composables/useSftp'
import { useBookmarks, type FileBookmark } from '../../composables/useBookmarks'
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

// 树视图展开状态（远程面板默认不显示）
const showTree = ref(props.type === 'local')

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

// 预览弹窗（远程文件）
const showPreviewDialog = ref(false)
const previewFile = ref<FileInfo | null>(null)
const previewContent = ref('')
const previewLoading = ref(false)

// 书签相关
const {
  localBookmarks,
  remoteBookmarks,
  loadBookmarks,
  addBookmark,
  deleteBookmark,
  isBookmarked,
  getBookmarkByPath,
  getRemoteBookmarksByHost
} = useBookmarks()

const showBookmarkDropdown = ref(false)
const showAddBookmarkDialog = ref(false)
const bookmarkName = ref('')
const bookmarkInputRef = ref<HTMLInputElement | null>(null)

// 键盘事件处理
const handleKeyDown = (e: KeyboardEvent) => {
  // ESC 键处理 - 关闭弹窗/菜单（无论焦点在哪里都生效）
  if (e.key === 'Escape') {
    // 按优先级关闭弹窗/菜单
    if (contextMenu.value.show) {
      e.preventDefault()
      closeContextMenu()
      return
    }
    if (showBookmarkDropdown.value) {
      e.preventDefault()
      closeBookmarkDropdown()
      return
    }
    if (showNewFolderDialog.value) {
      e.preventDefault()
      showNewFolderDialog.value = false
      return
    }
    if (showRenameDialog.value) {
      e.preventDefault()
      showRenameDialog.value = false
      return
    }
    if (showPreviewDialog.value) {
      e.preventDefault()
      showPreviewDialog.value = false
      return
    }
    if (showAddBookmarkDialog.value) {
      e.preventDefault()
      showAddBookmarkDialog.value = false
      return
    }
  }
  
  // 只在面板激活时响应其他键盘事件
  if (!props.active) return
  
  // 如果焦点在输入框中，不处理
  const target = e.target as HTMLElement
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
  
  // 如果有弹窗打开，不处理
  if (showNewFolderDialog.value || showRenameDialog.value) return
  
  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      if (selectedFiles.value.length > 0) {
        e.preventDefault()
        triggerDelete()
      }
      break
    case 'F2':
      if (selectedFiles.value.length === 1) {
        e.preventDefault()
        triggerRename()
      }
      break
    case 'F5':
      e.preventDefault()
      refresh()
      break
  }
}

// 初始化
onMounted(async () => {
  // 添加键盘事件监听
  window.addEventListener('keydown', handleKeyDown)
  
  // 加载书签
  await loadBookmarks()
  
  if (props.type === 'local') {
    await localFs?.initialize()
    if (props.initialPath) {
      await localFs?.navigateTo(props.initialPath)
    }
  } else if (props.type === 'remote' && props.sftpConfig) {
    const connected = await sftp?.connect(props.sftpConfig)
    // 连接成功后，如果有初始路径，导航到该路径
    if (connected && props.initialPath) {
      await sftp?.navigateTo(props.initialPath)
    }
  }
})

// 监听 SFTP 配置变化
watch(() => props.sftpConfig, async (newConfig) => {
  if (props.type === 'remote' && newConfig) {
    await sftp?.disconnect()
    const connected = await sftp?.connect(newConfig)
    // 连接成功后，如果有初始路径，导航到该路径
    if (connected && props.initialPath) {
      await sftp?.navigateTo(props.initialPath)
    }
  }
}, { deep: true })

// 监听初始路径变化（当文件管理器窗口已打开时，通过终端再次打开会更新路径）
watch(() => props.initialPath, async (newPath) => {
  console.log(`[FilePane] initialPath 变化: ${newPath}, isConnected=${isConnected.value}`)
  if (newPath && isConnected.value) {
    if (props.type === 'local') {
      await localFs?.navigateTo(newPath)
    } else {
      await sftp?.navigateTo(newPath)
    }
  }
})

// 监听连接状态变化，连接成功后如果有初始路径则导航
watch(() => isConnected.value, async (connected) => {
  console.log(`[FilePane] isConnected 变化: ${connected}, initialPath=${props.initialPath}`)
  if (connected && props.initialPath && props.type === 'remote') {
    // 延迟一下确保 connect 内部的 navigateTo 先完成
    await nextTick()
    await sftp?.navigateTo(props.initialPath)
  }
})

// 清理
onUnmounted(() => {
  // 移除键盘事件监听
  window.removeEventListener('keydown', handleKeyDown)
  
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
const handleDoubleClick = async (file: FileInfo) => {
  if (file.isDirectory) {
    navigateTo(file.path)
  } else if (props.type === 'local') {
    localFs?.openFile(file.path)
  } else if (props.type === 'remote') {
    // 远程文件：预览文本文件内容
    await handlePreview(file)
  }
}

// 预览远程文件
const handlePreview = async (file: FileInfo) => {
  previewFile.value = file
  previewContent.value = ''
  previewLoading.value = true
  showPreviewDialog.value = true

  const content = await sftp?.readTextFile(file.path)
  previewContent.value = content || t('fileManager.cannotReadFile')
  previewLoading.value = false
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

// 右键菜单操作（确保先保存文件引用再关闭菜单）
const onMenuOpen = () => {
  const file = contextMenu.value.file
  closeContextMenu()
  if (file) {
    handleDoubleClick(file)
  }
}

const onMenuRename = () => {
  const file = contextMenu.value.file
  closeContextMenu()
  if (file) {
    openRenameDialog(file)
  }
}

const onMenuDelete = () => {
  const file = contextMenu.value.file
  closeContextMenu()
  if (file) {
    handleDelete(file)
  }
}

const onMenuRefresh = () => {
  closeContextMenu()
  refresh()
}

const onMenuNewFolder = () => {
  closeContextMenu()
  openNewFolderDialog()
}

// 新建文件夹
const openNewFolderDialog = () => {
  newFolderName.value = ''
  showNewFolderDialog.value = true
  setTimeout(() => newFolderInputRef.value?.focus(), 50)
}

const confirmNewFolder = async () => {
  if (newFolderName.value.trim()) {
    const success = await createDirectory(newFolderName.value.trim())
    if (success) {
      showNewFolderDialog.value = false
      toast.success(t('fileManager.folderCreated'))
    } else {
      toast.error(t('fileManager.folderCreateFailed'))
    }
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
    const success = await renameItem(renameFile.value.path, renameName.value.trim())
    if (success) {
      showRenameDialog.value = false
      renameFile.value = null
      toast.success(t('fileManager.renameSuccess'))
    } else {
      toast.error(t('fileManager.renameFailed'))
    }
  }
}

// 删除
const handleDelete = async (file: FileInfo) => {
  const typeKey = file.isDirectory ? 'folder' : 'file'
  const typeText = t(`fileManager.${typeKey}`)
  const confirmed = await showConfirm({
    title: file.isDirectory ? t('fileManager.deleteFolder') : t('fileManager.deleteFile'),
    message: t('fileManager.confirmDeleteMessage', { type: typeText }),
    type: 'danger',
    confirmText: t('common.delete'),
    cancelText: t('fileManager.cancel'),
    fileInfo: {
      name: file.name,
      type: typeText,
      size: file.isDirectory ? undefined : formatSize(file.size)
    }
  })
  
  if (confirmed) {
    const success = await deleteItem(file)
    if (success) {
      toast.success(t('fileManager.deleted', { type: typeText }))
    } else {
      toast.error(t('fileManager.deleteFailed', { type: typeText }))
    }
  }
}

// 拖拽处理
const handleDrop = (files: FileInfo[], targetPath: string) => {
  emit('dropFiles', files, targetPath)
}

// 书签相关方法
const currentBookmarks = computed(() => {
  if (props.type === 'local') {
    return localBookmarks.value
  }
  // 远程书签：显示当前连接主机的书签
  const hostId = props.sftpConfig?.host ? `${props.sftpConfig.host}:${props.sftpConfig.port}` : undefined
  if (hostId) {
    return getRemoteBookmarksByHost(hostId)
  }
  return remoteBookmarks.value
})

const isCurrentPathBookmarked = computed(() => {
  if (!currentPath.value) return false
  const hostId = props.type === 'remote' && props.sftpConfig 
    ? `${props.sftpConfig.host}:${props.sftpConfig.port}` 
    : undefined
  return isBookmarked(currentPath.value, props.type, hostId)
})

const toggleBookmarkDropdown = () => {
  showBookmarkDropdown.value = !showBookmarkDropdown.value
}

const closeBookmarkDropdown = () => {
  showBookmarkDropdown.value = false
}

const openAddBookmarkDialog = () => {
  // 从路径中提取默认名称
  const pathParts = currentPath.value.split('/').filter(Boolean)
  bookmarkName.value = pathParts[pathParts.length - 1] || currentPath.value
  showAddBookmarkDialog.value = true
  closeBookmarkDropdown()
  setTimeout(() => {
    bookmarkInputRef.value?.focus()
    bookmarkInputRef.value?.select()
  }, 50)
}

const confirmAddBookmark = async () => {
  if (!bookmarkName.value.trim() || !currentPath.value) return
  
  const hostId = props.type === 'remote' && props.sftpConfig 
    ? `${props.sftpConfig.host}:${props.sftpConfig.port}` 
    : undefined
  const hostName = props.type === 'remote' && props.sftpConfig
    ? `${props.sftpConfig.username}@${props.sftpConfig.host}`
    : undefined
  
  const success = await addBookmark({
    name: bookmarkName.value.trim(),
    path: currentPath.value,
    type: props.type,
    hostId,
    hostName
  })
  
  if (success) {
    toast.success(t('fileManager.bookmarkAdded'))
    showAddBookmarkDialog.value = false
  } else {
    toast.error(t('fileManager.bookmarkAddFailed'))
  }
}

const handleDeleteBookmark = async (bookmark: FileBookmark) => {
  const success = await deleteBookmark(bookmark.id)
  if (success) {
    toast.success(t('fileManager.bookmarkDeleted'))
  } else {
    toast.error(t('fileManager.bookmarkDeleteFailed'))
  }
}

const handleRemoveCurrentBookmark = async () => {
  const hostId = props.type === 'remote' && props.sftpConfig 
    ? `${props.sftpConfig.host}:${props.sftpConfig.port}` 
    : undefined
  const bookmark = getBookmarkByPath(currentPath.value, props.type, hostId)
  if (bookmark) {
    await handleDeleteBookmark(bookmark)
  }
  closeBookmarkDropdown()
}

const navigateToBookmark = (bookmark: FileBookmark) => {
  navigateTo(bookmark.path)
  closeBookmarkDropdown()
}

// 暴露方法给父组件
const triggerRename = () => {
  if (selectedFiles.value.length === 1) {
    openRenameDialog(selectedFiles.value[0])
  }
}

const triggerDelete = async () => {
  // 复制一份选中的文件列表，避免在删除过程中列表发生变化
  const filesToDelete = [...selectedFiles.value]
  for (const file of filesToDelete) {
    await handleDelete(file)
  }
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
      <span>{{ t('fileManager.connecting') }}</span>
    </div>

    <!-- 未连接状态（仅远程） -->
    <div v-else-if="type === 'remote' && !isConnected && !isConnecting" class="disconnected-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
        <line x1="6" y1="6" x2="6" y2="6"/>
        <line x1="6" y1="18" x2="6" y2="18"/>
      </svg>
      <p>{{ t('fileManager.notConnected') }}</p>
      <p class="error-message" v-if="error">{{ error }}</p>
    </div>

    <!-- 已连接/本地 -->
    <template v-else>
      <!-- 工具栏 -->
      <div class="pane-toolbar">
        <div class="toolbar-nav">
          <button class="btn-icon" :disabled="!canGoBack" @click="goBack" :title="t('fileManager.goBack')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <button class="btn-icon" :disabled="!canGoForward" @click="goForward" :title="t('fileManager.goForward')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
          <button class="btn-icon" :disabled="!canGoUp" @click="goUp" :title="t('fileManager.goUp')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
          </button>
          <button class="btn-icon" @click="goHome" :title="t('fileManager.goHome')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
              <polyline points="9 22 9 12 15 12 15 22"/>
            </svg>
          </button>
          <button class="btn-icon" @click="refresh" :title="t('fileManager.refresh')">
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
          <span>{{ type === 'local' ? t('fileManager.local') : t('fileManager.remote') }}</span>
        </div>
        <div class="toolbar-actions">
          <!-- 书签按钮 -->
          <div class="bookmark-dropdown-container">
            <button 
              class="btn-icon" 
              :class="{ 'bookmarked': isCurrentPathBookmarked }"
              @click="toggleBookmarkDropdown" 
              :title="t('fileManager.bookmarks')"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" :fill="isCurrentPathBookmarked ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
              </svg>
            </button>
            <!-- 书签下拉菜单 -->
            <div v-if="showBookmarkDropdown" class="bookmark-dropdown" @click.stop>
              <div class="bookmark-dropdown-header">
                <span>{{ t('fileManager.bookmarks') }}</span>
                <button 
                  v-if="isCurrentPathBookmarked"
                  class="btn-text danger"
                  @click="handleRemoveCurrentBookmark"
                >
                  {{ t('fileManager.removeBookmark') }}
                </button>
                <button 
                  v-else
                  class="btn-text primary"
                  @click="openAddBookmarkDialog"
                >
                  {{ t('fileManager.addBookmark') }}
                </button>
              </div>
              <div class="bookmark-dropdown-divider"></div>
              <div class="bookmark-list" v-if="currentBookmarks.length > 0">
                <div 
                  v-for="bookmark in currentBookmarks" 
                  :key="bookmark.id"
                  class="bookmark-item"
                  @click="navigateToBookmark(bookmark)"
                >
                  <div class="bookmark-info">
                    <span class="bookmark-name">{{ bookmark.name }}</span>
                    <span class="bookmark-path">{{ bookmark.path }}</span>
                  </div>
                  <button 
                    class="btn-icon-small" 
                    @click.stop="handleDeleteBookmark(bookmark)"
                    :title="t('common.delete')"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18"/>
                      <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                  </button>
                </div>
              </div>
              <div v-else class="bookmark-empty">
                {{ t('fileManager.noBookmarks') }}
              </div>
            </div>
            <!-- 点击其他区域关闭下拉菜单 -->
            <div v-if="showBookmarkDropdown" class="bookmark-dropdown-overlay" @click="closeBookmarkDropdown"></div>
          </div>
          <button class="btn-icon" @click="showTree = !showTree" :title="t('fileManager.toggleTree')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="btn-icon" @click="openNewFolderDialog" :title="t('fileManager.newFolder')">
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
          :active="active"
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
      <!-- overlay 必须在菜单前面渲染，这样菜单才能在上层接收点击 -->
      <div v-if="contextMenu.show" class="context-menu-overlay" @click="closeContextMenu"></div>
      <div
        v-if="contextMenu.show"
        class="context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <div class="context-menu-item" @click="onMenuOpen">
          <span>{{ contextMenu.file?.isDirectory ? t('fileManager.open') : t('fileManager.previewFile') }}</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" @click="onMenuRename">
          <span>{{ t('fileManager.renameF2') }}</span>
        </div>
        <div class="context-menu-item danger" @click="onMenuDelete">
          <span>{{ t('fileManager.deleteDel') }}</span>
        </div>
        <div class="context-menu-separator"></div>
        <div class="context-menu-item" @click="onMenuRefresh">
          <span>{{ t('fileManager.refreshF5') }}</span>
        </div>
        <div class="context-menu-item" @click="onMenuNewFolder">
          <span>{{ t('fileManager.newFolder') }}</span>
        </div>
      </div>
    </Teleport>

    <!-- 新建文件夹弹窗 -->
    <Teleport to="body">
      <div v-if="showNewFolderDialog" class="dialog-overlay" @click.self="showNewFolderDialog = false">
        <div class="dialog">
          <div class="dialog-header">
            <h3>{{ t('fileManager.newFolderTitle') }}</h3>
          </div>
          <div class="dialog-body">
            <input
              ref="newFolderInputRef"
              v-model="newFolderName"
              type="text"
              class="input"
              :placeholder="t('fileManager.folderNamePlaceholder')"
              @keyup.enter="confirmNewFolder"
            />
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showNewFolderDialog = false">{{ t('fileManager.cancel') }}</button>
            <button class="btn btn-primary" @click="confirmNewFolder" :disabled="!newFolderName.trim()">
              {{ t('fileManager.create') }}
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
            <h3>{{ t('fileManager.renameTitle') }}</h3>
          </div>
          <div class="dialog-body">
            <input
              ref="renameInputRef"
              v-model="renameName"
              type="text"
              class="input"
              :placeholder="t('fileManager.newNamePlaceholder')"
              @keyup.enter="confirmRename"
            />
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showRenameDialog = false">{{ t('fileManager.cancel') }}</button>
            <button class="btn btn-primary" @click="confirmRename" :disabled="!renameName.trim()">
              {{ t('fileManager.confirm') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 预览弹窗（远程文件） -->
    <Teleport to="body">
      <div v-if="showPreviewDialog" class="dialog-overlay" @click.self="showPreviewDialog = false">
        <div class="dialog preview-dialog">
          <div class="dialog-header">
            <h3>{{ previewFile?.name }}</h3>
            <button class="btn-close" @click="showPreviewDialog = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          <div class="dialog-body preview-body">
            <div v-if="previewLoading" class="preview-loading">
              <span>{{ t('fileManager.loading') }}</span>
            </div>
            <pre v-else class="preview-content">{{ previewContent }}</pre>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 添加书签弹窗 -->
    <Teleport to="body">
      <div v-if="showAddBookmarkDialog" class="dialog-overlay" @click.self="showAddBookmarkDialog = false">
        <div class="dialog">
          <div class="dialog-header">
            <h3>{{ t('fileManager.addBookmarkTitle') }}</h3>
          </div>
          <div class="dialog-body">
            <div class="form-group">
              <label>{{ t('fileManager.bookmarkPath') }}</label>
              <div class="bookmark-path-display">{{ currentPath }}</div>
            </div>
            <div class="form-group">
              <label>{{ t('fileManager.bookmarkName') }}</label>
              <input
                ref="bookmarkInputRef"
                v-model="bookmarkName"
                type="text"
                class="input"
                :placeholder="t('fileManager.bookmarkNamePlaceholder')"
                @keyup.enter="confirmAddBookmark"
              />
            </div>
          </div>
          <div class="dialog-footer">
            <button class="btn" @click="showAddBookmarkDialog = false">{{ t('fileManager.cancel') }}</button>
            <button class="btn btn-primary" @click="confirmAddBookmark" :disabled="!bookmarkName.trim()">
              {{ t('fileManager.addBookmark') }}
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

/* 预览弹窗 */
.preview-dialog {
  width: 80%;
  max-width: 800px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}

.preview-dialog .dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.preview-dialog .dialog-header h3 {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.btn-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.preview-body {
  flex: 1;
  min-height: 200px;
  max-height: 60vh;
  overflow: auto;
  padding: 0 !important;
}

.preview-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: var(--text-secondary);
}

.preview-content {
  margin: 0;
  padding: 16px;
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--bg-primary);
  user-select: text;
  cursor: text;
}

/* 书签相关样式 */
.bookmark-dropdown-container {
  position: relative;
}

.btn-icon.bookmarked {
  color: var(--accent-warning);
}

.bookmark-dropdown-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
}

.bookmark-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 280px;
  max-width: 360px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 1000;
  overflow: hidden;
}

.bookmark-dropdown-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.bookmark-dropdown-divider {
  height: 1px;
  background: var(--border-color);
}

.btn-text {
  padding: 4px 8px;
  font-size: 12px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.btn-text.primary {
  color: var(--accent-primary);
}

.btn-text.primary:hover {
  background: rgba(var(--accent-primary-rgb), 0.1);
}

.btn-text.danger {
  color: var(--accent-error);
}

.btn-text.danger:hover {
  background: rgba(244, 63, 94, 0.1);
}

.bookmark-list {
  max-height: 300px;
  overflow-y: auto;
}

.bookmark-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.bookmark-item:hover {
  background: var(--bg-hover);
}

.bookmark-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bookmark-name {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bookmark-path {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-icon-small {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s;
}

.bookmark-item:hover .btn-icon-small {
  opacity: 1;
}

.btn-icon-small:hover {
  background: var(--bg-hover);
  color: var(--accent-error);
}

.bookmark-empty {
  padding: 20px;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}

/* 表单组 */
.form-group {
  margin-bottom: 16px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.bookmark-path-display {
  padding: 8px 12px;
  font-size: 13px;
  font-family: 'SF Mono', 'Monaco', monospace;
  color: var(--text-muted);
  background: var(--bg-primary);
  border-radius: 6px;
  word-break: break-all;
}
</style>

