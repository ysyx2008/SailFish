import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { KnowledgeSettings } from './knowledge/types'
import { DEFAULT_KNOWLEDGE_SETTINGS } from './knowledge/types'

export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
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

// 会话分组
export interface SessionGroup {
  id: string
  name: string
  jumpHost?: JumpHostConfig
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
  jumpHostOverride?: JumpHostConfig | null  // 覆盖分组跳板机
}

export interface TerminalSettings {
  fontSize: number
  fontFamily: string
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
}

// MCP 服务器配置
export interface McpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: 'stdio' | 'sse'
  // stdio 模式
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  // sse 模式
  url?: string
  headers?: Record<string, string>
}

// Agent MBTI 类型
export type AgentMbtiType = 
  | 'INTJ' | 'INTP' | 'ENTJ' | 'ENTP'
  | 'INFJ' | 'INFP' | 'ENFJ' | 'ENFP'
  | 'ISTJ' | 'ISFJ' | 'ESTJ' | 'ESFJ'
  | 'ISTP' | 'ISFP' | 'ESTP' | 'ESFP'
  | null

// 语言类型
export type LocaleType = 'zh-CN' | 'en-US'

interface StoreSchema {
  aiProfiles: AiProfile[]
  activeAiProfile: string
  sshSessions: SshSession[]
  sessionGroups: SessionGroup[]
  theme: string
  terminalSettings: TerminalSettings
  proxySettings: {
    enabled: boolean
    url: string
  }
  mcpServers: McpServerConfig[]
  agentMbti: AgentMbtiType
  knowledgeSettings: KnowledgeSettings
  setupCompleted: boolean
  language: LocaleType
}

const defaultConfig: StoreSchema = {
  aiProfiles: [],
  activeAiProfile: '',
  sshSessions: [],
  sessionGroups: [],
  theme: 'one-dark',
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
  knowledgeSettings: DEFAULT_KNOWLEDGE_SETTINGS,
  setupCompleted: false,
  language: 'zh-CN'
}

export class ConfigService {
  private store: Store<StoreSchema>

  constructor() {
    // 使用 safeStorage 生成加密密钥
    let encryptionKey: string | undefined
    
    try {
      if (safeStorage.isEncryptionAvailable()) {
        // 使用固定标识符生成一致的加密密钥
        const keyBuffer = safeStorage.encryptString('qiyu-terminal-encryption-key-v1')
        encryptionKey = keyBuffer.toString('hex').substring(0, 32) // 取前32字符作为密钥
      }
    } catch (e) {
      console.warn('safeStorage not available, using unencrypted storage')
    }

    this.store = new Store<StoreSchema>({
      name: 'qiyu-terminal-config',
      defaults: defaultConfig,
      encryptionKey // 启用加密存储
    })
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
   * 获取所有配置
   */
  getAll(): StoreSchema {
    return this.store.store
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

  // ==================== 终端设置 ====================

  /**
   * 获取终端设置
   */
  getTerminalSettings(): TerminalSettings {
    return this.store.get('terminalSettings') || defaultConfig.terminalSettings
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
}

