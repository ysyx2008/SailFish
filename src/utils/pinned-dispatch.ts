import type { AgentStep, SubAgentResult } from '@shared/types'
import { subAgentBucket } from './sub-agent-summary'

/** 这一批人里还有没干完的（排队、在干，含等模型空位） */
export function hasUnfinishedSubAgents(list: readonly SubAgentResult[] | undefined): boolean {
  return (list ?? []).some(sa => {
    const bucket = subAgentBucket(sa)
    return bucket === 'running' || bucket === 'waiting'
  })
}

/** 你亲口说的话（系统代发的，如目标续跑，不算） */
const isUserSpeech = (step: AgentStep): boolean =>
  (step.type === 'user_task' || step.type === 'user_supplement') && !step.systemInjected

/**
 * 记着哪几批派出去的人该挂在对话顶部（按派出先后给出）：
 * - 还有人没干完的，一直挂着，各批各挂一行；
 * - 眼看着干完的，从干完那一刻起挂到你下次说话——干完之前你说的话不算；做完的只留最近一批，免得越攒越多；
 * - 打开时就已经是干完（或被中断）状态的不挂：那是旧事。
 * 这个对象要一直活着，才看得到「刚干完」这一刻。
 */
export class PinnedDispatchTracker {
  /** 看到过还在干的批次 */
  private readonly working = new Set<string>()
  /** 看着干完的批次 → 当时你已经说过几句话 */
  private readonly finishedAt = new Map<string, number>()

  update(steps: readonly AgentStep[]): AgentStep[] {
    const dispatches = steps.filter(step => step.subAgents && step.subAgents.length > 0)
    const speech = steps.reduce((n, step) => n + (isUserSpeech(step) ? 1 : 0), 0)

    const alive = new Set(dispatches.map(step => step.id))
    for (const id of [...this.working]) if (!alive.has(id)) this.working.delete(id)
    for (const id of [...this.finishedAt.keys()]) if (!alive.has(id)) this.finishedAt.delete(id)

    const pinned: AgentStep[] = []
    let latestFinished: AgentStep | undefined
    for (const step of dispatches) {
      if (hasUnfinishedSubAgents(step.subAgents)) {
        this.working.add(step.id)
        this.finishedAt.delete(step.id)
        pinned.push(step)
        continue
      }
      if (this.working.delete(step.id)) this.finishedAt.set(step.id, speech)
      if (this.finishedAt.get(step.id) === speech) latestFinished = step
    }
    return latestFinished ? dispatches.filter(step => pinned.includes(step) || step === latestFinished) : pinned
  }
}
