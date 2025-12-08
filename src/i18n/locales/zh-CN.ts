export default {
  // 应用级别
  app: {
    title: '旗鱼终端',
    description: 'AI 驱动的跨平台终端'
  },

  // 通用按钮和操作
  common: {
    save: '保存',
    cancel: '取消',
    confirm: '确定',
    delete: '删除',
    edit: '编辑',
    add: '添加',
    new: '新建',
    close: '关闭',
    back: '返回',
    next: '下一步',
    prev: '上一步',
    skip: '跳过',
    finish: '完成',
    search: '搜索',
    refresh: '刷新',
    copy: '复制',
    clear: '清空',
    enable: '启用',
    disable: '禁用',
    enabled: '已启用',
    disabled: '未启用',
    loading: '加载中...',
    unknown: '未知',
    none: '无',
    yes: '是',
    no: '否',
    success: '成功',
    failed: '失败',
    error: '错误',
    warning: '警告',
    info: '信息',
    tips: '提示',
    version: '版本',
    name: '名称',
    type: '类型',
    status: '状态',
    actions: '操作',
    settings: '设置',
    help: '帮助',
    about: '关于',
    import: '导入',
    export: '导出',
    reset: '重置',
    apply: '应用',
    connect: '连接',
    disconnect: '断开',
    retry: '重试',
    select: '选择',
    selectAll: '全选',
    unselectAll: '取消全选',
    noData: '暂无数据',
    confirmDelete: '确定要删除吗？',
    operationSuccess: '操作成功',
    operationFailed: '操作失败'
  },

  // 头部工具栏
  header: {
    sessionManager: '会话管理',
    hostManager: '主机管理',
    aiAssistant: 'AI 助手',
    settings: '设置',
    closeSidebar: '关闭侧边栏'
  },

  // 设置
  settings: {
    title: '设置',
    closeSettings: '关闭设置',
    tabs: {
      ai: 'AI 配置',
      mcp: 'MCP 服务器',
      knowledge: '知识库',
      theme: '主题配色',
      terminal: '终端设置',
      data: '数据管理',
      language: '语言',
      about: '关于'
    },
    restartSetup: '重新运行引导',
    restartSetupConfirm: '确定要重新运行首次启动引导吗？'
  },

  // 关于页面
  about: {
    title: '旗鱼终端',
    description: 'AI 驱动的跨平台智慧终端',
    docs: '使用文档',
    feedback: '问题反馈',
    license: '开源协议',
    copyright: '© 2024 旗鱼'
  },

  // AI 配置
  aiSettings: {
    title: 'AI 模型配置',
    noProfiles: '尚未配置 AI 模型',
    addProfile: '添加配置',
    editProfile: '编辑配置',
    currentlyUsing: '当前使用',
    profileName: '配置名称',
    profileNamePlaceholder: '例如：公司内网模型',
    apiUrl: 'API 地址',
    apiUrlPlaceholder: 'http://10.0.1.100:8080/v1/chat/completions',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'sk-...（本地部署可留空）',
    apiKeyNotRequired: '大多数 API 服务需要提供 Key 才能正常使用（本地部署的 Ollama 等除外）。',
    model: '模型名称',
    modelPlaceholder: '例如：qwen-72b, gpt-3.5-turbo',
    proxy: '代理地址',
    proxyPlaceholder: 'http://proxy:port（可选）',
    contextLength: '上下文长度',
    contextLengthHint: 'tokens',
    saveProfile: '保存配置',
    deleteProfile: '删除配置',
    setActive: '设为当前',
    confirmDeleteProfile: '确定要删除此 AI 配置吗？',
    confirmNoApiKey: '您没有填写 API Key。\n\n大多数 API 服务需要提供 Key 才能正常使用（本地部署的 Ollama 等除外）。\n\n确定要继续保存吗？',
    agentPersonality: 'Agent 性格设置',
    agentPersonalityDesc: '选择 Agent 的性格类型，影响其回复风格',
    noPersonality: '默认（无特定性格）',
    mbtiGroups: {
      analyst: '分析师',
      diplomat: '外交官',
      sentinel: '哨兵',
      explorer: '探险家'
    },
    templates: {
      openai: 'OpenAI 官方 API，支持 GPT-3.5、GPT-4 等模型',
      qwen: '阿里云通义千问，国内访问速度快',
      deepseek: 'DeepSeek 大模型，性价比高',
      ollama: '本地部署的 Ollama，数据不出本地'
    }
  },

  // MCP 设置
  mcpSettings: {
    title: 'MCP 服务器',
    description: 'MCP (Model Context Protocol) 让 AI 能够访问外部工具和资源',
    noServers: '尚未配置 MCP 服务器',
    addServer: '添加服务器',
    editServer: '编辑服务器',
    serverName: '服务器名称',
    serverNamePlaceholder: '例如：文件系统',
    transport: '传输方式',
    transportStdio: '标准输入输出',
    transportSse: 'SSE',
    command: '命令',
    commandPlaceholder: '例如：npx',
    args: '参数',
    argsPlaceholder: '每行一个参数',
    url: 'URL 地址',
    urlPlaceholder: 'http://localhost:3000/sse',
    env: '环境变量',
    envPlaceholder: 'KEY=value（每行一个）',
    autoConnect: '启动时自动连接',
    testConnection: '测试连接',
    connecting: '连接中...',
    connected: '已连接',
    disconnected: '未连接',
    connectionFailed: '连接失败',
    tools: '可用工具',
    noTools: '暂无可用工具'
  },

  // 知识库设置
  knowledgeSettings: {
    title: '知识库设置',
    description: '本地知识库让 AI 能够理解您上传的文档',
    enable: '启用知识库',
    enableHint: '开启后可将对话中上传的文档保存供 Agent 使用',
    stats: '知识库统计',
    documentCount: '文档数量',
    chunkCount: '分块数量',
    storageSize: '存储大小',
    clearKnowledge: '清空知识库',
    clearConfirm: '确定要清空所有知识库数据吗？此操作不可撤销。',
    modelInfo: '向量模型',
    modelDescription: '使用轻量级向量模型（all-MiniLM-L6-v2），已随软件打包，无需额外下载'
  },

  // 终端设置
  terminalSettings: {
    title: '终端设置',
    fontSize: '字体大小',
    fontFamily: '字体',
    cursorBlink: '光标闪烁',
    cursorStyle: '光标样式',
    cursorStyles: {
      block: '方块',
      underline: '下划线',
      bar: '竖线'
    },
    scrollback: '回滚行数',
    scrollbackHint: '终端历史记录保留的行数'
  },

  // 主题设置
  themeSettings: {
    title: '主题设置',
    selectTheme: '选择主题',
    preview: '预览'
  },

  // 数据管理
  dataSettings: {
    title: '数据管理',
    exportData: '导出数据',
    exportDataDesc: '导出所有配置和会话数据',
    importData: '导入数据',
    importDataDesc: '从备份文件导入数据',
    clearData: '清除数据',
    clearDataDesc: '清除所有本地数据（配置、会话、历史记录等）',
    clearDataConfirm: '确定要清除所有数据吗？此操作不可撤销！',
    exportSuccess: '数据导出成功',
    importSuccess: '数据导入成功',
    clearSuccess: '数据清除成功'
  },

  // 语言设置
  languageSettings: {
    title: '语言设置',
    selectLanguage: '选择语言',
    languages: {
      'zh-CN': '简体中文',
      'en-US': 'English'
    },
    restartHint: '部分更改可能需要重启应用才能生效'
  },

  // AI 面板
  ai: {
    assistant: 'AI 助手',
    clearChat: '清空对话',
    closePanel: '关闭面板',
    noConfig: '尚未配置 AI 模型',
    goToSettings: '前往设置',
    switchModel: '切换 AI 模型',
    modeAgent: 'Agent',
    modeChat: '对话',
    agentModeTitle: 'Agent 模式：AI 自主执行命令完成任务',
    chatModeTitle: '对话模式：与 AI 进行问答交流',
    timeout: '超时',
    strict: '严格',
    relaxed: '宽松',
    strictModeTitle: '严格模式：每个命令都需确认',
    relaxedModeTitle: '宽松模式：仅危险命令需确认',
    inputPlaceholder: '输入问题或描述你想要的命令...',
    inputPlaceholderAgent: '描述你想让 Agent 完成的任务...',
    inputPlaceholderSupplement: '输入补充信息（将在下一步生效）...',
    sendMessage: '发送消息 (Enter)',
    executeTask: '执行任务 (Enter)',
    sendSupplement: '发送补充信息 (Enter)',
    stopGeneration: '停止生成',
    stopAgent: '停止 Agent',
    uploadDocument: '上传文档 (PDF/Word/文本)',
    dropToUpload: '释放以上传文档',
    dropHint: '支持 PDF、Word、文本等格式',
    uploadedDocs: '已上传文档',
    clearDocs: '清空所有文档',
    removeDoc: '移除',
    context: '上下文',
    contextUsed: '已使用',
    newMessage: '新消息',
    errorDetected: '检测到错误',
    aiDiagnose: 'AI 诊断',
    closeError: '关闭错误提示',
    selectedContent: '已选中终端内容',
    aiAnalyze: 'AI 分析',
    thinking: 'AI 正在思考中...',
    agentStarting: 'Agent 启动中...',
    agentRunning: 'Agent 执行中',
    agentHistory: 'Agent 执行记录',
    steps: '步',
    taskComplete: '任务完成',
    taskFailed: '任务失败',
    needConfirm: '需要确认',
    highRisk: '高风险',
    mediumRisk: '中风险',
    reject: '拒绝',
    allowExecute: '允许执行',
    supplementInfo: '补充信息',
    pendingProcess: '等待处理',
    welcome: {
      greeting: '你好！我是旗鱼终端的 AI 助手。',
      directChat: '直接对话',
      directChatDesc: '在下方输入框输入任何问题，我会尽力帮你解答。',
      quickFeatures: '快捷功能',
      explainCommand: '解释命令',
      explainCommandDesc: '选中终端内容后点击按钮解释，或直接点击查看示例',
      errorDiagnose: '错误诊断',
      errorDiagnoseDesc: '终端出错时自动提示，点击「AI 诊断」',
      generateCommand: '生成命令',
      generateCommandDesc: '用自然语言描述需求，如「查找大于100M的文件」',
      analyzeOutput: '分析输出',
      analyzeOutputDesc: '选中终端内容后，自动显示「AI 分析」按钮',
      usageTips: '使用技巧',
      tip1: '终端右键菜单可「发送到 AI 分析」',
      tip2: 'AI 回复中的代码块可一键发送到终端',
      tip3: '每个终端标签页有独立的对话记录',
      tip4: '我会根据你的系统环境生成合适的命令'
    },
    agentWelcome: {
      enabled: 'Agent 模式已启用',
      hostInfo: '主机信息',
      refreshHost: '刷新主机信息',
      probing: '探测中...',
      hostname: '主机',
      system: '系统',
      shell: 'Shell',
      tools: '工具',
      knownInfo: '已知信息',
      notProbed: '尚未探测，点击刷新按钮探测主机信息',
      whatIsAgent: '什么是 Agent 模式？',
      agentDesc: 'Agent 可以自主执行命令来完成你的任务，你可以看到完整的执行过程。',
      examples: '使用示例',
      example1: '「查看服务器磁盘空间，如果超过80%就清理日志」',
      example2: '「检查 nginx 服务状态，如果没运行就启动它」',
      example3: '「找出占用内存最多的进程并显示详情」',
      example4: '「在当前目录创建一个 backup 文件夹并备份所有配置文件」',
      strictMode: '严格模式',
      relaxedMode: '宽松模式',
      strictModeOn: '已开启',
      strictModeDesc1: '每个命令都需要你确认后才会执行',
      strictModeDesc2: '适合敏感环境，完全掌控每一步操作',
      relaxedModeDesc1: '安全命令自动执行，只有危险命令需要确认',
      relaxedModeDesc2: '适合日常使用，提高效率的同时保障安全',
      allCommandsVisible: '所有命令都在终端执行，你可以看到完整输入输出',
      cautions: '注意事项',
      caution1: '危险命令（如删除、修改系统文件）始终需要确认',
      caution2: '你可以随时点击「停止」中止 Agent 执行',
      caution3: '不适合长时间运行的命令（如大型编译、数据迁移）',
      caution4: '不适合循环/交互式命令（如 watch、top、tail -f、vim）'
    },
    quickActions: {
      explainCommand: '解释命令',
      generateCommand: '生成命令',
      analyzeError: '分析错误',
      systemStatus: '系统状态'
    },
    toolNames: {
      execute_command: '执行命令',
      read_file: '读取文件',
      write_file: '写入文件',
      get_terminal_context: '获取终端上下文'
    }
  },

  // 会话管理器
  session: {
    title: '会话管理',
    newSession: '新建会话',
    newHost: '新建主机',
    newGroup: '新建分组',
    editSession: '编辑会话',
    editGroup: '编辑分组',
    deleteSession: '删除会话',
    deleteGroup: '删除分组',
    confirmDeleteSession: '确定要删除此会话吗？',
    confirmDeleteGroup: '确定要删除此分组吗？分组内的会话不会被删除。',
    searchPlaceholder: '搜索主机...',
    noSessions: '暂无会话',
    noSessionsHint: '点击上方按钮添加新会话',
    ungrouped: '未分组',
    localTerminal: '本地终端',
    connect: '连接',
    openSftp: '打开 SFTP',
    duplicate: '复制',
    import: '导入',
    importXshell: '导入 Xshell',
    importManual: '手动选择目录',
    form: {
      sessionName: '会话名称',
      sessionNamePlaceholder: '例如：生产服务器',
      host: '主机地址',
      hostPlaceholder: '例如：192.168.1.100',
      port: '端口',
      username: '用户名',
      usernamePlaceholder: '例如：root',
      authType: '认证方式',
      authPassword: '密码',
      authKey: '密钥',
      password: '密码',
      passwordPlaceholder: '输入密码',
      privateKey: '私钥路径',
      privateKeyPlaceholder: '选择私钥文件',
      selectFile: '选择文件',
      passphrase: '密钥密码',
      passphrasePlaceholder: '如果私钥有密码保护',
      group: '分组',
      noGroup: '无分组',
      jumpHost: '跳板机',
      jumpHostEnable: '启用跳板机',
      jumpHostInherit: '继承分组配置',
      jumpHostCustom: '自定义配置',
      jumpHostDisable: '禁用跳板机'
    }
  },

  // 标签栏
  tabs: {
    newTab: '新建终端',
    closeTab: '关闭标签',
    closeOtherTabs: '关闭其他标签页',
    closeTabsToRight: '关闭右侧标签页',
    localTerminal: '本地终端',
    sshTerminal: 'SSH 终端',
    connecting: '连接中...',
    scrollLeft: '向左滚动',
    scrollRight: '向右滚动',
    selectShell: '选择 Shell'
  },

  // 文件管理器
  fileExplorer: {
    title: 'SFTP 文件管理器',
    close: '关闭',
    refresh: '刷新',
    upload: '上传',
    download: '下载',
    newFolder: '新建文件夹',
    newFile: '新建文件',
    rename: '重命名',
    delete: '删除',
    copy: '复制',
    cut: '剪切',
    paste: '粘贴',
    selectAll: '全选',
    confirmDelete: '确定要删除选中的文件/文件夹吗？',
    transferQueue: '传输队列',
    noTransfers: '暂无传输任务',
    fileName: '文件名',
    fileSize: '大小',
    modifyTime: '修改时间',
    permissions: '权限',
    pathBreadcrumb: '路径',
    goToParent: '返回上级',
    emptyFolder: '空文件夹'
  },

  // 首次设置向导
  setup: {
    welcome: {
      title: '欢迎使用旗鱼终端',
      subtitle: 'AI 驱动的智能终端工具，让运维更高效',
      intro: '旗鱼终端是一款专为运维人员设计的智能终端工具，集成了强大的 AI 能力，让您的工作更加高效便捷。通过简单的引导，我们将帮助您完成初始配置，快速开始使用。',
      features: {
        aiChat: {
          title: 'AI 对话助手',
          desc: '在终端中直接与 AI 对话，询问命令用法、排查问题、获取帮助。支持多种大模型，包括 OpenAI、通义千问、DeepSeek 等，也支持本地部署的 Ollama。'
        },
        agent: {
          title: 'Agent 自动执行',
          desc: 'AI Agent 可以理解您的自然语言指令，自动执行复杂的运维任务。支持命令执行、文件操作、系统监控等，让 AI 成为您的得力助手。'
        },
        ssh: {
          title: 'SSH 会话管理',
          desc: '统一管理多台服务器，支持分组、跳板机、快速连接。可以一键导入 Xshell 会话配置，快速迁移现有环境。'
        },
        knowledge: {
          title: '本地知识库',
          desc: '上传文档到本地知识库，AI 对话时自动检索相关内容，提供更精准的答案。支持 PDF、Word、文本等多种格式，使用轻量级向量模型，无需额外下载。'
        }
      },
      skipWizard: '跳过引导'
    },
    aiConfig: {
      title: '配置大模型',
      subtitle: '配置大语言模型，让终端更智能',
      intro: '大模型是 AI 功能的核心，您需要配置至少一个模型才能使用 AI 对话和 Agent 功能。',
      hint: '支持 OpenAI 兼容接口，包括 vLLM、FastChat、Ollama 等私有化部署方案。',
      configuredModels: '已配置的模型',
      addNewModel: '添加新模型',
      quickTemplates: '快速模板：'
    },
    import: {
      title: '导入 SSH 主机',
      subtitle: '快速导入已有的 SSH 主机配置',
      intro: '如果您之前使用 Xshell，可以一键导入所有会话配置，快速迁移到旗鱼终端。',
      scanning: '正在扫描 Xshell 会话目录...',
      found: '找到 {count} 个会话',
      import: '一键导入',
      importing: '导入中...',
      imported: '已导入',
      importSuccess: '成功导入 {count} 个主机',
      importFailed: '导入失败',
      manualSelect: '手动选择目录',
      notFound: '未找到 Xshell 会话目录',
      notFoundHint: '您可以手动选择目录导入，或稍后在设置中添加主机'
    },
    knowledge: {
      title: '启用本地知识库',
      subtitle: '启用本地知识库，让 AI 更懂你的文档',
      features: {
        title: '知识库功能',
        item1: '上传文档到本地知识库，支持 PDF、Word、文本等多种格式',
        item2: 'AI 对话时自动检索相关内容，提供更精准的答案',
        item3: '使用轻量级向量模型（all-MiniLM-L6-v2），已随软件打包，无需额外下载',
        item4: '支持语义搜索和重排序，提高检索准确性'
      },
      enableSwitch: '启用知识库',
      enableHint: '开启后可将对话中上传的文档保存供Agent使用'
    },
    mcp: {
      title: '配置 MCP 服务',
      subtitle: '连接 MCP 服务器，扩展 AI 能力',
      intro: 'MCP (Model Context Protocol) 是一种协议，允许 AI 访问外部工具和资源。',
      hint: '您可以稍后在设置中添加 MCP 服务器，现在可以跳过此步骤。',
      configuredServers: '已配置的 MCP 服务器',
      noServers: '尚未配置 MCP 服务器',
      noServersHint: '您可以在设置中添加 MCP 服务器，扩展 AI 的功能'
    },
    complete: {
      title: '一切就绪！',
      subtitle: '开始使用旗鱼终端吧',
      summary: {
        aiConfigured: '大模型已配置',
        aiNotConfigured: '大模型未配置',
        hostsImported: '已导入 {count} 个主机',
        knowledgeEnabled: '知识库已启用',
        knowledgeNotEnabled: '知识库未启用',
        mcpConfigured: 'MCP 服务已配置',
        mcpNotConfigured: 'MCP 服务未配置'
      },
      tip: '您可以在设置中随时修改这些配置'
    }
  },

  // 终端
  terminal: {
    contextMenu: {
      copy: '复制',
      paste: '粘贴',
      selectAll: '全选',
      clear: '清屏',
      sendToAi: '发送到 AI 分析',
      search: '搜索'
    },
    welcome: {
      title: '欢迎使用旗鱼终端',
      hint: '点击 + 按钮创建新的终端会话'
    },
    newLocalTerminal: '新建本地终端',
    connecting: '正在连接...',
    connectionFailed: '连接失败',
    connectionClosed: '连接已关闭',
    reconnect: '重新连接',
    localTerminal: '本地终端'
  },

  // MCP 状态
  mcp: {
    status: 'MCP 状态',
    connected: '已连接',
    disconnected: '未连接',
    connecting: '连接中',
    error: '错误',
    servers: '服务器',
    noServers: '未配置服务器',
    openSettings: '打开设置'
  }
}
