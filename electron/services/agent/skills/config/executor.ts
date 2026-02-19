/**
 * 旗鱼配置管理技能 - 执行器
 */

import { getConfigService } from '../../../config.service'
import { getIMService } from '../../../im/im.service'
import { BrowserWindow } from 'electron'
import type { ToolResult, ToolExecutorConfig, AgentConfig } from '../../tools/types'

// ==================== 配置项元数据 ====================

type ConfigCategory = 'ui' | 'terminal' | 'agent' | 'im' | 'gateway' | 'proxy' | 'mcp' | 'knowledge'

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
  { key: 'imWeComCorpId', label: '企业微信 Corp ID', category: 'im', type: 'string' },
  { key: 'imWeComCorpSecret', label: '企业微信 Corp Secret', category: 'im', type: 'string' },
  { key: 'imWeComAgentId', label: '企业微信 Agent ID', category: 'im', type: 'number' },
  { key: 'imWeComToken', label: '企业微信回调 Token', category: 'im', type: 'string' },
  { key: 'imWeComEncodingAESKey', label: '企业微信回调加密密钥', category: 'im', type: 'string' },
  { key: 'imWeComCallbackPort', label: '企业微信回调端口', category: 'im', type: 'number' },
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
    gateway: '网关',
    proxy: '代理',
    mcp: 'MCP 服务器',
    knowledge: '知识库',
  }

  const sections: string[] = []
  for (const [cat, metas] of grouped) {
    const lines = metas.map(m => {
      const sensitive = isSensitiveKey(m.key)
      const display = sensitive
        ? (resolveConfigValue(config, m.key) ? '_(已配置)_' : '_(未配置)_')
        : formatValue(resolveConfigValue(config, m.key), m)
      const flags = []
      if (m.readonly) flags.push('只读')
      if (sensitive) flags.push('敏感，只写')
      if (m.options) flags.push(`可选: ${m.options.join('/')}`)
      const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : ''
      return `  - **${m.label}** \`${m.key}\` = ${display}${flagStr}`
    })
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
  start: (imService: ReturnType<typeof getIMService>, cfg: any) => Promise<{ success: boolean; error?: string }>
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
    credKeys: ['imWeComCorpId', 'imWeComCorpSecret', 'imWeComAgentId', 'imWeComToken', 'imWeComEncodingAESKey'],
    autoConnectKey: 'imWeComAutoConnect',
    buildConfig: (c) => ({
      enabled: true,
      corpId: c.get('imWeComCorpId'),
      corpSecret: c.get('imWeComCorpSecret'),
      agentId: c.get('imWeComAgentId'),
      token: c.get('imWeComToken'),
      encodingAESKey: c.get('imWeComEncodingAESKey'),
      callbackPort: c.get('imWeComCallbackPort') || 3722,
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
function notifyFrontendConfigChanged(): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('config:changed')
      }
    }
  } catch (err) {
    console.warn('[ConfigSkill] Failed to notify frontend:', err)
  }
}
