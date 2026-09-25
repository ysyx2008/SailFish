import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { jumpHostFromGroup, type AiModelType, type AiProfile, type ApiFormat, type JumpHostConfig, type ProactiveCompactStyle, type SessionSortBy, type SshEncoding, type SystemColorScheme, type UiThemeMode } from '@shared/types'
import { clampUiZoomFactor, DEFAULT_CUE_SOUND_SETTINGS, DEFAULT_PROACTIVE_COMPACT, DEFAULT_UI_THEME, DEFAULT_UI_THEME_MODE, normalizeCueSoundSettings, normalizeProactiveCompact, resolveEffectiveUiTheme, UI_ZOOM_DEFAULT } from '@shared/types'
import { setLocale, type LocaleType } from '../i18n'
import { uiThemes, type UiThemeName } from '../themes/ui-themes'
import { setLogLevel as setFrontendLogLevel, type LogLevel } from '../utils/logger'

export type { AiModelType, AiProfile, ApiFormat, JumpHostConfig, SshEncoding }

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

// 分屏快捷键的平台默认值：
// - mac 沿用原生终端 / iTerm2 习惯：⌘D 水平、⌘⇧D 垂直、⌘⇧W 关窗格
// - win/linux：Ctrl+Shift+D 水平、Ctrl+Shift+E 垂直、Ctrl+Shift+W 关窗格
//   （Ctrl+D 是终端 EOF，绝不能被分屏拦截，所以默认值用 Cmd/Ctrl 而非 CmdOrCtrl
//   精确表达——matchAccelerator 会按字面意思区分这两类修饰键）
const _isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

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
  // Windows 下裸 Ctrl 与输入法切换（Ctrl+Space/Ctrl+Shift）冲突，且无干净的纯键盘 hold 键，
  // 故 Win 默认关闭；macOS 输入法不依赖 Ctrl，保留 'Control' 默认。
  // 快捷键为空字符串即视为功能关闭（不下模型、不监听按键）。
  voiceInput: _isMac ? 'Control' : '',
  splitHorizontal: _isMac ? 'Cmd+D' : 'Ctrl+Shift+D',
  splitVertical: _isMac ? 'Cmd+Shift+D' : 'Ctrl+Shift+E',
  closePane: _isMac ? 'Cmd+Shift+W' : 'Ctrl+Shift+W',
  sendMessage: 'Enter',
  queueFollowUp: _isMac ? 'Cmd+Enter' : 'Ctrl+Enter',
}

// 会话分组（支持跳板机继承）
export interface SessionGroup {
  id: string
  name: string
  jumpHost?: JumpHostConfig  // 可选的跳板机配置，组内会话自动继承
  sortOrder?: number         // 排序顺序
}

// 主机排序方式
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
  jumpHostOverride?: JumpHostConfig | null  // 覆盖分组跳板机：null 表示显式禁用，undefined 表示继承
  encoding?: SshEncoding   // 字符编码，默认 utf-8
  lastUsedAt?: number      // 最近使用时间戳（毫秒）
  sortOrder?: number       // 排序顺序
}

// 本地终端编码类型（与 SSH 编码共用）
export type LocalEncoding = 
  | 'auto'       // 自动检测（Windows 根据系统语言，其他系统 UTF-8）
  | 'utf-8'      // UTF-8
  | 'gbk'        // 简体中文 (Windows)
  | 'gb2312'     // 简体中文
  | 'gb18030'    // 简体中文 (完整)
  | 'big5'       // 繁体中文
  | 'shift_jis'  // 日语
  | 'euc-jp'     // 日语 (Unix)
  | 'euc-kr'     // 韩语
  | 'iso-8859-1' // Latin-1 (西欧语言)
  | 'iso-8859-15'// Latin-9 (西欧语言，含欧元符号)
  | 'windows-1252' // Windows 西欧
  | 'koi8-r'     // 俄语
  | 'windows-1251' // 俄语 (Windows)

export interface TerminalSettings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
  localEncoding: LocalEncoding  // 本地终端编码
  commandHighlight: boolean     // 命令行高亮
  aiPanelPosition: 'left' | 'right'  // 助手面板位置
}

// Agent MBTI 类型
export type AgentMbtiType = 
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'
  | null

// ==================== 邮箱账户配置 ====================

// 邮箱服务商类型
export type EmailProvider = 'gmail' | 'outlook' | 'qq' | '163' | 'custom'

// 邮箱认证类型
export type EmailAuthType = 'password' | 'oauth2'

// 预置邮箱服务器配置
export const EMAIL_PROVIDER_CONFIGS: Record<Exclude<EmailProvider, 'custom'>, {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
}> = {
  gmail: {
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true
  },
  outlook: {
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    smtpHost: 'smtp.office365.com',
    smtpPort: 587,
    smtpSecure: false  // STARTTLS
  },
  qq: {
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
    smtpSecure: true
  },
  '163': {
    imapHost: 'imap.163.com',
    imapPort: 993,
    smtpHost: 'smtp.163.com',
    smtpPort: 465,
    smtpSecure: true
  }
}

// 账户连接状态
export type AccountTestStatus = 'success' | 'failed' | 'unknown'

// 邮箱账户配置
export interface EmailAccount {
  id: string
  name: string              // 显示名称
  email: string             // 邮箱地址
  provider: EmailProvider   // 服务商
  authType: EmailAuthType   // 认证类型
  // 自定义服务器配置（provider 为 custom 时使用）
  imapHost?: string
  imapPort?: number
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  // TLS 选项
  rejectUnauthorized?: boolean  // 是否验证服务器证书，默认 true
  // 连接状态
  lastTestStatus?: AccountTestStatus
  lastTestTime?: number
  lastTestMessage?: string
  // 元数据
  createdAt?: number
  lastUsedAt?: number
}

// ==================== 日历账户配置 ====================

// 日历服务商类型
export type CalendarProvider = 'google' | 'icloud' | 'outlook' | 'wecom' | 'caldav'

// 预置 CalDAV 服务器配置
export const CALENDAR_PROVIDER_CONFIGS: Record<Exclude<CalendarProvider, 'caldav'>, {
  serverUrl: string
  displayName: string
  icon: string
}> = {
  google: {
    serverUrl: 'https://www.googleapis.com/caldav/v2',
    displayName: 'Google Calendar',
    icon: '📅'
  },
  icloud: {
    serverUrl: 'https://caldav.icloud.com',
    displayName: 'Apple iCloud',
    icon: '🍎'
  },
  outlook: {
    serverUrl: 'https://outlook.office365.com/caldav',
    displayName: 'Microsoft Outlook',
    icon: '📧'
  },
  wecom: {
    serverUrl: 'https://caldav.wecom.work',
    displayName: '企业微信',
    icon: '💼'
  }
}

// 日历账户配置
export interface CalendarAccount {
  id: string
  name: string                  // 显示名称
  provider: CalendarProvider    // 服务商
  username: string              // 用户名/邮箱
  // 自定义服务器配置（provider 为 caldav 时使用）
  serverUrl?: string
  // 连接状态
  lastTestStatus?: AccountTestStatus
  lastTestTime?: number
  lastTestMessage?: string
  // 元数据
  createdAt?: number
  lastUsedAt?: number
}

// ==================== UI 主题本地缓存 ====================
// 通过 localStorage 缓存上次使用的 UI 主题 + 模式，配合 index.html 的内联脚本
// 在 Vue 挂载之前就把 data-ui-theme 写到 <html>，消除启动时的颜色闪烁（FOUC）。
// key 与 index.html / file-manager.html 的内联脚本保持一致。
const UI_THEME_STORAGE_KEY = 'sfterm-ui-theme'                  // 实际生效的主题（auto 时是 system→dark/light）
const UI_THEME_MODE_STORAGE_KEY = 'sfterm-ui-theme-mode'        // manual / auto
const UI_COLOR_SCHEME_STORAGE_KEY = 'sfterm-ui-color-scheme'    // 实际生效的 dark/light

function readCachedUiTheme(): UiThemeName {
  try {
    const cached = typeof localStorage !== 'undefined'
      ? localStorage.getItem(UI_THEME_STORAGE_KEY)
      : null
    if (cached && cached in uiThemes) {
      return cached as UiThemeName
    }
  } catch { /* localStorage 不可用时静默降级 */ }
  return DEFAULT_UI_THEME
}

function readCachedUiThemeMode(): UiThemeMode {
  try {
    const cached = typeof localStorage !== 'undefined'
      ? localStorage.getItem(UI_THEME_MODE_STORAGE_KEY)
      : null
    if (cached === 'manual' || cached === 'auto') return cached
  } catch { /* localStorage 不可用时静默降级 */ }
  return DEFAULT_UI_THEME_MODE
}

function readSystemColorScheme(): SystemColorScheme {
  try {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
  } catch { /* matchMedia 不可用时静默降级 */ }
  return 'dark'
}

function writeCachedUiTheme(theme: UiThemeName): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(UI_THEME_STORAGE_KEY, theme)
    const scheme = uiThemes[theme]?.colorScheme ?? 'dark'
    localStorage.setItem(UI_COLOR_SCHEME_STORAGE_KEY, scheme)
  } catch { /* localStorage 不可用时静默降级 */ }
}

function writeCachedUiThemeMode(mode: UiThemeMode): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(UI_THEME_MODE_STORAGE_KEY, mode)
  } catch { /* localStorage 不可用时静默降级 */ }
}

export const useConfigStore = defineStore('config', () => {
  // AI 配置
  const aiProfiles = ref<AiProfile[]>([])
  const activeAiProfileId = ref<string>('')

  // SSH 会话
  const sshSessions = ref<SshSession[]>([])

  // 会话分组
  const sessionGroups = ref<SessionGroup[]>([])

  // 主题
  const currentTheme = ref<string>('one-dark')

  // UI 主题（用户在 manual 模式下选定的固定主题）
  // 初始值优先读 localStorage 缓存（在 index.html 的内联脚本里已经写入 <html data-ui-theme>），
  // 这样 Vue 首帧渲染的 data-ui-theme 就与 <html> 上的兜底保持一致，避免颜色闪烁。
  const uiTheme = ref<UiThemeName>(readCachedUiTheme())

  // UI 主题模式：manual=用户固定主题；auto=跟随系统外观（在 dark / light 之间切换）
  const uiThemeMode = ref<UiThemeMode>(readCachedUiThemeMode())

  // 系统当前外观（启动时同步用 matchMedia 读取，运行期由 main 进程通过 IPC 推送更新）
  const systemColorScheme = ref<SystemColorScheme>(readSystemColorScheme())

  /**
   * 实际生效的 UI 主题：
   * - manual 模式直接返回 uiTheme
   * - auto 模式根据 systemColorScheme 在 dark / light 之间切换
   */
  const effectiveUiTheme = computed<UiThemeName>(() =>
    resolveEffectiveUiTheme(uiThemeMode.value, uiTheme.value, systemColorScheme.value)
  )

  // 实际生效主题变化时同步缓存（auto 模式下 effective 与 uiTheme 不一致，必须以 effective 为准）
  watch(effectiveUiTheme, (value) => {
    writeCachedUiTheme(value)
  })

  watch(uiThemeMode, (value) => {
    writeCachedUiThemeMode(value)
  })

  // 终端设置
  const terminalSettings = ref<TerminalSettings>({
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    localEncoding: 'auto',  // 默认自动检测
    commandHighlight: true,  // 默认开启命令高亮
    aiPanelPosition: 'right'  // 助手面板默认在右侧
  })

  // Agent MBTI 设置
  const agentMbti = ref<AgentMbtiType>('ENFJ')

  // Agent 调试模式
  const agentDebugMode = ref<boolean>(false)

  // 首次设置向导
  const setupCompleted = ref<boolean>(false)

  // Agent 诞生引导
  const agentOnboardingCompleted = ref<boolean>(false)
  const agentOnboardingShown = ref<boolean>(false)

  // 语言设置
  const language = ref<LocaleType>('zh-CN')

  // 赞助状态
  const isSponsor = ref<boolean>(false)

  // 主机排序方式
  const sessionSortBy = ref<SessionSortBy>('custom')

  // 默认分组的排序位置（-1 表示在最后）
  const defaultGroupSortOrder = ref<number>(-1)

  // AI Rules（用户自定义的 AI 指令）
  const aiRules = ref<string>('')
  // Agent 个性描述（在 MBTI 基础上追加）
  const agentPersonalityText = ref<string>('')
  // AI 名字（默认旗鱼，用户可自定义）
  const agentName = ref<string>('')
  // AI 头像（data URL，用户可自定义）
  const agentAvatar = ref<string>('')

  // 日志级别
  const logLevel = ref<LogLevel>('warn')

  // 邮箱账户
  const emailAccounts = ref<EmailAccount[]>([])

  // 日历账户
  const calendarAccounts = ref<CalendarAccount[]>([])

  // 快捷键设置
  const keyboardShortcuts = ref<KeyboardShortcuts>({ ...DEFAULT_KEYBOARD_SHORTCUTS })

  // 输入区是否显示这场对话开着的技能胶囊（关掉只藏界面）
  const showConversationSkillChips = ref<boolean>(true)

  // 整窗界面缩放（1 = 100%），和菜单放大/缩小同一套
  const uiZoomFactor = ref<number>(UI_ZOOM_DEFAULT)

  // 自动使用视觉模型
  const autoVisionModel = ref<boolean>(true)
  // 自动切换可用模型（失败后从列表第一个开始换，只改这场对话）
  const autoFailoverModel = ref<boolean>(true)
  const proactiveCompact = ref<ProactiveCompactStyle>(DEFAULT_PROACTIVE_COMPACT)
  // 收起过程的表态：undefined = 还没表态，摊开且有资格被邀请一次
  const foldAgentProcessChoice = ref<boolean | undefined>(undefined)
  /** 生效值。唯一真相是用户的表态——没表态就摊开，不在这里兜第二个默认 */
  const foldAgentProcess = computed(() => foldAgentProcessChoice.value === true)
  /** 还没表态，长任务邀请的资格前提 */
  const foldAgentProcessUndecided = computed(() => foldAgentProcessChoice.value === undefined)
  // 长任务邀请已出现过几次（上限 2 次，跨会话累计）
  const foldProcessInviteCount = ref<number>(0)

  // TTS 语音合成设置
  const ttsSettings = ref<import('@shared/types').TtsSettings>({
    ...{ enabled: false, providerId: 'openai-compat', preset: 'openai', apiUrl: 'https://api.openai.com/v1/audio/speech', apiKey: '', model: 'tts-1', voice: 'alloy', speed: 1.0, autoSpeak: false },
  })

  const cueSoundSettings = ref<import('@shared/types').CueSoundSettings>({
    ...DEFAULT_CUE_SOUND_SETTINGS,
  })

  // Web 搜索设置
  const webSearchSettings = ref<import('@shared/types').WebSearchSettings>({
    enabled: false, providerId: 'bocha', apiKeys: {},
  })

  // 首页最近对话置顶（Agent 历史 record id）
  const pinnedConversationIds = ref<string[]>([])
  // 最近对话自定义标题
  const conversationDisplayTitles = ref<Record<string, string>>({})

  // 计算属性
  const activeAiProfile = computed(() =>
    aiProfiles.value.find(p => p.id === activeAiProfileId.value)
  )

  const hasAiConfig = computed(() => aiProfiles.value.length > 0)

  /**
   * 加载所有配置
   */
  async function loadConfig(): Promise<void> {
    try {
      const [
        profiles, activeId, sessions, groups,
        theme, uiThemeValue, mbti, debugMode,
        completed, onboarded, onboardingShown, lang, sponsorStatus,
        sortBy, defaultOrder, rules, personalityText,
        savedAgentName, savedAgentAvatar, savedLogLevel, savedTerminalSettings,
        accounts, savedShortcuts, savedAutoVision, savedAutoFailover, calAccounts, savedTtsSettings, savedCueSoundSettings, savedWebSearchSettings,
        themeMode, sysScheme, savedPinnedConversationIds, savedConversationDisplayTitles,
        savedFoldAgentProcess, savedFoldProcessInviteCount, savedShowConversationSkillChips,
        savedUiZoomFactor, savedProactiveCompact,
      ] = await Promise.all([
        window.electronAPI.config.getAiProfiles(),
        window.electronAPI.config.getActiveAiProfile(),
        window.electronAPI.config.getSshSessions(),
        window.electronAPI.config.getSessionGroups(),
        window.electronAPI.config.getTheme(),
        window.electronAPI.config.getUiTheme(),
        window.electronAPI.config.getAgentMbti(),
        window.electronAPI.config.getAgentDebugMode(),
        window.electronAPI.config.getSetupCompleted(),
        window.electronAPI.config.getAgentOnboardingCompleted(),
        window.electronAPI.config.get('agentOnboardingShown') as Promise<boolean | undefined>,
        window.electronAPI.config.getLanguage(),
        window.electronAPI.config.getSponsorStatus(),
        window.electronAPI.config.getSessionSortBy(),
        window.electronAPI.config.getDefaultGroupSortOrder(),
        window.electronAPI.config.getAiRules(),
        window.electronAPI.config.getAgentPersonalityText(),
        window.electronAPI.config.getAgentName(),
        window.electronAPI.config.getAgentAvatar(),
        window.electronAPI.config.get('logLevel') as Promise<string | undefined>,
        window.electronAPI.config.get('terminalSettings'),
        window.electronAPI.config.get('emailAccounts') as Promise<EmailAccount[] | undefined>,
        window.electronAPI.config.get('keyboardShortcuts') as Promise<Partial<KeyboardShortcuts> | null | undefined>,
        window.electronAPI.config.get('autoVisionModel') as Promise<boolean | undefined>,
        window.electronAPI.config.get('autoFailoverModel') as Promise<boolean | undefined>,
        window.electronAPI.config.get('calendarAccounts') as Promise<CalendarAccount[] | undefined>,
        window.electronAPI.config.get('ttsSettings') as Promise<import('@shared/types').TtsSettings | undefined>,
        window.electronAPI.config.get('cueSoundSettings') as Promise<import('@shared/types').CueSoundSettings | undefined>,
        window.electronAPI.config.get('webSearchSettings') as Promise<import('@shared/types').WebSearchSettings | undefined>,
        window.electronAPI.config.getUiThemeMode(),
        window.electronAPI.config.getSystemColorScheme(),
        window.electronAPI.config.get('pinnedConversationIds') as Promise<string[] | undefined>,
        window.electronAPI.config.get('conversationDisplayTitles') as Promise<Record<string, string> | undefined>,
        window.electronAPI.config.get('foldAgentProcess') as Promise<boolean | undefined>,
        window.electronAPI.config.get('foldProcessInviteCount') as Promise<number | undefined>,
        window.electronAPI.config.get('showConversationSkillChips') as Promise<boolean | undefined>,
        window.electronAPI.config.get('uiZoomFactor') as Promise<number | undefined>,
        window.electronAPI.config.get('proactiveCompact'),
      ])

      // 批量赋值
      aiProfiles.value = profiles || []
      activeAiProfileId.value = activeId || ''
      sshSessions.value = sessions || []
      sessionGroups.value = (groups || []).map(group => {
        if (!group.jumpHost) return group
        const marked = jumpHostFromGroup(group.name, group.jumpHost)
        return marked === group.jumpHost ? group : { ...group, jumpHost: marked }
      })
      if (sessionGroups.value.some((group, i) => group !== (groups || [])[i])) {
        void saveSessionGroups()
      }
      currentTheme.value = theme || 'one-dark'
      uiTheme.value = uiThemeValue || DEFAULT_UI_THEME
      uiThemeMode.value = themeMode || DEFAULT_UI_THEME_MODE
      systemColorScheme.value = sysScheme || systemColorScheme.value
      agentMbti.value = mbti as AgentMbtiType
      agentDebugMode.value = debugMode || false
      setupCompleted.value = completed || false
      agentOnboardingCompleted.value = onboarded || false
      agentOnboardingShown.value = onboardingShown || onboarded || false
      if (lang) {
        language.value = lang as LocaleType
        setLocale(lang as LocaleType)
      }
      isSponsor.value = sponsorStatus || false
      sessionSortBy.value = (sortBy as SessionSortBy) || 'custom'
      defaultGroupSortOrder.value = defaultOrder ?? -1
      aiRules.value = rules || ''
      agentPersonalityText.value = personalityText || ''
      agentName.value = savedAgentName || ''
      agentAvatar.value = savedAgentAvatar || ''
      if (savedLogLevel != null && savedLogLevel !== '') {
        logLevel.value = savedLogLevel as LogLevel
        setFrontendLogLevel(savedLogLevel as LogLevel)
      }
      if (savedTerminalSettings) {
        terminalSettings.value = { ...terminalSettings.value, ...savedTerminalSettings }
      }
      emailAccounts.value = accounts || []
      if (savedShortcuts && typeof savedShortcuts === 'object') {
        keyboardShortcuts.value = { ...DEFAULT_KEYBOARD_SHORTCUTS, ...savedShortcuts }
      }
      autoVisionModel.value = savedAutoVision ?? true
      autoFailoverModel.value = savedAutoFailover ?? true
      // 刻意不 `?? true`：磁盘上没有这个键就是"还没表态"，兜默认会让这个状态消失
      foldAgentProcessChoice.value = typeof savedFoldAgentProcess === 'boolean' ? savedFoldAgentProcess : undefined
      foldProcessInviteCount.value = savedFoldProcessInviteCount ?? 0
      showConversationSkillChips.value = savedShowConversationSkillChips ?? true
      uiZoomFactor.value = clampUiZoomFactor(savedUiZoomFactor ?? UI_ZOOM_DEFAULT)
      proactiveCompact.value = normalizeProactiveCompact(savedProactiveCompact)
      calendarAccounts.value = calAccounts || []
      if (savedTtsSettings && typeof savedTtsSettings === 'object') {
        ttsSettings.value = { ...ttsSettings.value, ...savedTtsSettings }
      }
      if (savedCueSoundSettings && typeof savedCueSoundSettings === 'object') {
        const custom = savedCueSoundSettings.custom && typeof savedCueSoundSettings.custom === 'object'
          ? { ...savedCueSoundSettings.custom }
          : {}
        cueSoundSettings.value = normalizeCueSoundSettings({
          ...savedCueSoundSettings,
          custom,
        })
      }
      if (savedWebSearchSettings && typeof savedWebSearchSettings === 'object') {
        webSearchSettings.value = { ...webSearchSettings.value, ...savedWebSearchSettings }
      }
      pinnedConversationIds.value = Array.isArray(savedPinnedConversationIds) ? savedPinnedConversationIds : []
      conversationDisplayTitles.value =
        savedConversationDisplayTitles && typeof savedConversationDisplayTitles === 'object'
          ? { ...savedConversationDisplayTitles }
          : {}

      // 后端同步（不阻塞主流程）
      if (emailAccounts.value.length > 0) {
        const plainAccounts = JSON.parse(JSON.stringify(emailAccounts.value))
        window.electronAPI.email.syncAccounts(plainAccounts).catch(() => {})
      }
      if (calendarAccounts.value.length > 0 && window.electronAPI.calendar) {
        const plainCalAccounts = JSON.parse(JSON.stringify(calendarAccounts.value))
        window.electronAPI.calendar.syncAccounts(plainCalAccounts).catch(() => {})
      }
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

  /**
   * 监听后端配置变更（由 Agent config 技能触发），自动重新加载
   */
  let cleanupConfigChanged: (() => void) | null = null
  function listenConfigChanged(): void {
    if (cleanupConfigChanged) return
    cleanupConfigChanged = window.electronAPI.config.onChanged((payload) => {
      if (Array.isArray(payload?.sshSessions)) {
        const prev = new Map(sshSessions.value.map(s => [s.id, s]))
        sshSessions.value = payload.sshSessions.map((incoming) => {
          const next = incoming as SshSession
          const old = prev.get(next.id)
          return {
            ...next,
            password: next.password ?? old?.password,
            passphrase: next.passphrase ?? old?.passphrase,
          }
        })
      }
      if (Array.isArray(payload?.sessionGroups)) {
        sessionGroups.value = [...payload.sessionGroups] as SessionGroup[]
      }
      loadConfig()
    })
  }
  listenConfigChanged()

  let cleanupUiZoomChanged: (() => void) | null = null
  function listenUiZoomChanged(): void {
    if (cleanupUiZoomChanged) return
    if (!window.electronAPI?.config?.onUiZoomChanged) return
    cleanupUiZoomChanged = window.electronAPI.config.onUiZoomChanged((factor) => {
      uiZoomFactor.value = clampUiZoomFactor(factor)
    })
  }
  listenUiZoomChanged()

  /**
   * 监听系统外观变化（macOS 早晚自动切换 / Win11 计划等），auto 模式下立即更新生效主题。
   * 主进程通过 nativeTheme 的 'updated' 事件广播，比 prefers-color-scheme media query
   * 在 Electron 下更可靠（部分版本 matchMedia 的 change 事件不稳定）。
   */
  let cleanupSystemSchemeChanged: (() => void) | null = null
  function listenSystemColorScheme(): void {
    if (cleanupSystemSchemeChanged) return
    if (!window.electronAPI?.config?.onSystemColorSchemeChanged) return
    cleanupSystemSchemeChanged = window.electronAPI.config.onSystemColorSchemeChanged((scheme) => {
      systemColorScheme.value = scheme
    })
  }
  listenSystemColorScheme()

  /**
   * 启动时尽早把主题相关的真实值从主进程同步进来（mount 之后立即并发执行，
   * 不阻塞首帧）。覆盖"首次启动、localStorage 还没缓存"的场景，让 DOM 主题
   * 尽早对齐磁盘真值，缩短可见的兜底期。loadConfig() 后续会再次覆盖，值
   * 一致时无视觉变化。
   */
  ;(async () => {
    try {
      if (!window.electronAPI?.config) return
      const [theme, mode, sysScheme] = await Promise.all([
        window.electronAPI.config.getUiTheme(),
        window.electronAPI.config.getUiThemeMode(),
        window.electronAPI.config.getSystemColorScheme(),
      ])
      if (theme) uiTheme.value = theme
      if (mode) uiThemeMode.value = mode
      if (sysScheme) systemColorScheme.value = sysScheme
    } catch { /* 主进程不可用时静默降级，由 store 默认值兜底 */ }
  })()

  // ==================== AI 配置 ====================

  async function saveAiProfiles(): Promise<void> {
    // 转换为普通对象，避免序列化错误
    const plainProfiles = JSON.parse(JSON.stringify(aiProfiles.value))
    await window.electronAPI.config.setAiProfiles(plainProfiles)
  }

  async function addAiProfile(profile: AiProfile): Promise<void> {
    aiProfiles.value.push(profile)
    await saveAiProfiles()

    // 如果是第一个，自动设为激活
    if (aiProfiles.value.length === 1) {
      await setActiveAiProfile(profile.id)
    }
  }

  async function updateAiProfile(profile: AiProfile): Promise<void> {
    const index = aiProfiles.value.findIndex(p => p.id === profile.id)
    if (index !== -1) {
      aiProfiles.value[index] = profile
      await saveAiProfiles()
    }
  }

  async function deleteAiProfile(id: string): Promise<void> {
    aiProfiles.value = aiProfiles.value
      .filter(p => p.id !== id)
      .map(p => (p.visionProfileId === id ? { ...p, visionProfileId: undefined } : p))
    await saveAiProfiles()

    // 如果删除的是当前激活的，切换到第一个
    if (activeAiProfileId.value === id && aiProfiles.value.length > 0) {
      await setActiveAiProfile(aiProfiles.value[0].id)
    }
  }

  async function reorderAiProfiles(fromIndex: number, toIndex: number): Promise<void> {
    const list = aiProfiles.value
    if (
      fromIndex === toIndex ||
      fromIndex < 0 || fromIndex >= list.length ||
      toIndex < 0 || toIndex >= list.length
    ) {
      return
    }
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    await saveAiProfiles()
  }

  async function setActiveAiProfile(id: string): Promise<void> {
    activeAiProfileId.value = id
    await window.electronAPI.config.setActiveAiProfile(id)
  }

  // ==================== SSH 会话 ====================

  async function saveSshSessions(): Promise<void> {
    // 转换为普通对象，避免序列化错误
    const plainSessions = JSON.parse(JSON.stringify(sshSessions.value))
    await window.electronAPI.config.setSshSessions(plainSessions)
  }

  async function addSshSession(session: SshSession): Promise<void> {
    sshSessions.value.push(session)
    await saveSshSessions()
  }

  async function updateSshSession(session: SshSession): Promise<void> {
    const index = sshSessions.value.findIndex(s => s.id === session.id)
    if (index !== -1) {
      sshSessions.value[index] = session
      await saveSshSessions()
    }
  }

  async function deleteSshSession(id: string): Promise<void> {
    sshSessions.value = sshSessions.value.filter(s => s.id !== id)
    await saveSshSessions()
  }

  // 更新会话的最近使用时间
  async function updateSessionLastUsed(id: string): Promise<void> {
    const session = sshSessions.value.find(s => s.id === id)
    if (session) {
      session.lastUsedAt = Date.now()
      await saveSshSessions()
    }
  }

  // ==================== 会话分组 ====================

  async function saveSessionGroups(): Promise<void> {
    const plainGroups = JSON.parse(JSON.stringify(sessionGroups.value))
    await window.electronAPI.config.setSessionGroups(plainGroups)
  }

  async function addSessionGroup(group: SessionGroup): Promise<void> {
    sessionGroups.value.push(group)
    await saveSessionGroups()
  }

  async function updateSessionGroup(group: SessionGroup): Promise<void> {
    const index = sessionGroups.value.findIndex(g => g.id === group.id)
    if (index !== -1) {
      sessionGroups.value[index] = group
      await saveSessionGroups()
    }
  }

  async function deleteSessionGroup(id: string): Promise<void> {
    sessionGroups.value = sessionGroups.value.filter(g => g.id !== id)
    await saveSessionGroups()
    // 清除引用该分组的会话的 groupId
    sshSessions.value.forEach(s => {
      if (s.groupId === id) {
        s.groupId = undefined
      }
    })
    await saveSshSessions()
  }

  /**
   * 根据分组名称获取分组
   */
  function getGroupByName(name: string): SessionGroup | undefined {
    return sessionGroups.value.find(g => g.name === name)
  }

  /**
   * 获取会话最终生效的跳板机配置
   * 优先级：会话自定义 > 分组继承 > 无
   */
  function getEffectiveJumpHost(session: SshSession): JumpHostConfig | undefined {
    // 如果会话显式禁用跳板机
    if (session.jumpHostOverride === null) {
      return undefined
    }
    // 如果会话有自定义跳板机
    if (session.jumpHostOverride) {
      return session.jumpHostOverride
    }
    // 继承分组的跳板机
    if (session.groupId) {
      const group = sessionGroups.value.find(g => g.id === session.groupId)
      return group?.jumpHost ? jumpHostFromGroup(group.name, group.jumpHost) : undefined
    }
    return undefined
  }

  // ==================== 主题 ====================

  async function setTheme(theme: string): Promise<void> {
    currentTheme.value = theme
    await window.electronAPI.config.setTheme(theme)
  }

  async function setUiTheme(theme: UiThemeName): Promise<void> {
    uiTheme.value = theme
    await window.electronAPI.config.setUiTheme(theme)
  }

  async function setUiThemeMode(mode: UiThemeMode): Promise<void> {
    uiThemeMode.value = mode
    await window.electronAPI.config.setUiThemeMode(mode)
  }

  // ==================== Agent MBTI ====================

  async function setAgentMbti(mbti: AgentMbtiType): Promise<void> {
    agentMbti.value = mbti
    await window.electronAPI.config.setAgentMbti(mbti)
  }

  // ==================== Agent 调试模式 ====================

  async function setAgentDebugMode(enabled: boolean): Promise<void> {
    agentDebugMode.value = enabled
    await window.electronAPI.config.setAgentDebugMode(enabled)
  }

  /** 标记诞生引导已展示（用户未完成 personality 流程时也仅触发一次） */
  async function markAgentOnboardingShown(): Promise<void> {
    if (agentOnboardingShown.value) return
    agentOnboardingShown.value = true
    await window.electronAPI.config.set('agentOnboardingShown', true)
  }

  // ==================== 视觉模型 ====================

  async function setAutoVisionModel(enabled: boolean): Promise<void> {
    autoVisionModel.value = enabled
    await window.electronAPI.config.set('autoVisionModel', enabled)
  }

  async function setAutoFailoverModel(enabled: boolean): Promise<void> {
    autoFailoverModel.value = enabled
    await window.electronAPI.config.set('autoFailoverModel', enabled)
  }

  async function setProactiveCompact(style: ProactiveCompactStyle): Promise<void> {
    const next = normalizeProactiveCompact(style)
    proactiveCompact.value = next
    await window.electronAPI.config.set('proactiveCompact', next)
  }

  /** 用户表态（设置页开关、或长任务邀请里的两个按钮）。落盘即视为表过态，从此不再邀请 */
  async function setFoldAgentProcess(enabled: boolean): Promise<void> {
    foldAgentProcessChoice.value = enabled
    await window.electronAPI.config.set('foldAgentProcess', enabled)
  }

  async function setShowConversationSkillChips(enabled: boolean): Promise<void> {
    showConversationSkillChips.value = enabled
    await window.electronAPI.config.set('showConversationSkillChips', enabled)
  }

  async function setUiZoomFactor(factor: number): Promise<void> {
    uiZoomFactor.value = clampUiZoomFactor(factor)
    await window.electronAPI.config.set('uiZoomFactor', uiZoomFactor.value)
  }

  /** 邀请露过一次面，消耗一次配额 */
  async function markFoldProcessInvited(): Promise<void> {
    foldProcessInviteCount.value += 1
    await window.electronAPI.config.set('foldProcessInviteCount', foldProcessInviteCount.value)
  }

  // ==================== 首次设置向导 ====================

  async function setSetupCompleted(completed: boolean): Promise<void> {
    setupCompleted.value = completed
    await window.electronAPI.config.setSetupCompleted(completed)
  }

  // ==================== 语言设置 ====================

  async function setLanguage(lang: LocaleType): Promise<void> {
    language.value = lang
    setLocale(lang)
    await window.electronAPI.config.setLanguage(lang)
  }

  // ==================== 赞助状态 ====================

  async function setSponsorStatus(status: boolean): Promise<void> {
    isSponsor.value = status
    await window.electronAPI.config.setSponsorStatus(status)
  }

  // ==================== 排序设置 ====================

  async function setSessionSortBy(sortBy: SessionSortBy): Promise<void> {
    sessionSortBy.value = sortBy
    await window.electronAPI.config.setSessionSortBy(sortBy)
  }

  async function setDefaultGroupSortOrder(order: number): Promise<void> {
    defaultGroupSortOrder.value = order
    await window.electronAPI.config.setDefaultGroupSortOrder(order)
  }

  // ==================== AI Rules ====================

  async function setAiRules(rules: string): Promise<void> {
    aiRules.value = rules
    await window.electronAPI.config.setAiRules(rules)
  }

  async function setAgentPersonalityText(text: string): Promise<void> {
    await window.electronAPI.config.setAgentPersonalityText(text)
    agentPersonalityText.value = text
  }

  async function setAgentName(name: string): Promise<void> {
    await window.electronAPI.config.setAgentName(name)
    agentName.value = name
  }

  async function setAgentAvatar(dataUrl: string): Promise<void> {
    await window.electronAPI.config.setAgentAvatar(dataUrl)
    agentAvatar.value = dataUrl
  }

  // ==================== 日志级别 ====================

  async function setLogLevel(level: LogLevel): Promise<void> {
    logLevel.value = level
    setFrontendLogLevel(level)
    await window.electronAPI.config.set('logLevel', level)
  }

  /**
   * 更新主机排序顺序
   */
  async function updateSessionSortOrder(sessionId: string, newOrder: number): Promise<void> {
    const session = sshSessions.value.find(s => s.id === sessionId)
    if (session) {
      session.sortOrder = newOrder
      await saveSshSessions()
    }
  }

  /**
   * 批量更新主机排序顺序
   */
  async function updateSessionsSortOrder(updates: { id: string; sortOrder: number }[]): Promise<void> {
    for (const update of updates) {
      const session = sshSessions.value.find(s => s.id === update.id)
      if (session) {
        session.sortOrder = update.sortOrder
      }
    }
    await saveSshSessions()
  }

  /**
   * 更新分组排序顺序
   */
  async function updateGroupSortOrder(groupId: string, newOrder: number): Promise<void> {
    const group = sessionGroups.value.find(g => g.id === groupId)
    if (group) {
      group.sortOrder = newOrder
      await saveSessionGroups()
    }
  }

  /**
   * 批量更新分组排序顺序
   */
  async function updateGroupsSortOrder(updates: { id: string; sortOrder: number }[]): Promise<void> {
    for (const update of updates) {
      const group = sessionGroups.value.find(g => g.id === update.id)
      if (group) {
        group.sortOrder = update.sortOrder
      }
    }
    await saveSessionGroups()
  }

  // ==================== 邮箱账户 ====================

  async function saveEmailAccounts(): Promise<void> {
    const plainAccounts = JSON.parse(JSON.stringify(emailAccounts.value))
    await window.electronAPI.config.set('emailAccounts', plainAccounts)
    // 同步到后端 email skill
    await window.electronAPI.email.syncAccounts(plainAccounts)
  }

  async function addEmailAccount(account: EmailAccount): Promise<void> {
    account.createdAt = Date.now()
    emailAccounts.value.push(account)
    await saveEmailAccounts()
  }

  async function updateEmailAccount(account: EmailAccount): Promise<void> {
    const index = emailAccounts.value.findIndex(a => a.id === account.id)
    if (index !== -1) {
      emailAccounts.value[index] = account
      await saveEmailAccounts()
    }
  }

  async function deleteEmailAccount(id: string): Promise<void> {
    emailAccounts.value = emailAccounts.value.filter(a => a.id !== id)
    await saveEmailAccounts()
    // 同时删除密钥链中的凭据（通过 IPC 调用）
    await window.electronAPI.email?.deleteCredential(id)
  }

  async function updateEmailAccountLastUsed(id: string): Promise<void> {
    const account = emailAccounts.value.find(a => a.id === id)
    if (account) {
      account.lastUsedAt = Date.now()
      await saveEmailAccounts()
    }
  }

  async function updateEmailAccountStatus(id: string, status: AccountTestStatus, message?: string): Promise<void> {
    const account = emailAccounts.value.find(a => a.id === id)
    if (account) {
      account.lastTestStatus = status
      account.lastTestTime = Date.now()
      account.lastTestMessage = message
      await saveEmailAccounts()
    }
  }

  /**
   * 获取邮箱账户的服务器配置
   */
  function getEmailServerConfig(account: EmailAccount): {
    imapHost: string
    imapPort: number
    smtpHost: string
    smtpPort: number
    smtpSecure: boolean
  } {
    if (account.provider === 'custom') {
      return {
        imapHost: account.imapHost || '',
        imapPort: account.imapPort || 993,
        smtpHost: account.smtpHost || '',
        smtpPort: account.smtpPort || 465,
        smtpSecure: account.smtpSecure ?? true
      }
    }
    return EMAIL_PROVIDER_CONFIGS[account.provider]
  }

  // ==================== 日历账户 ====================

  async function saveCalendarAccounts(): Promise<void> {
    const plainAccounts = JSON.parse(JSON.stringify(calendarAccounts.value))
    await window.electronAPI.config.set('calendarAccounts', plainAccounts)
    // 同步到后端 calendar skill
    if (window.electronAPI.calendar) {
      await window.electronAPI.calendar.syncAccounts(plainAccounts)
    }
  }

  async function addCalendarAccount(account: CalendarAccount): Promise<void> {
    account.createdAt = Date.now()
    calendarAccounts.value.push(account)
    await saveCalendarAccounts()
  }

  async function updateCalendarAccount(account: CalendarAccount): Promise<void> {
    const index = calendarAccounts.value.findIndex(a => a.id === account.id)
    if (index !== -1) {
      calendarAccounts.value[index] = account
      await saveCalendarAccounts()
    }
  }

  async function deleteCalendarAccount(id: string): Promise<void> {
    calendarAccounts.value = calendarAccounts.value.filter(a => a.id !== id)
    await saveCalendarAccounts()
    // 同时删除密钥链中的凭据
    await window.electronAPI.calendar?.deleteCredential(id)
  }

  async function updateCalendarAccountStatus(id: string, status: AccountTestStatus, message?: string): Promise<void> {
    const account = calendarAccounts.value.find(a => a.id === id)
    if (account) {
      account.lastTestStatus = status
      account.lastTestTime = Date.now()
      account.lastTestMessage = message
      await saveCalendarAccounts()
    }
  }

  /**
   * 获取日历账户的服务器配置
   */
  function getCalendarServerUrl(account: CalendarAccount): string {
    if (account.provider === 'caldav') {
      return account.serverUrl || ''
    }
    return CALENDAR_PROVIDER_CONFIGS[account.provider].serverUrl
  }

  // ==================== 快捷键设置 ====================

  async function setKeyboardShortcuts(shortcuts: KeyboardShortcuts): Promise<void> {
    keyboardShortcuts.value = shortcuts
    await window.electronAPI.config.setKeyboardShortcuts({ ...shortcuts })
  }

  // ==================== TTS 语音合成 ====================

  async function saveTtsSettings(settings: import('@shared/types').TtsSettings): Promise<void> {
    ttsSettings.value = { ...settings }
    await window.electronAPI.config.set('ttsSettings', JSON.parse(JSON.stringify(settings)))
  }

  async function saveCueSoundSettings(settings: import('@shared/types').CueSoundSettings): Promise<void> {
    cueSoundSettings.value = normalizeCueSoundSettings(settings)
    await window.electronAPI.config.set('cueSoundSettings', JSON.parse(JSON.stringify(cueSoundSettings.value)))
  }

  // ==================== Web 搜索 ====================

  async function saveWebSearchSettings(settings: import('@shared/types').WebSearchSettings): Promise<void> {
    webSearchSettings.value = { ...settings }
    await window.electronAPI.webSearch.updateSettings(settings)
  }

  // ==================== 最近对话置顶 ====================

  async function loadConversationPreferences(): Promise<void> {
    const [pins, titles] = await Promise.all([
      window.electronAPI.config.get('pinnedConversationIds') as Promise<string[] | undefined>,
      window.electronAPI.config.get('conversationDisplayTitles') as Promise<Record<string, string> | undefined>,
    ])
    pinnedConversationIds.value = Array.isArray(pins) ? [...pins] : []
    conversationDisplayTitles.value =
      titles && typeof titles === 'object' ? { ...titles } : {}
  }

  async function savePinnedConversationIds(ids: string[]): Promise<void> {
    const plain = [...ids]
    const previous = [...pinnedConversationIds.value]
    pinnedConversationIds.value = plain
    try {
      await window.electronAPI.config.set('pinnedConversationIds', plain)
    } catch (e) {
      pinnedConversationIds.value = previous
      throw e
    }
  }

  async function togglePinConversation(id: string): Promise<void> {
    const current = pinnedConversationIds.value
    if (current.includes(id)) {
      await savePinnedConversationIds(current.filter(x => x !== id))
    } else {
      await savePinnedConversationIds([id, ...current])
    }
  }

  function isConversationPinned(id: string): boolean {
    return pinnedConversationIds.value.includes(id)
  }

  function getConversationDisplayTitle(id: string): string | undefined {
    const title = conversationDisplayTitles.value[id]?.trim()
    return title || undefined
  }

  function resolveConversationTitle(id: string, userTask: string): string {
    return getConversationDisplayTitle(id) || userTask.trim()
  }

  async function setConversationDisplayTitle(id: string, title: string): Promise<void> {
    const trimmed = title.trim()
    const next = { ...conversationDisplayTitles.value }
    if (trimmed) {
      next[id] = trimmed
    } else {
      delete next[id]
    }
    const previous = { ...conversationDisplayTitles.value }
    conversationDisplayTitles.value = next
    try {
      await window.electronAPI.config.set('conversationDisplayTitles', next)
    } catch (e) {
      conversationDisplayTitles.value = previous
      throw e
    }
  }

  /**
   * 只移除指定会话的置顶/显示标题（删除单条历史时用）。
   * 不要用「当前 summaries 白名单」全量 prune：进行中尚未进历史索引的 live session
   * 不在 summaries 里，全量 prune 会误删其 LLM/手动标题。
   */
  async function removeConversationMetadata(id: string): Promise<void> {
    if (!id) return
    if (pinnedConversationIds.value.includes(id)) {
      await savePinnedConversationIds(pinnedConversationIds.value.filter(x => x !== id))
    }
    if (!(id in conversationDisplayTitles.value)) return
    const previous = { ...conversationDisplayTitles.value }
    const next = { ...previous }
    delete next[id]
    conversationDisplayTitles.value = next
    try {
      await window.electronAPI.config.set('conversationDisplayTitles', next)
    } catch (e) {
      conversationDisplayTitles.value = previous
      throw e
    }
  }

  async function pruneConversationMetadata(validIds: Set<string>): Promise<void> {
    // 历史索引尚未就绪时 list 可能为空，此时 prune 会把置顶/标题误删到磁盘
    if (validIds.size === 0) return

    const nextPins = pinnedConversationIds.value.filter(pid => validIds.has(pid))
    if (nextPins.length !== pinnedConversationIds.value.length) {
      await savePinnedConversationIds(nextPins)
    }
    const nextTitles: Record<string, string> = {}
    for (const [id, title] of Object.entries(conversationDisplayTitles.value)) {
      if (validIds.has(id) && title.trim()) nextTitles[id] = title.trim()
    }
    if (Object.keys(nextTitles).length !== Object.keys(conversationDisplayTitles.value).length) {
      const previousTitles = { ...conversationDisplayTitles.value }
      conversationDisplayTitles.value = nextTitles
      try {
        await window.electronAPI.config.set('conversationDisplayTitles', nextTitles)
      } catch (e) {
        conversationDisplayTitles.value = previousTitles
        throw e
      }
    }
  }

  return {
    // 状态
    aiProfiles,
    activeAiProfileId,
    activeAiProfile,
    hasAiConfig,
    sshSessions,
    sessionGroups,
    currentTheme,
    uiTheme,
    uiThemeMode,
    effectiveUiTheme,
    terminalSettings,
    agentMbti,
    agentDebugMode,
    autoVisionModel,
    autoFailoverModel,
    proactiveCompact,
    setProactiveCompact,
    foldAgentProcess,
    foldAgentProcessUndecided,
    foldProcessInviteCount,
    setFoldAgentProcess,
    markFoldProcessInvited,
    showConversationSkillChips,
    setShowConversationSkillChips,
    uiZoomFactor,
    setUiZoomFactor,
    setupCompleted,
    agentOnboardingCompleted,
    agentOnboardingShown,
    language,
    isSponsor,
    sessionSortBy,
    defaultGroupSortOrder,
    aiRules,
    agentPersonalityText,
    agentName,
    logLevel,
    emailAccounts,

    // 方法
    loadConfig,
    addAiProfile,
    updateAiProfile,
    deleteAiProfile,
    reorderAiProfiles,
    setActiveAiProfile,
    addSshSession,
    updateSshSession,
    deleteSshSession,
    updateSessionLastUsed,
    addSessionGroup,
    updateSessionGroup,
    deleteSessionGroup,
    getGroupByName,
    getEffectiveJumpHost,
    setTheme,
    setUiTheme,
    setUiThemeMode,
    setAgentMbti,
    markAgentOnboardingShown,
    setAgentDebugMode,
    setAutoVisionModel,
    setAutoFailoverModel,
    setSetupCompleted,
    setLanguage,
    setSponsorStatus,
    setSessionSortBy,
    setDefaultGroupSortOrder,
    updateSessionSortOrder,
    updateSessionsSortOrder,
    updateGroupSortOrder,
    updateGroupsSortOrder,
    setAiRules,
    setAgentPersonalityText,
    setAgentName,
    agentAvatar,
    setAgentAvatar,
    setLogLevel,
    addEmailAccount,
    updateEmailAccount,
    deleteEmailAccount,
    updateEmailAccountLastUsed,
    updateEmailAccountStatus,
    getEmailServerConfig,
    calendarAccounts,
    addCalendarAccount,
    updateCalendarAccount,
    deleteCalendarAccount,
    updateCalendarAccountStatus,
    getCalendarServerUrl,
    keyboardShortcuts,
    setKeyboardShortcuts,
    ttsSettings,
    saveTtsSettings,
    cueSoundSettings,
    saveCueSoundSettings,
    webSearchSettings,
    saveWebSearchSettings,
    pinnedConversationIds,
    togglePinConversation,
    isConversationPinned,
    savePinnedConversationIds,
    loadConversationPreferences,
    conversationDisplayTitles,
    getConversationDisplayTitle,
    resolveConversationTitle,
    setConversationDisplayTitle,
    removeConversationMetadata,
    pruneConversationMetadata,
  }
})

