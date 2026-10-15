/**
 * PDF 版面还原测试
 *
 * 用例形状来自一份真实法规（A4 单栏、页宽 595、正文 x 从 90 到 505）：
 * pdfjs 给出的文本块顺序是内容流顺序，与人读的顺序不一致，一行还常被切成
 * 好几块。这里把「按坐标还原」的几何判据固定住。
 */
import { describe, it, expect } from 'vitest'
import {
  buildLines,
  collapseCjkTracking,
  stripRunningHeads,
  joinParagraphs,
  reflowPage
} from '../pdf-layout.mjs'

/** A4 的未旋转页面框 */
const PAGE = { x1: 0, y1: 0, x2: 595, y2: 842 }
const FONT = 10

/** 造一个文本块；宽度默认按中文字宽≈字高估 */
function item(str: string, x: number, y: number, opts: { width?: number; height?: number } = {}) {
  const height = opts.height ?? FONT
  return {
    str,
    transform: [height, 0, 0, height, x, y],
    width: opts.width ?? str.length * height,
    height
  }
}

describe('buildLines', () => {
  it('同一基线上的块按横坐标排好，不管给进来的顺序', () => {
    // 坐标照搬真实法规第 8 页：一行被切成三块，字宽 16，块之间严丝合缝
    const cjk = { width: 16, height: 16 }
    const lines = buildLines([
      item('变更操作行为进行审查', 122, 747, { width: 10 * 16, height: 16 }),
      item('线', 90, 747, cjk),
      item('或', 106, 747, cjk)
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('线或变更操作行为进行审查')
  })

  it('不同基线分成多行，从上到下排', () => {
    const lines = buildLines([
      item('第二行', 90, 700),
      item('第一行', 90, 720),
      item('第三行', 90, 680)
    ])

    expect(lines.map(l => l.text)).toEqual(['第一行', '第二行', '第三行'])
  })

  it('基线有零点几的抖动仍算同一行', () => {
    const lines = buildLines([
      item('前', 90, 700),
      item('后', 100, 700.4)
    ])

    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('前后')
  })

  it('空白块不产生行', () => {
    expect(buildLines([item('   ', 90, 700), item('', 120, 700)])).toEqual([])
  })

  it('记下行的左右端和字高，供后续判断用', () => {
    const [line] = buildLines([item('两个字', 90, 700, { width: 30 })])

    expect(line.left).toBe(90)
    expect(line.right).toBe(120)
    expect(line.height).toBe(FONT)
  })

  describe('块之间要不要补空格', () => {
    it('中文紧挨着不补——补了会把词割开，关键词检索首先受害', () => {
      const [line] = buildLines([
        item('信息技术', 90, 700, { width: 40 }),
        item('管理办法', 130, 700, { width: 40 })
      ])

      expect(line.text).toBe('信息技术管理办法')
    })

    it('中文之间明显的间隙要留住（条号后那一下）', () => {
      const [line] = buildLines([
        item('第二十八条', 90, 700, { width: 50 }),
        item('证券基金经营机构', 148, 700, { width: 80 })
      ])

      expect(line.text).toBe('第二十八条 证券基金经营机构')
    })

    it('西文之间按间距补空格', () => {
      const [line] = buildLines([
        item('hello', 90, 700, { width: 25 }),
        item('world', 120, 700, { width: 25 })
      ])

      expect(line.text).toBe('hello world')
    })
  })
})

describe('collapseCjkTracking', () => {
  it('幻灯片标题里拉开字距的空格收掉，否则「大模型」搜不到', () => {
    expect(collapseCjkTracking('大 模 型 技 术 前 沿 与')).toBe('大模型技术前沿与')
  })

  it('单处分隔留着——条号和正文之间不是字距', () => {
    expect(collapseCjkTracking('第二十八条 证券基金经营机构应当')).toBe('第二十八条 证券基金经营机构应当')
  })

  it('两个字的不动（姓名这类）', () => {
    expect(collapseCjkTracking('于 申 2025年2月')).toBe('于 申 2025年2月')
  })

  it('中英混排里中文那段照收，英文空格不动', () => {
    expect(collapseCjkTracking('人 工 智 能 AI for finance')).toBe('人工智能 AI for finance')
  })
})

describe('stripRunningHeads', () => {
  const body = (text: string, y: number) =>
    ({ text, top: y, left: 90, right: 505, height: FONT })
  const shortAt = (text: string, y: number) =>
    ({ text, top: y, left: 483, right: 505, height: FONT })

  it('页脚的页码去掉', () => {
    const lines = [body('正文', 700), shortAt('- 9 -', 40)]

    expect(stripRunningHeads(lines, PAGE).map(l => l.text)).toEqual(['正文'])
  })

  it('页眉的书眉去掉', () => {
    const lines = [shortAt('管理办法', 800), body('正文', 700)]

    expect(stripRunningHeads(lines, PAGE).map(l => l.text)).toEqual(['正文'])
  })

  it('铺到正文宽度的末行留着，哪怕它靠着页边', () => {
    const lines = [body('正文', 700), body('这一行一直排到页面右边才换行', 40)]

    expect(stripRunningHeads(lines, PAGE)).toHaveLength(2)
  })

  it('正文中间的短行留着（条文结尾常常很短）', () => {
    const lines = [body('正文', 700), { text: '数据。', top: 400, left: 90, right: 120, height: FONT }]

    expect(stripRunningHeads(lines, PAGE)).toHaveLength(2)
  })

  it('页高未知时原样返回，不瞎猜', () => {
    const lines = [body('正文', 700), shortAt('- 9 -', 40)]

    expect(stripRunningHeads(lines, undefined)).toHaveLength(2)
  })
})

describe('joinParagraphs', () => {
  const full = (text: string, y: number) =>
    ({ text, top: y, left: 90, right: 505, height: FONT })
  const short = (text: string, y: number) =>
    ({ text, top: y, left: 90, right: 200, height: FONT })

  it('排到右边界的行接上下一行，同一段不留硬换行', () => {
    const text = joinParagraphs([
      full('证券基金经营机构应当确保重要信息系', 700),
      short('统具备可审计功能。', 688)
    ], PAGE)

    expect(text).toBe('证券基金经营机构应当确保重要信息系统具备可审计功能。')
  })

  it('没排到右边界就是段落结束，下一行另起一段', () => {
    const text = joinParagraphs([
      full('这一行一直排到页面右边', 712),
      short('第一段结束。', 700),
      short('第二段开始。', 688)
    ], PAGE)

    expect(text).toBe('这一行一直排到页面右边第一段结束。\n第二段开始。')
  })

  it('整页都是短行时各自成段，不粘成一团', () => {
    const text = joinParagraphs([
      short('第六十四条 本办法自2019年6月1日起实施。', 700),
      short('同时废止旧规定。', 688)
    ], PAGE)

    expect(text).toBe('第六十四条 本办法自2019年6月1日起实施。\n同时废止旧规定。')
  })

  it('居中的标题自成一段——长标题右端也会逼近正文右边界', () => {
    const text = joinParagraphs([
      { text: '证券基金经营机构信息技术管理办法', top: 760, left: 121, right: 474, height: 14 },
      short('第一章 总则', 700),
      full('第一条 为加强证券基金经营机构信息技术管', 688),
      short('理，制定本办法。', 676)
    ], PAGE)

    expect(text).toBe(
      '证券基金经营机构信息技术管理办法\n第一章 总则\n第一条 为加强证券基金经营机构信息技术管理，制定本办法。'
    )
  })

  it('没有行时给空串', () => {
    expect(joinParagraphs([], PAGE)).toBe('')
  })
})

describe('reflowPage', () => {

  it('乱序的块 + 页码，还原成通顺正文', () => {
    const text = reflowPage(
      [
        // 内容流里末尾行跑到了前面——这正是原来拼出残句的原因
        item('数据。', 90, 676, { width: 30 }),
        item('- 9 -', 483, 40, { width: 22 }),
        item('第二十八条', 90, 700, { width: 50 }),
        item('证券基金经营机构应当确保重要信息系', 148, 700, { width: 357 }),
        item('统具备可审计功能，并可以根据监管部门的要求转换、提供', 90, 688, { width: 415 })
      ],
      PAGE
    )

    expect(text).toBe(
      '第二十八条 证券基金经营机构应当确保重要信息系统具备可审计功能，并可以根据监管部门的要求转换、提供数据。'
    )
  })

  it('空页给空串', () => {
    expect(reflowPage([], PAGE)).toBe('')
  })

  it('没给块也不炸', () => {
    expect(reflowPage(undefined as never, PAGE)).toBe('')
  })
})
