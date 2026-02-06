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
  }
]

