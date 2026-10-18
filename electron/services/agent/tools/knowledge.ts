/**
 * 知识库操作工具
 * 包括：搜索知识库、获取知识库文档
 */
import * as fs from 'fs'
import * as path from 'path'
import { t } from '../i18n'
import { getKnowledgeService } from '../../knowledge'
import { getDocumentParserService } from '../../document-parser.service'
import { FolderPathError, type LiteralRow } from '../../knowledge/catalog'
import { setAgentRecallFolder } from '../../knowledge/recall-scope'
import { isUserDataForbidden } from '../command-audit/userdata-guard'
import { truncateFromEnd } from './utils'
import type { ToolExecutorConfig, ToolResult } from './types'

function clipLiteral(text: string): string {
  const max = 1000
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n... [内容已截断，完整内容共 ${text.length} 字符]`
}

function formatLiteralHits(rows: LiteralRow[]): string {
  const lines = rows.map((row, index) => {
    const n = index + 1
    if (row.kind === 'folder') return `### ${n}. 目录：${row.folder}`
    const title = row.folder ? `${row.folder}/${row.filename}` : row.filename
    if (row.kind === 'file') {
      const summary = row.summary ? `\n${row.summary}` : ''
      const excerpt = row.excerpt ? `\n${clipLiteral(row.excerpt)}` : ''
      return `### ${n}. ${title}\ndoc_id: ${row.id}${summary}${excerpt}`
    }
    return `### ${n}. ${title}\ndoc_id: ${row.id}\n${clipLiteral(row.excerpt)}`
  })
  return `找到 ${rows.length} 条：\n\n${lines.join('\n\n')}`
}

/**
 * 搜索知识库
 */
export async function searchKnowledge(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const query = args.query as string
  const limit = Math.min(Math.max(1, (args.limit as number) || 5), 20)
  
  if (!query) {
    return { success: false, output: '', error: t('error.query_required') }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('knowledge.search')}: "${query}"`,
    toolName: 'search_knowledge',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const knowledgeService = getKnowledgeService()
    
    if (!knowledgeService) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.not_initialized'),
        toolName: 'search_knowledge'
      })
      return { success: false, output: '', error: t('error.knowledge_not_initialized') }
    }

    if (!knowledgeService.isEnabled()) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.not_enabled'),
        toolName: 'search_knowledge'
      })
      return { success: false, output: '', error: t('error.knowledge_not_enabled') }
    }

    if (args.match === 'keyword') {
      const hits = await knowledgeService.searchLiteral(query, limit)
      if (hits.length === 0) {
        executor.addStep({
          type: 'tool_result',
          content: t('knowledge.no_results'),
          toolName: 'search_knowledge'
        })
        return { success: true, output: t('success.no_knowledge_found') }
      }
      const output = formatLiteralHits(hits)
      const displayOutput = output.length > 500 ? truncateFromEnd(output, 500) : output
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.found_results', { count: hits.length, chars: output.length }),
        toolName: 'search_knowledge',
        toolResult: displayOutput
      })
      return { success: true, output }
    }

    const results = await knowledgeService.search(query, {
      limit,
      hostId: executor.getHostId()
    })

    if (results.length === 0) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.no_results'),
        toolName: 'search_knowledge'
      })
      return { success: true, output: t('success.no_knowledge_found') }
    }

    const maxContentLength = 1000
    const formattedResults = results.map((r, i) => {
      const content = r.content.length > maxContentLength
        ? r.content.substring(0, maxContentLength) + `\n\n... [内容已截断，完整内容共 ${r.content.length} 字符]`
        : r.content
      const stored = knowledgeService.getDocument(r.docId)
      const folder = stored?.folder
      const title = folder ? `${folder}/${r.metadata.filename}` : r.metadata.filename
      return `### ${i + 1}. ${title}\ndoc_id: ${r.docId}\n${content}`
    }).join('\n\n')

    const output = `找到 ${results.length} 条相关内容：\n\n${formattedResults}`
    
    const displayOutput = output.length > 500
      ? truncateFromEnd(output, 500)
      : output

    executor.addStep({
      type: 'tool_result',
      content: t('knowledge.found_results', { count: results.length, chars: output.length }),
      toolName: 'search_knowledge',
      toolResult: displayOutput
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '搜索失败'
    executor.addStep({
      type: 'tool_result',
      content: `${t('knowledge.search_failed')}: ${errorMsg}`,
      toolName: 'search_knowledge'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 按 ID 获取知识库文档
 */
export async function getKnowledgeDoc(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const docId = args.doc_id as string
  
  if (!docId) {
    return { success: false, output: '', error: '缺少 doc_id 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.getting_doc', { id: docId }),
    toolName: 'get_knowledge_doc',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const knowledgeService = getKnowledgeService()
    
    if (!knowledgeService) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.not_initialized'),
        toolName: 'get_knowledge_doc'
      })
      return { success: false, output: '', error: t('error.knowledge_not_initialized') }
    }

    const doc = knowledgeService.getDocument(docId)
    
    if (!doc) {
      executor.addStep({
        type: 'tool_result',
        content: t('knowledge.doc_not_found', { id: docId }),
        toolName: 'get_knowledge_doc'
      })
      return { success: false, output: '', error: `文档不存在: ${docId}` }
    }

    const output = `## ${doc.filename}\n\n${doc.content}`
    
    const maxDisplayLength = 500
    const displayContent = doc.content.length > maxDisplayLength 
      ? doc.content.substring(0, maxDisplayLength) + `\n\n... [内容已截断，完整内容共 ${doc.content.length} 字符]`
      : doc.content

    executor.addStep({
      type: 'tool_result',
      content: t('knowledge.doc_retrieved', { filename: doc.filename, chars: doc.content.length }),
      toolName: 'get_knowledge_doc',
      toolResult: `## ${doc.filename}\n\n${displayContent}`
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取文档失败'
    executor.addStep({
      type: 'tool_result',
      content: `${t('knowledge.get_doc_failed')}: ${errorMsg}`,
      toolName: 'get_knowledge_doc'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

function requireKnowledge(executor: ToolExecutorConfig, toolName: string): ToolResult | null {
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

export async function listKnowledge(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const blocked = requireKnowledge(executor, 'list_knowledge')
  if (blocked) return blocked
  const folder = typeof args.folder === 'string' ? args.folder : ''
  executor.addStep({
    type: 'tool_call',
    content: folder ? t('knowledge.listing_folder', { folder }) : t('knowledge.listing'),
    toolName: 'list_knowledge',
    toolArgs: args,
    riskLevel: 'safe',
  })
  try {
    const output = getKnowledgeService()!.listCatalog(folder, { allFolders: args.all_folders === true })
    executor.addStep({ type: 'tool_result', content: output.slice(0, 500), toolName: 'list_knowledge' })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof FolderPathError
      ? error.message
      : (error instanceof Error ? error.message : '列出失败')
    return { success: false, output: '', error: errorMsg }
  }
}

export async function addKnowledge(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const blocked = requireKnowledge(executor, 'add_knowledge')
  if (blocked) return blocked
  const filePath = typeof args.path === 'string' ? args.path : ''
  const folder = typeof args.folder === 'string' ? args.folder : ''
  if (!filePath) return { success: false, output: '', error: t('error.file_path_required') }
  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.adding', { name: path.basename(filePath) }),
    toolName: 'add_knowledge',
    toolArgs: { path: filePath, folder },
    riskLevel: 'safe',
  })
  if (isUserDataForbidden(filePath, undefined, 'read')) {
    return { success: false, output: '', error: t('file.forbidden_path_error') }
  }
  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: t('error.file_not_exists', { path: filePath }) }
  }
  try {
    const parsed = await getDocumentParserService().parseDocument({
      name: path.basename(filePath),
      path: filePath,
      size: fs.statSync(filePath).size,
    })
    if (parsed.error) return { success: false, output: '', error: parsed.error }
    if (parsed.skipped) return { success: false, output: '', error: `${parsed.filename} 超过解析大小限制` }
    if (!parsed.content.trim()) return { success: false, output: '', error: `${parsed.filename} 没有解析出文字` }
    const service = getKnowledgeService()!
    const before = service.isDuplicate(parsed.content)
    const docId = await service.addDocument(parsed, { folder, addedBy: 'agent' })
    const doc = service.getDocument(docId)
    const where = doc?.folder ? `${doc.folder}/${doc.filename}` : (doc?.filename || parsed.filename)
    const output = before.isDuplicate
      ? `知识库里已经有同样内容：${where}（doc_id: ${docId}）。正文没有放进这次对话。`
      : `已放入知识库：${where}（doc_id: ${docId}）。正文没有放进这次对话。`
    executor.addStep({ type: 'tool_result', content: output, toolName: 'add_knowledge' })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof FolderPathError
      ? error.message
      : (error instanceof Error ? error.message : '放入失败')
    return { success: false, output: '', error: errorMsg }
  }
}

export async function removeKnowledge(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig,
  toolCallId: string
): Promise<ToolResult> {
  const blocked = requireKnowledge(executor, 'remove_knowledge')
  if (blocked) return blocked
  const docId = typeof args.doc_id === 'string' ? args.doc_id : ''
  if (!docId) return { success: false, output: '', error: '缺少 doc_id 参数' }
  const service = getKnowledgeService()!
  const doc = service.getDocument(docId)
  if (!doc || doc.fileType === 'host-memory' || doc.fileType === 'conversation') {
    return { success: false, output: '', error: `文档不存在: ${docId}` }
  }
  const needsConfirm = service.libraryDeleteNeedsConfirm(docId)
  executor.addStep({
    type: 'tool_call',
    content: t('knowledge.removing', { name: doc.filename }),
    toolName: 'remove_knowledge',
    toolArgs: args,
    riskLevel: needsConfirm ? 'dangerous' : 'safe',
  })
  if (needsConfirm) {
    const approved = await executor.waitForConfirmation(
      toolCallId,
      'remove_knowledge',
      args,
      'dangerous',
      t('knowledge.confirm_remove', { name: doc.filename })
    )
    if (!approved) return { success: false, output: '', error: '用户未同意删除' }
  }
  const removed = await service.removeDocument(docId)
  if (!removed) return { success: false, output: '', error: `文档不存在: ${docId}` }
  const output = `已从知识库删除：${doc.filename}。没有回收站。`
  executor.addStep({ type: 'tool_result', content: output, toolName: 'remove_knowledge' })
  return { success: true, output }
}

export async function focusKnowledgeFolder(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const folder = typeof args.folder === 'string' ? args.folder : ''
  if (!executor.agentId) return { success: false, output: '', error: '这场对话没有标识，没法记住范围' }
  try {
    const normalized = setAgentRecallFolder(executor.agentId, folder)
    const output = normalized
      ? `这场对话之后，自动翻档案只在「${normalized}」及其下级里。`
      : '这场对话之后，自动翻知识库改看整个知识库。'
    executor.addStep({
      type: 'tool_call',
      content: output,
      toolName: 'focus_knowledge_folder',
      toolArgs: { folder: normalized },
      riskLevel: 'safe',
    })
    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof FolderPathError
      ? error.message
      : (error instanceof Error ? error.message : '设置范围失败')
    return { success: false, output: '', error: errorMsg }
  }
}
