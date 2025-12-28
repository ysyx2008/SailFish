/**
 * 应用菜单栏服务
 * 
 * 提供完整的菜单栏功能，包括：
 * - macOS 标准菜单（应用、编辑、视图、窗口）
 * - 文件菜单（新建终端、SSH 连接等）
 * - 帮助菜单
 * - 多语言支持
 */

import { Menu, MenuItem, MenuItemConstructorOptions, shell, BrowserWindow, app } from 'electron'

// 菜单翻译
const menuI18n = {
  'zh-CN': {
    // 应用菜单 (macOS)
    about: '关于旗鱼终端',
    checkUpdate: '检查更新...',
    preferences: '偏好设置...',
    services: '服务',
    hide: '隐藏旗鱼终端',
    hideOthers: '隐藏其他',
    showAll: '显示全部',
    quit: '退出旗鱼终端',
    
    // 文件菜单
    file: '文件',
    newLocalTerminal: '新建本地终端',
    newSshConnection: '新建 SSH 连接...',
    openFileManager: '打开文件管理器',
    importXshell: '导入 Xshell 会话...',
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
    find: '查找...',
    clearTerminal: '清屏',
    
    // 视图菜单
    view: '视图',
    toggleSidebar: '切换侧边栏',
    toggleAiPanel: '切换 AI 面板',
    toggleKnowledge: '打开知识库管理',
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
    website: '官方网站'
  },
  'en-US': {
    // App menu (macOS)
    about: 'About SFTerm',
    checkUpdate: 'Check for Updates...',
    preferences: 'Preferences...',
    services: 'Services',
    hide: 'Hide SFTerm',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit SFTerm',
    
    // File menu
    file: 'File',
    newLocalTerminal: 'New Local Terminal',
    newSshConnection: 'New SSH Connection...',
    openFileManager: 'Open File Manager',
    importXshell: 'Import Xshell Sessions...',
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
    find: 'Find...',
    clearTerminal: 'Clear Terminal',
    
    // View menu
    view: 'View',
    toggleSidebar: 'Toggle Sidebar',
    toggleAiPanel: 'Toggle AI Panel',
    toggleKnowledge: 'Open Knowledge Manager',
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
    website: 'Website'
  }
}

type MenuKey = keyof typeof menuI18n['zh-CN']

export class MenuService {
  private language: 'zh-CN' | 'en-US' = 'zh-CN'
  private mainWindow: BrowserWindow | null = null

  /**
   * 获取翻译文本
   */
  private t(key: MenuKey): string {
    return menuI18n[this.language][key] || key
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
          label: this.t('about'),
          click: () => this.sendCommand('showAbout')
        },
        { type: 'separator' },
        {
          label: this.t('checkUpdate'),
          click: () => this.sendCommand('checkUpdate')
        },
        { type: 'separator' },
        {
          label: this.t('preferences'),
          accelerator: 'CmdOrCtrl+,',
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
          role: 'quit'
        }
      ]
    }
  }

  /**
   * 构建文件菜单
   */
  private buildFileMenu(): MenuItemConstructorOptions {
    const submenu: MenuItemConstructorOptions[] = [
      {
        label: this.t('newLocalTerminal'),
        accelerator: 'CmdOrCtrl+T',
        click: () => this.sendCommand('newLocalTerminal')
      },
      {
        label: this.t('newSshConnection'),
        accelerator: 'CmdOrCtrl+N',
        click: () => this.sendCommand('newSshConnection')
      },
      { type: 'separator' },
      {
        label: this.t('openFileManager'),
        accelerator: 'CmdOrCtrl+Shift+F',
        click: () => this.sendCommand('openFileManager')
      },
      { type: 'separator' },
      {
        label: this.t('importXshell'),
        click: () => this.sendCommand('importXshell')
      },
      { type: 'separator' },
      {
        label: this.t('closeTab'),
        accelerator: 'CmdOrCtrl+W',
        click: () => this.sendCommand('closeTab')
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
          label: this.t('find'),
          accelerator: 'CmdOrCtrl+F',
          click: () => this.sendCommand('find')
        },
        { type: 'separator' },
        {
          label: this.t('clearTerminal'),
          accelerator: 'CmdOrCtrl+K',
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
        accelerator: 'CmdOrCtrl+B',
        click: () => this.sendCommand('toggleSidebar')
      },
      {
        label: this.t('toggleAiPanel'),
        accelerator: 'CmdOrCtrl+I',
        click: () => this.sendCommand('toggleAiPanel')
      },
      {
        label: this.t('toggleKnowledge'),
        accelerator: 'CmdOrCtrl+Shift+K',
        click: () => this.sendCommand('toggleKnowledge')
      },
      { type: 'separator' },
      {
        label: this.t('zoomIn'),
        accelerator: 'CmdOrCtrl+=',
        role: 'zoomIn'
      },
      {
        label: this.t('zoomOut'),
        accelerator: 'CmdOrCtrl+-',
        role: 'zoomOut'
      },
      {
        label: this.t('resetZoom'),
        accelerator: 'CmdOrCtrl+0',
        role: 'resetZoom'
      },
      { type: 'separator' },
      {
        label: this.t('toggleFullscreen'),
        accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11',
        role: 'togglefullscreen'
      }
    ]

    // 开发模式添加开发者工具
    if (!app.isPackaged) {
      submenu.push(
        { type: 'separator' },
        {
          label: this.t('reload'),
          accelerator: 'CmdOrCtrl+R',
          role: 'reload'
        },
        {
          label: this.t('toggleDevTools'),
          accelerator: process.platform === 'darwin' ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
          role: 'toggleDevTools'
        }
      )
    }

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
      role: 'window',
      submenu
    }
  }

  /**
   * 构建帮助菜单
   */
  private buildHelpMenu(): MenuItemConstructorOptions {
    const submenu: MenuItemConstructorOptions[] = [
      {
        label: this.t('documentation'),
        click: () => shell.openExternal('http://www.sfterm.com/docs')
      },
      {
        label: this.t('reportIssue'),
        click: () => shell.openExternal('https://github.com/ysyx2008/SFTerminal/issues')
      },
      { type: 'separator' },
      {
        label: this.t('github'),
        click: () => shell.openExternal('https://github.com/ysyx2008/SFTerminal')
      },
      {
        label: this.t('website'),
        click: () => shell.openExternal('http://www.sfterm.com')
      }
    ]

    // 非 macOS 添加关于选项
    if (process.platform !== 'darwin') {
      submenu.unshift(
        {
          label: this.t('about'),
          click: () => this.sendCommand('showAbout')
        },
        { type: 'separator' }
      )
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

    // 标准菜单
    template.push(
      this.buildFileMenu(),
      this.buildEditMenu(),
      this.buildViewMenu(),
      this.buildWindowMenu(),
      this.buildHelpMenu()
    )

    return Menu.buildFromTemplate(template)
  }

  /**
   * 应用菜单
   */
  applyMenu(): void {
    const menu = this.buildMenu()
    Menu.setApplicationMenu(menu)
  }

  /**
   * 更新菜单（语言变化时调用）
   */
  updateMenu(language?: string): void {
    if (language) {
      this.setLanguage(language)
    }
    this.applyMenu()
  }
}

// 单例导出
export const menuService = new MenuService()

