<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Monitor, FolderPlus, Download, FileText, Folder, ListFilter, FileEdit, AlignLeft, AlignRight, Clock, Terminal, GripVertical, ChevronDown, ExternalLink, Settings, Play, Pencil, Trash2 } from 'lucide-vue-next'
import { useConfigStore, type SshSession, type SessionGroup, type JumpHostConfig, type SessionSortBy } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { v4 as uuidv4 } from 'uuid'
import SessionEditDialog from './SessionEditDialog.vue'
import GroupEditDialog from './GroupEditDialog.vue'
import { useSessionList } from '../composables/useSessionList'
import { useSessionDragDrop } from '../composables/useSessionDragDrop'

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
const editingGroup = ref<SessionGroup | null>(null)
const searchText = ref('')
const collapsedGroups = ref<Set<string>>(new Set())

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

// ==================== 菜单键盘/点击 ====================
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (showImportMenu.value) { e.stopImmediatePropagation(); showImportMenu.value = false }
    else if (showNewMenu.value) { e.stopImmediatePropagation(); showNewMenu.value = false }
  }
}

const handleClickOutside = (e: MouseEvent) => {
  const target = e.target as HTMLElement
  if (!target.closest('.import-dropdown')) showImportMenu.value = false
  if (!target.closest('.new-dropdown')) showNewMenu.value = false
  if (!target.closest('.sort-dropdown')) showSortMenu.value = false
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
const openNewSession = () => { editingSession.value = null; showNewSession.value = true }
const openEditSession = (session: SshSession) => { editingSession.value = session; showNewSession.value = true }
const closeSessionDialog = () => { showNewSession.value = false; editingSession.value = null }

const handleSaveSession = async (formData: Partial<SshSession>) => {
  try {
    if (editingSession.value) {
      await configStore.updateSshSession({ ...editingSession.value, ...formData } as SshSession)
    } else {
      await configStore.addSshSession({ id: uuidv4(), ...formData } as SshSession)
    }
    showNewSession.value = false
    editingSession.value = null
  } catch (error) {
    console.error('保存会话失败:', error)
    alert(t('session.validation.saveFailed'))
  }
}

const deleteSession = async (session: SshSession) => {
  if (confirm(t('session.confirmDeleteHost', { name: session.name }))) {
    await configStore.deleteSshSession(session.id)
  }
}

const connectSession = async (session: SshSession) => {
  await configStore.updateSessionLastUsed(session.id)
  const jumpHost = configStore.getEffectiveJumpHost(session)
  await terminalStore.createTab('ssh', {
    host: session.host, port: session.port,
    username: session.username, password: session.password,
    privateKeyPath: session.privateKeyPath, passphrase: session.passphrase,
    jumpHost, encoding: session.encoding || 'utf-8', sessionId: session.id
  })
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
    alert(`${t('session.importFailed')}：${importResult.errors.join('\n')}`)
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
  alert(message)
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
  if (confirm(t('session.confirmDeleteGroupNamed', { name: group.name }))) {
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
        <button class="btn btn-primary btn-sm" @click="showNewMenu = !showNewMenu">
          <Plus :size="14" />
          {{ t('common.new') }}
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
        <button class="btn btn-sm" @click="showImportMenu = !showImportMenu">
          <Download :size="14" />
          {{ t('common.import') }}
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
        <button class="btn btn-sm btn-icon-only" @click="showSortMenu = !showSortMenu" :title="t('session.sort.title')">
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
        <Terminal :size="18" />
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
            :class="{ 'drag-over': dragOverTargetGroupName === groupName }"
            draggable="true"
            @dragstart="handleGroupDragStart(groupName as string, $event)"
            @dragend="handleDragEnd"
            @dragover="handleDragOverGroupHeader(groupName as string, $event)"
            @drop="handleDropToGroupHeader(groupName as string, $event)"
          >
            <div class="group-header-left" @click.stop="toggleGroupCollapse(groupName as string)">
              <GripVertical class="drag-handle" :size="10" />
              <ChevronDown 
                class="collapse-icon" 
                :class="{ collapsed: collapsedGroups.has(groupName as string) }"
                :size="12"
              />
              <span class="group-name">{{ groupName }}</span>
              <span class="group-count">{{ groupData.sessions.length }}</span>
              <span v-if="groupData.group?.jumpHost" class="jump-host-badge" :title="t('session.form.jumpHost')">
                <ExternalLink :size="10" />
                {{ groupData.group.jumpHost.host }}
              </span>
            </div>
            <div class="group-header-right">
              <button class="btn-icon btn-xs" @click.stop="openGroupEditor(groupName as string)" :title="t('session.editGroup')">
                <Settings :size="12" />
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
                <Monitor :size="16" />
              </div>
              <div class="session-info">
                <div class="session-name">{{ session.name }}</div>
                <div class="session-host">{{ session.username }}@{{ session.host }}{{ session.port !== 22 ? ':' + session.port : '' }}</div>
              </div>
              <div class="session-actions">
                <button class="btn-icon btn-sm" @click.stop="connectSession(session)" :title="t('session.connect')">
                  <Play :size="14" />
                </button>
                <button class="btn-icon btn-sm" @click.stop="openFileManagerWindow(session)" :title="t('session.fileManager')">
                  <Folder :size="14" />
                </button>
                <button class="btn-icon btn-sm" @click.stop="openEditSession(session)" :title="t('common.edit')">
                  <Pencil :size="14" />
                </button>
                <button class="btn-icon btn-sm" @click.stop="deleteSession(session)" :title="t('common.delete')">
                  <Trash2 :size="14" />
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
  </div>
</template>

<style scoped>
.session-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* ==================== 工具栏 ==================== */
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

.session-toolbar .btn {
  height: 32px;
  min-width: fit-content;
  white-space: nowrap;
}

/* ==================== 通用下拉菜单 ==================== */
.toolbar-dropdown {
  position: relative;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  margin-top: 4px;
  min-width: 140px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 100;
  overflow: hidden;
}

.dropdown-left { left: 0; }
.dropdown-right { right: 0; }

.dropdown-item {
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

.dropdown-item:hover {
  background: var(--bg-surface);
}

.dropdown-item svg {
  color: var(--text-muted);
}

.dropdown-item.active {
  color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.1);
}

.dropdown-item.active svg {
  color: var(--accent-primary);
}

.btn-icon-only {
  padding: 0 8px;
  min-width: 32px;
}

/* ==================== 快速操作 ==================== */
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

/* ==================== 会话列表 ==================== */
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

.session-group.is-empty { margin-bottom: 4px; }
.session-group.is-empty .group-sessions { min-height: 4px; }

.session-group.drag-over {
  border-color: var(--accent-primary);
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.08);
  min-height: 40px;
}

/* ==================== 分组头 ==================== */
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

.group-header.draggable { cursor: grab; }
.group-header.draggable:active { cursor: grabbing; }

.group-header.drag-over {
  background: rgba(var(--accent-primary-rgb, 66, 153, 225), 0.15);
}

.group-header.drag-over::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: -2px;
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

.group-header:hover .drag-handle { opacity: 0.5; }

.collapse-icon {
  color: var(--text-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.collapse-icon.collapsed { transform: rotate(-90deg); }

.group-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.group-name { font-weight: 500; }

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

.jump-host-badge svg { opacity: 0.8; }

.btn-xs {
  padding: 2px 4px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.group-header:hover .btn-xs { opacity: 0.6; }
.btn-xs:hover { opacity: 1 !important; }

/* ==================== 会话项 ==================== */
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

.session-item:hover { background: var(--bg-surface); }
.session-item:active { cursor: grabbing; }
.session-item.dragging { opacity: 0.5; }

.session-item.drag-over-before,
.session-item.drag-over-after { position: relative; }

.session-item.drag-over-before::before,
.session-item.drag-over-after::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 2px;
  background: var(--accent-primary);
  border-radius: 1px;
}

.session-item.drag-over-before::before { top: -2px; }
.session-item.drag-over-after::after { bottom: -2px; }

.session-icon { color: var(--accent-primary); }

.session-info { flex: 1; min-width: 0; }

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

.session-item:hover .session-actions { opacity: 1; }

/* ==================== 空状态 ==================== */
.empty-sessions {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-sessions .tip {
  font-size: 12px;
  margin-top: 8px;
}
</style>
