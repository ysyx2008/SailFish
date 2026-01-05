/**
 * Word 技能执行器
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  convertInchesToTwip,
  ImageRun,
  PageBreak,
  TableOfContents,
  Header,
  Footer,
  PageNumber,
  ExternalHyperlink,
  Bookmark,
  CommentRangeStart,
  CommentRangeEnd,
  CommentReference
} from 'docx'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t } from '../../i18n'
import { getTerminalStateService } from '../../../terminal-state.service'
import {
  isSessionOpen,
  getSession,
  createSession,
  addContent,
  getSessionContent,
  markSaved,
  closeSession,
  setPageSettings,
  getPageSettings,
  setDocumentSettings,
  getDocumentSettings,
  type SectionContent,
  type PageSettings,
  type DocumentSettings
} from './session'
import {
  markdownToDocx,
  PRESET_STYLES,
  getStyleConfig,
  extractStyleFromTemplate,
  getStyleExtractionPrompt,
  type WordStyleConfig
} from './styles'
import { app } from 'electron'
import { getKnowledgeService } from '../../../knowledge'

// 备用存储路径（知识库未启用时使用）
const STYLES_FILE_PATH = path.join(app.getPath('userData'), 'word-styles.json')

// 样式文档标记 tag
const WORD_STYLE_TAG = 'word_style'

// 存储用户自定义样式（内存缓存）
const customStyles = new Map<string, WordStyleConfig>()
// 样式 ID 映射（样式名 -> 知识库文档 ID）
const styleDocIds = new Map<string, string>()
let defaultStyleName: string | null = null
let stylesLoaded = false

/**
 * 加载自定义样式
 * 优先从知识库加载，知识库不可用时从本地 JSON 加载
 */
function loadCustomStyles(): void {
  if (stylesLoaded) return
  
  try {
    const knowledgeService = getKnowledgeService()
    
    if (knowledgeService && knowledgeService.isEnabled()) {
      // 从知识库加载（通过 tag 标记）
      const docs = knowledgeService.getDocuments()
      const styleDocs = docs.filter(doc => doc.tags.includes(WORD_STYLE_TAG))
      
      for (const doc of styleDocs) {
        try {
          const styleData = JSON.parse(doc.content)
          customStyles.set(styleData.name, styleData as WordStyleConfig)
          styleDocIds.set(styleData.name, doc.id)
          
          // 检查是否为默认样式
          if (styleData.isDefault) {
            defaultStyleName = styleData.name
          }
        } catch (e) {
          console.error(`[WordSkill] Failed to parse style doc ${doc.id}:`, e)
        }
      }
      
      console.log(`[WordSkill] Loaded ${customStyles.size} custom styles from knowledge base`)
    } else {
      // 从本地 JSON 加载（备用）
      if (fs.existsSync(STYLES_FILE_PATH)) {
        const data = JSON.parse(fs.readFileSync(STYLES_FILE_PATH, 'utf-8'))
        if (data.styles) {
          for (const [name, style] of Object.entries(data.styles)) {
            customStyles.set(name, style as WordStyleConfig)
          }
        }
        if (data.defaultStyle) {
          defaultStyleName = data.defaultStyle
        }
        console.log(`[WordSkill] Loaded ${customStyles.size} custom styles from local file`)
      }
    }
  } catch (e) {
    console.error('[WordSkill] Failed to load custom styles:', e)
  }
  
  stylesLoaded = true
}

/**
 * 保存自定义样式到知识库
 */
async function saveStyleToKnowledge(style: WordStyleConfig): Promise<string | null> {
  try {
    const knowledgeService = getKnowledgeService()
    
    if (!knowledgeService || !knowledgeService.isEnabled()) {
      return null
    }
    
    // 如果样式已存在，先删除旧的
    const existingDocId = styleDocIds.get(style.name)
    if (existingDocId) {
      await knowledgeService.removeDocument(existingDocId)
    }
    
    // 添加新样式文档
    const styleContent = JSON.stringify(style, null, 2)
    const docId = await knowledgeService.addDocument({
      filename: `word-style-${style.name}.json`,
      fileType: 'json',
      content: styleContent,
      fileSize: Buffer.from(styleContent).length,
      parseTime: 0
    }, {
      tags: [WORD_STYLE_TAG, style.name]
    })
    
    styleDocIds.set(style.name, docId)
    console.log(`[WordSkill] Saved style "${style.name}" to knowledge base (doc: ${docId})`)
    
    return docId
  } catch (e) {
    console.error('[WordSkill] Failed to save style to knowledge:', e)
    return null
  }
}

/**
 * 保存默认样式设置
 */
async function saveDefaultStyleSetting(): Promise<void> {
  // 更新所有样式的 isDefault 标记
  const entries = Array.from(customStyles.entries())
  for (const [name, style] of entries) {
    const isDefault = name === defaultStyleName
    if (style.isDefault !== isDefault) {
      style.isDefault = isDefault
      await saveStyleToKnowledge(style)
    }
  }
}

/**
 * 保存自定义样式（备用：本地 JSON）
 */
function saveCustomStylesToFile(): void {
  try {
    const data = {
      styles: Object.fromEntries(customStyles),
      defaultStyle: defaultStyleName
    }
    
    const dir = path.dirname(STYLES_FILE_PATH)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    fs.writeFileSync(STYLES_FILE_PATH, JSON.stringify(data, null, 2))
    console.log(`[WordSkill] Saved ${customStyles.size} custom styles to local file`)
  } catch (e) {
    console.error('[WordSkill] Failed to save custom styles to file:', e)
  }
}

/**
 * 执行 Word 技能工具
 */
export async function executeWordTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'word_create':
      return await wordCreate(ptyId, args, executor)
    case 'word_open':
      return await wordOpen(ptyId, args, executor)
    case 'word_read':
      return await wordRead(ptyId, args, executor)
    case 'word_add':
      return await wordAdd(ptyId, args, executor)
    case 'word_save':
      return await wordSave(ptyId, args, toolCallId, config, executor)
    case 'word_close':
      return await wordClose(ptyId, args, executor)
    case 'word_set_page':
      return await wordSetPage(ptyId, args, executor)
    case 'word_track_changes':
      return await wordTrackChanges(ptyId, args, executor)
    // 快速模式工具
    case 'word_from_markdown':
      return await wordFromMarkdown(ptyId, args, toolCallId, config, executor)
    // 样式管理工具
    case 'word_create_style':
      return await wordCreateStyle(ptyId, args, executor)
    case 'word_list_styles':
      return await wordListStyles(executor)
    case 'word_set_default_style':
      return await wordSetDefaultStyle(args, executor)
    default:
      return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
  }
}

/**
 * 解析文件路径
 */
function resolvePath(ptyId: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath
  }
  const terminalStateService = getTerminalStateService()
  const cwd = terminalStateService.getCwd(ptyId)
  return path.resolve(cwd, filePath)
}

/**
 * 创建新 Word 文档
 */
async function wordCreate(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  let filePath = resolvePath(ptyId, args.path as string)
  
  // 确保文件扩展名为 .docx
  if (!filePath.toLowerCase().endsWith('.docx')) {
    filePath += '.docx'
  }

  // 检查是否已打开
  if (isSessionOpen(filePath)) {
    return { success: false, output: '', error: t('word.already_open', { path: filePath }) }
  }

  // 检查文件是否已存在
  if (fs.existsSync(filePath)) {
    return { success: false, output: '', error: t('word.file_exists', { path: filePath }) }
  }

  try {
    // 创建空文档
    const doc = new Document({
      sections: []
    })

    createSession(filePath, doc, true)

    const output = t('word.created_new', { path: filePath })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'word_create',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('word.create_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 打开 Word 文档
 */
async function wordOpen(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)

  // 检查是否已打开
  if (isSessionOpen(filePath)) {
    return { success: false, output: '', error: t('word.already_open', { path: filePath }) }
  }

  // 检查文件是否存在
  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: t('error.file_not_found', { path: filePath }) }
  }

  try {
    // 使用 mammoth 读取现有文档内容
    const mammoth = await import('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    const textContent = result.value

    // 创建一个新的 Document 实例（用于后续添加内容）
    const doc = new Document({
      sections: []
    })

    const session = createSession(filePath, doc, false)
    
    // 将原文档内容作为初始段落保存
    if (textContent.trim()) {
      // 按段落分割
      const paragraphs = textContent.split(/\n\n+/)
      for (const para of paragraphs) {
        if (para.trim()) {
          session.sections.push({
            type: 'paragraph',
            content: para.trim()
          })
        }
      }
    }

    const contentPreview = textContent.length > 500 
      ? textContent.substring(0, 500) + '...' 
      : textContent

    const output = t('word.opened', { path: filePath }) + 
      `\n\n**文档内容预览：**\n${contentPreview || '(空文档)'}`

    executor.addStep({
      type: 'tool_result',
      content: t('word.opened', { path: filePath }),
      toolName: 'word_open',
      toolResult: truncateFromEnd(output, 500)
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('word.open_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 读取 Word 文档内容
 */
async function wordRead(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('word.not_open', { path: filePath }) }
  }

  // 将会话内容转为 Markdown
  const markdown = sectionsToMarkdown(session.sections)
  
  const output = `## ${path.basename(filePath)}\n\n${markdown || '(空文档)'}`

  executor.addStep({
    type: 'tool_result',
    content: t('word.read_success'),
    toolName: 'word_read',
    toolResult: truncateFromEnd(output, 500)
  })

  return { success: true, output }
}

/**
 * 添加内容到 Word 文档
 */
async function wordAdd(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const contentType = args.type as string
  const content = args.content as string | undefined
  const level = args.level as number | undefined
  const items = args.items as string[] | undefined
  const rows = args.rows as string[][] | undefined
  // 样式参数（扁平化）
  const style = {
    font: args.font as string | undefined,
    size: args.size as number | undefined,
    bold: args.bold as boolean | undefined,
    italic: args.italic as boolean | undefined,
    underline: args.underline as boolean | undefined,
    color: args.color as string | undefined,
    highlight: args.highlight as string | undefined,
    align: args.align as 'left' | 'center' | 'right' | 'justify' | undefined,
    indent: args.indent as number | undefined
  }
  // 图片参数
  const imagePath = args.image_path as string | undefined
  const imageWidth = args.image_width as number | undefined
  const imageHeight = args.image_height as number | undefined
  // 超链接/书签/批注参数
  const url = args.url as string | undefined
  const bookmarkName = args.bookmark_name as string | undefined
  const commentText = args.comment_text as string | undefined
  const commentAuthor = args.comment_author as string | undefined

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('word.not_open', { path: filePath }) }
  }

  // 验证参数
  if (!contentType) {
    return { success: false, output: '', error: t('word.type_required') }
  }

  let sectionContent: SectionContent

  switch (contentType) {
    case 'paragraph':
      if (!content) {
        return { success: false, output: '', error: t('word.content_required') }
      }
      sectionContent = { type: 'paragraph', content, style }
      break
      
    case 'heading':
      if (!content) {
        return { success: false, output: '', error: t('word.content_required') }
      }
      sectionContent = { 
        type: 'heading', 
        content, 
        level: Math.min(Math.max(level || 1, 1), 6),
        style 
      }
      break
      
    case 'list':
      if (!items || items.length === 0) {
        return { success: false, output: '', error: t('word.items_required') }
      }
      sectionContent = { type: 'list', content: '', items, style }
      break
      
    case 'table':
      if (!rows || rows.length === 0) {
        return { success: false, output: '', error: t('word.rows_required') }
      }
      sectionContent = { type: 'table', content: '', rows }
      break
      
    case 'image':
      if (!imagePath) {
        return { success: false, output: '', error: '图片路径必填' }
      }
      const resolvedImagePath = resolvePath(ptyId, imagePath)
      if (!fs.existsSync(resolvedImagePath)) {
        return { success: false, output: '', error: t('error.file_not_found', { path: resolvedImagePath }) }
      }
      sectionContent = { 
        type: 'image', 
        content: '', 
        imagePath: resolvedImagePath,
        imageWidth,
        imageHeight,
        style 
      }
      break
      
    case 'page_break':
      sectionContent = { type: 'page_break', content: '' }
      break
      
    case 'toc':
      sectionContent = { type: 'toc', content: '' }
      break
      
    case 'hyperlink':
      if (!content) {
        return { success: false, output: '', error: '链接文字必填' }
      }
      if (!url) {
        return { success: false, output: '', error: '链接URL必填' }
      }
      sectionContent = { 
        type: 'hyperlink', 
        content,
        url,
        style 
      }
      break
      
    case 'bookmark':
      if (!content) {
        return { success: false, output: '', error: '书签位置文字必填' }
      }
      if (!bookmarkName) {
        return { success: false, output: '', error: '书签名称必填' }
      }
      sectionContent = { 
        type: 'bookmark', 
        content,
        bookmarkName,
        style 
      }
      break
      
    case 'comment':
      if (!content) {
        return { success: false, output: '', error: '段落内容必填' }
      }
      if (!commentText) {
        return { success: false, output: '', error: '批注内容必填' }
      }
      sectionContent = { 
        type: 'comment', 
        content,
        commentText,
        commentAuthor: commentAuthor || '批注者',
        style 
      }
      break
      
    default:
      return { success: false, output: '', error: t('word.invalid_type', { type: contentType }) }
  }

  addContent(filePath, sectionContent)

  const output = t('word.content_added', { type: contentType }) + '\n\n💡 ' + t('word.save_reminder')

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'word_add',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 保存 Word 文档
 */
async function wordSave(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('word.not_open', { path: filePath }) }
  }

  if (!session.dirty) {
    const output = t('word.no_changes')
    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'word_save',
      toolResult: output
    })
    return { success: true, output }
  }

  // 需要用户确认
  executor.addStep({
    type: 'tool_call',
    content: t('word.confirm_save', { path: filePath }),
    toolName: 'word_save',
    toolArgs: args,
    riskLevel: 'moderate'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'word_save',
    { path: filePath },
    'moderate'
  )

  if (!approved) {
    return { success: false, output: '', error: t('word.user_rejected') }
  }

  try {
    // 创建备份（如果文件已存在）
    if (fs.existsSync(filePath)) {
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
      const ext = path.extname(filePath)
      const baseName = filePath.slice(0, -ext.length)
      
      let backupPath = `${baseName}_${timestamp}${ext}.bak`
      let counter = 2
      while (fs.existsSync(backupPath)) {
        backupPath = `${baseName}_${timestamp}_${counter}${ext}.bak`
        counter++
      }
      fs.copyFileSync(filePath, backupPath)
    }

    // 构建文档（包含页眉页脚和文档设置）
    const doc = buildDocument(session.sections, session.pageSettings, session.documentSettings)
    
    // 写入文件
    const buffer = await Packer.toBuffer(doc)
    fs.writeFileSync(filePath, buffer)
    
    markSaved(filePath)

    const output = t('word.saved', { path: filePath })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'word_save',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('word.save_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 关闭 Word 文档
 */
async function wordClose(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const discardChanges = args.discard_changes === true

  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('word.not_open', { path: filePath }) }
  }

  if (session.dirty && !discardChanges) {
    return { success: false, output: '', error: t('word.unsaved_changes', { path: filePath }) }
  }

  const wasDirty = closeSession(filePath, false)
  
  const output = wasDirty
    ? t('word.closed_discarded', { path: filePath })
    : t('word.closed', { path: filePath })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'word_close',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 设置页面属性（页眉、页脚、页码）
 */
async function wordSetPage(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  
  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('word.not_open', { path: filePath }) }
  }
  
  const settings: PageSettings = {}
  
  if (args.header !== undefined) {
    settings.header = args.header as string
  }
  if (args.footer !== undefined) {
    settings.footer = args.footer as string
  }
  if (args.page_number !== undefined) {
    settings.pageNumber = args.page_number as boolean
  }
  if (args.page_number_format !== undefined) {
    settings.pageNumberFormat = args.page_number_format as 'numeric' | 'roman' | 'letter'
  }
  if (args.page_number_position !== undefined) {
    settings.pageNumberPosition = args.page_number_position as 'header' | 'footer'
  }
  
  setPageSettings(filePath, settings)
  
  const parts: string[] = []
  if (settings.header !== undefined) parts.push(`页眉: "${settings.header}"`)
  if (settings.footer !== undefined) parts.push(`页脚: "${settings.footer}"`)
  if (settings.pageNumber) parts.push(`页码: 已启用`)
  
  const output = `页面设置已更新：\n${parts.join('\n')}\n\n💡 ${t('word.save_reminder')}`

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'word_set_page',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 设置修订追踪
 */
async function wordTrackChanges(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  
  const filePath = resolvePath(ptyId, args.path as string)
  const enabled = args.enabled as boolean
  const author = (args.author as string) || '审阅者'
  
  const session = getSession(filePath)
  if (!session) {
    return { success: false, output: '', error: t('word.not_open', { path: filePath }) }
  }
  
  setDocumentSettings(filePath, {
    trackRevisions: enabled,
    revisionAuthor: author
  })
  
  const output = enabled 
    ? `修订追踪已启用，作者: ${author}\n\n💡 ${t('word.save_reminder')}`
    : `修订追踪已禁用\n\n💡 ${t('word.save_reminder')}`

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'word_track_changes',
    toolResult: output
  })

  return { success: true, output }
}

// ============ 辅助函数 ============

/**
 * 将 SectionContent 数组转为 Markdown
 */
function sectionsToMarkdown(sections: SectionContent[]): string {
  const parts: string[] = []
  
  for (const section of sections) {
    switch (section.type) {
      case 'heading':
        const hashes = '#'.repeat(section.level || 1)
        parts.push(`${hashes} ${section.content}`)
        break
        
      case 'paragraph':
        let text = section.content
        if (section.style?.bold) text = `**${text}**`
        if (section.style?.italic) text = `*${text}*`
        parts.push(text)
        break
        
      case 'list':
        if (section.items) {
          for (const item of section.items) {
            parts.push(`- ${item}`)
          }
        }
        break
        
      case 'table':
        if (section.rows && section.rows.length > 0) {
          // 表头
          parts.push('| ' + section.rows[0].join(' | ') + ' |')
          parts.push('| ' + section.rows[0].map(() => '---').join(' | ') + ' |')
          // 数据行
          for (let i = 1; i < section.rows.length; i++) {
            parts.push('| ' + section.rows[i].join(' | ') + ' |')
          }
        }
        break
    }
  }
  
  return parts.join('\n\n')
}

/**
 * 构建 Document 对象
 */
function buildDocument(sections: SectionContent[], pageSettings?: PageSettings, documentSettings?: DocumentSettings): Document {
  const children: (Paragraph | Table | TableOfContents)[] = []
  let commentId = 1  // 批注ID计数器
  
  for (const section of sections) {
    switch (section.type) {
      case 'heading':
        children.push(createHeading(section.content, section.level || 1, section.style))
        break
        
      case 'paragraph':
        children.push(createParagraph(section.content, section.style))
        break
        
      case 'list':
        if (section.items) {
          for (const item of section.items) {
            children.push(createBulletPoint(item, section.style))
          }
        }
        break
        
      case 'table':
        if (section.rows && section.rows.length > 0) {
          children.push(createTable(section.rows))
        }
        break
        
      case 'image':
        if (section.imagePath) {
          children.push(createImageParagraph(section.imagePath, section.imageWidth, section.imageHeight, section.style))
        }
        break
        
      case 'page_break':
        children.push(new Paragraph({
          children: [new PageBreak()]
        }))
        break
        
      case 'toc':
        children.push(new TableOfContents('目录', {
          hyperlink: true,
          headingStyleRange: '1-3'
        }))
        break
        
      case 'hyperlink':
        if (section.url) {
          children.push(createHyperlinkParagraph(section.content, section.url, section.style))
        }
        break
        
      case 'bookmark':
        if (section.bookmarkName) {
          children.push(createBookmarkParagraph(section.content, section.bookmarkName, section.style))
        }
        break
        
      case 'comment':
        if (section.commentText) {
          children.push(createCommentParagraph(
            section.content, 
            section.commentText, 
            section.commentAuthor || '批注者',
            section.style,
            commentId++
          ))
        }
        break
    }
  }
  
  // 构建页眉
  const headers = pageSettings?.header ? {
    default: new Header({
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: pageSettings.header })]
      })]
    })
  } : undefined
  
  // 构建页脚
  const footerChildren: TextRun[] = []
  if (pageSettings?.footer) {
    footerChildren.push(new TextRun({ text: pageSettings.footer }))
  }
  if (pageSettings?.pageNumber) {
    if (footerChildren.length > 0) {
      footerChildren.push(new TextRun({ text: '    ' }))  // 间隔
    }
    // 使用 children 数组形式添加页码字段
    footerChildren.push(new TextRun({ 
      children: ['第 ', PageNumber.CURRENT, ' 页']
    }))
  }
  
  const footers = footerChildren.length > 0 ? {
    default: new Footer({
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: footerChildren
      })]
    })
  } : undefined
  
  // 文档配置
  const docConfig: any = {
    sections: [{
      headers,
      footers,
      children: children.length > 0 ? children : [new Paragraph({ children: [] })]
    }]
  }
  
  // 启用修订追踪
  if (documentSettings?.trackRevisions) {
    docConfig.features = {
      trackRevisions: true
    }
  }
  
  return new Document(docConfig)
}

/**
 * 创建图片段落
 */
function createImageParagraph(
  imagePath: string, 
  width?: number, 
  height?: number,
  style?: ParagraphStyle
): Paragraph {
  const imageData = fs.readFileSync(imagePath)
  
  // 默认宽度 400 像素，保持比例
  const imgWidth = width || 400
  const imgHeight = height || imgWidth * 0.75  // 默认 4:3 比例
  
  return new Paragraph({
    alignment: getAlignment(style?.align),
    children: [
      new ImageRun({
        data: imageData,
        transformation: {
          width: imgWidth,
          height: imgHeight
        },
        type: 'png'  // 自动检测实际格式
      })
    ]
  })
}

/**
 * 创建超链接段落
 */
function createHyperlinkParagraph(text: string, url: string, style?: ParagraphStyle): Paragraph {
  return new Paragraph({
    alignment: getAlignment(style?.align),
    children: [
      new ExternalHyperlink({
        children: [
          new TextRun({
            text,
            font: style?.font,
            size: style?.size ? style.size * 2 : undefined,
            bold: style?.bold,
            italics: style?.italic,
            color: '0563C1',  // 标准链接蓝色
            underline: {}
          })
        ],
        link: url
      })
    ]
  })
}

/**
 * 创建书签段落
 */
function createBookmarkParagraph(text: string, bookmarkName: string, style?: ParagraphStyle): Paragraph {
  const indent = calcIndent(style?.indent)
  
  return new Paragraph({
    alignment: getAlignment(style?.align),
    indent: indent !== undefined ? { firstLine: indent } : undefined,
    children: [
      new Bookmark({
        id: bookmarkName,
        children: [
          new TextRun({
            text,
            font: style?.font,
            size: style?.size ? style.size * 2 : undefined,
            bold: style?.bold,
            italics: style?.italic,
            underline: style?.underline ? {} : undefined,
            color: style?.color,
            highlight: style?.highlight as any
          })
        ]
      })
    ]
  })
}

/**
 * 创建带批注的段落
 */
function createCommentParagraph(
  text: string, 
  commentText: string, 
  author: string,
  style?: ParagraphStyle,
  commentId: number = 1
): Paragraph {
  const indent = calcIndent(style?.indent)
  
  return new Paragraph({
    alignment: getAlignment(style?.align),
    indent: indent !== undefined ? { firstLine: indent } : undefined,
    children: [
      new CommentRangeStart(commentId),
      new TextRun({
        text,
        font: style?.font,
        size: style?.size ? style.size * 2 : undefined,
        bold: style?.bold,
        italics: style?.italic,
        underline: style?.underline ? {} : undefined,
        color: style?.color,
        highlight: style?.highlight as any
      }),
      new CommentRangeEnd(commentId),
      new CommentReference(commentId)
    ]
  })
}

/** 段落样式类型 */
type ParagraphStyle = {
  font?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string      // 十六进制颜色，如 "FF0000"
  highlight?: string  // 高亮色，如 "yellow"
  align?: 'left' | 'center' | 'right' | 'justify'  // 对齐方式
  indent?: number
}

/**
 * 将对齐字符串转换为 AlignmentType
 */
function getAlignment(align?: string): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (align) {
    case 'center': return AlignmentType.CENTER
    case 'right': return AlignmentType.RIGHT
    case 'justify': return AlignmentType.JUSTIFIED
    default: return AlignmentType.LEFT
  }
}

/**
 * 计算首行缩进（字符数转 twip）
 */
function calcIndent(chars?: number): number | undefined {
  if (chars === undefined || chars === null) return undefined
  if (chars === 0) return 0
  // 一个中文字符约等于 0.35 英寸
  return convertInchesToTwip(chars * 0.35)
}

/**
 * 创建标题段落
 */
function createHeading(text: string, level: number, style?: ParagraphStyle): Paragraph {
  const headingMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  }
  
  const indent = calcIndent(style?.indent)
  
  return new Paragraph({
    heading: headingMap[level] || HeadingLevel.HEADING_1,
    alignment: getAlignment(style?.align),
    indent: indent !== undefined ? { firstLine: indent } : undefined,
    children: [
      new TextRun({
        text,
        font: style?.font,
        bold: style?.bold ?? true,
        italics: style?.italic,
        underline: style?.underline ? {} : undefined,
        color: style?.color,
        highlight: style?.highlight as any,
        size: style?.size ? style.size * 2 : undefined // docx 使用半点为单位
      })
    ]
  })
}

/**
 * 创建普通段落
 */
function createParagraph(text: string, style?: ParagraphStyle): Paragraph {
  const indent = calcIndent(style?.indent)
  
  return new Paragraph({
    alignment: getAlignment(style?.align),
    indent: indent !== undefined ? { firstLine: indent } : undefined,
    children: [
      new TextRun({
        text,
        font: style?.font,
        bold: style?.bold,
        italics: style?.italic,
        underline: style?.underline ? {} : undefined,
        color: style?.color,
        highlight: style?.highlight as any,
        size: style?.size ? style.size * 2 : undefined
      })
    ]
  })
}

/**
 * 创建列表项
 */
function createBulletPoint(text: string, style?: ParagraphStyle): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    children: [
      new TextRun({
        text,
        font: style?.font,
        bold: style?.bold,
        italics: style?.italic,
        underline: style?.underline ? {} : undefined,
        color: style?.color,
        highlight: style?.highlight as any,
        size: style?.size ? style.size * 2 : undefined
      })
    ]
  })
}

/**
 * 创建表格
 */
function createTable(rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, rowIndex) => 
      new TableRow({
        children: row.map(cell => 
          new TableCell({
            children: [new Paragraph({ 
              children: [new TextRun({ 
                text: cell,
                bold: rowIndex === 0 // 表头加粗
              })] 
            })],
            borders: {
              top: { style: BorderStyle.SINGLE, size: 1 },
              bottom: { style: BorderStyle.SINGLE, size: 1 },
              left: { style: BorderStyle.SINGLE, size: 1 },
              right: { style: BorderStyle.SINGLE, size: 1 }
            }
          })
        )
      })
    )
  })
}

/**
 * 从末尾截断文本
 */
function truncateFromEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return '...' + text.slice(-maxLength + 3)
}

// ============ 快速模式工具 ============

/**
 * 从 Markdown 生成 Word 文档
 */
async function wordFromMarkdown(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  if (!args.path) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }
  if (!args.markdown) {
    return { success: false, output: '', error: t('word.markdown_required') }
  }
  
  let filePath = resolvePath(ptyId, args.path as string)
  const markdown = args.markdown as string
  const styleName = args.style as string | undefined
  
  // 确保文件扩展名为 .docx
  if (!filePath.toLowerCase().endsWith('.docx')) {
    filePath += '.docx'
  }

  // 加载自定义样式
  loadCustomStyles()
  
  // 获取样式配置
  let styleConfig: WordStyleConfig | string | undefined = styleName
  
  // 检查是否使用默认样式
  if (!styleName && defaultStyleName) {
    styleConfig = defaultStyleName
  }
  
  // 检查是否是自定义样式
  if (styleName && customStyles.has(styleName)) {
    styleConfig = customStyles.get(styleName)
  }

  // 需要用户确认
  executor.addStep({
    type: 'tool_call',
    content: t('word.confirm_create_from_md', { path: filePath }),
    toolName: 'word_from_markdown',
    toolArgs: { path: filePath, style: styleName },
    riskLevel: 'moderate'
  })

  const approved = await executor.waitForConfirmation(
    toolCallId,
    'word_from_markdown',
    { path: filePath },
    'moderate'
  )

  if (!approved) {
    return { success: false, output: '', error: t('word.user_rejected') }
  }

  try {
    // 如果文件已存在，创建备份
    if (fs.existsSync(filePath)) {
      const now = new Date()
      const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`
      const ext = path.extname(filePath)
      const baseName = filePath.slice(0, -ext.length)
      const backupPath = `${baseName}_${timestamp}${ext}.bak`
      fs.copyFileSync(filePath, backupPath)
    }

    // 转换 Markdown 为 docx
    const buffer = await markdownToDocx(markdown, styleConfig)
    
    // 确保目录存在
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    
    // 写入文件
    fs.writeFileSync(filePath, buffer)

    const styleInfo = typeof styleConfig === 'string' 
      ? styleConfig 
      : (styleConfig?.name || 'simple')
    const output = t('word.created_from_md', { path: filePath, style: styleInfo })

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'word_from_markdown',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('word.create_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

// ============ 样式管理工具 ============

/**
 * 创建自定义样式
 */
async function wordCreateStyle(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const name = args.name as string
  const fromTemplate = args.from_template as string | undefined
  const fromDescription = args.from_description as string | undefined
  const setAsDefault = args.set_as_default === true

  if (!name) {
    return { success: false, output: '', error: t('word.style_name_required') }
  }

  try {
    let styleConfig: WordStyleConfig

    if (fromTemplate) {
      // 从样板文档提取样式
      const templatePath = resolvePath(ptyId, fromTemplate)
      if (!fs.existsSync(templatePath)) {
        return { success: false, output: '', error: t('error.file_not_found', { path: templatePath }) }
      }
      
      styleConfig = await extractStyleFromTemplate(templatePath)
      styleConfig.name = name
      styleConfig.source = fromTemplate
      styleConfig.sourceType = 'template'
    } else if (fromDescription) {
      // 从格式说明文件解析（需要 AI 辅助）
      const descPath = resolvePath(ptyId, fromDescription)
      if (!fs.existsSync(descPath)) {
        return { success: false, output: '', error: t('error.file_not_found', { path: descPath }) }
      }
      
      // 读取文件内容
      const mammoth = await import('mammoth')
      let description: string
      
      if (descPath.toLowerCase().endsWith('.docx')) {
        const result = await mammoth.extractRawText({ path: descPath })
        description = result.value
      } else if (descPath.toLowerCase().endsWith('.pdf')) {
        // PDF 需要特殊处理，暂时返回提示
        const prompt = getStyleExtractionPrompt('（请使用 read_file 工具读取 PDF 内容后再试）')
        return { 
          success: false, 
          output: '', 
          error: t('word.pdf_style_hint', { prompt }) 
        }
      } else {
        // 文本文件
        description = fs.readFileSync(descPath, 'utf-8')
      }
      
      // 返回提示让 AI 解析
      const prompt = getStyleExtractionPrompt(description)
      const output = t('word.style_extraction_prompt', { name, prompt })
      
      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'word_create_style',
        toolResult: truncateFromEnd(output, 500)
      })
      
      return { 
        success: true, 
        output: output + '\n\n' + t('word.style_extraction_hint')
      }
    } else {
      // 创建空样式（使用默认配置）
      styleConfig = {
        name,
        sourceType: 'description',
        config: PRESET_STYLES.simple.config
      }
    }

    // 保存样式
    if (setAsDefault) {
      styleConfig.isDefault = true
      defaultStyleName = name
    }
    
    customStyles.set(name, styleConfig)
    
    // 持久化保存到知识库
    const docId = await saveStyleToKnowledge(styleConfig)
    if (!docId) {
      // 知识库不可用，保存到本地文件
      saveCustomStylesToFile()
    }

    const output = t('word.style_created', { name }) + 
      (setAsDefault ? '\n' + t('word.style_set_as_default', { name }) : '')

    executor.addStep({
      type: 'tool_result',
      content: output,
      toolName: 'word_create_style',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('word.style_create_failed')
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 列出所有可用样式
 */
async function wordListStyles(
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // 加载自定义样式
  loadCustomStyles()
  
  const lines: string[] = []
  
  // 预设样式
  lines.push('## 预设样式\n')
  for (const [id, style] of Object.entries(PRESET_STYLES)) {
    const isDefault = defaultStyleName === id
    lines.push(`- **${id}**：${style.name}${isDefault ? ' ⭐ (默认)' : ''}`)
  }
  
  // 自定义样式
  if (customStyles.size > 0) {
    lines.push('\n## 自定义样式\n')
    const entries = Array.from(customStyles.entries())
    for (const [name, style] of entries) {
      const isDefault = defaultStyleName === name
      const source = style.source ? ` (来源: ${style.source})` : ''
      lines.push(`- **${name}**${source}${isDefault ? ' ⭐ (默认)' : ''}`)
    }
  }
  
  if (!defaultStyleName) {
    lines.push('\n💡 提示：使用 word_set_default_style 设置默认样式')
  }

  const output = lines.join('\n')

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'word_list_styles',
    toolResult: output
  })

  return { success: true, output }
}

/**
 * 设置默认样式
 */
async function wordSetDefaultStyle(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  // 加载自定义样式
  loadCustomStyles()
  
  const name = args.name as string

  if (!name) {
    return { success: false, output: '', error: t('word.style_name_required') }
  }

  // 检查样式是否存在
  if (!PRESET_STYLES[name] && !customStyles.has(name)) {
    return { success: false, output: '', error: t('word.style_not_found', { name }) }
  }

  defaultStyleName = name
  
  // 持久化保存
  const knowledgeService = getKnowledgeService()
  if (knowledgeService && knowledgeService.isEnabled()) {
    await saveDefaultStyleSetting()
  } else {
    saveCustomStylesToFile()
  }
  
  const output = t('word.style_set_as_default', { name })

  executor.addStep({
    type: 'tool_result',
    content: output,
    toolName: 'word_set_default_style',
    toolResult: output
  })

  return { success: true, output }
}

