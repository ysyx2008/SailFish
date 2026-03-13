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
      description: `读取 Word 文档内容，返回带段落索引的 Markdown 格式文本。

**功能**：
- 无需先 word_open，可直接读取 .docx 文件
- 返回带段落索引号 [0] [1] [2] ... 的内容，便于后续使用 word_modify_paragraph 或 word_delete_paragraph
- 识别标题、段落、列表、表格、图片等结构
- 保留粗体、斜体、链接等内联格式
- 如果文件已通过 word_open 打开，则读取会话中的内容

**示例**：
word_read({ path: "/path/to/doc.docx" })`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录），无需先打开'
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
11. footnote - 带脚注的段落（使用 footnote_text 参数，适用于学术论文和正式文档）

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
            enum: ['paragraph', 'heading', 'list', 'table', 'image', 'page_break', 'toc', 'hyperlink', 'bookmark', 'comment', 'footnote'],
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
          },
          footnote_text: {
            type: 'string',
            description: '脚注内容（仅 type=footnote 时必填，如"参见《公司法》第三十条"）'
          }
        },
        required: ['path', 'type']
      }
    }
  },
  // ========== 修改工具 ==========
  {
    type: 'function',
    function: {
      name: 'word_replace',
      description: `在 Word 文档中查找并替换文本，完整保留原始文档格式。

**功能**：
- 直接操作 .docx 文件，无需先 word_open/word_save/word_close
- 自动创建备份后替换
- 完整保留所有格式（字体、颜色、加粗、样式等）
- 支持全文查找替换，可选区分大小写
- 支持跨格式区域（Run）的文本匹配
- 返回替换的数量

**示例**：
word_replace({
  path: "/path/to/doc.docx",
  find: "旧文本",
  replace: "新文本"
})`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录），无需先打开'
          },
          find: {
            type: 'string',
            description: '要查找的文本'
          },
          replace: {
            type: 'string',
            description: '替换为的文本'
          },
          case_sensitive: {
            type: 'boolean',
            description: '是否区分大小写（可选，默认 false）'
          }
        },
        required: ['path', 'find', 'replace']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_modify_paragraph',
      description: `修改 Word 文档中指定段落的内容或样式，保留其他格式不变。

**功能**：
- 直接操作 .docx 文件，无需先 word_open/word_save/word_close
- 通过索引定位段落（从 0 开始，使用 word_read 查看索引）
- 可修改文本内容（保留原格式结构）
- 可修改样式（字体、字号、粗体等）
- 自动创建备份

**示例**：
word_modify_paragraph({
  path: "/path/to/doc.docx",
  index: 2,
  content: "新的段落内容",
  bold: true,
  font: "黑体",
  color: "FF0000"
})`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录），无需先打开'
          },
          index: {
            type: 'number',
            description: '段落索引（从 0 开始，使用 word_read 查看）'
          },
          content: {
            type: 'string',
            description: '新的段落内容（可选，不提供则只修改样式）'
          },
          font: {
            type: 'string',
            description: '字体名称（可选）'
          },
          size: {
            type: 'number',
            description: '字号（磅，可选）'
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
            description: '文字颜色，十六进制（可选，如"FF0000"红色、"00FF00"绿色、"0000FF"蓝色）'
          },
          align: {
            type: 'string',
            enum: ['left', 'center', 'right', 'justify'],
            description: '对齐方式（可选）'
          }
        },
        required: ['path', 'index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_delete_paragraph',
      description: `删除 Word 文档中指定的段落，保留其他内容和格式不变。

**功能**：
- 直接操作 .docx 文件，无需先 word_open/word_save/word_close
- 通过索引定位段落（从 0 开始，使用 word_read 查看索引）
- 删除后其他段落索引会变化
- 自动创建备份

**示例**：
word_delete_paragraph({
  path: "/path/to/doc.docx",
  index: 3
})`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录），无需先打开'
          },
          index: {
            type: 'number',
            description: '要删除的段落索引（从 0 开始）'
          }
        },
        required: ['path', 'index']
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
      description: `【推荐】从 Markdown 快速生成或重写 Word 文档。一次调用完成整个文档，效率远高于逐段 word_add。
如果目标文件已存在，会自动备份后覆盖——可用于"读取→修改→重写"的编辑场景。

**输入方式**：
- 直接传入 markdown：适合动态生成内容后立刻转 Word
- 传入 markdown_path：适合直接把本地 .md 文件转成 Word，不必重新生成全文
- markdown 和 markdown_path 二选一，不能同时传

**推荐工作流**：
1. 新建文档：直接调用，传入 Markdown 内容和样式
2. 编辑文档：先 word_read 获取内容 → 修改 Markdown → 调用本工具覆盖重写

**支持的 Markdown 语法**：
标题(# ## ###)、段落、列表(- 或 1.)、表格(| |)、加粗(**)、斜体(*)、代码块(\`\`\`)、引用(>)
特殊标签：<p>顶格段落</p>、<p align="right">右对齐</p>、<center>居中</center>

**预设样式**（每个样式包含正文、标题、表格、代码块、引用的完整主题）：
- simple：简洁风格（默认，灰色表头）
- formal：正式报告（宋体，蓝色表头+交替行色）
- tech：技术文档（微软雅黑，深蓝表头）
- academic：学术论文（Times New Roman，双倍行距）
- official：公文格式（GB/T 9704-2012，仿宋三号，A4+公文页边距）
- securities：证券公文（仿宋_GB2312，A4+公文页边距）
- meeting：会议纪要（仿宋三号，A4+公文页边距）
也可传入通过 word_create_style 创建的自定义样式名。

**公文格式特别说明**：
official/securities/meeting 会自动识别中文编号：一、→黑体 （一）→楷体加粗 1.→仿宋加粗 （1）→仿宋
主送机关用 <p> 包裹顶格，落款用 <p align="right"> 包裹，系统自动在落款前加空行。`,
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
          markdown_path: {
            type: 'string',
            description: '本地 Markdown 文件路径（.md/.markdown/.txt 等文本文件），绝对路径或相对于当前目录'
          },
          style: {
            type: 'string',
            description: '样式模板名称：simple（默认）、formal、tech、academic、official（公文）、securities（证券公文）、meeting（会议纪要），或自定义样式名'
          },
          page_size: {
            type: 'string',
            enum: ['a4', 'letter'],
            description: '纸张大小（可选）：a4（默认，中国标准）、letter（美国标准）。公文样式已内置 A4+标准页边距，无需额外指定'
          }
        },
        required: ['path']
      }
    }
  },
  // ========== 样式管理工具 ==========
  {
    type: 'function',
    function: {
      name: 'word_create_style',
      description: `创建自定义文档主题。用户可能用口语描述（如"标题用黑体二号居中，正文仿宋三号"），请翻译为 config。

**创建方式**：
1. 直接指定 config JSON
2. base + config：基于已有样式（如 official）修改部分属性
3. from_template：从 .docx 样板文件提取
4. from_description：从格式说明文档解析

创建的样式保存到知识库，后续 word_from_markdown 可直接使用。

**中文字号 → 磅值对照**：
初号=42, 小初=36, 一号=26, 小一=24, 二号=22, 小二=18, 三号=16, 小三=15, 四号=14, 小四=12, 五号=10.5, 小五=9

**config 属性**：
- font/fontAscii: 中文字体/西文字体
- fontSize: 正文字号（磅）
- lineSpacing: 行距倍数 | lineSpacingFixed: 固定行距（磅）
- firstLineIndent/firstLineIndentChars: 首行缩进
- headings: { 1: { font, fontAscii, size, bold, align }, 2: {...}, ... }
- numberingRules: 编号层级规则数组
- table: { headerBackground, headerTextColor, headerBold, headerAlign, alternatingColors, borderColor, borderSize, fontSize, font, fontAscii, cellPadding }
- codeBlock: { font, fontSize, background, color }
- blockquote: { borderColor, italic, color }

**示例**（用户说"标题黑体二号居中，正文宋体四号，表头蓝底白字"）：
config: { font:"宋体", fontSize:14, headings:{1:{font:"黑体",size:22,align:"center"}}, table:{headerBackground:"4472C4",headerTextColor:"FFFFFF"} }`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '样式名称，用于后续引用'
          },
          config: {
            type: 'object',
            description: '样式配置 JSON，可指定 font/fontAscii/fontSize/lineSpacing/headings 等属性'
          },
          base: {
            type: 'string',
            description: '基础样式名称（预设或自定义），新样式会在此基础上覆盖 config 中指定的属性'
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
      name: 'word_edit_style',
      description: `修改已有样式的部分属性（增量更新）。用户说"把一级标题改成黑体二号"就传 config: { headings: { 1: { font:"黑体", size:22 } } }。

- 对预设样式：自动复制为自定义副本后修改
- 未指定的属性保持不变
- 字号对照：初号42 小初36 一号26 小一24 二号22 小二18 三号16 小三15 四号14 小四12 五号10.5 小五9`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要编辑的样式名称'
          },
          config: {
            type: 'object',
            description: '要修改的配置属性（增量合并），如 { "fontSize": 14, "headings": { "1": { "size": 22 } } }'
          },
          new_name: {
            type: 'string',
            description: '重命名样式（可选）'
          }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'word_delete_style',
      description: `删除自定义样式。预设样式不能删除。如果删除的是默认样式，会自动清除默认设置。`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要删除的自定义样式名称'
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
  },
  // ========== 导出工具 ==========
  {
    type: 'function',
    function: {
      name: 'word_export_pdf',
      description: `将 Word 文档导出为 PDF。

**系统要求**：
- Windows：需要安装 Microsoft Word
- macOS：需要安装 Microsoft Word 或 LibreOffice
- Linux：需要安装 LibreOffice

**使用方式**：
1. 可以直接导出任意 .docx 文件（无需先打开）
2. 如果文档已打开且有修改，会自动保存后再导出

**注意**：如果系统未安装支持的软件，会返回错误提示和安装建议。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Word 文档路径（.docx）'
          },
          output_path: {
            type: 'string',
            description: 'PDF 输出路径（可选，默认与源文件同目录同名）'
          }
        },
        required: ['path']
      }
    }
  }
]

