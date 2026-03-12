/**
 * 旗鱼配置管理技能 - 执行器
 */

import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ConfigExecutor')
import { getConfigService } from '../../../config.service'
import { getIMService, type IMService } from '../../../im/im.service'
import {
  getEmailCredential, setEmailCredential, deleteEmailCredential,
  getCalendarCredential, setCalendarCredential, deleteCalendarCredential
} from '../../../credential.service'
import { BrowserWindow } from 'electron'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'
import { getServerConfig as getEmailServerConfig } from '../email/session'
import { getServerConfig as getCalendarServerConfig } from '../calendar/session'

// ==================== 配置项元数据 ====================

type ConfigCategory = 'ui' | 'terminal' | 'agent' | 'im' | 'email' | 'calendar' | 'gateway' | 'proxy' | 'mcp' | 'knowledge'

interface ConfigMeta {
  key: string
  label: string
  category: ConfigCategory
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  /** 可选值枚举 */
  options?: string[]
  /** 是否只读（不允许 Agent 修改） */
  readonly?: boolean
}

const CONFIG_REGISTRY: ConfigMeta[] = [
  // UI
  { key: 'language', label: '界面语言', category: 'ui', type: 'string', options: ['zh-CN', 'en-US'] },
  { key: 'uiTheme', label: 'UI 主题', category: 'ui', type: 'string', options: ['dark', 'light', 'blue', 'gruvbox', 'forest', 'ayu-mirage', 'cyberpunk', 'lavender', 'aurora'] },
  { key: 'theme', label: '终端配色', category: 'ui', type: 'string' },

  // Terminal
  { key: 'terminalSettings.fontSize', label: '终端字号', category: 'terminal', type: 'number' },
  { key: 'terminalSettings.fontFamily', label: '终端字体', category: 'terminal', type: 'string' },
  { key: 'terminalSettings.cursorBlink', label: '光标闪烁', category: 'terminal', type: 'boolean' },
  { key: 'terminalSettings.cursorStyle', label: '光标样式', category: 'terminal', type: 'string', options: ['block', 'underline', 'bar'] },
  { key: 'terminalSettings.scrollback', label: '回滚行数', category: 'terminal', type: 'number' },

  // Agent
  { key: 'agentMbti', label: 'Agent 性格', category: 'agent', type: 'string', options: ['INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP', 'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP'] },
  { key: 'agentOnboardingCompleted', label: '新用户引导已完成', category: 'agent', type: 'boolean' },
  { key: 'agentDebugMode', label: '调试模式', category: 'agent', type: 'boolean' },
  { key: 'logLevel', label: '日志级别', category: 'agent', type: 'string', options: ['debug', 'info', 'warn', 'error', 'silent'] },
  { key: 'aiRules', label: '自定义 AI 规则', category: 'agent', type: 'string' },

  // IM - DingTalk
  { key: 'imDingTalkAutoConnect', label: '钉钉自动连接', category: 'im', type: 'boolean' },
  { key: 'imDingTalkClientId', label: '钉钉 AppKey', category: 'im', type: 'string' },
  { key: 'imDingTalkClientSecret', label: '钉钉 AppSecret', category: 'im', type: 'string' },
  // IM - Feishu
  { key: 'imFeishuAutoConnect', label: '飞书自动连接', category: 'im', type: 'boolean' },
  { key: 'imFeishuAppId', label: '飞书 App ID', category: 'im', type: 'string' },
  { key: 'imFeishuAppSecret', label: '飞书 App Secret', category: 'im', type: 'string' },
  // IM - Slack
  { key: 'imSlackAutoConnect', label: 'Slack 自动连接', category: 'im', type: 'boolean' },
  { key: 'imSlackBotToken', label: 'Slack Bot Token', category: 'im', type: 'string' },
  { key: 'imSlackAppToken', label: 'Slack App Token', category: 'im', type: 'string' },
  // IM - Telegram
  { key: 'imTelegramAutoConnect', label: 'Telegram 自动连接', category: 'im', type: 'boolean' },
  { key: 'imTelegramBotToken', label: 'Telegram Bot Token', category: 'im', type: 'string' },
  // IM - WeCom
  { key: 'imWeComAutoConnect', label: '企业微信自动连接', category: 'im', type: 'boolean' },
  { key: 'imWeComBotId', label: '企业微信 Bot ID', category: 'im', type: 'string' },
  { key: 'imWeComSecret', label: '企业微信长连接密钥', category: 'im', type: 'string' },
  // IM - 通用
  { key: 'imExecutionMode', label: 'IM Agent 执行模式', category: 'im', type: 'string', options: ['strict', 'relaxed', 'free'] },

  // Gateway
  { key: 'gatewayAutoStart', label: '网关自动启动', category: 'gateway', type: 'boolean' },
  { key: 'gatewayPort', label: '网关端口', category: 'gateway', type: 'number' },
  { key: 'gatewayHost', label: '网关监听地址', category: 'gateway', type: 'string' },

  // Proxy
  { key: 'proxySettings.enabled', label: '代理启用', category: 'proxy', type: 'boolean' },
  { key: 'proxySettings.url', label: '代理地址', category: 'proxy', type: 'string' },

  // Knowledge
  { key: 'knowledgeSettings', label: '知识库设置', category: 'knowledge', type: 'object' },

  // Email
  { key: 'emailAccounts', label: '邮箱账户', category: 'email', type: 'array', readonly: true },

  // Calendar
  { key: 'calendarAccounts', label: '日历账户', category: 'calendar', type: 'array', readonly: true },

  // Readonly
  { key: 'aiProfiles', label: 'AI 模型配置', category: 'agent', type: 'array', readonly: true },
  { key: 'sshSessions', label: 'SSH 会话', category: 'agent', type: 'array', readonly: true },
  { key: 'mcpServers', label: 'MCP 服务器', category: 'mcp', type: 'array' },
]

const CONFIG_MAP = new Map(CONFIG_REGISTRY.map(m => [m.key, m]))

// ==================== 入口 ====================

export async function executeConfigTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  _executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'config_list':
      return listConfig(args)
    case 'config_get':
      return getConfig(args)
    case 'config_set':
      return setConfig(args)
    case 'im_connect':
      return connectIM(args)
    case 'email_verify':
      return verifyEmail(args)
    case 'email_account_add':
      return addEmailAccount(args)
    case 'email_account_delete':
      return deleteEmailAccount(args)
    case 'calendar_verify':
      return verifyCalendar(args)
    case 'calendar_account_add':
      return addCalendarAccount(args)
    case 'calendar_account_delete':
      return deleteCalendarAccount(args)
    default:
      return { success: false, output: '', error: `未知的配置工具: ${toolName}` }
  }
}

// ==================== config_list ====================

function listConfig(args: Record<string, unknown>): ToolResult {
  const category = (args.category as string) || 'all'
  const items = category === 'all'
    ? CONFIG_REGISTRY
    : CONFIG_REGISTRY.filter(m => m.category === category)

  if (items.length === 0) {
    return { success: true, output: `没有找到分类 "${category}" 的配置项。可用分类: ui, terminal, agent, im, gateway, proxy, mcp, knowledge` }
  }

  const config = getConfigService()
  const grouped = new Map<ConfigCategory, ConfigMeta[]>()
  for (const item of items) {
    const list = grouped.get(item.category) || []
    list.push(item)
    grouped.set(item.category, list)
  }

  const categoryLabels: Record<ConfigCategory, string> = {
    ui: '界面',
    terminal: '终端',
    agent: 'AI Agent',
    im: 'IM 渠道',
    email: '邮箱',
    calendar: '日历',
    gateway: '网关',
    proxy: '代理',
    mcp: 'MCP 服务器',
    knowledge: '知识库',
  }

  const sections: string[] = []
  for (const [cat, metas] of grouped) {
    const lines: string[] = []
    for (const m of metas) {
      if (m.key === 'emailAccounts') {
        lines.push(formatEmailAccountsSummary(config))
        continue
      }
      if (m.key === 'calendarAccounts') {
        lines.push(formatCalendarAccountsSummary(config))
        continue
      }
      const sensitive = isSensitiveKey(m.key)
      const display = sensitive
        ? (resolveConfigValue(config, m.key) ? '_(已配置)_' : '_(未配置)_')
        : formatValue(resolveConfigValue(config, m.key), m)
      const flags = []
      if (m.readonly) flags.push('只读')
      if (sensitive) flags.push('敏感，只写')
      if (m.options) flags.push(`可选: ${m.options.join('/')}`)
      const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : ''
      lines.push(`  - **${m.label}** \`${m.key}\` = ${display}${flagStr}`)
    }
    sections.push(`### ${categoryLabels[cat]}\n${lines.join('\n')}`)
  }

  return { success: true, output: sections.join('\n\n') }
}

// ==================== config_get ====================

function getConfig(args: Record<string, unknown>): ToolResult {
  const key = args.key as string
  if (!key) return { success: false, output: '', error: '缺少 key 参数' }

  const meta = CONFIG_MAP.get(key)
  if (!meta) {
    return { success: false, output: '', error: `未知的配置项: "${key}"。使用 config_list 查看可用配置。` }
  }

  if (isSensitiveKey(meta.key)) {
    const config = getConfigService()
    const hasValue = !!resolveConfigValue(config, key)
    return { success: true, output: `**${meta.label}** (\`${key}\`) — 敏感配置，不可读取。当前状态: ${hasValue ? '已配置' : '未配置'}` }
  }

  const config = getConfigService()
  const val = resolveConfigValue(config, key)
  return { success: true, output: `**${meta.label}** (\`${key}\`) = ${formatValue(val, meta)}` }
}

// ==================== config_set ====================

function setConfig(args: Record<string, unknown>): ToolResult {
  const key = args.key as string
  const value = args.value
  if (!key) return { success: false, output: '', error: '缺少 key 参数' }
  if (value === undefined) return { success: false, output: '', error: '缺少 value 参数' }

  const meta = CONFIG_MAP.get(key)
  if (!meta) {
    return { success: false, output: '', error: `未知的配置项: "${key}"。使用 config_list 查看可用配置。` }
  }
  if (meta.readonly) {
    return { success: false, output: '', error: `配置项 "${key}" 为只读，不允许通过此工具修改。` }
  }

  if (meta.options && !meta.options.includes(String(value))) {
    return { success: false, output: '', error: `"${value}" 不是 "${key}" 的有效值。可选: ${meta.options.join(', ')}` }
  }

  const config = getConfigService()

  try {
    applyConfigValue(config, key, value, meta.type)
    notifyFrontendConfigChanged()
    const newVal = resolveConfigValue(config, key)
    return { success: true, output: `✅ 已设置 **${meta.label}** (\`${key}\`) = ${formatValue(newVal, meta)}` }
  } catch (err) {
    return { success: false, output: '', error: `设置失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ==================== im_connect ====================

/** IM 平台连接元数据 */
interface IMPlatformDef {
  label: string
  credKeys: string[]
  autoConnectKey: string
  buildConfig: (config: ReturnType<typeof getConfigService>) => Record<string, unknown>
  start: (imService: IMService, cfg: any) => Promise<{ success: boolean; error?: string }>
}

const IM_PLATFORMS: Record<string, IMPlatformDef> = {
  dingtalk: {
    label: '钉钉',
    credKeys: ['imDingTalkClientId', 'imDingTalkClientSecret'],
    autoConnectKey: 'imDingTalkAutoConnect',
    buildConfig: (c) => ({ enabled: true, clientId: c.get('imDingTalkClientId'), clientSecret: c.get('imDingTalkClientSecret') }),
    start: (im, cfg) => im.startDingTalk(cfg),
  },
  feishu: {
    label: '飞书',
    credKeys: ['imFeishuAppId', 'imFeishuAppSecret'],
    autoConnectKey: 'imFeishuAutoConnect',
    buildConfig: (c) => ({ enabled: true, appId: c.get('imFeishuAppId'), appSecret: c.get('imFeishuAppSecret') }),
    start: (im, cfg) => im.startFeishu(cfg),
  },
  slack: {
    label: 'Slack',
    credKeys: ['imSlackBotToken', 'imSlackAppToken'],
    autoConnectKey: 'imSlackAutoConnect',
    buildConfig: (c) => ({ enabled: true, botToken: c.get('imSlackBotToken'), appToken: c.get('imSlackAppToken') }),
    start: (im, cfg) => im.startSlack(cfg),
  },
  telegram: {
    label: 'Telegram',
    credKeys: ['imTelegramBotToken'],
    autoConnectKey: 'imTelegramAutoConnect',
    buildConfig: (c) => ({ enabled: true, botToken: c.get('imTelegramBotToken') }),
    start: (im, cfg) => im.startTelegram(cfg),
  },
  wecom: {
    label: '企业微信',
    credKeys: ['imWeComBotId', 'imWeComSecret'],
    autoConnectKey: 'imWeComAutoConnect',
    buildConfig: (c) => ({
      enabled: true,
      botId: c.get('imWeComBotId'),
      secret: c.get('imWeComSecret'),
    }),
    start: (im, cfg) => im.startWeCom(cfg),
  },
}

async function connectIM(args: Record<string, unknown>): Promise<ToolResult> {
  const platform = args.platform as string
  if (!platform) return { success: false, output: '', error: '缺少 platform 参数' }

  const def = IM_PLATFORMS[platform]
  if (!def) {
    return { success: false, output: '', error: `不支持的平台: "${platform}"。支持: ${Object.keys(IM_PLATFORMS).join(', ')}` }
  }

  const config = getConfigService()
  const missing = def.credKeys.filter(k => !config.get(k as any))
  if (missing.length > 0) {
    return { success: false, output: '', error: `${def.label}凭证未配置。请先用 config_set 设置: ${missing.join(', ')}` }
  }

  try {
    const imService = getIMService()
    const imConfig = def.buildConfig(config)
    const result = await def.start(imService, imConfig)

    if (result.success) {
      config.set(def.autoConnectKey as any, true)
      notifyFrontendConfigChanged()
      return { success: true, output: `✅ ${def.label} 连接成功，已开启自动连接。` }
    } else {
      return { success: false, output: '', error: `${def.label} 连接失败: ${result.error}` }
    }
  } catch (err) {
    return { success: false, output: '', error: `连接异常: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ==================== email_verify ====================

async function verifyEmail(args: Record<string, unknown>): Promise<ToolResult> {
  const config = getConfigService()
  const accounts = (config.get('emailAccounts' as any) || []) as Array<{
    id: string; name: string; email: string; provider: string;
    imapHost?: string; imapPort?: number; rejectUnauthorized?: boolean
  }>

  if (accounts.length === 0) {
    return { success: true, output: '未配置任何邮箱账户。用户可在「设置 → 邮箱」中添加。' }
  }

  const targetId = (args.accountId as string | undefined)?.trim() || undefined
  const toVerify = targetId
    ? accounts.filter(a => a.id === targetId)
    : accounts

  if (targetId && toVerify.length === 0) {
    return { success: false, output: '', error: `未找到 ID 为 "${targetId}" 的邮箱账户` }
  }

  const results = await Promise.allSettled(toVerify.map(a => verifySingleEmail(a)))
  const output = results.map(r => r.status === 'fulfilled' ? r.value : `❌ 验证异常: ${(r as PromiseRejectedResult).reason}`).join('\n\n')

  return { success: true, output }
}

async function verifySingleEmail(account: {
  id: string; name: string; email: string; provider: string;
  imapHost?: string; imapPort?: number; rejectUnauthorized?: boolean
}, providedPassword?: string): Promise<string> {
  const password = providedPassword || await getEmailCredential(account.id)
  if (!password) {
    return `**${account.name}** (${account.email}) — ❌ 未找到保存的密码，需重新编辑并输入密码`
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null
  try {
    const serverConfig = getEmailServerConfig(account.provider || 'gmail', {
      imapHost: account.imapHost,
      imapPort: account.imapPort
    })

    const { ImapFlow } = await import('imapflow')
    client = new ImapFlow({
      host: serverConfig.imapHost,
      port: serverConfig.imapPort,
      secure: true,
      auth: { user: account.email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: account.rejectUnauthorized !== false }
    })

    await client.connect()
    return `**${account.name}** (${account.email}) — ✅ 连接正常`
  } catch (error) {
    const msg = error instanceof Error ? error.message : '连接失败'
    return `**${account.name}** (${account.email}) — ❌ ${msg}`
  } finally {
    try { await client?.logout() } catch { /* ignore */ }
  }
}

// ==================== calendar_verify ====================

async function verifyCalendar(args: Record<string, unknown>): Promise<ToolResult> {
  const config = getConfigService()
  const accounts = (config.get('calendarAccounts' as any) || []) as Array<{
    id: string; name: string; username: string; provider: string; serverUrl?: string
  }>

  if (accounts.length === 0) {
    return { success: true, output: '未配置任何日历账户。用户可在「设置 → 日历」中添加。' }
  }

  const targetId = (args.accountId as string | undefined)?.trim() || undefined
  const toVerify = targetId
    ? accounts.filter(a => a.id === targetId)
    : accounts

  if (targetId && toVerify.length === 0) {
    return { success: false, output: '', error: `未找到 ID 为 "${targetId}" 的日历账户` }
  }

  const results = await Promise.allSettled(toVerify.map(a => verifySingleCalendar(a)))
  const output = results.map(r => r.status === 'fulfilled' ? r.value : `❌ 验证异常: ${(r as PromiseRejectedResult).reason}`).join('\n\n')

  return { success: true, output }
}

async function verifySingleCalendar(account: {
  id: string; name: string; username: string; provider: string; serverUrl?: string
}, providedPassword?: string): Promise<string> {
  const password = providedPassword || await getCalendarCredential(account.id)
  if (!password) {
    return `**${account.name}** (${account.username}) — ❌ 未找到保存的密码，需重新编辑并输入密码`
  }

  try {
    const serverConfig = getCalendarServerConfig(account.provider, account.serverUrl)
    const serverUrl = serverConfig.serverUrl

    const tsdav = await import('tsdav')
    const client = new tsdav.DAVClient({
      serverUrl,
      credentials: { username: account.username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })

    await client.login()
    const calendars = await client.fetchCalendars()
    return `**${account.name}** (${account.username}) — ✅ 连接正常，找到 ${calendars.length} 个日历`
  } catch (error) {
    const msg = error instanceof Error ? error.message : '连接失败'
    return `**${account.name}** (${account.username}) — ❌ ${msg}`
  }
}

// ==================== email_account_add ====================

async function addEmailAccount(args: Record<string, unknown>): Promise<ToolResult> {
  const name = argStr(args, 'name')
  const email = argStr(args, 'email')
  const provider = argStr(args, 'provider')
  const password = argStr(args, 'password')

  if (!name || !email || !provider || !password) {
    return { success: false, output: '', error: '缺少必填参数: name, email, provider, password' }
  }

  const validProviders = ['gmail', 'outlook', 'qq', '163', 'custom']
  if (!validProviders.includes(provider)) {
    return { success: false, output: '', error: `不支持的服务商: "${provider}"。可选: ${validProviders.join(', ')}` }
  }

  if (provider === 'custom' && (!args.imapHost || !args.smtpHost)) {
    return { success: false, output: '', error: '自定义服务器需要提供 imapHost 和 smtpHost' }
  }

  const config = getConfigService()
  const accounts = (config.get('emailAccounts' as any) || []) as any[]

  if (accounts.some((a: any) => a.email === email)) {
    return { success: false, output: '', error: `邮箱 ${email} 已存在，请先删除后重新添加` }
  }

  const accountId = uuidv4()
  const newAccount: Record<string, unknown> = {
    id: accountId,
    name,
    email,
    provider,
    authType: 'password',
    createdAt: Date.now()
  }

  if (provider === 'custom') {
    newAccount.imapHost = args.imapHost
    newAccount.imapPort = args.imapPort || 993
    newAccount.smtpHost = args.smtpHost
    newAccount.smtpPort = args.smtpPort || 465
    newAccount.smtpSecure = args.smtpSecure !== false
  }

  // 先验证连接
  const verifyResult = await verifySingleEmail({
    id: accountId, name, email, provider,
    imapHost: newAccount.imapHost as string,
    imapPort: newAccount.imapPort as number,
    rejectUnauthorized: true
  }, password)

  if (verifyResult.includes('❌')) {
    return { success: false, output: '', error: `连接验证失败，账户未添加。\n${verifyResult}` }
  }

  // 验证通过，保存
  newAccount.lastTestStatus = 'success'
  newAccount.lastTestTime = Date.now()
  accounts.push(newAccount)
  config.set('emailAccounts' as any, accounts as any)
  await setEmailCredential(accountId, password)
  syncEmailAccountsToSkill(accounts)
  notifyFrontendConfigChanged()

  return { success: true, output: `✅ 邮箱账户已添加并验证通过。\n\n- **名称**: ${name}\n- **邮箱**: ${email}\n- **服务商**: ${PROVIDER_LABELS[provider] || provider}\n- **ID**: \`${accountId}\`` }
}

// ==================== email_account_delete ====================

async function deleteEmailAccount(args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = argStr(args, 'accountId')
  if (!accountId) {
    return { success: false, output: '', error: '缺少 accountId 参数' }
  }

  const config = getConfigService()
  const accounts = (config.get('emailAccounts' as any) || []) as any[]
  const account = accounts.find((a: any) => a.id === accountId)

  if (!account) {
    return { success: false, output: '', error: `未找到 ID 为 "${accountId}" 的邮箱账户` }
  }

  const remaining = accounts.filter((a: any) => a.id !== accountId)
  config.set('emailAccounts' as any, remaining as any)
  await deleteEmailCredential(accountId)
  syncEmailAccountsToSkill(remaining)
  notifyFrontendConfigChanged()

  return { success: true, output: `✅ 已删除邮箱账户 **${account.name}** (${account.email})` }
}

// ==================== calendar_account_add ====================

async function addCalendarAccount(args: Record<string, unknown>): Promise<ToolResult> {
  const name = argStr(args, 'name')
  const username = argStr(args, 'username')
  const provider = argStr(args, 'provider')
  const password = argStr(args, 'password')

  if (!name || !username || !provider || !password) {
    return { success: false, output: '', error: '缺少必填参数: name, username, provider, password' }
  }

  const validProviders = ['google', 'icloud', 'outlook', 'wecom', 'caldav']
  if (!validProviders.includes(provider)) {
    return { success: false, output: '', error: `不支持的服务商: "${provider}"。可选: ${validProviders.join(', ')}` }
  }

  if (provider === 'caldav' && !args.serverUrl) {
    return { success: false, output: '', error: '自定义 CalDAV 需要提供 serverUrl' }
  }

  const config = getConfigService()
  const accounts = (config.get('calendarAccounts' as any) || []) as any[]

  if (accounts.some((a: any) => a.username === username && a.provider === provider)) {
    return { success: false, output: '', error: `该服务商下用户 ${username} 已存在，请先删除后重新添加` }
  }

  const accountId = uuidv4()
  const serverUrl = argStr(args, 'serverUrl')

  if (serverUrl && !serverUrl.startsWith('https://') && !serverUrl.startsWith('http://')) {
    return { success: false, output: '', error: 'serverUrl 必须以 https:// 或 http:// 开头' }
  }

  // 先验证连接
  const verifyResult = await verifySingleCalendar(
    { id: accountId, name, username, provider, serverUrl },
    password
  )

  if (verifyResult.includes('❌')) {
    return { success: false, output: '', error: `连接验证失败，账户未添加。\n${verifyResult}` }
  }

  const newAccount: Record<string, unknown> = {
    id: accountId,
    name,
    username,
    provider,
    serverUrl,
    lastTestStatus: 'success',
    lastTestTime: Date.now(),
    createdAt: Date.now()
  }

  accounts.push(newAccount)
  config.set('calendarAccounts' as any, accounts as any)
  await setCalendarCredential(accountId, password)
  syncCalendarAccountsToSkill(accounts)
  notifyFrontendConfigChanged()

  return { success: true, output: `✅ 日历账户已添加并验证通过。\n\n- **名称**: ${name}\n- **用户名**: ${username}\n- **服务商**: ${PROVIDER_LABELS[provider] || provider}\n- **ID**: \`${accountId}\`` }
}

// ==================== calendar_account_delete ====================

async function deleteCalendarAccount(args: Record<string, unknown>): Promise<ToolResult> {
  const accountId = argStr(args, 'accountId')
  if (!accountId) {
    return { success: false, output: '', error: '缺少 accountId 参数' }
  }

  const config = getConfigService()
  const accounts = (config.get('calendarAccounts' as any) || []) as any[]
  const account = accounts.find((a: any) => a.id === accountId)

  if (!account) {
    return { success: false, output: '', error: `未找到 ID 为 "${accountId}" 的日历账户` }
  }

  const remaining = accounts.filter((a: any) => a.id !== accountId)
  config.set('calendarAccounts' as any, remaining as any)
  await deleteCalendarCredential(accountId)
  syncCalendarAccountsToSkill(remaining)
  notifyFrontendConfigChanged()

  return { success: true, output: `✅ 已删除日历账户 **${account.name}** (${account.username})` }
}

// ==================== 参数辅助 ====================

function argStr(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v.trim() : ''
}

// ==================== 同步到后端技能 ====================

function syncEmailAccountsToSkill(accounts: any[]): void {
  try {
    const { setEmailAccounts } = require('../email/executor')
    setEmailAccounts(accounts)
  } catch { /* skill may not be loaded */ }
}

function syncCalendarAccountsToSkill(accounts: any[]): void {
  try {
    const { setCalendarAccounts } = require('../calendar/executor')
    setCalendarAccounts(accounts)
  } catch { /* skill may not be loaded */ }
}

// ==================== 邮箱/日历摘要格式化 ====================

const PROVIDER_LABELS: Record<string, string> = {
  gmail: 'Gmail', outlook: 'Outlook', qq: 'QQ邮箱', '163': '163邮箱', custom: '自定义',
  google: 'Google', icloud: 'iCloud', wecom: '企微', caldav: 'CalDAV'
}

function formatEmailAccountsSummary(config: ReturnType<typeof getConfigService>): string {
  const accounts = (config.get('emailAccounts' as any) || []) as Array<{
    id: string; name: string; email: string; provider: string; lastTestStatus?: string; lastTestTime?: number
  }>

  if (accounts.length === 0) {
    return '  - **邮箱账户** — _(未配置)_  提示用户在「设置 → 邮箱」中添加'
  }

  const lines = accounts.map(a => {
    const provider = PROVIDER_LABELS[a.provider] || a.provider
    const status = a.lastTestStatus === 'success' ? '✅'
      : a.lastTestStatus === 'failed' ? '❌'
      : '⚪'
    return `    - ${status} **${a.name}** \`${a.email}\` (${provider}) ID:\`${a.id}\``
  })

  return `  - **邮箱账户** — ${accounts.length} 个已配置（可用 \`email_verify\` 验证连接）\n${lines.join('\n')}`
}

function formatCalendarAccountsSummary(config: ReturnType<typeof getConfigService>): string {
  const accounts = (config.get('calendarAccounts' as any) || []) as Array<{
    id: string; name: string; username: string; provider: string; lastTestStatus?: string; lastTestTime?: number
  }>

  if (accounts.length === 0) {
    return '  - **日历账户** — _(未配置)_  提示用户在「设置 → 日历」中添加'
  }

  const lines = accounts.map(a => {
    const provider = PROVIDER_LABELS[a.provider] || a.provider
    const status = a.lastTestStatus === 'success' ? '✅'
      : a.lastTestStatus === 'failed' ? '❌'
      : '⚪'
    return `    - ${status} **${a.name}** \`${a.username}\` (${provider}) ID:\`${a.id}\``
  })

  return `  - **日历账户** — ${accounts.length} 个已配置（可用 \`calendar_verify\` 验证连接）\n${lines.join('\n')}`
}

// ==================== 辅助函数 ====================

/** 解析点分路径读取配置值 */
function resolveConfigValue(config: ReturnType<typeof getConfigService>, key: string): unknown {
  const parts = key.split('.')
  if (parts.length === 1) {
    return config.get(key as any)
  }
  const root = config.get(parts[0] as any)
  if (root == null || typeof root !== 'object') return undefined
  return (root as Record<string, unknown>)[parts[1]]
}

/** 写入配置值（支持点分路径） */
function applyConfigValue(
  config: ReturnType<typeof getConfigService>,
  key: string,
  value: unknown,
  expectedType: string
): void {
  const coerced = coerceValue(value, expectedType)
  const parts = key.split('.')
  if (parts.length === 1) {
    config.set(key as any, coerced as any)
  } else {
    const existing = config.get(parts[0] as any)
    const root = (existing != null && typeof existing === 'object') ? { ...existing as Record<string, unknown> } : {}
    root[parts[1]] = coerced
    config.set(parts[0] as any, root as any)
  }
}

/** 类型转换 */
function coerceValue(value: unknown, expectedType: string): unknown {
  switch (expectedType) {
    case 'number': {
      const n = Number(value)
      if (isNaN(n)) throw new Error(`无法转换为数字: "${value}"`)
      return n
    }
    case 'boolean':
      if (typeof value === 'boolean') return value
      if (value === 'true' || value === '1') return true
      if (value === 'false' || value === '0') return false
      throw new Error(`无法转换为布尔值: "${value}"`)
    case 'string':
      return String(value)
    default:
      return value
  }
}

/** 格式化显示值（脱敏处理） */
function formatValue(val: unknown, _meta: ConfigMeta): string {
  if (val === undefined || val === null || val === '') return '_(未设置)_'

  if (typeof val === 'object') {
    if (Array.isArray(val)) return `[${val.length} 项]`
    return `\`${JSON.stringify(val)}\``
  }

  return `\`${String(val)}\``
}

function isSensitiveKey(key: string): boolean {
  return /secret|token|password|key|passphrase/i.test(key) && !/autoconnect/i.test(key)
}

/** 通知前端配置已变更，触发 loadConfig() 刷新 */
export function notifyFrontendConfigChanged(): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('config:changed')
      }
    }
  } catch (err) {
    log.warn('Failed to notify frontend:', err)
  }
}
