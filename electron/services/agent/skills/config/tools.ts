/**
 * 旗鱼配置管理技能 - 工具定义
 */

import type { ToolDefinition } from '../../tools'

export const configTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'config_list',
      description: `列出所有可管理的旗鱼配置项及其当前值。

返回按分类整理的配置清单（界面、终端、AI Agent、IM 渠道、邮箱、日历、网关等），
每项标注是否可直接修改或需要用户确认。
邮箱和日历账户会显示已配置的账户列表、服务商和当前连接状态。`,
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['all', 'ui', 'terminal', 'agent', 'im', 'email', 'calendar', 'gateway', 'proxy', 'mcp', 'knowledge'],
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

支持的配置 key 见 config_list 的输出。`,
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
      description: `测试 IM 渠道连接。读取已保存的凭证并尝试连接指定平台。

连接成功后会自动开启自动连接（autoConnect），下次启动时自动连接。
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
    }
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
    }
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
    }
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
    }
  }
]
