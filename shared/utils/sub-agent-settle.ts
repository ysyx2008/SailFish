import type { SubAgentResult } from '@shared/types'

/** 派出去的人还没有定论：排队、在干（含等模型空位） */
export const isSubAgentUnsettled = (sa: Pick<SubAgentResult, 'status'>): boolean =>
  sa.status === 'pending' || sa.status === 'running'

/**
 * 从存下来的记录里读出一场会话时，上一个进程里的伙计已经不在了。
 * 记录里停在「排队 / 在干」的，当作被打断：他们的最终状态没来得及写下来，只知道到那一刻为止做了什么。
 * 没有要改的步骤原样返回（同一个对象），有要改的只换那一步。
 */
export function settleOrphanedSubAgents<T extends { subAgents?: SubAgentResult[] }>(steps: readonly T[]): T[] {
  return steps.map(step => {
    const list = step.subAgents
    if (!list || !list.some(isSubAgentUnsettled)) return step
    return {
      ...step,
      subAgents: list.map((sa): SubAgentResult => {
        if (!isSubAgentUnsettled(sa)) return sa
        const { waitingForModel: _waiting, ...rest } = sa
        return { ...rest, status: 'interrupted' }
      }),
    }
  })
}
