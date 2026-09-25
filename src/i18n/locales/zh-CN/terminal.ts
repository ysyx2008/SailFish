// 终端与会话：会话管理、Tab、终端窗格、MCP 状态、批量命令（产出物文案见 canvas.ts）
export default {

  // 会话管理器
  session: {
    title: '会话管理',
    newSession: '新建会话',
    newHost: '新建主机',
    newGroup: '新建分组',
    editSession: '编辑会话',
    editHost: '编辑主机',
    editGroup: '编辑分组',
    configGroup: '配置分组',
    deleteSession: '删除会话',
    deleteGroup: '删除分组',
    confirmDeleteSession: '确定要删除此会话吗？',
    confirmDeleteHost: '确定要删除主机 "{name}" 吗？',
    confirmDeleteGroup: '确定要删除此分组吗？分组内的会话不会被删除。',
    confirmDeleteGroupNamed: '确定要删除分组 "{name}" 吗？组内主机不会被删除，将移到"默认"分组。',
    searchPlaceholder: '搜索主机...',
    noSessions: '暂无会话',
    noSessionsHint: '点击上方按钮添加新会话',
    noHostsSaved: '暂无保存的主机',
    noHostsHint: '点击"新建"添加主机',
    noMatchingHosts: '未找到匹配的主机',
    tryOtherKeywords: '尝试其他关键词',
    ungrouped: '未分组',
    defaultGroup: '默认',
    localTerminal: '本地终端',
    connect: '连接',
    splitNeedSession: '先打开一个会话再分屏',
    openSftp: '打开 SFTP',
    fileManager: '文件管理',
    duplicate: '复制',
    import: '导入',
    importXshell: '导入 Xshell',
    importXshellFiles: '导入 Xshell 文件...',
    importXshellDir: '导入 Xshell 目录...',
    importManual: '手动选择目录',
    importFailed: '导入失败',
    sort: {
      title: '排序',
      custom: '自定义排序',
      nameAsc: '按名称 A-Z',
      nameDesc: '按名称 Z-A',
      lastUsed: '按最近使用'
    },
    dropHere: '拖放到此处',
    importSuccess: '成功导入 {count} 个会话',
    importPartialFailed: '以下文件导入失败：',
    pleaseInputGroupName: '请输入分组名称',
    pleaseInputJumpHostInfo: '请填写跳板机主机和用户名',
    credentialDialog: {
      title: '输入服务器凭证',
      username: '用户名',
      usernamePlaceholder: 'SSH 登录用户名',
      password: '密码',
      passwordPlaceholder: '留空则尝试无密码连接',
      saveCredentials: '保存凭证',
      connect: '连接',
    },
    form: {
      sessionName: '会话名称',
      sessionNamePlaceholder: '例如：生产服务器',
      name: '名称',
      host: '主机地址',
      hostPlaceholder: 'IP 或域名',
      port: '端口',
      username: '用户名',
      usernamePlaceholder: 'root',
      authType: '认证方式',
      authPassword: '密码',
      authKey: '密钥',
      password: '密码',
      passwordPlaceholder: '输入密码',
      privateKey: '私钥路径',
      privateKeyPath: '私钥路径',
      privateKeyPlaceholder: '选择私钥文件',
      privateKeyPathPlaceholder: '~/.ssh/id_rsa',
      selectFile: '选择文件',
      passphrase: '密钥密码',
      passphrasePlaceholder: '如果私钥有密码保护',
      passphraseOptional: '私钥密码（可选）',
      group: '分组',
      groupName: '分组名称',
      groupNamePlaceholder: '例如：生产环境',
      noGroup: '无分组',
      jumpHost: '跳板机',
      jumpHostHost: '跳板机主机',
      jumpHostEnable: '启用跳板机',
      jumpHostHint: '组内所有主机将通过此跳板机连接',
      jumpHostInherit: '继承分组配置',
      jumpHostCustom: '自定义配置',
      jumpHostDisable: '禁用跳板机',
      jumpHostInheritInfo: '将使用分组「{group}」的跳板机 {host}',
      jumpHostNoInherit: '当前分组未配置跳板机，将直连',
      jumpHostCustomHint: '支持 JumpServer 等堡垒机，端口通常为 2222',
      jumpHostIsJumpServer: '这是 JumpServer',
      jumpHostIsJumpServerHint: '勾选后，跳板机不允许端口转发时会改走堡垒机菜单',
      encoding: '字符编码',
      encodingHint: '远程服务器使用的字符编码，默认 UTF-8',
      encodings: {
        'utf-8': 'UTF-8（默认，支持所有语言）',
        'gbk': 'GBK（简体中文 Windows）',
        'gb2312': 'GB2312（简体中文）',
        'gb18030': 'GB18030（简体中文完整）',
        'big5': 'Big5（繁体中文）',
        'shift_jis': 'Shift-JIS（日语）',
        'euc-jp': 'EUC-JP（日语 Unix）',
        'euc-kr': 'EUC-KR（韩语）',
        'iso-8859-1': 'ISO-8859-1（西欧语言）',
        'iso-8859-15': 'ISO-8859-15（西欧语言含€）',
        'windows-1252': 'Windows-1252（西欧）',
        'koi8-r': 'KOI8-R（俄语）',
        'windows-1251': 'Windows-1251（俄语）'
      }
    },
    validation: {
      nameRequired: '请输入会话名称',
      hostRequired: '请输入主机地址',
      usernameRequired: '请输入用户名',
      saveFailed: '保存失败，请重试'
    }
  },


  // 标签栏
  tabs: {
    home: '首页',
    tasks: '任务',
    reach: '联络',
    todos: '待办',
    todosOverdue: '{n} 项待办已逾期',
    newTab: '新建终端',
    newTabDragHint: '点一下新开标签；拖到窗口边上可并排新开',
    closeTab: '关闭标签',
    closeOtherTabs: '关闭其他标签页',
    closeTabsToRight: '关闭右侧标签页',
    localTerminal: '本地终端',
    sshTerminal: 'SSH 终端',
    assistant: 'AI 助手',
    connecting: '连接中...',
    scrollLeft: '向左滚动',
    scrollRight: '向右滚动',
    selectShell: '选择 Shell',
    sshConnect: 'SSH 连接...',
    confirmCloseAgentRunning: 'AI 助手正在执行任务中，关闭终端将中断执行。确定要关闭吗？',
    confirmCloseWithChat: '当前终端有 AI 对话记录，关闭后将丢失。确定要关闭吗？',
    needsAttentionConfirm: '需要您的确认',
    needsAttentionTaskFinished: 'Agent 已完成任务',
    tasksNeedsAttention: '有任务需要查看',
    doubleClickToRename: '双击重命名标签页'
  },


  // 终端
  terminal: {
    contextMenu: {
      copy: '复制',
      copyFailed: '复制失败，请用 Ctrl/Cmd+C 再试',
      paste: '粘贴',
      selectAll: '全选',
      clear: '清屏',
      sendToAi: '发送到 AI 分析',
      search: '搜索',
      openFileManager: '打开文件管理器'
    },
    welcome: {
      title: '欢迎使用旗鱼',
      hint: '点击 + 按钮创建新的终端会话'
    },
    newLocalTerminal: '新建本地终端',
    loadingEnv: '正在加载环境变量...',
    connecting: '正在连接...',
    cancelConnect: '取消连接',
    connectionFailed: '连接失败',
    connectionClosed: '连接已关闭',
    reconnect: '重新连接',
    reconnecting: '正在重新连接...',
    dropFiles: '拖放文件到终端',
    cannotReconnect: '无法重连',
    cannotReconnectHint: '该连接未保存为会话，请从会话管理器重新连接',
    reconnectFailed: '重连失败',
    commandDone: '完成',
    commandTimeout: '命令执行超时 ({seconds}s)',
    localTerminal: '本地终端',
    hosted: {
      close: '关闭终端',
      newLocal: '再开一扇本地终端',
      newSsh: '再开一扇 SSH'
    },
    sshDisconnected: '[SSH 连接断开]',
    disconnectReasons: {
      closed: '连接已关闭',
      error: '连接错误',
      stream_closed: '数据流已关闭',
      jump_host_closed: '跳板机连接已断开'
    },
    // SSH 连接错误类型
    sshErrors: {
      auth_failed: '认证失败：用户名或密码错误，请检查登录凭据',
      timeout: '连接超时：无法连接到服务器，请检查网络或主机地址',
      connection_refused: '连接被拒绝：服务器拒绝连接，请检查端口是否正确或SSH服务是否运行',
      host_not_found: '主机不存在：无法解析主机地址，请检查主机名是否正确',
      host_unreachable: '主机不可达：无法连接到目标主机，请检查网络连接',
      network_error: '网络错误：网络连接异常，请检查网络设置',
      key_error: '密钥错误：私钥格式不正确或密钥密码错误',
      unknown: '连接失败'
    },
    reconnectHint: '点击右下角按钮或按 Ctrl+Shift+R 重新连接',
    noSessionSavedHint: '该连接未保存为会话，请从会话管理器重新连接',
    split: {
      position: {
        left: '左侧',
        right: '右侧',
        top: '上方',
        bottom: '下方',
        middle: '中间',
        col: '第{n}列',
        row: '第{n}行'
      },
      dragToRearrange: '拖到另一扇边上可换位置',
      label: {
        main: '主窗格',
        new: '新窗格'
      },
      menu: {
        horizontal: '左右分屏',
        vertical: '上下分屏',
        close: '关闭窗格',
        connectTo: '分屏并连接到…'
      },
      button: {
        horizontal: '左右分屏',
        verticalTitle: '上下分屏',
        horizontalTitle: '左右分屏'
      },
      target: {
        title: '分屏并连接到',
        directionLabel: '方向',
        directionHorizontal: '左右',
        directionVertical: '上下',
        targetLabel: '连接到',
        local: '本地终端',
        sshSection: 'SSH 会话',
        noSessions: '尚未配置任何 SSH 会话——前往会话管理添加',
        cancel: '取消',
        confirm: '分屏'
      }
    }
  },


  // MCP 状态
  mcp: {
    status: 'MCP 状态',
    connected: '已连接',
    disconnected: '未连接',
    connecting: '连接中',
    error: '错误',
    servers: '连接器',
    noServers: '未配置连接器',
    openSettings: '打开设置',
    serverList: 'MCP 连接器',
    retry: '重试',
    retryAll: '全部重试',
    healthOk: '{count} 个已启用',
    healthFailed: '{count} 个连接失败',
    healthNetworkDown: '网络不通',
    healthConnecting: '正在连接 {connected}/{total}',
    errorNetwork: '网络不通，请检查网络后重试',
    errorTimeout: '连接超时，请检查网络后重试',
    errorDns: '无法解析地址，请检查网络或连接器地址',
    errorRefused: '连接被拒绝，请确认连接器地址可用',
    connectAll: '全部连接',
    connect: '连接',
    disconnect: '断开',
    tools: '工具',
    disabled: '已禁用',
    noServersConfigured: '尚未配置 MCP 连接器'
  },


  // 批量操作
  batch: {
    title: '批量操作',
    scopeTab: '本标签',
    scopeAll: '全部标签',
    selectPanes: '选择要操作的窗格',
    noActiveTerminals: '没有可用的终端窗格',
    commandInput: '输入命令',
    commandPlaceholder: '输入要发送到所有选中窗格的命令...',
    send: '发送',
    sendEnter: '发送后按回车执行',
    selectedCount: '已选择 {count} 个窗格',
    shortcutHint: '快捷键：Ctrl+Shift+B 打开/关闭批量操作面板，Enter 发送命令；已分屏时默认本标签，否则默认全部标签'
  },
}
