/**
 * 档案室整理技能的工具。
 * 搜索、列目录、放入、删一份不在这里，那些是手头一直有的。
 */
import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

const step = { parallelizable: false, phase: 'idle' as const }

export const archiveSkillContent = `档案室的目录可以单独存在，不必先有文件。
建出来的空目录会留下来，文件挪走之后原来的目录也还在，直到被删掉。
挪文件和改名不删除文件，只改变位置。目标位置已经有东西时不会硬盖。
删目录会连同里面的文件和下级目录一起删掉。没有回收站。
里面若有用户放进去的文件，删除前会先征得同意；全是秘书放进去的，直接删。
清空整个档案室、导入导出、重建索引不在这里。`

export const archiveTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'archive_create_folder',
      description: '在档案室建一个目录。空目录会留下来。folder 用斜杠表示下级，例如 公司制度/差旅。',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '要建的目录' },
        },
        required: ['folder'],
      },
    },
    _meta: step,
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'archive_move',
      description: '把档案室里已有的一份文件挪到另一个目录。folder 为空则挪到根上。同一目录已有同名文件时不会挪。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: '文档 ID' },
          folder: { type: 'string', description: '目标目录，空字符串表示根' },
        },
        required: ['doc_id', 'folder'],
      },
    },
    _meta: step,
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'archive_rename_folder',
      description: '给档案室的一个目录改名。里面的文件和下级目录跟着走。目标位置已经有东西时不会改。',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: '现在的目录' },
          to: { type: 'string', description: '新的目录' },
        },
        required: ['from', 'to'],
      },
    },
    _meta: step,
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'archive_delete_folder',
      description: '删掉档案室的一个目录，连同里面的文件和下级目录。里面有用户放进去的文件时会先征得同意。没有回收站。',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '要删的目录' },
        },
        required: ['folder'],
      },
    },
    _meta: step,
  } as ToolDefinitionWithMeta,
]
