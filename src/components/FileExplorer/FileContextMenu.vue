<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { Download, Eye, Clipboard, Copy, Pencil, Trash2, Lock, Info, FolderPlus, RefreshCw } from 'lucide-vue-next'
import type { SftpFileInfo } from '../../composables/useSftp'
import { toast } from '../../composables/useToast'

const props = defineProps<{
  show: boolean
  x: number
  y: number
  file: SftpFileInfo | null
}>()

const emit = defineEmits<{
  close: []
  download: [file: SftpFileInfo]
  delete: [file: SftpFileInfo]
  rename: [file: SftpFileInfo]
  refresh: []
  newFolder: []
  preview: [file: SftpFileInfo]
  properties: [file: SftpFileInfo]
  chmod: [file: SftpFileInfo]
}>()

const menuRef = ref<HTMLElement | null>(null)

// 调整菜单位置，防止超出视口
const adjustedPosition = ref({ x: 0, y: 0 })

watch([() => props.show, () => props.x, () => props.y], () => {
  if (props.show) {
    // 延迟计算，等待 DOM 更新
    setTimeout(() => {
      if (menuRef.value) {
        const rect = menuRef.value.getBoundingClientRect()
        const viewportWidth = window.innerWidth
        const viewportHeight = window.innerHeight

        let x = props.x
        let y = props.y

        // 防止右边超出
        if (x + rect.width > viewportWidth) {
          x = viewportWidth - rect.width - 10
        }

        // 防止底部超出
        if (y + rect.height > viewportHeight) {
          y = viewportHeight - rect.height - 10
        }

        adjustedPosition.value = { x, y }
      }
    }, 0)
  }
}, { immediate: true })

// 点击外部关闭
const handleClickOutside = (e: MouseEvent) => {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

// ESC 关闭
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})

// 菜单项点击处理
const handleDownload = () => {
  if (props.file) {
    emit('download', props.file)
    emit('close')
  }
}

const handleDelete = () => {
  if (props.file) {
    emit('delete', props.file)
    emit('close')
  }
}

const handleRename = () => {
  if (props.file) {
    emit('rename', props.file)
    emit('close')
  }
}

const handleRefresh = () => {
  emit('refresh')
  emit('close')
}

const handleNewFolder = () => {
  emit('newFolder')
  emit('close')
}

const handlePreview = () => {
  if (props.file && !props.file.isDirectory) {
    emit('preview', props.file)
    emit('close')
  }
}

// 复制路径到剪贴板
const handleCopyPath = async () => {
  if (props.file) {
    try {
      await navigator.clipboard.writeText(props.file.path)
      toast.success('路径已复制')
    } catch (e) {
      toast.error('复制失败')
    }
    emit('close')
  }
}

// 复制文件名到剪贴板
const handleCopyName = async () => {
  if (props.file) {
    try {
      await navigator.clipboard.writeText(props.file.name)
      toast.success('文件名已复制')
    } catch (e) {
      toast.error('复制失败')
    }
    emit('close')
  }
}

// 查看属性
const handleProperties = () => {
  if (props.file) {
    emit('properties', props.file)
    emit('close')
  }
}

// 修改权限
const handleChmod = () => {
  if (props.file) {
    emit('chmod', props.file)
    emit('close')
  }
}

// 判断是否可预览（文本文件且小于 1MB）
const canPreview = (file: SftpFileInfo | null): boolean => {
  if (!file || file.isDirectory) return false
  if (file.size > 1024 * 1024) return false // 大于 1MB 不预览

  const ext = file.name.split('.').pop()?.toLowerCase()
  const previewExts = [
    'txt', 'md', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'log',
    'js', 'ts', 'vue', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h',
    'css', 'scss', 'less', 'html', 'sh', 'bash', 'zsh', 'fish'
  ]
  return ext ? previewExts.includes(ext) : false
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      ref="menuRef"
      class="context-menu"
      :style="{ left: adjustedPosition.x + 'px', top: adjustedPosition.y + 'px' }"
    >
      <!-- 文件操作 -->
      <template v-if="file">
        <button
          v-if="!file.isDirectory"
          class="menu-item"
          @click="handleDownload"
        >
          <Download :size="14" />
          <span>下载</span>
        </button>

        <button
          v-if="canPreview(file)"
          class="menu-item"
          @click="handlePreview"
        >
          <Eye :size="14" />
          <span>预览</span>
        </button>

        <div class="menu-divider"></div>

        <!-- 复制操作 -->
        <button class="menu-item" @click="handleCopyPath">
          <Clipboard :size="14" />
          <span>复制路径</span>
        </button>

        <button class="menu-item" @click="handleCopyName">
          <Copy :size="14" />
          <span>复制文件名</span>
        </button>

        <div class="menu-divider"></div>

        <button class="menu-item" @click="handleRename">
          <Pencil :size="14" />
          <span>重命名</span>
          <span class="shortcut">F2</span>
        </button>

        <button class="menu-item danger" @click="handleDelete">
          <Trash2 :size="14" />
          <span>删除</span>
          <span class="shortcut">Del</span>
        </button>

        <div class="menu-divider"></div>

        <!-- 属性和权限 -->
        <button class="menu-item" @click="handleChmod">
          <Lock :size="14" />
          <span>修改权限</span>
        </button>

        <button class="menu-item" @click="handleProperties">
          <Info :size="14" />
          <span>属性</span>
        </button>

        <div class="menu-divider"></div>
      </template>

      <!-- 通用操作 -->
      <button class="menu-item" @click="handleNewFolder">
        <FolderPlus :size="14" />
        <span>新建文件夹</span>
      </button>

      <button class="menu-item" @click="handleRefresh">
        <RefreshCw :size="14" />
        <span>刷新</span>
        <span class="shortcut">F5</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  min-width: 180px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  padding: 6px;
  z-index: 10000;
  animation: fadeIn 0.1s ease;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.menu-item:hover {
  background: var(--bg-hover);
}

.menu-item svg {
  color: var(--text-muted);
  flex-shrink: 0;
}

.menu-item:hover svg {
  color: var(--text-secondary);
}

.menu-item span:first-of-type {
  flex: 1;
}

.menu-item .shortcut {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: auto;
}

.menu-item.danger {
  color: var(--accent-error);
}

.menu-item.danger svg {
  color: var(--accent-error);
}

.menu-item.danger:hover {
  background: rgba(243, 139, 168, 0.15);
}

.menu-divider {
  height: 1px;
  background: var(--border-color);
  margin: 6px 0;
}
</style>
