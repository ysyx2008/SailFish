import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import { askUser, normalizeAskOptions, resolveAskDefault } from '../tools/misc'

describe('normalizeAskOptions', () => {
  it('rejects missing, empty, or single options', () => {
    expect(normalizeAskOptions(undefined)).toBeNull()
    expect(normalizeAskOptions([])).toBeNull()
    expect(normalizeAskOptions(['只要一个'])).toBeNull()
    expect(normalizeAskOptions(['  ', ''])).toBeNull()
    expect(normalizeAskOptions(['好', 1, null])).toBeNull()
    expect(normalizeAskOptions(['甲', '甲', ' 甲 '])).toBeNull()
  })

  it('keeps at least two trimmed choices and caps at ten', () => {
    expect(normalizeAskOptions([' 甲 ', '乙'])).toEqual(['甲', '乙'])
    expect(normalizeAskOptions(['甲', '甲', '乙'])).toEqual(['甲', '乙'])
    const many = Array.from({ length: 12 }, (_, i) => `选项${i + 1}`)
    expect(normalizeAskOptions(many)).toHaveLength(10)
  })
})

describe('askUser 推荐选项', () => {
  const makeExecutor = () => ({
    addStep: vi.fn((_step: { toolArgs: { options?: unknown; default_value?: unknown } }) => ({ id: 'ask-1' })),
    updateStep: vi.fn(),
    isAborted: () => true,
    hasPendingUserMessage: () => false,
    consumePendingUserMessage: () => undefined
  })

  it('没有选项时仍能提问', async () => {
    const executor = makeExecutor()
    await askUser({ question: '你怎么看？' }, executor as never)
    expect(executor.addStep).toHaveBeenCalled()
    expect(executor.addStep.mock.calls[0]![0].toolArgs.options).toEqual([])
    expect(executor.addStep.mock.calls[0]![0].toolArgs.default_value).toBeUndefined()
  })

  it('只有一个选项时不真正提问', async () => {
    const executor = makeExecutor()
    const result = await askUser(
      { question: '选哪个？', options: ['只要一个'] },
      executor as never
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/至少要有 2 个|at least 2/i)
    expect(executor.addStep).not.toHaveBeenCalled()
  })

  it('没标更倾向的那一项时照样提问，不改顺序', async () => {
    const executor = makeExecutor()
    await askUser(
      { question: '选哪个？', options: ['甲', '乙'] },
      executor as never
    )
    expect(executor.addStep).toHaveBeenCalled()
    expect(executor.addStep.mock.calls[0]![0].toolArgs.options).toEqual(['甲', '乙'])
    expect(executor.addStep.mock.calls[0]![0].toolArgs.default_value).toBeUndefined()
  })

  it('更倾向的不在选项里时当作没标，照样提问', async () => {
    const executor = makeExecutor()
    await askUser(
      { question: '选哪个？', options: ['甲', '乙'], default_value: '丙' },
      executor as never
    )
    expect(executor.addStep).toHaveBeenCalled()
    expect(executor.addStep.mock.calls[0]![0].toolArgs.options).toEqual(['甲', '乙'])
    expect(executor.addStep.mock.calls[0]![0].toolArgs.default_value).toBeUndefined()
  })

  it('只发了图、没写字时不算回答，不会马上选上推荐项', async () => {
    vi.useFakeTimers()
    try {
      const executor = {
        addStep: vi.fn(() => ({ id: 'ask-1' })),
        updateStep: vi.fn(),
        isAborted: () => false,
        hasPendingUserMessage: () => true,
        consumePendingUserMessage: () => '',
        consumePendingUserReply: () => undefined as string | undefined,
      }
      let settled = false
      const pending = askUser(
        {
          question: '可以吗？',
          options: ['就用这张', '再调一版'],
          default_value: '就用这张',
          timeout: 2,
        },
        executor as never,
      ).then(result => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(2500)
      const result = await pending
      expect(settled).toBe(true)
      expect(result.success).toBe(true)
      expect(result.output).toContain('就用这张')
    } finally {
      vi.useRealTimers()
    }
  })

  it('自己打的字才是回答，不改成推荐项', async () => {
    const executor = {
      addStep: vi.fn(() => ({ id: 'ask-1' })),
      updateStep: vi.fn(),
      isAborted: () => false,
      hasPendingUserMessage: () => true,
      consumePendingUserMessage: () => '',
      consumePendingUserReply: () => '再调一版',
    }
    const result = await askUser(
      {
        question: '可以吗？',
        options: ['就用这张', '再调一版'],
        default_value: '就用这张',
      },
      executor as never,
    )
    expect(result.success).toBe(true)
    expect(result.output).toContain('再调一版')
    expect(result.output).not.toContain('就用这张')
  })

  it('标了更倾向的那一项时排在最前', async () => {
    const executor = makeExecutor()
    await askUser(
      { question: '选哪个？', options: ['甲', '乙'], default_value: '乙' },
      executor as never
    )
    expect(executor.addStep).toHaveBeenCalled()
    expect(executor.addStep.mock.calls[0]![0].toolArgs.options).toEqual(['乙', '甲'])
    expect(executor.addStep.mock.calls[0]![0].toolArgs.default_value).toBe('乙')
  })
})

describe('resolveAskDefault', () => {
  it('only accepts a trimmed value that is already an option', () => {
    expect(resolveAskDefault(' 乙 ', ['甲', '乙'])).toBe('乙')
    expect(resolveAskDefault('丙', ['甲', '乙'])).toBeNull()
    expect(resolveAskDefault('', ['甲', '乙'])).toBeNull()
    expect(resolveAskDefault(undefined, ['甲', '乙'])).toBeNull()
  })
})
