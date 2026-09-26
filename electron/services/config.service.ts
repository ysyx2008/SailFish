import Store from 'electron-store'
import fs from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'
import type { AiModelType, AiProfile, ApiFormat, CommandRiskPolicy, ExecutionMode, IMProcessMode, JumpHostConfig, LocaleType, McpServerConfig, ProactiveCompactStyle, RiskLevel, SessionSortBy } from '@shared/types'
import type { KnowledgeSettings } from './knowledge/types'
import { DEFAULT_KNOWLEDGE_SETTINGS } from './knowledge/types'
import { DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS } from './knowledge/context-knowledge-budget'
import type { CueSoundSettings, TtsSettings, UiThemeMode, UiThemeName, WebSearchSettings } from '@shared/types'
import { COMMAND_RISK_POLICY_ALLOWED_LEVELS, DEFAULT_COMMAND_RISK_POLICY, DEFAULT_CUE_SOUND_SETTINGS, DEFAULT_PROACTIVE_COMPACT, DEFAULT_TTS_SETTINGS, DEFAULT_UI_THEME, DEFAULT_UI_THEME_MODE, DEFAULT_WEB_SEARCH_SETTINGS, normalizeProactiveCompact } from '@shared/types'
import { createLogger, type LogLevel } from '../utils/logger'
import { normalizeTerminalSettings, normalizeKeyboardShortcuts } from '../utils/normalize'
import {
  createConfigBackupIfNeeded,
  ensureStartupConfigBackup,
  peekConfigRecoveryNotice,
  dismissConfigRecoveryNotice,
  setConfigRecoveryNotice,
  tryRestoreConfigFromBackups,
  type ConfigRecoveryNotice,
} from './config-backup'

export type { AiModelType, AiProfile, ApiFormat, JumpHostConfig, McpServerConfig, ConfigRecoveryNotice }

const log = createLogger('Config')

// 会话分组
export interface SessionGroup {
  id: string
  name: string
  jumpHost?: JumpHostConfig
  sortOrder?: number
}

export type { SessionSortBy }

export interface SshSession {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  group?: string           // 保留旧字段，兼容迁移
  groupId?: string         // 新字段：引用分组 ID
  jumpHostOverride?: JumpHostConfig | null  // 覆盖分组跳板机
  sortOrder?: number       // 排序顺序
}

export interface TerminalSettings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
  localEncoding?: string
  commandHighlight?: boolean
  aiPanelPosition?: 'left' | 'right'
}

// Agent MBTI 类型
export type AgentMbtiType = 
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'
  | null

export type { LocaleType }

// 文件管理器书签
export interface FileBookmark {
  id: string
  name: string
  path: string
  type: 'local' | 'remote'
  // 远程书签需要关联主机信息
  hostId?: string      // SSH 会话 ID
  hostName?: string    // 主机名称（显示用）
  createdAt: number
}

// UI 主题类型 — 共享类型 UiThemeName 的本地别名（保留 UiThemeType 名字以兼容外部引用者）
export type UiThemeType = UiThemeName

// 快捷键配置（值为 Electron Accelerator 格式，空字符串表示禁用）
export interface KeyboardShortcuts {
  newLocalTerminal: string
  newAssistantTab: string
  newSshConnection: string
  batchCommand: string
  openFileManager: string
  toggleSidebar: string
  navBack: string
  navForward: string
  toggleAiPanel: string
  toggleKnowledge: string
  clearTerminal: string
  openSettings: string
  aiDebugConsole: string
  voiceInput: string
  splitHorizontal: string
  splitVertical: string
  closePane: string
  sendMessage: string
  queueFollowUp: string
}

// 分屏快捷键的平台默认值：mac 用 ⌘ 系，win/linux 用 Ctrl+Shift 系；
// Ctrl+D 是终端 EOF 不能误用，所以这里用 Cmd/Ctrl 字面量精确表达，而非 CmdOrCtrl。
// 详细原因见 src/utils/shortcut.ts 的 matchAccelerator 注释。
const _isMac = process.platform === 'darwin'

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
  newLocalTerminal: 'CmdOrCtrl+Shift+T',
  newAssistantTab: 'CmdOrCtrl+T',
  newSshConnection: 'CmdOrCtrl+N',
  batchCommand: 'CmdOrCtrl+Shift+B',
  openFileManager: 'CmdOrCtrl+F',
  toggleSidebar: 'CmdOrCtrl+B',
  navBack: 'CmdOrCtrl+[',
  navForward: 'CmdOrCtrl+]',
  toggleAiPanel: 'CmdOrCtrl+I',
  toggleKnowledge: 'CmdOrCtrl+Shift+K',
  clearTerminal: 'CmdOrCtrl+K',
  openSettings: 'CmdOrCtrl+,',
  aiDebugConsole: 'F12',
  // Windows 默认关闭（裸 Ctrl 与输入法切换冲突，无干净 hold 键）；macOS 保留 Control。
  // 空字符串 = 功能关闭，与前端 src/stores/config.ts 保持一致。
  voiceInput: _isMac ? 'Control' : '',
  splitHorizontal: _isMac ? 'Cmd+D' : 'Ctrl+Shift+D',
  splitVertical: _isMac ? 'Cmd+Shift+D' : 'Ctrl+Shift+E',
  closePane: _isMac ? 'Cmd+Shift+W' : 'Ctrl+Shift+W',
  sendMessage: 'Enter',
  queueFollowUp: _isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
}

interface StoreSchema {
  aiProfiles: AiProfile[]
  activeAiProfile: string
  sshSessions: SshSession[]
  sessionGroups: SessionGroup[]
  theme: string
  uiTheme: UiThemeType
  uiThemeMode: UiThemeMode
  terminalSettings: TerminalSettings
  proxySettings: {
    enabled: boolean
    url: string
  }
  mcpServers: McpServerConfig[]
  agentMbti: AgentMbtiType
  agentDebugMode: boolean
  /**
   * 助手埋头干活的那几步是否收成一行（点开仍可看全过程）。
   *
   * 故意不设默认值，`undefined` = 用户还没表态：此时摊开每一步（第一次用的人
   * 该看见它怎么把活干成的），并有资格在长任务里被邀请一次收起来。显式 `false`
   * 是"我就要看全过程"，不再打扰。两者生效表现相同，只能靠有无此键区分。
   *
   * 一旦写进 defaultConfig，conf 构造时就会把默认值落盘，"还没表态"不复存在，
   * 邀请永远不会出现。别加默认值。
   */
  foldAgentProcess?: boolean
  /** 长任务邀请已出现过几次（上限 2 次，跨会话累计） */
  foldProcessInviteCount: number
  /** 崩溃后是否主动提示（用户可在提示里勾选永久关闭） */
  crashNotifyEnabled: boolean
  knowledgeSettings: KnowledgeSettings
  setupCompleted: boolean
  agentOnboardingCompleted: boolean
  /**
   * 诞生引导是否已展示过（与 completed 分离：用户跳过引导时也只展示一次）。
   * 故意不设默认值：保持"未设置"状态可区分于显式 false，
   * 使 getAgentOnboardingShown 能对老用户（仅有 completed）做向后兼容回退。
   */
  agentOnboardingShown?: boolean
  language: LocaleType
  /** 整窗界面缩放（1 = 100%），和菜单放大/缩小同一套 */
  uiZoomFactor: number
  sponsorStatus: boolean
  sessionSortBy: SessionSortBy
  defaultGroupSortOrder: number
  fileBookmarks: FileBookmark[]
  aiRules: string  // 用户自定义的 AI 规则/指令
  agentPersonalityText: string  // 用户自定义个性描述（在 MBTI 基础上追加）
  agentName: string             // AI 名字（默认旗鱼，用户可自定义）
  agentAvatar: string           // AI 头像（data URL，用户可自定义）
  autoCheckUpdate: boolean   // 启动时自动检查更新
  autoDownloadUpdate: boolean // 发现新版本后自动下载（Win/Linux）
  installUpdateOnQuit: boolean // 已下载更新在退出应用时安装（「退出时安装」）
  launchAtLogin: boolean     // 开机启动（登录系统后自动启动应用，仅打包态生效）
  dismissedUpdateVersion?: string // 关闭「退出时安装」时，用户选择「稍后提醒」跳过的版本号
  gatewayAutoStart: boolean  // Gateway 远程访问自动启动
  gatewayPort: number        // Gateway 端口
  gatewayHost: string        // Gateway 监听地址
  // IM 集成
  imDingTalkAutoConnect: boolean  // 钉钉自动连接
  imDingTalkClientId: string      // 钉钉 AppKey
  imDingTalkClientSecret: string  // 钉钉 AppSecret
  imFeishuAutoConnect: boolean    // 飞书自动连接
  imFeishuAppId: string           // 飞书 App ID
  imFeishuAppSecret: string       // 飞书 App Secret
  imWeComAutoConnect: boolean     // 企业微信自动连接
  imWeComBotId: string            // 企业微信 Bot ID（长连接模式）
  imWeComSecret: string           // 企业微信长连接密钥
  imWeComCorpId: string           // 企业微信 Corp ID（企业 API，wecom skill 使用）
  imWeComCorpSecret: string       // 企业微信 Corp Secret（企业 API，wecom skill 使用）
  imWeComAgentId: number          // 企业微信 Agent ID（企业 API，wecom skill 使用）
  imSlackAutoConnect: boolean     // Slack 自动连接
  imSlackBotToken: string         // Slack Bot Token (xoxb-...)
  imSlackAppToken: string         // Slack App-Level Token (xapp-...)
  imTelegramAutoConnect: boolean  // Telegram 自动连接
  imTelegramBotToken: string      // Telegram Bot Token
  imWeChatAutoConnect: boolean    // 微信自动连接
  imWeChatToken: string           // 微信 bot token（扫码登录获得）
  imWeChatBaseUrl: string         // 微信 API base URL
  imExecutionMode: ExecutionMode  // IM Agent 执行模式，默认 relaxed
  imProcessMode: IMProcessMode   // IM 过程消息投递模式，默认 'messages'
  /** @deprecated 已迁移至 imProcessMode，仅用于读取旧配置做隐式迁移 */
  imSendProcessMessages?: boolean
  imSendThinkingProcess: boolean  // IM 是否发送 AI 思考过程，默认 false
  imLastContacts: Record<string, unknown> // IM 各平台最近联系人（主动推送使用）
  imKnownUsers: string[] // IM 已知用户（platform:userId），用于首次联系检测
  logLevel: LogLevel  // 日志级别
  skillMarketRegistryUrl: string  // 技能市场 registry URL
  disabledBuiltinSkills: string[] // 被禁用的内置技能 ID 列表
  /** 输入区是否显示这场对话开着的技能胶囊；关掉只藏界面，技能仍装着 */
  showConversationSkillChips: boolean
  /** 单份记忆（L2 知识文档）最大字符数 */
  contextKnowledgeMaxChars: number
  agentAwakened: boolean           // 觉醒模式：AI 主动感知环境、推送消息
  watchHeartbeatEnabled: boolean  // Watch 心跳传感器是否启用（觉醒模式内部使用）
  watchHeartbeatInterval: number  // Watch 心跳间隔（分钟）
  watchEventPoolDrainMinutes: number  // EventPool 排水间隔（分钟），默认 15
  watchQuietHours: { start: string; end: string } | null  // 静默时段（24h 格式），null 表示不启用
  // App Lifecycle / 里程碑
  appLifecycleFirstUseDate: number       // 首次使用时间戳
  appLifecycleTotalConversations: number  // 累计对话次数
  appLifecycleAchievedMilestones: string[] // 已达成的里程碑 ID
  // 羁绊系统
  bondLevel: number                    // 综合羁绊值 (0-100)
  bondMilestones: string[]             // 已达成的羁绊里程碑
  bondLastCalculatedAt: number         // 上次计算时间
  keyboardShortcuts: KeyboardShortcuts  // 自定义快捷键
  autoVisionModel: boolean  // 自动使用视觉模型：遇到图片时自动切换到关联的视觉模型
  autoFailoverModel: boolean  // 自动切换可用模型：当前模型重试仍失败时从列表第一个开始换（只改这场对话）
  /** 它有多主动地把已经用不上的过程先交接掉 */
  proactiveCompact: ProactiveCompactStyle
  /** 替我审批：任务里本来要问用户的确认，先交给独立评审员看（默认关） */
  autoApprovalReview: boolean
  schemaVersion: number  // 数据 schema 版本号，用于迁移框架追踪已执行的 migration
  // 堡垒机（JumpServer）集成
  bastionUrl: string              // JumpServer 地址
  bastionUsername: string         // JumpServer 用户名
  bastionPassword: string         // JumpServer 密码
  bastionAutoJumpHost: boolean    // 自动将 JumpServer 配置为同步组的跳板机
  bastionJumpHostPort: number     // JumpServer SSH 端口（KoKo），默认 2222
  bastionRejectUnauthorized: boolean  // 是否验证 SSL 证书（默认 true）
  // 插件系统
  pluginsEnabled: boolean
  pluginsAllow: string[]
  pluginsDeny: string[]
  pluginsLoadPaths: string[]
  pluginsEntries: Record<string, { enabled: boolean; config?: Record<string, unknown> }>
  // TTS 语音合成
  ttsSettings: TtsSettings
  // 任务 / 联络桌面提示音
  cueSoundSettings: CueSoundSettings
  // Web 搜索
  webSearchSettings: WebSearchSettings
  /** 首页最近对话侧栏：置顶的 Agent 历史记录 ID（顺序即展示顺序） */
  pinnedConversationIds: string[]
  /** 最近对话自定义显示标题（record id → 用户命名，空则回退 userTask） */
  conversationDisplayTitles: Record<string, string>
  /** 解析失败 / 未知命令 的默认风险策略（按 executionMode 分档） */
  commandRiskPolicy: CommandRiskPolicy
  /** scratch/ 临时区自动清理：文件 mtime 超过 N 天则删，0 表示禁用自动清理 */
  scratchCleanupMaxAgeDays: number
}

const defaultConfig: StoreSchema = {
  aiProfiles: [],
  activeAiProfile: '',
  sshSessions: [],
  sessionGroups: [],
  theme: 'one-dark',
  uiTheme: DEFAULT_UI_THEME,
  uiThemeMode: DEFAULT_UI_THEME_MODE,
  terminalSettings: {
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000
  },
  proxySettings: {
    enabled: false,
    url: ''
  },
  mcpServers: [],
  agentMbti: null,
  agentDebugMode: false,
  // foldAgentProcess 故意不设默认：保持 undefined 以区分"还没表态"与显式 false
  foldProcessInviteCount: 0,
  crashNotifyEnabled: true,
  knowledgeSettings: DEFAULT_KNOWLEDGE_SETTINGS,
  setupCompleted: false,
  agentOnboardingCompleted: false,
  // agentOnboardingShown 故意不设默认：保持 undefined 以区分"未展示"与显式 false
  language: 'zh-CN',
  uiZoomFactor: 1,
  sponsorStatus: false,
  sessionSortBy: 'custom',
  defaultGroupSortOrder: -1,
  fileBookmarks: [],
  aiRules: '',
  agentPersonalityText: '',
  agentName: '',
  agentAvatar: '',
  autoCheckUpdate: true,
  autoDownloadUpdate: true,
  installUpdateOnQuit: true,
  launchAtLogin: false,
  gatewayAutoStart: false,
  gatewayPort: 3721,
  gatewayHost: '0.0.0.0',
  imDingTalkAutoConnect: false,
  imDingTalkClientId: '',
  imDingTalkClientSecret: '',
  imFeishuAutoConnect: false,
  imFeishuAppId: '',
  imFeishuAppSecret: '',
  imWeComAutoConnect: false,
  imWeComBotId: '',
  imWeComSecret: '',
  imWeComCorpId: '',
  imWeComCorpSecret: '',
  imWeComAgentId: 0,
  imSlackAutoConnect: false,
  imSlackBotToken: '',
  imSlackAppToken: '',
  imTelegramAutoConnect: false,
  imTelegramBotToken: '',
  imWeChatAutoConnect: true,   // 微信扫码登录后应默认开机重连；无 token 时启动逻辑会空操作
  imWeChatToken: '',
  imWeChatBaseUrl: '',
  imExecutionMode: 'relaxed',
  imProcessMode: 'messages',
  imSendThinkingProcess: false,
  imLastContacts: {},
  imKnownUsers: [],
  logLevel: 'warn',
  skillMarketRegistryUrl: '',
  disabledBuiltinSkills: [],
  showConversationSkillChips: true,
  contextKnowledgeMaxChars: DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS,
  agentAwakened: true,
  watchHeartbeatEnabled: true,
  watchHeartbeatInterval: 30,
  watchEventPoolDrainMinutes: 15,
  watchQuietHours: null,
  appLifecycleFirstUseDate: 0,
  appLifecycleTotalConversations: 0,
  appLifecycleAchievedMilestones: [],
  bondLevel: 0,
  bondMilestones: [],
  bondLastCalculatedAt: 0,
  keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
  autoVisionModel: true,
  autoFailoverModel: true,
  proactiveCompact: DEFAULT_PROACTIVE_COMPACT,
  autoApprovalReview: false,
  schemaVersion: 0,
  bastionUrl: '',
  bastionUsername: '',
  bastionPassword: '',
  bastionAutoJumpHost: true,
  bastionJumpHostPort: 2222,
  bastionRejectUnauthorized: true,
  // 插件系统
  pluginsEnabled: true,
  pluginsAllow: [],
  pluginsDeny: [],
  pluginsLoadPaths: [],
  pluginsEntries: {},
  // TTS 语音合成
  ttsSettings: DEFAULT_TTS_SETTINGS,
  cueSoundSettings: DEFAULT_CUE_SOUND_SETTINGS,
  // Web 搜索
  webSearchSettings: DEFAULT_WEB_SEARCH_SETTINGS,
  pinnedConversationIds: [],
  conversationDisplayTitles: {},
  commandRiskPolicy: { ...DEFAULT_COMMAND_RISK_POLICY },
  scratchCleanupMaxAgeDays: 7,
}

export class ConfigService {
  private store: Store<StoreSchema>

  constructor() {
    // CLI 与桌面共用同一配置文件（明文）；userData 已由 bootstrap / CLI shim 对齐。
    // 敏感数据（SSH 密码/API Key）由 credential.service 管理，不在此文件。
    // 不使用 safeStorage：Keychain ACL 绑定二进制签名，跨版本升级后密钥失效会读崩配置。
    this.store = this.createStore('qiyu-terminal-config')
    this.wrapStoreSetForBackup(this.store)
    try {
      ensureStartupConfigBackup()
    } catch (err) {
      log.error('Startup config backup failed:', err)
    }
  }

  /** 包装 electron-store.set：写盘前轻量备份（失败不阻断写盘） */
  private wrapStoreSetForBackup(store: Store<StoreSchema>): void {
    const originalSet = store.set.bind(store) as Store<StoreSchema>['set']
    store.set = ((key: keyof StoreSchema | Partial<StoreSchema>, value?: StoreSchema[keyof StoreSchema]) => {
      try {
        createConfigBackupIfNeeded()
      } catch (err) {
        log.error('Pre-write config backup failed:', err)
      }
      if (typeof key === 'object') {
        return originalSet(key)
      }
      return originalSet(key, value as StoreSchema[keyof StoreSchema])
    }) as Store<StoreSchema>['set']
  }

  private openPlainStore(storeName: string): Store<StoreSchema> {
    return new Store<StoreSchema>({ name: storeName, defaults: defaultConfig })
  }

  private createStore(storeName: string): Store<StoreSchema> {
    // 步骤 1：尝试明文读取（新安装或已完成迁移的用户，正常路径）
    try {
      return this.openPlainStore(storeName)
    } catch (plainErr) {
      log.warn('明文配置读取失败，尝试从滚动备份恢复:', plainErr)
    }

    // 步骤 1b：从 config-backups/（或 backups/ 整包）恢复后再读明文
    try {
      const restoredFrom = tryRestoreConfigFromBackups()
      if (restoredFrom) {
        try {
          const store = this.openPlainStore(storeName)
          setConfigRecoveryNotice({ kind: 'restored', from: restoredFrom, at: Date.now() })
          log.warn(`配置已从备份恢复: ${restoredFrom}`)
          return store
        } catch (afterRestoreErr) {
          log.error('从备份恢复后仍无法读取明文配置:', afterRestoreErr)
        }
      }
    } catch (restoreErr) {
      log.error('尝试配置备份恢复时出错:', restoreErr)
    }

    // 步骤 2：尝试用当前机器的 safeStorage 密钥解密旧文件，并迁移为明文
    // （适用于 v11 正常升级的用户：Keychain 未变，能解密，迁移后不再依赖 safeStorage）
    const encryptionKey = this.deriveEncryptionKey()
    if (encryptionKey) {
      try {
        const encryptedStore = new Store<StoreSchema>({
          name: storeName,
          defaults: defaultConfig,
          encryptionKey,
        })
        const allData = encryptedStore.store
        if (allData && typeof allData === 'object' && Object.keys(allData).length > 0) {
          // 原子性保障：先备份旧文件，再删除，再写明文。
          // 若写入中途崩溃，备份文件仍在，下次启动步骤 2 可重试。
          const filePath = this.getStorePath(storeName)
          const backupPath = `${filePath}.enc.${Date.now()}`
          fs.copyFileSync(filePath, backupPath)
          fs.unlinkSync(filePath)
          const plainStore = this.openPlainStore(storeName)
          plainStore.store = allData
          log.info(`已将配置从加密格式迁移为明文存储（共 ${Object.keys(allData).length} 项），加密备份保留于 ${backupPath}`)
          return plainStore
        }
      } catch (_decryptErr) {
        // Keychain 密钥已变（跨签名升级），无法解密，走 fallback
      }
    }

    // 步骤 3：无法解密且无可用备份，备份旧文件后以默认值重建（必须提示用户）
    const reason = encryptionKey
      ? 'Keychain 密钥已变或配置损坏且无法从备份恢复'
      : '配置损坏且无法从备份恢复'
    log.warn(`配置无法加载（${reason}），将备份旧文件并重置为默认值`)
    this.backupCorruptedConfig(storeName)
    setConfigRecoveryNotice({ kind: 'reset', at: Date.now() })
    return this.openPlainStore(storeName)
  }

  peekRecoveryNotice(): ConfigRecoveryNotice | null {
    return peekConfigRecoveryNotice()
  }

  dismissRecoveryNotice(): void {
    dismissConfigRecoveryNotice()
  }

  /** config 文件绝对路径 */
  private getStorePath(storeName: string): string {
    return path.join(app.getPath('userData'), `${storeName}.json`)
  }

  /** 生成与旧版相同的 safeStorage 派生密钥，用于读取旧加密文件 */
  private deriveEncryptionKey(): string | undefined {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const keyBuffer = safeStorage.encryptString('qiyu-terminal-encryption-key-v1')
        return keyBuffer.toString('hex').substring(0, 32)
      }
    } catch {
      // ignore
    }
    return undefined
  }

  private backupCorruptedConfig(storeName: string): void {
    try {
      const filePath = this.getStorePath(storeName)
      const backupPath = `${filePath}.bak.${Date.now()}`
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath)
        fs.unlinkSync(filePath)
        log.info(`旧配置已备份至 ${backupPath}`)
      }
    } catch (backupErr) {
      log.warn(`备份旧配置文件失败: ${backupErr}`)
    }
  }

  /**
   * 获取配置项
   */
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K] {
    return this.store.get(key)
  }

  /**
   * 设置配置项
   */
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
    this.store.set(key, value)
  }

  /**
   * 检查配置项是否存在于磁盘（区别于 defaults 兜底返回的值）。
   * migration 中用来识别"新用户（已有该字段）"vs"老用户（字段缺失）"。
   */
  has<K extends keyof StoreSchema>(key: K): boolean {
    return this.store.has(key)
  }

  /**
   * 获取所有配置
   */
  getAll(): StoreSchema {
    return this.store.store
  }

  // ==================== Schema Version ====================

  getSchemaVersion(): number {
    return this.store.get('schemaVersion') ?? 0
  }

  setSchemaVersion(version: number): void {
    this.store.set('schemaVersion', version)
  }

  // ==================== AI 配置 ====================

  /**
   * 获取所有 AI Profiles
   */
  getAiProfiles(): AiProfile[] {
    return this.store.get('aiProfiles') || []
  }

  /**
   * 设置 AI Profiles
   */
  setAiProfiles(profiles: AiProfile[]): void {
    this.store.set('aiProfiles', profiles)
  }

  /**
   * 添加 AI Profile
   */
  addAiProfile(profile: AiProfile): void {
    const profiles = this.getAiProfiles()
    profiles.push(profile)
    this.setAiProfiles(profiles)
  }

  /**
   * 更新 AI Profile
   */
  updateAiProfile(profile: AiProfile): void {
    const profiles = this.getAiProfiles()
    const index = profiles.findIndex(p => p.id === profile.id)
    if (index !== -1) {
      profiles[index] = profile
      this.setAiProfiles(profiles)
    }
  }

  /**
   * 删除 AI Profile
   */
  deleteAiProfile(id: string): void {
    const profiles = this.getAiProfiles()
    const filtered = profiles.filter(p => p.id !== id)
    this.setAiProfiles(filtered)
  }

  /**
   * 获取当前激活的 AI Profile ID
   */
  getActiveAiProfile(): string {
    return this.store.get('activeAiProfile') || ''
  }

  /**
   * 设置当前激活的 AI Profile ID
   */
  setActiveAiProfile(profileId: string): void {
    this.store.set('activeAiProfile', profileId)
  }

  /**
   * 指定 AI 配置是否具备视觉（多模态）能力
   * - 目标模型本身标记为 vision → 直接具备
   * - 目标模型为 general/未标记 → 需 autoVisionModel 开启 + 有效的 visionProfileId
   * @param profileId 目标 profile id；不传则使用 active profile（向后兼容）
   */
  hasVisionCapability(profileId?: string): boolean {
    const profiles = this.getAiProfiles()
    const targetId = profileId ?? this.getActiveAiProfile()
    const profile = profiles.find(p => p.id === targetId)
    if (!profile) return false
    if (profile.modelType === 'vision') return true
    if (!this.get('autoVisionModel')) return false
    const visionId = profile.visionProfileId
    return !!(visionId && visionId !== targetId && profiles.some(p => p.id === visionId))
  }

  // ==================== SSH 会话配置 ====================

  /**
   * 获取所有 SSH 会话
   */
  getSshSessions(): SshSession[] {
    return this.store.get('sshSessions') || []
  }

  /**
   * 设置 SSH 会话
   */
  setSshSessions(sessions: SshSession[]): void {
    this.store.set('sshSessions', sessions)
  }

  /**
   * 添加 SSH 会话
   */
  addSshSession(session: SshSession): void {
    const sessions = this.getSshSessions()
    sessions.push(session)
    this.setSshSessions(sessions)
  }

  /**
   * 更新 SSH 会话
   */
  updateSshSession(session: SshSession): void {
    const sessions = this.getSshSessions()
    const index = sessions.findIndex(s => s.id === session.id)
    if (index !== -1) {
      sessions[index] = session
      this.setSshSessions(sessions)
    }
  }

  /**
   * 删除 SSH 会话
   */
  deleteSshSession(id: string): void {
    const sessions = this.getSshSessions()
    const filtered = sessions.filter(s => s.id !== id)
    this.setSshSessions(filtered)
  }

  // ==================== 会话分组配置 ====================

  /**
   * 获取所有会话分组
   */
  getSessionGroups(): SessionGroup[] {
    return this.store.get('sessionGroups') || []
  }

  /**
   * 设置会话分组
   */
  setSessionGroups(groups: SessionGroup[]): void {
    this.store.set('sessionGroups', groups)
  }

  /**
   * 添加会话分组
   */
  addSessionGroup(group: SessionGroup): void {
    const groups = this.getSessionGroups()
    groups.push(group)
    this.setSessionGroups(groups)
  }

  /**
   * 更新会话分组
   */
  updateSessionGroup(group: SessionGroup): void {
    const groups = this.getSessionGroups()
    const index = groups.findIndex(g => g.id === group.id)
    if (index !== -1) {
      groups[index] = group
      this.setSessionGroups(groups)
    }
  }

  /**
   * 删除会话分组
   */
  deleteSessionGroup(id: string): void {
    const groups = this.getSessionGroups()
    const filtered = groups.filter(g => g.id !== id)
    this.setSessionGroups(filtered)
  }

  // ==================== 主题配置 ====================

  /**
   * 获取当前主题
   */
  getTheme(): string {
    return this.store.get('theme') || 'one-dark'
  }

  /**
   * 设置主题
   */
  setTheme(theme: string): void {
    this.store.set('theme', theme)
  }

  /**
   * 获取 UI 主题
   */
  getUiTheme(): UiThemeType {
    return this.store.get('uiTheme') || DEFAULT_UI_THEME
  }

  /**
   * 设置 UI 主题
   */
  setUiTheme(theme: UiThemeType): void {
    this.store.set('uiTheme', theme)
  }

  /**
   * 获取 UI 主题模式（manual / auto）
   */
  getUiThemeMode(): UiThemeMode {
    return this.store.get('uiThemeMode') || DEFAULT_UI_THEME_MODE
  }

  /**
   * 设置 UI 主题模式
   */
  setUiThemeMode(mode: UiThemeMode): void {
    this.store.set('uiThemeMode', mode)
  }

  // ==================== 终端设置 ====================

  /**
   * 获取终端设置
   */
  getTerminalSettings(): TerminalSettings {
    const raw = this.store.get('terminalSettings') || defaultConfig.terminalSettings
    return normalizeTerminalSettings(raw as unknown as Record<string, unknown>)
  }

  /**
   * 设置终端设置
   */
  setTerminalSettings(settings: TerminalSettings): void {
    this.store.set('terminalSettings', settings)
  }

  // ==================== 代理设置 ====================

  /**
   * 获取代理设置
   */
  getProxySettings(): { enabled: boolean; url: string } {
    return this.store.get('proxySettings') || defaultConfig.proxySettings
  }

  /**
   * 设置代理设置
   */
  setProxySettings(settings: { enabled: boolean; url: string }): void {
    this.store.set('proxySettings', settings)
  }

  // ==================== MCP 服务器配置 ====================

  /**
   * 获取所有 MCP 服务器配置
   */
  getMcpServers(): McpServerConfig[] {
    return this.store.get('mcpServers') || []
  }

  /**
   * 设置 MCP 服务器配置
   */
  setMcpServers(servers: McpServerConfig[]): void {
    this.store.set('mcpServers', servers)
  }

  /**
   * 添加 MCP 服务器
   */
  addMcpServer(server: McpServerConfig): void {
    const servers = this.getMcpServers()
    servers.push(server)
    this.setMcpServers(servers)
  }

  /**
   * 更新 MCP 服务器
   */
  updateMcpServer(server: McpServerConfig): void {
    const servers = this.getMcpServers()
    const index = servers.findIndex(s => s.id === server.id)
    if (index !== -1) {
      servers[index] = server
      this.setMcpServers(servers)
    }
  }

  /**
   * 删除 MCP 服务器
   */
  deleteMcpServer(id: string): void {
    const servers = this.getMcpServers()
    const filtered = servers.filter(s => s.id !== id)
    this.setMcpServers(filtered)
  }

  /**
   * 获取启用的 MCP 服务器
   */
  getEnabledMcpServers(): McpServerConfig[] {
    return this.getMcpServers().filter(s => s.enabled)
  }

  // ==================== Agent MBTI 设置 ====================

  /**
   * 获取 Agent MBTI 类型
   */
  getAgentMbti(): AgentMbtiType {
    return this.store.get('agentMbti') || null
  }

  /**
   * 设置 Agent MBTI 类型
   */
  setAgentMbti(mbti: AgentMbtiType): void {
    this.store.set('agentMbti', mbti)
  }

  // ==================== Agent 调试模式 ====================

  /**
   * 获取 Agent 调试模式
   */
  getAgentDebugMode(): boolean {
    return this.store.get('agentDebugMode') || false
  }

  /**
   * 设置 Agent 调试模式
   */
  setAgentDebugMode(enabled: boolean): void {
    this.store.set('agentDebugMode', enabled)
  }

  // ==================== 崩溃提示 ====================

  /** 默认开启：不主动开口问，崩溃反馈就永远只有零星几个用户会说 */
  getCrashNotifyEnabled(): boolean {
    return this.store.get('crashNotifyEnabled') ?? true
  }

  setCrashNotifyEnabled(enabled: boolean): void {
    this.store.set('crashNotifyEnabled', enabled)
  }

  // ==================== 命令风险策略 ====================

  /**
   * 获取命令风险策略。
   * 老配置无此字段时回退默认值；字段缺失时补齐默认值。
   */
  getCommandRiskPolicy(): CommandRiskPolicy {
    const stored = this.store.get('commandRiskPolicy')
    if (!stored) return { ...DEFAULT_COMMAND_RISK_POLICY, extraFreeDirs: [] }
    return {
      strictParseFail: stored.strictParseFail ?? DEFAULT_COMMAND_RISK_POLICY.strictParseFail,
      strictUnknownCmd: stored.strictUnknownCmd ?? DEFAULT_COMMAND_RISK_POLICY.strictUnknownCmd,
      strictIndirection: stored.strictIndirection ?? DEFAULT_COMMAND_RISK_POLICY.strictIndirection,
      strictDynamicPath: stored.strictDynamicPath ?? DEFAULT_COMMAND_RISK_POLICY.strictDynamicPath,
      relaxedParseFail: stored.relaxedParseFail ?? DEFAULT_COMMAND_RISK_POLICY.relaxedParseFail,
      relaxedUnknownCmd: stored.relaxedUnknownCmd ?? DEFAULT_COMMAND_RISK_POLICY.relaxedUnknownCmd,
      relaxedIndirection: stored.relaxedIndirection ?? DEFAULT_COMMAND_RISK_POLICY.relaxedIndirection,
      relaxedDynamicPath: stored.relaxedDynamicPath ?? DEFAULT_COMMAND_RISK_POLICY.relaxedDynamicPath,
      relaxedConfirmModerate: stored.relaxedConfirmModerate ?? DEFAULT_COMMAND_RISK_POLICY.relaxedConfirmModerate,
      outsideWritesUpgrade: stored.outsideWritesUpgrade ?? DEFAULT_COMMAND_RISK_POLICY.outsideWritesUpgrade,
      extraFreeDirs: Array.isArray(stored.extraFreeDirs)
        ? stored.extraFreeDirs.filter((d): d is string => typeof d === 'string' && d.trim().length > 0)
        : [],
      subAgentBlockDangerous: stored.subAgentBlockDangerous ?? DEFAULT_COMMAND_RISK_POLICY.subAgentBlockDangerous,
    }
  }

  /**
   * 设置命令风险策略
   */
  setCommandRiskPolicy(policy: CommandRiskPolicy): void {
    const allowed = new Set(COMMAND_RISK_POLICY_ALLOWED_LEVELS)
    const sanitize = (level: RiskLevel | undefined, fallback: RiskLevel): RiskLevel =>
      level && allowed.has(level) ? level : fallback
    const dirs = Array.isArray(policy.extraFreeDirs)
      ? [...new Set(policy.extraFreeDirs.map(d => d.trim()).filter(Boolean))]
      : []
    this.store.set('commandRiskPolicy', {
      strictParseFail: sanitize(policy.strictParseFail, DEFAULT_COMMAND_RISK_POLICY.strictParseFail),
      strictUnknownCmd: sanitize(policy.strictUnknownCmd, DEFAULT_COMMAND_RISK_POLICY.strictUnknownCmd),
      strictIndirection: sanitize(policy.strictIndirection, DEFAULT_COMMAND_RISK_POLICY.strictIndirection),
      strictDynamicPath: sanitize(policy.strictDynamicPath, DEFAULT_COMMAND_RISK_POLICY.strictDynamicPath),
      relaxedParseFail: sanitize(policy.relaxedParseFail, DEFAULT_COMMAND_RISK_POLICY.relaxedParseFail),
      relaxedUnknownCmd: sanitize(policy.relaxedUnknownCmd, DEFAULT_COMMAND_RISK_POLICY.relaxedUnknownCmd),
      relaxedIndirection: sanitize(policy.relaxedIndirection, DEFAULT_COMMAND_RISK_POLICY.relaxedIndirection),
      relaxedDynamicPath: sanitize(policy.relaxedDynamicPath, DEFAULT_COMMAND_RISK_POLICY.relaxedDynamicPath),
      relaxedConfirmModerate: policy.relaxedConfirmModerate === true,
      outsideWritesUpgrade: policy.outsideWritesUpgrade === true,
      extraFreeDirs: dirs,
      subAgentBlockDangerous: policy.subAgentBlockDangerous !== false,
    })
  }

  // ==================== 知识库设置 ====================

  /**
   * 获取知识库设置
   */
  getKnowledgeSettings(): KnowledgeSettings {
    return this.store.get('knowledgeSettings') || DEFAULT_KNOWLEDGE_SETTINGS
  }

  /**
   * 设置知识库设置
   */
  setKnowledgeSettings(settings: KnowledgeSettings): void {
    this.store.set('knowledgeSettings', settings)
  }

  /**
   * 更新部分知识库设置
   */
  updateKnowledgeSettings(settings: Partial<KnowledgeSettings>): void {
    const current = this.getKnowledgeSettings()
    this.store.set('knowledgeSettings', { ...current, ...settings })
  }

  // ==================== 首次设置向导 ====================

  /**
   * 获取是否完成首次设置
   */
  getSetupCompleted(): boolean {
    return this.store.get('setupCompleted') || false
  }

  /**
   * 设置是否完成首次设置
   */
  setSetupCompleted(completed: boolean): void {
    this.store.set('setupCompleted', completed)
  }

  // ==================== Agent 诞生引导 ====================

  getAgentOnboardingCompleted(): boolean {
    return this.store.get('agentOnboardingCompleted') || false
  }

  setAgentOnboardingCompleted(completed: boolean): void {
    this.store.set('agentOnboardingCompleted', completed)
    if (completed) {
      this.store.set('agentOnboardingShown', true)
    }
  }

  getAgentOnboardingShown(): boolean {
    // 显式设置过（true/false）就以其为准；仅当从未设置（undefined）时，
    // 才回退到 completed，兼容"引导完成字段早于 shown 字段存在"的老用户。
    const shown = this.store.get('agentOnboardingShown')
    if (typeof shown === 'boolean') {
      return shown
    }
    return this.getAgentOnboardingCompleted()
  }

  setAgentOnboardingShown(shown: boolean): void {
    this.store.set('agentOnboardingShown', shown)
  }

  // ==================== 语言设置 ====================

  /**
   * 获取当前语言
   */
  getLanguage(): LocaleType {
    return this.store.get('language') || 'zh-CN'
  }

  /**
   * 设置语言
   */
  setLanguage(language: LocaleType): void {
    this.store.set('language', language)
  }

  /**
   * 获取赞助状态
   */
  getSponsorStatus(): boolean {
    return this.store.get('sponsorStatus') || false
  }

  /**
   * 设置赞助状态
   */
  setSponsorStatus(status: boolean): void {
    this.store.set('sponsorStatus', status)
  }

  // ==================== 排序设置 ====================

  /**
   * 获取主机排序方式
   */
  getSessionSortBy(): SessionSortBy {
    return this.store.get('sessionSortBy') || 'custom'
  }

  /**
   * 设置主机排序方式
   */
  setSessionSortBy(sortBy: SessionSortBy): void {
    this.store.set('sessionSortBy', sortBy)
  }

  /**
   * 获取默认分组排序位置
   */
  getDefaultGroupSortOrder(): number {
    return this.store.get('defaultGroupSortOrder') ?? -1
  }

  /**
   * 设置默认分组排序位置
   */
  setDefaultGroupSortOrder(order: number): void {
    this.store.set('defaultGroupSortOrder', order)
  }

  // ==================== 文件书签配置 ====================

  /**
   * 获取所有文件书签
   */
  getFileBookmarks(): FileBookmark[] {
    return this.store.get('fileBookmarks') || []
  }

  /**
   * 设置文件书签
   */
  setFileBookmarks(bookmarks: FileBookmark[]): void {
    this.store.set('fileBookmarks', bookmarks)
  }

  /**
   * 添加文件书签
   */
  addFileBookmark(bookmark: FileBookmark): void {
    const bookmarks = this.getFileBookmarks()
    bookmarks.push(bookmark)
    this.setFileBookmarks(bookmarks)
  }

  /**
   * 更新文件书签
   */
  updateFileBookmark(bookmark: FileBookmark): void {
    const bookmarks = this.getFileBookmarks()
    const index = bookmarks.findIndex(b => b.id === bookmark.id)
    if (index !== -1) {
      bookmarks[index] = bookmark
      this.setFileBookmarks(bookmarks)
    }
  }

  /**
   * 删除文件书签
   */
  deleteFileBookmark(id: string): void {
    const bookmarks = this.getFileBookmarks()
    const filtered = bookmarks.filter(b => b.id !== id)
    this.setFileBookmarks(filtered)
  }

  /**
   * 获取本地书签
   */
  getLocalBookmarks(): FileBookmark[] {
    return this.getFileBookmarks().filter(b => b.type === 'local')
  }

  /**
   * 获取指定主机的远程书签
   */
  getRemoteBookmarks(hostId?: string): FileBookmark[] {
    const remoteBookmarks = this.getFileBookmarks().filter(b => b.type === 'remote')
    if (hostId) {
      return remoteBookmarks.filter(b => b.hostId === hostId)
    }
    return remoteBookmarks
  }

  // ==================== AI Rules 设置 ====================

  /**
   * 获取 AI Rules
   */
  getAiRules(): string {
    return this.store.get('aiRules') || ''
  }

  getProactiveCompact(): ProactiveCompactStyle {
    return normalizeProactiveCompact(this.store.get('proactiveCompact'))
  }

  /** 只有明确打开才算开：旧数据缺字段、类型不对都当关 */
  isAutoApprovalReviewEnabled(): boolean {
    return this.store.get('autoApprovalReview') === true
  }

  /**
   * 设置 AI Rules
   */
  setAiRules(rules: string): void {
    this.store.set('aiRules', rules)
  }

  /**
   * 获取 Agent 个性描述
   */
  getAgentPersonalityText(): string {
    return this.store.get('agentPersonalityText') || ''
  }

  /**
   * 设置 Agent 个性描述
   */
  setAgentPersonalityText(text: string): void {
    const MAX_PERSONALITY_TEXT_LENGTH = 1000
    const safeText = text.length > MAX_PERSONALITY_TEXT_LENGTH
      ? text.substring(0, MAX_PERSONALITY_TEXT_LENGTH)
      : text
    this.store.set('agentPersonalityText', safeText)
  }

  // ==================== AI 名字 ====================

  getAgentName(): string {
    return this.store.get('agentName') || ''
  }

  setAgentName(name: string): void {
    const safeName = (name || '').trim().substring(0, 20)
    this.store.set('agentName', safeName)
  }

  // ==================== AI 头像 ====================

  getAgentAvatar(): string {
    return this.store.get('agentAvatar') || ''
  }

  setAgentAvatar(dataUrl: string): void {
    const MAX_AVATAR_SIZE = 100 * 1024
    if (dataUrl.length > MAX_AVATAR_SIZE) return
    this.store.set('agentAvatar', dataUrl)
  }

  // ==================== 快捷键 ====================

  getKeyboardShortcuts(): KeyboardShortcuts {
    const raw = this.store.get('keyboardShortcuts') || {}
    return normalizeKeyboardShortcuts(raw as unknown as Record<string, unknown>, DEFAULT_KEYBOARD_SHORTCUTS)
  }

  setKeyboardShortcuts(shortcuts: KeyboardShortcuts): void {
    this.store.set('keyboardShortcuts', shortcuts)
  }

  // ==================== 日志级别 ====================

  getLogLevel(): LogLevel {
    return this.store.get('logLevel') || 'warn'
  }

  setLogLevel(level: LogLevel): void {
    this.store.set('logLevel', level)
  }
}

let _instance: ConfigService | null = null

export function getConfigService(): ConfigService {
  if (!_instance) {
    _instance = new ConfigService()
  }
  return _instance
}

export function setConfigServiceInstance(instance: ConfigService): void {
  _instance = instance
}

