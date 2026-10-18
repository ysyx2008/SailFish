/**
 * 输入框编辑器的纯文本视图。
 *
 * 编辑器内部是「一行一个段落」的文档；外面（@ 菜单、斜杠命令、草稿、发送）
 * 仍按一段带 `\n` 的纯文本、字符偏移量理解。这里负责两边互转，不碰 DOM。
 */
import type { Node as PMNode } from '@tiptap/pm/model'

/** 文件胶囊在编辑器里的节点名 */
export const COMPOSER_CHIP_NODE = 'attachmentChip'

/**
 * 文件胶囊在纯文本里的占位字符（Unicode「对象替换符」）：占 1 个字符，
 * 与胶囊节点在文档里占 1 个位置一一对应，字符偏移量因此始终有效。
 */
export const COMPOSER_CHIP_CHAR = '\uFFFC'

type InlineJSON =
  | { type: 'text'; text: string }
  | { type: typeof COMPOSER_CHIP_NODE; attrs: { key: string | null } }

interface ParagraphJSON {
  type: 'paragraph'
  content?: InlineJSON[]
}

export interface DocJSON {
  type: 'doc'
  content: ParagraphJSON[]
}

function lineToInline(line: string): InlineJSON[] {
  const content: InlineJSON[] = []
  line.split(COMPOSER_CHIP_CHAR).forEach((piece, index) => {
    // 每个占位字符之前的分隔处是一枚胶囊（尚未绑定到具体文件，key 为空）
    if (index > 0) content.push({ type: COMPOSER_CHIP_NODE, attrs: { key: null } })
    if (piece) content.push({ type: 'text', text: piece })
  })
  return content
}

/** 纯文本 → 文档 JSON：每个换行符一个段落（连续换行不合并）；占位字符变成胶囊 */
export function plainTextToDocJSON(text: string): DocJSON {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: lines.map((line): ParagraphJSON => {
      const content = lineToInline(line)
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
    }),
  }
}

/** 文档 → 纯文本：段落之间用 `\n` 连接，胶囊写成占位字符 */
export function docToPlainText(doc: PMNode): string {
  const lines: string[] = []
  doc.forEach((paragraph) => {
    let line = ''
    paragraph.forEach((child) => {
      if (child.isText) line += child.text ?? ''
      else if (child.type.name === COMPOSER_CHIP_NODE) line += COMPOSER_CHIP_CHAR
    })
    lines.push(line)
  })
  return lines.join('\n')
}

/** 文档里所有胶囊的 key，按文字先后排列（未绑定的是 null） */
export function docChipKeys(doc: PMNode): (string | null)[] {
  const keys: (string | null)[] = []
  doc.descendants((node) => {
    if (node.type.name === COMPOSER_CHIP_NODE) keys.push((node.attrs.key as string | null) ?? null)
  })
  return keys
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
