import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { AttachmentChip } from './composer-chip-node'
import {
  plainTextToDocJSON,
  docToPlainText,
  docPosToOffset,
  offsetToDocPos,
  docChipKeys,
  COMPOSER_CHIP_CHAR as C,
} from './composer-editor-text'

const schema = getSchema([Document, Paragraph, Text, AttachmentChip])
const toDoc = (text: string) => schema.nodeFromJSON(plainTextToDocJSON(text))

describe('composer-editor-text', () => {
  it.each([
    '',
    'hello',
    'a\nb',
    'a\n\nb',
    '\n',
    '\n\nx\n',
    '你好\n世界',
  ])('纯文本往返不变：%j', (text) => {
    expect(docToPlainText(toDoc(text))).toBe(text)
  })

  it('CRLF 归一为换行', () => {
    expect(docToPlainText(toDoc('a\r\nb\rc'))).toBe('a\nb\nc')
  })

  it('偏移与文档位置互逆', () => {
    for (const text of ['', 'abc', 'ab\ncd', 'ab\n\ncd', '\nab\n']) {
      const doc = toDoc(text)
      for (let offset = 0; offset <= text.length; offset++) {
        const pos = offsetToDocPos(doc, offset)
        expect(docPosToOffset(doc, pos)).toBe(offset)
      }
    }
  })

  it('段落边界位置折回相邻文字', () => {
    const doc = toDoc('ab\ncd')
    // 位置 4 = 第一段之后、第二段之前
    expect(docPosToOffset(doc, 4)).toBe(3)
  })

  it('偏移越界落在文末', () => {
    const doc = toDoc('ab\ncd')
    expect(docPosToOffset(doc, offsetToDocPos(doc, 999))).toBe(5)
  })

  it('文末位置对应文字长度', () => {
    const doc = toDoc('ab\ncd')
    expect(docPosToOffset(doc, doc.content.size)).toBe(5)
  })

  describe('文件胶囊', () => {
    it.each([`a${C}b`, `${C}`, `${C}${C}`, `x\n${C}y\n`, `${C}\n${C}`])('带胶囊的文字往返不变：%j', (text) => {
      expect(docToPlainText(toDoc(text))).toBe(text)
    })

    it('胶囊占 1 个位置，偏移量与位置互转仍是互逆', () => {
      const doc = toDoc(`ab${C}cd\n${C}`)
      for (let offset = 0; offset <= 7; offset++) {
        expect(docPosToOffset(doc, offsetToDocPos(doc, offset))).toBe(offset)
      }
      // 第二个段落开头偏移 6，胶囊后偏移 7
      expect(offsetToDocPos(doc, 3) - offsetToDocPos(doc, 2)).toBe(1)
    })

    it('按文字先后列出胶囊的 key，新装回的都是空', () => {
      expect(docChipKeys(toDoc(`${C}x${C}\n${C}`))).toEqual([null, null, null])
    })
  })
})
