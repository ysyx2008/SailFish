/**
 * 本地联系人技能 - 工具定义
 * 认人用：姓名、别名、单位、角色、邮箱 / 电话 / IM。
 */
import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

const listMeta = {
  parallelizable: true,
  phase: 'idle' as const,
  contextBudget: { toolResult: 'clearable' as const },
}

const channelSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['email', 'phone', 'im'], description: '渠道类型' },
    value: { type: 'string', description: '邮箱、电话或 IM 标识' },
    platform: { type: 'string', description: '仅 im：渠道名，如 wecom / dingtalk / feishu' },
    label: { type: 'string', description: '可选说明，如「工作邮箱」' },
  },
  required: ['kind', 'value'],
}

export const contactTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'contact_search',
      description: `按名字、别名、单位、角色或邮箱/电话/IM 查找本地联系人（CONTACTS.json）。`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '姓名、别名、单位、角色或联系方式' },
        },
        required: ['query'],
      },
    },
    _meta: listMeta,
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'contact_list',
      description: `列出全部本地联系人。`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
    _meta: listMeta,
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'contact_add',
      description: `新增本地联系人。姓名或别名与已有联系人重合时不新建，返回已有记录。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '姓名或机构名（必填）' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: '别名、简称，如「沈总」',
          },
          kind: {
            type: 'string',
            enum: ['person', 'org'],
            description: '人还是机构，默认 person',
          },
          organization: { type: 'string', description: '单位' },
          role: { type: 'string', description: '角色或和用户的关系' },
          note: { type: 'string', description: '备注：关系与近况' },
          channels: {
            type: 'array',
            items: channelSchema,
            description: '邮箱、电话、IM',
          },
        },
        required: ['name'],
      },
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    },
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'contact_update',
      description: `更新已有联系人。

空字符串清空 organization / role / note。aliases 传入则整表替换，空数组清空；追加用 add_aliases。channels 同理，追加用 add_channels，按 kind+value 删用 remove_channels。
改名或改别名后若与别人重合，本次不写入。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '联系人 ID（从 contact_search / contact_list 获取）' },
          name: { type: 'string', description: '新姓名' },
          aliases: {
            type: 'array',
            items: { type: 'string' },
            description: '替换后的全部别名；空数组清空',
          },
          add_aliases: {
            type: 'array',
            items: { type: 'string' },
            description: '追加别名',
          },
          kind: { type: 'string', enum: ['person', 'org'] },
          organization: { type: 'string', description: '新单位；空字符串清空' },
          role: { type: 'string', description: '新角色；空字符串清空' },
          note: { type: 'string', description: '新备注，整段替换；空字符串清空' },
          channels: {
            type: 'array',
            items: channelSchema,
            description: '替换全部渠道；空数组清空',
          },
          add_channels: {
            type: 'array',
            items: channelSchema,
            description: '追加渠道，相同 kind+value 会去重',
          },
          remove_channels: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['email', 'phone', 'im'] },
                value: { type: 'string' },
              },
              required: ['kind', 'value'],
            },
            description: '按 kind + value 删除渠道',
          },
        },
        required: ['id'],
      },
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    },
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'contact_delete',
      description: `彻底删除一条本地联系人（不可恢复）。`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '联系人 ID' },
        },
        required: ['id'],
      },
    },
    _meta: {
      phase: 'idle',
      contextBudget: { toolResult: 'protected' },
      parallelizable: false,
    },
  } as ToolDefinitionWithMeta,
]

export const contactSkillContent = `## 本地联系人（contact 技能）

每人一条：姓名、别名、是人还是机构、单位、角色、邮箱 / 电话 / IM，外加一段备注（关系与近况）。只按用户或材料里出现过的信息填写。`
