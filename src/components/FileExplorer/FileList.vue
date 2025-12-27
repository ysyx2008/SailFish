<script setup lang="ts">
import { ref, computed } from 'vue'
import { Folder, FileText, Upload } from 'lucide-vue-next'
import type { SftpFileInfo } from '../../composables/useSftp'

const props = defineProps<{
  files: SftpFileInfo[]
  loading: boolean
  formatSize: (bytes: number) => string
  formatTime: (timestamp: number) => string
  formatPermissions: (perms: { user: string; group: string; other: string }) => string
}>()

const emit = defineEmits<{
  navigate: [path: string]
  download: [file: SftpFileInfo]
  contextmenu: [event: MouseEvent, file: SftpFileInfo]
  drop: [files: FileList]
}>()

// 排序状态
type SortKey = 'name' | 'size' | 'modifyTime' | 'permissions'
type SortOrder = 'asc' | 'desc'

const sortKey = ref<SortKey>('name')
const sortOrder = ref<SortOrder>('asc')

// 选中的文件
const selectedFile = ref<string | null>(null)

// 拖拽状态
const isDragOver = ref(false)

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
        compare = a.name.localeCompare(b.name)
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

// 双击处理
const handleDoubleClick = (file: SftpFileInfo) => {
  if (file.isDirectory) {
    emit('navigate', file.path)
  } else {
    emit('download', file)
  }
}

// 右键菜单
const handleContextMenu = (event: MouseEvent, file: SftpFileInfo) => {
  event.preventDefault()
  selectedFile.value = file.path
  emit('contextmenu', event, file)
}

// 选中文件
const handleClick = (file: SftpFileInfo) => {
  selectedFile.value = file.path
}

// 拖拽事件
const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
  isDragOver.value = true
}

const handleDragLeave = () => {
  isDragOver.value = false
}

const handleDrop = (e: DragEvent) => {
  e.preventDefault()
  isDragOver.value = false
  if (e.dataTransfer?.files.length) {
    emit('drop', e.dataTransfer.files)
  }
}

// 文件图标
const getFileIcon = (file: SftpFileInfo) => {
  if (file.isDirectory) {
    return 'folder'
  }
  if (file.isSymlink) {
    return 'link'
  }
  // 根据扩展名判断
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
</script>

<template>
  <div
    class="file-list"
    :class="{ 'drag-over': isDragOver }"
    @dragover="handleDragOver"
    @dragleave="handleDragLeave"
    @drop="handleDrop"
  >
    <!-- 表头 -->
    <div class="file-list-header">
      <div class="col col-name" @click="toggleSort('name')">
        名称 {{ getSortIcon('name') }}
      </div>
      <div class="col col-size" @click="toggleSort('size')">
        大小 {{ getSortIcon('size') }}
      </div>
      <div class="col col-time" @click="toggleSort('modifyTime')">
        修改时间 {{ getSortIcon('modifyTime') }}
      </div>
      <div class="col col-perms" @click="toggleSort('permissions')">
        权限 {{ getSortIcon('permissions') }}
      </div>
    </div>

    <!-- 文件列表 -->
    <div class="file-list-body">
      <!-- 加载中 -->
      <div v-if="loading" class="loading-state">
        <div class="spinner"></div>
        <span>加载中...</span>
      </div>

      <!-- 空目录 -->
      <div v-else-if="files.length === 0" class="empty-state">
        <Folder :size="48" :stroke-width="1.5" />
        <p>目录为空</p>
        <p class="tip">拖拽文件到此处上传</p>
      </div>

      <!-- 文件项 -->
      <div
        v-else
        v-for="file in sortedFiles"
        :key="file.path"
        class="file-item"
        :class="{ selected: selectedFile === file.path, directory: file.isDirectory }"
        @click="handleClick(file)"
        @dblclick="handleDoubleClick(file)"
        @contextmenu="handleContextMenu($event, file)"
      >
        <div class="col col-name">
          <span class="file-icon" :class="getFileIcon(file)">
            <Folder v-if="file.isDirectory" :size="16" fill="currentColor" />
            <FileText v-else :size="16" />
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
        <Upload :size="48" />
        <p>释放以上传文件</p>
      </div>
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

/* 表头 */
.file-list-header {
  display: flex;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
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
  width: 80px;
  text-align: right;
}

.col-time {
  width: 120px;
}

.col-perms {
  width: 80px;
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
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s;
}

.file-item:hover {
  background: var(--bg-surface);
}

.file-item.selected {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.file-item.directory {
  color: var(--text-primary);
}

/* 文件图标 */
.file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
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
</style>
