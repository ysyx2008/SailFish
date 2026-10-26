<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Monitor, FolderPlus, Download, FileText, Folder, ListFilter, FileEdit, AlignLeft, AlignRight, Clock, Terminal, ChevronDown, ExternalLink, Settings, Plug, Pencil, Trash2, Columns2, Rows2 } from 'lucide-vue-next'
import { useConfigStore, type SshSession, type SessionGroup, type JumpHostConfig, type SessionSortBy } from '../stores/config'
import { useTerminalStore, type PaneEdge } from '../stores/terminal'
import { v4 as uuidv4 } from 'uuid'
import SessionEditDialog from './SessionEditDialog.vue'
import GroupEditDialog from './GroupEditDialog.vue'
import SshCredentialDialog from './SshCredentialDialog.vue'
import { useSessionList } from '../composables/useSessionList'
import { useSessionDragDrop } from '../composables/useSessionDragDrop'
import { showConfirm, showAlert } from '../composables/useConfirm'

const { t } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const emit = defineEmits<{
  openSftp: [session: SshSession]
  openFileManagerWindow: [session: SshSession]
}>()

// ==================== UI 状态 ====================
const showNewSession = ref(false)
const showGroupEditor = ref(false)
const showNewMenu = ref(false)
const showImportMenu = ref(false)
const showSortMenu = ref(false)
const editingSession = ref<SshSession | null>(null)
const defaultGroupId = ref('')
const editingGroup = ref<SessionGroup | null>(null)
const credentialSession = ref<SshSession | null>(null)
const searchText = ref('')
const collapsedGroups = ref<Set<string>>(new Set())

type OpenIntent = 'new-tab' | 'split-h' | 'split-v' | 'split-edge'
const pendingOpenIntent = ref<OpenIntent>('new-tab')
const pendingSplitEdge = ref<{ tabId: string; paneId: string; edge: PaneEdge } | null>(null)
const ctxMenu = ref<{ show: boolean; x: number; y: number; session: SshSession | null }>({
  show: false, x: 0, y: 0, session: null,
})

// ==================== Composables ====================
const { groupedSessions } = useSessionList(searchText)
const {
  dragOverGroupName, dragOverSessionId, dragOverPosition,
  draggingGroupName, dragOverTargetGroupName,
  handleDragStart, handleGroupDragStart, handleDragEnd,
  handleDragOverGroup, handleDragOverSession, handleDragLeaveGroup,
  handleDragOverGroupHeader, handleDropToGroupHeader,
  handleDropToSession, handleDropToGroup,
} = useSessionDragDrop(groupedSessions, collapsedGroups)

// 分组拖拽落点指示：把 before/after 归一到单一「线锚定组」上，只渲染一条线
const groupDropLineAnchor = computed<{ name: string; edge: 'top' | 'bottom' } | null>(() => {
  if (!draggingGroupName.value || !dragOverTargetGroupName.value) return null
  const names = Object.keys(groupedSessions.value)
  const idx = names.indexOf(dragOverTargetGroupName.value)
  if (idx === -1) return null
  if (dragOverPosition.value === 'before') {
    return { name: dragOverTargetGroupName.value, edge: 'top' }
  }
  if (idx < names.length - 1) {
    return { name: names[idx + 1], edge: 'top' }
  }
  return { name: dragOverTargetGroupName.value, edge: 'bottom' }
})

// ==================== 菜单键盘/点击 ====================
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (ctxMenu.value.show) { e.stopImmediatePropagation(); closeCtxMenu() }
    else if (showImportMenu.value) { e.stopImmediatePropagation(); showImportMenu.value = false }
    else if (showNewMenu.value) { e.stopImmediatePropagation(); showNewMenu.value = false }
  }
}

const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.import-dropdown')) showImportMenu.value = false
  if (!target.closest('.new-dropdown')) showNewMenu.value = false
  if (!target.closest('.sort-dropdown')) showSortMenu.value = false
  if (!target.closest('.host-ctx-menu')) closeCtxMenu()
}

watch(showNewMenu, (isOpen) => {
  if (isOpen) { document.addEventListener('click', handleClickOutside); document.addEventListener('keydown', handleKeydown) }
  else if (!showImportMenu.value) { document.removeEventListener('click', handleClickOutside); document.removeEventListener('keydown', handleKeydown) }
})

watch(showImportMenu, (isOpen) => {
  if (isOpen) { document.addEventListener('click', handleClickOutside); document.addEventListener('keydown', handleKeydown) }
  else if (!showNewMenu.value && !showSortMenu.value) { document.removeEventListener('click', handleClickOutside); document.removeEventListener('keydown', handleKeydown) }
})

watch(showSortMenu, (isOpen) => {
  if (isOpen) document.addEventListener('click', handleClickOutside)
  else if (!showNewMenu.value && !showImportMenu.value) document.removeEventListener('click', handleClickOutside)
})

watch(() => ctxMenu.value.show, (isOpen) => {
  if (isOpen) document.addEventListener('keydown', handleKeydown)
  else if (!showNewMenu.value && !showImportMenu.value) document.removeEventListener('keydown', handleKeydown)
})

const handleMenuImportXshell = () => { showImportMenu.value = true }

onMounted(() => { window.addEventListener('menu:import-xshell', handleMenuImportXshell) })
onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('click', handleClickOutside)
  window.removeEventListener('menu:import-xshell', handleMenuImportXshell)
})

// ==================== 分组折叠 ====================
const toggleGroupCollapse = (groupName: string) => {
  if (collapsedGroups.value.has(groupName)) collapsedGroups.value.delete(groupName)
  else collapsedGroups.value.add(groupName)
}

// ==================== 会话操作 ====================
const openNewSession = (groupId?: string) => {
  editingSession.value = null
  defaultGroupId.value = groupId ?? ''
  showNewSession.value = true
}
const openNewSessionInGroup = (groupName: string) => {
  const groupData = groupedSessions.value[groupName]
  collapsedGroups.value.delete(groupName)
  openNewSession(groupData?.group?.id)
}
const openEditSession = (session: SshSession) => {
  editingSession.value = session
  defaultGroupId.value = ''
  showNewSession.value = true
}
const closeSessionDialog = () => {
  showNewSession.value = false
  editingSession.value = null
  defaultGroupId.value = ''
}

const handleSaveSession = async (formData: Partial<SshSession>) => {
  try {
    if (editingSession.value) {
      await configStore.updateSshSession({ ...editingSession.value, ...formData } as SshSession)
    } else {
      await configStore.addSshSession({ id: uuidv4(), ...formData } as SshSession)
    }
    closeSessionDialog()
  } catch (error) {
    console.error('保存会话失败:', error)
    await showAlert(t('common.error'), t('session.validation.saveFailed'))
  }
}

const deleteSession = async (session: SshSession) => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('session.confirmDeleteHost', { name: session.name }),
    confirmText: t('common.delete'),
  })
  if (confirmed) {
    await configStore.deleteSshSession(session.id)
  }
}

const currentSessionTab = computed(() => terminalStore.activeTab || terminalStore.hubFocusedTab)
const canSplitIntoCurrent = computed(() => Boolean(currentSessionTab.value))

const closeCtxMenu = () => {
  ctxMenu.value = { show: false, x: 0, y: 0, session: null }
}

const openCtxMenu = (e: MouseEvent, session: SshSession) => {
  e.preventDefault()
  e.stopPropagation()
  const menuW = 180
  const menuH = 120
  let x = e.clientX
  let y = e.clientY
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8
  ctxMenu.value = { show: true, x: Math.max(8, x), y: Math.max(8, y), session }
}

const connectSession = async (session: SshSession) => {
  await openHost(session, 'new-tab')
}

const openHost = async (session: SshSession, intent: OpenIntent) => {
  closeCtxMenu()
  pendingOpenIntent.value = intent
  const jumpHost = configStore.getEffectiveJumpHost(session)
  if (jumpHost) {
    await executeOpen(session, intent)
    return
  }
  const needsCredentials = !session.username || (!session.password && !session.privateKeyPath)
  if (needsCredentials) {
    credentialSession.value = session
    return
  }
  await executeOpen(session, intent)
}

const doConnect = async (session: SshSession, overrideCredentials?: { username: string; password: string }) => {
  await configStore.updateSessionLastUsed(session.id)
  const jumpHost = configStore.getEffectiveJumpHost(session)
  await terminalStore.createTab('ssh', {
    host: session.host, port: session.port,
    username: overrideCredentials?.username || session.username,
    password: overrideCredentials?.password || session.password,
    privateKeyPath: session.privateKeyPath, passphrase: session.passphrase,
    jumpHost, encoding: session.encoding || 'utf-8', sessionId: session.id
  })
}

const executeOpen = async (
  session: SshSession,
  intent: OpenIntent,
  overrideCredentials?: { username: string; password: string }
) => {
  if (intent === 'new-tab') {
    await doConnect(session, overrideCredentials)
    return
  }
  const edgeInfo = intent === 'split-edge' ? pendingSplitEdge.value : null
  const tab = edgeInfo
    ? terminalStore.tabs.find(t => t.id === edgeInfo.tabId)
    : currentSessionTab.value
  if (!tab) {
    await doConnect(session, overrideCredentials)
    return
  }
  await configStore.updateSessionLastUsed(session.id)
  const prevUser = session.username
  const prevPass = session.password
  if (overrideCredentials) {
    session.username = overrideCredentials.username
    session.password = overrideCredentials.password
  }
  const target = { kind: 'ssh' as const, sessionId: session.id }
  try {
    let opened: string | null = null
    if (intent === 'split-edge' && edgeInfo) {
      opened = terminalStore.tabHostsTerminal(tab)
        ? await terminalStore.splitAtEdge(edgeInfo.tabId, edgeInfo.paneId, edgeInfo.edge, target)
        : await terminalStore.openTerminalOnTab(tab.id, target)
    } else {
      opened = terminalStore.tabHostsTerminal(tab)
        ? await terminalStore.splitTerminal(intent === 'split-h' ? 'horizontal' : 'vertical', target, tab.id)
        : await terminalStore.openTerminalOnTab(tab.id, target)
    }
    if (
      !opened
      && !terminalStore.wasLastSplitCancelled()
      && !terminalStore.tabHasPaneConnectionError(tab.id)
    ) {
      const err = terminalStore.getLastSplitError()
      await showAlert(t('common.error'), err || t('session.splitNeedSession'))
    }
  } finally {
    if (overrideCredentials) {
      session.username = prevUser
      session.password = prevPass
    }
  }
}

watch(
  () => terminalStore.sshSplitAtEdgeRequest,
  (req) => {
    if (!req) return
    const session = configStore.sshSessions.find(s => s.id === req.sessionId)
    terminalStore.consumeSshSplitAtEdgeRequest()
    if (!session) return
    pendingSplitEdge.value = { tabId: req.tabId, paneId: req.paneId, edge: req.edge }
    void openHost(session, 'split-edge')
  }
)

const handleCredentialConnect = async (credentials: { username: string; password: string; save: boolean }) => {
  const session = credentialSession.value
  if (!session) return
  credentialSession.value = null
  const intent = pendingOpenIntent.value

  if (credentials.save) {
    const updated = { ...session, username: credentials.username, password: credentials.password }
    await configStore.updateSshSession(updated)
    await executeOpen(updated, intent)
  } else {
    await executeOpen(session, intent, credentials)
  }
}

const _openSftp = (session: SshSession) => { emit('openSftp', session) }
void _openSftp

const openFileManagerWindow = async (session: SshSession) => {
  await window.electronAPI.fileManager.open({
    sessionId: session.id,
    sftpConfig: {
      host: session.host, port: session.port,
      username: session.username, password: session.password,
      privateKeyPath: session.privateKeyPath, passphrase: session.passphrase
    }
  })
}

const createLocalTerminal = () => { terminalStore.createTab('local') }

const handleSortChange = async (sortBy: SessionSortBy) => {
  await configStore.setSessionSortBy(sortBy)
  showSortMenu.value = false
}

// ==================== 导入 ====================
const importXshellFiles = async () => {
  showImportMenu.value = false
  const result = await window.electronAPI.xshell.selectFiles()
  if (result.canceled) return
  await handleImportResult(await window.electronAPI.xshell.importFiles(result.filePaths))
}

const importXshellDirectory = async () => {
  showImportMenu.value = false
  const result = await window.electronAPI.xshell.selectDirectory()
  if (result.canceled) return
  await handleImportResult(await window.electronAPI.xshell.importDirectory(result.dirPath))
}

const handleImportResult = async (importResult: { success: boolean; sessions: any[]; errors: string[] }) => {
  if (!importResult.success && importResult.sessions.length === 0) {
    await showAlert(t('common.error'), `${t('session.importFailed')}：${importResult.errors.join('\n')}`)
    return
  }
  let importedCount = 0
  for (const session of importResult.sessions) {
    await configStore.addSshSession({
      id: uuidv4(), name: session.name, host: session.host, port: session.port,
      username: session.username, authType: session.privateKeyPath ? 'privateKey' : 'password',
      password: session.password, privateKeyPath: session.privateKeyPath, group: session.group
    })
    importedCount++
  }
  let message = t('session.importSuccess', { count: importedCount })
  if (importResult.errors.length > 0) {
    message += `\n\n${t('session.importPartialFailed')}\n${importResult.errors.join('\n')}`
  }
  await showAlert(t('common.success'), message)
}

// ==================== 分组管理 ====================
const openNewGroup = () => { editingGroup.value = null; showGroupEditor.value = true }

const openGroupEditor = (groupName: string) => {
  const groupData = groupedSessions.value[groupName]
  editingGroup.value = groupData?.group ?? null
  showGroupEditor.value = true
}

const handleSaveGroup = async (data: { name: string; jumpHost?: JumpHostConfig }) => {
  const groupData: SessionGroup = { id: editingGroup.value?.id || uuidv4(), name: data.name, jumpHost: data.jumpHost }
  if (editingGroup.value) {
    await configStore.updateSessionGroup(groupData)
  } else {
    await configStore.addSessionGroup(groupData)
    const sessionsToUpdate = configStore.sshSessions.filter(s => s.group === data.name && !s.groupId)
    for (const session of sessionsToUpdate) {
      await configStore.updateSshSession({ ...session, groupId: groupData.id })
    }
  }
  showGroupEditor.value = false
  editingGroup.value = null
}

const handleDeleteGroup = async (group: SessionGroup) => {
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.delete'),
    message: t('session.confirmDeleteGroupNamed', { name: group.name }),
    confirmText: t('common.delete'),
  })
  if (confirmed) {
    await configStore.deleteSessionGroup(group.id)
    showGroupEditor.value = false
    editingGroup.value = null
  }
}

const closeGroupDialog = () => { showGroupEditor.value = false; editingGroup.value = null }
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
      <div class="new-dropdown toolbar-dropdown">
        <button class="toolbar-btn toolbar-btn-primary" @click="showNewMenu = !showNewMenu">
          <Plus :size="14" />
          <span>{{ t('common.new') }}</span>
        </button>
        <div v-if="showNewMenu" class="dropdown-menu dropdown-left" @click.stop>
          <button class="dropdown-item" @click="openNewSession(); showNewMenu = false">
            <Monitor :size="14" />
            {{ t('session.newHost') }}
          </button>
          <button class="dropdown-item" @click="openNewGroup(); showNewMenu = false">
            <FolderPlus :size="14" />
            {{ t('session.newGroup') }}
          </button>
        </div>
      </div>
      <div class="import-dropdown toolbar-dropdown">
        <button class="toolbar-btn toolbar-btn-icon" @click="showImportMenu = !showImportMenu" :title="t('common.import')">
          <Download :size="14" />
        </button>
        <div v-if="showImportMenu" class="dropdown-menu dropdown-right" @click.stop>
          <button class="dropdown-item" @click="importXshellFiles">
            <FileText :size="14" />
            {{ t('session.importXshellFiles') }}
          </button>
          <button class="dropdown-item" @click="importXshellDirectory">
            <Folder :size="14" />
            {{ t('session.importXshellDir') }}
          </button>
        </div>
      </div>
      <div class="sort-dropdown toolbar-dropdown">
        <button class="toolbar-btn toolbar-btn-icon" @click="showSortMenu = !showSortMenu" :title="t('session.sort.title')">
          <ListFilter :size="14" />
        </button>
        <div v-if="showSortMenu" class="dropdown-menu dropdown-right" @click.stop>
          <button class="dropdown-item" :class="{ active: configStore.sessionSortBy === 'custom' }" @click="handleSortChange('custom')">
            <FileEdit :size="14" />
            {{ t('session.sort.custom') }}
          </button>
          <button class="dropdown-item" :class="{ active: configStore.sessionSortBy === 'name' }" @click="handleSortChange('name')">
            <AlignLeft :size="14" />
            {{ t('session.sort.nameAsc') }}
          </button>
          <button class="dropdown-item" :class="{ active: configStore.sessionSortBy === 'name-desc' }" @click="handleSortChange('name-desc')">
            <AlignRight :size="14" />
            {{ t('session.sort.nameDesc') }}
          </button>
          <button class="dropdown-item" :class="{ active: configStore.sessionSortBy === 'lastUsed' }" @click="handleSortChange('lastUsed')">
            <Clock :size="14" />
            {{ t('session.sort.lastUsed') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 快速操作 -->
    <div class="quick-connect">
      <button class="quick-btn" @click="createLocalTerminal">
        <Terminal :size="16" />
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
            class="group-header draggable"
            :class="{
              'drop-line-top': groupDropLineAnchor?.name === groupName && groupDropLineAnchor.edge === 'top',
              'drop-line-bottom': groupDropLineAnchor?.name === groupName && groupDropLineAnchor.edge === 'bottom'
            }"
            draggable="true"
            @dragstart="handleGroupDragStart(groupName as string, $event)"
            @dragend="handleDragEnd"
            @dragover="handleDragOverGroupHeader(groupName as string, $event)"
            @drop="handleDropToGroupHeader(groupName as string, $event)"
          >
            <div class="group-header-left" @click.stop="toggleGroupCollapse(groupName as string)">
              <ChevronDown 
                class="collapse-icon" 
                :class="{ collapsed: collapsedGroups.has(groupName as string) }"
                :size="12"
              />
              <span class="group-name">{{ groupName }}</span>
              <span class="group-count">{{ groupData.sessions.length }}</span>
            </div>
            <span
              v-if="groupData.group?.jumpHost"
              class="jump-host-badge"
              :title="t('session.form.jumpHost') + '：' + groupData.group.jumpHost.host"
              @click.stop="toggleGroupCollapse(groupName as string)"
            >
              <ExternalLink :size="10" />
              <span class="jump-host-text">{{ groupData.group.jumpHost.host }}</span>
            </span>
            <div class="group-header-right">
              <button class="group-action-btn" @click.stop="openNewSessionInGroup(groupName as string)" :title="t('session.newHost')">
                <Plus :size="13" />
              </button>
              <button class="group-action-btn" @click.stop="openGroupEditor(groupName as string)" :title="t('session.editGroup')">
                <Settings :size="13" />
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
              :title="`${session.username ? session.username + '@' : ''}${session.host}${session.port !== 22 ? ':' + session.port : ''}`"
              draggable="true"
              @dragstart="handleDragStart(session, $event)"
              @dragover="handleDragOverSession(session.id, $event)"
              @drop="handleDropToSession(session.id, groupName as string, $event)"
              @dragend="handleDragEnd"
              @dblclick="connectSession(session)"
              @contextmenu="openCtxMenu($event, session)"
            >
              <div class="session-icon">
                <Monitor :size="16" />
              </div>
              <div class="session-info">
                <div class="session-name">{{ session.name }}</div>
              </div>
              <div class="session-actions">
                <button class="session-action-btn" @click.stop="connectSession(session)" :title="t('session.connect')">
                  <Plug :size="13" />
                </button>
                <button class="session-action-btn" @click.stop="openFileManagerWindow(session)" :title="t('session.fileManager')">
                  <Folder :size="13" />
                </button>
                <button class="session-action-btn" @click.stop="openEditSession(session)" :title="t('common.edit')">
                  <Pencil :size="13" />
                </button>
                <button class="session-action-btn session-action-btn-danger" @click.stop="deleteSession(session)" :title="t('common.delete')">
                  <Trash2 :size="13" />
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

    <SessionEditDialog
      v-if="showNewSession"
      :session="editingSession"
      :default-group-id="defaultGroupId"
      @save="handleSaveSession"
      @close="closeSessionDialog"
    />

    <GroupEditDialog
      v-if="showGroupEditor"
      :group="editingGroup"
      @save="handleSaveGroup"
      @delete="handleDeleteGroup"
      @close="closeGroupDialog"
    />

    <SshCredentialDialog
      v-if="credentialSession"
      :session="credentialSession"
      @connect="handleCredentialConnect"
      @cancel="credentialSession = null"
    />

    <Teleport to="body">
      <div v-if="ctxMenu.show" class="context-menu-overlay" @click="closeCtxMenu" />
      <div
        v-if="ctxMenu.show && ctxMenu.session"
        class="dropdown-menu host-ctx-menu"
        :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
        @click.stop
        @contextmenu.prevent
      >
        <button class="dropdown-item" @click="openHost(ctxMenu.session!, 'new-tab')">
          <Terminal :size="14" />
          {{ t('tabs.newTab') }}
        </button>
        <button
          class="dropdown-item"
          :class="{ disabled: !canSplitIntoCurrent }"
          :title="canSplitIntoCurrent ? undefined : t('session.splitNeedSession')"
          :disabled="!canSplitIntoCurrent"
          @click="canSplitIntoCurrent && openHost(ctxMenu.session!, 'split-h')"
        >
          <Columns2 :size="14" />
          {{ t('terminal.split.menu.horizontal') }}
        </button>
        <button
          class="dropdown-item"
          :class="{ disabled: !canSplitIntoCurrent }"
          :title="canSplitIntoCurrent ? undefined : t('session.splitNeedSession')"
          :disabled="!canSplitIntoCurrent"
          @click="canSplitIntoCurrent && openHost(ctxMenu.session!, 'split-v')"
        >
          <Rows2 :size="14" />
          {{ t('terminal.split.menu.vertical') }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/*
 * 主机管理侧栏尺寸体系（与顶部栏/标签页视觉同家族）
 *   - 工具栏控件统一高度 30px，图标 14px
 *   - 分组头：字号 12 / 字重 600 / 不 uppercase，行高 22px，图标 14px
 *   - 会话行：字号 13 / padding 6×10，图标 16px，默认无背景只 hover 出背景
 *   - 行内操作按钮：22×22，图标 13px
 *   - 所有容器圆角统一 6px，向 VSCode / Cursor 侧栏靠拢
 */

.session-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ==================== 工具栏 ==================== */
.session-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  font-size: 13px;
  box-sizing: border-box;
}

/* 工具栏按钮：30px 高，扁平风格，不继承全局 .btn 的 shimmer/上浮 */
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.toolbar-btn:hover {
  background: var(--bg-surface);
  color: var(--text-primary);
  border-color: var(--border-color);
}

.toolbar-btn:focus,
.toolbar-btn:focus-visible { outline: none; }

.toolbar-btn-primary {
  color: var(--text-primary);
}

/* 纯图标工具按钮：等宽方形 */
.toolbar-btn-icon {
  width: 30px;
  padding: 0;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.toolbar-btn-icon:hover { color: var(--text-primary); }

/* ==================== 通用下拉菜单 ==================== */
.toolbar-dropdown {
  position: relative;
}

.dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  min-width: 160px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28);
  z-index: 100;
  overflow: hidden;
  padding: 4px;
}

.dropdown-left { left: 0; }
.dropdown-right { right: 0; }

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s ease;
}

.dropdown-item:hover {
  background: var(--bg-surface);
}

.dropdown-item svg {
  color: var(--text-muted);
  flex-shrink: 0;
}

.dropdown-item.active {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.1);
}

.dropdown-item.active svg {
  color: var(--accent-primary);
}

.dropdown-item:disabled,
.dropdown-item.disabled {
  opacity: 0.4;
  cursor: default;
}

.dropdown-item:disabled:hover,
.dropdown-item.disabled:hover {
  background: transparent;
}

.context-menu-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
}

.host-ctx-menu {
  position: fixed;
  z-index: 10000;
}

/* ==================== 快速入口（本地终端） ==================== */
/* 保留独立块（上下有分隔），但尺寸与会话行对齐，去厚重边框 */
.quick-connect {
  padding: 6px;
  border-bottom: 1px solid var(--border-color);
}

/* 本地终端：作为"特殊主机行"，左侧缩进对齐下方会话项的图标起点 */
.quick-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 30px;
  padding: 0 10px 0 20px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s ease, color 0.15s ease;
}

.quick-btn svg {
  flex-shrink: 0;
  color: var(--brand-local, var(--accent-primary));
}

.quick-btn:hover {
  background: var(--bg-surface);
}

.quick-btn:focus,
.quick-btn:focus-visible { outline: none; }

/* ==================== 会话列表 ==================== */
.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 6px 12px;
}

.session-group {
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}

.session-group:last-child { margin-bottom: 0; }

.session-group.is-empty .group-sessions { min-height: 4px; }

.session-group.drag-over {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.08);
  min-height: 40px;
}

/* ==================== 分组头 ====================
   定位："小标题/容器"，不是"内容"。用字号收小 + 间距拉开 + text-muted/secondary
   来和下方 session-item（字号 13 + text-primary）形成父子层级。 */
.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 24px;
  padding: 0 6px;
  font-size: 11px;
  color: var(--text-muted);
  border-radius: 4px;
  transition: background-color 0.15s ease, color 0.15s ease;
  position: relative;
}

.group-header:hover {
  background: var(--bg-surface);
  color: var(--text-secondary);
}

.group-header.draggable { cursor: grab; }
.group-header.draggable:active { cursor: grabbing; }

.group-header.drop-line-top::before,
.group-header.drop-line-bottom::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
}

.group-header.drop-line-top::before { top: -2px; }
.group-header.drop-line-bottom::after { bottom: -2px; }

.collapse-icon {
  color: currentColor;
  opacity: 0.7;
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.collapse-icon.collapsed { transform: rotate(-90deg); }

.group-header-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  /* 按内容宽度起算，放不下时才收缩（跳板机标签缩得更狠） */
  flex: 1 1 auto;
  cursor: pointer;
}

/* 分组名：比主机名更小更紧，但字间距拉开一点，给"标题"的气质 */
.group-name {
  /* 空间不够时先让跳板机标签缩（它缩得更狠），分组名最后才被省略 */
  flex-shrink: 1;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 中文不吃 uppercase，这里给中文再拉一档字号让两种语言视觉平衡 */
.group-name:lang(zh) {
  letter-spacing: 0.04em;
}

.group-header-right {
  /* 平时不占位，悬停这一行时才浮在右侧，名字和标签能用满整行 */
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 2px;
  background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  border-radius: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.group-header:hover .group-header-right,
.group-header:focus-within .group-header-right {
  opacity: 1;
  pointer-events: auto;
}

.group-count {
  padding: 0 6px;
  min-width: 18px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-surface);
  border-radius: 8px;
  flex-shrink: 0;
  letter-spacing: 0;
  text-transform: none;
}

/* jump-host：放在分组头最右，中性灰，避免抢 accent；空间不够时它先缩 */
.jump-host-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  height: 16px;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-muted);
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  max-width: 160px;
  white-space: nowrap;
  flex-shrink: 10000;
  min-width: 0;
  transition: opacity 0.15s ease;
  cursor: pointer;
  letter-spacing: 0;
  text-transform: none;
}

.group-header:hover .jump-host-badge,
.group-header:focus-within .jump-host-badge {
  /* 悬停时这一块让给右侧浮出来的按钮 */
  opacity: 0;
}

.jump-host-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jump-host-badge svg {
  opacity: 0.7;
  flex-shrink: 0;
}

.group-action-btn {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.group-action-btn:focus,
.group-action-btn:focus-visible { outline: none; }

.group-action-btn:hover {
  opacity: 1 !important;
  color: var(--text-primary);
  background: var(--bg-hover);
}

/* ==================== 会话项 ==================== */
.group-sessions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-top: 2px;
}

/* padding-left 20px 让 Monitor 图标缩进到分组文字起点附近，
   形成清晰的"分组标题 > 主机行"父子层级 */
.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 30px;
  padding: 0 8px 0 20px;
  background: transparent;
  border-radius: 6px;
  cursor: grab;
  transition: background 0.15s ease;
  position: relative;
}

.session-item:hover { background: var(--bg-surface); }
.session-item:active { cursor: grabbing; }
.session-item.dragging { opacity: 0.5; }

.session-item.drag-over-before::before,
.session-item.drag-over-after::after {
  content: '';
  position: absolute;
  left: 6px; right: 6px;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
}

.session-item.drag-over-before::before { top: -1px; }
.session-item.drag-over-after::after { bottom: -1px; }

/* 图标降级为中性灰，不与分组标题争夺视觉焦点；hover 时回到 accent 提示可点击 */
.session-icon {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--text-muted);
  transition: color 0.15s ease;
}

.session-item:hover .session-icon {
  color: var(--accent-primary);
}

.session-info { flex: 1; min-width: 0; }

.session-name {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 行内操作按钮：统一 22×22 热区。平时不占位（名字用满整行），悬停或键盘聚焦到这一行时才浮在右侧出现 */
.session-actions {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 2px;
  /* 半透明底：被盖住的名字隐约透出来，按钮仍然看得清 */
  background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  border-radius: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.session-item:hover .session-actions,
.session-item:focus-within .session-actions {
  opacity: 1;
  pointer-events: auto;
}

.session-action-btn {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.session-action-btn:focus,
.session-action-btn:focus-visible { outline: none; }

.session-action-btn:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.session-action-btn-danger:hover {
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.12);
}

/* ==================== 空状态 ==================== */
.empty-sessions {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.empty-sessions .tip {
  font-size: 12px;
  margin-top: 8px;
  color: var(--text-muted);
  opacity: 0.8;
}
</style>
