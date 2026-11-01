import { describe, expect, it } from 'vitest'
import { WatchState } from '../state'

describe('关切状态保存边界', () => {
  it('保留长字符串、嵌套 JSON、数组和长键，不修改旧状态', () => {
    const current = { kept: true, overwritten: 'old' }
    const patch = { overwritten: '新'.repeat(1437), nested: { value: ['一', null, false] }, ['k'.repeat(101)]: 'value' }
    expect(WatchState.merge(current, patch)).toEqual({ ...current, ...patch })
    expect(current).toEqual({ kept: true, overwritten: 'old' })
  })
  it('按合并后的整体大小判断超限，失败时旧对象不变', () => {
    const current = { body: 'x'.repeat(40000) }
    expect(() => WatchState.merge(current, { other: 'x'.repeat(30000) })).toThrow('原状态保留')
    expect(current.body).toHaveLength(40000)
  })
  it.each([null, [], 'text', 1, { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }])('拒绝不能完整保存的输入：%#', value => {
    expect(() => WatchState.validate(value)).toThrow()
  })
  it('整体边界以内原样保存，超过一字符拒绝', () => {
    const body = 'x'.repeat(WatchState.MAX_CHARS - JSON.stringify({ body: '' }).length)
    expect(WatchState.validate({ body })).toEqual({ body })
    expect(() => WatchState.validate({ body: body + 'x' })).toThrow('超过')
  })
  it('循环对象明确失败', () => {
    const state: Record<string, unknown> = {}
    state.self = state
    expect(() => WatchState.validate(state)).toThrow()
  })
})
