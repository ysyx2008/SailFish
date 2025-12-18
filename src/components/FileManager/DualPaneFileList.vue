<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { LocalFileInfo } from '../../composables/useLocalFs'
import type { SftpFileInfo } from '../../composables/useSftp'

const { t } = useI18n()

type FileInfo = LocalFileInfo | SftpFileInfo

const props = defineProps<{
  files: FileInfo[]
  loading: boolean
  formatSize: (bytes: number) => string
  formatTime: (timestamp: number) => string
  formatPermissions: (perms: { user: string; group: string; other: string }) => string
  paneType: 'local' | 'remote'
  active: boolean
}>()

const emit = defineEmits<{
  navigate: [path: string]
  doubleClick: [file: FileInfo]
  selectionChange: [files: FileInfo[]]
  contextmenu: [event: MouseEvent, file: FileInfo]
  drop: [files: FileInfo[], targetPath: string]
}>()

// 排序状态
type SortKey = 'name' | 'size' | 'modifyTime' | 'permissions'
type SortOrder = 'asc' | 'desc'

const sortKey = ref<SortKey>('name')
const sortOrder = ref<SortOrder>('asc')

// 选中的文件路径
const selectedPaths = ref<Set<string>>(new Set())

// 最后点击的文件（用于 Shift 多选）
const lastClickedPath = ref<string | null>(null)

// 拖拽状态
const isDragOver = ref(false)
const isDragging = ref(false)
const draggedFiles = ref<FileInfo[]>([])

// 排序后的文件列表
const sortedFiles = computed(() => {
  const sorted = [...props.files]

  sorted.sort((a, b) => {
    // 目录始终在前
    if (a.isDirectory && !b.isDirectory) return -1
    if (!a.isDirectory && b.isDirectory) return 1

    let compare = 0
    switch (sortKey.value) {
      case 'name':
        compare = a.name.localeCompare(b.name, 'zh-CN')
        break
      case 'size':
        compare = a.size - b.size
        break
      case 'modifyTime':
        compare = a.modifyTime - b.modifyTime
        break
      case 'permissions':
        const pa = `${a.permissions.user}${a.permissions.group}${a.permissions.other}`
        const pb = `${b.permissions.user}${b.permissions.group}${b.permissions.other}`
        compare = pa.localeCompare(pb)
        break
    }

    return sortOrder.value === 'asc' ? compare : -compare
  })

  return sorted
})

// 选中的文件列表
const selectedFiles = computed(() => {
  return props.files.filter(f => selectedPaths.value.has(f.path))
})

// 切换排序
const toggleSort = (key: SortKey) => {
  if (sortKey.value === key) {
    sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortOrder.value = 'asc'
  }
}

// 获取排序图标
const getSortIcon = (key: SortKey) => {
  if (sortKey.value !== key) return ''
  return sortOrder.value === 'asc' ? '↑' : '↓'
}

// 点击处理（支持多选）
const handleClick = (file: FileInfo, event: MouseEvent) => {
  if (event.ctrlKey || event.metaKey) {
    // Ctrl/Cmd + 点击：切换选中状态
    if (selectedPaths.value.has(file.path)) {
      selectedPaths.value.delete(file.path)
    } else {
      selectedPaths.value.add(file.path)
    }
  } else if (event.shiftKey && lastClickedPath.value) {
    // Shift + 点击：范围选择
    const files = sortedFiles.value
    const lastIndex = files.findIndex(f => f.path === lastClickedPath.value)
    const currentIndex = files.findIndex(f => f.path === file.path)
    
    if (lastIndex !== -1 && currentIndex !== -1) {
      const start = Math.min(lastIndex, currentIndex)
      const end = Math.max(lastIndex, currentIndex)
      
      // 添加范围内的所有文件
      for (let i = start; i <= end; i++) {
        selectedPaths.value.add(files[i].path)
      }
    }
  } else {
    // 普通点击：只选中当前文件
    selectedPaths.value.clear()
    selectedPaths.value.add(file.path)
  }
  
  lastClickedPath.value = file.path
  emit('selectionChange', selectedFiles.value)
}

// 双击处理
const handleDoubleClick = (file: FileInfo) => {
  emit('doubleClick', file)
}

// 右键菜单
const handleContextMenu = (event: MouseEvent, file: FileInfo) => {
  event.preventDefault()
  
  // 如果右键的文件不在选中列表中，先选中它
  if (!selectedPaths.value.has(file.path)) {
    selectedPaths.value.clear()
    selectedPaths.value.add(file.path)
    emit('selectionChange', selectedFiles.value)
  }
  
  emit('contextmenu', event, file)
}

// 全选
const selectAll = () => {
  props.files.forEach(f => selectedPaths.value.add(f.path))
  emit('selectionChange', selectedFiles.value)
}

// 取消全选
const clearSelection = () => {
  selectedPaths.value.clear()
  lastClickedPath.value = null
  emit('selectionChange', [])
}

// 键盘事件处理
const handleKeyDown = (e: KeyboardEvent) => {
  // 只在当前面板激活时响应
  if (!props.active) return
  
  // ESC 取消选择
  if (e.key === 'Escape') {
    if (selectedPaths.value.size > 0) {
      e.preventDefault()
      clearSelection()
    }
  }
  // Ctrl/Cmd + A 全选
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    e.preventDefault()
    selectAll()
  }
}

// 点击空白区域取消选择
const handleListClick = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  // 检查是否点击在文件项上（包括子元素）
  const fileItem = target.closest('.file-item')
  const header = target.closest('.file-list-header')
  
  // 如果不是点击在文件项或表头上，取消选择
  if (!fileItem && !header) {
    clearSelection()
  }
}

// 生命周期
onMounted(() => {
  // 监听键盘事件
  window.addEventListener('keydown', handleKeyDown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown)
})

// 拖拽开始
const handleDragStart = (event: DragEvent, file: FileInfo) => {
  isDragging.value = true
  
  // 如果拖拽的文件不在选中列表中，只拖拽当前文件
  if (selectedPaths.value.has(file.path)) {
    draggedFiles.value = selectedFiles.value
  } else {
    draggedFiles.value = [file]
  }
  
  // 设置拖拽数据
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData('text/plain', JSON.stringify({
      sourcePane: props.paneType,
      files: draggedFiles.value.map(f => ({
        name: f.name,
        path: f.path,
        isDirectory: f.isDirectory
      }))
    }))
  }
}

// 拖拽结束
const handleDragEnd = () => {
  isDragging.value = false
  draggedFiles.value = []
}

// 拖拽进入
const handleDragOver = (event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  isDragOver.value = true
}

// 拖拽离开
const handleDragLeave = () => {
  isDragOver.value = false
}

// 放下
const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  isDragOver.value = false
  
  if (event.dataTransfer) {
    const data = event.dataTransfer.getData('text/plain')
    
    // 检查是否是从本应用拖拽的
    try {
      const parsed = JSON.parse(data)
      if (parsed.sourcePane && parsed.sourcePane !== props.paneType) {
        // 从另一个面板拖拽过来的文件
        emit('drop', parsed.files, '')
        return
      }
    } catch {
      // 不是 JSON，可能是外部文件
    }
    
    // 处理从系统拖拽的文件
    if (event.dataTransfer.files.length > 0) {
      const files: FileInfo[] = []
      for (let i = 0; i < event.dataTransfer.files.length; i++) {
        const file = event.dataTransfer.files[i]
        if ((file as any).path) {
          files.push({
            name: file.name,
            path: (file as any).path,
            size: file.size,
            modifyTime: file.lastModified,
            accessTime: file.lastModified,
            isDirectory: false,
            isSymlink: false,
            permissions: { user: 'rw-', group: 'r--', other: 'r--' }
          } as LocalFileInfo)
        }
      }
      if (files.length > 0) {
        emit('drop', files, '')
      }
    }
  }
}

// 文件图标
const getFileIcon = (file: FileInfo) => {
  if (file.isDirectory) return 'folder'
  if (file.isSymlink) return 'link'
  
  const ext = file.name.split('.').pop()?.toLowerCase()
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'ico']
  const codeExts = ['js', 'ts', 'vue', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h']
  const textExts = ['txt', 'md', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'log']
  const archiveExts = ['zip', 'tar', 'gz', 'bz2', '7z', 'rar']

  if (ext && imageExts.includes(ext)) return 'image'
  if (ext && codeExts.includes(ext)) return 'code'
  if (ext && textExts.includes(ext)) return 'text'
  if (ext && archiveExts.includes(ext)) return 'archive'
  return 'file'
}

// 监听文件列表变化，清空选择
watch(() => props.files, () => {
  selectedPaths.value.clear()
  lastClickedPath.value = null
  emit('selectionChange', [])
})

// 暴露方法
defineExpose({
  selectAll,
  clearSelection
})
</script>

<template>
  <div
    class="file-list"
    :class="{ 'drag-over': isDragOver, dragging: isDragging }"
    tabindex="0"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
    @click="handleListClick"
  >
    <!-- 表头 -->
    <div class="file-list-header">
      <div class="col col-name" @click="toggleSort('name')">
        {{ t('fileManager.name') }} {{ getSortIcon('name') }}
      </div>
      <div class="col col-size" @click="toggleSort('size')">
        {{ t('fileManager.size') }} {{ getSortIcon('size') }}
      </div>
      <div class="col col-time" @click="toggleSort('modifyTime')">
        {{ t('fileManager.modifyTime') }} {{ getSortIcon('modifyTime') }}
      </div>
      <div class="col col-perms" @click="toggleSort('permissions')">
        {{ t('fileManager.permissions') }} {{ getSortIcon('permissions') }}
      </div>
    </div>

    <!-- 文件列表 -->
    <div class="file-list-body">
      <!-- 加载中 -->
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>{{ t('fileManager.loading') }}</span>
      </div>

      <!-- 空目录 -->
      <div v-else-if="files.length === 0" class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        <p>{{ t('fileManager.emptyDirectory') }}</p>
        <p class="tip">{{ t('fileManager.dropFilesHere') }}{{ paneType === 'local' ? '' : t('fileManager.dropToUpload') }}</p>
      </div>

      <!-- 文件项 -->
      <div
        v-else
        v-for="file in sortedFiles"
        :key="file.path"
        class="file-item"
        :class="{ 
          selected: selectedPaths.has(file.path), 
          directory: file.isDirectory,
          'being-dragged': isDragging && draggedFiles.some(f => f.path === file.path)
        }"
        draggable="true"
        @click="handleClick(file, $event)"
        @dblclick="handleDoubleClick(file)"
        @contextmenu="handleContextMenu($event, file)"
        @dragstart="handleDragStart($event, file)"
        @dragend="handleDragEnd"
      >
        <div class="col col-name">
          <span class="file-icon" :class="getFileIcon(file)">
            <!-- 目录图标 -->
            <svg v-if="file.isDirectory" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
            </svg>
            <!-- 文件图标 -->
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
          </span>
          <span class="file-name" :title="file.name">{{ file.name }}</span>
          <span v-if="file.isSymlink" class="symlink-badge">→</span>
        </div>
        <div class="col col-size">{{ file.isDirectory ? '-' : formatSize(file.size) }}</div>
        <div class="col col-time">{{ formatTime(file.modifyTime) }}</div>
        <div class="col col-perms">{{ formatPermissions(file.permissions) }}</div>
      </div>
    </div>

    <!-- 拖拽提示 -->
    <div v-if="isDragOver" class="drop-overlay">
      <div class="drop-hint">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        <p>{{ paneType === 'local' ? t('fileManager.dropToCopy') : t('fileManager.dropToTransfer') }}</p>
      </div>
    </div>

    <!-- 选择信息 -->
    <div v-if="selectedPaths.size > 0" class="selection-info">
      {{ t('fileManager.selectedItems', { count: selectedPaths.size }) }}
    </div>
  </div>
</template>

<style scoped>
.file-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  background: var(--bg-tertiary);
}

.file-list.drag-over {
  background: var(--bg-surface);
}

.file-list.dragging .file-item.being-dragged {
  opacity: 0.5;
}

/* 表头 */
.file-list-header {
  display: flex;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
  flex-shrink: 0;
}

.file-list-header .col {
  cursor: pointer;
  transition: color 0.2s;
}

.file-list-header .col:hover {
  color: var(--text-primary);
}

/* 列宽 */
.col {
  padding: 0 8px;
}

.col-name {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.col-size {
  width: 70px;
  text-align: right;
}

.col-time {
  width: 110px;
}

.col-perms {
  width: 70px;
  font-family: var(--font-mono);
  font-size: 11px;
}

/* 文件列表体 */
.file-list-body {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}

/* 文件项 */
.file-item {
  display: flex;
  align-items: center;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s;
  user-select: none;
}

.file-item:hover {
  background: var(--bg-surface);
}

.file-item.selected {
  background: rgba(137, 180, 250, 0.15);
  color: var(--text-primary);
}

.file-item.selected:hover {
  background: rgba(137, 180, 250, 0.2);
}

.file-item.directory {
  color: var(--text-primary);
}

/* 文件图标 */
.file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.file-icon.folder {
  color: var(--accent-warning);
}

.file-icon.file {
  color: var(--text-muted);
}

.file-icon.image {
  color: var(--accent-success);
}

.file-icon.code {
  color: var(--accent-primary);
}

.file-icon.text {
  color: var(--text-secondary);
}

.file-icon.archive {
  color: var(--accent-secondary);
}

.file-icon.link {
  color: var(--accent-primary);
}

/* 文件名 */
.file-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.symlink-badge {
  margin-left: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

/* 加载状态 */
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px;
  color: var(--text-muted);
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 空状态 */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 40px;
  color: var(--text-muted);
}

.empty-state svg {
  opacity: 0.5;
}

.empty-state .tip {
  font-size: 12px;
  opacity: 0.7;
}

/* 拖拽覆盖层 */
.drop-overlay {
  position: absolute;
  inset: 0;
  background: rgba(137, 180, 250, 0.1);
  border: 2px dashed var(--accent-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 10;
}

.drop-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--accent-primary);
}

.drop-hint p {
  font-size: 14px;
  font-weight: 500;
}

/* 选择信息 */
.selection-info {
  position: absolute;
  bottom: 8px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 12px;
  background: var(--accent-primary);
  color: white;
  font-size: 11px;
  border-radius: 12px;
  opacity: 0.9;
}
</style>

