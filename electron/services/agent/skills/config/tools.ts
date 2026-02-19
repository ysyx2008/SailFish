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

返回按分类整理的配置清单（界面、终端、AI Agent、IM 渠道、网关等），
每项标注是否可直接修改或需要用户确认。`,
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['all', 'ui', 'terminal', 'agent', 'im', 'gateway', 'proxy', 'mcp', 'knowledge'],
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
  }
]
