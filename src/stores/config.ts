import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { v4 as uuidv4 } from 'uuid'
import { setLocale, type LocaleType } from '../i18n'

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  contextLength?: number  // 模型上下文长度（tokens），默认 8000
}

// 跳板机配置
export interface JumpHostConfig {
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

// 会话分组（支持跳板机继承）
export interface SessionGroup {
  id: string
  name: string
  jumpHost?: JumpHostConfig  // 可选的跳板机配置，组内会话自动继承
}

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
}

export interface TerminalSettings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
}

// Agent MBTI 类型
export type AgentMbtiType = 
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'
  | null

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

  // UI 主题
  const uiTheme = ref<'dark' | 'light' | 'blue'>('dark')

  // 终端设置
  const terminalSettings = ref<TerminalSettings>({
    fontSize: 14,
    fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000
  })

  // Agent MBTI 设置
  const agentMbti = ref<AgentMbtiType>(null)

  // 首次设置向导
  const setupCompleted = ref<boolean>(false)

  // 语言设置
  const language = ref<LocaleType>('zh-CN')

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
      // 加载 AI 配置
      const profiles = await window.electronAPI.config.getAiProfiles()
      aiProfiles.value = profiles || []

      const activeId = await window.electronAPI.config.getActiveAiProfile()
      activeAiProfileId.value = activeId || ''

      // 加载 SSH 会话
      const sessions = await window.electronAPI.config.getSshSessions()
      sshSessions.value = sessions || []

      // 加载会话分组
      const groups = await window.electronAPI.config.getSessionGroups()
      sessionGroups.value = groups || []

      // 数据迁移：将旧的 group 字符串转换为 SessionGroup
      await migrateGroupStringsToEntities()

      // 加载主题
      const theme = await window.electronAPI.config.getTheme()
      currentTheme.value = theme || 'one-dark'

      // 加载 UI 主题
      const uiThemeValue = await window.electronAPI.config.getUiTheme()
      uiTheme.value = uiThemeValue || 'dark'

      // 加载 Agent MBTI
      const mbti = await window.electronAPI.config.getAgentMbti()
      agentMbti.value = mbti as AgentMbtiType

      // 加载首次设置状态
      const completed = await window.electronAPI.config.getSetupCompleted()
      setupCompleted.value = completed || false

      // 加载语言设置
      const lang = await window.electronAPI.config.getLanguage()
      if (lang) {
        language.value = lang as LocaleType
        setLocale(lang as LocaleType)
      }
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

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
    aiProfiles.value = aiProfiles.value.filter(p => p.id !== id)
    await saveAiProfiles()

    // 如果删除的是当前激活的，切换到第一个
    if (activeAiProfileId.value === id && aiProfiles.value.length > 0) {
      await setActiveAiProfile(aiProfiles.value[0].id)
    }
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
      return group?.jumpHost
    }
    return undefined
  }

  // ==================== 主题 ====================

  async function setTheme(theme: string): Promise<void> {
    currentTheme.value = theme
    await window.electronAPI.config.setTheme(theme)
  }

  async function setUiTheme(theme: 'dark' | 'light' | 'blue'): Promise<void> {
    uiTheme.value = theme
    await window.electronAPI.config.setUiTheme(theme)
  }

  // ==================== Agent MBTI ====================

  async function setAgentMbti(mbti: AgentMbtiType): Promise<void> {
    agentMbti.value = mbti
    await window.electronAPI.config.setAgentMbti(mbti)
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

  // ==================== 数据迁移 ====================

  /**
   * 将旧的 group 字符串迁移为 SessionGroup 实体
   * 只在首次加载时执行一次
   */
  async function migrateGroupStringsToEntities(): Promise<void> {
    // 收集所有使用旧 group 字段但没有 groupId 的会话
    const sessionsToMigrate = sshSessions.value.filter(s => s.group && !s.groupId)
    if (sessionsToMigrate.length === 0) return

    // 收集所有唯一的分组名称
    const groupNames = new Set(sessionsToMigrate.map(s => s.group!))

    // 为每个分组名称创建 SessionGroup（如果不存在）
    let groupsChanged = false
    for (const name of groupNames) {
      if (!sessionGroups.value.find(g => g.name === name)) {
        sessionGroups.value.push({
          id: uuidv4(),
          name
        })
        groupsChanged = true
      }
    }

    // 更新会话的 groupId
    let sessionsChanged = false
    for (const session of sessionsToMigrate) {
      const group = sessionGroups.value.find(g => g.name === session.group)
      if (group) {
        session.groupId = group.id
        sessionsChanged = true
      }
    }

    // 保存更改
    if (groupsChanged) {
      await saveSessionGroups()
    }
    if (sessionsChanged) {
      await saveSshSessions()
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
    terminalSettings,
    agentMbti,
    setupCompleted,
    language,

    // 方法
    loadConfig,
    addAiProfile,
    updateAiProfile,
    deleteAiProfile,
    setActiveAiProfile,
    addSshSession,
    updateSshSession,
    deleteSshSession,
    addSessionGroup,
    updateSessionGroup,
    deleteSessionGroup,
    getGroupByName,
    getEffectiveJumpHost,
    setTheme,
    setUiTheme,
    setAgentMbti,
    setSetupCompleted,
    setLanguage
  }
})

