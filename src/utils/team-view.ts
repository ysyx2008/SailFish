import type { AgentStep, OrganizationMemberView, OrganizationView, SubAgentResult } from '@shared/types'

const isTask = (step: AgentStep) => step.type === 'user_task' && !step.systemInjected
export const hasTeam = (step: AgentStep) => !!step.organization || !!step.subAgents?.length

/** 一次用户任务内的团队记录；追问与进度更新不创建另一支团队。 */
export function teamSources(steps: readonly AgentStep[], stepId: string): readonly AgentStep[] {
  const index = steps.findIndex(step => step.id === stepId)
  if (index < 0) return []
  let start = index
  let end = index + 1
  while (start > 0 && !isTask(steps[start])) start--
  while (end < steps.length && !isTask(steps[end])) end++
  const session = steps[index].sourceSessionId ?? steps[index].organization?.sessionId
  return steps.slice(start, end).filter(step => !session || !(step.sourceSessionId ?? step.organization?.sessionId) || (step.sourceSessionId ?? step.organization?.sessionId) === session)
}

/** 已有组织快照是全貌；没有层级时，将真实成员/群适配到同一张图。 */
export function teamViewForStep(steps: readonly AgentStep[], stepId: string, sessionId?: string): OrganizationView | undefined {
  const sources = teamSources(steps, stepId)
  if (!sources.some(hasTeam)) return undefined
  const snapshot = sources.find(step => step.organization)?.organization
  const original = sources.find(step => step.sourceSessionId)?.sourceSessionId ?? sessionId
  if (snapshot) return { ...snapshot, sessionId: snapshot.sessionId ?? original }
  const members = new Map<string, OrganizationMemberView>()
  const teams = new Map<string, OrganizationView['teams'][number]>()
  const seen = new Map<string, number>()
  for (const step of sources) {
    const team = step.expertTeam
    if (team) {
      const key = JSON.stringify([undefined, team.name])
      const previous = teams.get(key)
      const count = team.messages.length + (team.earlierOmitted ?? 0)
      if (!previous || count >= previous.messageCount) teams.set(key, {
        name: team.name, review: team.review ?? 'none', reviewers: team.reviewers,
        messageCount: count, waitingLeader: team.waitingLeader, wakeLimit: team.wakeLimit,
        chatFile: team.chatFile, transcriptPath: team.transcriptPath,
      })
    }
    for (const member of step.subAgents ?? []) {
      const name = member.name ?? member.id
      const at = step.snapshotAt ?? step.timestamp
      if ((seen.get(name) ?? -Infinity) > at) continue
      seen.set(name, at)
      const previous = members.get(name)
      const activity = member.steps?.[member.steps.length - 1]
      members.set(name, { id: member.id, name, description: member.description, role: member.role,
        status: member.status, waitingForModel: member.waitingForModel,
        team: team?.name ?? previous?.team, reviewer: team?.reviewers?.includes(name) ?? previous?.reviewer,
        ...(activity ? { activity: { tool: activity.tool, args: activity.args, status: activity.status } } : {}),
      })
    }
  }
  const all = [...members.values()]
  return { sessionId: original, members: all, teams: [...teams.values()], total: all.length,
    live: all.filter(m => m.status === 'running' || m.status === 'pending').length,
  }
}

/** 同一任务一处卡片；入口一直指向该任务最早的团队记录。 */
export function teamCards(steps: readonly AgentStep[], sessionId?: string): Map<string, OrganizationView> {
  const cards = new Map<string, OrganizationView>()
  let seen = false
  let session: string | undefined
  for (const step of steps) {
    const source = step.sourceSessionId ?? step.organization?.sessionId
    if (isTask(step) || (source && session && source !== session)) seen = false
    if (source) session = source
    if (!seen && hasTeam(step)) {
      const view = teamViewForStep(steps, step.id, sessionId)
      if (view) cards.set(step.id, view)
      seen = true
    }
  }
  return cards
}

export function teamMemberSnapshot(steps: readonly AgentStep[], stepId: string, name: string): SubAgentResult | undefined {
  let found: SubAgentResult | undefined
  let at = -Infinity
  for (const step of teamSources(steps, stepId)) {
    const candidate = step.subAgents?.find(member => (member.name ?? member.id) === name)
    const updated = step.snapshotAt ?? step.timestamp
    if (candidate && updated >= at) { found = candidate; at = updated }
  }
  return found
}
