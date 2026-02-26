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
      description: `通过引导式对话生成并写入 Agent 个性定义。

**使用流程**:
1. 先调用 personality_get 读取当前状态
2. 与用户对话，了解他们期望的沟通风格、价值观、态度和禁忌
3. 生成结构化个性文本，用 personality_preview 预览
4. 用户确认后再调用本工具正式写入

**个性文本格式建议**（不强制，但推荐结构化）:
- 沟通风格：直接/委婉、详细/简洁、正式/随意等
- 价值观：效率优先/质量优先、保守/创新等
- 态度：是否敢于质疑、遇到分歧怎么处理
- 禁忌：哪些事情绝对不做

写入后立即生效，下一轮对话将使用新个性。`,
      parameters: {
        type: 'object',
        properties: {
          personality_text: {
            type: 'string',
            description: '个性定义文本（Markdown 格式，最多 1000 字符）'
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
