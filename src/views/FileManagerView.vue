<script setup lang="ts">
import { ref, onMounted, onUnmounted, provide, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import FilePane from '../components/FileManager/FilePane.vue'
import TransferQueue from '../components/FileExplorer/TransferQueue.vue'
import type { SftpConnectionConfig, TransferProgress } from '../composables/useSftp'
import type { LocalFileInfo } from '../composables/useLocalFs'
import type { SftpFileInfo } from '../composables/useSftp'

const { t } = useI18n()

// 窗口初始化参数
const initParams = ref<{
  sessionId?: string
  sftpConfig?: SftpConnectionConfig
  initialLocalPath?: string
  initialRemotePath?: string
} | null>(null)

// 面板引用
const localPaneRef = ref<InstanceType<typeof FilePane> | null>(null)
const remotePaneRef = ref<InstanceType<typeof FilePane> | null>(null)

// 当前活动面板
const activePane = ref<'local' | 'remote'>('local')

// 传输队列
const transfers = ref<TransferProgress[]>([])

// 选中的文件
const localSelectedFiles = ref<LocalFileInfo[]>([])
const remoteSelectedFiles = ref<SftpFileInfo[]>([])

// 分隔条拖拽
const isDraggingDivider = ref(false)
const leftPaneWidth = ref(50) // 百分比

// 提供给子组件的上下文
provide('activePane', activePane)
provide('transfers', transfers)

// 计算样式
const leftPaneStyle = computed(() => ({
  width: `${leftPaneWidth.value}%`
}))

const rightPaneStyle = computed(() => ({
  width: `${100 - leftPaneWidth.value}%`
}))

// 初始化
onMounted(async () => {
  // 获取窗口初始化参数
  const params = await window.electronAPI.fileManager.getInitParams()
  initParams.value = params

  // 监听参数更新
  window.electronAPI.fileManager.onParamsUpdate((newParams) => {
    initParams.value = newParams
  })

  // 监听传输事件
  const unsubStart = window.electronAPI.sftp.onTransferStart((progress) => {
    const existing = transfers.value.find(t => t.transferId === progress.transferId)
    if (!existing) {
      transfers.value.push(progress)
    }
  })

  const unsubProgress = window.electronAPI.sftp.onTransferProgress((progress) => {
    const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
    if (index !== -1) {
      transfers.value[index] = progress
    }
  })

  const unsubComplete = window.electronAPI.sftp.onTransferComplete((progress) => {
    const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
    if (index !== -1) {
      transfers.value[index] = progress
      // 3秒后移除已完成的传输
      setTimeout(() => {
        transfers.value = transfers.value.filter(t => t.transferId !== progress.transferId)
      }, 3000)
    }
    // 刷新对应面板
    if (progress.direction === 'upload') {
      remotePaneRef.value?.refresh()
    } else {
      localPaneRef.value?.refresh()
    }
  })

  const unsubError = window.electronAPI.sftp.onTransferError((progress) => {
    const index = transfers.value.findIndex(t => t.transferId === progress.transferId)
    if (index !== -1) {
      transfers.value[index] = progress
    }
  })

  // 清理函数
  onUnmounted(() => {
    unsubStart()
    unsubProgress()
    unsubComplete()
    unsubError()
  })

  // 键盘事件
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

// 键盘快捷键
const handleKeydown = (e: KeyboardEvent) => {
  // F5 刷新
  if (e.key === 'F5') {
    e.preventDefault()
    if (activePane.value === 'local') {
      localPaneRef.value?.refresh()
    } else {
      remotePaneRef.value?.refresh()
    }
  }
  // F2 重命名
  if (e.key === 'F2') {
    e.preventDefault()
    if (activePane.value === 'local') {
      localPaneRef.value?.triggerRename()
    } else {
      remotePaneRef.value?.triggerRename()
    }
  }
  // Delete 删除
  if (e.key === 'Delete') {
    e.preventDefault()
    if (activePane.value === 'local') {
      localPaneRef.value?.triggerDelete()
    } else {
      remotePaneRef.value?.triggerDelete()
    }
  }
  // Tab 切换面板
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    e.preventDefault()
    activePane.value = activePane.value === 'local' ? 'remote' : 'local'
  }
  // Ctrl+Enter 传输选中文件
  if (e.key === 'Enter' && e.ctrlKey) {
    e.preventDefault()
    handleTransferSelected()
  }
}

// 开始拖拽分隔条
const startDividerDrag = (e: MouseEvent) => {
  isDraggingDivider.value = true
  document.addEventListener('mousemove', handleDividerDrag)
  document.addEventListener('mouseup', stopDividerDrag)
}

// 拖拽分隔条
const handleDividerDrag = (e: MouseEvent) => {
  if (!isDraggingDivider.value) return
  const container = document.querySelector('.dual-pane-container') as HTMLElement
  if (!container) return

  const rect = container.getBoundingClientRect()
  const x = e.clientX - rect.left
  const percent = (x / rect.width) * 100

  // 限制在 20% - 80% 之间
  leftPaneWidth.value = Math.min(Math.max(percent, 20), 80)
}

// 停止拖拽分隔条
const stopDividerDrag = () => {
  isDraggingDivider.value = false
  document.removeEventListener('mousemove', handleDividerDrag)
  document.removeEventListener('mouseup', stopDividerDrag)
}

// 传输选中的文件
const handleTransferSelected = async () => {
  if (activePane.value === 'local' && localSelectedFiles.value.length > 0) {
    // 本地 -> 远程上传
    await handleUpload(localSelectedFiles.value)
  } else if (activePane.value === 'remote' && remoteSelectedFiles.value.length > 0) {
    // 远程 -> 本地下载
    await handleDownload(remoteSelectedFiles.value)
  }
}

// 上传文件
const handleUpload = async (files: LocalFileInfo[]) => {
  const remotePath = remotePaneRef.value?.getCurrentPath()
  if (!remotePath || !remotePaneRef.value?.isConnected) {
    alert('请先连接远程服务器')
    return
  }

  for (const file of files) {
    const targetPath = `${remotePath}/${file.name}`
    const transferId = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`
    
    if (file.isDirectory) {
      await window.electronAPI.sftp.uploadDir(
        remotePaneRef.value.getSessionId(),
        file.path,
        targetPath
      )
    } else {
      await window.electronAPI.sftp.upload(
        remotePaneRef.value.getSessionId(),
        file.path,
        targetPath,
        transferId
      )
    }
  }
}

// 下载文件
const handleDownload = async (files: SftpFileInfo[]) => {
  const localPath = localPaneRef.value?.getCurrentPath()
  if (!localPath) return

  for (const file of files) {
    const targetPath = await window.electronAPI.localFs.joinPath(localPath, file.name)
    const transferId = `download-${Date.now()}-${Math.random().toString(36).slice(2)}`
    
    if (file.isDirectory) {
      await window.electronAPI.sftp.downloadDir(
        remotePaneRef.value!.getSessionId(),
        file.path,
        targetPath
      )
    } else {
      await window.electronAPI.sftp.download(
        remotePaneRef.value!.getSessionId(),
        file.path,
        targetPath,
        transferId
      )
    }
  }
}

// 处理跨面板拖拽
const handleCrossPaneDrop = async (
  sourcePane: 'local' | 'remote',
  files: (LocalFileInfo | SftpFileInfo)[],
  targetPath: string
) => {
  if (sourcePane === 'local') {
    // 本地文件拖到远程
    await handleUpload(files as LocalFileInfo[])
  } else {
    // 远程文件拖到本地
    await handleDownload(files as SftpFileInfo[])
  }
}

// 更新选中的文件
const updateLocalSelection = (files: LocalFileInfo[]) => {
  localSelectedFiles.value = files
}

const updateRemoteSelection = (files: SftpFileInfo[]) => {
  remoteSelectedFiles.value = files
}

// 设置活动面板
const setActivePane = (pane: 'local' | 'remote') => {
  activePane.value = pane
}
</script>

<template>
  <div class="file-manager-view" :class="{ dragging: isDraggingDivider }">
    <!-- 工具栏 -->
    <div class="toolbar">
      <div class="toolbar-left">
        <button 
          class="btn btn-primary" 
          @click="handleUpload(localSelectedFiles)"
          :disabled="localSelectedFiles.length === 0 || !remotePaneRef?.isConnected"
          title="上传选中文件到远程 (Ctrl+Enter)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          上传
        </button>
        <button 
          class="btn btn-primary" 
          @click="handleDownload(remoteSelectedFiles)"
          :disabled="remoteSelectedFiles.length === 0 || !remotePaneRef?.isConnected"
          title="下载选中文件到本地 (Ctrl+Enter)"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          下载
        </button>
      </div>
      <div class="toolbar-center">
        <span class="shortcut-hint">F5 刷新 | F2 重命名 | Del 删除 | Tab 切换面板 | Ctrl+Enter 传输</span>
      </div>
      <div class="toolbar-right">
        <!-- 可以添加更多工具按钮 -->
      </div>
    </div>

    <!-- 双栏容器 -->
    <div class="dual-pane-container">
      <!-- 左栏 - 本地文件 -->
      <div class="pane left-pane" :style="leftPaneStyle">
        <FilePane
          ref="localPaneRef"
          type="local"
          :initial-path="initParams?.initialLocalPath"
          :active="activePane === 'local'"
          @focus="setActivePane('local')"
          @selection-change="updateLocalSelection"
          @drop-files="(files, targetPath) => handleCrossPaneDrop('remote', files, targetPath)"
        />
      </div>

      <!-- 分隔条 -->
      <div 
        class="pane-divider"
        @mousedown="startDividerDrag"
      >
        <div class="divider-handle"></div>
      </div>

      <!-- 右栏 - SFTP 远程文件 -->
      <div class="pane right-pane" :style="rightPaneStyle">
        <FilePane
          ref="remotePaneRef"
          type="remote"
          :sftp-config="initParams?.sftpConfig"
          :initial-path="initParams?.initialRemotePath"
          :active="activePane === 'remote'"
          @focus="setActivePane('remote')"
          @selection-change="updateRemoteSelection"
          @drop-files="(files, targetPath) => handleCrossPaneDrop('local', files, targetPath)"
        />
      </div>
    </div>

    <!-- 传输队列 -->
    <TransferQueue v-if="transfers.length > 0" :transfers="transfers" />
  </div>
</template>

<style scoped>
.file-manager-view {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  color: var(--text-primary);
  overflow: hidden;
}

.file-manager-view.dragging {
  cursor: col-resize;
  user-select: none;
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  -webkit-app-region: drag;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
  -webkit-app-region: no-drag;
}

.toolbar-center {
  flex: 1;
  text-align: center;
}

.shortcut-hint {
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.3px;
}

/* 按钮样式 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  color: white;
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-secondary);
  border-color: var(--accent-secondary);
  color: white;
}

.btn-primary svg {
  stroke: white;
}

/* 双栏容器 */
.dual-pane-container {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.pane {
  height: 100%;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* 分隔条 */
.pane-divider {
  width: 6px;
  background: var(--bg-tertiary);
  cursor: col-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.2s;
  border-left: 1px solid var(--border-color);
  border-right: 1px solid var(--border-color);
}

.pane-divider:hover {
  background: var(--accent-primary);
}

.divider-handle {
  width: 2px;
  height: 40px;
  background: var(--text-muted);
  border-radius: 1px;
  opacity: 0.5;
  transition: opacity 0.2s;
}

.pane-divider:hover .divider-handle {
  opacity: 0;
}
</style>

