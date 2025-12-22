<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { getTheme } from '../themes'
import { TerminalScreenService, type ScreenContent } from '../services/terminal-screen.service'
import { TerminalSnapshotManager, type TerminalSnapshot, type TerminalDiff } from '../services/terminal-snapshot.service'
import '@xterm/xterm/css/xterm.css'

const { t } = useI18n()

const props = defineProps<{
  tabId: string
  ptyId: string
  type: 'local' | 'ssh'
  isActive: boolean
}>()

const configStore = useConfigStore()
const terminalStore = useTerminalStore()

const terminalRef = ref<HTMLDivElement | null>(null)
let terminal: XTerm | null = null
let fitAddon: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let screenService: TerminalScreenService | null = null
let snapshotManager: TerminalSnapshotManager | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeDisconnect: (() => void) | null = null  // SSH 断开连接事件取消订阅
let unsubscribeScreenRequest: (() => void) | null = null  // 主进程屏幕内容请求监听
let unsubscribeVisibleRequest: (() => void) | null = null  // 主进程可视内容请求监听
let unsubscribeAnalysisRequest: (() => void) | null = null  // 主进程屏幕分析请求监听
let resizeObserver: ResizeObserver | null = null
let isDisposed = false
let isPasting = false
let keyDownHandler: ((event: KeyboardEvent) => void) | null = null
let resizeTimeout: ReturnType<typeof setTimeout> | null = null
let dprMediaQuery: MediaQueryList | null = null
let dprChangeHandler: (() => void) | null = null
// 用户输入缓冲区（用于 CWD 追踪）
let inputBuffer = ''

// 右键菜单状态
const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  hasSelection: false,
  selectedText: ''
})

// SSH 断开连接状态（用于显示重连按钮）
const sshDisconnected = ref(false)
const isReconnecting = ref(false)

// 初始化终端
onMounted(async () => {
  if (!terminalRef.value) return

  // 获取主题
  const theme = getTheme(configStore.currentTheme)
  const settings = configStore.terminalSettings

  // 创建终端实例
  terminal = new XTerm({
    theme,
    fontSize: settings.fontSize,
    fontFamily: settings.fontFamily,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
    allowProposedApi: true,
    convertEol: true
  })

  // 加载插件
  fitAddon = new FitAddon()
  searchAddon = new SearchAddon()
  const webLinksAddon = new WebLinksAddon()

  terminal.loadAddon(fitAddon)
  terminal.loadAddon(searchAddon)
  terminal.loadAddon(webLinksAddon)

  // 挂载到 DOM
  terminal.open(terminalRef.value)

  // 创建屏幕服务实例
  screenService = new TerminalScreenService(terminal)
  
  // 创建快照管理器
  snapshotManager = new TerminalSnapshotManager(screenService)
  
  // 注册屏幕服务和快照管理器到 store（供外部访问）
  terminalStore.registerScreenService(props.tabId, screenService)
  terminalStore.registerSnapshotManager(props.tabId, snapshotManager)

  // 初始化终端状态服务（CWD 追踪等）
  window.electronAPI.terminalState.init(props.ptyId, props.type)

  // 适配大小 - 使用 setTimeout 确保 DOM 完全渲染和布局完成
  await nextTick()
  setTimeout(async () => {
    if (fitAddon && terminal && terminalRef.value) {
      // 检查容器是否有有效尺寸
      const rect = terminalRef.value.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        fitAddon.fit()
        // 更新后端 PTY 大小
        const { cols, rows } = terminal
        await terminalStore.resizeTerminal(props.tabId, cols, rows)
        terminal.focus()
      }
    }
  }, 100)

  // 监听用户输入
  if (!terminal) return
  terminal.onData(data => {
    terminalStore.writeToTerminal(props.tabId, data)
    
    // 追踪用户输入（用于 CWD 变化检测）
    // 当用户按下回车时，发送完整命令给终端状态服务
    if (data === '\r' || data === '\n') {
      if (inputBuffer.trim()) {
        window.electronAPI.terminalState.handleInput(props.ptyId, inputBuffer)
      }
      inputBuffer = ''
    } else if (data === '\x7f' || data === '\b') {
      // 退格键，删除缓冲区最后一个字符
      inputBuffer = inputBuffer.slice(0, -1)
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      // 普通可打印字符
      inputBuffer += data
    } else if (data.length > 1 && !data.includes('\x1b')) {
      // 粘贴的文本（不包含转义序列）
      inputBuffer += data
    }
  })

  // 处理 Ctrl+C 复制和 Ctrl+Shift+R 重连
  terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    // Ctrl+C 复制选中内容
    if ((event.ctrlKey || event.metaKey) && event.key === 'c' && event.type === 'keydown') {
      const selection = terminal?.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
        return false // 阻止默认行为（不发送 SIGINT）
      }
      // 没有选中内容时，让 Ctrl+C 发送到终端（作为中断信号）
      return true
    }
    // Ctrl+Shift+R SSH 重连
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'R' && event.type === 'keydown') {
      if (props.type === 'ssh' && sshDisconnected.value) {
        handleReconnect()
        return false
      }
    }
    return true
  })

  // 处理 Ctrl+V 粘贴 - 监听 DOM 事件
  const handlePaste = async () => {
    if (isPasting || isDisposed || !terminal) return
    isPasting = true
    
    try {
      const text = await navigator.clipboard.readText()
      if (text) {
        terminalStore.writeToTerminal(props.tabId, text)
      }
    } catch (e) {
      // 忽略错误
    } finally {
      setTimeout(() => { isPasting = false }, 200)
    }
  }

  keyDownHandler = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
      event.preventDefault()
      event.stopPropagation()
      handlePaste()
    }
  }

  if (terminalRef.value) {
    terminalRef.value.addEventListener('keydown', keyDownHandler, true)
  }

  // 订阅后端数据
  if (props.type === 'local') {
    unsubscribe = window.electronAPI.pty.onData(props.ptyId, (data: string) => {
      if (!isDisposed && terminal) {
        try {
          terminal.write(data)
          // 捕获输出用于 AI 分析
          terminalStore.appendOutput(props.tabId, data)
        } catch (e) {
          // 忽略写入错误
        }
      }
    })
  } else {
    unsubscribe = window.electronAPI.ssh.onData(props.ptyId, (data: string) => {
      if (!isDisposed && terminal) {
        try {
          terminal.write(data)
          // 捕获输出用于 AI 分析
          terminalStore.appendOutput(props.tabId, data)
        } catch (e) {
          // 忽略写入错误
        }
      }
    })

    // 监听 SSH 断开连接事件
    unsubscribeDisconnect = window.electronAPI.ssh.onDisconnected(props.ptyId, (event) => {
      if (!isDisposed && terminal) {
        // 更新连接状态
        terminalStore.updateConnectionStatus(props.tabId, false)
        
        // 在终端显示断开连接消息
        const reasonMap: Record<string, string> = {
          'closed': t('terminal.disconnectReasons.closed'),
          'error': t('terminal.disconnectReasons.error'),
          'stream_closed': t('terminal.disconnectReasons.stream_closed'),
          'jump_host_closed': t('terminal.disconnectReasons.jump_host_closed')
        }
        const reasonText = reasonMap[event.reason] || event.reason
        const errorText = event.error ? `: ${event.error}` : ''
        terminal.write(`\r\n\x1b[31m${t('terminal.sshDisconnected')} ${reasonText}${errorText}\x1b[0m\r\n`)
        
        // 检查是否可以重连（有保存的会话 ID）
        const tab = terminalStore.tabs.find(tb => tb.id === props.tabId)
        if (tab?.sshSessionId) {
          // 设置断开状态（用于显示重连按钮）
          sshDisconnected.value = true
          terminal.write(`\x1b[33m${t('terminal.reconnectHint')}\x1b[0m\r\n`)
        } else {
          terminal.write(`\x1b[33m${t('terminal.noSessionSavedHint')}\x1b[0m\r\n`)
        }
      }
    })
  }

  // 监听选中文本变化
  terminal.onSelectionChange(() => {
    if (terminal) {
      const selection = terminal.getSelection()
      terminalStore.updateSelectedText(props.tabId, selection || '')
    }
  })

  // 重新适配终端大小的函数
  const doFit = () => {
    if (resizeTimeout) {
      clearTimeout(resizeTimeout)
    }
    resizeTimeout = setTimeout(() => {
      if (fitAddon && props.isActive && terminal && !isDisposed) {
        fitAddon.fit()
        terminalStore.resizeTerminal(props.tabId, terminal.cols, terminal.rows)
      }
    }, 50)
  }

  // 监听窗口大小变化（带防抖，确保最大化等动画完成后再计算）
  resizeObserver = new ResizeObserver(() => {
    doFit()
  })
  resizeObserver.observe(terminalRef.value)

  // 监听 devicePixelRatio 变化（窗口在不同 DPI 显示器间移动时）
  const updateDprListener = () => {
    if (dprMediaQuery && dprChangeHandler) {
      dprMediaQuery.removeEventListener('change', dprChangeHandler)
    }
    dprMediaQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dprMediaQuery.addEventListener('change', dprChangeHandler!)
  }

  dprChangeHandler = () => {
    // DPI 变化时重新适配终端
    doFit()
    // 更新监听器以跟踪新的 DPI 值
    updateDprListener()
  }

  updateDprListener()

  // 注册主进程屏幕内容请求监听器
  // 当主进程需要获取准确的终端输出时，会发送请求到渲染进程
  // 先清理旧的监听器，防止热重载时重复注册
  if (unsubscribeScreenRequest) {
    unsubscribeScreenRequest()
    unsubscribeScreenRequest = null
  }
  if (unsubscribeVisibleRequest) {
    unsubscribeVisibleRequest()
    unsubscribeVisibleRequest = null
  }
  if (unsubscribeAnalysisRequest) {
    unsubscribeAnalysisRequest()
    unsubscribeAnalysisRequest = null
  }
  
  unsubscribeScreenRequest = window.electronAPI.screen.onRequestLastNLines((data) => {
    // 检查是否是发给当前终端的请求
    if (data.ptyId === props.ptyId && screenService && !isDisposed) {
      try {
        const lines = screenService.getLastNLines(data.lines)
        window.electronAPI.screen.responseLastNLines(data.requestId, lines)
      } catch (e) {
        // 出错时返回 null，让主进程回退到其他方式
        window.electronAPI.screen.responseLastNLines(data.requestId, null)
      }
    }
  })

  unsubscribeVisibleRequest = window.electronAPI.screen.onRequestVisibleContent((data) => {
    if (data.ptyId === props.ptyId && screenService && !isDisposed) {
      try {
        const lines = screenService.getVisibleContent()
        window.electronAPI.screen.responseVisibleContent(data.requestId, lines)
      } catch (e) {
        window.electronAPI.screen.responseVisibleContent(data.requestId, null)
      }
    }
  })

  // 注册屏幕分析请求监听器
  // 当主进程（Agent）需要实时获取终端状态分析时调用
  unsubscribeAnalysisRequest = window.electronAPI.screen.onRequestScreenAnalysis((data) => {
    console.log(`[Terminal] 收到屏幕分析请求: requestPtyId=${data.ptyId}, myPtyId=${props.ptyId}, match=${data.ptyId === props.ptyId}`)
    if (data.ptyId === props.ptyId && screenService && !isDisposed) {
      try {
        // 获取完整的终端感知状态（包含输入等待检测、输出模式识别、环境分析）
        const awarenessState = screenService.getAwarenessState()
        // 同时获取可视区域内容
        const visibleContent = screenService.getVisibleContent()
        console.log(`[Terminal] 屏幕分析响应: visibleLines=${visibleContent.length}, context=`, awarenessState.context)
        window.electronAPI.screen.responseScreenAnalysis(data.requestId, {
          ...awarenessState,
          visibleContent
        })
      } catch (e) {
        console.error(`[Terminal] 屏幕分析异常:`, e)
        window.electronAPI.screen.responseScreenAnalysis(data.requestId, null)
      }
    }
  })
})

// 清理
onUnmounted(() => {
  // 先标记为已销毁，防止后续回调执行
  isDisposed = true
  
  if (resizeTimeout) {
    clearTimeout(resizeTimeout)
    resizeTimeout = null
  }
  if (dprMediaQuery && dprChangeHandler) {
    dprMediaQuery.removeEventListener('change', dprChangeHandler)
    dprMediaQuery = null
    dprChangeHandler = null
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (unsubscribeDisconnect) {
    unsubscribeDisconnect()
    unsubscribeDisconnect = null
  }
  if (unsubscribeScreenRequest) {
    unsubscribeScreenRequest()
    unsubscribeScreenRequest = null
  }
  if (unsubscribeVisibleRequest) {
    unsubscribeVisibleRequest()
    unsubscribeVisibleRequest = null
  }
  if (unsubscribeAnalysisRequest) {
    unsubscribeAnalysisRequest()
    unsubscribeAnalysisRequest = null
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (keyDownHandler && terminalRef.value) {
    terminalRef.value.removeEventListener('keydown', keyDownHandler, true)
    keyDownHandler = null
  }
  // 注销屏幕服务和快照管理器
  terminalStore.unregisterScreenService(props.tabId)
  terminalStore.unregisterSnapshotManager(props.tabId)
  screenService = null
  snapshotManager = null
  
  // 移除终端状态
  window.electronAPI.terminalState.remove(props.ptyId)
  inputBuffer = ''
  
  if (terminal) {
    terminal.dispose()
    terminal = null
  }
  fitAddon = null
  searchAddon = null
})

// 当标签页激活时，重新适配大小并聚焦
watch(
  () => props.isActive,
  async active => {
    if (active && terminal && fitAddon && terminalRef.value) {
      await nextTick()
      setTimeout(() => {
        if (fitAddon && terminal && terminalRef.value) {
          const rect = terminalRef.value.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            fitAddon.fit()
            terminal.focus()
            terminalStore.resizeTerminal(props.tabId, terminal.cols, terminal.rows)
          }
        }
      }, 50)
    }
  },
  { immediate: true }
)

// 监听主题变化
watch(
  () => configStore.currentTheme,
  themeName => {
    if (terminal) {
      const theme = getTheme(themeName)
      terminal.options.theme = theme
    }
  }
)

// 监听焦点请求（从 AI 助手发送代码到终端后自动聚焦）
watch(
  () => terminalStore.pendingFocusTabId,
  (focusTabId) => {
    if (focusTabId === props.tabId && terminal) {
      nextTick(() => {
        terminal?.focus()
        terminalStore.clearPendingFocus()
      })
    }
  }
)

// 右键菜单处理
const handleContextMenu = (event: MouseEvent) => {
  event.preventDefault()
  
  const selection = terminal?.getSelection() || ''
  contextMenu.value = {
    visible: true,
    x: event.clientX,
    y: event.clientY,
    hasSelection: selection.length > 0,
    selectedText: selection
  }
}

const hideContextMenu = () => {
  contextMenu.value.visible = false
  // 让终端重新获得焦点
  nextTick(() => {
    terminal?.focus()
  })
}

const menuCopy = async () => {
  if (contextMenu.value.selectedText) {
    await navigator.clipboard.writeText(contextMenu.value.selectedText)
  }
  hideContextMenu()
}

const menuPaste = async () => {
  try {
    const text = await navigator.clipboard.readText()
    if (text) {
      terminalStore.writeToTerminal(props.tabId, text)
    }
  } catch (e) {
    // 忽略错误
  }
  hideContextMenu()
}

const menuSendToAi = () => {
  if (contextMenu.value.selectedText) {
    terminalStore.sendToAi(contextMenu.value.selectedText)
  }
  hideContextMenu()
}

const menuClear = () => {
  terminal?.clear()
  hideContextMenu()
}

// 打开文件管理器
const menuOpenFileManager = async () => {
  hideContextMenu()
  
  try {
    // 获取当前工作目录
    // 对于 SSH 终端，需要调用 refreshCwd 来通过 exec channel 获取真实 CWD
    const cwd = props.type === 'ssh' 
      ? await window.electronAPI.terminalState.refreshCwd(props.ptyId)
      : await window.electronAPI.terminalState.getCwd(props.ptyId)
    
    console.log(`[Terminal] menuOpenFileManager: type=${props.type}, ptyId=${props.ptyId}, cwd=${cwd}`)
    
    if (props.type === 'local') {
      // 本地终端：只传入本地路径
      await window.electronAPI.fileManager.open({
        initialLocalPath: cwd || undefined
      })
    } else {
      // SSH 终端：需要 SFTP 配置和远程路径
      const tab = terminalStore.tabs.find(t => t.id === props.tabId)
      if (!tab?.sshSessionId) {
        // 没有保存的会话 ID，尝试使用基本的 SSH 配置
        if (tab?.sshConfig) {
          await window.electronAPI.fileManager.open({
            sftpConfig: {
              host: tab.sshConfig.host,
              port: tab.sshConfig.port,
              username: tab.sshConfig.username
            },
            initialRemotePath: cwd || undefined
          })
        }
        return
      }
      
      // 从 configStore 获取完整的会话配置
      const session = configStore.sshSessions.find(s => s.id === tab.sshSessionId)
      if (session) {
        await window.electronAPI.fileManager.open({
          sessionId: session.id,
          sftpConfig: {
            host: session.host,
            port: session.port,
            username: session.username,
            password: session.password,
            privateKeyPath: session.privateKeyPath,
            passphrase: session.passphrase
          },
          initialRemotePath: cwd || undefined
        })
      }
    }
  } catch (error) {
    console.error('Failed to open file manager:', error)
  }
}

// SSH 重新连接
const handleReconnect = async () => {
  if (props.type !== 'ssh' || isReconnecting.value) return
  
  isReconnecting.value = true
  
  try {
    // 在终端显示正在重连的消息
    terminal?.write(`\r\n\x1b[36m[正在重新连接...]\x1b[0m\r\n`)
    
    // 调用 store 的重连方法
    const result = await terminalStore.reconnectSsh(props.tabId)
    
    // 如果会话未保存，无法重连
    if (result.needsSession) {
      terminal?.write(`\r\n\x1b[33m[无法重连] 该连接未保存为会话，请从会话管理器重新连接\x1b[0m\r\n`)
      // 隐藏重连按钮（无法重连）
      sshDisconnected.value = false
      return
    }
    
    if (!result.success) {
      terminal?.write(`\r\n\x1b[31m[重连失败] 未知错误\x1b[0m\r\n`)
      return
    }
    
    // 重连成功，清除断开状态
    sshDisconnected.value = false
    
    // 在终端显示成功消息
    terminal?.write(`\r\n\x1b[32m[连接成功]\x1b[0m\r\n`)
    
    // 重新订阅数据
    if (unsubscribe) {
      unsubscribe()
    }
    const tab = terminalStore.tabs.find(t => t.id === props.tabId)
    if (tab?.ptyId) {
      unsubscribe = window.electronAPI.ssh.onData(tab.ptyId, (data: string) => {
        if (!isDisposed && terminal) {
          try {
            terminal.write(data)
            terminalStore.appendOutput(props.tabId, data)
          } catch (e) {
            // 忽略写入错误
          }
        }
      })
      
      // 重新订阅断开事件
      if (unsubscribeDisconnect) {
        unsubscribeDisconnect()
      }
      unsubscribeDisconnect = window.electronAPI.ssh.onDisconnected(tab.ptyId, (event) => {
        if (!isDisposed && terminal) {
          terminalStore.updateConnectionStatus(props.tabId, false)
          sshDisconnected.value = true
          const reasonMap: Record<string, string> = {
            'closed': '连接已关闭',
            'error': '连接错误',
            'stream_closed': '数据流已关闭',
            'jump_host_closed': '跳板机连接已断开'
          }
          const reasonText = reasonMap[event.reason] || event.reason
          const errorText = event.error ? `: ${event.error}` : ''
          terminal.write(`\r\n\x1b[31m[SSH 连接断开] ${reasonText}${errorText}\x1b[0m\r\n`)
          terminal.write(`\x1b[33m点击右下角按钮或按 Ctrl+Shift+R 重新连接\x1b[0m\r\n`)
        }
      })
      
      // 重新调整终端大小
      if (fitAddon && terminal) {
        fitAddon.fit()
        await terminalStore.resizeTerminal(props.tabId, terminal.cols, terminal.rows)
      }
    }
  } catch (error) {
    // 在终端显示错误消息
    const errorMsg = error instanceof Error ? error.message : '未知错误'
    terminal?.write(`\r\n\x1b[31m[重连失败] ${errorMsg}\x1b[0m\r\n`)
    terminal?.write(`\x1b[33m点击右下角按钮或按 Ctrl+Shift+R 重试\x1b[0m\r\n`)
  } finally {
    isReconnecting.value = false
  }
}


// 暴露方法供外部调用
defineExpose({
  focus: () => terminal?.focus(),
  search: (text: string) => searchAddon?.findNext(text),
  clear: () => terminal?.clear(),
  // 屏幕内容读取方法
  getScreenContent: (): ScreenContent | null => screenService?.getScreenContent() ?? null,
  getVisibleContent: (): string[] => screenService?.getVisibleContent() ?? [],
  getLastNLines: (n: number): string[] => screenService?.getLastNLines(n) ?? [],
  getCursorPosition: () => screenService?.getCursorPosition() ?? { x: 0, y: 0 },
  getCurrentLine: () => screenService?.getCurrentLine() ?? '',
  isAtPrompt: () => screenService?.isAtPrompt() ?? false,
  detectErrors: (maxLines?: number) => screenService?.detectErrors(maxLines) ?? [],
  // 快照相关方法
  createSnapshot: (name?: string): TerminalSnapshot | null => snapshotManager?.createSnapshot(name) ?? null,
  getSnapshot: (name: string): TerminalSnapshot | undefined => snapshotManager?.getSnapshot(name),
  snapshotAndCompare: (): { snapshot: TerminalSnapshot; diff: TerminalDiff | null } | null => 
    snapshotManager?.snapshotAndCompare() ?? null,
  hasContentChanged: (): boolean => snapshotManager?.hasContentChanged() ?? true,
  getNewOutputSinceLastSnapshot: (): string[] => snapshotManager?.getNewOutputSinceLastSnapshot() ?? []
})
</script>

<template>
  <div 
    class="terminal-wrapper" 
    @contextmenu="handleContextMenu"
    @click="hideContextMenu"
  >
    <div ref="terminalRef" class="terminal-inner"></div>
    
    <!-- SSH 重连按钮 -->
    <div 
      v-if="type === 'ssh' && sshDisconnected" 
      class="reconnect-overlay"
    >
      <button 
        class="reconnect-btn"
        :disabled="isReconnecting"
        @click="handleReconnect"
      >
        <span v-if="isReconnecting" class="reconnect-spinner">⟳</span>
        <span v-else>🔌</span>
        {{ isReconnecting ? '连接中...' : '重新连接' }}
      </button>
    </div>
  </div>
  
  <!-- 右键菜单 -->
  <Teleport to="body">
    <div 
      v-if="contextMenu.visible" 
      class="context-menu"
      :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
      @click.stop
    >
      <div 
        class="menu-item"
        :class="{ disabled: !contextMenu.hasSelection }"
        @click="contextMenu.hasSelection && menuSendToAi()"
      >
        <span class="menu-icon">🤖</span>
        <span>{{ t('terminal.contextMenu.sendToAi') }}</span>
      </div>
      <div class="menu-divider"></div>
      <div 
        class="menu-item" 
        :class="{ disabled: !contextMenu.hasSelection }"
        @click="contextMenu.hasSelection && menuCopy()"
      >
        <span class="menu-icon">📋</span>
        <span>{{ t('terminal.contextMenu.copy') }}</span>
        <span class="shortcut">Ctrl+C</span>
      </div>
      <div class="menu-item" @click="menuPaste()">
        <span class="menu-icon">📄</span>
        <span>{{ t('terminal.contextMenu.paste') }}</span>
        <span class="shortcut">Ctrl+V</span>
      </div>
      <div class="menu-divider"></div>
      <div class="menu-item" @click="menuClear()">
        <span class="menu-icon">🗑️</span>
        <span>{{ t('terminal.contextMenu.clear') }}</span>
      </div>
      <div class="menu-item" @click="menuOpenFileManager()">
        <span class="menu-icon">📁</span>
        <span>{{ t('terminal.contextMenu.openFileManager') }}</span>
      </div>
    </div>
    <div 
      v-if="contextMenu.visible" 
      class="context-menu-overlay" 
      @click="hideContextMenu"
    ></div>
  </Teleport>
</template>

<style scoped>
.terminal-wrapper {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 4px;
  box-sizing: border-box;
  overflow: hidden;
}

.terminal-inner {
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.terminal-inner :deep(.xterm) {
  height: 100% !important;
}

.terminal-inner :deep(.xterm-viewport) {
  overflow-y: auto !important;
}

/* 右键菜单遮罩层 */
.context-menu-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 999;
}

/* 右键菜单 */
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  background: var(--bg-secondary, #2d2d30);
  border: 1px solid var(--border-color, #404040);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  padding: 4px 0;
  font-size: 13px;
}

.menu-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  color: var(--text-primary, #e0e0e0);
  transition: background-color 0.15s;
}

.menu-item:hover:not(.disabled) {
  background: var(--bg-hover, #094771);
}

.menu-item.disabled {
  color: var(--text-disabled, #6e6e6e);
  cursor: not-allowed;
}

.menu-icon {
  width: 20px;
  margin-right: 8px;
  font-size: 14px;
}

.shortcut {
  margin-left: auto;
  color: var(--text-secondary, #888);
  font-size: 11px;
}

.menu-divider {
  height: 1px;
  background: var(--border-color, #404040);
  margin: 4px 0;
}

/* SSH 重连按钮 */
.reconnect-overlay {
  position: absolute;
  bottom: 16px;
  right: 16px;
  z-index: 10;
}

.reconnect-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-accent, #094771);
  color: var(--text-primary, #fff);
  border: 1px solid var(--border-color, #404040);
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.reconnect-btn:hover:not(:disabled) {
  background: var(--bg-hover, #0d5a8c);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.reconnect-btn:active:not(:disabled) {
  transform: translateY(0);
}

.reconnect-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.reconnect-spinner {
  display: inline-block;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>

