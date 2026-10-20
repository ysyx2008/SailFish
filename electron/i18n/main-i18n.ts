/**
 * 主进程用户可见文案国际化（对话框、IPC 错误、通知标题等）
 */
import type { ConfigService } from '../services/config.service'

const translations = {
  'zh-CN': {
    // 窗口标题
    'window.fileManager': '文件管理器',
    'window.aiDebug': 'AI 调试控制台',
    'window.llmBench': '压测控制台',
    'window.reviewBadge': '验收',

    // 文件对话框
    'dialog.selectXshellFile': '选择 Xshell 会话文件',
    'dialog.selectXshellDir': '选择 Xshell 会话目录',
    'dialog.selectExportDir': '选择导出目录',
    'dialog.exportHere': '导出到此目录',
    'dialog.selectBackupFolder': '选择备份文件夹',
    'dialog.importHere': '导入此目录',
    'dialog.saveBackupArchive': '保存完整备份',
    'dialog.saveBackup': '保存备份',
    'dialog.selectBackupArchive': '选择备份压缩包',
    'dialog.selectBackupFile': '选择此备份',
    'dialog.restoreFromBackup': '从此备份恢复',
    'dialog.restoreConfirmTitle': '确认完整恢复',
    'dialog.restoreConfirmMessage': '将从「{name}」完整恢复数据。',
    'dialog.restoreConfirmDetail': '备份版本：{appVersion}\n创建时间：{createdAt}\n\n当前全部数据将被替换，应用随后重启。此操作不可撤销。',
    'dialog.restoreConfirmOk': '恢复并重启',
    'dialog.restoreConfirmCancel': '取消',
    'dialog.backupArchiveFilter': '旗鱼备份 (.zip)',
    'dialog.backupOverwriteTitle': '文件已存在',
    'dialog.backupOverwriteMessage': '「{name}」已存在，是否覆盖？',
    'dialog.backupOverwrite': '覆盖',
    'dialog.backupOverwriteCancel': '取消',
    'dialog.selectFile': '选择文件',
    'dialog.selectUploadFiles': '选择要上传的文件',
    'dialog.selectDir': '选择目录',
    'dialog.saveFile': '保存文件',
    'dialog.selectKnowledgeBackupDir': '选择知识库备份目录',
    'dialog.selectKnowledgeSaveDir': '选择保存位置',
    'dialog.selectKnowledgeSnapshotDir': '选择备份文件夹',
    'error.notKnowledgeSnapshot': '这不是一份完整备份。以前单独导出的文件夹不能从这里恢复。',
    'dialog.configRestoredTitle': '配置已从备份恢复',
    'dialog.configRestoredMessage':
      '检测到应用配置损坏，已用最近一份可用备份恢复。请到设置中核对 AI、SSH、即时通讯等各项是否齐全。',
    'dialog.configResetTitle': '配置无法自动恢复',
    'dialog.configResetMessage':
      '应用配置已损坏且没有可用备份。损坏文件已另行备份，应用将使用空配置启动。请重新配置 AI、SSH、即时通讯等必要项。',
    'dialog.configRecoveryOk': '知道了',
    'filter.allFiles': '所有文件',
    'filter.xshellFiles': 'Xshell 会话文件',

    // 系统通知
    'notification.confirmRequired': '{appName} 需要确认',
    'notification.apiKeyRequired': '{appName} 需要 API Key',
    'notification.skillEnvBody': '请为技能配置 {envName}',

    // 通用 IPC 错误
    'error.windowNotReady': '窗口未就绪',
    'error.unknown': '未知错误',
    'error.checkUpdateFailed': '检查更新失败',
    'error.devModeNoDownload': '开发模式不支持下载更新',
    'error.downloadUpdateFailed': '下载更新失败',
    'error.installUpdateFailed': '安装更新失败',
    'error.noDownloadedUpdate': '尚未下载更新',
    'error.invalidSource': '无效的更新源',
    'error.exportFailed': '导出失败',
    'error.importFailed': '导入失败',
    'error.listDirFailed': '列出目录失败',
    'error.getFileInfoFailed': '获取文件信息失败',
    'error.checkPathFailed': '检查路径失败',
    'error.createDirFailed': '创建目录失败',
    'error.deleteFileFailed': '删除文件失败',
    'error.deleteDirFailed': '删除目录失败',
    'error.renameFailed': '重命名失败',
    'error.copyFileFailed': '复制文件失败',
    'error.copyDirFailed': '复制目录失败',
    'error.readFileFailed': '读取文件失败',
    'error.writeFileFailed': '写入文件失败',
    'error.connectFailed': '连接失败',
    'error.getCwdFailed': '获取工作目录失败',
    'error.uploadFailed': '上传失败',
    'error.downloadFailed': '下载失败',
    'error.uploadDirFailed': '上传目录失败',
    'error.downloadDirFailed': '下载目录失败',
    'error.chmodFailed': '修改权限失败',
    'error.cancelFailed': '取消失败',
    'error.refreshFailed': '刷新失败',
    'error.initFailed': '初始化失败',
    'error.updateSettingsFailed': '更新设置失败',
    'error.addDocFailed': '添加文档失败',
    'error.deleteDocFailed': '删除文档失败',
    'error.batchDeleteDocFailed': '批量删除文档失败',
    'error.docsDeletePartialFailed': '{count} 个文档删除失败',
    'error.searchFailed': '搜索失败',
    'error.getKnowledgeFailed': '获取知识失败',
    'error.buildContextFailed': '构建上下文失败',
    'error.getStatsFailed': '获取统计失败',
    'error.clearFailed': '清空失败',
    'error.switchModelFailed': '切换模型失败',
    'error.getListFailed': '获取列表失败',
    'error.getDocFailed': '获取文档失败',
    'error.saveDocFailed': '保存文档失败',
    'error.transcribeFailed': '转录失败',
    'error.invalidAccount': '无效的账户信息',
    'error.credentialsNotFound': '未找到保存的凭据，请重新编辑账户并输入密码',

    // 成功消息
    'msg.connectSuccess': '连接成功',
    'msg.connectOk': '连接正常',
    'msg.emailImapOk': '收信（IMAP）连接正常',
    'msg.emailSmtpOk': '发信（SMTP）连接正常',
    'msg.emailBothOk': '收发信连接均正常',
    'error.emailImapFailed': '收信（IMAP）连接失败',
    'error.emailSmtpFailed': '发信（SMTP）连接失败',
    'msg.calendarsConnectSuccess': '连接成功，找到 {count} 个日历',
    'msg.calendarsConnectOk': '连接正常，找到 {count} 个日历',

    // 崩溃提示
    'crash.previousTitle': '上次未能正常退出',
    'crash.previousMessage': '上次运行意外中断了',
    'crash.previousDetail': '已在本机保留崩溃现场。复制摘要发给我们，就能帮我们定位问题（不含主机名、账号名与对话内容）。',
    'crash.previousDetailRepeated': '最近连续 {count} 次未能正常退出，已在本机保留崩溃现场。复制摘要发给我们，就能帮我们定位问题（不含主机名、账号名与对话内容）。',
    'crash.rendererTitle': '界面已崩溃',
    'crash.rendererMessage': '界面进程崩溃了，需要重新载入',
    'crash.rendererDetail': '重载界面即可继续使用，正在进行的任务不受影响。顺手复制一份摘要发给我们，能帮我们定位问题。',
    'crash.copySummary': '复制诊断摘要',
    'crash.reloadWindow': '重载界面',
    'crash.dismiss': '知道了',
    'crash.stopNotifying': '不再提示崩溃',
    'crash.copiedTitle': '已复制',
    'crash.copiedMessage': '诊断摘要已复制到剪贴板，直接粘贴发给我们即可',
  },
  'en-US': {
    'window.fileManager': 'File Manager',
    'window.aiDebug': 'AI Debug Console',
    'window.llmBench': 'Benchmark Console',
    'window.reviewBadge': 'Review',

    'dialog.selectXshellFile': 'Select Xshell Session File',
    'dialog.selectXshellDir': 'Select Xshell Sessions Folder',
    'dialog.selectExportDir': 'Select Export Directory',
    'dialog.exportHere': 'Export Here',
    'dialog.selectBackupFolder': 'Select Backup Folder',
    'dialog.importHere': 'Import from This Directory',
    'dialog.saveBackupArchive': 'Save Full Backup',
    'dialog.saveBackup': 'Save Backup',
    'dialog.selectBackupArchive': 'Select Backup Archive',
    'dialog.selectBackupFile': 'Select This Backup',
    'dialog.restoreFromBackup': 'Restore from This Backup',
    'dialog.restoreConfirmTitle': 'Confirm Full Restore',
    'dialog.restoreConfirmMessage': 'Restore all data from “{name}”?',
    'dialog.restoreConfirmDetail': 'Backup version: {appVersion}\nCreated: {createdAt}\n\nAll current data will be replaced and the app will restart. This cannot be undone.',
    'dialog.restoreConfirmOk': 'Restore & Restart',
    'dialog.restoreConfirmCancel': 'Cancel',
    'dialog.backupArchiveFilter': 'SailFish Backup (.zip)',
    'dialog.backupOverwriteTitle': 'File Already Exists',
    'dialog.backupOverwriteMessage': '“{name}” already exists. Replace it?',
    'dialog.backupOverwrite': 'Replace',
    'dialog.backupOverwriteCancel': 'Cancel',
    'dialog.selectFile': 'Select File',
    'dialog.selectUploadFiles': 'Select Files to Upload',
    'dialog.selectDir': 'Select Directory',
    'dialog.saveFile': 'Save File',
    'dialog.selectKnowledgeBackupDir': 'Select Knowledge Base Backup Directory',
    'dialog.selectKnowledgeSaveDir': 'Choose where to save',
    'dialog.selectKnowledgeSnapshotDir': 'Select backup folder',
    'error.notKnowledgeSnapshot': 'This is not a complete backup. Folders from the old export cannot be restored here.',
    'dialog.configRestoredTitle': 'Settings Restored from Backup',
    'dialog.configRestoredMessage':
      'App settings were damaged and have been restored from the latest usable backup. Please check Settings for AI, SSH, messaging, and other items.',
    'dialog.configResetTitle': 'Settings Could Not Be Restored',
    'dialog.configResetMessage':
      'App settings were damaged and no usable backup was found. The damaged file was backed up separately, and the app started with empty defaults. Please reconfigure AI, SSH, messaging, and other required items.',
    'dialog.configRecoveryOk': 'Got it',
    'filter.allFiles': 'All Files',
    'filter.xshellFiles': 'Xshell Session Files',

    'notification.confirmRequired': '{appName} Confirmation Required',
    'notification.apiKeyRequired': '{appName} API Key Required',
    'notification.skillEnvBody': 'Please configure {envName} for this skill',

    'error.windowNotReady': 'Window is not ready',
    'error.unknown': 'Unknown error',
    'error.checkUpdateFailed': 'Failed to check for updates',
    'error.devModeNoDownload': 'Downloading updates is not supported in development mode',
    'error.downloadUpdateFailed': 'Failed to download update',
    'error.installUpdateFailed': 'Failed to install update',
    'error.noDownloadedUpdate': 'No update has been downloaded',
    'error.invalidSource': 'Invalid update source',
    'error.exportFailed': 'Export failed',
    'error.importFailed': 'Import failed',
    'error.listDirFailed': 'Failed to list directory',
    'error.getFileInfoFailed': 'Failed to get file info',
    'error.checkPathFailed': 'Failed to check path',
    'error.createDirFailed': 'Failed to create directory',
    'error.deleteFileFailed': 'Failed to delete file',
    'error.deleteDirFailed': 'Failed to delete directory',
    'error.renameFailed': 'Failed to rename',
    'error.copyFileFailed': 'Failed to copy file',
    'error.copyDirFailed': 'Failed to copy directory',
    'error.readFileFailed': 'Failed to read file',
    'error.writeFileFailed': 'Failed to write file',
    'error.connectFailed': 'Connection failed',
    'error.getCwdFailed': 'Failed to get working directory',
    'error.uploadFailed': 'Upload failed',
    'error.downloadFailed': 'Download failed',
    'error.uploadDirFailed': 'Failed to upload directory',
    'error.downloadDirFailed': 'Failed to download directory',
    'error.chmodFailed': 'Failed to change permissions',
    'error.cancelFailed': 'Failed to cancel',
    'error.refreshFailed': 'Failed to refresh',
    'error.initFailed': 'Initialization failed',
    'error.updateSettingsFailed': 'Failed to update settings',
    'error.addDocFailed': 'Failed to add document',
    'error.deleteDocFailed': 'Failed to delete document',
    'error.batchDeleteDocFailed': 'Failed to delete documents in batch',
    'error.docsDeletePartialFailed': '{count} document(s) failed to delete',
    'error.searchFailed': 'Search failed',
    'error.getKnowledgeFailed': 'Failed to get knowledge',
    'error.buildContextFailed': 'Failed to build context',
    'error.getStatsFailed': 'Failed to get statistics',
    'error.clearFailed': 'Failed to clear',
    'error.switchModelFailed': 'Failed to switch model',
    'error.getListFailed': 'Failed to get list',
    'error.getDocFailed': 'Failed to get document',
    'error.saveDocFailed': 'Failed to save document',
    'error.transcribeFailed': 'Transcription failed',
    'error.invalidAccount': 'Invalid account information',
    'error.credentialsNotFound': 'Saved credentials not found. Please edit the account and enter the password again',

    'msg.connectSuccess': 'Connected successfully',
    'msg.connectOk': 'Connection is OK',
    'msg.emailImapOk': 'Incoming mail (IMAP) connection is OK',
    'msg.emailSmtpOk': 'Outgoing mail (SMTP) connection is OK',
    'msg.emailBothOk': 'Incoming and outgoing mail connections are OK',
    'error.emailImapFailed': 'Incoming mail (IMAP) connection failed',
    'error.emailSmtpFailed': 'Outgoing mail (SMTP) connection failed',
    'msg.calendarsConnectSuccess': 'Connected successfully, found {count} calendar(s)',
    'msg.calendarsConnectOk': 'Connection is OK, found {count} calendar(s)',

    'crash.previousTitle': 'Last Session Ended Unexpectedly',
    'crash.previousMessage': 'The previous session was interrupted',
    'crash.previousDetail': 'The crash details are kept on this machine. Copying the summary and sending it to us helps us pin down the cause (no hostname, account name or conversations included).',
    'crash.previousDetailRepeated': 'The last {count} sessions ended unexpectedly and the crash details are kept on this machine. Copying the summary and sending it to us helps us pin down the cause (no hostname, account name or conversations included).',
    'crash.rendererTitle': 'Interface Crashed',
    'crash.rendererMessage': 'The interface process crashed and needs reloading',
    'crash.rendererDetail': 'Reloading brings the interface back; running tasks are unaffected. Copying a summary for us helps pin down the cause.',
    'crash.copySummary': 'Copy Diagnostic Summary',
    'crash.reloadWindow': 'Reload Interface',
    'crash.dismiss': 'Dismiss',
    'crash.stopNotifying': 'Stop notifying me about crashes',
    'crash.copiedTitle': 'Copied',
    'crash.copiedMessage': 'The diagnostic summary is on your clipboard — just paste it to us',
  },
} as const

export type MainI18nKey = keyof typeof translations['zh-CN']

let cachedLocale: 'zh-CN' | 'en-US' | null = null
let configService: ConfigService | null = null

export function setConfigService(service: ConfigService): void {
  configService = service
}

export function updateLocale(locale: 'zh-CN' | 'en-US'): void {
  cachedLocale = locale
}

export function getLocale(): 'zh-CN' | 'en-US' {
  if (configService) {
    const locale = configService.getLanguage()
    return locale === 'en-US' ? 'en-US' : 'zh-CN'
  }
  return cachedLocale || 'zh-CN'
}

export function t(key: MainI18nKey, params?: Record<string, string | number>): string {
  const locale = getLocale()
  let text: string = translations[locale][key] || translations['zh-CN'][key] || key

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v))
    }
  }

  return text
}

/** IPC 错误兜底：优先返回 Error.message，否则返回 i18n 文案 */
export function errMsg(error: unknown, key: MainI18nKey): string {
  return error instanceof Error ? error.message : t(key)
}
