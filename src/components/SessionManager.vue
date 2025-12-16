<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type SshSession, type SessionGroup, type JumpHostConfig, type SshEncoding, type SessionSortBy } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()

// 可用的编码选项（与后端保持一致）
const encodingOptions: SshEncoding[] = [
  'utf-8',
  'gbk',
  'gb2312',
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'iso-8859-1',
  'iso-8859-15',
  'windows-1252',
  'koi8-r',
  'windows-1251'
]

// 分组编辑弹窗
const showGroupEditor = ref(false)
const editingGroup = ref<SessionGroup | null>(null)
const groupFormData = ref<Partial<SessionGroup & { jumpHost?: Partial<JumpHostConfig> }>>({
  name: '',
  jumpHost: undefined
})

const emit = defineEmits<{
  openSftp: [session: SshSession]
}>()

const showNewSession = ref(false)
const showNewMenu = ref(false)
const showImportMenu = ref(false)
const showSortMenu = ref(false)
const nameInputRef = ref<HTMLInputElement | null>(null)

// ESC 关闭弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    // 按优先级关闭弹窗，并阻止其他监听器被调用
    if (showNewSession.value) {
      e.stopImmediatePropagation()
      showNewSession.value = false
      resetForm()
    } else if (showGroupEditor.value) {
      e.stopImmediatePropagation()
      showGroupEditor.value = false
      resetGroupForm()
    } else if (showImportMenu.value) {
      e.stopImmediatePropagation()
      showImportMenu.value = false
    } else if (showNewMenu.value) {
      e.stopImmediatePropagation()
      showNewMenu.value = false
    }
  }
}

// 点击外部关闭菜单
const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.import-dropdown')) {
    showImportMenu.value = false
  }
  if (!target.closest('.new-dropdown')) {
    showNewMenu.value = false
  }
  if (!target.closest('.sort-dropdown')) {
    showSortMenu.value = false
  }
}

// 监听弹窗状态，添加/移除键盘事件
watch(showNewSession, (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', handleKeydown)
  } else {
    document.removeEventListener('keydown', handleKeydown)
  }
})

// 监听新建菜单状态
watch(showNewMenu, (isOpen) => {
  if (isOpen) {
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleKeydown)
  } else if (!showImportMenu.value) {
    document.removeEventListener('click', handleClickOutside)
  }
})

// 监听导入菜单状态
watch(showImportMenu, (isOpen) => {
  if (isOpen) {
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleKeydown)
  } else if (!showNewMenu.value && !showSortMenu.value) {
    document.removeEventListener('click', handleClickOutside)
  }
})

// 监听排序菜单状态
watch(showSortMenu, (isOpen) => {
  if (isOpen) {
    document.addEventListener('click', handleClickOutside)
  } else if (!showNewMenu.value && !showImportMenu.value) {
    document.removeEventListener('click', handleClickOutside)
  }
})

// 分组编辑弹窗名称输入框引用
const groupNameInputRef = ref<HTMLInputElement | null>(null)

// 监听分组编辑弹窗状态
watch(showGroupEditor, async (isOpen) => {
  if (isOpen) {
    document.addEventListener('keydown', handleKeydown)
    await nextTick()
    groupNameInputRef.value?.focus()
  } else {
    document.removeEventListener('keydown', handleKeydown)
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('click', handleClickOutside)
})
const editingSession = ref<SshSession | null>(null)
const searchText = ref('')

// ==================== 分组折叠 ====================
const collapsedGroups = ref<Set<string>>(new Set())
const savedCollapsedState = ref<Set<string> | null>(null)  // 拖拽前保存的折叠状态

// 切换分组折叠状态
const toggleGroupCollapse = (groupName: string) => {
  if (collapsedGroups.value.has(groupName)) {
    collapsedGroups.value.delete(groupName)
  } else {
    collapsedGroups.value.add(groupName)
  }
}

// ==================== 拖拽相关 ====================
const draggingSession = ref<SshSession | null>(null)
const dragOverGroupName = ref<string | null>(null)
const dragOverSessionId = ref<string | null>(null)
const dragOverPosition = ref<'before' | 'after'>('before')  // 拖放位置：目标前面或后面
const draggingGroupName = ref<string | null>(null)  // 使用分组名称而非对象
const dragOverTargetGroupName = ref<string | null>(null)

// 拖拽开始 - 主机
const handleDragStart = (session: SshSession, event: DragEvent) => {
  draggingSession.value = session
  draggingGroupName.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', session.id)
    event.dataTransfer.setData('application/x-session', 'true')
  }
  // 添加拖拽样式
  const target = event.target as HTMLElement
  setTimeout(() => {
    target.classList.add('dragging')
  }, 0)
}

// 拖拽开始 - 分组（支持默认分组）
const handleGroupDragStart = (groupName: string, event: DragEvent) => {
  draggingGroupName.value = groupName
  draggingSession.value = null
  
  // 保存当前折叠状态并折叠所有分组
  savedCollapsedState.value = new Set(collapsedGroups.value)
  const allGroupNames = Object.keys(groupedSessions.value)
  allGroupNames.forEach(name => {
    collapsedGroups.value.add(name)
  })
  
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', groupName)
    event.dataTransfer.setData('application/x-group', 'true')
  }
  const target = event.target as HTMLElement
  setTimeout(() => {
    target.classList.add('dragging')
  }, 0)
}

// 拖拽结束
const handleDragEnd = (event: DragEvent) => {
  // 恢复折叠状态
  if (savedCollapsedState.value !== null) {
    collapsedGroups.value = new Set(savedCollapsedState.value)
    savedCollapsedState.value = null
  }
  
  draggingSession.value = null
  draggingGroupName.value = null
  dragOverGroupName.value = null
  dragOverSessionId.value = null
  dragOverTargetGroupName.value = null
  const target = event.target as HTMLElement
  target.classList.remove('dragging')
}

// 拖拽经过分组
const handleDragOverGroup = (groupName: string, event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragOverGroupName.value = groupName
}

// 拖拽经过主机（用于组内排序）
const handleDragOverSession = (sessionId: string, event: DragEvent) => {
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  dragOverSessionId.value = sessionId
  
  // 检测鼠标在元素上的位置，判断是插入到前面还是后面
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const mouseY = event.clientY
  const threshold = rect.top + rect.height / 2
  dragOverPosition.value = mouseY < threshold ? 'before' : 'after'
}

// 拖拽离开分组
const handleDragLeaveGroup = () => {
  dragOverGroupName.value = null
}

// 拖拽经过分组标题（用于分组排序或会话拖入分组）
const handleDragOverGroupHeader = (targetGroupName: string, event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
  
  // 如果正在拖动分组
  if (draggingGroupName.value) {
    event.stopPropagation()
    dragOverTargetGroupName.value = targetGroupName
  } else if (draggingSession.value) {
    // 如果正在拖动会话，设置分组的拖放效果
    dragOverGroupName.value = targetGroupName
  }
}

// 放置到分组标题（分组排序）
const handleDropToGroupHeader = async (targetGroupName: string, event: DragEvent) => {
  event.preventDefault()
  dragOverTargetGroupName.value = null
  
  // 如果正在拖动会话（而不是分组），让事件冒泡到父元素处理
  if (!draggingGroupName.value) {
    // 手动调用 handleDropToGroup 来处理会话拖放到分组标题的情况
    if (draggingSession.value) {
      await handleDropToGroup(targetGroupName, event)
    }
    return
  }
  
  event.stopPropagation()
  
  if (draggingGroupName.value === targetGroupName) {
    draggingGroupName.value = null
    return
  }
  
  const defaultGroupName = t('session.defaultGroup')
  const defaultGroupOrder = configStore.defaultGroupSortOrder
  
  // 构建包含默认分组的完整分组列表
  type SortItem = { name: string; order: number; group: SessionGroup | null }
  const sortItems: SortItem[] = []
  
  // 添加已定义的分组
  const sortedGroupList = [...configStore.sessionGroups].sort((a, b) => 
    (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
  )
  sortedGroupList.forEach(g => {
    sortItems.push({ name: g.name, order: g.sortOrder ?? Infinity, group: g })
  })
  
  // 始终添加默认分组（无论是否有会话）
  sortItems.push({ 
    name: defaultGroupName, 
    order: defaultGroupOrder === -1 ? Infinity : defaultGroupOrder, 
    group: null 
  })
  
  // 按 order 排序
  sortItems.sort((a, b) => a.order - b.order)
  
  const dragIndex = sortItems.findIndex(item => item.name === draggingGroupName.value)
  const dropIndex = sortItems.findIndex(item => item.name === targetGroupName)
  
  if (dragIndex === -1 || dropIndex === -1) {
    draggingGroupName.value = null
    return
  }
  
  // 移动分组
  const [movedItem] = sortItems.splice(dragIndex, 1)
  sortItems.splice(dropIndex, 0, movedItem)
  
  // 更新所有分组的 sortOrder
  const updates: { id: string; sortOrder: number }[] = []
  let newDefaultGroupOrder = -1
  
  sortItems.forEach((item, index) => {
    if (item.group) {
      updates.push({ id: item.group.id, sortOrder: index })
    } else if (item.name === defaultGroupName) {
      newDefaultGroupOrder = index
    }
  })
  
  // 更新有实体的分组
  if (updates.length > 0) {
    await configStore.updateGroupsSortOrder(updates)
  }
  
  // 更新默认分组的排序位置
  if (newDefaultGroupOrder !== configStore.defaultGroupSortOrder) {
    await configStore.setDefaultGroupSortOrder(newDefaultGroupOrder)
  }
  
  draggingGroupName.value = null
}

// 放置到主机位置（组内排序或跨分组拖放到指定位置）
const handleDropToSession = async (targetSessionId: string, groupName: string, event: DragEvent) => {
  event.preventDefault()
  event.stopPropagation()
  dragOverSessionId.value = null
  dragOverGroupName.value = null
  
  if (!draggingSession.value || draggingSession.value.id === targetSessionId) {
    return
  }
  
  // 只有在自定义排序模式下才支持拖拽排序
  if (configStore.sessionSortBy !== 'custom') {
    await configStore.setSessionSortBy('custom')
  }
  
  const groupData = groupedSessions.value[groupName]
  if (!groupData) return
  
  const targetGroupId = groupData.group?.id
  const sourceGroupId = draggingSession.value.groupId
  const isCrossGroup = sourceGroupId !== targetGroupId
  const draggedSessionId = draggingSession.value.id
  
  // 获取目标分组中的会话（不包含被拖动的会话）
  const targetGroupSessions = configStore.sshSessions.filter(s => {
    if (s.id === draggedSessionId) return false // 排除被拖动的会话
    const gId = s.groupId
    return gId === targetGroupId || (!gId && !targetGroupId)
  })
  
  // 按 sortOrder 排序
  const sortedSessions = [...targetGroupSessions].sort((a, b) => 
    (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
  )
  
  // 找到目标位置
  const dropIndex = sortedSessions.findIndex(s => s.id === targetSessionId)
  if (dropIndex === -1) return
  
  // 根据鼠标位置决定插入到目标的前面还是后面
  const insertIndex = dragOverPosition.value === 'before' ? dropIndex : dropIndex + 1
  
  // 在目标位置插入被拖动会话的 ID（用于计算 sortOrder）
  const newOrder: string[] = sortedSessions.map(s => s.id)
  newOrder.splice(insertIndex, 0, draggedSessionId)
  
  // 更新被拖动会话的分组（如果是跨分组）
  if (isCrossGroup) {
    await configStore.updateSshSession({
      ...draggingSession.value,
      groupId: targetGroupId,
      group: undefined,
      sortOrder: dropIndex // 临时设置，后面会被覆盖
    })
  }
  
  // 更新所有会话的 sortOrder
  const updates: { id: string; sortOrder: number }[] = newOrder.map((id, index) => ({
    id,
    sortOrder: index
  }))
  
  await configStore.updateSessionsSortOrder(updates)
}

// 放置到分组
const handleDropToGroup = async (groupName: string, event: DragEvent) => {
  event.preventDefault()
  dragOverGroupName.value = null
  
  // 如果是分组拖拽，忽略
  if (draggingGroupName.value) return
  
  if (!draggingSession.value) return
  
  const session = draggingSession.value
  const groupData = groupedSessions.value[groupName]
  
  // 获取目标分组的 ID
  let targetGroupId: string | undefined = undefined
  if (groupData?.group) {
    targetGroupId = groupData.group.id
  }
  
  // 如果分组没有变化，不需要更新
  const currentGroupId = session.groupId || undefined
  if (currentGroupId === targetGroupId) {
    draggingSession.value = null
    return
  }
  
  // 更新主机的分组，并设置为最后一个
  const targetGroupSessions = configStore.sshSessions.filter(s => s.groupId === targetGroupId)
  const maxOrder = Math.max(...targetGroupSessions.map(s => s.sortOrder ?? 0), -1)
  
  await configStore.updateSshSession({
    ...session,
    groupId: targetGroupId,
    group: undefined,
    sortOrder: maxOrder + 1
  })
  
  draggingSession.value = null
}

// 切换排序方式
const handleSortChange = async (sortBy: SessionSortBy) => {
  await configStore.setSessionSortBy(sortBy)
  showSortMenu.value = false
}

// 表单数据
const formData = ref<Partial<SshSession>>({
  name: '',
  host: '',
  port: 22,
  username: '',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  groupId: '',
  encoding: 'utf-8'
})

// 过滤后的会话列表
const filteredSessions = computed(() => {
  const text = searchText.value.toLowerCase()
  if (!text) return configStore.sshSessions
  return configStore.sshSessions.filter(
    s =>
      s.name.toLowerCase().includes(text) ||
      s.host.toLowerCase().includes(text) ||
      s.username.toLowerCase().includes(text)
  )
})

// 对会话进行排序
const sortSessions = (sessions: SshSession[]): SshSession[] => {
  const sortBy = configStore.sessionSortBy
  const sorted = [...sessions]
  
  switch (sortBy) {
    case 'name':
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      break
    case 'name-desc':
      sorted.sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'))
      break
    case 'lastUsed':
      sorted.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
      break
    case 'custom':
    default:
      sorted.sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
      break
  }
  
  return sorted
}

// 排序后的分组列表（包含默认分组）
const sortedGroups = computed(() => {
  const defaultGroupName = t('session.defaultGroup')
  const defaultGroupOrder = configStore.defaultGroupSortOrder
  
  // 获取所有分组并排序
  const groups = [...configStore.sessionGroups].sort((a, b) => 
    (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)
  )
  
  // 构建包含默认分组位置信息的结果
  return { groups, defaultGroupName, defaultGroupOrder }
})

// 按组分类的会话
const groupedSessions = computed(() => {
  const groups: Record<string, { group: SessionGroup | null; sessions: SshSession[] }> = {}
  const { groups: sortedGroupList, defaultGroupName, defaultGroupOrder } = sortedGroups.value
  
  // 先添加所有已定义的分组（按排序顺序）
  sortedGroupList.forEach(group => {
    groups[group.name] = { group, sessions: [] }
  })
  
  // 始终添加默认分组（即使为空）
  if (!groups[defaultGroupName]) {
    groups[defaultGroupName] = { group: null, sessions: [] }
  }
  
  filteredSessions.value.forEach(session => {
    // 优先使用 groupId，否则使用旧的 group 字段
    let groupName = defaultGroupName
    let groupEntity: SessionGroup | null = null
    
    if (session.groupId) {
      const found = configStore.sessionGroups.find(g => g.id === session.groupId)
      if (found) {
        groupName = found.name
        groupEntity = found
      }
    } else if (session.group) {
      groupName = session.group
      // 尝试查找对应的分组实体
      groupEntity = configStore.sessionGroups.find(g => g.name === session.group) || null
    }
    
    if (!groups[groupName]) {
      groups[groupName] = { group: groupEntity, sessions: [] }
    }
    groups[groupName].sessions.push(session)
  })
  
  // 对每个分组内的会话进行排序
  for (const groupName of Object.keys(groups)) {
    groups[groupName].sessions = sortSessions(groups[groupName].sessions)
  }
  
  // 构建排序项数组（分组名称 + 排序值）
  type SortItem = { name: string; order: number }
  const sortItems: SortItem[] = []
  
  sortedGroupList.forEach(group => {
    if (groups[group.name]) {
      sortItems.push({ name: group.name, order: group.sortOrder ?? Infinity })
    }
  })
  
  // 始终添加默认分组
  sortItems.push({ name: defaultGroupName, order: defaultGroupOrder === -1 ? Infinity : defaultGroupOrder })
  
  // 添加其他未定义的分组
  Object.keys(groups).forEach(groupName => {
    if (!sortItems.find(item => item.name === groupName)) {
      sortItems.push({ name: groupName, order: Infinity })
    }
  })
  
  // 按 order 排序
  sortItems.sort((a, b) => a.order - b.order)
  
  // 返回有序的分组对象
  const orderedGroups: typeof groups = {}
  sortItems.forEach(item => {
    if (groups[item.name]) {
      orderedGroups[item.name] = groups[item.name]
    }
  })
  
  return orderedGroups
})

// 重置表单
const resetForm = () => {
  formData.value = {
    name: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    groupId: '',
    encoding: 'utf-8'
  }
  editingSession.value = null
}

// 打开新建会话
const openNewSession = async () => {
  resetForm()
  showNewSession.value = true
  await nextTick()
  nameInputRef.value?.focus()
}

// 打开编辑会话
const openEditSession = async (session: SshSession) => {
  editingSession.value = session
  formData.value = { ...session }
  showNewSession.value = true
  await nextTick()
  nameInputRef.value?.focus()
}

// 保存会话
const saveSession = async () => {
  if (!formData.value.name || !formData.value.host || !formData.value.username) {
    return
  }

  if (editingSession.value) {
    // 更新
    await configStore.updateSshSession({
      ...editingSession.value,
      ...formData.value
    } as SshSession)
  } else {
    // 新建
    await configStore.addSshSession({
      id: uuidv4(),
      ...formData.value
    } as SshSession)
  }

  showNewSession.value = false
  resetForm()
}

// 删除会话
const deleteSession = async (session: SshSession) => {
  if (confirm(t('session.confirmDeleteHost', { name: session.name }))) {
    await configStore.deleteSshSession(session.id)
  }
}

// 连接会话
const connectSession = async (session: SshSession) => {
  // 更新最近使用时间
  await configStore.updateSessionLastUsed(session.id)
  
  // 获取有效的跳板机配置
  const jumpHost = configStore.getEffectiveJumpHost(session)
  
  await terminalStore.createTab('ssh', {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKey: session.privateKeyPath,
    jumpHost,  // 传递跳板机配置
    encoding: session.encoding || 'utf-8',  // 传递编码配置
    sessionId: session.id  // 传递会话 ID（用于重连）
  })
}

// 打开 SFTP 文件管理
const openSftp = (session: SshSession) => {
  emit('openSftp', session)
}

// 创建本地终端
const createLocalTerminal = () => {
  terminalStore.createTab('local')
}

// 导入 Xshell 会话文件
const importXshellFiles = async () => {
  showImportMenu.value = false
  const result = await window.electronAPI.xshell.selectFiles()
  if (result.canceled) return
  
  const importResult = await window.electronAPI.xshell.importFiles(result.filePaths)
  await handleImportResult(importResult)
}

// 导入 Xshell 会话目录
const importXshellDirectory = async () => {
  showImportMenu.value = false
  const result = await window.electronAPI.xshell.selectDirectory()
  if (result.canceled) return
  
  const importResult = await window.electronAPI.xshell.importDirectory(result.dirPath)
  await handleImportResult(importResult)
}

// 处理导入结果
const handleImportResult = async (importResult: { success: boolean; sessions: any[]; errors: string[] }) => {
  if (!importResult.success && importResult.sessions.length === 0) {
    alert(`${t('session.importFailed')}：${importResult.errors.join('\n')}`)
    return
  }
  
  // 将导入的会话添加到列表
  let importedCount = 0
  for (const session of importResult.sessions) {
    await configStore.addSshSession({
      id: uuidv4(),
      name: session.name,
      host: session.host,
      port: session.port,
      username: session.username,
      authType: session.privateKeyPath ? 'privateKey' : 'password',
      password: session.password,
      privateKeyPath: session.privateKeyPath,
      group: session.group
    })
    importedCount++
  }
  
  // 显示结果
  let message = t('session.importSuccess', { count: importedCount })
  if (importResult.errors.length > 0) {
    message += `\n\n${t('session.importPartialFailed')}\n${importResult.errors.join('\n')}`
  }
  alert(message)
}

// ==================== 分组管理 ====================

// 新建分组
const openNewGroup = () => {
  editingGroup.value = null
  groupFormData.value = {
    name: '',
    jumpHost: undefined
  }
  showGroupEditor.value = true
}

// 打开分组编辑弹窗
const openGroupEditor = (groupName: string) => {
  const groupData = groupedSessions.value[groupName]
  if (groupData?.group) {
    // 编辑已有分组
    editingGroup.value = groupData.group
    groupFormData.value = {
      name: groupData.group.name,
      jumpHost: groupData.group.jumpHost ? { ...groupData.group.jumpHost } : undefined
    }
  } else {
    // 创建新分组
    editingGroup.value = null
    groupFormData.value = {
      name: groupName === t('session.defaultGroup') ? '' : groupName,
      jumpHost: undefined
    }
  }
  showGroupEditor.value = true
}

// 重置分组表单
const resetGroupForm = () => {
  groupFormData.value = {
    name: '',
    jumpHost: undefined
  }
  editingGroup.value = null
}

// 启用/禁用跳板机
const toggleJumpHost = (enabled: boolean) => {
  if (enabled) {
    groupFormData.value.jumpHost = {
      host: '',
      port: 22,
      username: '',
      authType: 'password'
    }
  } else {
    groupFormData.value.jumpHost = undefined
  }
}

// 保存分组
const saveGroup = async () => {
  if (!groupFormData.value.name) {
    alert(t('session.pleaseInputGroupName'))
    return
  }

  // 验证跳板机配置
  if (groupFormData.value.jumpHost) {
    const jh = groupFormData.value.jumpHost
    if (!jh.host || !jh.username) {
      alert(t('session.pleaseInputJumpHostInfo'))
      return
    }
  }

  const groupData: SessionGroup = {
    id: editingGroup.value?.id || uuidv4(),
    name: groupFormData.value.name,
    jumpHost: groupFormData.value.jumpHost as JumpHostConfig | undefined
  }

  if (editingGroup.value) {
    await configStore.updateSessionGroup(groupData)
  } else {
    await configStore.addSessionGroup(groupData)
    
    // 更新使用旧 group 字段的会话，让它们使用新的 groupId
    const sessionsToUpdate = configStore.sshSessions.filter(
      s => s.group === groupFormData.value.name && !s.groupId
    )
    for (const session of sessionsToUpdate) {
      await configStore.updateSshSession({
        ...session,
        groupId: groupData.id
      })
    }
  }

  showGroupEditor.value = false
  resetGroupForm()
}

// 删除分组
const deleteGroup = async (groupName: string) => {
  const groupData = groupedSessions.value[groupName]
  if (!groupData?.group) return
  
  if (confirm(t('session.confirmDeleteGroupNamed', { name: groupName }))) {
    await configStore.deleteSessionGroup(groupData.group.id)
    showGroupEditor.value = false
    resetGroupForm()
  }
}
</script>

<template>
  <div class="session-manager">
    <!-- 搜索和操作栏 -->
    <div class="session-toolbar">
      <input
        v-model="searchText"
        type="text"
        class="input search-input"
        :placeholder="t('session.searchPlaceholder')"
      />
      <div class="new-dropdown">
        <button class="btn btn-primary btn-sm" @click="showNewMenu = !showNewMenu">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          {{ t('common.new') }}
        </button>
        <div v-if="showNewMenu" class="new-menu" @click.stop>
          <button class="new-menu-item" @click="openNewSession(); showNewMenu = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            {{ t('session.newHost') }}
          </button>
          <button class="new-menu-item" @click="openNewGroup(); showNewMenu = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              <line x1="12" y1="11" x2="12" y2="17"/>
              <line x1="9" y1="14" x2="15" y2="14"/>
            </svg>
            {{ t('session.newGroup') }}
          </button>
        </div>
      </div>
      <div class="import-dropdown">
        <button class="btn btn-sm" @click="showImportMenu = !showImportMenu">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
          {{ t('common.import') }}
        </button>
        <div v-if="showImportMenu" class="import-menu" @click.stop>
          <button class="import-menu-item" @click="importXshellFiles">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            {{ t('session.importXshellFiles') }}
          </button>
          <button class="import-menu-item" @click="importXshellDirectory">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            {{ t('session.importXshellDir') }}
          </button>
        </div>
      </div>
      <div class="sort-dropdown">
        <button class="btn btn-sm btn-icon-only" @click="showSortMenu = !showSortMenu" :title="t('session.sort.title')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="4" y1="6" x2="20" y2="6"/>
            <line x1="4" y1="12" x2="14" y2="12"/>
            <line x1="4" y1="18" x2="8" y2="18"/>
          </svg>
        </button>
        <div v-if="showSortMenu" class="sort-menu" @click.stop>
          <button 
            class="sort-menu-item" 
            :class="{ active: configStore.sessionSortBy === 'custom' }"
            @click="handleSortChange('custom')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="8" y1="13" x2="16" y2="13"/>
              <line x1="8" y1="17" x2="16" y2="17"/>
            </svg>
            {{ t('session.sort.custom') }}
          </button>
          <button 
            class="sort-menu-item"
            :class="{ active: configStore.sessionSortBy === 'name' }"
            @click="handleSortChange('name')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18"/>
              <path d="M3 12h12"/>
              <path d="M3 18h6"/>
            </svg>
            {{ t('session.sort.nameAsc') }}
          </button>
          <button 
            class="sort-menu-item"
            :class="{ active: configStore.sessionSortBy === 'name-desc' }"
            @click="handleSortChange('name-desc')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h6"/>
              <path d="M3 12h12"/>
              <path d="M3 18h18"/>
            </svg>
            {{ t('session.sort.nameDesc') }}
          </button>
          <button 
            class="sort-menu-item"
            :class="{ active: configStore.sessionSortBy === 'lastUsed' }"
            @click="handleSortChange('lastUsed')"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <polyline points="12 6 12 12 16 14"/>
            </svg>
            {{ t('session.sort.lastUsed') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 快速操作 -->
    <div class="quick-connect">
      <button class="quick-btn" @click="createLocalTerminal">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="4 17 10 11 4 5"/>
          <line x1="12" y1="19" x2="20" y2="19"/>
        </svg>
        <span>{{ t('terminal.localTerminal') }}</span>
      </button>
    </div>

    <!-- 会话列表 -->
    <div class="session-list">
      <template v-if="Object.keys(groupedSessions).length > 0">
        <div
          v-for="(groupData, groupName) in groupedSessions"
          :key="groupName"
          class="session-group"
          :class="{ 
            'drag-over': dragOverGroupName === groupName && !draggingGroupName,
            'is-empty': groupData.sessions.length === 0
          }"
          @dragover="handleDragOverGroup(groupName as string, $event)"
          @dragleave="handleDragLeaveGroup"
          @drop="handleDropToGroup(groupName as string, $event)"
        >
          <div 
            class="group-header" 
            :class="{ 
              'draggable': true,
              'drag-over': dragOverTargetGroupName === groupName 
            }"
            draggable="true"
            @dragstart="handleGroupDragStart(groupName as string, $event)"
            @dragend="handleDragEnd"
            @dragover="handleDragOverGroupHeader(groupName as string, $event)"
            @drop="handleDropToGroupHeader(groupName as string, $event)"
          >
            <div class="group-header-left" @click.stop="toggleGroupCollapse(groupName as string)">
              <svg class="drag-handle" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="9" cy="5" r="1"/>
                <circle cx="9" cy="12" r="1"/>
                <circle cx="9" cy="19" r="1"/>
                <circle cx="15" cy="5" r="1"/>
                <circle cx="15" cy="12" r="1"/>
                <circle cx="15" cy="19" r="1"/>
              </svg>
              <svg 
                class="collapse-icon" 
                :class="{ collapsed: collapsedGroups.has(groupName as string) }"
                width="12" height="12" 
                viewBox="0 0 24 24" 
                fill="none" 
                stroke="currentColor" 
                stroke-width="2"
              >
                <polyline points="6 9 12 15 18 9"/>
              </svg>
              <span class="group-name">{{ groupName }}</span>
              <span class="group-count">{{ groupData.sessions.length }}</span>
              <span v-if="groupData.group?.jumpHost" class="jump-host-badge" :title="t('session.form.jumpHost')">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
                {{ groupData.group.jumpHost.host }}
              </span>
            </div>
            <div class="group-header-right">
              <button class="btn-icon btn-xs" @click.stop="openGroupEditor(groupName)" :title="t('session.editGroup')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="3"/>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="group-sessions" v-show="!collapsedGroups.has(groupName as string)">
            <div
              v-for="session in groupData.sessions"
              :key="session.id"
              class="session-item"
              :class="{ 
                'drag-over-before': dragOverSessionId === session.id && dragOverPosition === 'before',
                'drag-over-after': dragOverSessionId === session.id && dragOverPosition === 'after'
              }"
              draggable="true"
              @dragstart="handleDragStart(session, $event)"
              @dragover="handleDragOverSession(session.id, $event)"
              @drop="handleDropToSession(session.id, groupName as string, $event)"
              @dragend="handleDragEnd"
              @dblclick="connectSession(session)"
            >
              <div class="session-icon">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                  <line x1="8" y1="21" x2="16" y2="21"/>
                  <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>
              </div>
              <div class="session-info">
                <div class="session-name">{{ session.name }}</div>
                <div class="session-host">{{ session.username }}@{{ session.host }}{{ session.port !== 22 ? ':' + session.port : '' }}</div>
              </div>
              <div class="session-actions">
                <button class="btn-icon btn-sm" @click.stop="connectSession(session)" :title="t('session.connect')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                </button>
                <button class="btn-icon btn-sm" @click.stop="openSftp(session)" :title="t('session.fileManager')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                  </svg>
                </button>
                <button class="btn-icon btn-sm" @click.stop="openEditSession(session)" :title="t('common.edit')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>
                <button class="btn-icon btn-sm" @click.stop="deleteSession(session)" :title="t('common.delete')">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="empty-sessions">
        <template v-if="searchText">
          <p>{{ t('session.noMatchingHosts') }}</p>
          <p class="tip">{{ t('session.tryOtherKeywords') }}</p>
        </template>
        <template v-else>
          <p>{{ t('session.noHostsSaved') }}</p>
          <p class="tip">{{ t('session.noHostsHint') }}</p>
        </template>
      </div>
    </div>

    <!-- 新建/编辑会话弹窗 -->
    <div v-if="showNewSession" class="modal-overlay" @click.self="showNewSession = false">
      <div class="modal session-modal">
        <div class="modal-header">
          <h3>{{ editingSession ? t('session.editHost') : t('session.newHost') }}</h3>
          <button class="btn-icon" @click="showNewSession = false" :title="t('common.close')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">{{ t('session.form.name') }} *</label>
            <input ref="nameInputRef" v-model="formData.name" type="text" class="input" :placeholder="t('session.form.sessionNamePlaceholder')" />
          </div>
          <div class="form-row">
            <div class="form-group" style="flex: 2">
              <label class="form-label">{{ t('session.form.host') }} *</label>
              <input v-model="formData.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
            </div>
            <div class="form-group" style="flex: 1">
              <label class="form-label">{{ t('session.form.port') }}</label>
              <input v-model.number="formData.port" type="number" class="input" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.username') }} *</label>
            <input v-model="formData.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.authType') }}</label>
            <select v-model="formData.authType" class="select">
              <option value="password">{{ t('session.form.authPassword') }}</option>
              <option value="privateKey">{{ t('session.form.authKey') }}</option>
            </select>
          </div>
          <div v-if="formData.authType === 'password'" class="form-group">
            <label class="form-label">{{ t('session.form.password') }}</label>
            <input v-model="formData.password" type="password" class="input" />
          </div>
          <template v-else>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
              <input v-model="formData.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
              <input v-model="formData.passphrase" type="password" class="input" />
            </div>
          </template>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.group') }}</label>
            <select v-model="formData.groupId" class="select">
              <option value="">{{ t('session.defaultGroup') }}</option>
              <option v-for="group in configStore.sessionGroups" :key="group.id" :value="group.id">
                {{ group.name }}
                <template v-if="group.jumpHost"> ({{ t('session.form.jumpHost') }}: {{ group.jumpHost.host }})</template>
              </option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.encoding') }}</label>
            <select v-model="formData.encoding" class="select">
              <option v-for="enc in encodingOptions" :key="enc" :value="enc">
                {{ t(`session.form.encodings.${enc}`) }}
              </option>
            </select>
            <span class="form-hint">{{ t('session.form.encodingHint') }}</span>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="showNewSession = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="saveSession">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>

    <!-- 分组编辑弹窗 -->
    <div v-if="showGroupEditor" class="modal-overlay" @click.self="showGroupEditor = false">
      <div class="modal session-modal">
        <div class="modal-header">
          <h3>{{ editingGroup ? t('session.editGroup') : (groupFormData.name ? t('session.configGroup') : t('session.newGroup')) }}</h3>
          <button class="btn-icon" @click="showGroupEditor = false" :title="t('common.close')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">{{ t('session.form.groupName') }} *</label>
            <input ref="groupNameInputRef" v-model="groupFormData.name" type="text" class="input" :placeholder="t('session.form.groupNamePlaceholder')" />
          </div>
          
          <!-- 跳板机配置 -->
          <div class="form-section">
            <div class="form-section-header">
              <label class="checkbox-label">
                <input 
                  type="checkbox" 
                  :checked="!!groupFormData.jumpHost"
                  @change="toggleJumpHost(($event.target as HTMLInputElement).checked)"
                />
                <span>{{ t('session.form.jumpHostEnable') }}</span>
              </label>
              <span class="form-section-hint">{{ t('session.form.jumpHostHint') }}</span>
            </div>
            
            <template v-if="groupFormData.jumpHost">
              <div class="form-row">
                <div class="form-group" style="flex: 2">
                  <label class="form-label">{{ t('session.form.jumpHostHost') }} *</label>
                  <input v-model="groupFormData.jumpHost.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
                </div>
                <div class="form-group" style="flex: 1">
                  <label class="form-label">{{ t('session.form.port') }}</label>
                  <input v-model.number="groupFormData.jumpHost.port" type="number" class="input" />
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.username') }} *</label>
                <input v-model="groupFormData.jumpHost.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.authType') }}</label>
                <select v-model="groupFormData.jumpHost.authType" class="select">
                  <option value="password">{{ t('session.form.authPassword') }}</option>
                  <option value="privateKey">{{ t('session.form.authKey') }}</option>
                </select>
              </div>
              <div v-if="groupFormData.jumpHost.authType === 'password'" class="form-group">
                <label class="form-label">{{ t('session.form.password') }}</label>
                <input v-model="groupFormData.jumpHost.password" type="password" class="input" />
              </div>
              <template v-else>
                <div class="form-group">
                  <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
                  <input v-model="groupFormData.jumpHost.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
                </div>
                <div class="form-group">
                  <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
                  <input v-model="groupFormData.jumpHost.passphrase" type="password" class="input" />
                </div>
              </template>
            </template>
          </div>
        </div>
        <div class="modal-footer">
          <button v-if="editingGroup" class="btn btn-danger" @click="deleteGroup(editingGroup.name)">{{ t('session.deleteGroup') }}</button>
          <div style="flex: 1"></div>
          <button class="btn" @click="showGroupEditor = false">{{ t('common.cancel') }}</button>
          <button class="btn btn-primary" @click="saveGroup">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.session-toolbar {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.search-input {
  flex: 1;
  height: 32px;
  box-sizing: border-box;
}

/* 工具栏按钮统一样式 */
.session-toolbar .btn {
  height: 32px;
  min-width: fit-content;
  white-space: nowrap;
}

/* 新建下拉菜单 */
.new-dropdown {
  position: relative;
}

.new-menu {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 4px;
  min-width: 140px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  overflow: hidden;
}

.new-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}

.new-menu-item:hover {
  background: var(--bg-surface);
}

.new-menu-item svg {
  color: var(--text-muted);
}

/* 导入下拉菜单 */
.import-dropdown {
  position: relative;
}

.import-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 180px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  overflow: hidden;
}

.import-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}

.import-menu-item:hover {
  background: var(--bg-surface);
}

.import-menu-item svg {
  color: var(--text-muted);
}

/* 排序下拉菜单 */
.sort-dropdown {
  position: relative;
}

.btn-icon-only {
  padding: 0 8px;
  min-width: 32px;
}

.sort-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  overflow: hidden;
}

.sort-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease;
}

.sort-menu-item:hover {
  background: var(--bg-surface);
}

.sort-menu-item.active {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.1);
}

.sort-menu-item svg {
  color: var(--text-muted);
}

.sort-menu-item.active svg {
  color: var(--accent-primary);
}

.quick-connect {
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.quick-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.quick-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.session-group {
  margin-bottom: 8px;
  padding: 4px;
  border-radius: 8px;
  border: 2px solid transparent;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}

.session-group.is-empty {
  margin-bottom: 4px;
}

.session-group.is-empty .group-sessions {
  min-height: 4px;
}

.session-group.drag-over {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.08);
  min-height: 40px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  border-radius: 4px;
  transition: background-color 0.15s ease;
  position: relative;
}

.group-header.draggable {
  cursor: grab;
}

.group-header.draggable:active {
  cursor: grabbing;
}

.group-header.drag-over {
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.15);
}

.group-header.drag-over::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -2px;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
}

.drag-handle {
  opacity: 0;
  color: var(--text-muted);
  transition: opacity 0.15s ease;
  flex-shrink: 0;
}

.group-header:hover .drag-handle {
  opacity: 0.5;
}

.collapse-icon {
  color: var(--text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.group-sessions {
  /* 会话列表容器 */
}

.group-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.group-name {
  font-weight: 500;
}

.group-header-right {
  display: flex;
  align-items: center;
  gap: 4px;
}

.group-count {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: normal;
  text-transform: none;
}

.jump-host-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  font-size: 10px;
  font-weight: normal;
  text-transform: none;
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.15);
  border-radius: 4px;
}

.jump-host-badge svg {
  opacity: 0.8;
}

.btn-xs {
  padding: 2px 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.group-header:hover .btn-xs {
  opacity: 0.6;
}

.btn-xs:hover {
  opacity: 1 !important;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 4px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  cursor: grab;
  transition: all 0.2s ease;
}

.session-item:hover {
  background: var(--bg-surface);
}

.session-item:active {
  cursor: grabbing;
}

.session-item.dragging {
  opacity: 0.5;
}

.session-item.drag-over-before,
.session-item.drag-over-after {
  position: relative;
}

.session-item.drag-over-before::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -2px;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
}

.session-item.drag-over-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -2px;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
}

.session-icon {
  color: var(--accent-primary);
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-host {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.session-actions {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.session-item:hover .session-actions {
  opacity: 1;
}

.empty-sessions {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-sessions .tip {
  font-size: 12px;
  margin-top: 8px;
}

/* 弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 420px;
  max-height: 80vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.modal-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-hint {
  display: block;
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* 分组编辑弹窗样式 */
.form-section {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.form-section-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.form-section-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 22px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.btn-danger {
  background: #e53e3e;
  color: white;
}

.btn-danger:hover {
  background: #c53030;
}
</style>

