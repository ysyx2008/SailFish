/**
 * Word 技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const wordTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'word_create',
      description: `创建一个新的 Word 文档并打开会话。

**注意**：
- 文件路径应以 .docx 结尾
- 创建后文档处于打开状态，可以添加内容
- 完成后请调用 word_save 保存，然后 word_close 关闭`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录），应以 .docx 结尾'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_open',
      description: `打开已存在的 Word 文档，建立会话。后续的读取和修改操作都在此会话中进行。

**注意**：
- 同一文件不能重复打开
- 打开后请及时操作，5 分钟无操作会自动关闭
- 完成后请调用 word_save 保存（如有修改），然后 word_close 关闭`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录）'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_read',
      description: `读取已打开的 Word 文档内容，返回 Markdown 格式的文本。

**返回内容**：
- 文档中的段落、标题、列表等内容
- 格式化为 Markdown 便于理解`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_add',
      description: `向已打开的 Word 文档添加内容。添加后需要调用 word_save 保存。

**支持的内容类型**：
1. paragraph - 普通段落
2. heading - 标题（level 1-6）
3. list - 列表（使用 items 参数）
4. table - 表格（使用 rows 参数，二维数组）

**样式选项**（可选）：
- bold: 粗体
- italic: 斜体
- size: 字号（磅）`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          type: {
            type: 'string',
            enum: ['paragraph', 'heading', 'list', 'table'],
            description: '内容类型'
          },
          content: {
            type: 'string',
            description: '文本内容（paragraph/heading 时使用）'
          },
          level: {
            type: 'number',
            description: '标题级别 1-6（仅 heading 类型时使用）'
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: '列表项（仅 list 类型时使用），字符串数组'
          },
          rows: {
            type: 'array',
            items: { type: 'array' },
            description: '表格数据，二维字符串数组（仅 table 类型时使用），第一行为表头，如 [["列1","列2"],["数据1","数据2"]]'
          },
          bold: {
            type: 'boolean',
            description: '是否粗体（可选）'
          },
          italic: {
            type: 'boolean',
            description: '是否斜体（可选）'
          },
          size: {
            type: 'number',
            description: '字号（磅，可选）'
          }
        },
        required: ['path', 'type']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_save',
      description: `保存已打开的 Word 文档的修改。

**注意**：
- 保存前会自动创建备份（带时间戳）
- 保存后会话仍然保持，可以继续操作`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_close',
      description: `关闭已打开的 Word 文档。

**注意**：
- 如果有未保存的修改，会提示是否丢弃
- 关闭后如需再次操作，需要重新 word_open`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          discard_changes: {
            type: 'boolean',
            description: '是否丢弃未保存的修改（默认 false，有未保存修改时会报错）'
          }
        },
        required: ['path']
      }
    }
  },
  // ========== 快速模式工具 ==========
  {
    type: 'function',
    function: {
      name: 'word_from_markdown',
      description: `【推荐】从 Markdown 内容快速生成 Word 文档。一次调用完成整个文档的创建。

**支持的 Markdown 语法**：
- 标题：# ## ### 等
- 段落：普通文本
- 列表：- 或 1. 2. 3.
- 表格：| 列1 | 列2 |
- 加粗：**文本**
- 斜体：*文本*
- 代码块：\`\`\`代码\`\`\`
- 引用：> 引用文本

**预设样式**：
- simple：简洁风格（默认）
- formal：正式报告（宋体，首行缩进）
- tech：技术文档（微软雅黑）
- academic：学术论文（Times New Roman，双倍行距）

**示例**：
word_from_markdown({
  path: "报告.docx",
  markdown: "# 标题\\n\\n正文内容",
  style: "formal"
})`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '输出文件路径（绝对路径或相对于当前目录）'
          },
          markdown: {
            type: 'string',
            description: 'Markdown 格式的文档内容'
          },
          style: {
            type: 'string',
            description: '样式模板名称：simple（默认）、formal、tech、academic，或自定义样式名'
          }
        },
        required: ['path', 'markdown']
      }
    }
  },
  // ========== 样式管理工具 ==========
  {
    type: 'function',
    function: {
      name: 'word_create_style',
      description: `创建自定义格式规范。支持两种方式：

1. **从样板文档提取**：上传一个已格式化好的 .docx 文件，自动提取样式
2. **从格式说明解析**：上传格式说明文档（PDF/Word/文本），AI 理解后生成样式

创建的样式会保存到知识库，可在后续生成文档时使用。`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '样式名称，用于后续引用'
          },
          from_template: {
            type: 'string',
            description: '样板文档路径（.docx），从中提取样式定义'
          },
          from_description: {
            type: 'string',
            description: '格式说明文档路径（PDF/Word/文本），AI 解析后生成样式'
          },
          set_as_default: {
            type: 'boolean',
            description: '是否设为默认样式'
          }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_list_styles',
      description: `列出所有可用的格式规范，包括预设样式和用户自定义样式。`,
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_set_default_style',
      description: `设置默认格式规范。后续生成文档时如不指定样式，将使用此默认样式。`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '样式名称（预设或自定义）'
          }
        },
        required: ['name']
      }
    }
  }
]

