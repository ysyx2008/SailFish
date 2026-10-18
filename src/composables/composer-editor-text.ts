/**
 * 输入框编辑器的纯文本视图。
 *
 * 编辑器内部是「一行一个段落」的文档；外面（@ 菜单、斜杠命令、草稿、发送）
 * 仍按一段带 `\n` 的纯文本、字符偏移量理解。这里负责两边互转，不碰 DOM。
 */
import type { Node as PMNode } from '@tiptap/pm/model'

interface ParagraphJSON {
  type: 'paragraph'
  content?: { type: 'text'; text: string }[]
}

export interface DocJSON {
  type: 'doc'
  content: ParagraphJSON[]
}

/** 纯文本 → 文档 JSON：每个换行符一个段落（连续换行不合并） */
export function plainTextToDocJSON(text: string): DocJSON {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: lines.map((line): ParagraphJSON =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    ),
  }
}

/** 文档 → 纯文本：段落之间用 `\n` 连接 */
export function docToPlainText(doc: PMNode): string {
  const lines: string[] = []
  doc.forEach((paragraph) => lines.push(paragraph.textContent))
  return lines.join('\n')
}

/** 文档位置 → 纯文本字符偏移 */
export function docPosToOffset(doc: PMNode, pos: number): number {
  let offset = 0
  let start = 0
  for (let i = 0; i < doc.childCount; i++) {
    const paragraph = doc.child(i)
    const contentStart = start + 1
    const contentEnd = contentStart + paragraph.content.size
    if (pos <= contentEnd) return offset + Math.max(0, pos - contentStart)
    offset += paragraph.content.size + 1
    start += paragraph.nodeSize
  }
  return Math.max(0, offset - 1)
}

/** 纯文本字符偏移 → 文档位置（越界时落在文末） */
export function offsetToDocPos(doc: PMNode, offset: number): number {
  let remaining = Math.max(0, offset)
  let start = 0
  let lastContentEnd = 1
  for (let i = 0; i < doc.childCount; i++) {
    const paragraph = doc.child(i)
    const contentStart = start + 1
    const size = paragraph.content.size
    lastContentEnd = contentStart + size
    if (remaining <= size) return contentStart + remaining
    remaining -= size + 1
    start += paragraph.nodeSize
  }
  return lastContentEnd
}
