/**
 * Docx XML 操作模块
 * 提供直接操作 .docx ZIP/XML 的核心函数
 * 用于编辑已有文档时保留原始格式
 */

import * as fs from 'fs'
import JSZip from 'jszip'

// ============ 文件读写 ============

/**
 * 读取 docx 文件，返回 JSZip 实例和 document.xml 内容
 */
export async function readDocx(filePath: string): Promise<{ zip: JSZip; documentXml: string }> {
  const data = fs.readFileSync(filePath)
  const zip = await JSZip.loadAsync(data)

  const docFile = zip.file('word/document.xml')
  if (!docFile) {
    throw new Error('无效的 docx 文件：找不到 word/document.xml')
  }

  const documentXml = await docFile.async('string')
  return { zip, documentXml }
}

/**
 * 将修改后的 document.xml 写回 docx 文件
 * 注意：备份由调用方（wordSave）统一管理
 */
export async function writeDocx(filePath: string, zip: JSZip, documentXml: string): Promise<void> {
  // 更新 document.xml
  zip.file('word/document.xml', documentXml)

  // 写回文件
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.writeFileSync(filePath, buffer)
}

// ============ 段落操作 ============

/**
 * 提取所有段落的原始 XML 和文本
 * 返回数组，每个元素包含段落的起止位置和纯文本
 */
export interface ParagraphInfo {
  /** 段落在 document.xml 中的起始位置 */
  start: number
  /** 段落在 document.xml 中的结束位置（含 </w:p>） */
  end: number
  /** 段落纯文本（所有 run 的文本拼接） */
  text: string
  /** 段落的原始 XML */
  xml: string
}

/**
 * 从 document.xml 中提取所有段落信息
 */
export function getParagraphs(documentXml: string): ParagraphInfo[] {
  const paragraphs: ParagraphInfo[] = []

  // 匹配 <w:p ...>...</w:p> 和自闭合的 <w:p ... />
  const pRegex = /<w:p[\s>]/g
  let match: RegExpExecArray | null

  while ((match = pRegex.exec(documentXml)) !== null) {
    const startPos = match.index

    // 检查是否是自闭合标签
    const selfCloseCheck = documentXml.indexOf('/>', startPos)
    const openTagEnd = documentXml.indexOf('>', startPos)

    if (selfCloseCheck === openTagEnd - 1 && selfCloseCheck < documentXml.indexOf('<', startPos + 1)) {
      // 自闭合 <w:p ... />
      const endPos = openTagEnd + 1
      const xml = documentXml.substring(startPos, endPos)
      paragraphs.push({ start: startPos, end: endPos, text: '', xml })
      continue
    }

    // 找到对应的 </w:p>，需要处理嵌套
    let depth = 1
    let searchPos = openTagEnd + 1
    let endPos = -1

    while (depth > 0 && searchPos < documentXml.length) {
      const nextOpen = documentXml.indexOf('<w:p', searchPos)
      const nextClose = documentXml.indexOf('</w:p>', searchPos)

      if (nextClose === -1) break

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // 检查是否是 <w:p 标签（不是 <w:pPr 等）
        const charAfter = documentXml[nextOpen + 4]
        if (charAfter === ' ' || charAfter === '>' || charAfter === '/') {
          depth++
        }
        searchPos = nextOpen + 4
      } else {
        depth--
        if (depth === 0) {
          endPos = nextClose + '</w:p>'.length
        }
        searchPos = nextClose + '</w:p>'.length
      }
    }

    if (endPos === -1) continue

    const xml = documentXml.substring(startPos, endPos)
    const text = extractTextFromParagraphXml(xml)
    paragraphs.push({ start: startPos, end: endPos, text, xml })
  }

  return paragraphs
}

/**
 * 从段落 XML 中提取纯文本
 * 收集所有 <w:t> 和 <w:t xml:space="preserve"> 中的文本
 */
export function extractTextFromParagraphXml(paragraphXml: string): string {
  const texts: string[] = []
  // 匹配 <w:t>text</w:t> 或 <w:t xml:space="preserve">text</w:t>
  const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
  let tMatch: RegExpExecArray | null

  while ((tMatch = tRegex.exec(paragraphXml)) !== null) {
    texts.push(tMatch[1])
  }

  return texts.join('')
}

/**
 * 在段落 XML 中替换文本，保留所有格式
 *
 * 核心算法：
 * 1. 收集段落内所有 <w:t> 元素的文本和位置
 * 2. 拼接成完整段落文本
 * 3. 在拼接文本中查找匹配
 * 4. 根据匹配位置反推到各个 <w:t> 元素中进行替换
 * 5. 保持所有 <w:rPr> 等格式标签不变
 */
export function replaceTextInParagraphXml(
  paragraphXml: string,
  findText: string,
  replaceText: string,
  caseSensitive: boolean = false
): { xml: string; count: number } {
  // 收集所有 <w:t> 的信息
  interface TElement {
    fullMatch: string   // 完整匹配 <w:t ...>text</w:t>
    text: string        // 文本内容
    start: number       // 在 paragraphXml 中的起始位置
    end: number         // 在 paragraphXml 中的结束位置
    textOffset: number  // 在拼接文本中的起始偏移
  }

  const tElements: TElement[] = []
  const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
  let tMatch: RegExpExecArray | null
  let textOffset = 0

  while ((tMatch = tRegex.exec(paragraphXml)) !== null) {
    tElements.push({
      fullMatch: tMatch[0],
      text: tMatch[1],
      start: tMatch.index,
      end: tMatch.index + tMatch[0].length,
      textOffset
    })
    textOffset += tMatch[1].length
  }

  if (tElements.length === 0) return { xml: paragraphXml, count: 0 }

  // 拼接完整文本
  const fullText = tElements.map(t => t.text).join('')

  // 查找所有匹配
  const escapedFind = findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(escapedFind, caseSensitive ? 'g' : 'gi')
  const matches: { index: number; length: number }[] = []
  let regexMatch: RegExpExecArray | null

  while ((regexMatch = regex.exec(fullText)) !== null) {
    matches.push({ index: regexMatch.index, length: regexMatch[0].length })
  }

  if (matches.length === 0) return { xml: paragraphXml, count: 0 }

  // 构建新的文本内容
  // 将匹配应用到各个 t 元素
  // 使用字符级映射：对于拼接文本中的每个字符，记录它属于哪个 t 元素的哪个位置
  let newFullText = fullText
  // 从后往前替换，避免偏移问题
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    newFullText = newFullText.substring(0, m.index) + replaceText + newFullText.substring(m.index + m.length)
  }

  // 将新文本分配回各个 t 元素
  // 策略：将所有文本放入第一个 t 元素，清空其他 t 元素
  // 这虽然简单，但完美保留了第一个 run 的格式，且不改变 XML 结构
  //
  // 更精细的策略：保持文本在各 run 之间的分布比例
  // 我们采用精细策略以更好地保留跨 run 的格式

  // 重新分配文本到各 t 元素
  const newTexts = distributeTextToRuns(fullText, newFullText, tElements.map(t => t.text), matches, replaceText)

  // 从后往前替换 XML 中的 t 元素
  let result = paragraphXml
  for (let i = tElements.length - 1; i >= 0; i--) {
    const te = tElements[i]
    const newText = escapeXml(newTexts[i])
    // 保留 <w:t> 的属性（如 xml:space="preserve"）
    const tagStart = te.fullMatch.indexOf('>') + 1
    const tagEnd = te.fullMatch.lastIndexOf('<')
    const prefix = te.fullMatch.substring(0, tagStart)
    const suffix = te.fullMatch.substring(tagEnd)

    // 如果新文本为空且原始有 space preserve，保留属性
    let newTag: string
    if (newText === '' && !prefix.includes('xml:space')) {
      newTag = prefix.replace('>', ' xml:space="preserve">') + suffix
    } else if (newText !== '' && !prefix.includes('xml:space')) {
      newTag = prefix + newText + suffix
    } else {
      newTag = prefix + newText + suffix
    }

    result = result.substring(0, te.start) + newTag + result.substring(te.end)
  }

  return { xml: result, count: matches.length }
}

/**
 * 将替换后的新文本按照原始 run 分布重新分配
 */
function distributeTextToRuns(
  oldFullText: string,
  newFullText: string,
  oldRunTexts: string[],
  matches: { index: number; length: number }[],
  replaceText: string
): string[] {
  if (oldRunTexts.length === 1) {
    return [newFullText]
  }

  // 创建字符映射：原始文本中每个字符对应的 run 索引
  const charToRun: number[] = []
  for (let runIdx = 0; runIdx < oldRunTexts.length; runIdx++) {
    for (let c = 0; c < oldRunTexts[runIdx].length; c++) {
      charToRun.push(runIdx)
    }
  }

  // 构建新的 run 文本
  const newRunTexts = oldRunTexts.map(() => '')

  // 处理方法：在原始文本中标记哪些区域被替换了
  // 被替换区域的新文本放入匹配起始位置对应的 run
  // 未被替换的区域保持在原来的 run 中

  // 构建 "段" 列表（未替换段 + 替换段 交替）
  interface Segment {
    type: 'keep' | 'replace'
    startInOld: number
    endInOld: number
    text: string
  }

  const segments: Segment[] = []
  let pos = 0
  for (const m of matches) {
    if (m.index > pos) {
      segments.push({
        type: 'keep',
        startInOld: pos,
        endInOld: m.index,
        text: oldFullText.substring(pos, m.index)
      })
    }
    segments.push({
      type: 'replace',
      startInOld: m.index,
      endInOld: m.index + m.length,
      text: replaceText
    })
    pos = m.index + m.length
  }
  if (pos < oldFullText.length) {
    segments.push({
      type: 'keep',
      startInOld: pos,
      endInOld: oldFullText.length,
      text: oldFullText.substring(pos)
    })
  }

  // 分配到各 run
  for (const seg of segments) {
    if (seg.type === 'keep') {
      // 保持原始分布
      for (let i = seg.startInOld; i < seg.endInOld; i++) {
        const runIdx = charToRun[i]
        if (runIdx !== undefined) {
          newRunTexts[runIdx] += oldFullText[i]
        }
      }
    } else {
      // 替换文本放入匹配起始位置的 run
      const runIdx = charToRun[seg.startInOld] ?? 0
      newRunTexts[runIdx] += seg.text
    }
  }

  return newRunTexts
}

/**
 * 删除段落：从 document.xml 中删除指定索引的段落
 */
export function deleteParagraphFromXml(documentXml: string, index: number): { xml: string; deletedText: string } {
  const paragraphs = getParagraphs(documentXml)

  if (index < 0 || index >= paragraphs.length) {
    throw new Error(`段落索引 ${index} 超出范围（0-${paragraphs.length - 1}）`)
  }

  const para = paragraphs[index]
  const deletedText = para.text

  // 删除段落 XML（包含前后可能的空白）
  let removeStart = para.start
  const removeEnd = para.end

  // 尝试清理段落前后的空白换行
  while (removeStart > 0 && (documentXml[removeStart - 1] === '\n' || documentXml[removeStart - 1] === '\r')) {
    removeStart--
  }

  const xml = documentXml.substring(0, removeStart) + documentXml.substring(removeEnd)
  return { xml, deletedText }
}

/**
 * 修改段落文本：替换指定段落中所有 run 的文本为新内容
 */
export function modifyParagraphText(documentXml: string, index: number, newContent: string): string {
  const paragraphs = getParagraphs(documentXml)

  if (index < 0 || index >= paragraphs.length) {
    throw new Error(`段落索引 ${index} 超出范围（0-${paragraphs.length - 1}）`)
  }

  const para = paragraphs[index]
  let paraXml = para.xml

  // 收集所有 <w:t> 元素
  const tRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g
  const tMatches: { fullMatch: string; start: number; end: number }[] = []
  let tMatch: RegExpExecArray | null

  while ((tMatch = tRegex.exec(paraXml)) !== null) {
    tMatches.push({
      fullMatch: tMatch[0],
      start: tMatch.index,
      end: tMatch.index + tMatch[0].length
    })
  }

  if (tMatches.length === 0) {
    // 没有文本 run，需要添加一个
    // 在 </w:p> 前插入一个 run
    const insertPos = paraXml.lastIndexOf('</w:p>')
    if (insertPos !== -1) {
      const newRun = `<w:r><w:t xml:space="preserve">${escapeXml(newContent)}</w:t></w:r>`
      paraXml = paraXml.substring(0, insertPos) + newRun + paraXml.substring(insertPos)
    }
  } else {
    // 将新内容放入第一个 t 元素，清空其余
    for (let i = tMatches.length - 1; i >= 0; i--) {
      const tm = tMatches[i]
      const tagStart = tm.fullMatch.indexOf('>') + 1
      const tagEnd = tm.fullMatch.lastIndexOf('<')
      const prefix = tm.fullMatch.substring(0, tagStart)
      const suffix = tm.fullMatch.substring(tagEnd)

      const text = i === 0 ? escapeXml(newContent) : ''
      let newTag: string
      if (!prefix.includes('xml:space')) {
        newTag = prefix.replace('>', ' xml:space="preserve">') + text + suffix
      } else {
        newTag = prefix + text + suffix
      }

      paraXml = paraXml.substring(0, tm.start) + newTag + paraXml.substring(tm.end)
    }
  }

  // 替换原始 document.xml 中的段落
  return documentXml.substring(0, para.start) + paraXml + documentXml.substring(para.end)
}

/**
 * 修改段落样式：设置/更新段落内所有 run 的格式属性
 */
export function modifyParagraphStyle(
  documentXml: string,
  index: number,
  style: {
    font?: string
    size?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    color?: string
    align?: 'left' | 'center' | 'right' | 'justify'
  }
): string {
  const paragraphs = getParagraphs(documentXml)

  if (index < 0 || index >= paragraphs.length) {
    throw new Error(`段落索引 ${index} 超出范围（0-${paragraphs.length - 1}）`)
  }

  const para = paragraphs[index]
  let paraXml = para.xml

  // 处理段落级别属性（对齐方式）
  if (style.align !== undefined) {
    paraXml = setParagraphAlignment(paraXml, style.align)
  }

  // 处理 run 级别属性（字体、字号、加粗等）
  const hasRunStyle = style.font !== undefined || style.size !== undefined ||
    style.bold !== undefined || style.italic !== undefined ||
    style.underline !== undefined || style.color !== undefined

  if (hasRunStyle) {
    paraXml = setRunProperties(paraXml, style)
  }

  return documentXml.substring(0, para.start) + paraXml + documentXml.substring(para.end)
}

/**
 * 设置段落对齐方式
 */
function setParagraphAlignment(paraXml: string, align: string): string {
  const alignMap: Record<string, string> = {
    'left': 'left',
    'center': 'center',
    'right': 'right',
    'justify': 'both'
  }
  const wAlign = alignMap[align] || 'left'

  // 检查是否已有 <w:pPr>
  const pPrMatch = paraXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)
  if (pPrMatch) {
    let pPrContent = pPrMatch[1]
    // 检查是否已有 <w:jc>
    if (/<w:jc\s/.test(pPrContent)) {
      pPrContent = pPrContent.replace(/<w:jc\s+w:val="[^"]*"\s*\/>/, `<w:jc w:val="${wAlign}"/>`)
    } else {
      pPrContent += `<w:jc w:val="${wAlign}"/>`
    }
    return paraXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, `<w:pPr>${pPrContent}</w:pPr>`)
  } else {
    // 在 <w:p...> 后插入 <w:pPr>
    const insertAfter = paraXml.indexOf('>') + 1
    const pPr = `<w:pPr><w:jc w:val="${wAlign}"/></w:pPr>`
    return paraXml.substring(0, insertAfter) + pPr + paraXml.substring(insertAfter)
  }
}

/**
 * 设置段落内所有 run 的格式属性
 */
function setRunProperties(
  paraXml: string,
  style: {
    font?: string
    size?: number
    bold?: boolean
    italic?: boolean
    underline?: boolean
    color?: string
  }
): string {
  // 构建要添加/更新的 rPr 内容
  const rPrParts: string[] = []
  if (style.font !== undefined) {
    rPrParts.push(`<w:rFonts w:eastAsia="${escapeXml(style.font)}" w:hAnsi="${escapeXml(style.font)}"/>`)
  }
  if (style.size !== undefined) {
    const halfPt = Math.round(style.size * 2)
    rPrParts.push(`<w:sz w:val="${halfPt}"/>`)
    rPrParts.push(`<w:szCs w:val="${halfPt}"/>`)
  }
  if (style.bold === true) {
    rPrParts.push('<w:b/>')
    rPrParts.push('<w:bCs/>')
  }
  if (style.italic === true) {
    rPrParts.push('<w:i/>')
    rPrParts.push('<w:iCs/>')
  }
  if (style.underline === true) {
    rPrParts.push('<w:u w:val="single"/>')
  }
  if (style.color !== undefined) {
    rPrParts.push(`<w:color w:val="${escapeXml(style.color)}"/>`)
  }

  if (rPrParts.length === 0) return paraXml

  // 对每个 <w:r> 更新/添加 <w:rPr>
  // 匹配 <w:r> 或 <w:r w:rsidR="xxx"> 等带属性的情况
  const result = paraXml.replace(/<w:r(\s[^>]*)?>(((?!<w:r[\s>])[\s\S])*?)<\/w:r>/g, (match, attrs, content) => {
    const rOpenTag = `<w:r${attrs || ''}>`

    // 检查是否已有 <w:rPr>
    const rPrMatch = content.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)
    if (rPrMatch) {
      let rPrContent = rPrMatch[1]

      // 逐个更新属性
      if (style.font !== undefined) {
        if (/<w:rFonts\s/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:rFonts[^/]*\/>/, `<w:rFonts w:eastAsia="${escapeXml(style.font)}" w:hAnsi="${escapeXml(style.font)}"/>`)
        } else {
          rPrContent += `<w:rFonts w:eastAsia="${escapeXml(style.font)}" w:hAnsi="${escapeXml(style.font)}"/>`
        }
      }
      if (style.size !== undefined) {
        const halfPt = Math.round(style.size * 2)
        if (/<w:sz\s/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:sz\s+w:val="[^"]*"\s*\/>/, `<w:sz w:val="${halfPt}"/>`)
        } else {
          rPrContent += `<w:sz w:val="${halfPt}"/>`
        }
        if (/<w:szCs\s/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:szCs\s+w:val="[^"]*"\s*\/>/, `<w:szCs w:val="${halfPt}"/>`)
        } else {
          rPrContent += `<w:szCs w:val="${halfPt}"/>`
        }
      }
      if (style.bold !== undefined) {
        if (style.bold) {
          if (!/<w:b[\s/>]/.test(rPrContent)) rPrContent += '<w:b/>'
          if (!/<w:bCs[\s/>]/.test(rPrContent)) rPrContent += '<w:bCs/>'
        } else {
          rPrContent = rPrContent.replace(/<w:b\s*\/>/g, '')
          rPrContent = rPrContent.replace(/<w:bCs\s*\/>/g, '')
        }
      }
      if (style.italic !== undefined) {
        if (style.italic) {
          if (!/<w:i[\s/>]/.test(rPrContent)) rPrContent += '<w:i/>'
          if (!/<w:iCs[\s/>]/.test(rPrContent)) rPrContent += '<w:iCs/>'
        } else {
          rPrContent = rPrContent.replace(/<w:i\s*\/>/g, '')
          rPrContent = rPrContent.replace(/<w:iCs\s*\/>/g, '')
        }
      }
      if (style.underline !== undefined) {
        if (style.underline) {
          if (!/<w:u[\s/>]/.test(rPrContent)) rPrContent += '<w:u w:val="single"/>'
        } else {
          rPrContent = rPrContent.replace(/<w:u[^/]*\/>/g, '')
        }
      }
      if (style.color !== undefined) {
        if (/<w:color\s/.test(rPrContent)) {
          rPrContent = rPrContent.replace(/<w:color\s+w:val="[^"]*"\s*\/>/, `<w:color w:val="${escapeXml(style.color)}"/>`)
        } else {
          rPrContent += `<w:color w:val="${escapeXml(style.color)}"/>`
        }
      }

      const newContent = content.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/, `<w:rPr>${rPrContent}</w:rPr>`)
      return `${rOpenTag}${newContent}</w:r>`
    } else {
      // 没有 rPr，在开头添加
      return `${rOpenTag}<w:rPr>${rPrParts.join('')}</w:rPr>${content}</w:r>`
    }
  })

  return result
}

/**
 * XML 转义
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
