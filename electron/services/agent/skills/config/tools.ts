/**
 * 旗鱼配置管理技能 - 工具定义
 */

import type { ToolDefinitionWithMeta } from '../../tools'
import { t } from '../../i18n'
import { getConfigService } from '../../../config.service'
import { aiProfileStreamHint } from './ai-profiles'
import { sshSessionStreamHint } from './ssh-sessions'

function lookupAiProfileName(id: string): string | undefined {
  try {
    const profile = getConfigService().getAiProfiles().find(p => p.id === id)
    const label = profile?.name?.trim() || profile?.model?.trim()
    return label || undefined
  } catch {
    return undefined
  }
}

function formatAiProfileStreamTitle(args: Record<string, unknown>): string {
  const action = typeof args.action === 'string' ? args.action : ''
  const key = action === 'add'
    ? 'config.ai_profile.add'
    : action === 'update'
      ? 'config.ai_profile.update'
      : action === 'delete'
        ? 'config.ai_profile.delete'
        : 'config.ai_profile.manage'
  const hint = aiProfileStreamHint(args, lookupAiProfileName)
  return hint ? `${t(key)}: ${hint}` : t(key)
}

function formatWebSearchStreamTitle(args: Record<string, unknown>): string {
  const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
  return provider ? `${t('config.web_search.manage')}: ${provider}` : t('config.web_search.manage')
}

function lookupSshSessionLabel(id: string): string | undefined {
  try {
    const session = getConfigService().getSshSessions().find(s => s.id === id)
    const label = session?.name?.trim() || session?.host?.trim()
    return label || undefined
  } catch {
    return undefined
  }
}

function formatSshSessionStreamTitle(args: Record<string, unknown>): string {
  const action = typeof args.action === 'string' ? args.action : ''
  const key = action === 'add'
    ? 'config.ssh_session.add'
    : action === 'update'
      ? 'config.ssh_session.update'
      : action === 'delete'
        ? 'config.ssh_session.delete'
        : 'config.ssh_session.manage'
  const hint = sshSessionStreamHint(args, lookupSshSessionLabel)
  return hint ? `${t(key)}: ${hint}` : t(key)
}

export const configTools: ToolDefinitionWithMeta[] = [
  {
    type: 'function',
    function: {
      name: 'config_list',
      description: `列出所有可管理的旗鱼配置项及其当前值。

返回按分类整理的配置清单（界面、终端、AI Agent、IM 渠道、邮箱、日历、网关、MCP 连接器等），
每项标注是否可直接修改或需要用户确认。
邮箱和日历账户会显示已配置的账户列表、服务商和当前连接状态。
AI 模型配置会列出名称、模型名、接口地址、是否已填 Key、是否当前默认；增删改用 config_ai_profile（不可用 config_set 整表覆盖）。
联网搜索会列出开没开、当前用的哪一家、各家密钥填了没有（不回显密钥；沿用模型密钥会标明）；换服务商、填密钥、改档位用 config_web_search（不可用 config_set 整表覆盖）。
SSH 主机会列出名称、地址、账号、分组、认证是否已填（不回显密码）；增删改用 config_ssh_session（不可用 config_set 整表覆盖）。
MCP 连接器列表可通过 config_mcp_server_add/update/delete 管理（不可用 config_set 整表覆盖）。`,
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['all', 'ui', 'terminal', 'agent', 'im', 'email', 'calendar', 'gateway', 'proxy', 'mcp', 'knowledge', 'webSearch'],
            description: '筛选配置分类，默认 all'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_get',
      description: `读取指定配置项的当前值。

支持的配置 key 见 config_list 的输出。
特殊用法：
- key="aiProfiles" 查看已配置的 AI 模型（名称、模型名、地址、Key 是否已填；不回显 Key）
- key="webSearchSettings" 查看联网搜索（开没开、当前服务商、各家密钥是否已填、档位；不回显密钥）
- key="sshSessions" 查看已配置的 SSH 主机（名称、地址、账号、分组、认证是否已填；不回显密码）
- key="mcpServers" 查看所有已配置的 MCP 连接器详情（id、transport、command/url 等）
在执行对应的 add/update/delete 前建议先用此工具了解现状。`,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '配置项 key，如 "language"、"uiTheme"、"terminalSettings" 等'
          }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_set',
      description: `修改旗鱼配置项。

**安全类配置**（界面语言、主题、终端字号等）直接生效。
**敏感类配置**（IM 凭证、网关、代理）也可设置，写入后建议用 im_connect 测试连接。

**AI 模型列表（aiProfiles）、SSH 主机（sshSessions）、MCP 连接器列表（mcpServers）和联网搜索（webSearchSettings）不可通过本工具整表写入**，否则会覆盖已有项。模型请用 \`config_ai_profile\`；主机请用 \`config_ssh_session\`；MCP 请用 \`config_mcp_server_add\` / \`config_mcp_server_update\` / \`config_mcp_server_delete\`；搜索请用 \`config_web_search\`。

常见用法：
- 切换语言: key="language", value="en-US"
- 修改主题: key="uiTheme", value="dark"
- 调整字号: key="terminalSettings.fontSize", value=16
- 设置 IM 凭证: key="imDingTalkClientId", value="your-client-id"
- 开启自动连接: key="imDingTalkAutoConnect", value=true`,
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: '配置项 key（支持点分路径如 "terminalSettings.fontSize"）'
          },
          value: {
            description: '要设置的值（类型需与配置项匹配）'
          }
        },
        required: ['key', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'im_connect',
      description: `激活 IM 渠道连接。读取已保存的凭证并尝试连接指定平台。

**典型工作流**：先用 config_set 写入凭证（AppKey/Token 等），再调用本工具激活连接。
连接成功后会自动开启自动连接（autoConnect），下次启动时自动重连。
如果凭证未配置，会返回缺少哪些字段。

**支持的平台**: dingtalk, feishu, slack, telegram, wecom`,
      parameters: {
        type: 'object',
        properties: {
          platform: {
            type: 'string',
            enum: ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom'],
            description: 'IM 平台名称'
          }
        },
        required: ['platform']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_verify',
      description: `验证邮箱账户连接。从系统密钥链读取已保存的密码，尝试连接 IMAP 服务器。

如果不指定 accountId，则验证所有已配置的邮箱账户。
返回每个账户的连接状态（成功/失败及原因）。`,
      parameters: {
        type: 'object',
        properties: {
          accountId: {
            type: 'string',
            description: '邮箱账户 ID（可选，不填则验证全部）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'email_account_add',
      description: `添加邮箱账户。密码将安全存储在系统密钥链中。
添加后自动验证连接，验证成功才算配置完成。

常见服务商的 IMAP/SMTP 配置会自动填充，自定义服务器需提供 imapHost/smtpHost。
建议用户使用应用专用密码（如 Gmail 应用密码、QQ 邮箱授权码），而非登录密码。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '显示名称，如"工作邮箱"' },
          email: { type: 'string', description: '邮箱地址' },
          provider: { type: 'string', enum: ['gmail', 'outlook', 'qq', '163', 'custom'], description: '邮箱服务商' },
          password: { type: 'string', description: '密码或应用专用密码' },
          imapHost: { type: 'string', description: 'IMAP 服务器地址（仅 custom 需要）' },
          imapPort: { type: 'number', description: 'IMAP 端口（仅 custom，默认 993）' },
          smtpHost: { type: 'string', description: 'SMTP 服务器地址（仅 custom 需要）' },
          smtpPort: { type: 'number', description: 'SMTP 端口（仅 custom，默认 465）' },
          smtpSecure: { type: 'boolean', description: 'SMTP 使用 SSL（仅 custom，默认 true）' }
        },
        required: ['name', 'email', 'provider', 'password']
      }
    },
    _meta: { allowedForSubAgent: false }
  },
  {
    type: 'function',
    function: {
      name: 'email_account_delete',
      description: '删除邮箱账户及其保存在系统密钥链中的凭据。删除前请与用户确认。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: '邮箱账户 ID（通过 config_list category=email 查看）' }
        },
        required: ['accountId']
      }
    },
    _meta: { allowedForSubAgent: false }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_verify',
      description: `验证日历账户连接。从系统密钥链读取已保存的密码，尝试连接 CalDAV 服务器。

如果不指定 accountId，则验证所有已配置的日历账户。
返回每个账户的连接状态（成功/失败及原因），以及发现的日历数量。`,
      parameters: {
        type: 'object',
        properties: {
          accountId: {
            type: 'string',
            description: '日历账户 ID（可选，不填则验证全部）'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_account_add',
      description: `添加日历账户（CalDAV 协议）。密码将安全存储在系统密钥链中。
添加后自动验证连接。

**企业微信**：密码需在「日程 → 同步至其他日历」中获取，每次使用需重新获取。
其他服务商使用账号密码或应用专用密码。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '显示名称，如"工作日历"' },
          username: { type: 'string', description: '用户名或邮箱' },
          provider: { type: 'string', enum: ['google', 'icloud', 'outlook', 'wecom', 'caldav'], description: '日历服务商' },
          password: { type: 'string', description: '密码' },
          serverUrl: { type: 'string', description: 'CalDAV 服务器地址（仅 caldav 需要）' }
        },
        required: ['name', 'username', 'provider', 'password']
      }
    },
    _meta: { allowedForSubAgent: false }
  },
  {
    type: 'function',
    function: {
      name: 'calendar_account_delete',
      description: '删除日历账户及其保存在系统密钥链中的凭据。删除前请与用户确认。',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string', description: '日历账户 ID（通过 config_list category=calendar 查看）' }
        },
        required: ['accountId']
      }
    },
    _meta: { allowedForSubAgent: false }
  },
  {
    type: 'function',
    function: {
      name: 'config_mcp_server_add',
      description: `向旗鱼追加一个 MCP 连接器配置（合并到现有列表，不会删除已有项）。

**stdio**：必须提供 command；可选 args（字符串数组）、env（键值对象）、cwd。
**http**（推荐，MCP Streamable HTTP 规范）：必须提供 url；可选 headers（键值对象，例如 \`{ "Authorization": "Bearer xxx" }\`）。
**sse**（已被规范标记为 deprecated，仅用于兼容旧连接器）：必须提供 url；可选 headers。

**whenToUse**（启用时必填）：一句「何时该用」说明，须先与用户确认再写入；禁止空着启用。

启用时保存后会立刻在后台连接，当前对话即可 \`skill load mcp:<id>\` 加载工具，**无需重启客户端**。连接失败不撤销配置，工具结果里会说明原因。

与 \`config_set\` 写入 mcpServers 不同，本工具只追加一条记录。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '显示名称' },
          transport: { type: 'string', enum: ['stdio', 'sse', 'http'], description: '传输方式：远程服务优先选 http' },
          enabled: { type: 'boolean', description: '是否启用，默认 true' },
          whenToUse: { type: 'string', description: '何时该用（给模型的一句话，≤200 字；启用时必填，须用户确认）' },
          id: { type: 'string', description: '连接器唯一 id，省略则自动生成 UUID' },
          command: { type: 'string', description: 'stdio：可执行文件或命令' },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'stdio：命令行参数列表'
          },
          env: { type: 'object', description: 'stdio：环境变量（字符串键值）' },
          cwd: { type: 'string', description: 'stdio：工作目录' },
          url: { type: 'string', description: 'sse / http：服务端 URL' },
          headers: { type: 'object', description: 'sse / http：HTTP 请求头（字符串键值），常用于 Bearer Token 鉴权' }
        },
        required: ['name', 'transport']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_mcp_server_update',
      description: `按 id 更新已有 MCP 连接器。未传入的字段保持原值（部分更新）。

切换 transport 时请同时提供对应模式下必填字段（stdio 需 command，sse / http 需 url）。
补齐或修改 whenToUse 时须先与用户确认文案。新启用（enabled→true）必须带非空 whenToUse。
启用态保存后会立刻连接（改连接参数会重连）；禁用则断开。无需重启。`,
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: '要更新的连接器 id（与 config_get key=mcpServers 中一致）' },
          name: { type: 'string', description: '显示名称' },
          transport: { type: 'string', enum: ['stdio', 'sse', 'http'] },
          enabled: { type: 'boolean', description: '启用/禁用该连接器，不需要删除后重建' },
          whenToUse: { type: 'string', description: '何时该用（确认后的一句话）' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object' },
          cwd: { type: 'string' },
          url: { type: 'string' },
          headers: { type: 'object' }
        },
        required: ['serverId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_mcp_server_delete',
      description: '按 id 删除 MCP 连接器配置；若当前已连接会先断开。删除前请与用户确认。',
      parameters: {
        type: 'object',
        properties: {
          serverId: { type: 'string', description: '要删除的连接器 id' }
        },
        required: ['serverId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_ai_profile',
      description: `管理旗鱼的 AI 模型配置（一条一条加/改/删，不会整表覆盖）。

**action=add**：追加一条。必填 name、apiUrl、model、apiKey。apiUrl 须为完整接口地址，不要猜供应商默认地址。
可选 proxy、contextLength（默认 128000）、maxOutputTokens、temperature、modelType（general/vision）、visionProfileId、apiFormat（auto/openai/anthropic）、setActive。
第一条自动成为默认；之后不抢当前默认，除非 setActive=true。保存后会试连，失败也先存。

**action=update**：按 profileId 部分更新。省略 apiKey 则保留原 Key。setActive=true 设为默认。保存后会试连。

**action=delete**：按 profileId 删除。不能删当前对话正在用的那条，也不能删它关联的视觉模型，也不能删最后一条。若其他模型把它当作视觉模型，先不要删——说明是谁、删了会解除关联，等用户同意后再带 confirmUnlink=true 删除。删除前请与用户确认。

Key 不会回显。`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'delete'], description: 'add 追加 / update 修改 / delete 删除' },
          profileId: { type: 'string', description: 'update/delete：要操作的模型 id' },
          name: { type: 'string', description: '显示名称，如"DeepSeek"' },
          apiUrl: { type: 'string', description: '完整 API 地址' },
          model: { type: 'string', description: '模型名，如 deepseek-chat' },
          apiKey: { type: 'string', description: 'API Key（写入后不回显；update 时省略则保留原 Key）' },
          proxy: { type: 'string', description: '代理地址（可选）' },
          contextLength: { type: 'number', description: '上下文长度，默认 128000' },
          maxOutputTokens: { type: 'number', description: '单次回复最大输出 token' },
          temperature: { type: 'number', description: '采样温度，省略则自动' },
          modelType: { type: 'string', enum: ['general', 'vision'], description: '模型类型，默认 general' },
          visionProfileId: { type: 'string', description: '关联的视觉模型 id（仅 general 有效）' },
          apiFormat: { type: 'string', enum: ['auto', 'openai', 'anthropic'], description: 'API 协议，默认 auto' },
          id: { type: 'string', description: 'add：唯一 id，省略则自动生成' },
          setActive: { type: 'boolean', description: '是否设为默认模型' },
          confirmUnlink: { type: 'boolean', description: 'delete：其他模型仍把它当作视觉模型时，用户同意解除关联后再标 true' }
        },
        required: ['action']
      }
    },
    _meta: {
      streamDisplay: {
        customRender: formatAiProfileStreamTitle
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_ssh_session',
      description: `管理已保存的 SSH 主机（一条一条加/改/删，不会整表覆盖）。

**add**：必填 host。可选 name（默认用 host）、port（默认 22）、username（默认 root）、password、privateKeyPath、passphrase、authType、group（组名，没有就新建）、encoding。
**update**：按 sessionId 或唯一 name 部分更新。省略的字段保持原样（改地址不必重填密码）。
**delete**：按 sessionId 或唯一 name 删除。删除前请与用户确认。

密码和密钥口令不回显。`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'delete'], description: 'add 追加 / update 修改 / delete 删除' },
          sessionId: { type: 'string', description: 'update/delete：主机 id（重名时必须用这个）' },
          name: { type: 'string', description: '显示名称' },
          host: { type: 'string', description: '主机地址' },
          port: { type: 'number', description: '端口，默认 22' },
          username: { type: 'string', description: '用户名，默认 root' },
          password: { type: 'string', description: '登录密码（写入后不回显；update 时省略则保留）' },
          privateKeyPath: { type: 'string', description: '私钥文件路径' },
          passphrase: { type: 'string', description: '私钥口令（写入后不回显）' },
          authType: { type: 'string', enum: ['password', 'privateKey'], description: '认证方式' },
          group: { type: 'string', description: '分组名；没有则新建。空字符串表示未分组' },
          encoding: { type: 'string', description: '终端编码，默认 utf-8' },
          id: { type: 'string', description: 'add：唯一 id，省略则自动生成' }
        },
        required: ['action']
      }
    },
    _meta: {
      allowedForSubAgent: false,
      streamDisplay: { customRender: formatSshSessionStreamTitle }
    }
  },
  {
    type: 'function',
    function: {
      name: 'config_web_search',
      description: `管理旗鱼的联网搜索（换当前服务商、开关、给某一家填或清掉密钥、改档位）。不会整表覆盖，改一家不影响其他家。不能新增或删除服务商。

**provider**：bocha（博查）/ zhipu（智谱）/ kimi（Kimi）/ tavily / jina / google。改密钥、档位或换当前使用的那家时必填。
**setCurrent=true**：把 provider 设为当前使用的搜索引擎。
**enabled**：联网搜索总开关。只想开关时可以不填 provider。搜索关着时，只换服务商不会自动打开。
**apiKey**：写入这家的搜索密钥。留空字符串表示清掉单独填的密钥（智谱、Kimi 会回到沿用模型密钥）。省略则保持原密钥。
**engine**：仅智谱。search_std / search_pro / search_pro_sogou / search_pro_quark。留空恢复默认 search_std。
**tier**：仅 Kimi。basic / pro。留空恢复默认 basic。
**cx**：仅 Google，搜索引擎编号。

密钥不回显。改完立刻生效，不用重启。`,
      parameters: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            enum: ['bocha', 'zhipu', 'kimi', 'tavily', 'jina', 'google'],
            description: '要改的服务商',
          },
          setCurrent: { type: 'boolean', description: '把这一家设为当前使用的搜索引擎' },
          enabled: { type: 'boolean', description: '联网搜索总开关' },
          apiKey: { type: 'string', description: '这家的搜索密钥。留空则清掉单独填的密钥。省略则不动。' },
          engine: { type: 'string', description: '智谱引擎：search_std / search_pro / search_pro_sogou / search_pro_quark' },
          tier: { type: 'string', enum: ['basic', 'pro'], description: 'Kimi 档位' },
          cx: { type: 'string', description: 'Google 搜索引擎编号' },
        },
      },
    },
    _meta: {
      streamDisplay: { customRender: formatWebSearchStreamTitle },
    },
  },
]
