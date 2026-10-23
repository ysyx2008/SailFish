/**
 * 工具输出字符预算（防「最后一读把上下文撑爆」）
 *
 * 在工具结果写入 run.messages 前，根据模型 contextLength 与当前已用量
 * 计算单次 output 允许的最大字符数。read_file 等只读工具在返回前截断。
 */

export const TOOL_OUTPUT_MIN_CHARS = 4096
export const TOOL_OUTPUT_HARD_CAP = 65_536
export const TOOL_OUTPUT_CRITICAL_FLOOR = 512
export const CONTEXT_RESERVE_RATIO = 0.15
export const CONTEXT_RESERVE_MIN_TOKENS = 4096
/** 保守估计：1 token ≈ 0.5 字符（中文更密），取 2 字符/token 留余量 */
export const CHARS_PER_TOKEN_ESTIMATE = 2

export interface ToolOutputBudgetInput {
  contextLength: number
  currentTokens: number
}

export interface ToolOutputBudget {
  /** 本次 tool output 允许的最大字符数（含截断 notice） */
  maxChars: number
  /** 单次 range read 允许的最大行数 */
  maxLines: number
  /** 上下文已紧张，output 可能被大幅压缩或仅返回摘要 */
  critical: boolean
  usagePercent: number
}

/**
 * 单次读入的字符上限，与窗口大小无关。
 * 按实测最密内容约 0.6 token/字符，16,000 字符最坏约 1 万 token；
 * 窗口再大也不多给——本地估算对密集内容会估少，单次读得越多越容易一步越界。
 */
export const TOOL_OUTPUT_FLAT_CAP = 16_000

export function getTierOutputCap(contextLength: number): number {
  return contextLength <= 32_000 ? 8_192 : TOOL_OUTPUT_FLAT_CAP
}

export function getPressureMultiplier(usageRatio: number): number {
  if (usageRatio >= 0.85) return 0.25
  if (usageRatio >= 0.70) return 0.5
  return 1.0
}

export function getMaxReadLines(contextLength: number): number {
  if (contextLength <= 32_000) return 200
  if (contextLength <= 128_000) return 500
  return 800
}

/**
 * 计算单次工具 output 字符预算。
 * remaining = contextLength - currentTokens - reserve；与档位上限取 min。
 */
export function computeToolOutputBudget(input: ToolOutputBudgetInput): ToolOutputBudget {
  const contextLength = Math.max(1, input.contextLength)
  const currentTokens = Math.max(0, input.currentTokens)
  const usageRatio = Math.min(1, currentTokens / contextLength)
  const usagePercent = Math.round(usageRatio * 100)

  const reserveTokens = Math.max(
    CONTEXT_RESERVE_MIN_TOKENS,
    Math.floor(contextLength * CONTEXT_RESERVE_RATIO)
  )
  const remainingTokens = Math.max(0, contextLength - currentTokens - reserveTokens)
  const remainingChars = Math.floor(remainingTokens * CHARS_PER_TOKEN_ESTIMATE)

  const tierCap = getTierOutputCap(contextLength)
  const tierAdjusted = Math.floor(tierCap * getPressureMultiplier(usageRatio))

  let maxChars = Math.min(tierAdjusted, remainingChars, TOOL_OUTPUT_HARD_CAP)

  const critical =
    usageRatio >= 0.85 ||
    remainingTokens < 8192 ||
    maxChars < TOOL_OUTPUT_MIN_CHARS

  if (maxChars <= 0) {
    return {
      maxChars: 0,
      maxLines: getMaxReadLines(contextLength),
      critical: true,
      usagePercent,
    }
  }

  if (maxChars < TOOL_OUTPUT_MIN_CHARS) {
    maxChars = Math.max(TOOL_OUTPUT_CRITICAL_FLOOR, maxChars)
  }

  return {
    maxChars,
    maxLines: getMaxReadLines(contextLength),
    critical,
    usagePercent,
  }
}

/**
 * 并行 tool batch 内按份额分摊 output 预算，避免 N 个 read 各拿满额叠加撑爆上下文。
 */
export function applyParallelShare(
  budget: ToolOutputBudget,
  parallelShare: number
): ToolOutputBudget {
  const share = Math.max(1, Math.floor(parallelShare))
  if (share <= 1) return budget

  const maxLines = Math.max(1, Math.floor(budget.maxLines / share))

  if (budget.maxChars <= 0) {
    return { ...budget, maxLines }
  }

  const divided = Math.floor(budget.maxChars / share)
  const maxChars = Math.max(TOOL_OUTPUT_CRITICAL_FLOOR, divided)

  return { ...budget, maxChars, maxLines }
}
