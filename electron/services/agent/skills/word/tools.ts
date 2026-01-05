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
5. image - 图片（使用 image_path 参数）
6. page_break - 分页符
7. toc - 目录（自动根据标题生成）
8. hyperlink - 超链接（使用 url 参数）
9. bookmark - 书签锚点（使用 bookmark_name 参数）
10. comment - 带批注的段落（使用 comment_text/comment_author 参数）

**样式选项**（可选）：
- font: 字体名称（如"黑体"、"仿宋"、"Arial"）
- size: 字号（磅）
- bold: 粗体
- italic: 斜体
- underline: 下划线
- color: 文字颜色（十六进制，如"FF0000"红色、"0000FF"蓝色）
- highlight: 高亮背景色（如"yellow"、"cyan"）
- align: 对齐方式（left=左对齐, center=居中, right=右对齐, justify=两端对齐）
- indent: 首行缩进（字符数，0=顶格，2=缩进两字）

**公文格式示例**：
- 一级标题"一、总体要求"：font="黑体", size=16, indent=0
- 二级标题"（一）提高认识"：font="楷体", size=16, bold=true, indent=0
- 正文段落：font="仿宋", size=16, indent=2
- 重点文字：color="FF0000", bold=true`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          type: {
            type: 'string',
            enum: ['paragraph', 'heading', 'list', 'table', 'image', 'page_break', 'toc', 'hyperlink', 'bookmark', 'comment'],
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
          font: {
            type: 'string',
            description: '字体名称，如"黑体"、"仿宋"、"楷体"、"宋体"、"Arial"（可选）'
          },
          size: {
            type: 'number',
            description: '字号（磅，可选）。常用：三号=16，四号=14，小四=12，五号=10.5'
          },
          bold: {
            type: 'boolean',
            description: '是否粗体（可选）'
          },
          italic: {
            type: 'boolean',
            description: '是否斜体（可选）'
          },
          underline: {
            type: 'boolean',
            description: '是否下划线（可选）'
          },
          color: {
            type: 'string',
            description: '文字颜色，十六进制（可选，如"FF0000"红色、"0000FF"蓝色、"000000"黑色）'
          },
          highlight: {
            type: 'string',
            description: '高亮背景色（可选，如"yellow"、"cyan"、"green"、"magenta"）'
          },
          align: {
            type: 'string',
            enum: ['left', 'center', 'right', 'justify'],
            description: '对齐方式（可选，默认 left 左对齐）'
          },
          indent: {
            type: 'number',
            description: '首行缩进字符数（可选，0=顶格，2=缩进两字符）'
          },
          image_path: {
            type: 'string',
            description: '图片文件路径（仅 type=image 时必填）'
          },
          image_width: {
            type: 'number',
            description: '图片宽度（像素，可选，默认保持原始尺寸）'
          },
          image_height: {
            type: 'number',
            description: '图片高度（像素，可选，默认保持原始尺寸）'
          },
          url: {
            type: 'string',
            description: '超链接URL（仅 type=hyperlink 时必填，如 "https://example.com"）'
          },
          bookmark_name: {
            type: 'string',
            description: '书签名称（仅 type=bookmark 时必填，用于创建文档内跳转锚点）'
          },
          comment_text: {
            type: 'string',
            description: '批注内容（仅 type=comment 时必填）'
          },
          comment_author: {
            type: 'string',
            description: '批注作者（仅 type=comment 时使用，可选）'
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
  {
    type: 'function',
    function: {
      name: 'word_set_page',
      description: `设置 Word 文档的页面属性（页眉、页脚、页码）。

**功能**：
- 设置页眉文字
- 设置页脚文字
- 添加页码（支持多种格式）

**注意**：需要先用 word_open 打开文档，设置后需要 word_save 保存。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          header: {
            type: 'string',
            description: '页眉文字（可选）'
          },
          footer: {
            type: 'string',
            description: '页脚文字（可选）'
          },
          page_number: {
            type: 'boolean',
            description: '是否添加页码（可选，默认 false）'
          },
          page_number_format: {
            type: 'string',
            enum: ['numeric', 'roman', 'letter'],
            description: '页码格式：numeric=阿拉伯数字(1,2,3)，roman=罗马数字(I,II,III)，letter=字母(A,B,C)，默认 numeric'
          },
          page_number_position: {
            type: 'string',
            enum: ['header', 'footer'],
            description: '页码位置：header=页眉，footer=页脚，默认 footer'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_track_changes',
      description: `启用或禁用 Word 文档的修订追踪功能。

**功能**：
- 启用后，所有后续修改都会被标记为修订
- 可以指定修订作者名称
- 适用于需要审阅和批注的协作文档

**注意**：需要先用 word_open 打开文档，设置后需要 word_save 保存。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          enabled: {
            type: 'boolean',
            description: '是否启用修订追踪（true=启用，false=禁用）'
          },
          author: {
            type: 'string',
            description: '修订作者名称（可选，默认为"审阅者"）'
          }
        },
        required: ['path', 'enabled']
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
- 对齐：<p align="right">右对齐</p>、<center>居中</center>

**预设样式**：
- simple：简洁风格（默认）
- formal：正式报告（宋体，首行缩进）
- tech：技术文档（微软雅黑）
- academic：学术论文（Times New Roman，双倍行距）
- official：公文格式（GB/T 9704-2012 党政机关公文格式）
- securities：证券公文（证券公司公文格式）

**公文格式特别说明**：
使用 official 或 securities 样式时，会自动识别中文编号并应用对应格式：
- "一、二、三、..." → 黑体
- "（一）（二）..." → 楷体加粗
- "1. 2. 3. ..." → 仿宋加粗
- "（1）（2）..." → 仿宋
- 普通段落 → 仿宋三号，首行缩进两字

**示例**：
word_from_markdown({
  path: "通知.docx",
  markdown: "# 关于加强信息安全的通知\\n\\n一、总体要求\\n\\n（一）提高思想认识。各部门要...",
  style: "official"
})

**对齐示例**（用于落款等右对齐内容）：
markdown 内容：
# 通知
正文内容...

<p align="right">
XX公司
2024年1月1日
</p>`,
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
            description: '样式模板名称：simple（默认）、formal、tech、academic、official（公文）、securities（证券公文），或自定义样式名'
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

