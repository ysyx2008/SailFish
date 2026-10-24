import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CONTEXT_LENGTH,
  REQUEST_SAFETY_MARGIN_TOKENS,
  SUMMARY_CEILING_OUTPUT_TOKENS,
  SUMMARY_MIN_OUTPUT_TOKENS,
  resolveRequestBudget,
  resolveSummaryBudget
} from '../ai-request-budget'
import { DEFAULT_MAX_OUTPUT_TOKENS } from '../ai.service'

describe('resolveRequestBudget', () => {
  it('无配置 → 保守窗口，输出不超过窗口四分之一', () => {
    const budget = resolveRequestBudget()
    expect(budget.contextLength).toBe(DEFAULT_CONTEXT_LENGTH)
    expect(budget.outputTokens).toBe(Math.min(DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_CONTEXT_LENGTH / 4))
    expect(budget.inputLimit).toBe(
      DEFAULT_CONTEXT_LENGTH - budget.outputTokens - REQUEST_SAFETY_MARGIN_TOKENS
    )
  })

  it('略大于默认输出的窗口不出现输入断崖', () => {
    const a = resolveRequestBudget({ contextLength: 33_792 })
    const b = resolveRequestBudget({ contextLength: 33_793 })
    expect(a.inputLimit).toBeGreaterThan(20_000)
    expect(b.inputLimit).toBeGreaterThan(20_000)
    expect(Math.abs(a.inputLimit - b.inputLimit)).toBeLessThan(100)
  })

  it('小窗口未指定输出 → 输出不超过窗口的四分之一', () => {
    const budget = resolveRequestBudget({ contextLength: 32_000 })
    expect(budget.outputTokens).toBe(8_000)
    expect(budget.inputLimit).toBe(32_000 - 8_000 - REQUEST_SAFETY_MARGIN_TOKENS)
  })

  it('指定输出覆盖配置', () => {
    const budget = resolveRequestBudget(
      { contextLength: 128_000, maxOutputTokens: 16_000 },
      SUMMARY_MIN_OUTPUT_TOKENS
    )
    expect(budget.outputTokens).toBe(SUMMARY_MIN_OUTPUT_TOKENS)
    expect(budget.inputLimit).toBe(128_000 - SUMMARY_MIN_OUTPUT_TOKENS - REQUEST_SAFETY_MARGIN_TOKENS)
  })

  it('输出加余量超过窗口时输入至少留 1', () => {
    const budget = resolveRequestBudget({ contextLength: 1000, maxOutputTokens: 4000 })
    expect(budget.inputLimit).toBe(1)
  })

  it('输出上限等于窗口时按没填处理，十几 K 的对话仍能发', () => {
    const budget = resolveRequestBudget({ contextLength: 128_000, maxOutputTokens: 128_000 })
    expect(budget.outputTokens).toBe(Math.min(DEFAULT_MAX_OUTPUT_TOKENS, 128_000 / 4))
    expect(budget.inputLimit).toBeGreaterThan(80_000)
  })

  it('输出上限大于窗口时同样按没填处理', () => {
    const budget = resolveRequestBudget({ contextLength: 128_000, maxOutputTokens: 384_000 })
    expect(budget.outputTokens).toBe(Math.min(DEFAULT_MAX_OUTPUT_TOKENS, 128_000 / 4))
    expect(budget.inputLimit).toBeGreaterThan(80_000)
  })

  it('用户填了比窗口小的输出上限：仍听用户的', () => {
    const budget = resolveRequestBudget({ contextLength: 128_000, maxOutputTokens: 16_000 })
    expect(budget.outputTokens).toBe(16_000)
    expect(budget.inputLimit).toBe(128_000 - 16_000 - REQUEST_SAFETY_MARGIN_TOKENS)
  })

  it('用户填的输出偏大但仍小于窗口：输入至少留四分之一', () => {
    const budget = resolveRequestBudget({ contextLength: 128_000, maxOutputTokens: 110_000 })
    expect(budget.inputLimit).toBeGreaterThanOrEqual(32_000)
    expect(budget.outputTokens).toBeLessThan(110_000)
  })
})

describe('resolveSummaryBudget', () => {
  it('可用空间的 8%：窗口大就多写', () => {
    const b = resolveSummaryBudget(80_000, 128_000)
    expect(b.outputTokens).toBe(6_400)
    expect(b.chars).toBe(6_200)
  })

  it('下限：可用空间很小也不低于 2048 额度 / 2000 字', () => {
    const b = resolveSummaryBudget(7_000, 32_000)
    expect(b.outputTokens).toBe(SUMMARY_MIN_OUTPUT_TOKENS)
    expect(b.chars).toBe(2_000)
  })

  it('上界：窗口再大也不超过封顶', () => {
    const b = resolveSummaryBudget(900_000, 1_000_000)
    expect(b.outputTokens).toBe(SUMMARY_CEILING_OUTPUT_TOKENS)
  })

  it('极小窗口：不超过整窗的八分之一，小结不会把窗口挤爆', () => {
    const b = resolveSummaryBudget(0, 8_000)
    expect(b.outputTokens).toBe(1_000)
    expect(b.chars).toBeLessThanOrEqual(b.outputTokens)
  })

  it('更小的窗口也不超过整窗八分之一，字数不超过额度', () => {
    const b = resolveSummaryBudget(0, 2_000)
    expect(b.outputTokens).toBe(250)
    expect(b.chars).toBeLessThanOrEqual(b.outputTokens)
    const c = resolveSummaryBudget(80_000, 128_000, 50)
    expect(c.outputTokens).toBe(50)
    expect(c.chars).toBeLessThanOrEqual(50)
  })

  it('配置声明了更小的单次输出上限 → 听配置', () => {
    const b = resolveSummaryBudget(80_000, 128_000, 1_500)
    expect(b.outputTokens).toBe(1_500)
  })

  it('提示词字数不超过发给接口的额度', () => {
    for (const available of [0, 3_000, 20_000, 80_000, 500_000]) {
      const b = resolveSummaryBudget(available, 1_000_000)
      expect(b.chars).toBeLessThanOrEqual(b.outputTokens)
    }
  })
})
