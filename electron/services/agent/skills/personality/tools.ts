/**
 * 个性定义技能 - 工具定义
 * SoulCraft 式引导对话，帮助用户定义 Agent 个性
 */

import type { ToolDefinition } from '../../tools'

export const personalityTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'personality_get',
      description: `读取当前 Agent 的个性配置，包括个性定义文本、MBTI 类型和名字。

在修改个性前必须先调用此工具，了解当前状态后再引导用户。`,
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'personality_craft',
      description: `写入 Agent 身份描述到 IDENTITY.md 文件。

**使用流程**:
1. 先调用 personality_get 读取当前状态
2. 与用户对话，了解他们期望的沟通风格、价值观、态度和禁忌
3. 生成身份描述文本，用 personality_preview 预览
4. 用户确认后再调用本工具正式写入

身份描述写入 IDENTITY.md，无长度限制，支持 Markdown 格式。
写入后立即生效，下一轮对话将使用新身份。`,
      parameters: {
        type: 'object',
        properties: {
          personality_text: {
            type: 'string',
            description: '身份描述文本（Markdown 格式，无长度限制），将写入 IDENTITY.md'
          },
          name: {
            type: 'string',
            description: 'Agent 名字（可选，不填则不修改，最多 20 字符）'
          },
          mbti: {
            type: 'string',
            enum: ['INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP', 'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP'],
            description: 'MBTI 性格类型（可选，不填则不修改，作为沟通风格的参考维度）'
          }
        },
        required: ['personality_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'personality_preview',
      description: `预览个性定义效果，不实际写入。

生成个性文本后先用此工具让用户预览，确认满意后再用 personality_craft 正式写入。
返回个性文本在 system prompt 中的呈现效果。`,
      parameters: {
        type: 'object',
        properties: {
          personality_text: {
            type: 'string',
            description: '要预览的个性定义文本'
          },
          name: {
            type: 'string',
            description: 'Agent 名字（可选）'
          },
          mbti: {
            type: 'string',
            enum: ['INTJ', 'INTP', 'ENTJ', 'ENTP', 'INFJ', 'INFP', 'ENFJ', 'ENFP', 'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ', 'ISTP', 'ISFP', 'ESTP', 'ESFP'],
            description: 'MBTI 性格类型（可选）'
          }
        },
        required: ['personality_text']
      }
    }
  }
]
