/**
 * Agent 共享类型定义
 * 前后端通用，IPC 安全（不含不可序列化的字段如函数回调）
 */

import type { WorkbenchContext } from './workbench'

/** 终端/执行环境类型：本地终端、SSH 远程终端、纯助手模式（无终端） */
export type TerminalType = 'local' | 'ssh' | 'assistant'

/**
 * 会话类别——对应 Agent 的存在方式（互斥）：
 * - task：直接接受指令干活，可并行、可隔离（普通 tab）
 * - companion：与用户的对话，一条长期关系线，多渠道汇流（联络 `__companion__`）
 * - watch：关切——用户配置的一次性任务，逐次失忆、独立历史树（`__watch__`）
 * - wakeup：唤醒/心跳——Agent 的内心独白与自主循环，需要历史记忆辅助决策（`__wakeup__`）
 * 详见 docs/conversation-refactor-design.md 与 project-architecture.mdc。
 */
export type ConversationKind = 'task' | 'companion' | 'watch' | 'wakeup'

/** 联络常驻 Agent key（一条长期关系线，全渠道汇流） */
export const COMPANION_AGENT_KEY = '__companion__'
/** 关切（Watch）Agent key 前缀；legacy 整 key 为 `__watch__`，并发后为 `__watch__:${watchId}` */
export const WATCH_AGENT_KEY = '__watch__'
/** 唤醒常驻 Agent key（心跳/内心独白，跨执行保留记忆辅助决策） */
export const WAKEUP_AGENT_KEY = '__wakeup__'

/** 是否为关切 Agent key（含 legacy `__watch__` 与 `__watch__:${watchId}`） */
export function isWatchAgentKey(agentKey?: string): boolean {
  if (!agentKey) return false
  return agentKey === WATCH_AGENT_KEY || agentKey.startsWith(`${WATCH_AGENT_KEY}:`)
}

/** 普通关切的 per-watch Agent key（用于并发隔离） */
export function watchAgentKeyFor(watchId: string): string {
  if (!watchId) throw new Error('watchAgentKeyFor: watchId is required')
  return `${WATCH_AGENT_KEY}:${watchId}`
}

/** 从 `__watch__:${watchId}` 解析 watchId；legacy `__watch__` 返回 null */
export function watchIdFromAgentKey(agentKey?: string): string | null {
  if (!agentKey?.startsWith(`${WATCH_AGENT_KEY}:`)) return null
  const id = agentKey.slice(WATCH_AGENT_KEY.length + 1)
  return id || null
}

/**
 * 从 agentKey 推断会话类别。常驻命名 Agent 用固定 key，其余皆为普通任务。
 * 这是 kind 的唯一推断口径——历史记录缺 `kind` 字段时按此补默认（向后兼容）。
 */
export function inferConversationKind(agentKey?: string): ConversationKind {
  if (agentKey === COMPANION_AGENT_KEY) return 'companion'
  if (agentKey === WAKEUP_AGENT_KEY) return 'wakeup'
  if (isWatchAgentKey(agentKey)) return 'watch'
  return 'task'
}

/** Agent 执行模式：strict=所有命令需确认，relaxed=仅危险命令需确认，free=全自动 */
export type ExecutionMode = 'strict' | 'relaxed' | 'free'

/** 它有多主动地把已经用不上的过程先交接掉 */
export const PROACTIVE_COMPACT_STYLES = ['more', 'balanced', 'less', 'off'] as const
export type ProactiveCompactStyle = (typeof PROACTIVE_COMPACT_STYLES)[number]
export const DEFAULT_PROACTIVE_COMPACT: ProactiveCompactStyle = 'balanced'

export function normalizeProactiveCompact(raw: unknown): ProactiveCompactStyle {
  return (PROACTIVE_COMPACT_STYLES as readonly string[]).includes(raw as string)
    ? (raw as ProactiveCompactStyle)
    : DEFAULT_PROACTIVE_COMPACT
}

/** 智能巡检的确认策略：cautious=逐条审慎，batch=批量确认，free=自由模式 */
export type ConfirmStrategy = 'cautious' | 'batch' | 'free'

/** 远程访问渠道 */
export type RemoteChannel = 'desktop' | 'web' | 'dingtalk' | 'feishu' | 'slack' | 'telegram' | 'wecom' | 'wechat'

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked'

/** 向用户提问这道题的结果。说明文字不是状态。 */
export type AskingStatus = 'waiting' | 'received' | 'timeout' | 'cancelled'

export function isAskingSettled(status?: AskingStatus): boolean {
  return status === 'received' || status === 'timeout' || status === 'cancelled'
}

/** 提问等待：没设用 120 秒；最短 1 秒；最长 600 秒。 */
export const ASK_USER_TIMEOUT_DEFAULT_SEC = 120
export const ASK_USER_TIMEOUT_MIN_SEC = 1
export const ASK_USER_TIMEOUT_MAX_SEC = 600

export function clampAskUserTimeout(timeout?: unknown): number {
  if (typeof timeout === 'number' && Number.isFinite(timeout)) {
    return Math.min(
      ASK_USER_TIMEOUT_MAX_SEC,
      Math.max(ASK_USER_TIMEOUT_MIN_SEC, Math.round(timeout))
    )
  }
  return ASK_USER_TIMEOUT_DEFAULT_SEC
}

/**
 * 命令风险策略（按 executionMode 分档 + 若干开关）
 *
 * Fail-Closed 兜底（parseFail / unknownCmd / indirection / dynamicPath）：
 * - 可选值限定 moderate / dangerous / blocked（safe 不允许）
 * - free 模式跟随 relaxed 配置
 *
 * 注意：Windows 原生 shell（PowerShell/CMD）走 legacyAssess，不套 Fail-Closed 档位。
 * blocked 是硬墙--任何 executionMode 下都会拒绝执行，慎用。
 */
export interface CommandRiskPolicy {
  /** strict 模式下解析失败的等级（默认 dangerous） */
  strictParseFail: RiskLevel
  /** strict 模式下未知命令的等级（默认 dangerous） */
  strictUnknownCmd: RiskLevel
  /** strict 模式下间接执行（node -e / python -c 等）的等级（默认 dangerous） */
  strictIndirection: RiskLevel
  /** strict 模式下动态路径无法静态审计时的等级（默认 dangerous） */
  strictDynamicPath: RiskLevel
  /** relaxed 模式下解析失败的等级（默认 moderate） */
  relaxedParseFail: RiskLevel
  /** relaxed 模式下未知命令的等级（默认 moderate） */
  relaxedUnknownCmd: RiskLevel
  /** relaxed 模式下间接执行的等级（默认 moderate） */
  relaxedIndirection: RiskLevel
  /** relaxed 模式下动态路径的等级（默认 moderate） */
  relaxedDynamicPath: RiskLevel
  /**
   * relaxed 模式下是否也对 moderate 弹确认（默认 false）。
   * true 时行为更接近「半严格」：safe 放行，moderate+ 确认。
   */
  relaxedConfirmModerate: boolean
  /**
   * 工作区外写操作是否升级确认（默认 false）。
   * true 时：safe 命令写到工作区外升为 moderate（需确认）。
   */
  outsideWritesUpgrade: boolean
  /**
   * 额外自由区目录（绝对路径），读写删免确认，语义同 scratch/charts。
   */
  extraFreeDirs: string[]
  /**
   * 子 Agent 是否自动阻止 dangerous（默认 true）。
   * false 时仅阻止 blocked；dangerous 仍可由主确认策略处理（子 Agent 本身无确认 UI，
   * 故 false 等于允许子 Agent 执行 dangerous——仅高信任场景开启）。
   */
  subAgentBlockDangerous: boolean
}

/** CommandRiskPolicy 各档位字段允许的取值（不含 safe） */
export const COMMAND_RISK_POLICY_ALLOWED_LEVELS: readonly RiskLevel[] = ['moderate', 'dangerous', 'blocked'] as const

/** CommandRiskPolicy 默认值 */
export const DEFAULT_COMMAND_RISK_POLICY: CommandRiskPolicy = {
  strictParseFail: 'dangerous',
  strictUnknownCmd: 'dangerous',
  strictIndirection: 'dangerous',
  strictDynamicPath: 'dangerous',
  relaxedParseFail: 'moderate',
  relaxedUnknownCmd: 'moderate',
  relaxedIndirection: 'moderate',
  relaxedDynamicPath: 'moderate',
  relaxedConfirmModerate: false,
  outsideWritesUpgrade: false,
  extraFreeDirs: [],
  subAgentBlockDangerous: true,
}

/** API 调用的 token 用量（由 LLM provider 返回的精确值） */
export interface TokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens?: number
  cache_miss_tokens?: number
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

export interface StepProgress {
  value: number
  current?: number
  total?: number
  eta?: string
  speed?: string
  isIndeterminate: boolean
  statusText?: string
}

export interface AgentPlanStep {
  id: string
  title: string
  description?: string
  status: PlanStepStatus
  result?: string
  startedAt?: number
  completedAt?: number
  progress?: StepProgress
  terminalId?: string
  terminalName?: string
  hostId?: string
  isParallel?: boolean
}

export interface AgentPlan {
  id: string
  title: string
  steps: AgentPlanStep[]
  paused?: boolean
  createdAt: number
  updatedAt: number
}

/**
 * 一轮已经收尾、还没送进模型的用户补充。
 * 界面用它开下一轮；图片和附件必须一起带上，不能只留文字。
 * 旧的完成事件只传字符串，两种形状都要认。
 */
export interface PendingUserHandoff {
  message: string
  images?: string[]
  attachments?: AttachmentInfo[]
  documentContext?: string
  workbenchContext?: import('./workbench').WorkbenchContext
}

/** 用户消息附带的文件附件元信息（仅用于 UI 展示，不含文件内容） */
export interface AttachmentInfo {
  filename: string
  /** 文件完整路径（供 Agent 直接访问） */
  filePath?: string
  fileSize: number
  fileType: string
  /** PDF/文档总页数 */
  totalPages?: number
  /** 已渲染为预览图片的页数 */
  previewPages?: number
}

/** 分屏窗格信息（用于多屏感知 system prompt 注入） */
export interface AgentPaneInfo {
  paneId: string
  ptyId: string
  /** 方位（左侧 / 右上…）——用户按方位说话 */
  label: string
  /**
   * 此刻连着哪台机器（会话名 / 登录账号与地址 / 本地终端）——用户按机器指认。
   * 按当前连接实时取值，重连或换会话后会变；老入口可能不带。
   */
  connectionName?: string
  isActive: boolean
  terminalOutput: string[]
  terminalType: 'local' | 'ssh'
}

/**
 * 一次 Agent 运行的上下文：它在哪台机器上、看到什么、带了什么材料。
 *
 * 前后端共用同一份定义——发起方（前端 IPC / IM / 网关 / 关切）少填一个字段，
 * 后端就只能靠猜，猜错还会落进历史记录里（曾把助手会话全存成本地终端）。
 */
export interface AgentContext {
  ptyId?: string
  /** 最近的终端输出（分屏模式下为激活窗格的输出） */
  terminalOutput: string[]
  systemInfo: {
    os: string
    shell: string
  }
  terminalType: TerminalType
  remoteChannel?: RemoteChannel
  /** 当前工作目录（告知 AI 当前位置，帮助正确处理相对路径） */
  cwd?: string
  /** 主机档案 ID */
  hostId?: string
  /** 用户上传的文档内容 */
  documentContext?: string
  /** 用户上传的图片（base64 data URL），发送给 AI 用于视觉理解 */
  images?: string[]
  /** UI 展示用的预览图片（仅 PDF 页面渲染），缺省时用 images */
  previewImages?: string[]
  /** 用户上传的文件元信息（用于 user_task 步骤展示） */
  attachments?: AttachmentInfo[]
  /** SSH 主机地址（用于历史记录元数据） */
  sshHost?: string
  /** 从历史恢复的会话 ID（后端自行加载历史数据） */
  sessionId?: string
  /** 从历史恢复的会话开始时间 */
  sessionStartTime?: number
  /** 当前执行计划（从前端 steps 恢复，用于跨对话持久化） */
  currentPlan?: AgentPlan
  /** 唤醒模式：静默运行，不累积到会话历史 */
  wakeup?: boolean
  /**
   * 本次执行无人值守：没有可同步应答的对象。
   *
   * 由各入口如实申报当次执行的真实处境，而非入口类型——同一个 CLI 进程，
   * 交互式跑（有人）和脚本里跑（无人）结论不同。关切/唤醒恒为 true。
   */
  unattended?: boolean
  /** IM 场景：Agent 之前主动发送的消息内容，作为用户回复的上下文注入 API 消息 */
  proactiveContext?: string
  /** 仅注入 API 消息的上下文提示（如首次联系提醒），不显示在 user_task 步骤中 */
  contextHint?: string
  /**
   * 工作台可扩展旁路上下文（选区作用域等）：组装进 API 信封，不上聊天气泡。
   * @see WorkbenchContext
   */
  workbenchContext?: WorkbenchContext
  // 分屏多屏感知（仅在 tab 处于分屏模式时由前端 IPC 注入）
  mode?: 'single' | 'split'
  panes?: AgentPaneInfo[]
  activePaneId?: string
  /**
   * 工作台 UI 描述（由前端在特定 workbench tab 对话时注入，prompt-builder 原样插入）。
   * 例如独立助手工作台的 Artifact 产出物面板说明；IM/Web/Watch 不传。
   */
  workbenchPrompt?: string
}

/** @deprecated 伙计不再分 read/write 两档，保留仅为旧记录兼容 */
export type SubAgentTypeName = 'read' | 'write'

/** 子 Agent 任务描述（dispatch_agents 工具参数） */
export interface SubAgentTask {
  id: string
  /** 这场任务里招呼他的名字 */
  name?: string
  description: string
  prompt: string
  /** @deprecated 不再使用 */
  agentType?: SubAgentTypeName
}

/** 子 Agent 单步工具调用记录 */
export interface SubAgentToolStep {
  tool: string
  args?: string
  status: 'running' | 'completed' | 'failed'
  result?: string
}

/** Web 搜索结果条目（供 UI 展开渲染） */
export interface WebSearchResultItem {
  title: string
  url: string
  snippet?: string
  /** 提取的正文（部分 Provider 支持，展示时会截断） */
  content?: string
}

/** 子 Agent 执行结果（通过 AgentStep.subAgents 推送进度） */
export interface SubAgentResult {
  id: string
  /** 这场任务里招呼他的名字 */
  name?: string
  description: string
  /** 主 Agent 下达的具体任务指令 */
  prompt?: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted'
  result?: string
  error?: string
  /** 卡住原因（高危被拦等） */
  blockedReason?: string
  tokensUsed?: TokenUsage
  /** 子 Agent 工具调用步骤（实时更新，提供执行过程透明度） */
  steps?: SubAgentToolStep[]
}

/**
 * 「活图」载荷：让前端在对话气泡里实例化 ECharts，提供 tooltip / dataZoom / legend toggle
 * 等交互能力，并支持高 DPI 复制 / 任意倍率另存为。
 *
 * 与 `images` 是**并列两路**而不是替代关系：
 *   - chart skill 在 svg 模式下同时投递 `echartsOption`（活图）+ `images`（SVG 兜底）
 *   - 前端渲染优先级：`echartsOption` > `images`
 *   - `images` 兜底场景：旧历史记录、不支持 echarts 的视图（如 Awaken 关切面板）、
 *     钉钉/飞书 IM 渠道转发（IM 链路只用 `format='png'` 落盘的文件，不读这些 dataURL）
 *   - PNG 模式（AI 显式选 `format='png'`，意图是导出位图）下 chart skill 不投递 echartsOption——
 *     用户在气泡里看到的 PNG 与导出文件视觉一致更直观
 *
 * IPC 通过结构化克隆透传，注意 `option` 必须是纯 JSON 兼容对象（chart skill 的
 * `buildOption` 已经把所有主题颜色 inline 进去，无函数引用）。
 */
export interface EChartsStepPayload {
  /** 完整 ECharts option（v6+ 格式，已含 backgroundColor/color/textStyle 等主题） */
  option: Record<string, unknown>
  /** 后端建议的画布逻辑宽度（px），前端按容器实际宽度 resize，但保留宽高比 */
  width: number
  /** 后端建议的画布逻辑高度（px） */
  height: number
  /**
   * 渲染前需 registerMap 的内置地图 id（world / china / p{adcode}）。
   * GeoJSON 文件不进 IPC，前后端各自从 resources/chart-maps 加载。
   */
  registeredMaps?: string[]
}

export interface AgentStep {
  id: string
  type: 'thinking' | 'tool_call' | 'tool_result' | 'message' | 'error' | 'confirm' | 'streaming' | 'user_supplement' | 'waiting' | 'asking' | 'waiting_password' | 'waiting_input' | 'plan_created' | 'plan_updated' | 'plan_archived' | 'user_task' | 'final_result' | 'proactive_notice' | 'auto_review'
  content: string
  images?: string[]
  /**
   * 「活图」载荷。chart skill 在默认 svg 模式下注入；前端用 echarts 实例化得到
   * 可交互图表（tooltip / legend toggle / dataZoom 等）。同时 `images` 仍带 SVG
   * 兜底以兼容历史展示链路。详见 `EChartsStepPayload` 注释。
   */
  echartsOption?: EChartsStepPayload
  attachments?: AttachmentInfo[]
  toolName?: string
  /**
   * 关联的 tool_call ID。用于在同一批工具调用中精确配对 tool_call ↔ tool_result，
   * 避免按 toolName 配对时同名工具相互覆盖。
   * 仅 tool_call / tool_result 步骤需要；老历史数据可能缺失，此时退化为按 toolName 匹配。
   */
  toolCallId?: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  riskLevel?: RiskLevel
  timestamp: number
  isStreaming?: boolean
  plan?: AgentPlan
  progress?: StepProgress
  contextTokens?: number
  /**
   * 本次 API 调用实际使用的模型上下文窗口大小（tokens）。
   * 当发生视觉模型自动切换时，此值反映切换后模型的 contextLength，
   * 而非前端 activeAiProfile 的 contextLength。
   * 实时状态栏优先读 `AgentContextBar`；本字段仍写入 step 供历史落盘。
   */
  effectiveContextLength?: number
  /**
   * 本次 API 调用实际使用的模型 Profile 名称（用户自定义名）。
   * 当发生视觉模型自动切换时，此值为切换后的 profile.name。
   * 实时状态栏优先读 `AgentContextBar`；本字段仍写入 step 供历史落盘。
   */
  effectiveModel?: string
  /** 本次 API 调用的缓存命中率（0-100），由后端计算后推送 */
  cacheHitRate?: number
  /** Canvas 预览数据（仅 UI 消费，不发给 AI） */
  canvasData?: import('./canvas').CanvasData
  /** 并行子 Agent 状态（dispatch_agents 工具专用，实时更新） */
  subAgents?: SubAgentResult[]
  /** Web 搜索结果（web_search 工具专用，供 UI 可展开渲染） */
  webSearchResults?: WebSearchResultItem[]
  /**
   * 工具执行是否成功。仅 tool_call 步骤使用：
   *   undefined → 还在运行（或没有执行结果）
   *   true      → 成功
   *   false     → 失败（包括用户拒绝、超时、工具异常）
   * 用于 UI 侧将"左侧风险色竖条"切换为"执行结果色竖条"，避免把风险红色误解为执行失败。
   */
  success?: boolean
  /**
   * 向用户提问这道题的结果。仅 asking 步骤使用。
   * 旧记录可能缺失：任务已不在跑则当作已经结束。
   */
  askingStatus?: AskingStatus
  /**
   * asking 步骤：用户亲手输入或点选的回答（不含超时/空回复时补上的默认值）。
   * 「替我审批」只把这类回答当作用户的原话。
   */
  askingAnswer?: string
  /** auto_review 步骤：替我审批这一次的结论 */
  autoReview?: AutoReviewTrail
  /**
   * 此步骤是否对应"被用户拒绝执行"。仅由工具层在拒绝场景显式标记。
   * UI 用此字段（而不是 content 关键词）渲染"灰色 + 半透明"的拒绝样式，
   * 避免正文里出现"拒绝"二字的 message step 被误判为拒绝步骤而整体变灰。
   */
  rejected?: boolean
  /**
   * 临时 UI 占位标记。`startup` = run 开头「正在准备…/等待首 token」步骤，
   * 首条 message 或 tool_call 产出后由后端 removeStep，不应落盘或留在历史。
   */
  placeholder?: 'startup'
  /**
   * 读历史时遇到超大工具输出：正文未装入，只留大小和头尾。
   * 聊天里不要整段渲染 toolResult。
   */
  hugeOutput?: HugeOutputStub
}

/** 超大工具输出的占位：给大小、开头、结尾，必要时另存为文件。 */
export interface HugeOutputStub {
  bytes: number
  skipped: true
  head?: string
  tail?: string
  sourceFile?: string
  sourceLine?: number
}

/** Agent 启动阶段的临时占位步骤（等待首 token 前，不应落盘） */
export function isStartupPlaceholderStep(
  step: Pick<AgentStep, 'type' | 'isStreaming' | 'placeholder'>,
): boolean {
  if (step.placeholder === 'startup') return true
  return step.type === 'thinking' && step.isStreaming === true
}

/** 持久化时剔除 startup 占位 */
export function filterPersistableSteps<T extends AgentStep>(steps: T[]): T[] {
  return steps.filter(s => !isStartupPlaceholderStep(s))
}

/**
 * 上下文组成树节点 id（稳定枚举；UI 文案走 i18n）。
 * 一级：system / tools / messages；其余为二级叶子。
 */
export type ContextCompositionId =
  | 'root'
  | 'system'
  | 'identity'
  | 'rules'
  | 'skills'
  | 'knowledge'
  | 'environment'
  | 'tools'
  | 'builtin'
  | 'mcp'
  | 'messages'
  | 'history'
  | 'currentUser'
  | 'images'

/** 字数占比树节点（父 chars = 子之和；空块不入树） */
export interface ContextCompositionNode {
  id: ContextCompositionId
  chars: number
  children?: ContextCompositionNode[]
}

/**
 * 会话级「上下文栏」快照（token / cache / 拟用或已确认模型）。
 * 与 step 解耦：删占位、重试、流式接替不会把状态栏打空或回退主模型。
 * 确认值以 API usage 为准；请求中途可暂挂上轮确认 token + 本轮拟用 model/limit。
 */
export interface AgentContextBar {
  contextTokens?: number
  cacheHitRate?: number
  effectiveContextLength?: number
  effectiveModel?: string
  /** 拟用 / 已确认的 AI profileId（换模型时用于清 Cache%） */
  profileId?: string
  /**
   * 本次请求发出时的字数组成树（live 推送；不落盘）。
   * 占比按 chars；UI 只展示百分比（不折算约数 tokens）。
   */
  composition?: ContextCompositionNode
  /**
   * 当前会话在本进程内的累计 API 消耗（live 推送；不落盘、不从历史回种）。
   * 与 contextTokens（当前窗口占用）不是同一件事。
   */
  consumedTokens?: number
  consumedPromptTokens?: number
  consumedCompletionTokens?: number
  /** 输入里缓存命中的部分；服务商不报就没有这个字段 */
  consumedCacheHitTokens?: number
}

/** 从步骤流倒查最近一次带 contextTokens 的统计（历史加载 / 无 live 推送时回退） */
export function deriveContextBarFromSteps(
  steps: ReadonlyArray<Pick<AgentStep, 'contextTokens' | 'cacheHitRate' | 'effectiveContextLength' | 'effectiveModel'>>,
): AgentContextBar | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.contextTokens === undefined) continue
    const bar: AgentContextBar = { contextTokens: step.contextTokens }
    if (step.cacheHitRate !== undefined) bar.cacheHitRate = step.cacheHitRate
    if (step.effectiveContextLength !== undefined) bar.effectiveContextLength = step.effectiveContextLength
    if (step.effectiveModel !== undefined) bar.effectiveModel = step.effectiveModel
    return bar
  }
  return undefined
}

/**
 * 安全输入请求（IPC 安全版本，不含 resolve 回调）。
 *
 * Agent 通过 requestSecureInput 触发前端弹出安全输入框。用户输入的值
 * 经 IPC 直接写入加密存储，**不经过 LLM 上下文**，Agent 只收到"已设置/已取消"。
 */
export interface PendingSecureInput {
  agentId: string
  requestId: string
  /** 提示用户输入什么（如 "请输入 STOCK_API_KEY"） */
  prompt: string
  /** 技能 ID，用于存储时构建 credential key */
  skillId: string
  /** env 变量名（如 "STOCK_API_KEY"） */
  envName: string
  /** 可选：是否是更新（已配置过，本次覆盖） */
  isUpdate?: boolean
}

// ==================== 替我审批 ====================

/** 评审员给这一步定的风险分 */
export const AUTO_REVIEW_RISK_SCORES = ['low', 'medium', 'high', 'critical'] as const
export type AutoReviewRiskScore = (typeof AUTO_REVIEW_RISK_SCORES)[number]

/** 评审员判断用户原话对这一步的授权程度 */
export const AUTO_REVIEW_AUTHORIZATION_SCORES = ['high', 'medium', 'low', 'unknown'] as const
export type AutoReviewAuthorizationScore = (typeof AUTO_REVIEW_AUTHORIZATION_SCORES)[number]

/**
 * 没有替用户放行、交回用户确认的原因：
 * - not_approved：评审员看过，认为该问用户
 * - failed：超时、出错或评审结论看不懂
 * - too_large：用户原话或这一步参数太长，放不下就不评
 * - circuit_open：这一轮已连着几次没放行，后面直接问用户
 * - user_spoke：评审期间用户又说了话，重评后仍在变，交给用户
 */
export type AutoReviewHandOverReason = 'not_approved' | 'failed' | 'too_large' | 'circuit_open' | 'user_spoke'

/** 一次替我审批的留痕（写进 auto_review 步骤，也随确认卡带给用户） */
export interface AutoReviewTrail {
  outcome: 'approved' | 'handed_over'
  reason?: AutoReviewHandOverReason
  risk?: AutoReviewRiskScore
  authorization?: AutoReviewAuthorizationScore
  rationale?: string
}

/**
 * 待确认的工具调用（IPC 安全版本，不含 resolve 回调）
 * 后端通过 PendingConfirmationInternal 扩展 resolve 字段
 */
export interface PendingConfirmation {
  agentId: string
  toolCallId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskLevel: RiskLevel
  /**
   * 可选的人类可读动作名（如 "覆盖生成 Word 文档"）。
   *
   * 用途：当同一个工具在不同场景下需要不同确认文案时（例如 word_from_markdown
   * 的"新建" vs "覆盖"），由具体工具在调用 waitForConfirmation 时按场景传入。
   * 前端有 displayName 时优先显示，否则回退到工具名映射表。
   */
  displayName?: string
  /**
   * 触发该风险等级的具体原因（人类可读，已按 locale 国际化）。
   *
   * 只包含「等级等于最终 riskLevel」的那些子命令的原因（去重后），
   * 让用户在确认卡片上看到"为什么是高风险"，而不必展示所有子命令的噪声。
   * 仅 exec 等命令类工具有值；其他工具（如文件写入）不传。
   */
  reasons?: string[]
  /**
   * 可将未知命令名加入用户命令规则库的要约（仅命令类确认）。
   * 出现时前端展示「加入规则并允许」；默认 moderate，不可覆盖内置。
   */
  trustCommandOffer?: {
    cmd: string
    writesTo: boolean
    baseLevel: 'moderate'
  }
  /** 替我审批评审过但没有放行时带上：为什么交回用户 */
  autoReview?: AutoReviewTrail
}
