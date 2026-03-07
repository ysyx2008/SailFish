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

身份描述写入 IDENTITY.md，最多 1000 字符，支持 Markdown 格式。
写入后立即生效，下一轮对话将使用新身份。`,
      parameters: {
        type: 'object',
        properties: {
          personality_text: {
            type: 'string',
            description: '身份描述文本（Markdown 格式，最多 1000 字符），将写入 IDENTITY.md'
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
  },
  {
    type: 'function',
    function: {
      name: 'soul_craft',
      description: `写入行为灵魂到 SOUL.md 文件。

SOUL.md 定义你的价值观、行为准则和相处方式——你怎么对待用户、你们之间有什么默契。
它会注入到"你的灵魂"段落中，每次对话都会读取。

三文件分工：
- IDENTITY.md = 你是谁（身份描述）
- SOUL.md = 你的价值观和行为准则（行为灵魂）
- USER.md = 用户是谁（用户画像）

最多 1000 字符，支持 Markdown 格式。`,
      parameters: {
        type: 'object',
        properties: {
          soul_text: {
            type: 'string',
            description: '行为灵魂文本（Markdown 格式，最多 1000 字符），将写入 SOUL.md'
          }
        },
        required: ['soul_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'user_craft',
      description: `写入用户画像到 USER.md 文件。

USER.md 记录你对用户的了解——称呼、职业、工作内容、沟通偏好等。
它会注入到"关于用户"段落中，每次对话都会读取，帮助你更好地为用户服务。

三文件分工：
- IDENTITY.md = 你是谁
- SOUL.md = 你的价值观和行为准则
- USER.md = 用户是谁

最多 1000 字符，支持 Markdown 格式。`,
      parameters: {
        type: 'object',
        properties: {
          user_text: {
            type: 'string',
            description: '用户画像文本（Markdown 格式，最多 1000 字符），将写入 USER.md'
          }
        },
        required: ['user_text']
      }
    }
  }
]
