import type { OrganizationView, SubAgentResult } from '@shared/types'

/** 派出去的人还没有定论：排队、在干（含等模型空位） */
export const isSubAgentUnsettled = (sa: Pick<SubAgentResult, 'status'>): boolean =>
  sa.status === 'pending' || sa.status === 'running'

/**
 * 从存下来的记录里读出一场会话时，上一个进程里的伙计已经不在了。
 * 记录里停在「排队 / 在干」的，当作被打断：他们的最终状态没来得及写下来，只知道到那一刻为止做了什么。
 * 组织快照里的成员也一样；没做完人数跟着扣掉。没有要改的步骤原样返回（同一个对象），有要改的只换那一步。
 */
export function settleOrphanedSubAgents<T extends { subAgents?: SubAgentResult[]; organization?: OrganizationView }>(steps: readonly T[]): T[] {
  return steps.map(step => {
    const list = step.subAgents
    const org = step.organization
    const unsettledSubAgents = !!list?.some(isSubAgentUnsettled)
    const unsettledMembers = org?.members.some(m => isSubAgentUnsettled(m)) ?? false
    if (!list && !org) return step
    if (!unsettledSubAgents && !unsettledMembers) return step

    let settledLive = 0
    const members = org?.members.map(member => {
      if (!isSubAgentUnsettled(member)) return member
      settledLive += 1
      const { waitingForModel: _waiting, ...rest } = member
      return { ...rest, status: 'interrupted' as const }
    })

    return {
      ...step,
      ...(unsettledSubAgents && list ? {
        subAgents: list.map((sa): SubAgentResult => {
          if (!isSubAgentUnsettled(sa)) return sa
          const { waitingForModel: _waiting, ...rest } = sa
          return { ...rest, status: 'interrupted' }
        }),
      } : {}),
      ...(unsettledMembers && org && members ? {
        organization: { ...org, members, live: Math.max(0, org.live - settledLive) },
      } : {}),
    }
  })
}
