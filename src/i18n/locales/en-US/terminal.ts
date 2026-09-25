// Terminal & sessions: session manager, tabs, panes, MCP status, batch commands (artifacts → canvas.ts)
export default {

  // Session Manager
  session: {
    title: 'Session Manager',
    newSession: 'New Session',
    newHost: 'New Host',
    newGroup: 'New Group',
    editSession: 'Edit Session',
    editHost: 'Edit Host',
    editGroup: 'Edit Group',
    configGroup: 'Configure Group',
    deleteSession: 'Delete Session',
    deleteGroup: 'Delete Group',
    confirmDeleteSession: 'Are you sure you want to delete this session?',
    confirmDeleteHost: 'Are you sure you want to delete host "{name}"?',
    confirmDeleteGroup: 'Are you sure you want to delete this group? Sessions in the group will not be deleted.',
    confirmDeleteGroupNamed: 'Are you sure you want to delete group "{name}"? Hosts in the group will be moved to "Default" group.',
    searchPlaceholder: 'Search hosts...',
    noSessions: 'No sessions',
    noSessionsHint: 'Click the button above to add a new session',
    noHostsSaved: 'No hosts saved',
    noHostsHint: 'Click "New" to add a host',
    noMatchingHosts: 'No matching hosts found',
    tryOtherKeywords: 'Try other keywords',
    ungrouped: 'Ungrouped',
    defaultGroup: 'Default',
    localTerminal: 'Local Terminal',
    connect: 'Connect',
    splitNeedSession: 'Open a session first to split',
    openSftp: 'Open SFTP',
    fileManager: 'File Manager',
    duplicate: 'Duplicate',
    import: 'Import',
    importXshell: 'Import from Xshell',
    importXshellFiles: 'Import Xshell Files...',
    importXshellDir: 'Import Xshell Directory...',
    importManual: 'Select Directory',
    importFailed: 'Import failed',
    sort: {
      title: 'Sort',
      custom: 'Custom Order',
      nameAsc: 'Name A-Z',
      nameDesc: 'Name Z-A',
      lastUsed: 'Recently Used'
    },
    dropHere: 'Drop here',
    importSuccess: 'Successfully imported {count} sessions',
    importPartialFailed: 'The following files failed to import:',
    pleaseInputGroupName: 'Please enter group name',
    pleaseInputJumpHostInfo: 'Please enter jump host address and username',
    credentialDialog: {
      title: 'Enter Server Credentials',
      username: 'Username',
      usernamePlaceholder: 'SSH login username',
      password: 'Password',
      passwordPlaceholder: 'Leave empty for key-based auth',
      saveCredentials: 'Save credentials',
      connect: 'Connect',
    },
    form: {
      sessionName: 'Session Name',
      sessionNamePlaceholder: 'e.g., Production Server',
      name: 'Name',
      host: 'Host',
      hostPlaceholder: 'IP or domain',
      port: 'Port',
      username: 'Username',
      usernamePlaceholder: 'root',
      authType: 'Authentication',
      authPassword: 'Password',
      authKey: 'Private Key',
      password: 'Password',
      passwordPlaceholder: 'Enter password',
      privateKey: 'Private Key Path',
      privateKeyPath: 'Private Key Path',
      privateKeyPlaceholder: 'Select private key file',
      privateKeyPathPlaceholder: '~/.ssh/id_rsa',
      selectFile: 'Select File',
      passphrase: 'Key Passphrase',
      passphrasePlaceholder: 'If private key is password protected',
      passphraseOptional: 'Passphrase (optional)',
      group: 'Group',
      groupName: 'Group Name',
      groupNamePlaceholder: 'e.g., Production',
      noGroup: 'No Group',
      jumpHost: 'Jump Host',
      jumpHostHost: 'Jump Host',
      jumpHostEnable: 'Enable Jump Host',
      jumpHostHint: 'All hosts in this group will connect via this jump host',
      jumpHostInherit: 'Inherit from Group',
      jumpHostCustom: 'Custom',
      jumpHostDisable: 'Disable Jump Host',
      jumpHostInheritInfo: 'Will use jump host {host} from group "{group}"',
      jumpHostNoInherit: 'No jump host configured in current group, will connect directly',
      jumpHostCustomHint: 'Compatible with JumpServer and other bastion hosts (port usually 2222)',
      jumpHostIsJumpServer: 'This is JumpServer',
      jumpHostIsJumpServerHint: 'When checked, a jump host that disallows port forwarding opens the bastion menu instead',
      encoding: 'Character Encoding',
      encodingHint: 'Character encoding used by remote server, default UTF-8',
      encodings: {
        'utf-8': 'UTF-8 (Default, all languages)',
        'gbk': 'GBK (Simplified Chinese Windows)',
        'gb2312': 'GB2312 (Simplified Chinese)',
        'gb18030': 'GB18030 (Simplified Chinese Full)',
        'big5': 'Big5 (Traditional Chinese)',
        'shift_jis': 'Shift-JIS (Japanese)',
        'euc-jp': 'EUC-JP (Japanese Unix)',
        'euc-kr': 'EUC-KR (Korean)',
        'iso-8859-1': 'ISO-8859-1 (Western European)',
        'iso-8859-15': 'ISO-8859-15 (Western European w/€)',
        'windows-1252': 'Windows-1252 (Western)',
        'koi8-r': 'KOI8-R (Russian)',
        'windows-1251': 'Windows-1251 (Russian)'
      }
    },
    validation: {
      nameRequired: 'Please enter session name',
      hostRequired: 'Please enter host address',
      usernameRequired: 'Please enter username',
      saveFailed: 'Save failed, please try again'
    }
  },


  // Tab Bar
  tabs: {
    home: 'Home',
    tasks: 'Tasks',
    reach: 'Reach',
    todos: 'Todos',
    todosOverdue: '{n} overdue todos',
    newTab: 'New Terminal',
    newTabDragHint: 'Click for a new tab; drag onto a pane edge to split',
    closeTab: 'Close Tab',
    closeOtherTabs: 'Close Other Tabs',
    closeTabsToRight: 'Close Tabs to Right',
    localTerminal: 'Local Terminal',
    sshTerminal: 'SSH Terminal',
    assistant: 'AI Assistant',
    connecting: 'Connecting...',
    scrollLeft: 'Scroll Left',
    scrollRight: 'Scroll Right',
    selectShell: 'Select Shell',
    sshConnect: 'SSH Connect...',
    confirmCloseAgentRunning: 'AI Agent is running a task. Closing the terminal will interrupt it. Are you sure?',
    confirmCloseWithChat: 'This terminal has AI chat history that will be lost. Are you sure you want to close?',
    needsAttentionConfirm: 'Needs your confirmation',
    needsAttentionTaskFinished: 'Agent finished a task',
    tasksNeedsAttention: 'Tasks need your attention',
    doubleClickToRename: 'Double-click to rename tab'
  },


  // Terminal
  terminal: {
    contextMenu: {
      copy: 'Copy',
      copyFailed: 'Copy failed, try Ctrl/Cmd+C instead',
      paste: 'Paste',
      selectAll: 'Select All',
      clear: 'Clear',
      sendToAi: 'Send to AI Analysis',
      search: 'Search',
      openFileManager: 'Open File Manager'
    },
    welcome: {
      title: 'Welcome to SailFish',
      hint: 'Click + to create a new terminal session'
    },
    newLocalTerminal: 'New Local Terminal',
    loadingEnv: 'Loading environment variables...',
    connecting: 'Connecting...',
    cancelConnect: 'Cancel connection',
    connectionFailed: 'Connection failed',
    connectionClosed: 'Connection closed',
    reconnect: 'Reconnect',
    reconnecting: 'Reconnecting...',
    dropFiles: 'Drop files here',
    cannotReconnect: 'Cannot reconnect',
    cannotReconnectHint: 'This connection is not saved as a session, please reconnect from Session Manager',
    reconnectFailed: 'Reconnect failed',
    commandDone: 'Done',
    commandTimeout: 'Command timed out ({seconds}s)',
    localTerminal: 'Local Terminal',
    hosted: {
      close: 'Close terminal',
      newLocal: 'Open another local terminal',
      newSsh: 'Open another SSH session'
    },
    sshDisconnected: '[SSH Disconnected]',
    disconnectReasons: {
      closed: 'Connection closed',
      error: 'Connection error',
      stream_closed: 'Data stream closed',
      jump_host_closed: 'Jump host connection closed'
    },
    // SSH connection error types
    sshErrors: {
      auth_failed: 'Authentication failed: Incorrect username or password, please check your credentials',
      timeout: 'Connection timeout: Unable to connect to server, please check network or host address',
      connection_refused: 'Connection refused: Server refused the connection, please check if the port is correct or SSH service is running',
      host_not_found: 'Host not found: Unable to resolve host address, please check the hostname',
      host_unreachable: 'Host unreachable: Unable to connect to target host, please check network connection',
      network_error: 'Network error: Network connection exception, please check network settings',
      key_error: 'Key error: Invalid private key format or incorrect passphrase',
      unknown: 'Connection failed'
    },
    reconnectHint: 'Click the button at bottom right or press Ctrl+Shift+R to reconnect',
    noSessionSavedHint: 'This connection is not saved as a session, please reconnect from Session Manager',
    split: {
      position: {
        left: 'Left',
        right: 'Right',
        top: 'Top',
        bottom: 'Bottom',
        middle: 'Middle',
        col: 'Col {n}',
        row: 'Row {n}'
      },
      dragToRearrange: 'Drag onto another pane edge to rearrange',
      label: {
        main: 'Main',
        new: 'New'
      },
      menu: {
        horizontal: 'Split Horizontally',
        vertical: 'Split Vertically',
        close: 'Close Pane',
        connectTo: 'Split and connect to…'
      },
      button: {
        horizontal: 'Split Horizontally',
        verticalTitle: 'Split Vertically',
        horizontalTitle: 'Split Horizontally'
      },
      target: {
        title: 'Split and connect to',
        directionLabel: 'Direction',
        directionHorizontal: 'Horizontal',
        directionVertical: 'Vertical',
        targetLabel: 'Connect to',
        local: 'Local terminal',
        sshSection: 'SSH sessions',
        noSessions: 'No SSH sessions configured yet — add one via Session Manager',
        cancel: 'Cancel',
        confirm: 'Split'
      }
    }
  },


  // MCP Status
  mcp: {
    status: 'MCP Status',
    connected: 'Connected',
    disconnected: 'Disconnected',
    connecting: 'Connecting',
    error: 'Error',
    servers: 'Connectors',
    noServers: 'No connectors configured',
    openSettings: 'Open Settings',
    serverList: 'MCP Connectors',
    retry: 'Retry',
    retryAll: 'Retry all',
    healthOk: '{count} enabled',
    healthFailed: '{count} failed',
    healthNetworkDown: 'Network unavailable',
    healthConnecting: 'Connecting {connected}/{total}',
    errorNetwork: 'Network unavailable, check your connection and retry',
    errorTimeout: 'Connection timed out, check your network and retry',
    errorDns: 'Could not resolve the address, check your network or connector URL',
    errorRefused: 'Connection refused, check that the connector address is reachable',
    connectAll: 'Connect All',
    connect: 'Connect',
    disconnect: 'Disconnect',
    tools: 'tools',
    disabled: 'Disabled',
    noServersConfigured: 'No MCP connectors configured'
  },


  // Batch Operations
  batch: {
    title: 'Batch Command',
    scopeTab: 'This tab',
    scopeAll: 'All tabs',
    selectPanes: 'Select panes to operate',
    noActiveTerminals: 'No active terminal panes available',
    commandInput: 'Enter command',
    commandPlaceholder: 'Enter command to send to all selected panes...',
    send: 'Send',
    sendEnter: 'Press Enter after sending',
    selectedCount: '{count} pane(s) selected',
    shortcutHint: 'Shortcut: Ctrl+Shift+B to toggle batch panel, Enter to send. Defaults to this tab when split, all tabs otherwise'
  },
}
