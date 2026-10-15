/**
 * 档案室管理技能的工具。
 * 搜索、列目录、打开全文、限定这场对话的范围不在这里，那些更常用。
 */
import type { ToolDefinition, ToolDefinitionWithMeta } from '../../tools'

const step = { parallelizable: false, phase: 'idle' as const, allowedForSubAgent: false }

export const archiveTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'add_knowledge',
      description: '把本机上的一个文件放进档案室。只收本机路径，文件正文不会出现在这次对话里。可指定目录。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '本机文件路径（跑着旗鱼的这台电脑，不是远程主机）',
          },
          folder: {
            type: 'string',
            description: '放进哪个目录，例如「公司制度/差旅」。不填则放在根上。',
          },
        },
        required: ['path'],
      },
    },
    _meta: { ...step, supportedModes: ['local', 'assistant', 'ssh'] },
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'remove_knowledge',
      description: '从档案室删除一份文档。自己放进去的可以直接删；用户放进去的会先征得同意。没有回收站。',
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: '文档 ID' },
        },
        required: ['doc_id'],
      },
    },
    _meta: step,
  } as ToolDefinitionWithMeta,
  {
    type: 'function',
    function: {
      name: 'archive_create_folder',
      description: '在档案室建一个目录。folder 用斜杠表示下级，例如 公司制度/差旅。',
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
      description: '删掉档案室的一个目录，连同里面的文件和下级目录。目录里还有文件时会先征得同意，并说明有多少份。没有回收站。',
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
