import type { SubAgentResult } from '@shared/types'

/** 折叠行里按这几堆数人；排队等模型的单算，不混进在干的 */
export type SubAgentBucket = 'completed' | 'running' | 'waiting' | 'failed' | 'interrupted'

/** 超过这么多个伙计就折叠成一行计数 */
export const SUB_AGENT_FOLD_THRESHOLD = 5
/** 展开后一次显示这么多个 */
export const SUB_AGENT_PAGE_SIZE = 40

/** 计数行的先后 */
export const SUB_AGENT_SUMMARY_ORDER: readonly SubAgentBucket[] = ['completed', 'running', 'waiting', 'failed', 'interrupted']
/** 展开后的先后：还在动的在前，做完的在后 */
const LIST_ORDER: readonly SubAgentBucket[] = ['running', 'waiting', 'failed', 'interrupted', 'completed']

export function subAgentBucket(sa: SubAgentResult): SubAgentBucket {
  switch (sa.status) {
    case 'completed':
    case 'failed':
    case 'interrupted':
      return sa.status
    case 'pending':
      return 'waiting'
    default:
      return sa.waitingForModel ? 'waiting' : 'running'
  }
}

export function countSubAgents(list: readonly SubAgentResult[]): Record<SubAgentBucket, number> {
  const counts: Record<SubAgentBucket, number> = { completed: 0, running: 0, waiting: 0, failed: 0, interrupted: 0 }
  for (const sa of list) counts[subAgentBucket(sa)]++
  return counts
}

/** 按状态分组排好；同一堆里保持派出时的先后 */
export function sortSubAgentsByBucket(list: readonly SubAgentResult[]): SubAgentResult[] {
  const rank = (sa: SubAgentResult) => LIST_ORDER.indexOf(subAgentBucket(sa))
  return list
    .map((sa, index) => ({ sa, index }))
    .sort((a, b) => rank(a.sa) - rank(b.sa) || a.index - b.index)
    .map(({ sa }) => sa)
}

export type Translate = (key: string, named?: Record<string, unknown>) => string

const isExpertBatch = (list: readonly SubAgentResult[]): boolean => list.length > 0 && list.every(agent => !!agent.role)

/** 「8 个伙计：3 做完 / 5 在干」 */
export function formatSubAgentSummary(t: Translate, list: readonly SubAgentResult[]): string {
  const counts = countSubAgents(list)
  const parts = SUB_AGENT_SUMMARY_ORDER
    .filter(bucket => counts[bucket] > 0)
    .map(bucket => t(`ai.subAgentCount.${bucket}`, { count: counts[bucket] }))
  return t(isExpertBatch(list) ? 'ai.expertSummary' : 'ai.subAgentSummary', { count: list.length, parts: parts.join(' / ') })
}

export type DockKind = 'working' | 'done' | 'problem'

/**
 * 顶部挂着那一行：还有人在干就是计数行；全做完写「都干完了」；
 * 干完但有人失败或被打断，如实用计数行，不写都干完了。
 */
export function describeDock(t: Translate, list: readonly SubAgentResult[]): { kind: DockKind; headline: string } {
  const counts = countSubAgents(list)
  if (counts.running + counts.waiting > 0) return { kind: 'working', headline: formatSubAgentSummary(t, list) }
  if (counts.completed < list.length) return { kind: 'problem', headline: formatSubAgentSummary(t, list) }
  const key = isExpertBatch(list) ? 'ai.subAgentDock.allDoneExperts' : 'ai.subAgentDock.allDoneAgents'
  return { kind: 'done', headline: t(key, { count: list.length }) }
}
