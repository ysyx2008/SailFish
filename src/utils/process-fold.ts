/**
 * 过程折叠：一个任务在界面上只有两种东西——它说给你听的话留在外面，它做事的过程收成一行。
 *
 * 那一行从任务开始到结束位置不动、行数不变，只换内容（跑着时说它在忙什么，做完说做了什么），
 * 所以不存在"冒出来又消失"。不为折叠另写摘要：动作从工具调用数出来，忙什么用它自己写下的思考。
 */
import { parseThinking } from './thinking-block'

export type ActionKind = 'read' | 'write' | 'edit' | 'command' | 'search' | 'browse' | 'other'

export const ACTION_KIND_ORDER: ActionKind[] = [
  'read', 'write', 'edit', 'command', 'search', 'browse', 'other',
]

/** 已知工具 → 动作桶。未登记的进 other。封闭表，不是内容模式匹配。 */
export const TOOL_ACTION_KIND: Record<string, ActionKind> = {
  read_file: 'read',
  read_remote_file: 'read',
  read_remote_text_file: 'read',
  get_knowledge_doc: 'read',
  sftp_get: 'read',
  write_text_file: 'write',
  write_remote_text_file: 'write',
  sftp_put: 'write',
  word_from_markdown: 'write',
  excel_from_markdown: 'write',
  excel_open: 'read',
  excel_read: 'read',
  excel_modify: 'edit',
  excel_save: 'write',
  edit_file: 'edit',
  execute_command: 'command',
  exec: 'command',
  await_exec: 'command',
  file_search: 'search',
  search_knowledge: 'search',
  web_search: 'search',
  search_history: 'search',
  recall: 'search',
  web_fetch: 'browse',
  browser_launch: 'browse',
  browser_goto: 'browse',
  browser_snapshot: 'browse',
  browser_read_article: 'browse',
  browser_read_page: 'browse',
  browser_get_content: 'browse',
}

/**
 * 留在外面的步骤类型。只有两类够格：**要你动手的**（问你问题、等你输密码、等你确认）
 * 和**它交给你的东西**（任务级错误、计划、你自己补的话）。
 * 注意任务级 `error` 在外面，但过程中某次工具失败不在——它试三次成了就是成了。
 */
const PINNED_STEP_TYPES = new Set([
  'asking',
  'waiting',
  'waiting_password',
  'waiting_input',
  'error',
  'user_supplement',
  'proactive_notice',
  'plan_created',
  'plan_updated',
  'plan_archived',
])

/**
 * 对外发出去的：主动联系、往对话里寄东西——是产出不是过程。
 * 跟「成功结果卡是否还要画」那份名单刻意分开：那边管展开后看不看得见，这边管收不收。
 */
const PINNED_TOOLS = new Set<string>([
  'talk_to_user',
  'send_file_to_chat',
  'send_image_to_chat',
  'send_to_chat',
])

const PROGRESS_MAX_CHARS = 60
/** 做完之后耗时不到 1 秒就不提，省得挂个「· 0s」 */
const MIN_SHOWN_DURATION_MS = 1000

export interface ProcessStepLike {
  id: string
  type: string
  content?: string
  toolName?: string
  success?: boolean
  riskLevel?: string
  isStreaming?: boolean
  timestamp?: number
  images?: unknown[]
  echartsOption?: unknown
  webSearchResults?: unknown[]
  subAgents?: unknown[]
}

/**
 * 一条步骤在界面上出现的形态。它说给你听的话里往往还夹着"它先想了想"——
 * 想的那截是过程、说的那句是回话，两者要分头安置，所以同一条步骤可以拆成两半各自出场。
 */
export type StepPart = 'full' | 'thinking' | 'body'

export interface ProcessStepRef<T = ProcessStepLike> {
  step: T
  part: StepPart
}

export interface ProcessFoldView {
  id: string
  counts: Partial<Record<ActionKind, number>>
  /** 这一截还在跑：那一行要转圈、秒数要走 */
  live: boolean
  /** 跑着的时候它在忙什么——它自己写下的那句思考 */
  liveText?: string
  /** 这一句还是启动等待提示（「深潜中」），不是它正在写的思考 */
  waitingHint?: boolean
  /** 没有思考可用时退回动作分类 */
  liveAction?: ActionKind
  /** 还活着的伙计人数：等他们时折叠行要继续走秒 */
  liveColleagueCount?: number
  /** 这一截只是想了想，没动手做任何事 */
  thinkingOnly: boolean
  /** 计时锚点：从上一步结束算起 */
  startedAt?: number
  /** 做完了共花多久；太短则不给 */
  durationMs?: number
  /** 整条收进来的步骤（只有半截思考进来的不算，那条步骤本人还在外面） */
  stepIds: string[]
}

export type ProcessSegment<T = ProcessStepLike> =
  | { kind: 'open'; steps: ProcessStepRef<T>[] }
  | { kind: 'fold'; fold: ProcessFoldView; steps: ProcessStepRef<T>[] }

/**
 * 流式期间每来一段内容整条步骤流都要重判一遍，历史长了正则解析全部消息不划算。
 * 按步骤对象缓存，原文变了就重算，步骤被回收缓存自动消失。
 */
const parsedCache = new WeakMap<ProcessStepLike, { content: string; parsed: ReturnType<typeof parseThinking> }>()

function parsed(step: ProcessStepLike) {
  const content = step.content || ''
  const hit = parsedCache.get(step)
  if (hit && hit.content === content) return hit.parsed
  const result = parseThinking(content)
  parsedCache.set(step, { content, parsed: result })
  return result
}

function messageBody(step: ProcessStepLike): string {
  if (step.type !== 'message') return ''
  return parsed(step).body.trim()
}

/** 这一步是它说给用户听的话（而不是光在想）——这类步骤永远留在外面 */
export function hasSpokenBody(step: ProcessStepLike): boolean {
  return !!messageBody(step)
}

/** 这一步里有"它先想了想"那截 */
function hasThinkingPart(step: ProcessStepLike): boolean {
  if (step.type !== 'message') return false
  return !!parsed(step).thinking?.reasoning.trim()
}

/** 图——交给你看的东西。搜索结果、子任务进度不算，那是过程。 */
function hasHandedOverPayload(step: ProcessStepLike): boolean {
  if (step.images && step.images.length > 0) return true
  if (step.echartsOption) return true
  return false
}

/** 除了"说了话"，还有别的理由留在外面吗 */
function pinnedBesidesSpeech(step: ProcessStepLike): boolean {
  // 替我审批是过程：放过的收进去点开能翻到；没放过的由确认卡自己站在外面
  if (step.type === 'auto_review') return false
  if (PINNED_STEP_TYPES.has(step.type)) return true
  if (step.riskLevel === 'dangerous' || step.riskLevel === 'blocked') return true
  if (step.toolName && PINNED_TOOLS.has(step.toolName)) return true
  if (hasHandedOverPayload(step)) return true
  return false
}

/**
 * 留在原处不收的步骤。除了要你动手的、任务级错误、对外发出的、带图的，
 * **它说给你听的话也一律留在原处**——折叠行因此永远落在这段过程原来的位置，
 * 展开与否，读到的顺序都和它当时干活的顺序一样。
 *
 * 刻意不在此列的：过程中某次工具失败、正在跑的工具、还在流的思考、搜索结果、子任务进度——
 * 这些全是过程，收进那一行里，跑着的时候由那一行代为播报。
 */
export function isPinnedProcessStep(step: ProcessStepLike): boolean {
  return pinnedBesidesSpeech(step) || !!messageBody(step)
}

/**
 * 把步骤流摊成"出场单元"。说出口的那句留在外面，但同一条步骤里"它先想了想"那截是过程，
 * 拆出来跟前面那截活收在一起——外面因此不再夹着一排只写着「思考完成」的行。
 * 只有它自己有别的理由留在外面时（要你动手、带产出）才整条不拆。
 */
function toStepRefs<T extends ProcessStepLike>(steps: ReadonlyArray<T>): ProcessStepRef<T>[] {
  const refs: ProcessStepRef<T>[] = []
  for (const step of steps) {
    if (!pinnedBesidesSpeech(step) && hasSpokenBody(step) && hasThinkingPart(step)) {
      refs.push({ step, part: 'thinking' }, { step, part: 'body' })
    } else {
      refs.push({ step, part: 'full' })
    }
  }
  return refs
}

function isPinnedRef(ref: ProcessStepRef): boolean {
  if (ref.part === 'thinking') return false
  return isPinnedProcessStep(ref.step)
}

function liveColleagueCountOf(step: ProcessStepLike): number {
  const agents = step.subAgents
  if (!Array.isArray(agents)) return 0
  let n = 0
  for (const item of agents) {
    if (!item || typeof item !== 'object') continue
    const status = (item as { status?: string }).status
    if (status === 'pending' || status === 'running') n++
  }
  return n
}

/** 这一步还没完：工具没回，或内容还在流，或伙计还活着。 */
function isUnfinished(ref: ProcessStepRef): boolean {
  if (ref.part === 'thinking') return false
  if (liveColleagueCountOf(ref.step) > 0) return true
  if (ref.step.isStreaming) return true
  return ref.step.type === 'tool_call' && ref.step.success === undefined
}

export function countActions(steps: ReadonlyArray<ProcessStepLike>): Partial<Record<ActionKind, number>> {
  const counts: Partial<Record<ActionKind, number>> = {}
  for (const step of steps) {
    if (step.type !== 'tool_call') continue
    const kind = (step.toolName && TOOL_ACTION_KIND[step.toolName]) || 'other'
    counts[kind] = (counts[kind] || 0) + 1
  }
  return counts
}

/** 一句的边界：中文句末标点、英文句末标点后跟空白、或换行 */
const SENTENCE_BREAK = /(?<=[。！？；;…])|(?<=[.!?])\s+|\r?\n/
/** 到最后一个句子边界为止——后面那截还在写 */
const SETTLED_HEAD = /^[\s\S]*(?:[。！？；;…]|[.!?]\s|\r?\n)/

export function lastProgressLine(text: string): string {
  const parts = text.split(SENTENCE_BREAK).map(part => part.trim()).filter(Boolean)
  const raw = parts[parts.length - 1] || ''
  const cleaned = raw
    .replace(/^(?:[-*•]|\d+\.)\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    // 句号收在这行末尾没意义，后面还跟着动作数和秒数；问号叹号有语气，留着
    .replace(/[。；;….]+$/, '')
  if (cleaned.length <= PROGRESS_MAX_CHARS) return cleaned
  return `${cleaned.slice(0, PROGRESS_MAX_CHARS - 1)}…`
}

/**
 * 它此刻在忙什么：拿最近一次思考里**已经写完的那句**。
 * 正在写的半句不算——那截跟着流一个字一个字地变，喊出来只会闪，看不清。
 * 这一段还没写完整一句时退回上一段的收尾句，宁可慢半拍也不要一行字乱跳。
 *
 * `thinking` 步骤是整句换上的状态提示（「深潜中」「正在准备…」），不是一个字一个字写出来的，
 * 即使还在转圈也直接用原文，否则折叠行会丢掉启动时那句有趣的形容。
 */
function clipProgressLabel(text: string): string {
  if (text.length <= PROGRESS_MAX_CHARS) return text
  return `${text.slice(0, PROGRESS_MAX_CHARS - 1)}…`
}

function extractLiveCaption(
  steps: ReadonlyArray<ProcessStepLike>,
): { text: string; waitingHint: boolean } | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type === 'thinking') {
      const label = (step.content || '').trim()
      if (label) return { text: clipProgressLabel(label), waitingHint: true }
      continue
    }
    if (step.type !== 'message') continue
    const thinking = parsed(step).thinking
    const reasoning = thinking?.reasoning || ''
    const done = thinking?.isDone !== false
    const settled = done ? reasoning : reasoning.match(SETTLED_HEAD)?.[0] || ''
    if (!settled.trim()) continue
    const line = lastProgressLine(settled)
    if (line) return { text: line, waitingHint: false }
  }
  return undefined
}

export function extractProgressLine(steps: ReadonlyArray<ProcessStepLike>): string | undefined {
  return extractLiveCaption(steps)?.text
}

/** 铺满浮层和折叠行共用：这一刻它在忙什么，不另写摘要。 */
export interface LiveProcessView {
  liveText?: string
  liveAction?: ActionKind
  liveColleagueCount?: number
  thinkingOnly: boolean
  counts: Partial<Record<ActionKind, number>>
}

export function describeLiveProcess(steps: ReadonlyArray<ProcessStepLike>): LiveProcessView {
  const caption = extractLiveCaption(steps)
  const counts = countActions(steps)
  const colleagueCount = steps.reduce((n, step) => n + liveColleagueCountOf(step), 0)
  return {
    liveText: caption?.text,
    liveAction: pendingAction(steps),
    liveColleagueCount: colleagueCount > 0 ? colleagueCount : undefined,
    thinkingOnly:
      Object.keys(counts).length === 0 &&
      steps.every(step => step.type === 'message' || step.type === 'thinking'),
    counts,
  }
}

/** 跑着的时候手上这件事属于哪一类动作 */
function pendingAction(steps: ReadonlyArray<ProcessStepLike>): ActionKind | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (step.type !== 'tool_call') continue
    return (step.toolName && TOOL_ACTION_KIND[step.toolName]) || 'other'
  }
  return undefined
}

/**
 * 步骤只带创建时间，没有结束时间。所以一截的耗时按「从它第一步开始，到下一件事发生为止」算——
 * 下一步的创建时间就是这一截的收尾时刻，段内只有一步时也才有耗时可言。
 * 后面没有步骤了（任务就此结束）只能退回最后一步的开始时间，会少算最后一步自己跑了多久。
 */
function toFold(refs: ProcessStepRef[], nextStepAt?: number, hasSuccessor = false): ProcessFoldView {
  const steps = refs.map(ref => ref.step)
  const last = steps[steps.length - 1]
  const colleagueCount = steps.reduce((n, step) => n + liveColleagueCountOf(step), 0)
  // 后面已经发生了下一件事（用户插话、它说了话），这一截就结束了。
  // 否则写文件被打断后卡片还会一直转圈计时。
  const live = !hasSuccessor && (refs.some(isUnfinished) || colleagueCount > 0)
  const startedAt = steps[0].timestamp
  const endedAt = nextStepAt ?? last.timestamp
  const elapsed =
    startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : 0
  const counts = countActions(steps)
  const caption = live ? extractLiveCaption(steps) : undefined
  return {
    // 只认这一截的起点：这截还在长，末尾每加一步 id 都变的话，
    // 用户刚点开就会被重新收起，虚拟列表也要跟着重建。
    id: `fold_${steps[0].id}`,
    counts,
    live,
    // 没动手做任何事，只是想了想——那一行就该说"想了想"，而不是含糊的"处理中"
    thinkingOnly:
      Object.keys(counts).length === 0 &&
      steps.every(step => step.type === 'message' || step.type === 'thinking'),
    liveText: caption?.text,
    waitingHint: caption?.waitingHint,
    liveAction: live ? pendingAction(steps) : undefined,
    liveColleagueCount: live && colleagueCount > 0 ? colleagueCount : undefined,
    startedAt,
    durationMs: !live && elapsed >= MIN_SHOWN_DURATION_MS ? elapsed : undefined,
    // 只有半截思考进来的不算收了这条步骤——它本人还在外面，找它就该找外面那条
    stepIds: refs.filter(ref => ref.part === 'full').map(ref => ref.step.id),
  }
}

/**
 * 把步骤流切成「留在外面的」和「收成一行的」。
 *
 * 收是从头收到尾——不是做完才收，而是压根没展开过，所以任务跑着的时候
 * 只有那一行在动，做完也不会有十几行忽然塌成一行的突变。
 */
export function foldProcessSteps<T extends ProcessStepLike>(
  steps: ReadonlyArray<T>,
  opts: { enabled: boolean },
): ProcessSegment<T>[] {
  if (steps.length === 0) return []
  if (!opts.enabled) {
    return [{ kind: 'open', steps: steps.map(step => ({ step, part: 'full' as const })) }]
  }

  const runs: { pinned: boolean; refs: ProcessStepRef<T>[] }[] = []
  for (const ref of toStepRefs(steps)) {
    const pinned = isPinnedRef(ref)
    const last = runs[runs.length - 1]
    if (last && last.pinned === pinned) last.refs.push(ref)
    else runs.push({ pinned, refs: [ref] })
  }

  return runs.map((run, i) => {
    if (run.pinned) return { kind: 'open' as const, steps: run.refs }
    const next = runs[i + 1]
    const nextStepAt = next?.refs[0]?.step.timestamp
    return { kind: 'fold' as const, fold: toFold(run.refs, nextStepAt, next !== undefined), steps: run.refs }
  })
}
