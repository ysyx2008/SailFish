/**
 * 应用菜单栏服务
 * 
 * 提供完整的菜单栏功能，包括：
 * - macOS 标准菜单（应用、编辑、视图、窗口）
 * - 前往（跟侧栏同一张地图）
 * - 终端菜单（本机 / 远程 / 分屏等）
 * - 帮助菜单
 * - 多语言支持
 */

import { Menu, MenuItemConstructorOptions, shell, clipboard, BrowserWindow, app } from 'electron'
import { type KeyboardShortcuts, DEFAULT_KEYBOARD_SHORTCUTS } from './config.service'
import { oemResolved } from '@shared/oem-resolve'
import { oemConfig } from '@shared/oem-runtime'

// 菜单翻译
const menuI18n = {
  'zh-CN': {
    // 应用菜单 (macOS)
    about: '关于旗鱼',
    checkUpdate: '检查更新',
    preferences: '控制面板',
    services: '服务',
    hide: '隐藏旗鱼',
    hideOthers: '隐藏其他',
    showAll: '显示全部',
    quit: '退出旗鱼',
    
    // 前往
    go: '前往',
    goNewChat: '新对话',
    goCompanion: '联络',
    goTerminal: '终端',
    openTodos: '待办',
    openWatch: '关切',
    navBack: '后退',
    navForward: '前进',

    // 终端菜单
    file: '终端',
    newLocalTerminal: '打开本机终端',
    newSshConnection: '连接远程主机',
    manageHosts: '管理主机',
    batchCommand: '批量操作',
    openFileManager: '打开文件管理器',
    importXshell: '导入 Xshell 会话',
    splitHorizontal: '左右分屏',
    splitVertical: '上下分屏',
    closePane: '关闭当前窗格',
    closeTab: '关闭标签',
    closeWindow: '关闭窗口',
    exit: '退出',
    
    // 编辑菜单
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    selectAll: '全选',
    clearTerminal: '清屏',
    
    // 视图菜单
    view: '视图',
    toggleSidebar: '收起 / 展开最近对话',
    toggleAiPanel: '收起 / 展开侧边栏',
    toggleKnowledge: '记忆与知识库',
    aiDebugConsole: 'AI 调试控制台',
    llmBenchConsole: '压测控制台',
    zoomIn: '放大',
    zoomOut: '缩小',
    resetZoom: '实际大小',
    toggleFullscreen: '切换全屏',
    toggleDevTools: '开发者工具',
    reload: '重新加载',
    
    // 窗口菜单
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    bringAllToFront: '全部置于最前面',
    
    // 帮助菜单
    help: '帮助',
    documentation: '文档',
    reportIssue: '报告问题',
    github: 'GitHub',
    qqGroup: 'QQ 交流群',
    website: '官方网站',
    restartToUpdate: '重启并更新',
    downloadingUpdate: '正在下载更新…',

    // 退出确认
    quitConfirmTitle: '确认退出',
    quitConfirmMessage: '确定要退出程序吗？',
    quitConfirmDetail: '当前有 {count} 个标签页未关闭，退出将关闭所有标签页。',
    quitConfirmCancel: '取消',
    quitConfirmExit: '退出',

    // 托盘菜单
    trayShowWindow: '显示窗口',
    trayQuit: '退出',
  },
  'en-US': {
    // App menu (macOS)
    about: 'About SailFish',
    checkUpdate: 'Check for Updates',
    preferences: 'Control Panel',
    services: 'Services',
    hide: 'Hide SailFish',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit SailFish',
    
    // Go
    go: 'Go',
    goNewChat: 'New Chat',
    goCompanion: 'Reach',
    goTerminal: 'Terminal',
    openTodos: 'Todos',
    openWatch: 'Watch',
    navBack: 'Go Back',
    navForward: 'Go Forward',

    // Terminal menu
    file: 'Terminal',
    newLocalTerminal: 'Open Local Terminal',
    newSshConnection: 'Connect to a Host',
    manageHosts: 'Manage Hosts',
    batchCommand: 'Batch Command',
    openFileManager: 'Open File Manager',
    importXshell: 'Import Xshell Sessions',
    splitHorizontal: 'Split Left / Right',
    splitVertical: 'Split Up / Down',
    closePane: 'Close Current Pane',
    closeTab: 'Close Tab',
    closeWindow: 'Close Window',
    exit: 'Exit',
    
    // Edit menu
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    clearTerminal: 'Clear Terminal',
    
    // View menu
    view: 'View',
    toggleSidebar: 'Collapse / Expand Recent Chats',
    toggleAiPanel: 'Collapse / Expand Sidebar',
    toggleKnowledge: 'Memory & Knowledge',
    aiDebugConsole: 'AI Debug Console',
    llmBenchConsole: 'Benchmark Console',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    resetZoom: 'Actual Size',
    toggleFullscreen: 'Toggle Full Screen',
    toggleDevTools: 'Developer Tools',
    reload: 'Reload',
    
    // Window menu
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    bringAllToFront: 'Bring All to Front',
    
    // Help menu
    help: 'Help',
    documentation: 'Documentation',
    reportIssue: 'Report Issue',
    github: 'GitHub',
    qqGroup: 'QQ Group',
    website: 'Website',
    restartToUpdate: 'Restart to Update',
    downloadingUpdate: 'Downloading Update…',

    // Quit confirmation
    quitConfirmTitle: 'Confirm Quit',
    quitConfirmMessage: 'Are you sure you want to quit?',
    quitConfirmDetail: '{count} tab(s) are still open. Quitting will close all tabs.',
    quitConfirmCancel: 'Cancel',
    quitConfirmExit: 'Quit',

    // Tray menu
    trayShowWindow: 'Show Window',
    trayQuit: 'Quit',
  },
}

type MenuKey = keyof typeof menuI18n['zh-CN']

const IS_STEAM_BUILD = process.env.VITE_STEAM_BUILD === 'true'

export type MenuUpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export class MenuService {
  private language: 'zh-CN' | 'en-US' = 'zh-CN'
  private mainWindow: BrowserWindow | null = null
  private shortcuts: KeyboardShortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS }
  private hasTerminal = false
  private hasAiPanel = false
  private _updateStatus: MenuUpdateStatus = 'idle'
  private quitHandler: (() => void) | null = null
  /** ⌘W 先关附属窗口（文件管理器等）时返回 true，主窗口就不要再关内容 */
  private closeTabInterceptor: (() => boolean) | null = null
  /** 整窗缩放（不用 role，避免焦点在 webview 里改错对象） */
  private zoomHandler: ((action: 'in' | 'out' | 'reset') => void) | null = null

  /**
   * 获取翻译文本
   */
  private t(key: MenuKey): string {
    return menuI18n[this.language][key] || key
  }

  private aboutLabel(): string {
    const brand = this.language === 'zh-CN' ? oemConfig.brand.name.zh : oemConfig.brand.name.en
    return this.language === 'zh-CN' ? `关于${brand}` : `About ${brand}`
  }

  /**
   * 设置语言
   */
  setLanguage(lang: string): void {
    this.language = lang.startsWith('zh') ? 'zh-CN' : 'en-US'
  }

  /**
   * 设置主窗口引用
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * 设置自定义快捷键（合并到默认值上，空字符串表示禁用）
   */
  setShortcuts(shortcuts: Partial<KeyboardShortcuts>): void {
    this.shortcuts = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...shortcuts }
  }

  /**
   * 设置 ⌘Q 退出回调（不设则直接 app.quit）
   */
  setQuitHandler(handler: () => void): void {
    this.quitHandler = handler
  }

  setCloseTabInterceptor(handler: () => boolean): void {
    this.closeTabInterceptor = handler
  }

  setZoomHandler(handler: (action: 'in' | 'out' | 'reset') => void): void {
    this.zoomHandler = handler
  }

  private handleCloseTabCommand(): void {
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && this.mainWindow && focused !== this.mainWindow && !focused.isDestroyed()) {
      focused.close()
      return
    }
    if (this.closeTabInterceptor?.()) return
    this.sendCommand('closeTab')
  }

  /**
   * 发送菜单命令到渲染进程
   */
  private sendCommand(command: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('menu:command', { command, args })
    }
  }

  /**
   * 构建应用菜单（macOS 专用）
   */
  private buildAppMenu(): MenuItemConstructorOptions {
    return {
      label: app.name,
      submenu: [
        {
          label: this.aboutLabel(),
          click: () => this.sendCommand('showAbout')
        },
        { type: 'separator' },
        {
          label: this.t('preferences'),
          accelerator: this.shortcuts.openSettings || undefined,
          click: () => this.sendCommand('openSettings')
        },
        { type: 'separator' },
        {
          label: this.t('services'),
          role: 'services'
        },
        { type: 'separator' },
        {
          label: this.t('hide'),
          role: 'hide'
        },
        {
          label: this.t('hideOthers'),
          role: 'hideOthers'
        },
        {
          label: this.t('showAll'),
          role: 'unhide'
        },
        { type: 'separator' },
        {
          label: this.t('quit'),
          accelerator: 'Command+Q',
          click: () => {
            if (this.quitHandler) {
              this.quitHandler()
            } else {
              app.quit()
            }
          }
        }
      ]
    }
  }

  /**
   * 前往：跟侧栏同一张地图。加速键只展示——后退/前进已由页面自己接。
   */
  private buildGoMenu(): MenuItemConstructorOptions {
    const places: MenuItemConstructorOptions[] = IS_STEAM_BUILD
      ? [
          {
            label: this.t('goTerminal'),
            click: () => this.sendCommand('goTerminal'),
          },
        ]
      : [
          {
            label: this.t('goNewChat'),
            click: () => this.sendCommand('goNewChat'),
          },
          {
            label: this.t('goCompanion'),
            click: () => this.sendCommand('goCompanion'),
          },
          {
            label: this.t('goTerminal'),
            click: () => this.sendCommand('goTerminal'),
          },
          { type: 'separator' },
          {
            label: this.t('openTodos'),
            click: () => this.sendCommand('openTodos'),
          },
          {
            label: this.t('openWatch'),
            click: () => this.sendCommand('openWatch'),
          },
        ]

    return {
      label: this.t('go'),
      submenu: [
        ...places,
        { type: 'separator' },
        {
          label: this.t('navBack'),
          accelerator: this.shortcuts.navBack || undefined,
          registerAccelerator: false,
          click: () => this.sendCommand('navBack'),
        },
        {
          label: this.t('navForward'),
          accelerator: this.shortcuts.navForward || undefined,
          registerAccelerator: false,
          click: () => this.sendCommand('navForward'),
        },
      ],
    }
  }

  /**
   * 终端菜单：只放终端里的事
   */
  private buildFileMenu(): MenuItemConstructorOptions {
    const submenu: MenuItemConstructorOptions[] = [
      {
        label: this.t('newLocalTerminal'),
        accelerator: this.shortcuts.newLocalTerminal || undefined,
        click: () => this.sendCommand('newLocalTerminal')
      },
      {
        label: this.t('newSshConnection'),
        accelerator: this.shortcuts.newSshConnection || undefined,
        click: () => this.sendCommand('newSshConnection')
      },
      {
        label: this.t('manageHosts'),
        click: () => this.sendCommand('manageHosts')
      },
      { type: 'separator' },
      {
        label: this.t('batchCommand'),
        accelerator: this.shortcuts.batchCommand || undefined,
        enabled: this.hasTerminal,
        click: () => this.sendCommand('batchCommand')
      },
      {
        label: this.t('openFileManager'),
        accelerator: this.shortcuts.openFileManager || undefined,
        enabled: this.hasAiPanel,
        click: () => this.sendCommand('openFileManager')
      },
      { type: 'separator' },
      {
        label: this.t('importXshell'),
        click: () => this.sendCommand('importXshell')
      },
      { type: 'separator' },
      {
        label: this.t('splitHorizontal'),
        accelerator: this.shortcuts.splitHorizontal || undefined,
        registerAccelerator: false,
        enabled: this.hasTerminal,
        click: () => this.sendCommand('splitHorizontal')
      },
      {
        label: this.t('splitVertical'),
        accelerator: this.shortcuts.splitVertical || undefined,
        registerAccelerator: false,
        enabled: this.hasTerminal,
        click: () => this.sendCommand('splitVertical')
      },
      {
        label: this.t('closePane'),
        accelerator: this.shortcuts.closePane || undefined,
        registerAccelerator: false,
        enabled: this.hasTerminal,
        click: () => this.sendCommand('closePane')
      },
      { type: 'separator' },
      {
        label: this.t('closeTab'),
        accelerator: 'CmdOrCtrl+W',
        click: () => this.handleCloseTabCommand()
      }
    ]

    // 非 macOS 添加退出选项
    if (process.platform !== 'darwin') {
      submenu.push(
        { type: 'separator' },
        {
          label: this.t('exit'),
          role: 'quit'
        }
      )
    }

    return {
      label: this.t('file'),
      submenu
    }
  }

  /**
   * 构建编辑菜单
   */
  private buildEditMenu(): MenuItemConstructorOptions {
    return {
      label: this.t('edit'),
      submenu: [
        {
          label: this.t('undo'),
          accelerator: 'CmdOrCtrl+Z',
          role: 'undo'
        },
        {
          label: this.t('redo'),
          accelerator: process.platform === 'darwin' ? 'Shift+CmdOrCtrl+Z' : 'CmdOrCtrl+Y',
          role: 'redo'
        },
        { type: 'separator' },
        {
          label: this.t('cut'),
          accelerator: 'CmdOrCtrl+X',
          role: 'cut'
        },
        {
          label: this.t('copy'),
          accelerator: 'CmdOrCtrl+C',
          role: 'copy'
        },
        {
          label: this.t('paste'),
          accelerator: 'CmdOrCtrl+V',
          role: 'paste'
        },
        {
          label: this.t('selectAll'),
          accelerator: 'CmdOrCtrl+A',
          role: 'selectAll'
        },
        { type: 'separator' },
        {
          label: this.t('clearTerminal'),
          accelerator: this.shortcuts.clearTerminal || undefined,
          click: () => this.sendCommand('clearTerminal')
        }
      ]
    }
  }

  /**
   * 构建视图菜单
   */
  private buildViewMenu(): MenuItemConstructorOptions {
    const submenu: MenuItemConstructorOptions[] = [
      {
        label: this.t('toggleSidebar'),
        accelerator: this.shortcuts.toggleSidebar || undefined,
        click: () => this.sendCommand('toggleSidebar')
      },
      ...(!IS_STEAM_BUILD ? [
        {
          label: this.t('toggleAiPanel'),
          accelerator: this.shortcuts.toggleAiPanel || undefined,
          enabled: this.hasAiPanel,
          click: () => this.sendCommand('toggleAiPanel')
        },
        {
          label: this.t('toggleKnowledge'),
          accelerator: this.shortcuts.toggleKnowledge || undefined,
          click: () => this.sendCommand('toggleKnowledge')
        },
        {
          label: this.t('aiDebugConsole'),
          accelerator: this.shortcuts.aiDebugConsole || undefined,
          click: () => this.sendCommand('openAiDebugConsole')
        },
        {
          label: this.t('llmBenchConsole'),
          click: () => this.sendCommand('openLlmBenchConsole')
        },
      ] as MenuItemConstructorOptions[] : []),
      { type: 'separator' },
      {
        label: this.t('zoomIn'),
        accelerator: 'CmdOrCtrl+=',
        click: () => this.zoomHandler?.('in')
      },
      {
        label: this.t('zoomIn'),
        accelerator: 'CmdOrCtrl+Plus',
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: () => this.zoomHandler?.('in')
      },
      {
        label: this.t('zoomIn'),
        accelerator: 'CmdOrCtrl+numadd',
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: () => this.zoomHandler?.('in')
      },
      {
        label: this.t('zoomOut'),
        accelerator: 'CmdOrCtrl+-',
        click: () => this.zoomHandler?.('out')
      },
      {
        label: this.t('zoomOut'),
        accelerator: 'CmdOrCtrl+numsub',
        visible: false,
        acceleratorWorksWhenHidden: true,
        click: () => this.zoomHandler?.('out')
      },
      {
        label: this.t('resetZoom'),
        accelerator: 'CmdOrCtrl+0',
        click: () => this.zoomHandler?.('reset')
      },
      { type: 'separator' },
      {
        label: this.t('toggleFullscreen'),
        accelerator: process.platform === 'darwin' ? 'Command+Enter' : 'F11',
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.setFullScreen(!this.mainWindow.isFullScreen())
          }
        }
      },
      { type: 'separator' },
      {
        label: this.t('toggleDevTools'),
        accelerator: process.platform === 'darwin' ? 'Cmd+Option+I' : 'Ctrl+Shift+I',
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.toggleDevTools()
          }
        }
      },
      {
        label: this.t('reload'),
        accelerator: 'CmdOrCtrl+Shift+R',
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.reload()
          }
        }
      }
    ]

    return {
      label: this.t('view'),
      submenu
    }
  }

  /**
   * 构建窗口菜单
   */
  private buildWindowMenu(): MenuItemConstructorOptions {
    const submenu: MenuItemConstructorOptions[] = [
      {
        label: this.t('minimize'),
        accelerator: 'CmdOrCtrl+M',
        role: 'minimize'
      },
      {
        label: this.t('zoom'),
        role: 'zoom'
      }
    ]

    if (process.platform === 'darwin') {
      submenu.push(
        { type: 'separator' },
        {
          label: this.t('bringAllToFront'),
          role: 'front'
        }
      )
    } else {
      submenu.push({
        label: this.t('closeWindow'),
        role: 'close'
      })
    }

    return {
      label: this.t('window'),
      submenu
    }
  }

  /**
   * 构建帮助菜单
   */
  private buildHelpMenu(): MenuItemConstructorOptions {
    const links = oemResolved.links
    const github = oemResolved.distribution.github
    const submenu: MenuItemConstructorOptions[] = []
    if (links.docs) {
      submenu.push({
        label: this.t('documentation'),
        click: () => shell.openExternal(links.docs as string)
      })
    }
    if (links.issues) {
      submenu.push({
        label: this.t('reportIssue'),
        click: () => shell.openExternal(links.issues as string)
      })
    }
    if (github || links.qqGroup || links.website) {
      submenu.push({ type: 'separator' })
    }
    if (github) {
      submenu.push({
        label: this.t('github'),
        click: () => shell.openExternal(`https://github.com/${github.owner}/${github.repo}`)
      })
    }
    if (links.qqGroup) {
      const group = links.qqGroup
      submenu.push({
        label: `${this.t('qqGroup')} (${group})`,
        click: () => clipboard.writeText(group)
      })
    }
    if (links.website) {
      submenu.push({
        label: this.t('website'),
        click: () => shell.openExternal(links.website as string)
      })
    }

    // 非 macOS 添加关于选项
    if (process.platform !== 'darwin') {
      submenu.unshift(
        {
          label: this.aboutLabel(),
          click: () => this.sendCommand('showAbout')
        },
        { type: 'separator' }
      )
    }

    // 检查更新 / 重启并更新。两处更新地址都空着时，这个版本不做应用内更新。
    // macOS 无签名公证，不支持自动下载安装，统一走设置页面手动下载
    if (oemResolved.inAppUpdateEnabled) {
    submenu.push({ type: 'separator' })
    if (process.platform === 'darwin') {
      submenu.push({
        label: this.t('checkUpdate'),
        click: () => this.sendCommand('checkUpdate')
      })
    } else if (this._updateStatus === 'downloaded') {
      submenu.push({
        label: this.t('restartToUpdate'),
        click: () => this.sendCommand('restartAndUpdate')
      })
    } else if (this._updateStatus === 'downloading') {
      submenu.push({
        label: this.t('downloadingUpdate'),
        enabled: false,
      })
    } else {
      submenu.push({
        label: this.t('checkUpdate'),
        enabled: this._updateStatus !== 'checking',
        click: () => this.sendCommand('checkUpdate')
      })
    }
    }

    return {
      label: this.t('help'),
      role: 'help',
      submenu
    }
  }

  /**
   * 构建完整菜单
   */
  buildMenu(): Menu {
    const template: MenuItemConstructorOptions[] = []

    // macOS 应用菜单
    if (process.platform === 'darwin') {
      template.push(this.buildAppMenu())
    }

    // 标准菜单：前往跟侧栏同一张地图，终端栏只放终端的事
    template.push(
      this.buildGoMenu(),
      this.buildFileMenu(),
      this.buildEditMenu(),
      this.buildViewMenu(),
      this.buildWindowMenu(),
      this.buildHelpMenu()
    )

    return Menu.buildFromTemplate(template)
  }

  /**
   * 设置更新状态（影响帮助菜单中检查更新/重启更新的显示）
   */
  setUpdateStatus(status: MenuUpdateStatus): void {
    if (this._updateStatus !== status) {
      this._updateStatus = status
      this.applyMenu()
    }
  }

  /**
   * 设置是否有终端标签页（影响文件管理器等菜单项的启用状态）
   */
  setHasTerminal(value: boolean): void {
    if (this.hasTerminal !== value) {
      this.hasTerminal = value
      this.applyMenu()
    }
  }

  /** 人正在终端界面（侧边栏、文件管理器才有对象可开关） */
  setHasAiPanel(value: boolean): void {
    if (this.hasAiPanel !== value) {
      this.hasAiPanel = value
      this.applyMenu()
    }
  }

  /**
   * 退出确认对话框文案（跟随应用语言设置）
   */
  getQuitConfirmDialogOptions(tabCount: number) {
    const detail = this.t('quitConfirmDetail').replace('{count}', String(tabCount))
    return {
      type: 'question' as const,
      buttons: [this.t('quitConfirmCancel'), this.t('quitConfirmExit')],
      defaultId: 0,
      cancelId: 0,
      title: this.t('quitConfirmTitle'),
      message: this.t('quitConfirmMessage'),
      detail,
    }
  }

  /**
   * 托盘右键菜单项（跟随应用语言设置）
   */
  buildTrayContextMenu(options: {
    onShowWindow: () => void
    onQuit: () => void
  }): MenuItemConstructorOptions[] {
    return [
      {
        label: this.t('trayShowWindow'),
        click: options.onShowWindow,
      },
      { type: 'separator' },
      {
        label: this.t('trayQuit'),
        click: options.onQuit,
      },
    ]
  }

  /**
   * 应用菜单
   */
  applyMenu(): void {
    const menu = this.buildMenu()
    Menu.setApplicationMenu(menu)
  }

  /**
   * 更新菜单（语言或快捷键变化时调用）
   */
  updateMenu(language?: string, shortcuts?: Partial<KeyboardShortcuts>): void {
    if (language) {
      this.setLanguage(language)
    }
    if (shortcuts) {
      this.setShortcuts(shortcuts)
    }
    this.applyMenu()
  }
}

// 单例导出
export const menuService = new MenuService()

