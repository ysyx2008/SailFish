export default {
  // App level
  app: {
    title: 'SFTerminal',
    description: 'AI-powered cross-platform terminal'
  },

  // Common buttons and actions
  common: {
    save: 'Save',
    cancel: 'Cancel',
    confirm: 'Confirm',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
    new: 'New',
    close: 'Close',
    back: 'Back',
    next: 'Next',
    prev: 'Previous',
    skip: 'Skip',
    finish: 'Finish',
    search: 'Search',
    refresh: 'Refresh',
    copy: 'Copy',
    clear: 'Clear',
    enable: 'Enable',
    disable: 'Disable',
    enabled: 'Enabled',
    disabled: 'Disabled',
    loading: 'Loading...',
    unknown: 'Unknown',
    none: 'None',
    yes: 'Yes',
    no: 'No',
    success: 'Success',
    failed: 'Failed',
    error: 'Error',
    warning: 'Warning',
    info: 'Info',
    tips: 'Tips',
    version: 'Version',
    name: 'Name',
    type: 'Type',
    status: 'Status',
    actions: 'Actions',
    settings: 'Settings',
    help: 'Help',
    about: 'About',
    import: 'Import',
    export: 'Export',
    reset: 'Reset',
    apply: 'Apply',
    connect: 'Connect',
    disconnect: 'Disconnect',
    retry: 'Retry',
    select: 'Select',
    selectAll: 'Select All',
    unselectAll: 'Unselect All',
    noData: 'No data',
    confirmDelete: 'Are you sure you want to delete?',
    operationSuccess: 'Operation successful',
    operationFailed: 'Operation failed'
  },

  // Header toolbar
  header: {
    sessionManager: 'Session Manager',
    hostManager: 'Host Manager',
    aiAssistant: 'AI Assistant',
    settings: 'Settings',
    closeSidebar: 'Close Sidebar'
  },

  // Settings
  settings: {
    title: 'Settings',
    closeSettings: 'Close Settings',
    tabs: {
      ai: 'AI Config',
      mcp: 'MCP Servers',
      knowledge: 'Knowledge Base',
      theme: 'Theme',
      terminal: 'Terminal',
      data: 'Data',
      language: 'Language',
      about: 'About'
    },
    restartSetup: 'Restart Setup Wizard',
    restartSetupConfirm: 'Are you sure you want to restart the setup wizard?'
  },

  // About page
  about: {
    title: 'SFTerminal',
    description: 'AI-powered cross-platform smart terminal',
    docs: 'Documentation',
    feedback: 'Feedback',
    license: 'License',
    copyright: '© 2024 SFTerminal'
  },

  // AI Settings
  aiSettings: {
    title: 'AI Model Configuration',
    noProfiles: 'No AI model configured',
    addProfile: 'Add Profile',
    editProfile: 'Edit Profile',
    currentlyUsing: 'Currently using',
    profileName: 'Profile Name',
    profileNamePlaceholder: 'e.g., Company Internal Model',
    apiUrl: 'API URL',
    apiUrlPlaceholder: 'http://10.0.1.100:8080/v1/chat/completions',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'sk-... (optional for local deployment)',
    apiKeyNotRequired: 'Most API services require a key to work (except local deployments like Ollama).',
    model: 'Model Name',
    modelPlaceholder: 'e.g., qwen-72b, gpt-3.5-turbo',
    proxy: 'Proxy',
    proxyPlaceholder: 'http://proxy:port (optional)',
    contextLength: 'Context Length',
    contextLengthHint: 'tokens',
    saveProfile: 'Save Profile',
    deleteProfile: 'Delete Profile',
    setActive: 'Set as Active',
    confirmDeleteProfile: 'Are you sure you want to delete this AI profile?',
    confirmNoApiKey: 'You have not entered an API Key.\n\nMost API services require a key to work (except local deployments like Ollama).\n\nDo you want to continue saving?',
    agentPersonality: 'Agent Personality',
    agentPersonalityDesc: 'Select the Agent personality type to influence its response style',
    noPersonality: 'Default (No specific personality)',
    mbtiGroups: {
      analyst: 'Analyst',
      diplomat: 'Diplomat',
      sentinel: 'Sentinel',
      explorer: 'Explorer'
    },
    templates: {
      openai: 'OpenAI official API, supports GPT-3.5, GPT-4, etc.',
      qwen: 'Alibaba Qwen, fast access in China',
      deepseek: 'DeepSeek LLM, cost-effective',
      ollama: 'Local Ollama deployment, data stays local'
    }
  },

  // MCP Settings
  mcpSettings: {
    title: 'MCP Servers',
    description: 'MCP (Model Context Protocol) allows AI to access external tools and resources',
    noServers: 'No MCP servers configured',
    addServer: 'Add Server',
    editServer: 'Edit Server',
    serverName: 'Server Name',
    serverNamePlaceholder: 'e.g., File System',
    transport: 'Transport',
    transportStdio: 'Standard I/O',
    transportSse: 'SSE',
    command: 'Command',
    commandPlaceholder: 'e.g., npx',
    args: 'Arguments',
    argsPlaceholder: 'One argument per line',
    url: 'URL',
    urlPlaceholder: 'http://localhost:3000/sse',
    env: 'Environment Variables',
    envPlaceholder: 'KEY=value (one per line)',
    autoConnect: 'Auto-connect on startup',
    testConnection: 'Test Connection',
    connecting: 'Connecting...',
    connected: 'Connected',
    disconnected: 'Disconnected',
    connectionFailed: 'Connection Failed',
    tools: 'Available Tools',
    noTools: 'No tools available'
  },

  // Knowledge Settings
  knowledgeSettings: {
    title: 'Knowledge Base Settings',
    description: 'Local knowledge base allows AI to understand your uploaded documents',
    enable: 'Enable Knowledge Base',
    enableHint: 'When enabled, uploaded documents in conversations can be saved for Agent use',
    stats: 'Knowledge Base Statistics',
    documentCount: 'Documents',
    chunkCount: 'Chunks',
    storageSize: 'Storage Size',
    clearKnowledge: 'Clear Knowledge Base',
    clearConfirm: 'Are you sure you want to clear all knowledge base data? This action cannot be undone.',
    modelInfo: 'Vector Model',
    modelDescription: 'Uses lightweight vector model (all-MiniLM-L6-v2), bundled with the app, no additional download required'
  },

  // Terminal Settings
  terminalSettings: {
    title: 'Terminal Settings',
    fontSize: 'Font Size',
    fontFamily: 'Font Family',
    cursorBlink: 'Cursor Blink',
    cursorStyle: 'Cursor Style',
    cursorStyles: {
      block: 'Block',
      underline: 'Underline',
      bar: 'Bar'
    },
    scrollback: 'Scrollback Lines',
    scrollbackHint: 'Number of lines to keep in terminal history'
  },

  // Theme Settings
  themeSettings: {
    title: 'Theme Settings',
    selectTheme: 'Select Theme',
    preview: 'Preview'
  },

  // Data Settings
  dataSettings: {
    title: 'Data Management',
    exportData: 'Export Data',
    exportDataDesc: 'Export all configuration and session data',
    importData: 'Import Data',
    importDataDesc: 'Import data from backup file',
    clearData: 'Clear Data',
    clearDataDesc: 'Clear all local data (config, sessions, history, etc.)',
    clearDataConfirm: 'Are you sure you want to clear all data? This action cannot be undone!',
    exportSuccess: 'Data exported successfully',
    importSuccess: 'Data imported successfully',
    clearSuccess: 'Data cleared successfully'
  },

  // Language Settings
  languageSettings: {
    title: 'Language Settings',
    selectLanguage: 'Select Language',
    languages: {
      'zh-CN': '简体中文',
      'en-US': 'English'
    },
    restartHint: 'Some changes may require restarting the app to take effect'
  },

  // AI Panel
  ai: {
    assistant: 'AI Assistant',
    clearChat: 'Clear Chat',
    closePanel: 'Close Panel',
    noConfig: 'No AI model configured',
    goToSettings: 'Go to Settings',
    switchModel: 'Switch AI Model',
    modeAgent: 'Agent',
    modeChat: 'Chat',
    agentModeTitle: 'Agent Mode: AI autonomously executes commands to complete tasks',
    chatModeTitle: 'Chat Mode: Have conversations with AI',
    timeout: 'Timeout',
    strict: 'Strict',
    relaxed: 'Relaxed',
    strictModeTitle: 'Strict Mode: Every command requires confirmation',
    relaxedModeTitle: 'Relaxed Mode: Only dangerous commands require confirmation',
    inputPlaceholder: 'Enter your question or describe the command you want...',
    inputPlaceholderAgent: 'Describe the task you want Agent to complete...',
    inputPlaceholderSupplement: 'Enter supplementary information (will take effect in next step)...',
    sendMessage: 'Send Message (Enter)',
    executeTask: 'Execute Task (Enter)',
    sendSupplement: 'Send Supplement (Enter)',
    stopGeneration: 'Stop Generation',
    stopAgent: 'Stop Agent',
    uploadDocument: 'Upload Document (PDF/Word/Text)',
    dropToUpload: 'Drop to upload document',
    dropHint: 'Supports PDF, Word, Text formats',
    uploadedDocs: 'Uploaded Documents',
    clearDocs: 'Clear All Documents',
    removeDoc: 'Remove',
    context: 'Context',
    contextUsed: 'used',
    newMessage: 'New Message',
    errorDetected: 'Error Detected',
    aiDiagnose: 'AI Diagnose',
    closeError: 'Close Error',
    selectedContent: 'Terminal Content Selected',
    aiAnalyze: 'AI Analyze',
    thinking: 'AI is thinking...',
    agentStarting: 'Agent starting...',
    agentRunning: 'Agent Running',
    agentHistory: 'Agent Execution History',
    steps: 'steps',
    taskComplete: 'Task Complete',
    taskFailed: 'Task Failed',
    needConfirm: 'Confirmation Required',
    highRisk: 'High Risk',
    mediumRisk: 'Medium Risk',
    reject: 'Reject',
    allowExecute: 'Allow Execute',
    supplementInfo: 'Supplement Info',
    pendingProcess: 'Pending',
    welcome: {
      greeting: 'Hello! I\'m your AI assistant for SFTerminal.',
      directChat: 'Direct Chat',
      directChatDesc: 'Enter any question in the input box below, and I\'ll do my best to help.',
      quickFeatures: 'Quick Features',
      explainCommand: 'Explain Command',
      explainCommandDesc: 'Select terminal content and click to explain, or click to see examples',
      errorDiagnose: 'Error Diagnosis',
      errorDiagnoseDesc: 'Auto-prompt when terminal errors occur, click "AI Diagnose"',
      generateCommand: 'Generate Command',
      generateCommandDesc: 'Describe your needs in natural language, like "find files larger than 100M"',
      analyzeOutput: 'Analyze Output',
      analyzeOutputDesc: 'After selecting terminal content, "AI Analyze" button appears automatically',
      usageTips: 'Usage Tips',
      tip1: 'Right-click menu in terminal allows "Send to AI Analysis"',
      tip2: 'Code blocks in AI replies can be sent to terminal with one click',
      tip3: 'Each terminal tab has its own conversation history',
      tip4: 'I generate commands appropriate for your system environment'
    },
    agentWelcome: {
      enabled: 'Agent Mode Enabled',
      hostInfo: 'Host Information',
      refreshHost: 'Refresh Host Info',
      probing: 'Probing...',
      hostname: 'Host',
      system: 'System',
      shell: 'Shell',
      tools: 'Tools',
      knownInfo: 'Known Info',
      notProbed: 'Not probed yet, click refresh to probe host information',
      whatIsAgent: 'What is Agent Mode?',
      agentDesc: 'Agent can autonomously execute commands to complete your tasks, and you can see the complete execution process.',
      examples: 'Examples',
      example1: '"Check server disk space, clean logs if over 80%"',
      example2: '"Check nginx service status, start it if not running"',
      example3: '"Find the process using the most memory and show details"',
      example4: '"Create a backup folder and backup all config files"',
      strictMode: 'Strict Mode',
      relaxedMode: 'Relaxed Mode',
      strictModeOn: 'On',
      strictModeDesc1: 'Every command requires your confirmation before execution',
      strictModeDesc2: 'Suitable for sensitive environments, full control over every step',
      relaxedModeDesc1: 'Safe commands auto-execute, only dangerous commands require confirmation',
      relaxedModeDesc2: 'Suitable for daily use, efficient while maintaining security',
      allCommandsVisible: 'All commands execute in terminal, you can see complete input and output',
      cautions: 'Cautions',
      caution1: 'Dangerous commands (like delete, modify system files) always require confirmation',
      caution2: 'You can click "Stop" at any time to abort Agent execution',
      caution3: 'Not suitable for long-running commands (like large compilations, data migrations)',
      caution4: 'Not suitable for loop/interactive commands (like watch, top, tail -f, vim)'
    },
    quickActions: {
      explainCommand: 'Explain Command',
      generateCommand: 'Generate Command',
      analyzeError: 'Analyze Error',
      systemStatus: 'System Status'
    },
    toolNames: {
      execute_command: 'Execute Command',
      read_file: 'Read File',
      write_file: 'Write File',
      get_terminal_context: 'Get Terminal Context'
    }
  },

  // Session Manager
  session: {
    title: 'Session Manager',
    newSession: 'New Session',
    newHost: 'New Host',
    newGroup: 'New Group',
    editSession: 'Edit Session',
    editGroup: 'Edit Group',
    deleteSession: 'Delete Session',
    deleteGroup: 'Delete Group',
    confirmDeleteSession: 'Are you sure you want to delete this session?',
    confirmDeleteGroup: 'Are you sure you want to delete this group? Sessions in the group will not be deleted.',
    searchPlaceholder: 'Search hosts...',
    noSessions: 'No sessions',
    noSessionsHint: 'Click the button above to add a new session',
    ungrouped: 'Ungrouped',
    localTerminal: 'Local Terminal',
    connect: 'Connect',
    openSftp: 'Open SFTP',
    duplicate: 'Duplicate',
    import: 'Import',
    importXshell: 'Import from Xshell',
    importManual: 'Select Directory',
    form: {
      sessionName: 'Session Name',
      sessionNamePlaceholder: 'e.g., Production Server',
      host: 'Host',
      hostPlaceholder: 'e.g., 192.168.1.100',
      port: 'Port',
      username: 'Username',
      usernamePlaceholder: 'e.g., root',
      authType: 'Authentication',
      authPassword: 'Password',
      authKey: 'Private Key',
      password: 'Password',
      passwordPlaceholder: 'Enter password',
      privateKey: 'Private Key Path',
      privateKeyPlaceholder: 'Select private key file',
      selectFile: 'Select File',
      passphrase: 'Key Passphrase',
      passphrasePlaceholder: 'If private key is password protected',
      group: 'Group',
      noGroup: 'No Group',
      jumpHost: 'Jump Host',
      jumpHostEnable: 'Enable Jump Host',
      jumpHostInherit: 'Inherit from Group',
      jumpHostCustom: 'Custom',
      jumpHostDisable: 'Disable Jump Host'
    }
  },

  // Tab Bar
  tabs: {
    newTab: 'New Terminal',
    closeTab: 'Close Tab',
    closeOtherTabs: 'Close Other Tabs',
    closeTabsToRight: 'Close Tabs to Right',
    localTerminal: 'Local Terminal',
    sshTerminal: 'SSH Terminal',
    connecting: 'Connecting...',
    scrollLeft: 'Scroll Left',
    scrollRight: 'Scroll Right',
    selectShell: 'Select Shell'
  },

  // File Explorer
  fileExplorer: {
    title: 'SFTP File Manager',
    close: 'Close',
    refresh: 'Refresh',
    upload: 'Upload',
    download: 'Download',
    newFolder: 'New Folder',
    newFile: 'New File',
    rename: 'Rename',
    delete: 'Delete',
    copy: 'Copy',
    cut: 'Cut',
    paste: 'Paste',
    selectAll: 'Select All',
    confirmDelete: 'Are you sure you want to delete the selected files/folders?',
    transferQueue: 'Transfer Queue',
    noTransfers: 'No transfer tasks',
    fileName: 'Name',
    fileSize: 'Size',
    modifyTime: 'Modified',
    permissions: 'Permissions',
    pathBreadcrumb: 'Path',
    goToParent: 'Go to Parent',
    emptyFolder: 'Empty folder'
  },

  // Setup Wizard
  setup: {
    welcome: {
      title: 'Welcome to SFTerminal',
      subtitle: 'AI-powered smart terminal for efficient operations',
      intro: 'SFTerminal is a smart terminal tool designed for operations engineers, integrating powerful AI capabilities to make your work more efficient. This wizard will help you complete the initial setup and get started quickly.',
      features: {
        aiChat: {
          title: 'AI Chat Assistant',
          desc: 'Chat with AI directly in the terminal, ask about command usage, troubleshoot issues, get help. Supports multiple LLMs including OpenAI, Qwen, DeepSeek, and local Ollama deployments.'
        },
        agent: {
          title: 'Agent Auto-Execution',
          desc: 'AI Agent can understand your natural language instructions and automatically execute complex operations tasks. Supports command execution, file operations, system monitoring, making AI your capable assistant.'
        },
        ssh: {
          title: 'SSH Session Management',
          desc: 'Unified management of multiple servers, supports grouping, jump hosts, quick connections. One-click import of Xshell session configurations for quick migration.'
        },
        knowledge: {
          title: 'Local Knowledge Base',
          desc: 'Upload documents to local knowledge base, AI automatically retrieves relevant content during conversations for more accurate answers. Supports PDF, Word, text formats, using lightweight vector model with no additional download required.'
        }
      },
      skipWizard: 'Skip Wizard'
    },
    aiConfig: {
      title: 'Configure AI Model',
      subtitle: 'Configure large language model to make terminal smarter',
      intro: 'AI model is the core of AI features. You need to configure at least one model to use AI chat and Agent features.',
      hint: 'Supports OpenAI-compatible APIs, including vLLM, FastChat, Ollama and other private deployment solutions.',
      configuredModels: 'Configured Models',
      addNewModel: 'Add New Model',
      quickTemplates: 'Quick Templates:'
    },
    import: {
      title: 'Import SSH Hosts',
      subtitle: 'Quickly import existing SSH host configurations',
      intro: 'If you previously used Xshell, you can import all session configurations with one click to quickly migrate to SFTerminal.',
      scanning: 'Scanning Xshell session directory...',
      found: 'Found {count} sessions',
      import: 'Import',
      importing: 'Importing...',
      imported: 'Imported',
      importSuccess: 'Successfully imported {count} hosts',
      importFailed: 'Import failed',
      manualSelect: 'Select Directory',
      notFound: 'Xshell session directory not found',
      notFoundHint: 'You can manually select a directory to import, or add hosts later in settings'
    },
    knowledge: {
      title: 'Enable Local Knowledge Base',
      subtitle: 'Enable local knowledge base for AI to better understand your documents',
      features: {
        title: 'Knowledge Base Features',
        item1: 'Upload documents to local knowledge base, supports PDF, Word, text and more',
        item2: 'AI automatically retrieves relevant content during conversations for more accurate answers',
        item3: 'Uses lightweight vector model (all-MiniLM-L6-v2), bundled with app, no additional download',
        item4: 'Supports semantic search and reranking for improved retrieval accuracy'
      },
      enableSwitch: 'Enable Knowledge Base',
      enableHint: 'When enabled, uploaded documents in conversations can be saved for Agent use'
    },
    mcp: {
      title: 'Configure MCP Services',
      subtitle: 'Connect MCP servers to extend AI capabilities',
      intro: 'MCP (Model Context Protocol) is a protocol that allows AI to access external tools and resources.',
      hint: 'You can add MCP servers in settings later, feel free to skip this step.',
      configuredServers: 'Configured MCP Servers',
      noServers: 'No MCP servers configured',
      noServersHint: 'You can add MCP servers in settings to extend AI capabilities'
    },
    complete: {
      title: 'All Set!',
      subtitle: 'Start using SFTerminal',
      summary: {
        aiConfigured: 'AI model configured',
        aiNotConfigured: 'AI model not configured',
        hostsImported: 'Imported {count} hosts',
        knowledgeEnabled: 'Knowledge base enabled',
        knowledgeNotEnabled: 'Knowledge base not enabled',
        mcpConfigured: 'MCP services configured',
        mcpNotConfigured: 'MCP services not configured'
      },
      tip: 'You can modify these settings anytime in Settings'
    }
  },

  // Terminal
  terminal: {
    contextMenu: {
      copy: 'Copy',
      paste: 'Paste',
      selectAll: 'Select All',
      clear: 'Clear',
      sendToAi: 'Send to AI Analysis',
      search: 'Search'
    },
    welcome: {
      title: 'Welcome to SFTerminal',
      hint: 'Click + to create a new terminal session'
    },
    newLocalTerminal: 'New Local Terminal',
    connecting: 'Connecting...',
    connectionFailed: 'Connection failed',
    connectionClosed: 'Connection closed',
    reconnect: 'Reconnect',
    localTerminal: 'Local Terminal'
  },

  // MCP Status
  mcp: {
    status: 'MCP Status',
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting',
    error: 'Error',
    servers: 'Servers',
    noServers: 'No servers configured',
    openSettings: 'Open Settings'
  }
}
