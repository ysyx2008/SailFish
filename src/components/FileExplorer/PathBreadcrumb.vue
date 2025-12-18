<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue'

const props = defineProps<{
  path: string
}>()

const emit = defineEmits<{
  navigate: [path: string]
}>()

// 编辑模式
const isEditing = ref(false)
const editPath = ref('')
const inputRef = ref<HTMLInputElement | null>(null)

// 解析路径为面包屑项
const breadcrumbs = computed(() => {
  const parts = props.path.split('/').filter(Boolean)
  const items: { name: string; path: string }[] = []

  // 添加根目录
  items.push({ name: '/', path: '/' })

  // 添加各级目录
  let currentPath = ''
  for (const part of parts) {
    currentPath += '/' + part
    items.push({ name: part, path: currentPath })
  }

  return items
})

// 点击导航
const handleClick = (path: string, event: MouseEvent) => {
  event.stopPropagation()
  emit('navigate', path)
}

// 点击空白区域进入编辑模式
const enterEditMode = () => {
  if (isEditing.value) return
  isEditing.value = true
  editPath.value = props.path
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}

// 提交路径
const submitPath = () => {
  const path = editPath.value.trim()
  isEditing.value = false
  if (path && path !== props.path) {
    // 确保路径以 / 开头
    const normalizedPath = path.startsWith('/') ? path : '/' + path
    emit('navigate', normalizedPath)
  }
}

// 取消编辑
const cancelEdit = () => {
  isEditing.value = false
  editPath.value = props.path
}

// 处理键盘事件
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    submitPath()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    cancelEdit()
  }
}

// 当路径变化时，如果在编辑模式则更新编辑路径
watch(() => props.path, (newPath) => {
  if (!isEditing.value) {
    editPath.value = newPath
  }
})
</script>

<template>
  <div class="path-breadcrumb" @click="enterEditMode">
    <!-- 编辑模式 -->
    <input
      v-if="isEditing"
      ref="inputRef"
      v-model="editPath"
      class="path-input"
      type="text"
      @blur="submitPath"
      @keydown="handleKeydown"
      @click.stop
    />
    <!-- 面包屑模式 -->
    <template v-else>
      <div class="breadcrumb-container">
        <template v-for="(item, index) in breadcrumbs" :key="item.path">
          <span
            class="breadcrumb-item"
            :class="{ active: index === breadcrumbs.length - 1 }"
            @click="handleClick(item.path, $event)"
            :title="item.path"
          >
            {{ item.name }}
          </span>
          <span v-if="index < breadcrumbs.length - 1" class="separator">/</span>
        </template>
      </div>
      <!-- 空白区域用于点击进入编辑模式 -->
      <div class="edit-hint" :title="'点击编辑路径'">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
      </div>
    </template>
  </div>
</template>

<style scoped>
.path-breadcrumb {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: 0 8px;
  font-size: 13px;
  color: var(--text-secondary);
  overflow: hidden;
  cursor: text;
  border-radius: 4px;
  transition: background 0.15s;
}

.path-breadcrumb:hover {
  background: var(--bg-hover);
}

.breadcrumb-container {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.path-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-primary);
  border: 1px solid var(--accent);
  border-radius: 4px;
  outline: none;
}

.path-input:focus {
  box-shadow: 0 0 0 2px var(--accent-alpha);
}

.breadcrumb-item {
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 150px;
  transition: all 0.15s;
}

.breadcrumb-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.breadcrumb-item.active {
  color: var(--text-primary);
  font-weight: 500;
}

.separator {
  margin: 0 2px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.edit-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  padding: 4px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.15s;
}

.path-breadcrumb:hover .edit-hint {
  opacity: 0.6;
}

.edit-hint:hover {
  opacity: 1 !important;
  color: var(--text-secondary);
}
</style>
