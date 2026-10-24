/**
 * 旗鱼配置管理技能 - 执行器
 */

import { v4 as uuidv4 } from 'uuid'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ConfigExecutor')
import { getConfigService, type McpServerConfig } from '../../../config.service'
import { getIMService, type IMService } from '../../../im/im.service'
import {
  getEmailCredential, setEmailCredential, deleteEmailCredential,
  getCalendarCredential, setCalendarCredential, deleteCalendarCredential
} from '../../../credential.service'
import { BrowserWindow } from 'electron'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'
import { getServerConfig as getEmailServerConfig } from '../email/session'
import { getServerConfig as getCalendarServerConfig } from '../calendar/session'
import {
  executeAiProfileAction,
  formatAiProfilesDetail,
  formatAiProfilesSummary,
  type AiProfileTestFn,
} from './ai-profiles'
import {
  executeSshSessionAction,
  formatSessionGroupsSummary,
  formatSshSessionsDetail,
  formatSshSessionsSummary,
} from './ssh-sessions'
import type { AiProfile } from '@shared/types'
import { isApprovalMode } from '@shared/types'
import { persistSharedApproval, sharedApprovalFromConfig, storedFromImApproval } from '../../../im/approval'
import { updateSettings as applyWebSearchSettings } from '../../../web-search/index'
import {
  executeWebSearchSettingsAction,
  formatWebSearchDetail,
  formatWebSearchSummary,
  type WebSearchSettingsStore,
} from './web-search-settings'

// ==================== 配置项元数据 ====================

type ConfigCategory = 'ui' | 'terminal' | 'agent' | 'im' | 'email' | 'calendar' | 'gateway' | 'proxy' | 'mcp' | 'knowledge' | 'webSearch'

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
  { key: 'agentOnboardingShown', label: '诞生引导已展示', category: 'agent', type: 'boolean' },
  { key: 'agentDebugMode', label: '调试模式', category: 'agent', type: 'boolean' },
  { key: 'logLevel', label: '日志级别', category: 'agent', type: 'string', options: ['debug', 'info', 'warn', 'error', 'silent'] },
  { key: 'aiRules', label: '自定义 AI 规则', category: 'agent', type: 'string' },
  { key: 'proactiveCompact', label: '主动压缩上下文', category: 'agent', type: 'string', options: ['more', 'balanced', 'less', 'off'] },

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
  { key: 'imExecutionMode', label: 'IM Agent 执行模式', category: 'im', type: 'string', options: ['strict', 'relaxed', 'autoReview', 'free'] },

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
  { key: 'sshSessions', label: 'SSH 主机', category: 'agent', type: 'array', readonly: true },
  { key: 'sessionGroups', label: '会话分组', category: 'agent', type: 'array', readonly: true },
  /** 仅整体展示；增删改须用 config_mcp_server_* 工具，禁止 config_set 覆盖列表 */
  { key: 'mcpServers', label: 'MCP 连接器', category: 'mcp', type: 'array', readonly: true },

  /** 只展示；换服务商、填密钥、改档位用 config_web_search，禁止整表覆盖 */
  { key: 'webSearchSettings', label: '联网搜索', category: 'webSearch', type: 'object', readonly: true },
]

const CONFIG_MAP = new Map(CONFIG_REGISTRY.map(m => [m.key, m]))

/**
 * 改这些会改规则、执行方式、网关或渠道密钥。写入前走现有的用户确认。
 * 名单是配置键本身，不按名字里的词来猜。
 */
const CONFIRM_BEFORE_SET = new Set([
  'aiRules',
  'imExecutionMode',
  'gatewayHost',
  'gatewayAutoStart',
  'imDingTalkClientSecret',
  'imFeishuAppSecret',
  'imSlackBotToken',
  'imSlackAppToken',
  'imTelegramBotToken',
  'imWeComSecret',
])

// ==================== 入口 ====================

export async function executeConfigTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  _toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'config_list':
      return listConfig(args)
    case 'config_get':
      return getConfig(args)
    case 'config_set':
      return setConfig(args, _toolCallId, executor)
    case 'config_mcp_server_add':
      return addMcpServerConfig(args, executor)
    case 'config_mcp_server_update':
      return updateMcpServerConfig(args, executor)
    case 'config_mcp_server_delete':
      return deleteMcpServerConfig(args, executor)
    case 'config_ai_profile':
      return runAiProfileAndNotify(args, executor)
    case 'config_ssh_session':
      return runSshSessionAndNotify(args)
    case 'config_web_search':
      return runWebSearchAndNotify(args)
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
    return { success: true, output: `没有找到分类 "${category}" 的配置项。可用分类: ui, terminal, agent, im, gateway, proxy, mcp, knowledge, webSearch` }
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
    mcp: 'MCP 连接器',
    knowledge: '知识库',
    webSearch: '联网搜索',
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
      if (m.key === 'mcpServers') {
        lines.push(formatMcpServersSummary(config))
        continue
      }
      if (m.key === 'aiProfiles') {
        lines.push(formatAiProfilesSummary(config))
        continue
      }
      if (m.key === 'sshSessions') {
        lines.push(formatSshSessionsSummary(config))
        continue
      }
      if (m.key === 'sessionGroups') {
        lines.push(formatSessionGroupsSummary(config))
        continue
      }
      if (m.key === 'webSearchSettings') {
        lines.push(formatWebSearchSummary(webSearchStore(config)))
        continue
      }
      const sensitive = isSensitiveKey(m.key)
      const raw = resolveConfigValue(config, m.key)
      const shown = m.key === 'imExecutionMode'
        ? sharedApprovalFromConfig(config.get('executionMode'), config.get('autoApprovalReview'))
        : raw
      const display = sensitive
        ? (raw ? '_(已配置)_' : '_(未配置)_')
        : formatValue(shown, m)
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
  const val = key === 'imExecutionMode'
    ? sharedApprovalFromConfig(config.get('executionMode'), config.get('autoApprovalReview'))
    : resolveConfigValue(config, key)
  if (key === 'mcpServers') {
    return { success: true, output: `**${meta.label}** (\`${key}\`)\n${formatMcpServersDetail(config)}` }
  }
  if (key === 'aiProfiles') {
    return { success: true, output: `**${meta.label}** (\`${key}\`)\n${formatAiProfilesDetail(config)}` }
  }
  if (key === 'sshSessions') {
    return { success: true, output: `**${meta.label}** (\`${key}\`)\n${formatSshSessionsDetail(config)}` }
  }
  if (key === 'webSearchSettings') {
    return { success: true, output: `**${meta.label}** (\`${key}\`)\n${formatWebSearchDetail(webSearchStore(config))}` }
  }
  return { success: true, output: `**${meta.label}** (\`${key}\`) = ${formatValue(val, meta)}` }
}

/**
 * 联络输入框那一档和 IM 运行模式是同一个。
 * 替我审批记成宽松加开关，不能把 autoReview 写进只认三档的执行模式。
 */
function applyImExecutionMode(
  config: ReturnType<typeof getConfigService>,
  value: unknown,
  meta: ConfigMeta,
): ToolResult {
  if (!isApprovalMode(value)) {
    return { success: false, output: '', error: `"${String(value)}" 不是 "imExecutionMode" 的有效值。可选: strict, relaxed, autoReview, free` }
  }
  try {
    persistSharedApproval((key, storedValue) => {
      applyConfigValue(config, key, storedValue, typeof storedValue === 'boolean' ? 'boolean' : 'string')
    }, value)
    try {
      const stored = storedFromImApproval(value)
      const im = getIMService()
      im.setExecutionMode(stored.executionMode)
      im.setAutoApprovalReview(stored.autoApprovalReview)
    } catch (err) {
      log.warn('IM 执行模式已写入，运行中的 IM 没跟上:', err)
    }
    notifyFrontendConfigChanged()
    const shown = value
    return { success: true, output: `✅ 已设置 **${meta.label}** (\`${meta.key}\`) = ${formatValue(shown, meta)}` }
  } catch (err) {
    return { success: false, output: '', error: `设置失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ==================== config_set ====================

async function setConfig(
  args: Record<string, unknown>,
  toolCallId: string,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const key = args.key as string
  const value = args.value
  if (!key) return { success: false, output: '', error: '缺少 key 参数' }
  if (value === undefined) return { success: false, output: '', error: '缺少 value 参数' }

  const meta = CONFIG_MAP.get(key)
  if (!meta) {
    return { success: false, output: '', error: `未知的配置项: "${key}"。使用 config_list 查看可用配置。` }
  }
  if (meta.readonly) {
    const hint = key === 'mcpServers'
      ? ' 请改用 config_mcp_server_add、config_mcp_server_update、config_mcp_server_delete。'
      : key === 'aiProfiles'
        ? ' 请改用 config_ai_profile（action=add/update/delete）。'
        : key === 'sshSessions' || key === 'sessionGroups'
          ? ' 请改用 config_ssh_session（action=add/update/delete）。'
        : key === 'webSearchSettings'
          ? ' 请改用 config_web_search。'
        : key === 'emailAccounts'
          ? ' 请改用 email_account_add、email_account_delete。'
          : key === 'calendarAccounts'
            ? ' 请改用 calendar_account_add、calendar_account_delete。'
            : ''
    return { success: false, output: '', error: `配置项 "${key}" 为只读，不允许通过此工具修改。${hint}` }
  }

  if (meta.options && !meta.options.includes(String(value))) {
    return { success: false, output: '', error: `"${value}" 不是 "${key}" 的有效值。可选: ${meta.options.join(', ')}` }
  }

  if (CONFIRM_BEFORE_SET.has(key)) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'config_set',
      { key, value },
      'dangerous',
      meta.label,
    )
    if (!approved) {
      return { success: false, output: '', error: '未确认，这项配置没有改' }
    }
  }

  const config = getConfigService()

  if (key === 'imExecutionMode') {
    return applyImExecutionMode(config, value, meta)
  }

  try {
    applyConfigValue(config, key, value, meta.type)
    notifyFrontendConfigChanged()
    const newVal = resolveConfigValue(config, key)
    return { success: true, output: `✅ 已设置 **${meta.label}** (\`${key}\`) = ${formatValue(newVal, meta)}` }
  } catch (err) {
    return { success: false, output: '', error: `设置失败: ${err instanceof Error ? err.message : String(err)}` }
  }
}

// ==================== MCP 连接器（合并写入，禁止整表覆盖）====================

function formatMcpServersSummary(config: ReturnType<typeof getConfigService>): string {
  const servers = config.getMcpServers()
  if (servers.length === 0) {
    return '  - **MCP 连接器** — _(未配置)_  使用 `config_mcp_server_add` 添加'
  }
  const lines = servers.map(s => {
    const endpoint = s.transport === 'stdio'
      ? (s.command ? `\`${s.command}\`` : '_(无 command)_')
      : (s.url ? `\`${s.url}\`` : '_(无 url)_')
    const on = s.enabled ? '启用' : '禁用'
    return `    - **${s.name}** \`${s.id}\` · ${s.transport} · ${on} · ${endpoint}`
  })
  return `  - **MCP 连接器** — ${servers.length} 个（勿用 config_set 整表覆盖；用 config_mcp_server_add 追加）\n${lines.join('\n')}`
}

/** 给模型看的一条连接器。env 与 headers 只报项数，不把密钥写进对话。 */
export function formatMcpServerDetail(server: McpServerConfig, index: number): string {
  const parts = [
    `${index + 1}. **${server.name}**`,
    `- id: \`${server.id}\``,
    `- transport: \`${server.transport}\``,
    `- enabled: \`${server.enabled}\``,
  ]
  if (server.transport === 'stdio') {
    if (server.command) parts.push(`- command: \`${server.command}\``)
    if (server.args?.length) parts.push(`- args: \`${JSON.stringify(server.args)}\``)
    if (server.cwd) parts.push(`- cwd: \`${server.cwd}\``)
    const envCount = server.env ? Object.keys(server.env).length : 0
    if (envCount > 0) parts.push(`- env: _(已配置 ${envCount} 项)_`)
  } else {
    if (server.url) parts.push(`- url: \`${server.url}\``)
    const headerCount = server.headers ? Object.keys(server.headers).length : 0
    if (headerCount > 0) parts.push(`- headers: _(已配置 ${headerCount} 项)_`)
  }
  return parts.join('\n')
}

function formatMcpServersDetail(config: ReturnType<typeof getConfigService>): string {
  const servers = config.getMcpServers()
  if (servers.length === 0) {
    return '_(未配置)_\n\n使用 `config_mcp_server_add` 添加连接器。'
  }
  const lines = servers.map((server, index) => formatMcpServerDetail(server, index))
  return `共 ${servers.length} 个：\n\n${lines.join('\n\n')}\n\n增删改请用 \`config_mcp_server_add\` / \`config_mcp_server_update\` / \`config_mcp_server_delete\`，勿用 \`config_set\` 写入整表。`
}

function parseOptionalStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined
  if (Array.isArray(v)) return v.map(x => String(x))
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown
      return Array.isArray(p) ? p.map(x => String(x)) : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

function parseOptionalStringRecord(v: unknown): Record<string, string> | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o: Record<string, string> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = typeof val === 'string' ? val : String(val)
    }
    return Object.keys(o).length > 0 ? o : undefined
  }
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v) as unknown
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
        return parseOptionalStringRecord(p)
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

// 支持的 transport 类型；'http' 走 MCP Streamable HTTP，'sse' 已被规范标记 deprecated 仅保留兼容
type McpTransport = 'stdio' | 'sse' | 'http'
const VALID_TRANSPORTS: readonly McpTransport[] = ['stdio', 'sse', 'http']
const isValidTransport = (t: string): t is McpTransport =>
  (VALID_TRANSPORTS as readonly string[]).includes(t)
// 'sse' 和 'http' 都通过 url + headers 描述端点，验证逻辑相同
const isRemoteTransport = (t: McpTransport) => t === 'sse' || t === 'http'

function mcpConnectionParamsChanged(a: McpServerConfig, b: McpServerConfig): boolean {
  const sameRecord = (x?: Record<string, string>, y?: Record<string, string>) =>
    JSON.stringify(x || {}) === JSON.stringify(y || {})
  const sameArgs = (x?: string[], y?: string[]) =>
    JSON.stringify(x || []) === JSON.stringify(y || [])
  return a.transport !== b.transport
    || a.command !== b.command
    || a.cwd !== b.cwd
    || a.url !== b.url
    || !sameArgs(a.args, b.args)
    || !sameRecord(a.env, b.env)
    || !sameRecord(a.headers, b.headers)
}

async function dropMcpRuntime(
  executor: ToolExecutorConfig,
  serverId: string
): Promise<void> {
  try {
    if (executor.mcpService?.isConnected(serverId)) {
      await executor.mcpService.disconnect(serverId)
    }
  } catch (err) {
    log.warn('Disconnect MCP after disable/delete failed:', err)
  }
  executor.mcpToolSession?.unloadServer(serverId)
}

async function syncMcpConnection(
  executor: ToolExecutorConfig,
  server: McpServerConfig,
  previous?: McpServerConfig
): Promise<string> {
  if (!server.enabled) {
    await dropMcpRuntime(executor, server.id)
    return '已禁用，未连接。'
  }
  if (!executor.mcpService) {
    return '配置已保存。当前无法连接（MCP 未就绪），稍后可用 skill load 重试，无需重启。'
  }
  const already = executor.mcpService.isConnected(server.id)
  const paramsChanged = previous ? mcpConnectionParamsChanged(previous, server) : true
  if (already && !paramsChanged) {
    executor.mcpService.patchConnectedConfig(server)
    return '已更新配置（连接未中断）。本会话用 skill load 加载后即可调用，无需重启。'
  }
  try {
    await executor.mcpService.connect(server)
    const status = executor.mcpService.resolveServerRef(server.id)
    const n = status?.toolCount ?? 0
    return `已连接，发现 ${n} 个工具。本会话用 skill load mcp:${server.id} 加载后即可调用，无需重启。`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `⚠️ 配置已保存，但连接失败：${msg}。可稍后 skill load mcp:${server.id} 重试，无需重启。`
  }
}

async function addMcpServerConfig(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const name = argStr(args, 'name')
  const transport = args.transport as string
  if (!name) return { success: false, output: '', error: '缺少 name 参数' }
  if (!isValidTransport(transport)) {
    return { success: false, output: '', error: 'transport 须为 stdio、sse 或 http' }
  }

  const command = argStr(args, 'command')
  const url = argStr(args, 'url')
  if (transport === 'stdio' && !command) {
    return { success: false, output: '', error: 'stdio 模式需要 command' }
  }
  if (isRemoteTransport(transport) && !url) {
    return { success: false, output: '', error: `${transport} 模式需要 url` }
  }

  const enabled = args.enabled === false ? false : true
  const whenToUseRaw = argStr(args, 'whenToUse')
  const whenToUse = whenToUseRaw ? whenToUseRaw.trim().slice(0, 200) : ''
  if (enabled && !whenToUse) {
    return {
      success: false,
      output: '',
      error: '启用 MCP 时必须提供非空 whenToUse（何时该用的一句话；请先与用户确认文案再写入）'
    }
  }

  const id = argStr(args, 'id') || uuidv4()
  const config = getConfigService()
  const servers = config.getMcpServers()
  if (servers.some(s => s.id === id)) {
    return { success: false, output: '', error: `已存在 id 为 "${id}" 的 MCP 连接器` }
  }

  const remote = isRemoteTransport(transport)
  const server: McpServerConfig = {
    id,
    name,
    enabled,
    transport,
    command: transport === 'stdio' ? command : undefined,
    args: parseOptionalStringArray(args.args),
    env: parseOptionalStringRecord(args.env),
    cwd: argStr(args, 'cwd') || undefined,
    url: remote ? url : undefined,
    headers: remote ? parseOptionalStringRecord(args.headers) : undefined,
    whenToUse: whenToUse || undefined,
  }

  config.addMcpServer(server)
  notifyFrontendConfigChanged()
  const n = config.getMcpServers().length
  const connectNote = await syncMcpConnection(executor, server)
  return {
    success: true,
    output: `✅ 已添加 MCP 连接器 **${name}**（id: \`${id}\`，${transport}）。当前共 ${n} 个。\n${connectNote}`,
  }
}

async function updateMcpServerConfig(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const serverId = argStr(args, 'serverId') || argStr(args, 'id')
  if (!serverId) return { success: false, output: '', error: '缺少 serverId（或 id）参数' }

  const config = getConfigService()
  const existing = config.getMcpServers().find(s => s.id === serverId)
  if (!existing) {
    return { success: false, output: '', error: `未找到 id 为 "${serverId}" 的 MCP 连接器` }
  }

  const transport = (args.transport as string) || existing.transport
  if (!isValidTransport(transport)) {
    return { success: false, output: '', error: 'transport 须为 stdio、sse 或 http' }
  }

  const name = argStr(args, 'name') || existing.name
  const enabled = typeof args.enabled === 'boolean' ? args.enabled : existing.enabled

  let command = existing.command
  let url = existing.url
  if (transport === 'stdio') {
    command = args.command !== undefined ? argStr(args, 'command') : existing.command
  } else {
    url = args.url !== undefined ? argStr(args, 'url') : existing.url
  }

  if (transport === 'stdio' && !command) {
    return { success: false, output: '', error: 'stdio 模式需要 command' }
  }
  if (isRemoteTransport(transport) && !url) {
    return { success: false, output: '', error: `${transport} 模式需要 url` }
  }

  const remote = isRemoteTransport(transport)
  let whenToUse = existing.whenToUse
  if (args.whenToUse !== undefined) {
    const w = argStr(args, 'whenToUse').trim().slice(0, 200)
    whenToUse = w || undefined
  }
  const effectiveWhen = (whenToUse || '').trim()
  const enabling = enabled && !existing.enabled
  // 新启用、或显式写入空 whenToUse：启用态必须非空。已启用的旧配置仅改连接字段可不逼补。
  if (enabled && !effectiveWhen && (enabling || args.whenToUse !== undefined)) {
    return {
      success: false,
      output: '',
      error: '启用 MCP 时 whenToUse 不能为空。请提供与用户确认过的使用说明'
    }
  }

  const merged: McpServerConfig = {
    id: serverId,
    name,
    enabled,
    transport,
    command: transport === 'stdio' ? command : undefined,
    args: args.args !== undefined ? parseOptionalStringArray(args.args) : existing.args,
    env: args.env !== undefined ? parseOptionalStringRecord(args.env) : existing.env,
    cwd: args.cwd !== undefined ? (argStr(args, 'cwd') || undefined) : existing.cwd,
    url: remote ? url : undefined,
    headers: remote
      ? (args.headers !== undefined ? parseOptionalStringRecord(args.headers) : existing.headers)
      : undefined,
    whenToUse: args.whenToUse !== undefined
      ? (effectiveWhen || undefined)
      : existing.whenToUse,
  }

  config.updateMcpServer(merged)
  notifyFrontendConfigChanged()
  const connectNote = await syncMcpConnection(executor, merged, existing)
  return { success: true, output: `✅ 已更新 MCP 连接器 **${name}**（\`${serverId}\`）。\n${connectNote}` }
}

async function deleteMcpServerConfig(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const serverId = argStr(args, 'serverId') || argStr(args, 'id')
  if (!serverId) return { success: false, output: '', error: '缺少 serverId（或 id）参数' }

  const config = getConfigService()
  const servers = config.getMcpServers()
  const found = servers.find(s => s.id === serverId)
  if (!found) {
    return { success: false, output: '', error: `未找到 id 为 "${serverId}" 的 MCP 连接器` }
  }

  await dropMcpRuntime(executor, serverId)

  config.deleteMcpServer(serverId)
  notifyFrontendConfigChanged()
  const remaining = config.getMcpServers().length
  return {
    success: true,
    output: `✅ 已删除 MCP 连接器 **${found.name}**（\`${serverId}\`）。剩余 ${remaining} 个。`,
  }
}

function resolveAiProfileTestFn(executor: ToolExecutorConfig): AiProfileTestFn | undefined {
  const ai = executor.getAiService?.()
  if (!ai?.testApiKey) return undefined
  return (profile: Partial<AiProfile>) => ai.testApiKey(profile)
}

async function runAiProfileAndNotify(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const result = await executeAiProfileAction(getConfigService(), args, {
    testFn: resolveAiProfileTestFn(executor),
    inUseProfileId: executor.getActiveProfileId?.(),
  })
  if (result.success) notifyFrontendConfigChanged()
  return result
}

function webSearchStore(config: ReturnType<typeof getConfigService>): WebSearchSettingsStore {
  return {
    getWebSearchSettings: () => config.get('webSearchSettings'),
    setWebSearchSettings: (settings) => config.set('webSearchSettings', settings),
    getAiProfiles: () => config.getAiProfiles(),
    getActiveAiProfile: () => config.getActiveAiProfile(),
  }
}

function runWebSearchAndNotify(args: Record<string, unknown>): ToolResult {
  const config = getConfigService()
  const store = webSearchStore(config)
  const result = executeWebSearchSettingsAction(store, args)
  if (result.success) {
    const saved = config.get('webSearchSettings')
    if (saved) applyWebSearchSettings(saved)
    notifyFrontendConfigChanged()
  }
  return result
}

function runSshSessionAndNotify(args: Record<string, unknown>): ToolResult {
  const config = getConfigService()
  const result = executeSshSessionAction(config, args)
  if (result.success) {
    notifyFrontendConfigChanged({
      sshSessions: config.getSshSessions().map(({ password: _p, passphrase: _k, ...rest }) => rest),
      sessionGroups: [...config.getSessionGroups()],
    })
  }
  return result
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

/** 通知前端配置已变更。主机增删改时带上最新列表，界面立刻换，不用等整份配置重载。 */
export function notifyFrontendConfigChanged(payload?: {
  sshSessions?: unknown
  sessionGroups?: unknown
}): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('config:changed', payload)
      }
    }
  } catch (err) {
    log.warn('Failed to notify frontend:', err)
  }
}
