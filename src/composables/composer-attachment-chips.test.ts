import { describe, expect, it } from 'vitest'
import {
  chipsToMarkers,
  markersToChips,
  orderIdsByChips,
  planChipSync,
  removedChipKeys,
} from './composer-attachment-chips'
import { COMPOSER_CHIP_CHAR as C } from './composer-editor-text'

describe('planChipSync', () => {
  it('对得上就什么都不用做', () => {
    expect(planChipSync(['a', 'b'], ['a', 'b'])).toEqual({ bind: [], remove: [], insert: [] })
  })

  it('新文件需要新胶囊，按附件顺序', () => {
    expect(planChipSync(['a'], ['a', 'b', 'c']).insert).toEqual(['b', 'c'])
  })

  it('文件没了，胶囊要删', () => {
    expect(planChipSync(['a', 'b'], ['b']).remove).toEqual([0])
  })

  it('没对上的胶囊按先后认领还没胶囊的文件', () => {
    const plan = planChipSync([null, null], ['x', 'y'])
    expect(plan.bind).toEqual([{ index: 0, key: 'x' }, { index: 1, key: 'y' }])
    expect(plan.insert).toEqual([])
  })

  it('没对上的胶囊比文件多：多的删', () => {
    const plan = planChipSync([null, null, null], ['x'])
    expect(plan.bind).toEqual([{ index: 0, key: 'x' }])
    expect(plan.remove).toEqual([1, 2])
  })

  it('已对上的和没对上的混着：没对上的只认领剩下的文件', () => {
    const plan = planChipSync([null, 'b'], ['a', 'b'])
    expect(plan.bind).toEqual([{ index: 0, key: 'a' }])
    expect(plan.insert).toEqual([])
  })

  it('同一个文件的重复胶囊只留第一枚', () => {
    expect(planChipSync(['a', 'a'], ['a']).remove).toEqual([1])
  })
})

describe('orderIdsByChips', () => {
  it('顺序一致返回 null', () => {
    expect(orderIdsByChips(['a', 'b'], ['a', 'b'])).toBeNull()
  })
  it('文件顺序跟着胶囊走，没有胶囊的排最后', () => {
    expect(orderIdsByChips(['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'a', 'b'])
  })
})

describe('removedChipKeys', () => {
  it('找出少了的 key', () => {
    expect(removedChipKeys(['a', 'b', 'c'], ['a', null, 'c'])).toEqual(['b'])
  })
})

describe('胶囊与标记文本互转', () => {
  const labels = ['[附件：a.pdf]', '[附件：b.pdf]']

  it('发送：占位字符按先后换成各文件的标记', () => {
    expect(chipsToMarkers(`看${C}和${C}`, labels)).toBe('看[附件：a.pdf]和[附件：b.pdf]')
  })

  it('发送：没对上文件的胶囊当作不存在', () => {
    expect(chipsToMarkers(`看${C}`, [null])).toBe('看')
  })

  it('取回：标记还原成占位字符，往返不变', () => {
    const text = `看${C}和${C}`
    expect(markersToChips(chipsToMarkers(text, labels), labels)).toBe(text)
  })

  it('取回：同名文件按先后逐个认领', () => {
    const same = ['[附件：a.pdf]', '[附件：a.pdf]']
    expect(markersToChips('[附件：a.pdf] [附件：a.pdf]', same)).toBe(`${C} ${C}`)
  })

  it('取回：文字里找不到的标记跳过，不影响其余', () => {
    expect(markersToChips('只有 [附件：b.pdf]', labels)).toBe(`只有 ${C}`)
  })

  it('取回：消息后面追加的内容原样保留', () => {
    expect(markersToChips('看 [附件：a.pdf]\n\n其他', ['[附件：a.pdf]'])).toBe(`看 ${C}\n\n其他`)
  })
})
