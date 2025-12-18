<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  isLoading?: boolean
  isExpanded?: boolean
}

const props = defineProps<{
  type: 'local' | 'remote'
  currentPath: string
  sessionId: string
}>()

const emit = defineEmits<{
  navigate: [path: string]
}>()

// 树节点
const roots = ref<TreeNode[]>([])
const expandedPaths = ref<Set<string>>(new Set())
const isLoading = ref(false)

// 初始化
onMounted(async () => {
  await loadRoots()
})

// 当前路径变化时，自动展开路径
watch(() => props.currentPath, async (newPath) => {
  if (newPath) {
    await expandToPath(newPath)
  }
})

// 加载根目录
const loadRoots = async () => {
  isLoading.value = true
  try {
    if (props.type === 'local') {
      // 本地：获取常用目录和驱动器
      const folders = await window.electronAPI.localFs.getSpecialFolders()
      const drives = await window.electronAPI.localFs.getDrives()
      
      roots.value = [
        ...folders.map(f => ({
          name: f.name,
          path: f.path,
          isDirectory: true,
          icon: f.icon
        })),
        ...drives.map(d => ({
          name: d.name,
          path: d.path,
          isDirectory: true,
          icon: 'drive'
        }))
      ]
    } else {
      // 远程：只显示根目录
      roots.value = [{
        name: '/',
        path: '/',
        isDirectory: true
      }]
    }
  } finally {
    isLoading.value = false
  }
}

// 展开到指定路径
const expandToPath = async (targetPath: string) => {
  // 解析路径的每个部分
  const parts = targetPath.split(/[/\\]/).filter(Boolean)
  let currentPath = props.type === 'local' && targetPath.match(/^[A-Z]:/i) 
    ? parts[0] + '\\' 
    : '/'
  
  for (const part of parts.slice(props.type === 'local' && targetPath.match(/^[A-Z]:/i) ? 1 : 0)) {
    currentPath = props.type === 'local' 
      ? `${currentPath}${currentPath.endsWith('\\') ? '' : '\\'}${part}`
      : `${currentPath}${currentPath === '/' ? '' : '/'}${part}`
    
    if (!expandedPaths.value.has(currentPath)) {
      expandedPaths.value.add(currentPath)
    }
  }
}

// 加载子目录
const loadChildren = async (node: TreeNode): Promise<TreeNode[]> => {
  try {
    if (props.type === 'local') {
      const result = await window.electronAPI.localFs.list(node.path)
      if (result.success && result.data) {
        return result.data
          .filter(f => f.isDirectory)
          .map(f => ({
            name: f.name,
            path: f.path,
            isDirectory: true
          }))
      }
    } else {
      if (!props.sessionId) {
        console.warn('DirectoryTree: sessionId is required for remote type')
        return []
      }
      const result = await window.electronAPI.sftp.list(
        props.sessionId,
        node.path
      )
      if (result.success && result.data) {
        return result.data
          .filter(f => f.isDirectory)
          .map(f => ({
            name: f.name,
            path: f.path,
            isDirectory: true
          }))
      }
    }
  } catch (e) {
    console.error('加载子目录失败:', e)
  }
  return []
}

// 切换展开/折叠
const toggleExpand = async (node: TreeNode, e: Event) => {
  e.stopPropagation()
  
  const isExpanded = expandedPaths.value.has(node.path)
  
  if (isExpanded) {
    expandedPaths.value.delete(node.path)
  } else {
    expandedPaths.value.add(node.path)
    
    // 如果还没有加载子目录，加载它们
    if (!node.children) {
      node.isLoading = true
      node.children = await loadChildren(node)
      node.isLoading = false
    }
  }
}

// 选择节点
const selectNode = (node: TreeNode) => {
  emit('navigate', node.path)
}

// 判断节点是否是当前路径的祖先
const isAncestorOfCurrent = (nodePath: string): boolean => {
  if (!props.currentPath) return false
  return props.currentPath.startsWith(nodePath)
}

// 判断节点是否是当前路径
const isCurrentPath = (nodePath: string): boolean => {
  return props.currentPath === nodePath
}

// 判断节点是否展开
const isExpanded = (nodePath: string): boolean => {
  return expandedPaths.value.has(nodePath)
}

</script>

<template>
  <div class="directory-tree">
    <div v-if="isLoading" class="tree-loading">
      <div class="spinner-small"></div>
    </div>
    
    <template v-else>
      <!-- 根节点 -->
      <div
        v-for="root in roots"
        :key="root.path"
        class="tree-root"
      >
        <TreeNodeItem
          :node="root"
          :depth="0"
          :is-expanded="isExpanded(root.path)"
          :is-current="isCurrentPath(root.path)"
          :is-ancestor="isAncestorOfCurrent(root.path)"
          :type="type"
          :expanded-paths="expandedPaths"
          :current-path="currentPath"
          :session-id="sessionId"
          @toggle="toggleExpand"
          @select="selectNode"
          @load-children="loadChildren"
        />
      </div>
    </template>
  </div>
</template>

<script lang="ts">
// 递归组件
import { defineComponent, h, type VNode } from 'vue'

// TreeNode 接口（与 setup 脚本中的定义保持一致）
interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children?: TreeNode[]
  isLoading?: boolean
  isExpanded?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TreeNodeItem: any = defineComponent({
  name: 'TreeNodeItem',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    isExpanded: { type: Boolean, default: false },
    isCurrent: { type: Boolean, default: false },
    isAncestor: { type: Boolean, default: false },
    type: { type: String, required: true },
    expandedPaths: { type: Object, required: true },
    currentPath: { type: String, required: true },
    sessionId: { type: String, default: '' }
  },
  emits: ['toggle', 'select', 'loadChildren'],
  setup(props, { emit }): () => VNode {
    const handleToggle = async (e: Event) => {
      e.stopPropagation()
      
      const node = props.node as TreeNode
      const isExpanded = (props.expandedPaths as Set<string>).has(node.path)
      
      if (!isExpanded && !node.children) {
        // 先标记为加载中
        node.isLoading = true
        
        // 异步加载子目录
        try {
          if (props.type === 'local') {
            const result = await window.electronAPI.localFs.list(node.path)
            if (result.success && result.data) {
              node.children = result.data
                .filter((f: { isDirectory: boolean }) => f.isDirectory)
                .map((f: { name: string; path: string }) => ({
                  name: f.name,
                  path: f.path,
                  isDirectory: true
                }))
            }
          } else if (props.type === 'remote' && props.sessionId) {
            const result = await window.electronAPI.sftp.list(props.sessionId, node.path)
            if (result.success && result.data) {
              node.children = result.data
                .filter((f: { isDirectory: boolean }) => f.isDirectory)
                .map((f: { name: string; path: string }) => ({
                  name: f.name,
                  path: f.path,
                  isDirectory: true
                }))
            }
          }
        } finally {
          node.isLoading = false
        }
      }
      
      emit('toggle', node, e)
    }
    
    const handleSelect = () => {
      emit('select', props.node)
    }
    
    const isNodeExpanded = (path: string): boolean => {
      return (props.expandedPaths as Set<string>).has(path)
    }
    
    const isNodeCurrent = (path: string): boolean => {
      return props.currentPath === path
    }
    
    const isNodeAncestor = (path: string): boolean => {
      if (!props.currentPath) return false
      return props.currentPath.startsWith(path) && props.currentPath !== path
    }
    
    return () => {
      const node = props.node as TreeNode & { icon?: string }
      const expanded = isNodeExpanded(node.path)
      const current = isNodeCurrent(node.path)
      const ancestor = isNodeAncestor(node.path)
      
      return h('div', { class: 'tree-node-wrapper' }, [
        // 节点本身
        h('div', {
          class: ['tree-node', { expanded, current, ancestor }],
          style: { paddingLeft: `${props.depth * 16 + 8}px` },
          onClick: handleSelect
        }, [
          // 展开箭头
          h('span', {
            class: ['expand-arrow', { expanded, loading: node.isLoading }],
            onClick: handleToggle
          }, node.isLoading 
            ? h('span', { class: 'spinner-tiny' })
            : h('svg', {
                width: 12,
                height: 12,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                'stroke-width': 2
              }, [h('polyline', { points: '9 18 15 12 9 6' })])
          ),
          // 图标
          h('span', { class: 'node-icon' }, 
            node.icon 
              ? (node.icon === 'home' ? '🏠' : 
                 node.icon === 'desktop' ? '🖥️' : 
                 node.icon === 'documents' ? '📄' : 
                 node.icon === 'downloads' ? '⬇️' :
                 node.icon === 'applications' ? '📦' :
                 node.icon === 'drive' ? '💿' : '📁')
              : '📁'
          ),
          // 名称
          h('span', { class: 'node-name', title: node.path }, node.name)
        ]),
        // 子节点
        expanded && node.children && node.children.length > 0
          ? h('div', { class: 'tree-children' },
              node.children.map((child: TreeNode) =>
                h(TreeNodeItem, {
                  key: child.path,
                  node: child,
                  depth: props.depth + 1,
                  isExpanded: isNodeExpanded(child.path),
                  isCurrent: isNodeCurrent(child.path),
                  isAncestor: isNodeAncestor(child.path),
                  type: props.type,
                  expandedPaths: props.expandedPaths,
                  currentPath: props.currentPath,
                  sessionId: props.sessionId,
                  onToggle: (n: TreeNode, e: Event) => emit('toggle', n, e),
                  onSelect: (n: TreeNode) => emit('select', n),
                  onLoadChildren: (n: TreeNode) => emit('loadChildren', n)
                })
              )
            )
          : null
      ])
    }
  }
})

export default {
  components: { TreeNodeItem }
}
</script>

<style scoped>
.directory-tree {
  width: 200px;
  min-width: 150px;
  max-width: 300px;
  height: 100%;
  overflow: auto;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  padding: 8px 0;
}

.tree-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.spinner-small {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinner-tiny {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.tree-node-wrapper {
  user-select: none;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  transition: background 0.15s;
}

.tree-node:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tree-node.current {
  background: rgba(137, 180, 250, 0.15);
  color: var(--accent-primary);
  font-weight: 500;
}

.tree-node.current:hover {
  background: rgba(137, 180, 250, 0.2);
}

.tree-node.ancestor {
  color: var(--text-primary);
}

.tree-node.ancestor .node-icon {
  opacity: 0.9;
}

.expand-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.2s;
}

.expand-arrow.expanded {
  transform: rotate(90deg);
}

.expand-arrow.loading {
  transform: none;
}

.node-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.node-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-children {
  /* 子节点缩进由 padding-left 控制 */
}
</style>

