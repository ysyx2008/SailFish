import { describe, expect, it } from 'vitest'
import { markersToFileNames, splitMessageByAttachments } from './message-attachment-inline'

const mk = (name: string) => `[附件：${name}]`
const markers = (f: { filename: string }) => [mk(f.filename), `[Attachment: ${f.filename}]`]
const f = (filename: string) => ({ filename })

describe('splitMessageByAttachments', () => {
  it('附件嵌回标记所在的位置', () => {
    const r = splitMessageByAttachments(`看 ${mk('a.pdf')} 和 ${mk('b.md')} 的差异`, [f('a.pdf'), f('b.md')], markers)
    expect(r.hasInline).toBe(true)
    expect(r.rest).toEqual([])
    expect(r.segments.map(s => (s.type === 'text' ? s.text : `<${s.file.filename}>`))).toEqual([
      '看 ', '<a.pdf>', ' 和 ', '<b.md>', ' 的差异',
    ])
  })

  it('同名文件按先后逐个认领', () => {
    const r = splitMessageByAttachments(`${mk('a')}${mk('a')}`, [f('a'), f('a')], markers)
    expect(r.segments.filter(s => s.type === 'file')).toHaveLength(2)
    expect(r.rest).toEqual([])
  })

  it('找不到标记的附件留在下方，其余照常嵌入', () => {
    const r = splitMessageByAttachments(`只有 ${mk('a')}`, [f('a'), f('图.png')], markers)
    expect(r.rest.map(x => x.filename)).toEqual(['图.png'])
    expect(r.hasInline).toBe(true)
  })

  it('老消息没有标记：原文不动，附件全在下方', () => {
    const r = splitMessageByAttachments('这是个文件', [f('a')], markers)
    expect(r.hasInline).toBe(false)
    expect(r.segments).toEqual([{ type: 'text', text: '这是个文件' }])
    expect(r.rest).toHaveLength(1)
  })

  it('换过界面语言：另一种语言的标记也认得', () => {
    const r = splitMessageByAttachments('see [Attachment: a] ok', [f('a')], markers)
    expect(r.hasInline).toBe(true)
  })

  it('只发了文件（句子里只有标记）：气泡里只有文件，没有多余文字', () => {
    const r = splitMessageByAttachments(`${mk('a.pdf')} ${mk('b.md')}`, [f('a.pdf'), f('b.md')], markers)
    expect(r.hasInline).toBe(true)
    expect(r.rest).toEqual([])
    const text = r.segments.map(s => (s.type === 'text' ? s.text : '')).join('').trim()
    expect(text).toBe('')
  })

  it('换行和前后文字原样保留', () => {
    const r = splitMessageByAttachments(`${mk('a')}这是个文件\n${mk('b')}这也是\n\n对吧？`, [f('a'), f('b')], markers)
    const text = r.segments.map(s => (s.type === 'text' ? s.text : '')).join('')
    expect(text).toBe('这是个文件\n这也是\n\n对吧？')
  })
})

describe('markersToFileNames', () => {
  const renders = [(n: string) => `[附件：${n}]`, (n: string) => `[Attachment: ${n}]`]
  it('标记还原成文件名', () => {
    expect(markersToFileNames('看 [附件：a.pdf] 和 [Attachment: b.md]', renders)).toBe('看 a.pdf 和 b.md')
  })
  it('没有标记的文字原样不动', () => {
    expect(markersToFileNames('普通 [标题]', renders)).toBe('普通 [标题]')
  })
})
