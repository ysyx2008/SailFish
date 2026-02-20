<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Server, Bot, Settings, X, Loader2, Eye } from 'lucide-vue-next'
import { useTerminalStore } from './stores/terminal'
import { useConfigStore, type SshSession } from './stores/config'
import TabBar from './components/TabBar.vue'
import TerminalContainer from './components/TerminalContainer.vue'
import AiPanel from './components/AiPanel.vue'
import SessionManager from './components/SessionManager.vue'
import SettingsModal from './components/Settings/SettingsModal.vue'
import FileExplorer from './components/FileExplorer/FileExplorer.vue'
import ConnectionStatusPopover from './components/ConnectionStatusPopover.vue'
import SchedulerPopover from './components/SchedulerPopover.vue'
import SchedulerManager from './components/SchedulerManager.vue'
import WatchManager from './components/WatchManager.vue'
import SetupWizard from './components/SetupWizard.vue'
import WelcomePage from './components/WelcomePage.vue'
import SmartPatrolPage from './components/SmartPatrolPage.vue'
import Toast from './components/common/Toast.vue'
import ConfirmDialog from './components/common/ConfirmDialog.vue'
import KnowledgeManager from './components/KnowledgeManager.vue'
import { useConfirm } from './composables/useConfirm'
import { toast } from './composables/useToast'
import type { SftpConnectionConfig } from './composables/useSftp'
import { uiThemes } from './themes/ui-themes'
import { createLogger } from './utils/logger'

const log = createLogger('App')

const { t } = useI18n()

// Steam 构建标识（由 vite define 注入），在 script 中取值供模板使用，避免模板直接访问全局
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__

// 知识库升级进度
const knowledgeUpgrading = ref(false)
const knowledgeUpgradeProgress = ref({ current: 0, total: 0, filename: '' })
const terminalStore = useTerminalStore()
const configStore = useConfigStore()

// Steam 版使用独立品牌名
const steamAppTitle = computed(() => {
  const lang = configStore.language || 'zh-CN'
  return lang.startsWith('zh') ? '旗鱼终端' : 'SFTerm'
})
const { show: showConfirmDialog, options: confirmOptions, handleConfirm, handleCancel, handleClose } = useConfirm()

const showSidebar = ref(false)
// Steam 版默认不显示 AI 面板，且面板区域不渲染
const showAiPanel = ref(isSteamBuild ? false : true)
const showSettings = ref(false)
const showSmartPatrol = ref(false)
const showSchedulerManager = ref(false)
const showWatchManager = ref(false)

// UI 主题
const currentUiTheme = computed(() => configStore.uiTheme)
// 当前主题的颜色模式（dark/light）
const currentColorScheme = computed(() => {
  const theme = uiThemes[currentUiTheme.value as keyof typeof uiThemes]
  return theme?.colorScheme || 'dark'
})
const settingsInitialTab = ref<string | undefined>(undefined)
const pendingInstallSkillId = ref<string | undefined>(undefined)
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
watch([currentUiTheme, currentColorScheme], ([theme, colorScheme]) => {
  document.body.setAttribute('data-ui-theme', theme)
  document.body.setAttribute('data-color-scheme', colorScheme)
}, { immediate: true })

// 全局快捷键处理
const handleGlobalKeydown = (event: KeyboardEvent) => {
  // Ctrl+T / Cmd+T 新建终端标签页
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 't') {
    event.preventDefault()
    terminalStore.createTab('local')
  }

  // Ctrl+W / Cmd+W 关闭当前终端或窗口
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault()
    handleCloseShortcut()
  }
}

// 处理关闭快捷键
const handleCloseShortcut = async () => {
  // 如果有活跃终端，关闭当前终端
  if (terminalStore.tabs.length > 0 && terminalStore.activeTabId) {
    await terminalStore.closeTab(terminalStore.activeTabId)
  } else {
    // 没有活跃终端时关闭窗口
    await window.electronAPI.window.close()
  }
}

// 清理函数存储
let cleanupTerminalCountListener: (() => void) | null = null
let cleanupKnowledgeUpgrading: (() => void) | null = null
let cleanupKnowledgeProgress: (() => void) | null = null
let cleanupKnowledgeReady: (() => void) | null = null
let cleanupMenuCommand: (() => void) | null = null
let cleanupSchedulerTaskStarted: (() => void) | null = null
let cleanupGatewayRemoteTab: (() => void) | null = null
let cleanupGatewayRemoteTask: (() => void) | null = null
let cleanupRemoteAgentStep: (() => void) | null = null
let cleanupRemoteAgentComplete: (() => void) | null = null
let cleanupRemoteAgentConfirm: (() => void) | null = null
let cleanupImConnectionChange: (() => void) | null = null
let cleanupRunTask: (() => void) | null = null
let cleanupInstallSkill: (() => void) | null = null

// 知识库管理器显示状态
const showKnowledgeManager = ref(false)

onMounted(async () => {
  // 注册全局快捷键
  document.addEventListener('keydown', handleGlobalKeydown)

  // 注册终端数量查询响应（用于退出确认）
  cleanupTerminalCountListener = window.electronAPI.window.onRequestTerminalCount(() => {
    window.electronAPI.window.responseTerminalCount(terminalStore.tabs.length)
  })

  // 监听知识库升级事件
  cleanupKnowledgeUpgrading = window.electronAPI.knowledge.onUpgrading(() => {
    knowledgeUpgrading.value = true
  })
  cleanupKnowledgeProgress = window.electronAPI.knowledge.onRebuildProgress((data) => {
    knowledgeUpgradeProgress.value = data
  })
  cleanupKnowledgeReady = window.electronAPI.knowledge.onReady(() => {
    knowledgeUpgrading.value = false
  })

  // 监听菜单命令
  cleanupMenuCommand = window.electronAPI.menu.onCommand(({ command }) => {
    handleMenuCommand(command)
  })

  // 监听定时任务开始事件，创建可见的终端 tab 并自动执行 Agent
  cleanupSchedulerTaskStarted = window.electronAPI.scheduler.onTaskStarted((data) => {
    if (data.ptyId) {
      // 根据任务类型构建 tab 配置，包含 pendingTask 以便 AiPanel 自动执行
      const tabTitle = `⏰ ${data.taskName}`
      const pendingTask = data.prompt  // 任务 prompt 作为待执行任务
      
      if (data.targetType === 'local') {
        terminalStore.createTabWithExistingPty({
          ptyId: data.ptyId,
          title: tabTitle,
          type: 'local',
          pendingTask
        })
      } else if (data.targetType === 'ssh' && data.sshSessionId) {
        // 获取 SSH 会话配置
        const sshSession = configStore.sshSessions.find(s => s.id === data.sshSessionId)
        if (sshSession) {
          terminalStore.createTabWithExistingPty({
            ptyId: data.ptyId,
            title: tabTitle,
            type: 'ssh',
            sshConfig: {
              host: sshSession.host,
              port: sshSession.port,
              username: sshSession.username
            },
            sshSessionId: data.sshSessionId,
            pendingTask
          })
        }
      }
      
      // 打开 AI 面板确保可见
      showAiPanel.value = true
      
      log.debug(`[Scheduler] 定时任务开始: ${data.taskName}, 已创建终端 tab，等待 AiPanel 执行`)
    }
  })

  // 监听深链调起：从官网技能示例等外部来源触发 Agent 任务
  cleanupRunTask = window.electronAPI.app.onRunTask((task: string) => {
    log.debug(`[DeepLink] 收到外部任务: ${task.substring(0, 80)}...`)
    showAiPanel.value = true
    terminalStore.createTabWithTask(task)
  })

  // 监听深链调起：从官网一键安装技能
  cleanupInstallSkill = window.electronAPI.app.onInstallSkill((skillId: string) => {
    log.debug(`[DeepLink] 收到技能安装请求: ${skillId}`)
    pendingInstallSkillId.value = skillId
    settingsInitialTab.value = 'skills'
    showSettings.value = true
  })

  // 监听远程 Gateway 终端标签页创建事件
  cleanupGatewayRemoteTab = window.electronAPI.gateway.onRemoteTabCreated((data) => {
    if (data.ptyId) {
      // 检查是否已经为此 ptyId 创建过标签页（避免重复创建）
      const existingTab = terminalStore.tabs.find(tab => tab.ptyId === data.ptyId)
      if (!existingTab) {
        terminalStore.createTabWithExistingPty({
          ptyId: data.ptyId,
          title: data.title || '📡 Remote Agent',
          type: data.type || 'local',
          isRemote: true,
          activate: false  // 不激活，避免干扰用户当前操作
        })
        log.debug(`[Gateway] 远程 Agent 终端标签页已创建（后台）: ptyId=${data.ptyId}`)
      }
    }
  })

  // 监听远程 Gateway 任务开始事件（关键时刻 Toast 通知 + 初始化 Agent 消息）
  cleanupGatewayRemoteTask = window.electronAPI.gateway.onRemoteTaskStarted((data) => {
    log.debug(`[RemoteDebug] onRemoteTaskStarted: ptyId=${data.ptyId}, remoteChannel=${data.remoteChannel}, message="${data.message.substring(0, 60)}"`)
    const preview = data.message.length > 60
      ? data.message.substring(0, 60) + '...'
      : data.message
    toast.info(`📡 ${t('gateway.remoteTaskStarted')}: ${preview}`, 5000)

    // 在远程标签页中初始化 Agent 状态，让 AiPanel 能显示进度
    // 如果标签页不存在（用户手动关闭后再次收到任务），自动重新创建
    let remoteTab = terminalStore.tabs.find(tab => tab.ptyId === data.ptyId)
    log.debug(`[RemoteDebug] 查找 tab: ptyId=${data.ptyId}, found=${!!remoteTab}, isRemote=${remoteTab?.isRemote}, tabId=${remoteTab?.id}`)
    if (!remoteTab) {
      const newTabId = terminalStore.createTabWithExistingPty({
        ptyId: data.ptyId,
        title: '📡 Remote Agent',
        type: 'local',
        isRemote: true,
        activate: false  // 不激活，避免干扰用户当前操作
      })
      remoteTab = terminalStore.tabs.find(tab => tab.id === newTabId)
      log.debug(`[RemoteDebug] 新建远程 tab: newTabId=${newTabId}, found=${!!remoteTab}`)

      // 等 Terminal.vue 挂载完成后触发 resize，让 shell 重绘 prompt
      setTimeout(() => {
        window.electronAPI.pty.resize(data.ptyId, 80, 24)
      }, 300)
    }
    if (remoteTab) {
      // 不切换 tab、不打开 AI 面板，避免干扰用户当前操作；tab 已在栏内可见，用户可自行点击查看
      // 标记 Agent 正在运行
      const hadAgentState = !!remoteTab.agentState
      const prevStepsCount = remoteTab.agentState?.steps?.length ?? 0
      if (!remoteTab.agentState) {
        remoteTab.agentState = {
          isRunning: true,
          steps: [],
          pendingConfirm: undefined,
          agentId: undefined,
          userTask: data.message
        }
      } else {
        remoteTab.agentState.isRunning = true
        remoteTab.agentState.userTask = data.message
      }
      remoteTab.aiLoading = true

      // user_task 步骤由后端 Agent 统一生成并通过 onStep 推送，前端不再手动添加
      log.debug(`[RemoteDebug] 远程任务已启动: tabId=${remoteTab.id}, hadAgentState=${hadAgentState}, prevSteps=${prevStepsCount}, nowSteps=${remoteTab.agentState!.steps.length}`)
    } else {
      log.warn(`[RemoteDebug] 无法找到或创建远程 tab: ptyId=${data.ptyId}`)
    }
  })

  // 远程 Agent 事件路由：直接写入 store，不依赖 useAgentMode 的 tab 过滤
  // 这确保即使用户不在远程标签页上，事件数据也不会丢失
  cleanupRemoteAgentStep = window.electronAPI.agent.onStep((data: { agentId: string; ptyId?: string; step: any }) => {
    if (!data.ptyId) return
    // 只处理远程标签页的事件
    const tab = terminalStore.tabs.find(tab => tab.ptyId === data.ptyId && tab.isRemote)
    if (!tab) return
    // 确保 agentState 存在
    if (!tab.agentState) {
      log.warn(`[RemoteDebug] onStep: tab ${tab.id} 的 agentState 不存在，手动创建`)
      tab.agentState = { isRunning: true, steps: [], agentId: data.agentId }
    }
    // 关联 agentId
    if (data.agentId && !tab.agentState!.agentId) {
      tab.agentState!.agentId = data.agentId
    }
    // 存入 store（addAgentStep 自动处理新增/更新）
    const prevCount = tab.agentState!.steps.length
    terminalStore.addAgentStep(tab.id, data.step)
    const newCount = tab.agentState!.steps.length
    // 仅在新增步骤或特殊类型时打印，避免流式 message 更新刷屏
    if (newCount !== prevCount || data.step.type !== 'message') {
      log.debug(`[RemoteDebug] onStep: type=${data.step.type}, id=${data.step.id}, tabId=${tab.id}, steps: ${prevCount}→${newCount}`)
    }
  })

  cleanupRemoteAgentComplete = window.electronAPI.agent.onComplete((data: { agentId: string; ptyId?: string; result: string }) => {
    if (!data.ptyId) return
    const tab = terminalStore.tabs.find(tab => tab.ptyId === data.ptyId && tab.isRemote)
    if (!tab || !tab.agentState) return
    log.debug(`[RemoteDebug] onComplete: ptyId=${data.ptyId}, tabId=${tab.id}, stepsBeforeComplete=${tab.agentState.steps.length}, result="${data.result.substring(0, 60)}"`)
    // final_result 步骤由后端 Agent 统一生成并通过 onStep 推送
    tab.agentState.isRunning = false
    tab.aiLoading = false
  })

  cleanupRemoteAgentConfirm = window.electronAPI.agent.onNeedConfirm((data: any) => {
    if (!data.ptyId) return
    const tab = terminalStore.tabs.find(tab => tab.ptyId === data.ptyId && tab.isRemote)
    if (!tab || !tab.agentState) return
    terminalStore.setAgentPendingConfirm(tab.id, {
      agentId: data.agentId,
      toolCallId: data.toolCallId,
      toolName: data.toolName,
      toolArgs: data.toolArgs,
      riskLevel: data.riskLevel
    })
  })

  // 全局监听 IM 渠道连接状态变化，弹 toast 通知
  const imPlatformNames: Record<string, string> = {
    dingtalk: t('settings.im.dingtalk'),
    feishu: t('settings.im.feishu'),
    slack: t('settings.im.slack'),
    telegram: t('settings.im.telegram'),
    wecom: t('settings.im.wecom'),
  }
  const imConnectedState = new Map<string, boolean>()
  cleanupImConnectionChange = window.electronAPI.im.onConnectionChange((data) => {
    const prev = imConnectedState.get(data.platform)
    imConnectedState.set(data.platform, data.connected)
    // 仅在状态真正变化时提示（跳过首次上报，避免启动时刷屏）
    if (prev === undefined) return
    const name = imPlatformNames[data.platform] || data.platform
    if (data.connected) {
      toast.success(t('im.channelConnected', { platform: name }))
    } else {
      toast.warning(t('im.channelDisconnected', { platform: name }))
    }
  })

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

  // 延迟连接 MCP 服务器，不阻塞首屏渲染
  // 使用 requestIdleCallback 或 setTimeout 在浏览器空闲时执行
  const connectMcpServers = async () => {
    try {
      const results = await window.electronAPI.mcp.connectEnabledServers()
      const connected = results.filter(r => r.success).length
      const failed = results.filter(r => !r.success)
      if (connected > 0) {
        log.info(`[MCP] 自动连接了 ${connected} 个服务器`)
      }
      if (failed.length > 0) {
        log.warn('[MCP] 部分服务器连接失败:', failed)
      }
    } catch (error) {
      log.error('[MCP] 自动连接服务器失败:', error)
    }
  }

  // 延迟执行，让 UI 先渲染完成
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => connectMcpServers(), { timeout: 3000 })
  } else {
    setTimeout(connectMcpServers, 500)
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
    privateKeyPath: session.privateKeyPath,  // 私钥文件路径
    passphrase: session.passphrase,  // 私钥密码
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
  // 隐藏 AI 面板时让终端获得焦点
  if (!showAiPanel.value && terminalStore.activeTabId) {
    terminalStore.focusTerminal()
  }
}

// 打开 SFTP 文件管理器（模态框模式）
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

// 有新的 Agent 任务时确保 AI 面板可见
watch(() => Object.keys(terminalStore.pendingSchedulerTasks).length, (count) => {
  if (count > 0) {
    showAiPanel.value = true
  }
})

const openConnectionSettings = (tab?: string) => {
  settingsInitialTab.value = tab || undefined
  showSettings.value = true
}

// 关闭控制面板
const closeSettings = () => {
  showSettings.value = false
  settingsInitialTab.value = undefined
  pendingInstallSkillId.value = undefined
}

// 重新运行引导
const restartSetup = async () => {
  showSetupWizard.value = true
}

// 处理菜单命令
const handleMenuCommand = async (command: string) => {
  switch (command) {
    case 'newLocalTerminal':
      terminalStore.createTab('local')
      break
    case 'newSshConnection':
      showSidebar.value = true
      break
    case 'openFileManager':
      // 通过自定义事件通知终端组件打开文件管理器（复用右键菜单逻辑）
      window.dispatchEvent(new CustomEvent('menu:open-file-manager'))
      break
    case 'importXshell':
      // 打开侧边栏并触发导入对话框
      showSidebar.value = true
      // 延迟触发导入事件，确保侧边栏已打开
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('menu:import-xshell'))
      }, 100)
      break
    case 'closeTab':
      handleCloseShortcut()
      break
    case 'toggleSidebar':
      toggleSidebar()
      break
    case 'toggleAiPanel':
      toggleAiPanel()
      break
    case 'toggleKnowledge':
      showKnowledgeManager.value = true
      break
    case 'openSettings':
      showSettings.value = true
      break
    case 'showAbout':
      settingsInitialTab.value = 'about'
      showSettings.value = true
      break
    case 'checkUpdate':
      settingsInitialTab.value = 'about'
      showSettings.value = true
      // 延迟触发更新检查
      setTimeout(() => {
        window.electronAPI.updater.checkForUpdates()
      }, 500)
      break
    case 'clearTerminal':
      // 通过自定义事件通知终端组件清屏
      window.dispatchEvent(new CustomEvent('menu:clear-terminal'))
      break
    case 'find':
      // 通过自定义事件通知终端组件打开查找
      window.dispatchEvent(new CustomEvent('menu:find'))
      break
    case 'selectAll':
      // 通过自定义事件通知终端组件全选
      window.dispatchEvent(new CustomEvent('menu:select-all'))
      break
    case 'batchCommand':
      // 触发批量命令面板（通过自定义事件）
      window.dispatchEvent(new CustomEvent('toggle-batch-panel'))
      break
    case 'openAiDebugConsole':
      // 打开 AI 调试控制台
      window.electronAPI.aiDebugOpenWindow()
      break
  }
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
  // 清理监听器
  cleanupTerminalCountListener?.()
  cleanupKnowledgeUpgrading?.()
  cleanupKnowledgeProgress?.()
  cleanupKnowledgeReady?.()
  cleanupMenuCommand?.()
  cleanupSchedulerTaskStarted?.()
  cleanupGatewayRemoteTab?.()
  cleanupGatewayRemoteTask?.()
  cleanupRemoteAgentStep?.()
  cleanupRemoteAgentComplete?.()
  cleanupRemoteAgentConfirm?.()
  cleanupImConnectionChange?.()
  cleanupRunTask?.()
  cleanupInstallSkill?.()
})
</script>

<template>
  <div class="app-container" :class="{ 'sidebar-open': showSidebar, 'ai-open': showAiPanel }" :data-ui-theme="currentUiTheme" :data-color-scheme="currentColorScheme">
    <!-- 顶部工具栏 -->
    <header class="app-header">
      <div class="header-left">
        <button class="btn-icon" @click="toggleSidebar" :title="t('header.sessionManager')">
          <Server :size="18" />
        </button>
        <span class="app-title">{{ isSteamBuild ? steamAppTitle : t('app.title') }}</span>
      </div>
      <div class="header-center">
        <TabBar />
      </div>
      <div class="header-right">
        <template v-if="!isSteamBuild">
          <button class="btn-icon" @click="toggleAiPanel" :title="t('header.aiAssistant')">
            <Bot :size="18" />
          </button>
          <SchedulerPopover @open-manager="showSchedulerManager = true" />
          <button class="btn-icon" @click="showWatchManager = true" title="Watch 管理（感知层）">
            <Eye :size="18" />
          </button>
          <ConnectionStatusPopover @open-settings="openConnectionSettings" />
        </template>
        <button class="btn-icon" @click="showSettings = true" :title="t('header.settings')">
          <Settings :size="18" />
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
            <X :size="14" />
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

      <!-- AI 面板 - Steam 版不渲染；非 Steam 版仅在有终端时显示 -->
      <template v-if="!isSteamBuild && showAiPanel && !showWelcomePage">
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
              :visible="tab.id === terminalStore.activeTabId"
              @close="showAiPanel = false" 
            />
          </template>
        </aside>
      </template>
    </div>

    <!-- 控制面板 -->
    <SettingsModal 
      v-if="showSettings" 
      :initial-tab="settingsInitialTab"
      :pending-install-skill-id="pendingInstallSkillId"
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

    <!-- 知识库管理器 -->
    <KnowledgeManager
      v-if="showKnowledgeManager"
      @close="showKnowledgeManager = false"
    />

    <!-- 定时任务管理器 -->
    <SchedulerManager
      v-if="showSchedulerManager"
      @close="showSchedulerManager = false"
    />

    <!-- Watch 管理器（感知层） -->
    <WatchManager
      v-if="showWatchManager"
      @close="showWatchManager = false"
    />

    <!-- 知识库升级进度提示 -->
    <Transition name="slide-down">
      <div v-if="knowledgeUpgrading" class="knowledge-upgrade-bar">
        <div class="upgrade-content">
          <Loader2 class="upgrade-icon" :size="16" />
          <span class="upgrade-text">
            {{ t('knowledge.upgrading') }}
            <template v-if="knowledgeUpgradeProgress.total > 0">
              ({{ knowledgeUpgradeProgress.current }}/{{ knowledgeUpgradeProgress.total }})
            </template>
          </span>
          <span v-if="knowledgeUpgradeProgress.filename" class="upgrade-filename">
            {{ knowledgeUpgradeProgress.filename }}
          </span>
        </div>
        <div class="upgrade-progress">
          <div 
            class="upgrade-progress-bar" 
            :style="{ width: knowledgeUpgradeProgress.total > 0 ? (knowledgeUpgradeProgress.current / knowledgeUpgradeProgress.total * 100) + '%' : '0%' }"
          ></div>
        </div>
      </div>
    </Transition>

    <!-- 全局 Toast 提示 -->
    <Toast />

    <!-- 全局确认对话框 -->
    <ConfirmDialog
      :show="showConfirmDialog"
      :options="confirmOptions"
      @confirm="handleConfirm"
      @cancel="handleCancel"
      @close="handleClose"
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
  position: relative;
  z-index: 10;
}

/* 深色主题：顶部渐变效果 */
[data-color-scheme="dark"] .app-header {
  background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(var(--bg-secondary-rgb, 24, 24, 37), 0.95) 100%);
}

/* 浅色主题：简洁干净的顶部栏 */
[data-color-scheme="light"] .app-header {
  background: var(--bg-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

/* 深色主题：顶部微光效果 */
[data-color-scheme="dark"] .app-header::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.2), transparent);
  pointer-events: none;
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 4px;
  -webkit-app-region: no-drag;
}

.header-left .btn-icon,
.header-right .btn-icon {
  width: 30px;
  height: 30px;
  padding: 6px;
  border-radius: 6px;
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
  font-weight: 700;
  color: var(--text-primary);
  margin-left: 8px;
  letter-spacing: 0.3px;
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
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  position: relative;
  animation: slideInLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideInLeft {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* 侧边栏右边缘光效 */
.sidebar::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.15), transparent);
  pointer-events: none;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  text-transform: uppercase;
  letter-spacing: 0.5px;
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
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: relative;
  animation: slideInRight 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes slideInRight {
  from {
    opacity: 0;
    transform: translateX(20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

/* AI 侧边栏左边缘光效 */
.ai-sidebar::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(180deg, transparent, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.15), transparent);
  pointer-events: none;
}

/* 拖拽调整宽度手柄 */
.resize-handle {
  width: 5px;
  cursor: col-resize;
  background: transparent;
  transition: all 0.25s ease;
  flex-shrink: 0;
  position: relative;
}

.resize-handle::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 3px;
  height: 40px;
  background: var(--border-color);
  border-radius: 2px;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.resize-handle:hover::after,
.resize-handle.resizing::after {
  opacity: 1;
}

.resize-handle:hover,
.resize-handle.resizing {
  background: linear-gradient(180deg, transparent, rgba(var(--accent-rgb, 137, 180, 250), 0.3), transparent);
}

.resize-handle.resizing::after {
  background: var(--accent-primary);
  box-shadow: 0 0 10px var(--accent-primary);
}

/* 知识库升级进度条 */
.knowledge-upgrade-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  z-index: 1000;
}

.upgrade-content {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 13px;
  color: var(--text-secondary);
}

.upgrade-icon {
  animation: spin 1s linear infinite;
  color: var(--accent-primary);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.upgrade-text {
  color: var(--text-primary);
}

.upgrade-filename {
  color: var(--text-tertiary);
  font-size: 12px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.upgrade-progress {
  height: 2px;
  background: var(--bg-tertiary);
}

.upgrade-progress-bar {
  height: 100%;
  background: var(--accent-primary);
  transition: width 0.3s ease;
}

/* 进度条动画 */
.slide-down-enter-active,
.slide-down-leave-active {
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

</style>

