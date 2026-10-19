import { describe, expect, it } from 'vitest'
import { isFlowArrowKey, moveInFlow, type TileBox } from './skill-flow-nav'

const H = 30
const tile = (left: number, top: number, width: number): TileBox => ({ left, top, width, height: H })

/*
 * 两组标签，宽度不一：
 *   我装的
 *   [0 0..200][1 210..290][2 300..520]
 *   [3 0..90 ][4 100..400]
 *   内置
 *   [5 0..120][6 130..250][7 260..330]
 */
const BOXES: TileBox[] = [
  tile(0, 40, 200), tile(210, 40, 80), tile(300, 40, 220),
  tile(0, 76, 90), tile(100, 76, 300),
  tile(0, 140, 120), tile(130, 140, 120), tile(260, 140, 70),
]
const move = (i: number, key: Parameters<typeof moveInFlow>[1]) => moveInFlow(i, key, BOXES)

describe('isFlowArrowKey', () => {
  it('只认四个方向键', () => {
    for (const k of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) expect(isFlowArrowKey(k)).toBe(true)
    for (const k of ['Enter', 'Tab', 'Home', 'a']) expect(isFlowArrowKey(k)).toBe(false)
  })
})

describe('moveInFlow 左右', () => {
  it('左右按顺序走，跨行、跨组都接着走', () => {
    expect(move(1, 'ArrowRight')).toBe(2)
    expect(move(2, 'ArrowRight')).toBe(3)
    expect(move(4, 'ArrowRight')).toBe(5)
    expect(move(5, 'ArrowLeft')).toBe(4)
  })

  it('到头不动', () => {
    expect(move(0, 'ArrowLeft')).toBe(0)
    expect(move(7, 'ArrowRight')).toBe(7)
  })
})

describe('moveInFlow 上下：隔壁一行里水平离得最近的', () => {
  it('往下：正下方最近的那个', () => {
    expect(move(0, 'ArrowDown')).toBe(3) // 中心 100：3 的中心 45、4 的中心 250 → 3 更近
    expect(move(1, 'ArrowDown')).toBe(4) // 中心 250：正对 4
    expect(move(2, 'ArrowDown')).toBe(4) // 中心 410：只有 4 在这一行，最近
  })

  it('往下跨过分组标题，落到下一组第一行', () => {
    expect(move(4, 'ArrowDown')).toBe(7) // 中心 250：6 的中心 190 距 60、7 的中心 295 距 45 → 7
    expect(move(3, 'ArrowDown')).toBe(5) // 中心 45：5 最近
  })

  it('往上：正上方最近的那个', () => {
    expect(move(4, 'ArrowUp')).toBe(1) // 中心 250：1 的中心 250
    expect(move(3, 'ArrowUp')).toBe(0)
    expect(move(7, 'ArrowUp')).toBe(4) // 中心 295：上一行只有 3、4 → 4
  })

  it('第一行再往上、最后一行再往下都不动', () => {
    expect(move(1, 'ArrowUp')).toBe(1)
    expect(move(6, 'ArrowDown')).toBe(6)
  })

  it('同一行里顶边差几像素也算同一行', () => {
    const boxes = [tile(0, 0, 100), tile(0, 40, 100), tile(110, 43, 100)]
    expect(moveInFlow(0, 'ArrowDown', boxes)).toBe(1)
    expect(moveInFlow(2, 'ArrowUp', boxes)).toBe(0)
  })
})

describe('moveInFlow 边界', () => {
  it('没有标签时回到 0', () => {
    expect(moveInFlow(3, 'ArrowDown', [])).toBe(0)
  })

  it('越界的起点先收回范围内', () => {
    expect(moveInFlow(99, 'ArrowLeft', BOXES)).toBe(6)
    expect(moveInFlow(-5, 'ArrowRight', BOXES)).toBe(1)
  })

  it('量不到位置的标签：上下键跳过它，左右照常', () => {
    const boxes: Array<TileBox | undefined> = [tile(0, 0, 100), undefined, tile(0, 40, 100)]
    expect(moveInFlow(0, 'ArrowDown', boxes)).toBe(2)
    expect(moveInFlow(0, 'ArrowRight', boxes)).toBe(1)
    expect(moveInFlow(1, 'ArrowDown', boxes)).toBe(1)
  })
})
