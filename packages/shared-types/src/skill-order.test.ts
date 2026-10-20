import { describe, expect, it } from 'vitest'
import { sortSkillsByName } from './skill-order'

const row = (id: string, name: string) => ({ id, name })
const idsOf = (rows: { id: string }[]) => rows.map(r => r.id)

describe('技能列表按名字排', () => {
  it('中文名按拼音：待办、飞书、日历、邮件', () => {
    const sorted = sortSkillsByName(
      [row('mail', '邮件'), row('feishu', '飞书'), row('todo', '待办'), row('cal', '日历')],
      r => r.name,
    )
    expect(idsOf(sorted)).toEqual(['todo', 'feishu', 'cal', 'mail'])
  })

  it('不是按字符编码：「能」(neng) 在「数」(shu) 前，虽然「数」的编码更小', () => {
    const sorted = sortSkillsByName([row('data', '万得金融数据'), row('find', '万得金融能力发现')], r => r.name)
    expect(idsOf(sorted)).toEqual(['find', 'data'])
  })

  it('中文名在前、英文名在后；英文按字母，数字按大小', () => {
    const sorted = sortSkillsByName(
      [row('word', 'Word'), row('j10', '技能 10'), row('excel', 'Excel'), row('j2', '技能 2'), row('todo', '待办')],
      r => r.name,
    )
    expect(idsOf(sorted)).toEqual(['todo', 'j2', 'j10', 'excel', 'word'])
  })

  it('按调用方给的显示名排，不按对象里的原名', () => {
    const shown: Record<string, string> = { excel: 'Zebra Sheets', word: 'Apple Notes' }
    const sorted = sortSkillsByName([row('excel', 'Excel 处理'), row('word', 'Word 文档')], r => shown[r.id])
    expect(idsOf(sorted)).toEqual(['word', 'excel'])
  })

  it('名字一样（连大小写差异也算）时按 id 定，输入顺序不影响结果', () => {
    const rows = [row('b', 'Excel'), row('c', 'excel'), row('a', 'EXCEL')]
    expect(idsOf(sortSkillsByName(rows, r => r.name))).toEqual(['a', 'b', 'c'])
    expect(idsOf(sortSkillsByName([...rows].reverse(), r => r.name))).toEqual(['a', 'b', 'c'])
  })

  it('不改传进来的数组，元素还是原来的对象', () => {
    const a = row('a', '邮件')
    const b = row('b', '待办')
    const input = [a, b]
    const sorted = sortSkillsByName(input, r => r.name)
    expect(input).toEqual([a, b])
    expect(sorted[0]).toBe(b)
    expect(sorted[1]).toBe(a)
  })

  it('空列表返回空数组', () => {
    expect(sortSkillsByName([], () => '')).toEqual([])
  })
})
