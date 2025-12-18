<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { SftpFileInfo } from '../../composables/useSftp'
import { toast } from '../../composables/useToast'

const props = defineProps<{
  show: boolean
  file: SftpFileInfo | null
  mode: 'properties' | 'chmod'
}>()

const emit = defineEmits<{
  close: []
  chmod: [path: string, mode: string]
}>()

// 权限编辑状态
const permissions = ref({
  user: { read: false, write: false, execute: false },
  group: { read: false, write: false, execute: false },
  other: { read: false, write: false, execute: false }
})

// 从文件信息初始化权限
watch(() => props.file, (file) => {
  if (file) {
    permissions.value = {
      user: {
        read: file.permissions.user.includes('r'),
        write: file.permissions.user.includes('w'),
        execute: file.permissions.user.includes('x')
      },
      group: {
        read: file.permissions.group.includes('r'),
        write: file.permissions.group.includes('w'),
        execute: file.permissions.group.includes('x')
      },
      other: {
        read: file.permissions.other.includes('r'),
        write: file.permissions.other.includes('w'),
        execute: file.permissions.other.includes('x')
      }
    }
  }
}, { immediate: true })

// 计算八进制权限
const octalPermission = computed(() => {
  const calcOctal = (perm: { read: boolean; write: boolean; execute: boolean }) => {
    return (perm.read ? 4 : 0) + (perm.write ? 2 : 0) + (perm.execute ? 1 : 0)
  }
  return `${calcOctal(permissions.value.user)}${calcOctal(permissions.value.group)}${calcOctal(permissions.value.other)}`
})

// 权限字符串显示
const permissionString = computed(() => {
  const toStr = (perm: { read: boolean; write: boolean; execute: boolean }) => {
    return (perm.read ? 'r' : '-') + (perm.write ? 'w' : '-') + (perm.execute ? 'x' : '-')
  }
  return toStr(permissions.value.user) + toStr(permissions.value.group) + toStr(permissions.value.other)
})

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`
}

// 格式化时间
const formatTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// 复制路径
const copyPath = async () => {
  if (props.file) {
    try {
      await navigator.clipboard.writeText(props.file.path)
      toast.success('路径已复制')
    } catch (e) {
      toast.error('复制失败')
    }
  }
}

// 保存权限
const savePermissions = () => {
  if (props.file) {
    emit('chmod', props.file.path, octalPermission.value)
    emit('close')
  }
}

// 关闭
const handleClose = () => {
  emit('close')
}

// 获取文件类型描述
const getFileType = (file: SftpFileInfo | null): string => {
  if (!file) return ''
  if (file.isSymlink) return '符号链接'
  if (file.isDirectory) return '目录'
  
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (!ext) return '文件'
  
  const types: Record<string, string> = {
    // 图片
    'jpg': '图片', 'jpeg': '图片', 'png': '图片', 'gif': '图片', 'webp': '图片', 'svg': '图片',
    // 文档
    'txt': '文本文件', 'md': 'Markdown 文档', 'pdf': 'PDF 文档', 'doc': 'Word 文档', 'docx': 'Word 文档',
    // 代码
    'js': 'JavaScript', 'ts': 'TypeScript', 'vue': 'Vue 组件', 'jsx': 'React JSX', 'tsx': 'React TSX',
    'py': 'Python', 'go': 'Go', 'rs': 'Rust', 'java': 'Java', 'cpp': 'C++', 'c': 'C', 'h': 'C/C++ 头文件',
    // 配置
    'json': 'JSON', 'xml': 'XML', 'yml': 'YAML', 'yaml': 'YAML', 'toml': 'TOML', 'ini': '配置文件',
    // 压缩
    'zip': 'ZIP 压缩包', 'tar': 'TAR 归档', 'gz': 'GZ 压缩包', '7z': '7z 压缩包', 'rar': 'RAR 压缩包',
    // 脚本
    'sh': 'Shell 脚本', 'bash': 'Bash 脚本', 'zsh': 'Zsh 脚本',
    // 其他
    'log': '日志文件', 'conf': '配置文件', 'css': 'CSS 样式表', 'html': 'HTML 文档'
  }
  
  return types[ext] || `${ext.toUpperCase()} 文件`
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="show && file" class="dialog-overlay" @click.self="handleClose">
        <Transition name="scale">
          <div v-if="show" class="properties-dialog">
            <!-- 标题栏 -->
            <div class="dialog-header">
              <h3>{{ mode === 'chmod' ? '修改权限' : '属性' }}</h3>
              <button class="btn-close" @click="handleClose">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </div>

            <!-- 内容区域 -->
            <div class="dialog-body">
              <!-- 文件信息（仅在属性模式显示完整信息） -->
              <template v-if="mode === 'properties'">
                <!-- 文件图标和名称 -->
                <div class="file-header">
                  <div class="file-icon" :class="{ directory: file.isDirectory }">
                    <svg v-if="file.isDirectory" width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
                    </svg>
                    <svg v-else width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                  </div>
                  <div class="file-name-info">
                    <span class="name" :title="file.name">{{ file.name }}</span>
                    <span class="type">{{ getFileType(file) }}</span>
                  </div>
                </div>

                <!-- 详细信息 -->
                <div class="info-section">
                  <div class="info-row">
                    <span class="label">路径</span>
                    <div class="value path-value">
                      <span :title="file.path">{{ file.path }}</span>
                      <button class="btn-copy" @click="copyPath" title="复制路径">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div class="info-row" v-if="!file.isDirectory">
                    <span class="label">大小</span>
                    <span class="value">{{ formatSize(file.size) }} ({{ file.size.toLocaleString() }} 字节)</span>
                  </div>

                  <div class="info-row">
                    <span class="label">修改时间</span>
                    <span class="value">{{ formatTime(file.modifyTime) }}</span>
                  </div>

                  <div class="info-row">
                    <span class="label">访问时间</span>
                    <span class="value">{{ formatTime(file.accessTime) }}</span>
                  </div>

                  <div class="info-row">
                    <span class="label">所有者</span>
                    <span class="value">{{ file.owner }} / {{ file.group }}</span>
                  </div>
                </div>

                <div class="section-divider"></div>
              </template>

              <!-- 权限编辑 -->
              <div class="permissions-section">
                <div class="section-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                  <span>权限设置</span>
                </div>

                <!-- 权限表格 -->
                <div class="permissions-table">
                  <div class="perm-header">
                    <span></span>
                    <span>读取 (r)</span>
                    <span>写入 (w)</span>
                    <span>执行 (x)</span>
                  </div>

                  <div class="perm-row">
                    <span class="perm-label">所有者</span>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.user.read">
                      <span class="checkmark"></span>
                    </label>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.user.write">
                      <span class="checkmark"></span>
                    </label>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.user.execute">
                      <span class="checkmark"></span>
                    </label>
                  </div>

                  <div class="perm-row">
                    <span class="perm-label">用户组</span>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.group.read">
                      <span class="checkmark"></span>
                    </label>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.group.write">
                      <span class="checkmark"></span>
                    </label>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.group.execute">
                      <span class="checkmark"></span>
                    </label>
                  </div>

                  <div class="perm-row">
                    <span class="perm-label">其他用户</span>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.other.read">
                      <span class="checkmark"></span>
                    </label>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.other.write">
                      <span class="checkmark"></span>
                    </label>
                    <label class="checkbox">
                      <input type="checkbox" v-model="permissions.other.execute">
                      <span class="checkmark"></span>
                    </label>
                  </div>
                </div>

                <!-- 权限预览 -->
                <div class="perm-preview">
                  <div class="preview-item">
                    <span class="preview-label">八进制</span>
                    <code>{{ octalPermission }}</code>
                  </div>
                  <div class="preview-item">
                    <span class="preview-label">符号表示</span>
                    <code>{{ permissionString }}</code>
                  </div>
                </div>
              </div>
            </div>

            <!-- 底部按钮 -->
            <div class="dialog-footer">
              <button class="btn btn-cancel" @click="handleClose">
                {{ mode === 'properties' ? '关闭' : '取消' }}
              </button>
              <button v-if="mode === 'chmod' || mode === 'properties'" class="btn btn-primary" @click="savePermissions">
                应用权限
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(2px);
}

.properties-dialog {
  width: 420px;
  max-width: 90vw;
  max-height: 85vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 标题栏 */
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
  color: var(--text-primary);
}

.btn-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  transition: all 0.2s;
}

.btn-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* 内容区域 */
.dialog-body {
  padding: 20px;
  overflow-y: auto;
}

/* 文件头部 */
.file-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
}

.file-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
}

.file-icon.directory {
  color: var(--accent-warning);
}

.file-name-info {
  flex: 1;
  min-width: 0;
}

.file-name-info .name {
  display: block;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-name-info .type {
  display: block;
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

/* 信息区域 */
.info-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 12px;
}

.info-row {
  display: flex;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
}

.info-row:last-child {
  border-bottom: none;
}

.info-row .label {
  width: 80px;
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-muted);
}

.info-row .value {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
  word-break: break-all;
}

.path-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.path-value span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-copy {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  transition: all 0.2s;
}

.btn-copy:hover {
  background: var(--bg-hover);
  color: var(--accent-primary);
}

/* 分隔线 */
.section-divider {
  height: 1px;
  background: var(--border-color);
  margin: 20px 0;
}

/* 权限区域 */
.permissions-section {
  /* margin-top: 16px; */
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin-bottom: 16px;
}

.section-title svg {
  color: var(--text-muted);
}

/* 权限表格 */
.permissions-table {
  background: var(--bg-tertiary);
  border-radius: 8px;
  overflow: hidden;
}

.perm-header,
.perm-row {
  display: grid;
  grid-template-columns: 80px repeat(3, 1fr);
  padding: 10px 12px;
  align-items: center;
}

.perm-header {
  background: var(--bg-hover);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.perm-header span:first-child {
  text-align: left;
}

.perm-row {
  border-bottom: 1px solid var(--border-color);
}

.perm-row:last-child {
  border-bottom: none;
}

.perm-label {
  font-size: 13px;
  color: var(--text-secondary);
}

/* 复选框 */
.checkbox {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.checkbox input {
  display: none;
}

.checkmark {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-color);
  border-radius: 4px;
  transition: all 0.2s;
  position: relative;
}

.checkbox input:checked + .checkmark {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.checkbox input:checked + .checkmark::after {
  content: '';
  position: absolute;
  left: 5px;
  top: 2px;
  width: 4px;
  height: 8px;
  border: solid white;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}

/* 权限预览 */
.perm-preview {
  display: flex;
  gap: 20px;
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preview-label {
  font-size: 12px;
  color: var(--text-muted);
}

.preview-item code {
  font-family: var(--font-mono);
  font-size: 14px;
  color: var(--accent-primary);
  background: var(--bg-secondary);
  padding: 4px 8px;
  border-radius: 4px;
}

/* 底部按钮 */
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

.btn {
  padding: 8px 20px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.btn-cancel {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}

.btn-cancel:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-primary {
  background: var(--accent-primary);
  color: white;
}

.btn-primary:hover {
  filter: brightness(1.1);
}

/* 动画 */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}

.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
