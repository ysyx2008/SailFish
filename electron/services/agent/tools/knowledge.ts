/**
 * 知识库操作工具
 * 包括：记忆信息、搜索知识库、获取知识库文档
 */
import { t } from '../i18n'
import { getKnowledgeService } from '../../knowledge'
import { getContextKnowledgeService } from '../../knowledge/context-knowledge'
import { truncateFromEnd } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'

/**
 * 记住信息 — 通过 LLM 将信息整合到知识文档中
 */
export async function rememberInfo(
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const info = args.info as string
  if (!info) {
    return { success: false, output: '', error: t('error.info_required') }
  }

  executor.addStep({
    type: 'tool_call',
    content: `${t('memory.remember')}: ${info}`,
    toolName: 'remember_info',
    toolArgs: args,
    riskLevel: 'safe'
  })

  const contextId = executor.getHostId() || 'personal'
  const aiService = executor.getAiService?.()
  const profileId = executor.getActiveProfileId?.()

  if (!aiService) {
    executor.addStep({
      type: 'tool_result',
      content: t('memory.cannot_save'),
      toolName: 'remember_info'
    })
    return { success: false, output: '', error: t('error.knowledge_not_available') }
  }

  try {
    const ckService = getContextKnowledgeService()
    const result = await ckService.rememberInfo(contextId, info, aiService, profileId)

    const resultMessage = result.updated
      ? `已将信息整合到知识文档中（${contextId}）`
      : `信息已存在或无需更新（${contextId}）`

    executor.addStep({
      type: 'tool_result',
      content: resultMessage,
      toolName: 'remember_info'
    })

    return { success: true, output: resultMessage }
  } catch (error) {
    console.error('[rememberInfo] 更新知识文档失败:', error)
    executor.addStep({
      type: 'tool_result',
      content: t('memory.cannot_save'),
      toolName: 'remember_info'
    })
    return { success: false, output: '', error: t('error.knowledge_not_available') }
  }
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
      return `### ${i + 1}. ${r.metadata.filename}\n${content}`
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
