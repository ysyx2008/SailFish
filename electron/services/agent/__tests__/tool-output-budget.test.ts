import { describe, it, expect } from 'vitest'
import {
  computeToolOutputBudget,
  applyParallelShare,
  getTierOutputCap,
  getMaxReadLines,
  TOOL_OUTPUT_MIN_CHARS,
  TOOL_OUTPUT_CRITICAL_FLOOR,
  TOOL_OUTPUT_FLAT_CAP,
} from '../tool-output-budget'

describe('computeToolOutputBudget', () => {
  it('returns full tier cap when context is mostly empty', () => {
    const budget = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 10_000,
    })
    expect(budget.maxChars).toBe(getTierOutputCap(128_000))
    expect(budget.maxLines).toBe(getMaxReadLines(128_000))
    expect(budget.critical).toBe(false)
  })

  it('shrinks under 70% usage pressure', () => {
    const budget = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 90_000,
    })
    expect(budget.maxChars).toBeLessThan(getTierOutputCap(128_000))
    expect(budget.critical).toBe(false)
  })

  it('shrinks further under 85% usage', () => {
    const low = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 90_000,
    })
    const high = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 110_000,
    })
    expect(high.maxChars).toBeLessThan(low.maxChars)
  })

  it('returns zero maxChars when context is effectively full', () => {
    const budget = computeToolOutputBudget({
      contextLength: 32_000,
      currentTokens: 31_500,
    })
    expect(budget.maxChars).toBe(0)
    expect(budget.critical).toBe(true)
  })

  it('uses critical floor when remaining is tiny but non-zero', () => {
    const budget = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 108_000,
    })
    expect(budget.maxChars).toBeGreaterThan(0)
    expect(budget.maxChars).toBeLessThan(TOOL_OUTPUT_MIN_CHARS)
    expect(budget.maxChars).toBeGreaterThanOrEqual(TOOL_OUTPUT_CRITICAL_FLOOR)
  })

  it('单次上限与窗口大小无关：110K 与 1M 窗口相同，小窗口不超过自己的档位', () => {
    const at = (contextLength: number) =>
      computeToolOutputBudget({ contextLength, currentTokens: 1_000 }).maxChars
    expect(at(110_000)).toBe(TOOL_OUTPUT_FLAT_CAP)
    expect(at(128_000)).toBe(TOOL_OUTPUT_FLAT_CAP)
    expect(at(1_000_000)).toBe(TOOL_OUTPUT_FLAT_CAP)
    expect(at(32_000)).toBeLessThan(TOOL_OUTPUT_FLAT_CAP)
  })

  it('uses smaller tier for 32K models', () => {
    const budget = computeToolOutputBudget({
      contextLength: 32_000,
      currentTokens: 5_000,
    })
    expect(budget.maxChars).toBe(getTierOutputCap(32_000))
    expect(budget.maxLines).toBe(200)
  })
})

describe('applyParallelShare', () => {
  it('divides maxChars and maxLines among parallel tools', () => {
    const base = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 10_000,
    })
    const shared = applyParallelShare(base, 3)
    expect(shared.maxChars).toBe(Math.max(TOOL_OUTPUT_CRITICAL_FLOOR, Math.floor(base.maxChars / 3)))
    expect(shared.maxLines).toBe(Math.floor(base.maxLines / 3))
  })

  it('keeps maxChars at zero when base budget is exhausted', () => {
    const base = computeToolOutputBudget({
      contextLength: 32_000,
      currentTokens: 31_500,
    })
    expect(base.maxChars).toBe(0)
    const shared = applyParallelShare(base, 4)
    expect(shared.maxChars).toBe(0)
  })

  it('is a no-op for single tool', () => {
    const base = computeToolOutputBudget({
      contextLength: 128_000,
      currentTokens: 10_000,
    })
    expect(applyParallelShare(base, 1)).toEqual(base)
  })
})
