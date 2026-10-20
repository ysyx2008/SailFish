/**
 * 命令行里的 `/goal`：把用户敲的那一行翻成对后端「目标」能力的调用，并把结果说成人话。
 * 写法（空 / pause / resume / clear / edit / 正文）与桌面输入框共用同一份定义。
 */
import type { AgentContext, GoalContract, GoalStatus, TerminalType } from '@shared/types'
import { parseGoalHint } from '@shared/utils/goal-command'
import { formatGoalElapsed, formatGoalTokenUsage, goalClearNeedsConfirm, goalReplaceNeedsConfirm } from '@shared/utils/goal-view'

type Failure = { ok: false; error: string }
type WithGoal = { ok: true; goal: GoalContract } | Failure

/** 命令行要用到的那一小片后端目标能力（AgentService 本身就满足） */
export interface GoalPort {
  getGoal(agentKey: string): GoalContract | undefined
  setGoal(input: { agentKey: string; objective: string; terminalType: TerminalType; replace?: boolean }): WithGoal
  pauseGoal(input: { agentKey: string; terminalType: TerminalType }): WithGoal
  resumeGoal(input: { agentKey: string; terminalType: TerminalType; context?: AgentContext }): Promise<WithGoal>
  clearGoal(input: { agentKey: string; terminalType: TerminalType }): { ok: true } | Failure
  editGoal(input: { agentKey: string; terminalType: TerminalType; objective: string }): WithGoal
}

export interface CliGoalOptions {
  agentKey: string
  terminalType: TerminalType
  /** 终端那头有没有人能回答、能再敲一行 */
  interactive: boolean
  /** 问一句要不要；只在 interactive 时才会被调用 */
  confirm(question: string): Promise<boolean>
}

export interface CliGoalOutcome {
  /** 马上说给用户的话 */
  notes: string[]
  /** 挂上了新目标：以这句话开一轮 */
  say?: string
  /** 继续目标：要开一轮续跑。跑完返回要说的话 */
  resume?: () => Promise<string[]>
}

/** 与桌面 `goal.status.*` 同一套叫法 */
const STATUS_LABEL: Record<GoalStatus, string> = {
  active: '推进中',
  paused: '已暂停',
  blocked: '停滞',
  usage_limited: '额度受限',
  budget_limited: '预算用尽',
  achieved: '已达成',
}

const USAGE = '用法：/goal [目标正文|clear|edit|pause|resume]'

function describeGoalUsage(goal: GoalContract): string {
  const tokens = formatGoalTokenUsage(goal)
  return [`用时 ${formatGoalElapsed(goal.timeUsedSeconds)}`, ...(tokens ? [`${tokens} tokens`] : [])].join(' · ')
}

/** 收工时说的那一句，状态不同下一步也不同 */
function headline(goal: GoalContract): { text: string; hint?: string } {
  switch (goal.status) {
    case 'achieved':
      return { text: '目标已达成', hint: '报早了的话，/goal resume 重新推进' }
    case 'paused':
      return { text: '目标已暂停', hint: '/goal resume 接着推进，/goal clear 清掉' }
    case 'blocked':
      return { text: '目标停滞了，需要你看一眼', hint: '处理之后用 /goal resume 继续' }
    case 'usage_limited':
      return { text: '模型额度不够，目标先停在这里', hint: '额度恢复后用 /goal resume 继续' }
    case 'budget_limited':
      return { text: '目标的 token 预算用完了', hint: '/goal clear 之后可以用 /goal 新建一个' }
    case 'active':
      return { text: '这一轮停下了，目标还在', hint: '再说一句话就会接着推' }
  }
}

function explain(error: string): string {
  switch (error) {
    case 'no_goal': return '这场还没有目标。'
    case 'not_supported': return '这场对话不能挂目标。'
    case 'empty_objective': return '目标正文不能为空。'
    case 'not_active': return '目标现在不在推进，不需要暂停。'
    case 'not_resumable':
    case 'budget_exhausted': return '现在没法继续这个目标：它正在推进，或者预算已经用完。'
    case 'terminal': return '目标已经达成或预算用尽，不能改写；/goal resume 可以重新推进，或者新建一个。'
    case 'no_context': return '这场还没跑过，没有可以接着的环境。'
    default: return `这次没做成（${error}）`
  }
}

export class CliGoalCommand {
  /** 上一次说给用户听的目标状态；没有变化就不重复说 */
  private reported = ''

  constructor(
    private readonly port: GoalPort,
    private readonly options: CliGoalOptions,
  ) {}

  private get target() {
    return { agentKey: this.options.agentKey, terminalType: this.options.terminalType }
  }

  /** 执行 `/goal` 后面那串字 */
  async apply(hint: string, context?: AgentContext): Promise<CliGoalOutcome> {
    const action = parseGoalHint(hint)
    switch (action.kind) {
      case 'status': return { notes: this.status() }
      case 'pause': return { notes: this.pause() }
      case 'resume': return { notes: [], resume: () => this.resume(context) }
      case 'clear': return { notes: await this.clear() }
      case 'edit': return { notes: this.edit(action.objective) }
      case 'set': return this.set(action.objective)
    }
  }

  /** 一轮跑完后，目标有变化才说一句（做了什么、花了多少、下一步怎么走） */
  reportAfterTurn(): string[] {
    const goal = this.port.getGoal(this.options.agentKey)
    if (!goal) {
      this.reported = ''
      return []
    }
    const key = `${goal.goalId}|${goal.status}|${goal.tokensUsed}`
    if (key === this.reported) return []
    this.reported = key
    const { text, hint } = headline(goal)
    const lines = [`${text} · ${describeGoalUsage(goal)}`]
    if (hint && this.options.interactive) lines.push(`  ${hint}`)
    return lines
  }

  private status(): string[] {
    const goal = this.port.getGoal(this.options.agentKey)
    if (!goal) return ['这场还没有目标。', USAGE]
    return [`目标：${goal.objective}`, `状态：${STATUS_LABEL[goal.status]} · ${describeGoalUsage(goal)}`]
  }

  private async set(objective: string): Promise<CliGoalOutcome> {
    const existing = this.port.getGoal(this.options.agentKey)
    const replace = goalReplaceNeedsConfirm(existing)
    if (replace) {
      if (!this.options.interactive) {
        return { notes: ['已有一个没做完的目标，没有交互终端，没有换。'] }
      }
      if (!(await this.options.confirm('已有一个没做完的目标。要换成新的吗？[y/N] '))) {
        return { notes: ['没换，目标还是原来的。'] }
      }
    }
    const result = this.port.setGoal({ ...this.target, objective, replace })
    if (!result.ok) return { notes: [explain(result.error)] }
    this.reported = ''
    return { notes: [`已挂上目标：${result.goal.objective}`], say: `/goal ${result.goal.objective}` }
  }

  private pause(): string[] {
    const result = this.port.pauseGoal(this.target)
    return [result.ok ? '已暂停目标。' : explain(result.error)]
  }

  private async resume(context?: AgentContext): Promise<string[]> {
    this.reported = ''
    const result = await this.port.resumeGoal({ ...this.target, ...(context ? { context } : {}) })
    return result.ok ? [] : [explain(result.error)]
  }

  private async clear(): Promise<string[]> {
    const goal = this.port.getGoal(this.options.agentKey)
    if (!goal) return [explain('no_goal')]
    if (goalClearNeedsConfirm(goal)) {
      if (!this.options.interactive) return ['没有交互终端，没有清除。']
      if (!(await this.options.confirm('清除这个目标？续跑也会停。[y/N] '))) return ['没清除。']
    }
    const result = this.port.clearGoal(this.target)
    if (!result.ok) return [explain(result.error)]
    this.reported = ''
    return ['已清除目标。']
  }

  private edit(objective: string): string[] {
    if (!objective) return ['改目标需要写新的正文，例如 /goal edit 把测试跑绿']
    const result = this.port.editGoal({ ...this.target, objective })
    return [result.ok ? `已改目标：${result.goal.objective}` : explain(result.error)]
  }
}
