import { describe, expect, it } from 'vitest'
import { skillTitleMatchesQuery } from './skill-title-match'

const JD = '京东购物助手'

describe('skillTitleMatchesQuery', () => {
  it('空搜索全部算对上', () => {
    expect(skillTitleMatchesQuery(JD, '')).toBe(true)
    expect(skillTitleMatchesQuery(JD, '   ')).toBe(true)
  })

  it('标题原文照旧能对上，不区分大小写', () => {
    expect(skillTitleMatchesQuery('Excel 处理', 'excel')).toBe(true)
    expect(skillTitleMatchesQuery('Excel 处理', '处理')).toBe(true)
    expect(skillTitleMatchesQuery(JD, '购物')).toBe(true)
  })

  it('全拼、声母、从中间一个字起、没写完，都能对上', () => {
    for (const q of ['jingdong', 'jd', 'gouwu', 'gw', 'jdgw', 'gwzs', 'jin', 'jing', 'jingd', 'JD', 'jing dong']) {
      expect(skillTitleMatchesQuery(JD, q), q).toBe(true)
    }
  })

  it('跳过中间的字、中间少写字母，都不算', () => {
    expect(skillTitleMatchesQuery(JD, 'jz')).toBe(false)
    expect(skillTitleMatchesQuery(JD, 'jdzs')).toBe(false)
    expect(skillTitleMatchesQuery(JD, 'jindong')).toBe(false)
    expect(skillTitleMatchesQuery(JD, 'jindongwu')).toBe(false)
    expect(skillTitleMatchesQuery(JD, 'pin')).toBe(false)
  })

  it('多音字任一常用读音对上即可', () => {
    expect(skillTitleMatchesQuery('音乐', 'yinyue')).toBe(true)
    expect(skillTitleMatchesQuery('音乐', 'yinle')).toBe(true)
    expect(skillTitleMatchesQuery('重庆', 'chongqing')).toBe(true)
    expect(skillTitleMatchesQuery('重庆', 'zhongqing')).toBe(true)
    expect(skillTitleMatchesQuery('银行', 'yinhang')).toBe(true)
    expect(skillTitleMatchesQuery('银行', 'yinxing')).toBe(true)
  })

  it('ü 写成 v 也行', () => {
    expect(skillTitleMatchesQuery('女儿', 'nv')).toBe(true)
    expect(skillTitleMatchesQuery('女儿', 'nü')).toBe(true)
    expect(skillTitleMatchesQuery('绿', 'lv')).toBe(true)
  })

  it('对不上的拼音就是对不上', () => {
    expect(skillTitleMatchesQuery(JD, 'xyz')).toBe(false)
    expect(skillTitleMatchesQuery('Excel 处理', 'biao')).toBe(false)
  })
})
