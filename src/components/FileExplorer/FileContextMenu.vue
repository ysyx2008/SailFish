<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          <span>下载</span>
        </button>

        <button
          v-if="canPreview(file)"
          class="menu-item"
          @click="handlePreview"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <span>预览</span>
        </button>

        <div class="menu-divider"></div>

        <!-- 复制操作 -->
        <button class="menu-item" @click="handleCopyPath">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
          </svg>
          <span>复制路径</span>
        </button>

        <button class="menu-item" @click="handleCopyName">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
          <span>复制文件名</span>
        </button>

        <div class="menu-divider"></div>

        <button class="menu-item" @click="handleRename">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span>重命名</span>
          <span class="shortcut">F2</span>
        </button>

        <button class="menu-item danger" @click="handleDelete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
          <span>删除</span>
          <span class="shortcut">Del</span>
        </button>

        <div class="menu-divider"></div>

        <!-- 属性和权限 -->
        <button class="menu-item" @click="handleChmod">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span>修改权限</span>
        </button>

        <button class="menu-item" @click="handleProperties">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="16" x2="12" y2="12"/>
            <line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
          <span>属性</span>
        </button>

        <div class="menu-divider"></div>
      </template>

      <!-- 通用操作 -->
      <button class="menu-item" @click="handleNewFolder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          <line x1="12" y1="11" x2="12" y2="17"/>
          <line x1="9" y1="14" x2="15" y2="14"/>
        </svg>
        <span>新建文件夹</span>
      </button>

      <button class="menu-item" @click="handleRefresh">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
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
