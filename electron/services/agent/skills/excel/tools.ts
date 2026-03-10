/**
 * Excel 技能工具定义
 */

import type { ToolDefinition } from '../../tools'

export const excelTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'excel_open',
      description: `打开 Excel 文件，建立会话。后续的读取和修改操作都在此会话中进行。

**注意**：
- 同一文件不能重复打开
- 打开后请及时操作，5 分钟无操作会自动关闭（未保存的修改会丢失）
- 完成后请调用 excel_save 保存，然后 excel_close 关闭`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（绝对路径或相对于当前目录）'
          },
          create_if_not_exists: {
            type: 'boolean',
            description: '如果文件不存在，是否创建新文件（默认 false）'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_read',
      description: `读取已打开的 Excel 文件数据。

**读取模式**：
1. 不指定 sheet：返回工作簿概览（所有 Sheet 的名称和数据量）
2. 指定 sheet：返回该 Sheet 的数据（Markdown 表格格式）
3. 指定 sheet + range：返回指定单元格范围的数据

**大表处理**：默认最多显示 50 行 x 20 列，超出部分显示摘要。可通过 max_rows 参数调整（上限 500）。
**include_styles**：设为 true 时，在有非默认样式的单元格值后附加样式标注（如 \`文本[bg:#FF9900]\`），用于检查/复刻现有格式。
**建议**：先不指定 sheet 获取概览，再根据数据量决定读取策略。对于大表，建议分批使用 range 读取。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          sheet: {
            type: 'string',
            description: 'Sheet 名称（可选，不指定则返回概览）'
          },
          range: {
            type: 'string',
            description: '单元格范围（可选，如 "A1:D100"）'
          },
          max_rows: {
            type: 'number',
            description: '最大返回行数（默认 50，上限 500）'
          },
          include_styles: {
            type: 'boolean',
            description: '是否在输出中包含单元格样式信息（背景色、字体颜色、粗体等），默认 false'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_save',
      description: `保存已打开的 Excel 文件的修改。

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
      name: 'excel_close',
      description: `关闭已打开的 Excel 文件。

**注意**：
- 如果有未保存的修改，会提示是否丢弃
- 关闭后如需再次操作，需要重新 excel_open`,
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
      name: 'excel_from_markdown',
      description: `从 Markdown 内容直接生成 Excel 文件（快速模式，无需 open/modify/save 流程）。

**输入方式**：
- 直接传入 markdown：适合动态生成表格内容后立刻转 Excel
- 传入 markdown_path：适合直接把本地 .md 文件里的表格转成 Excel，不必重新生成全文
- markdown 和 markdown_path 二选一，不能同时传

**Markdown 格式要求**：
- 使用标准 Markdown 表格语法
- 第一行为表头，自动加粗
- 多个表格用 \`## 标题\` 分隔，每个标题+表格成为一个 Sheet
- 没有标题的表格使用默认 Sheet 名

**示例**：
\`\`\`markdown
## 销售数据

| 月份 | 销售额 | 增长率 |
|------|--------|--------|
| 1月  | 10000  | 5%     |
| 2月  | 12000  | 20%    |

## 员工信息

| 姓名 | 部门 | 入职日期   |
|------|------|-----------|
| 张三 | 技术 | 2024-01-01 |
\`\`\`

**特性**：
- 自动调整列宽
- 表头加粗 + 底色 + 边框
- 数字自动识别（不会变成文本）
- 文件已存在时自动备份`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '目标文件路径（.xlsx），绝对路径或相对于当前目录'
          },
          markdown: {
            type: 'string',
            description: 'Markdown 内容（包含表格）'
          },
          markdown_path: {
            type: 'string',
            description: '本地 Markdown 文件路径（.md/.markdown/.txt 等文本文件），绝对路径或相对于当前目录'
          },
          sheet_name: {
            type: 'string',
            description: '当 Markdown 中只有一个表格且无标题时使用的 Sheet 名（默认 "Sheet1"）'
          },
          style: {
            type: 'string',
            description: '样式主题名称：simple（默认，蓝色表头）、business（商务蓝，交替行色）、dark（深色表头）、colorful（绿色，交替行色）、minimal（极简）、finance（深蓝财务风），或自定义样式名'
          }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'excel_modify',
      description: `修改已打开的 Excel 文件。修改后需要调用 excel_save 保存。

**支持的操作**：
1. 修改单元格：使用 cells 参数
2. 添加新 Sheet：使用 add_sheet 参数
3. 删除 Sheet：使用 delete_sheet 参数

**cells 值格式**：
- 普通值：\`{"A1": "文本", "B1": 123}\`
- 公式：\`{"A1": {"formula": "SUM(B1:B10)"}}\`（注意：formula 值不要加等号）
- 强制文本：\`{"A1": {"text": "=这不是公式"}}\`

**styles 单元格样式**（可选，与 cells 同时使用或单独使用）：
- 格式：\`{"A1": {"bold": true, "background": "FFFF00"}, "B1:D1": {"align": "center"}}\`
- 支持范围：\`"A1:C3"\` 对范围内所有单元格应用同一样式
- 可用属性：font(字体名), fontSize, bold, italic, underline, color(十六进制), background(十六进制), align(left/center/right), verticalAlign(top/middle/bottom), wrapText, numberFormat(如"#,##0.00"), border("thin"/"medium"/"thick"/"none"/"all"或{style,color})

**注意**：修改只在内存中生效，需要 excel_save 才能写入文件。`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '已打开的文件路径'
          },
          sheet: {
            type: 'string',
            description: 'Sheet 名称（修改单元格时必填）'
          },
          cells: {
            type: 'object',
            description: '要修改的单元格，格式：{"A1": "值1", "B2": 123}'
          },
          styles: {
            type: 'object',
            description: `要设置的单元格样式，格式：{"A1": {样式}, "B1:D1": {样式}}

**样式属性**：
- font: 字体名称（如"微软雅黑"、"Arial"）
- fontSize: 字号
- bold/italic/underline: 布尔值
- color: 文字颜色（十六进制如"FF0000"）
- background: 背景色（十六进制如"F2F2F2"）
- align: 水平对齐（left/center/right）
- verticalAlign: 垂直对齐（top/middle/bottom）
- wrapText: 自动换行
- numberFormat: 数字格式（如"#,##0.00"、"0%"、"yyyy-mm-dd"）
- border: 边框（"thin"/"medium"/"thick"/"none"/"all"，或 {style, color}）

**范围语法**：单元格 "A1"、矩形区域 "A1:D10"、整列 "A:A"、整行 "1:1"`
          },
          add_sheet: {
            type: 'string',
            description: '要添加的新 Sheet 名称'
          },
          delete_sheet: {
            type: 'string',
            description: '要删除的 Sheet 名称'
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
      name: 'excel_create_style',
      description: `创建自定义 Excel 主题样式。创建的样式保存到知识库，后续 excel_from_markdown 可直接使用。

**创建方式**：
1. 直接指定 config JSON
2. base + config：基于已有样式修改部分属性

**config 属性**：
- header: { font, fontSize, bold, color(文字色), background(背景色), align, border:{style,color} }
- data: { font, fontSize, color, align, border:{style,color}, alternatingColors:[奇数行色, 偶数行色] }
- autoWidth: 自动调整列宽（默认 true）
- freezeHeader: 冻结表头行（默认 false）

**示例**（用户说"表头红底白字，数据行交替灰白"）：
config: { header: { background:"C00000", color:"FFFFFF", bold:true }, data: { alternatingColors:["FFFFFF","F2F2F2"] } }`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '样式名称，用于后续引用'
          },
          config: {
            type: 'object',
            description: '样式配置 JSON'
          },
          base: {
            type: 'string',
            description: '基础样式名称（预设或自定义），新样式会在此基础上覆盖 config 中指定的属性'
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
      name: 'excel_edit_style',
      description: `修改已有 Excel 样式的部分属性（增量更新）。

- 对预设样式：自动复制为自定义副本后修改
- 未指定的属性保持不变`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: '要编辑的样式名称'
          },
          config: {
            type: 'object',
            description: '要修改的配置属性（增量合并）'
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
      name: 'excel_delete_style',
      description: `删除自定义 Excel 样式。预设样式不能删除。`,
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
      name: 'excel_list_styles',
      description: `列出所有可用的 Excel 主题样式，包括预设样式和用户自定义样式。`,
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
      name: 'excel_set_default_style',
      description: `设置默认 Excel 主题样式。后续 excel_from_markdown 如不指定样式，将使用此默认样式。`,
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

