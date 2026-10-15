/**
 * 档案室整理技能的执行。
 */
import type { AgentConfig, ToolExecutorConfig, ToolResult } from '../../tools/types'
import { t } from '../../i18n'
import { getKnowledgeService } from '../../../knowledge'
import { FolderPathError } from '../../../knowledge/catalog'

function requireArchive(executor: ToolExecutorConfig, toolName: string): ToolResult | null {
  const knowledgeService = getKnowledgeService()
  if (!knowledgeService) {
    executor.addStep({ type: 'tool_result', content: t('knowledge.not_initialized'), toolName })
    return { success: false, output: '', error: t('error.knowledge_not_initialized') }
  }
  if (!knowledgeService.isEnabled()) {
    executor.addStep({ type: 'tool_result', content: t('knowledge.not_enabled'), toolName })
    return { success: false, output: '', error: t('error.knowledge_not_enabled') }
  }
  return null
}

function fail(error: unknown, fallback: string): ToolResult {
  const errorMsg = error instanceof FolderPathError
    ? error.message
    : (error instanceof Error ? error.message : fallback)
  return { success: false, output: '', error: errorMsg }
}

async function createFolder(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const blocked = requireArchive(executor, 'archive_create_folder')
  if (blocked) return blocked
  const folder = typeof args.folder === 'string' ? args.folder : ''
  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.creating_folder', { folder: folder || '（空）' }),
    toolName: 'archive_create_folder',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const created = getKnowledgeService()!.createFolder(folder)
    const output = `已建目录：${created}。`
    executor.addStep({ type: 'tool_result', content: output, toolName: 'archive_create_folder' })
    return { success: true, output }
  } catch (error) {
    return fail(error, '建目录失败')
  }
}

async function moveDoc(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const blocked = requireArchive(executor, 'archive_move')
  if (blocked) return blocked
  const docId = typeof args.doc_id === 'string' ? args.doc_id : ''
  const folder = typeof args.folder === 'string' ? args.folder : ''
  if (!docId) return { success: false, output: '', error: '缺少 doc_id 参数' }
  const service = getKnowledgeService()!
  const doc = service.getDocument(docId)
  if (!doc || doc.fileType === 'host-memory' || doc.fileType === 'conversation') {
    return { success: false, output: '', error: `文档不存在: ${docId}` }
  }
  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.moving', { name: doc.filename, folder: folder || '根' }),
    toolName: 'archive_move',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const moved = await service.moveLibraryDocument(docId, folder)
    if (!moved) return { success: false, output: '', error: '同目录下已有同名文档' }
    const where = folder ? `${service.getDocument(docId)?.folder}/${doc.filename}` : doc.filename
    const output = `已挪到：${where}（doc_id: ${docId}）。`
    executor.addStep({ type: 'tool_result', content: output, toolName: 'archive_move' })
    return { success: true, output }
  } catch (error) {
    return fail(error, '挪动失败')
  }
}

async function renameFolder(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const blocked = requireArchive(executor, 'archive_rename_folder')
  if (blocked) return blocked
  const from = typeof args.from === 'string' ? args.from : ''
  const to = typeof args.to === 'string' ? args.to : ''
  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.renaming_folder', { from, to }),
    toolName: 'archive_rename_folder',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const dest = getKnowledgeService()!.renameFolder(from, to)
    const children = getKnowledgeService()!.listFolders().filter(folder => folder === dest || folder.startsWith(`${dest}/`))
    const output = `已改名：${from} → ${dest}\n${children.join('\n')}`
    executor.addStep({ type: 'tool_result', content: output, toolName: 'archive_rename_folder' })
    return { success: true, output }
  } catch (error) {
    return fail(error, '改名失败')
  }
}

async function deleteFolder(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  toolCallId: string,
): Promise<ToolResult> {
  const blocked = requireArchive(executor, 'archive_delete_folder')
  if (blocked) return blocked
  const folder = typeof args.folder === 'string' ? args.folder : ''
  if (!folder.trim()) return { success: false, output: '', error: '缺少 folder 参数' }
  const service = getKnowledgeService()!
  let fileCount = 0
  try {
    fileCount = service.countLibraryFilesInFolder(folder)
  } catch (error) {
    return fail(error, '删除失败')
  }
  const needsConfirm = fileCount > 0
  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.removing_folder', { folder }),
    toolName: 'archive_delete_folder',
    toolArgs: args,
    riskLevel: needsConfirm ? 'dangerous' : 'safe',
  })
  if (needsConfirm) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'archive_delete_folder',
      args,
      'dangerous',
      t('knowledge.confirm_remove_folder', { folder, count: fileCount }),
    )
    if (!approved) return { success: false, output: '', error: '用户未同意删除' }
  }
  try {
    const removed = await service.deleteFolder(folder)
    const output = `已删除目录：${folder}（${removed} 份文件）。没有回收站。`
    executor.addStep({ type: 'tool_result', content: output, toolName: 'archive_delete_folder' })
    return { success: true, output }
  } catch (error) {
    return fail(error, '删除失败')
  }
}

export async function executeArchiveTool(
  toolName: string,
  _ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  _config: AgentConfig,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  switch (toolName) {
    case 'archive_create_folder':
      return createFolder(args, executor)
    case 'archive_move':
      return moveDoc(args, executor)
    case 'archive_rename_folder':
      return renameFolder(args, executor)
    case 'archive_delete_folder':
      return deleteFolder(args, executor, toolCallId)
    default:
      return { success: false, output: '', error: `Unknown archive tool: ${toolName}` }
  }
}
