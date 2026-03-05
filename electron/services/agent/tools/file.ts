/**
 * 文件操作工具
 * 包括：文件搜索、读取文件、编辑文件、写入本地文件、写入远程文件
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { t } from '../i18n'
import { getTerminalStateService } from '../../terminal-state.service'
import { getFileSearchService } from '../../file-search.service'
import { getDocumentParserService } from '../../document-parser.service'
import { getConfigService } from '../../config.service'
import { categorizeError, getErrorRecoverySuggestion, truncateFromEnd, formatFileSize } from './utils'
import type { ToolExecutorConfig, AgentConfig, ToolResult } from './types'
import { VISION_IMAGE_EXTENSIONS, IMAGE_MIME_TYPES, CONVERTIBLE_IMAGE_EXTENSIONS } from './types'

/**
 * 获取 Agent workspace 目录路径
 */
export function getWorkspacePath(): string {
  return path.join(app.getPath('userData'), 'agent-workspace')
}

/**
 * 判断文件路径是否在 Agent workspace 内
 * 使用 realpath 解析符号链接，防止通过 symlink 绕过
 */
export function isInWorkspace(filePath: string): boolean {
  const workspace = getWorkspacePath()
  let resolved: string
  try {
    resolved = fs.realpathSync(path.resolve(filePath))
  } catch {
    // 文件不存在时 realpathSync 会抛异常，回退到 resolve 检查父目录链
    resolved = path.resolve(filePath)
    // 逐级向上查找已存在的祖先目录，用 realpath 验证
    let dir = path.dirname(resolved)
    while (dir !== path.dirname(dir)) {
      try {
        const realDir = fs.realpathSync(dir)
        resolved = path.join(realDir, path.relative(dir, resolved))
        break
      } catch {
        dir = path.dirname(dir)
      }
    }
  }
  const normalizedResolved = resolved.replace(/\\/g, '/')
  const normalizedWorkspace = workspace.replace(/\\/g, '/')
  return normalizedResolved.startsWith(normalizedWorkspace + '/') || normalizedResolved === normalizedWorkspace
}

/**
 * 文件搜索
 */
export async function fileSearch(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const terminalType = executor.terminalService.getTerminalType(ptyId)
  if (terminalType === 'ssh') {
    const errorMsg = t('error.file_search_ssh_not_supported')
    executor.addStep({
      type: 'tool_call',
      content: `🔍 ${t('file.searching')}...`,
      toolName: 'file_search',
      toolArgs: args,
      riskLevel: 'safe'
    })
    executor.addStep({
      type: 'tool_result',
      content: `❌ ${errorMsg}`,
      toolName: 'file_search',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  const query = args.query as string
  const searchPath = args.path as string | undefined
  const type = args.type as 'file' | 'dir' | 'all' | undefined
  const limit = args.limit as number | undefined

  if (!query) {
    return { success: false, output: '', error: t('error.query_required') }
  }

  executor.addStep({
    type: 'tool_call',
    content: `🔍 ${t('file.searching')}: "${query}"${searchPath ? ` in ${searchPath}` : ''}`,
    toolName: 'file_search',
    toolArgs: { query, path: searchPath, type, limit },
    riskLevel: 'safe'
  })

  try {
    const fileSearchService = getFileSearchService()
    const results = await fileSearchService.search({
      query,
      searchPath,
      type,
      limit: limit || 50
    })

    if (results.length === 0) {
      executor.addStep({
        type: 'tool_result',
        content: t('file.search_no_results'),
        toolName: 'file_search',
        toolResult: t('file.search_no_results_detail', { query })
      })
      return { success: true, output: t('file.search_no_results_detail', { query }) }
    }

    const formattedResults = results.map((r, i) => {
      const icon = r.isDirectory ? '📁' : '📄'
      const sizeStr = r.size !== undefined ? ` (${formatFileSize(r.size)})` : ''
      const modTime = r.modifiedTime 
        ? ` [${t('file.modified')}: ${new Date(r.modifiedTime).toLocaleString()}]` 
        : ''
      const createTime = r.createdTime 
        ? ` [${t('file.created')}: ${new Date(r.createdTime).toLocaleString()}]` 
        : ''
      return `${i + 1}. ${icon} ${r.path}${sizeStr}${modTime}${createTime}`
    }).join('\n')

    const output = `${t('file.search_found', { count: results.length })}:\n\n${formattedResults}`

    executor.addStep({
      type: 'tool_result',
      content: t('file.search_found', { count: results.length }),
      toolName: 'file_search',
      toolResult: results.length > 10 
        ? formattedResults.split('\n').slice(0, 10).join('\n') + `\n... ${t('file.search_more', { count: results.length - 10 })}`
        : formattedResults
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.search_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.search_failed')}: ${errorMsg}`,
      toolName: 'file_search',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 检测是否为文档类型
 */
function isDocumentType(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return ['.pdf', '.docx', '.doc', '.xlsx', '.xls'].includes(ext)
}

/**
 * 检测是否为 AI Vision 可处理的图片类型
 */
function isVisionImageType(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return VISION_IMAGE_EXTENSIONS.has(ext)
}

const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB

/**
 * 读取图片文件为 base64 data URL，返回给 AI 进行视觉分析
 */
function readImageFile(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): ToolResult {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  const mime = IMAGE_MIME_TYPES[ext]
  if (!mime) {
    return { success: false, output: '', error: t('file.unsupported_format') }
  }

  if (fileSize > MAX_IMAGE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1)
    const errorMsg = t('file.image_too_large', { size: sizeMB })
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  try {
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:${mime};base64,${base64}`

    const sizeDisplay = formatFileSize(fileSize)

    executor.addStep({
      type: 'tool_result',
      content: t('file.image_read_success', { name: fileName, size: sizeDisplay }),
      toolName: 'read_file',
      toolResult: `${fileName} (${sizeDisplay})`,
      images: [dataUrl]
    })

    return {
      success: true,
      output: t('file.image_read_output', { name: fileName, size: sizeDisplay, path: filePath }),
      images: [dataUrl]
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.read_error')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

function hasVisionCapability(): boolean {
  try {
    return getConfigService().hasVisionCapability()
  } catch {
    return false
  }
}

/**
 * 从 ICO 文件中提取最大尺寸的 PNG 图片
 * ICO 格式: 6 字节头(reserved + type + count) + N * 16 字节目录项 + 图片数据
 */
function extractIcoLargestPng(filePath: string): { png: Buffer; width: number; height: number } | null {
  const buf = fs.readFileSync(filePath)
  if (buf.length < 6) return null

  const type = buf.readUInt16LE(2)
  if (type !== 1 && type !== 2) return null // 1=ICO, 2=CUR
  const count = buf.readUInt16LE(4)
  if (count === 0 || count > 256) return null

  let bestIdx = -1
  let bestPixels = 0
  let bestDataSize = 0

  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16
    if (off + 16 > buf.length) break
    const w = buf[off] || 256 // 0 means 256
    const h = buf[off + 1] || 256
    const dataSize = buf.readUInt32LE(off + 8)
    const pixels = w * h
    if (pixels > bestPixels || (pixels === bestPixels && dataSize > bestDataSize)) {
      bestIdx = i
      bestPixels = pixels
      bestDataSize = dataSize
    }
  }

  if (bestIdx < 0) return null

  const entry = 6 + bestIdx * 16
  const w = buf[entry] || 256
  const h = buf[entry + 1] || 256
  const dataSize = buf.readUInt32LE(entry + 8)
  const dataOffset = buf.readUInt32LE(entry + 12)
  if (dataSize === 0 || dataOffset + dataSize > buf.length) return null

  const imageData = buf.subarray(dataOffset, dataOffset + dataSize)

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  if (imageData.length >= 8 && imageData.subarray(0, 8).equals(PNG_MAGIC)) {
    return { png: Buffer.from(imageData), width: w, height: h }
  }

  // BMP data — 目前不转换，返回 null
  return null
}

/**
 * 获取 ICO 文件中所有图标的尺寸信息（用于描述无法提取 PNG 的情况）
 */
function describeIcoEntries(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 6) return null
    const type = buf.readUInt16LE(2)
    if (type !== 1 && type !== 2) return null
    const count = buf.readUInt16LE(4)
    if (count === 0 || count > 256) return null

    const sizes: string[] = []
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16
      if (off + 16 > buf.length) break
      const w = buf[off] || 256
      const h = buf[off + 1] || 256
      sizes.push(`${w}x${h}`)
    }
    return sizes.join(', ')
  } catch {
    return null
  }
}

/**
 * 读取需要转换的图片格式（如 ICO），提取为 PNG 后走视觉通道
 */
function readConvertibleImage(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): ToolResult {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)

  if (fileSize > MAX_IMAGE_SIZE) {
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(1)
    const errorMsg = t('file.image_too_large', { size: sizeMB })
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }

  try {
    if (ext === '.ico') {
      const result = extractIcoLargestPng(filePath)
      if (result) {
        const base64 = result.png.toString('base64')
        const dataUrl = `data:image/png;base64,${base64}`
        const sizeDisplay = formatFileSize(fileSize)

        executor.addStep({
          type: 'tool_result',
          content: t('file.image_read_success', { name: fileName, size: sizeDisplay }),
          toolName: 'read_file',
          toolResult: `${fileName} (${sizeDisplay}, ${result.width}x${result.height})`,
          images: [dataUrl]
        })

        return {
          success: true,
          output: t('file.image_converted_output', {
            name: fileName, size: sizeDisplay, path: filePath,
            format: 'ICO', width: result.width, height: result.height
          }),
          images: [dataUrl]
        }
      }

      // PNG 提取失败（BMP 格式），返回描述信息
      const sizes = describeIcoEntries(filePath)
      const sizeDisplay = formatFileSize(fileSize)
      const desc = t('file.ico_bmp_only', { name: fileName, size: sizeDisplay, sizes: sizes || 'unknown' })
      executor.addStep({
        type: 'tool_result',
        content: desc,
        toolName: 'read_file',
        toolResult: desc
      })
      return { success: true, output: desc }
    }

    return { success: false, output: '', error: t('file.unsupported_format') }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.read_error')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 通过头部 null byte 检测判断是否为二进制文件（与 git 同一策略）
 * 额外识别 UTF-16/UTF-32 BOM 避免误判 Unicode 文本为二进制
 */
function isLikelyBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const stats = fs.fstatSync(fd)
      if (stats.size < 4) return false
      const buf = Buffer.alloc(Math.min(8000, stats.size))
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      if (bytesRead >= 2) {
        // UTF-16 LE BOM: FF FE / UTF-16 BE BOM: FE FF / UTF-8 BOM: EF BB BF
        if ((buf[0] === 0xFF && buf[1] === 0xFE) ||
            (buf[0] === 0xFE && buf[1] === 0xFF) ||
            (bytesRead >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) {
          return false
        }
      }
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0) return true
      }
      return false
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return true
  }
}

async function readDocumentFile(
  filePath: string,
  fileSize: number,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const ext = path.extname(filePath).toLowerCase()
  const fileName = path.basename(filePath)
  
  try {
    const documentParser = getDocumentParserService()
    const extractImages = hasVisionCapability()
    
    const result = await documentParser.parseDocument({
      name: fileName,
      path: filePath,
      size: fileSize
    }, {
      maxFileSize: 10 * 1024 * 1024,
      maxTextLength: 100000,
      extractImages
    })

    const hasContent = result.content && result.content.length > 0
    const hasImages = result.images && result.images.length > 0

    // 1) 扫描件 PDF：无文本，仅图片
    if (!hasContent && hasImages) {
      if (ext === '.pdf' && executor.skillSession) {
        try {
          await executor.skillSession.loadSkill('pdf')
        } catch (_) { /* skill already loaded or unavailable */ }
      }

      const totalPages = result.totalPages || result.pageCount || 0
      const output = t('pdf.scanned_pdf_detected', {
        name: fileName,
        totalPages,
        path: filePath
      })

      executor.addStep({
        type: 'tool_result',
        content: output,
        toolName: 'read_file',
        toolResult: output,
        images: result.images
      })

      return { success: true, output, images: result.images }
    }

    // 2) 解析失败
    if (result.error) {
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${result.error}`,
        toolName: 'read_file',
        toolResult: result.error
      })
      return { success: false, output: '', error: result.error }
    }

    // 3) 有文本（可能也有图片：图文混排 PDF / Word 含图）
    const docInfo: string[] = []
    docInfo.push(`📄 ${fileName}`)
    docInfo.push(`${ext.toUpperCase().slice(1)} ${t('file.document_parsed')}`)
    if (result.pageCount) {
      docInfo.push(`${t('file.page_count')}: ${result.pageCount}`)
    }
    docInfo.push(`${t('file.content_length')}: ${result.content.length.toLocaleString()} ${t('file.chars')}`)
    if (hasImages) {
      docInfo.push(`${t('file.images_extracted')}: ${result.images!.length}`)
    }

    // 图文混排 PDF：加载 pdf 技能以支持查看更多页
    if (hasImages && ext === '.pdf' && executor.skillSession) {
      try {
        await executor.skillSession.loadSkill('pdf')
      } catch (_) { /* skill already loaded or unavailable */ }
    }

    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_success')}: ${docInfo.join(', ')}`,
      toolName: 'read_file',
      toolResult: truncateFromEnd(result.content, 500),
      images: hasImages ? result.images : undefined
    })

    return { success: true, output: result.content, images: hasImages ? result.images : undefined }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.parse_failed')
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: errorMsg
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 读取文件
 */
export async function readFile(
  ptyId: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = args.path as string
  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  if (!path.isAbsolute(filePath)) {
    const terminalStateService = getTerminalStateService()
    const cwd = terminalStateService.getCwd(ptyId)
    filePath = path.resolve(cwd, filePath)
  }

  const infoOnly = args.info_only === true
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const maxLines = args.max_lines as number | undefined
  const tailLines = args.tail_lines as number | undefined

  if (config.debugMode) {
    executor.addStep({
      type: 'tool_call',
      content: infoOnly ? `${t('file.reading_info_only')}: ${filePath}` : `${t('file.reading')}: ${filePath}`,
      toolName: 'read_file',
      toolArgs: args,
      riskLevel: 'safe'
    })
  }

  try {
    const stats = fs.statSync(filePath)
    const fileSize = stats.size
    const sizeMB = (fileSize / (1024 * 1024)).toFixed(2)

    if (isDocumentType(filePath) && !infoOnly) {
      return await readDocumentFile(filePath, fileSize, executor)
    }

    if (isVisionImageType(filePath)) {
      if (infoOnly) {
        const ext = path.extname(filePath).toLowerCase()
        const maxMB = MAX_IMAGE_SIZE / 1024 / 1024
        const canRead = fileSize <= MAX_IMAGE_SIZE
        const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.image_type')}**: ${ext.slice(1).toUpperCase()}
- **${t('file.image_readable')}**: ${canRead ? t('file.image_readable_yes') : t('file.image_readable_no', { max: maxMB })}`

        executor.addStep({
          type: 'tool_result',
          content: `${t('file.file_info')}: ${sizeMB} MB, ${t('file.image_type_short')}`,
          toolName: 'read_file',
          toolResult: info
        })
        return { success: true, output: info }
      }
      return readImageFile(filePath, fileSize, executor)
    }

    // 需要转换的图片格式（如 ICO），提取内嵌 PNG 后走视觉通道
    {
      const ext = path.extname(filePath).toLowerCase()
      if (CONVERTIBLE_IMAGE_EXTENSIONS.has(ext)) {
        if (infoOnly) {
          const sizes = ext === '.ico' ? describeIcoEntries(filePath) : null
          const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.image_type')}**: ${ext.slice(1).toUpperCase()}${sizes ? `\n- **${t('file.ico_sizes')}**: ${sizes}` : ''}
- **${t('file.image_readable')}**: ${t('file.image_readable_yes')}`

          executor.addStep({
            type: 'tool_result',
            content: `${t('file.file_info')}: ${sizeMB} MB, ${t('file.image_type_short')}`,
            toolName: 'read_file',
            toolResult: info
          })
          return { success: true, output: info }
        }
        return readConvertibleImage(filePath, fileSize, executor)
      }
    }

    // 提前检测二进制，供 infoOnly 和文本读取路径共用
    const detectedBinary = isLikelyBinary(filePath)

    if (infoOnly) {
      if (detectedBinary) {
        const ext = path.extname(filePath).toLowerCase()
        const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.image_type')}**: ${ext.slice(1).toUpperCase() || 'unknown'}
- **${t('file.is_binary')}**`

        executor.addStep({
          type: 'tool_result',
          content: `${t('file.file_info')}: ${sizeMB} MB, ${t('file.is_binary')}`,
          toolName: 'read_file',
          toolResult: info
        })
        return { success: true, output: info }
      }

      let totalLines = 0
      let sampleContent = ''
      let estimated = false
      
      try {
        if (fileSize <= 10 * 1024 * 1024) {
          const fullContent = fs.readFileSync(filePath, 'utf-8')
          const lines = fullContent.split('\n')
          totalLines = lines.length
          sampleContent = lines.slice(0, 10).join('\n')
        } else {
          const sampleSize = Math.min(100 * 1024, fileSize)
          const buffer = Buffer.alloc(sampleSize)
          const fd = fs.openSync(filePath, 'r')
          fs.readSync(fd, buffer, 0, sampleSize, 0)
          fs.closeSync(fd)
          
          const sample = buffer.toString('utf-8')
          const sampleLines = sample.split('\n')
          const avgLineLength = sample.length / sampleLines.length
          totalLines = Math.floor(fileSize / avgLineLength)
          estimated = true
          sampleContent = sampleLines.slice(0, 10).join('\n')
        }
      } catch {
        totalLines = Math.floor(fileSize / 80)
        estimated = true
      }

      const info = `## ${t('file.info_header')}
- **${t('file.info_path')}**: ${filePath}
- **${t('file.info_size')}**: ${t('file.info_size_value', { sizeMB, sizeBytes: fileSize.toLocaleString() })}
- **${t('file.info_lines')}**: ${t('file.info_lines_value', { count: totalLines.toLocaleString() })}${estimated ? ` ${t('file.info_estimated')}` : ''}
- **${t('file.info_suggestion')}**: ${fileSize > 500 * 1024 ? t('file.info_suggestion_large') : t('file.info_suggestion_small')}

${sampleContent ? `### ${t('file.info_preview')}\n\`\`\`\n${sampleContent}\n\`\`\`` : ''}`

      executor.addStep({
        type: 'tool_result',
        content: `${t('file.file_info')}: ${sizeMB} MB, ${totalLines.toLocaleString()}`,
        toolName: 'read_file',
        toolResult: info
      })
      return { success: true, output: info }
    }

    // 二进制文件检测：防止把二进制数据当文本读给 AI
    if (detectedBinary) {
      const ext = path.extname(filePath).toLowerCase()
      const sizeDisplay = formatFileSize(fileSize)
      const fileName = path.basename(filePath)
      const errorMsg = t('file.binary_file_detected', { name: fileName, size: sizeDisplay, ext: ext || 'unknown' })
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.read_failed')}: ${t('file.is_binary')}`,
        toolName: 'read_file',
        toolResult: errorMsg
      })
      return { success: false, output: '', error: errorMsg }
    }

    let content = ''
    let actualLines: string[] = []
    let totalLines: number | undefined
    let isPartialRead = false

    const formatBytes = (bytes: number): string => {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    }

    if (startLine !== undefined || endLine !== undefined) {
      const fullContent = fs.readFileSync(filePath, 'utf-8')
      const allLines = fullContent.split('\n')
      totalLines = allLines.length
      const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0
      const end = endLine !== undefined ? Math.min(allLines.length, endLine) : allLines.length
      actualLines = allLines.slice(start, end)
      content = actualLines.join('\n')
      isPartialRead = actualLines.length < allLines.length
    } else if (maxLines !== undefined) {
      const fullContent = fs.readFileSync(filePath, 'utf-8')
      const allLines = fullContent.split('\n')
      totalLines = allLines.length
      actualLines = allLines.slice(0, maxLines)
      content = actualLines.join('\n')
      isPartialRead = actualLines.length < allLines.length
    } else if (tailLines !== undefined) {
      const fullContent = fs.readFileSync(filePath, 'utf-8')
      const allLines = fullContent.split('\n')
      totalLines = allLines.length
      actualLines = allLines.slice(-tailLines)
      content = actualLines.join('\n')
      isPartialRead = actualLines.length < allLines.length
    } else {
      const maxFileSize = 500 * 1024
      if (fileSize > maxFileSize) {
        const errorMsg = t('file.too_large_error', { size: sizeMB })
        executor.addStep({
          type: 'tool_result',
          content: `${t('file.read_failed')}: ${t('file.file_too_large')}`,
          toolName: 'read_file',
          toolResult: errorMsg
        })
        return { success: false, output: '', error: errorMsg }
      }
      content = fs.readFileSync(filePath, 'utf-8')
      actualLines = content.split('\n')
    }

    const readInfo: string[] = []
    if (startLine !== undefined || endLine !== undefined) {
      readInfo.push(t('file.read_line_range', { start: startLine || 1, end: endLine || t('file.end_of_file') }))
    } else if (maxLines !== undefined) {
      readInfo.push(t('file.read_first_n', { count: maxLines }))
    } else if (tailLines !== undefined) {
      readInfo.push(t('file.read_last_n', { count: tailLines }))
    } else {
      readInfo.push(t('file.full_read'))
    }
    
    if (isPartialRead && totalLines !== undefined) {
      readInfo.push(t('file.partial_read_stats', {
        totalLines,
        totalBytes: formatBytes(fileSize),
        lines: actualLines.length,
        chars: formatBytes(content.length)
      }))
    } else {
      readInfo.push(t('file.actual_read', { lines: actualLines.length, chars: content.length.toLocaleString() }))
    }

    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_success')}: ${readInfo.join(', ')}`,
      toolName: 'read_file',
      toolResult: truncateFromEnd(content, 500)
    })
    
    return { success: true, output: content }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '读取失败'
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.read_failed')}: ${errorMsg}`,
      toolName: 'read_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 精确编辑本地文件
 */
export async function editFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = args.path as string
  const oldText = args.old_text as string
  const newText = args.new_text as string

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  if (oldText === undefined || oldText === null) {
    return { success: false, output: '', error: t('error.old_text_required') }
  }

  if (newText === undefined || newText === null) {
    return { success: false, output: '', error: t('error.new_text_required') }
  }

  if (!path.isAbsolute(filePath)) {
    const terminalStateService = getTerminalStateService()
    const cwd = terminalStateService.getCwd(ptyId)
    filePath = path.resolve(cwd, filePath)
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, output: '', error: t('error.file_not_exists', { path: filePath }) }
  }

  const oldTextPreview = oldText.length > 50 ? oldText.substring(0, 50) + '...' : oldText
  const newTextPreview = newText.length > 50 ? newText.substring(0, 50) + '...' : newText
  
  const inWorkspace = isInWorkspace(filePath)

  executor.addStep({
    type: 'tool_call',
    content: `${t('file.edit')}: ${filePath}`,
    toolName: 'edit_file',
    toolArgs: { 
      path: filePath, 
      old_text: oldTextPreview,
      new_text: newTextPreview
    },
    riskLevel: inWorkspace ? 'safe' : 'moderate'
  })

  if (!inWorkspace && config.executionMode === 'strict') {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'edit_file', 
      args, 
      'moderate'
    )
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  try {
    const fileContent = fs.readFileSync(filePath, 'utf-8')
    const occurrences = fileContent.split(oldText).length - 1

    if (occurrences === 0) {
      const errorMsg = t('error.old_text_not_found')
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.edit_failed')}: ${errorMsg}`,
        toolName: 'edit_file',
        toolResult: `${errorMsg}\n\n${t('hint.old_text_not_found')}`
      })
      return { success: false, output: '', error: errorMsg }
    }

    if (occurrences > 1) {
      const errorMsg = t('error.old_text_multiple_matches', { count: occurrences })
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.edit_failed')}: ${errorMsg}`,
        toolName: 'edit_file',
        toolResult: `${errorMsg}\n\n${t('hint.old_text_multiple_matches')}`
      })
      return { success: false, output: '', error: errorMsg }
    }

    const newContent = fileContent.replace(oldText, newText)
    fs.writeFileSync(filePath, newContent, 'utf-8')

    const resultMsg = t('file.edit_success', { path: filePath })
    executor.addStep({
      type: 'tool_result',
      content: resultMsg,
      toolName: 'edit_file'
    })

    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.edit_failed')
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.edit_failed')}: ${errorMsg}`,
      toolName: 'edit_file',
      toolResult: `${errorMsg}\n\n💡 ${suggestion}`
    })
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 写入本地文件
 */
export async function writeLocalFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  let filePath = args.path as string
  const content = args.content as string | undefined
  const mode = (args.mode as string) || 'create'
  const insertAtLine = args.insert_at_line as number | undefined
  const startLine = args.start_line as number | undefined
  const endLine = args.end_line as number | undefined
  const pattern = args.pattern as string | undefined
  const replacement = args.replacement as string | undefined
  const replaceAll = args.replace_all !== false

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  const validModes = ['overwrite', 'create', 'append', 'insert', 'replace_lines', 'regex_replace']
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: t('error.invalid_write_mode', { mode, modes: validModes.join(', ') }) }
  }

  // 验证各模式的必要参数
  if (mode === 'overwrite' || mode === 'create' || mode === 'append') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.content_required_for_mode', { mode }) }
    }
  } else if (mode === 'insert') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.insert_content_required') }
    }
    if (insertAtLine === undefined || insertAtLine < 1) {
      return { success: false, output: '', error: t('error.insert_line_required') }
    }
  } else if (mode === 'replace_lines') {
    if (content === undefined) {
      return { success: false, output: '', error: t('error.replace_content_required') }
    }
    if (startLine === undefined || startLine < 1) {
      return { success: false, output: '', error: t('error.replace_start_line_required') }
    }
    if (endLine === undefined || endLine < startLine) {
      return { success: false, output: '', error: t('error.replace_end_line_required') }
    }
  } else if (mode === 'regex_replace') {
    if (pattern === undefined) {
      return { success: false, output: '', error: t('error.regex_pattern_required') }
    }
    if (replacement === undefined) {
      return { success: false, output: '', error: t('error.regex_replacement_required') }
    }
  }

  if (!path.isAbsolute(filePath)) {
    const terminalStateService = getTerminalStateService()
    const cwd = terminalStateService.getCwd(ptyId)
    filePath = path.resolve(cwd, filePath)
  }

  // Office 扩展名自动转为 .md（无法生成真正的 Office 文档）
  const officeExt = ['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']
  if (officeExt.includes(path.extname(filePath).toLowerCase())) {
    const original = path.basename(filePath)
    filePath = filePath.replace(/\.(docx?|xlsx?|pptx?)$/i, '.md')
    executor.addStep({
      type: 'tool_result',
      content: `⚠️ ${t('file.office_extension_converted', { original, converted: path.basename(filePath) })}`,
      toolName: 'write_local_file'
    })
  }

  let operationDesc = ''
  switch (mode) {
    case 'overwrite':
      operationDesc = `${t('file.overwrite')}: ${filePath}`
      break
    case 'create':
      operationDesc = `${t('file.create')}: ${filePath}`
      break
    case 'append':
      operationDesc = `${t('file.append')}: ${filePath}`
      break
    case 'insert':
      operationDesc = `${t('file.insert_at_line', { line: insertAtLine! })}: ${filePath}`
      break
    case 'replace_lines':
      operationDesc = `${t('file.replace_lines', { start: startLine!, end: endLine! })}: ${filePath}`
      break
    case 'regex_replace':
      operationDesc = `${t('file.regex_replace', { scope: replaceAll ? t('file.regex_scope_all') : t('file.regex_scope_first') })}: ${filePath}`
      break
  }

  const fileExists = fs.existsSync(filePath)
  const inWorkspace = isInWorkspace(filePath)
  const isDangerousOverwrite = mode === 'overwrite' && fileExists && !inWorkspace

  executor.addStep({
    type: 'tool_call',
    content: operationDesc,
    toolName: 'write_local_file',
    toolArgs: { 
      path: filePath, 
      mode,
      ...(content !== undefined && { content: content.length > 100 ? content.substring(0, 100) + '...' : content }),
      ...(insertAtLine !== undefined && { insert_at_line: insertAtLine }),
      ...(startLine !== undefined && { start_line: startLine }),
      ...(endLine !== undefined && { end_line: endLine }),
      ...(pattern !== undefined && { pattern }),
      ...(replacement !== undefined && { replacement })
    },
    riskLevel: inWorkspace ? 'safe' : (isDangerousOverwrite ? 'dangerous' : 'moderate')
  })

  if (!inWorkspace && (isDangerousOverwrite || config.executionMode === 'strict')) {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'write_local_file', 
      args, 
      isDangerousOverwrite ? 'dangerous' : 'moderate'
    )
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  const contentLength = content?.length || 0
  const contentSizeKB = (contentLength / 1024).toFixed(1)
  const isLargeContent = contentLength > 10000

  let progressStepId: string | undefined
  if (isLargeContent) {
    const progressStep = executor.addStep({
      type: 'tool_result',
      content: `⏳ ${t('file.writing_progress')}（${contentSizeKB} KB）`,
      toolName: 'write_local_file',
      isStreaming: true
    })
    progressStepId = progressStep.id
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    let resultMsg = ''
    const fileExistsNow = fs.existsSync(filePath)

    switch (mode) {
      case 'overwrite': {
        fs.writeFileSync(filePath, content!, 'utf-8')
        resultMsg = `${fileExistsNow ? t('file.result_overwritten') : t('file.result_created')}: ${filePath}`
        break
      }
      case 'create': {
        if (fileExistsNow) {
          const errorMsg = t('error.file_exists_cannot_create', { path: filePath })
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_local_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        fs.writeFileSync(filePath, content!, 'utf-8')
        resultMsg = `${t('file.result_created')}: ${filePath}`
        break
      }
      case 'append': {
        fs.appendFileSync(filePath, content!, 'utf-8')
        resultMsg = `${t('file.result_appended')}: ${filePath}`
        break
      }
      case 'insert': {
        if (!fileExistsNow) {
          const errorMsg = t('error.file_not_exists_for_insert')
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_local_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
        const insertIndex = Math.min(insertAtLine! - 1, lines.length)
        const contentLines = content!.split('\n')
        lines.splice(insertIndex, 0, ...contentLines)
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
        resultMsg = `${t('file.result_inserted', { line: insertAtLine!, count: contentLines.length })}: ${filePath}`
        break
      }
      case 'replace_lines': {
        if (!fileExistsNow) {
          const errorMsg = t('error.file_not_exists_for_replace')
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_local_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n')
        const totalLines = lines.length
        if (startLine! > totalLines) {
          const errorMsg = t('error.start_line_exceeds_total', { start: startLine!, total: totalLines })
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_local_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const actualEndLine = Math.min(endLine!, totalLines)
        const deleteCount = actualEndLine - startLine! + 1
        const contentLines = content!.split('\n')
        lines.splice(startLine! - 1, deleteCount, ...contentLines)
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
        resultMsg = `${t('file.result_replaced_lines', { start: startLine!, end: actualEndLine, deleteCount, newCount: contentLines.length })}: ${filePath}`
        break
      }
      case 'regex_replace': {
        if (!fileExistsNow) {
          const errorMsg = t('error.file_not_exists_for_regex')
          executor.addStep({
            type: 'tool_result',
            content: `❌ ${errorMsg}`,
            toolName: 'write_local_file'
          })
          return { success: false, output: '', error: errorMsg }
        }
        const fileContent = fs.readFileSync(filePath, 'utf-8')
        let regex: RegExp
        try {
          regex = new RegExp(pattern!, replaceAll ? 'g' : '')
        } catch {
          return { success: false, output: '', error: t('error.invalid_regex_pattern', { pattern: pattern! }) }
        }
        const matches = fileContent.match(regex)
        if (!matches || matches.length === 0) {
          return { success: false, output: '', error: t('error.regex_no_match', { pattern: pattern! }) }
        }
        const newContent = fileContent.replace(regex, replacement!)
        fs.writeFileSync(filePath, newContent, 'utf-8')
        resultMsg = `${t('file.result_regex_replaced', { count: matches.length })}: ${filePath}`
        break
      }
    }

    if (progressStepId) {
      executor.updateStep(progressStepId, {
        type: 'tool_result',
        content: `✅ ${resultMsg}`,
        toolName: 'write_local_file',
        isStreaming: false
      })
    } else {
      executor.addStep({
        type: 'tool_result',
        content: resultMsg,
        toolName: 'write_local_file'
      })
    }
    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.write_failed')
    const errorCategory = categorizeError(errorMsg)
    const suggestion = getErrorRecoverySuggestion(errorMsg, errorCategory)
    
    if (progressStepId) {
      executor.updateStep(progressStepId, {
        type: 'tool_result',
        content: `❌ ${t('file.write_failed')}: ${errorMsg}`,
        toolName: 'write_local_file',
        toolResult: `${errorMsg}\n\n💡 ${suggestion}`,
        isStreaming: false
      })
    } else {
      executor.addStep({
        type: 'tool_result',
        content: `${t('file.write_failed')}: ${errorMsg}`,
        toolName: 'write_local_file',
        toolResult: `${errorMsg}\n\n💡 ${suggestion}`
      })
    }
    return { success: false, output: '', error: t('error.recovery_hint', { error: errorMsg, suggestion }) }
  }
}

/**
 * 写入远程文件（通过 SFTP）
 */
export async function writeRemoteFile(
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const filePath = args.path as string
  const content = args.content as string
  const mode = (args.mode as string) || 'create'

  if (!filePath) {
    return { success: false, output: '', error: t('error.file_path_required') }
  }

  if (content === undefined) {
    return { success: false, output: '', error: t('error.content_required_for_mode', { mode }) }
  }

  const validModes = ['create', 'overwrite', 'append']
  if (!validModes.includes(mode)) {
    return { success: false, output: '', error: t('error.invalid_write_mode', { mode, modes: validModes.join(', ') }) }
  }

  return writeFileViaSftp(ptyId, filePath, content, mode as 'create' | 'overwrite' | 'append', toolCallId, config, executor)
}

/**
 * 通过 SFTP 写入远程文件
 */
async function writeFileViaSftp(
  ptyId: string,
  filePath: string,
  content: string,
  mode: 'overwrite' | 'create' | 'append',
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const sftpService = executor.getSftpService?.()
  const sshConfig = executor.getSshConfig?.(ptyId)

  if (!sftpService) {
    return { 
      success: false, 
      output: '', 
      error: t('error.sftp_not_initialized') 
    }
  }

  if (!sshConfig) {
    return { 
      success: false, 
      output: '', 
      error: t('error.ssh_config_unavailable') 
    }
  }

  const contentLength = content.length
  const contentSizeKB = (contentLength / 1024).toFixed(1)

  let operationDesc = ''
  switch (mode) {
    case 'overwrite':
      operationDesc = `${t('file.overwrite')}: ${filePath}`
      break
    case 'create':
      operationDesc = `${t('file.create')}: ${filePath}`
      break
    case 'append':
      operationDesc = `${t('file.append')}: ${filePath}`
      break
  }

  executor.addStep({
    type: 'tool_call',
    content: operationDesc,
    toolName: 'write_remote_file',
    toolArgs: { 
      path: filePath, 
      mode,
      content: content.length > 100 ? content.substring(0, 100) + '...' : content
    },
    riskLevel: mode === 'overwrite' ? 'dangerous' : 'moderate'
  })

  if (mode === 'overwrite' || config.executionMode === 'strict') {
    const approved = await executor.waitForConfirmation(
      toolCallId, 
      'write_remote_file', 
      { path: filePath, mode, content }, 
      mode === 'overwrite' ? 'dangerous' : 'moderate'
    )
    if (!approved) {
      return { success: false, output: '', error: t('file.user_rejected_write') }
    }
  }

  executor.terminalService.write(ptyId, `echo "📝 ${t('file.writing_remote', { path: filePath, size: contentSizeKB })}"\r`)
  
  await new Promise(resolve => setTimeout(resolve, 300))

  try {
    if (!sftpService.hasSession(ptyId)) {
      executor.addStep({
        type: 'tool_result',
        content: t('file.establishing_sftp'),
        toolName: 'write_remote_file',
        isStreaming: true
      })

      const sftpConfig = {
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        password: sshConfig.password,
        privateKey: sshConfig.privateKey,
        privateKeyPath: sshConfig.privateKeyPath,
        passphrase: sshConfig.passphrase
      }

      await sftpService.connect(ptyId, sftpConfig)
    }

    let resultMsg: string
    if (mode === 'create') {
      let fileExists = false
      try {
        await sftpService.readFile(ptyId, filePath)
        fileExists = true
      } catch {
        // 文件不存在
      }
      if (fileExists) {
        const errorMsg = t('error.file_exists_cannot_create', { path: filePath })
        executor.addStep({
          type: 'tool_result',
          content: `❌ ${errorMsg}`,
          toolName: 'write_remote_file'
        })
        return { success: false, output: '', error: errorMsg }
      }
      await sftpService.writeFile(ptyId, filePath, content)
      resultMsg = `${t('file.result_remote_created')}: ${filePath}`
    } else if (mode === 'append') {
      let existingContent = ''
      try {
        existingContent = await sftpService.readFile(ptyId, filePath)
      } catch {
        // 文件不存在
      }
      await sftpService.writeFile(ptyId, filePath, existingContent + content)
      resultMsg = `${t('file.result_remote_appended')}: ${filePath}`
    } else {
      await sftpService.writeFile(ptyId, filePath, content)
      resultMsg = `${t('file.result_remote_written')}: ${filePath}`
    }

    executor.terminalService.write(ptyId, `echo "✅ ${t('file.write_success')}: ${filePath}"\r`)
    
    await new Promise(resolve => setTimeout(resolve, 300))

    executor.addStep({
      type: 'tool_result',
      content: resultMsg,
      toolName: 'write_remote_file'
    })

    return { success: true, output: resultMsg }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : t('file.remote_write_failed')
    
    executor.terminalService.write(ptyId, `echo "❌ ${t('file.write_failed')}: ${errorMsg}"\r`)
    
    executor.addStep({
      type: 'tool_result',
      content: `${t('file.remote_write_failed')}: ${errorMsg}`,
      toolName: 'write_remote_file',
      toolResult: errorMsg
    })

    return { success: false, output: '', error: `${t('file.remote_write_failed')}: ${errorMsg}` }
  }
}
