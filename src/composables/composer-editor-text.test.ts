import { describe, it, expect } from 'vitest'
import { getSchema } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import {
  plainTextToDocJSON,
  docToPlainText,
  docPosToOffset,
  offsetToDocPos,
} from './composer-editor-text'

const schema = getSchema([Document, Paragraph, Text])
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
})
