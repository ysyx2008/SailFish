<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from './stores/terminal'
import { useConfigStore, type SshSession } from './stores/config'
import TabBar from './components/TabBar.vue'
import TerminalContainer from './components/TerminalContainer.vue'
import AiPanel from './components/AiPanel.vue'
import SessionManager from './components/SessionManager.vue'
import SettingsModal from './components/Settings/SettingsModal.vue'
import FileExplorer from './components/FileExplorer/FileExplorer.vue'
import McpStatusPopover from './components/McpStatusPopover.vue'
import SetupWizard from './components/SetupWizard.vue'
import WelcomePage from './components/WelcomePage.vue'
import SmartPatrolPage from './components/SmartPatrolPage.vue'
import type { SftpConnectionConfig } from './composables/useSftp'

const { t } = useI18n()
const terminalStore = useTerminalStore()
const configStore = useConfigStore()

const showSidebar = ref(false)
const showAiPanel = ref(true)
const showSettings = ref(false)
const showSmartPatrol = ref(false)

// UI 主题
const currentUiTheme = computed(() => configStore.uiTheme)
const settingsInitialTab = ref<string | undefined>(undefined)
const showFileExplorer = ref(false)
const sftpConfig = ref<SftpConnectionConfig | null>(null)
const showSetupWizard = ref(false)

// AI 面板宽度
const aiPanelWidth = ref(420)
const isResizing = ref(false)
const MIN_AI_WIDTH = 300
// 最大宽度为窗口宽度减去最小终端宽度（200px）
const getMaxAiWidth = () => window.innerWidth - 200

// 提供给子组件
provide('showSettings', () => {
  showSettings.value = true
})

// 同步主题到 body，让 Teleport 到 body 的弹窗也能使用正确的主题
watch(currentUiTheme, (theme) => {
  document.body.setAttribute('data-ui-theme', theme)
}, { immediate: true })

// 全局快捷键处理
const handleGlobalKeydown = (event: KeyboardEvent) => {
  // Ctrl+Shift+T / Cmd+Shift+T 新建终端标签页
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 't') {
    event.preventDefault()
    terminalStore.createTab('local')
  }
}

onMounted(async () => {
  // 注册全局快捷键
  document.addEventListener('keydown', handleGlobalKeydown)

  // 加载配置
  await configStore.loadConfig()

  // 检查是否完成首次设置
  const setupCompleted = await window.electronAPI.config.getSetupCompleted()
  if (!setupCompleted) {
    showSetupWizard.value = true
    return // 显示向导，暂不创建终端
  }

  // 已完成设置，正常启动
  await initializeApp()
})

// 初始化应用（正常启动流程）
const initializeApp = async () => {
  // 不再自动创建本地终端，显示欢迎页让用户选择

  // 自动连接启用的 MCP 服务器
  try {
    const results = await window.electronAPI.mcp.connectEnabledServers()
    const connected = results.filter(r => r.success).length
    const failed = results.filter(r => !r.success)
    if (connected > 0) {
      console.log(`[MCP] 自动连接了 ${connected} 个服务器`)
    }
    if (failed.length > 0) {
      console.warn('[MCP] 部分服务器连接失败:', failed)
    }
  } catch (error) {
    console.error('[MCP] 自动连接服务器失败:', error)
  }
}

// 是否显示欢迎页（没有打开任何终端且不在智能巡检界面时显示）
const showWelcomePage = computed(() => terminalStore.tabs.length === 0 && !showSmartPatrol.value)

// 从欢迎页打开本地终端
const openLocalFromWelcome = async () => {
  await terminalStore.createTab('local')
}

// 从欢迎页连接 SSH
const openSshFromWelcome = async (session: SshSession) => {
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
    jumpHost,
    encoding: session.encoding || 'utf-8',
    sessionId: session.id  // 传递会话 ID（用于重连）
  })
}

// 从欢迎页打开会话管理器
const openSessionManagerFromWelcome = () => {
  showSidebar.value = true
}

// 从欢迎页打开智能巡检
const openSmartPatrolFromWelcome = () => {
  showSmartPatrol.value = true
}

// 从智能巡检返回欢迎页
const backFromSmartPatrol = () => {
  showSmartPatrol.value = false
}

// 完成引导向导
const onSetupComplete = async () => {
  showSetupWizard.value = false
  // 向导完成后初始化应用
  await initializeApp()
}

// 切换侧边栏
const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

// 切换 AI 面板
const toggleAiPanel = () => {
  showAiPanel.value = !showAiPanel.value
}

// 打开 SFTP 文件管理器
const openSftp = (session: SshSession) => {
  sftpConfig.value = {
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKeyPath: session.privateKeyPath,
    passphrase: session.passphrase
  }
  showFileExplorer.value = true
}

// 关闭 SFTP 文件管理器
const closeSftp = () => {
  showFileExplorer.value = false
  sftpConfig.value = null
}

// 监听右键菜单发送到 AI 的请求，自动打开 AI 面板
watch(() => terminalStore.pendingAiText, (text) => {
  if (text) {
    showAiPanel.value = true
  }
})

// 打开 MCP 设置
const openMcpSettings = () => {
  settingsInitialTab.value = 'mcp'
  showSettings.value = true
}

// 关闭设置弹窗
const closeSettings = () => {
  showSettings.value = false
  settingsInitialTab.value = undefined
}

// 重新运行引导
const restartSetup = async () => {
  showSetupWizard.value = true
}

// AI 面板拖拽调整宽度
const startResize = (_e: MouseEvent) => {
  isResizing.value = true
  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

const handleResize = (e: MouseEvent) => {
  if (!isResizing.value) return
  
  // 计算新宽度（从右边缘到鼠标位置）
  const newWidth = window.innerWidth - e.clientX
  
  // 限制宽度范围（最大为窗口一半）
  const maxWidth = getMaxAiWidth()
  if (newWidth >= MIN_AI_WIDTH && newWidth <= maxWidth) {
    aiPanelWidth.value = newWidth
  }
}

const stopResize = () => {
  isResizing.value = false
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

onUnmounted(() => {
  document.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
})
</script>

<template>
  <div class="app-container" :class="{ 'sidebar-open': showSidebar, 'ai-open': showAiPanel }" :data-ui-theme="currentUiTheme">
    <!-- 顶部工具栏 -->
    <header class="app-header">
      <div class="header-left">
        <button class="btn-icon" @click="toggleSidebar" :title="t('header.sessionManager')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="14" y="14" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/>
          </svg>
        </button>
        <span class="app-title">{{ t('app.title') }}</span>
      </div>
      <div class="header-center">
        <TabBar />
      </div>
      <div class="header-right">
        <button class="btn-icon" @click="toggleAiPanel" :title="t('header.aiAssistant')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
            <circle cx="7.5" cy="14.5" r="1.5"/>
            <circle cx="16.5" cy="14.5" r="1.5"/>
          </svg>
        </button>
        <McpStatusPopover @open-settings="openMcpSettings" />
        <button class="btn-icon" @click="showSettings = true" :title="t('header.settings')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
          </svg>
        </button>
      </div>
    </header>

    <!-- 主体内容 -->
    <div class="app-body">
      <!-- 左侧边栏 - 主机管理 -->
      <aside v-show="showSidebar" class="sidebar">
        <div class="sidebar-header">
          <span>{{ t('header.hostManager') }}</span>
          <button class="btn-icon btn-sm" @click="showSidebar = false" :title="t('header.closeSidebar')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="sidebar-content">
          <SessionManager @open-sftp="openSftp" />
        </div>
      </aside>

      <!-- 终端区域 / 欢迎页 / 智能巡检 -->
      <main class="terminal-area">
        <WelcomePage 
          v-if="showWelcomePage"
          @open-local="openLocalFromWelcome"
          @open-ssh="openSshFromWelcome"
          @open-session-manager="openSessionManagerFromWelcome"
          @open-smart-patrol="openSmartPatrolFromWelcome"
        />
        <SmartPatrolPage 
          v-else-if="showSmartPatrol"
          @back="backFromSmartPatrol"
        />
        <TerminalContainer v-else />
      </main>

      <!-- AI 面板 - 每个 tab 独立实例（仅在有终端时显示） -->
      <template v-if="showAiPanel && !showWelcomePage">
        <div 
          class="resize-handle" 
          @mousedown="startResize"
          :class="{ resizing: isResizing }"
        ></div>
        <aside class="ai-sidebar" :style="{ width: aiPanelWidth + 'px' }">
          <template v-for="tab in terminalStore.tabs" :key="tab.id">
            <AiPanel 
              v-show="tab.id === terminalStore.activeTabId"
              :tab-id="tab.id"
              @close="showAiPanel = false" 
            />
          </template>
        </aside>
      </template>
    </div>

    <!-- 设置弹窗 -->
    <SettingsModal 
      v-if="showSettings" 
      :initial-tab="settingsInitialTab"
      @close="closeSettings"
      @restart-setup="restartSetup"
    />

    <!-- SFTP 文件管理器弹窗 -->
    <FileExplorer
      v-if="showFileExplorer && sftpConfig"
      :config="sftpConfig"
      @close="closeSftp"
    />

    <!-- 首次启动引导向导 -->
    <SetupWizard
      v-if="showSetupWizard"
      @complete="onSetupComplete"
    />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: var(--bg-primary);
}

/* 顶部工具栏 */
.app-header {
  display: flex;
  align-items: center;
  height: var(--header-height);
  padding: 0 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  -webkit-app-region: drag;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.header-center {
  flex: 1;
  display: flex;
  justify-content: center;
  overflow: hidden;
  -webkit-app-region: no-drag;
}

.app-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-left: 8px;
}

/* 主体 */
.app-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  width: var(--sidebar-width);
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
}

/* 终端区域 */
.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* AI 侧边栏 */
.ai-sidebar {
  min-width: 280px;
  max-width: 600px;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

/* 拖拽调整宽度手柄 */
.resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.2s ease;
  flex-shrink: 0;
}

.resize-handle:hover,
.resize-handle.resizing {
  background: var(--accent-primary);
}

</style>

