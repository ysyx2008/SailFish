/**
 * tool_call / tool_result 步骤的"是否在 UI 中显示"策略。
 *
 * 设计原则（与 SPEC「工具执行透明原则」对齐）：
 * - 后端永远 emit `tool_call` + `tool_result` 并写入会话历史（不受 debugMode 影响，保证持久化完整）
 * - debugMode 只影响**前端是否渲染**这两类步骤
 * - 关闭调试模式时，成功的 tool_result 默认不渲染——tool_call 绿条已表达"做完了"；
 *   仅 ALWAYS_SHOW_RESULT_TOOLS 或携带富内容字段的步骤例外
 *
 * 分类：
 * - TOOLS_WITH_DEDICATED_STEP_TYPE: 用专用 step type（plan_*）整张卡承载"做什么 + 做完了"的工具，
 *   非调试模式下其 tool_call 通告卡 + tool_result 兜底卡都隐藏，避免与专用卡重复展示
 * - ALWAYS_SHOW_RESULT_TOOLS: 少数 tool_result 含用户必看独立产出的工具——成功时也展示结果卡
 *
 * 失败的步骤（step.success === false）始终展示，让用户立刻看到错误。
 * 携带 images / webSearchResults / subAgents 等专用富内容字段的 step 也始终保留
 * （折叠收起时不占地方，点开那一行还要画得出来）。
 *
 * 维护说明：新增工具时默认无需登记——成功 tool_result 自动隐藏。
 * 若某工具的 tool_result 有独立于 tool_call 的用户必看产出，加入 ALWAYS_SHOW_RESULT_TOOLS。
 */

/**
 * 这些工具用专用 step type 直接呈现（如 plan→`plan_*`、ask_user→`asking`、wait→`waiting`），
 * 专用卡本身已包含完整的"做什么 + 进度 / 状态 / 结果"信息——非调试模式下隐藏其
 * `tool_call`（流式通告卡 `调用: xxx`）和 `tool_result`（ensureToolResultStep 兜底卡），
 * 避免与专用卡内容重复。调试模式下依然展示，方便排查工具执行链路。
 */
export const TOOLS_WITH_DEDICATED_STEP_TYPE = new Set<string>([
  'plan',       // → plan_created / plan_updated / plan_archived
  'ask_user',   // → asking
  'wait',       // → waiting
])

/** 成功时 tool_result 仍需独立展示——content 含 tool_call 无法承载的用户必看信息 */
export const ALWAYS_SHOW_RESULT_TOOLS = new Set<string>([
  // 主动消息（talk_to_user 的 tool_result 携带实际发送正文，用户需始终可见）
  'talk_to_user',
  'send_file_to_chat',
  'send_image_to_chat',
])

/**
 * tool_result step 是否携带了富内容字段——折叠收起时不占地方，
 * 但点开还要画，所以不能因为 debugMode 关闭而被丢掉。
 */
export function hasRichPayload(step: {
  images?: unknown[]
  echartsOption?: unknown
  webSearchResults?: unknown[]
  subAgents?: unknown[]
}): boolean {
  if (step.images && step.images.length > 0) return true
  if (step.echartsOption) return true
  if (step.webSearchResults && step.webSearchResults.length > 0) return true
  if (step.subAgents && step.subAgents.length > 0) return true
  return false
}

/**
 * 判断 tool_call / tool_result 步骤是否需要在 UI 中渲染。
 *
 * 仅适用于 `tool_call` 与 `tool_result` 两种 step type；其它 step 类型由调用方自行决定（默认展示）。
 * 失败步骤（success === false）和携带富内容字段（images / webSearchResults / subAgents）的步骤始终展示。
 *
 * @param step tool_call 或 tool_result 步骤
 * @param debugMode 当前 UI 的调试模式开关
 */
export function shouldShowToolResultStep(
  step: {
    type: string
    toolName?: string
    success?: boolean
    images?: unknown[]
    echartsOption?: unknown
    webSearchResults?: unknown[]
    subAgents?: unknown[]
  },
  debugMode: boolean
): boolean {
  // 仅对 tool_call / tool_result 应用过滤；其它 step 类型由调用方自行决定（默认展示）
  if (step.type !== 'tool_result' && step.type !== 'tool_call') return true
  // 失败步骤始终展示（让用户立刻看到错误）
  if (step.success === false) return true
  // 调试模式：所有 tool_call / tool_result 都展示
  if (debugMode) return true
  // 用专用 step type 呈现的工具（如 plan / ask_user / wait）：tool_call + tool_result 都隐藏。
  if (step.toolName && TOOLS_WITH_DEDICATED_STEP_TYPE.has(step.toolName)) return false
  // 携带富内容字段的 step 始终保留（点开折叠还要画图、搜索结果、子任务进度）
  if (hasRichPayload(step)) return true
  // tool_result：非调试模式下默认隐藏（tool_call 绿条已表达成功）；仅 ALWAYS_SHOW 例外
  if (step.type === 'tool_result') {
    if (step.toolName && ALWAYS_SHOW_RESULT_TOOLS.has(step.toolName)) return true
    return false
  }
  // tool_call 默认展示（保留"知情权"——用户需要看到 Agent 准备做什么）
  return true
}
