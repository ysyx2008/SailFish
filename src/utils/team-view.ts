import { LEGACY_TEAM_ID } from '@shared/types'
import type { AgentStep, OrganizationMemberView, OrganizationView, SubAgentResult } from '@shared/types'

const isTask = (step: AgentStep) => step.type === 'user_task' && !step.systemInjected
export const hasTeam = (step: AgentStep) => !!step.organization || !!step.subAgents?.length

/** 有标识的团队跨轮次续用；旧记录沿用原任务边界，不猜测拆分历史。 */
const sourceOf = (step: AgentStep, sessionId?: string): string | undefined => step.sourceSessionId ?? step.organization?.sessionId ?? sessionId
const storedTeamId = (step: AgentStep): string | undefined => step.organization?.teamId ?? step.subAgents?.find(member => member.teamId)?.teamId
export function teamIdOfStep(step: AgentStep, steps?: readonly AgentStep[], sessionId?: string): string | undefined {
  const direct = storedTeamId(step)
  if (direct || !steps || !hasTeam(step)) return direct
  // 老团队被明确续用后，原无字段快照和显式legacy必须共用入口；
  // 未续用的旧历史仍按原任务展示，不凭文字猜测拆分组织。
  const session = sourceOf(step, sessionId)
  return session && steps.some(other => storedTeamId(other) === LEGACY_TEAM_ID && sourceOf(other, sessionId) === session) ? LEGACY_TEAM_ID : undefined
}
export function teamSources(steps: readonly AgentStep[], stepId: string, sessionId?: string): readonly AgentStep[] {
  const index = steps.findIndex(step => step.id === stepId)
  if (index < 0) return []
  const teamId = teamIdOfStep(steps[index], steps, sessionId)
  const session = sourceOf(steps[index], sessionId)
  const sameSource = (step: AgentStep) => sourceOf(step, sessionId) === session
  let start = index
  let end = index + 1
  const matching = teamId ? steps.map((step, i) => teamIdOfStep(step, steps, sessionId) === teamId && sameSource(step) ? i : -1).filter(i => i >= 0) : []
  // 辅助计划只取此团队最近一次参与的用户任务，避免借用后面另一任务的计划。
  if (matching.length) start = matching[matching.length - 1]
  end = start + 1
  while (start > 0 && !isTask(steps[start])) start--
  while (end < steps.length && !isTask(steps[end])) end++
  return steps.filter((step, i) => sameSource(step) && (teamId
    ? teamIdOfStep(step, steps, sessionId) === teamId || (!hasTeam(step) && !teamIdOfStep(step, steps, sessionId) && i >= start && i < end)
    : i >= start && i < end && !teamIdOfStep(step, steps, sessionId)))
}

/** 已有组织快照是全貌；没有层级时，将真实成员/群适配到同一张图。 */
export function teamViewForStep(steps: readonly AgentStep[], stepId: string, sessionId?: string): OrganizationView | undefined {
  const sources = teamSources(steps, stepId, sessionId)
  if (!sources.some(hasTeam)) return undefined
  const teamId = teamIdOfStep(steps.find(step => step.id === stepId)!, steps, sessionId)
  const snapshots = sources.filter(step => step.organization)
  const snapshot = teamId
    ? snapshots.reduce<AgentStep | undefined>((latest, step) => !latest || (step.organization?.updatedAt ?? step.snapshotAt ?? step.timestamp) >= (latest.organization?.updatedAt ?? latest.snapshotAt ?? latest.timestamp) ? step : latest, undefined)?.organization
    : snapshots[0]?.organization
  const original = sources.find(step => step.sourceSessionId)?.sourceSessionId ?? sessionId
  if (snapshot) return { ...snapshot, ...(teamId ? { teamId } : {}), sessionId: snapshot.sessionId ?? original }
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
      members.set(name, { id: member.id, teamId: member.teamId, name, description: member.description, role: member.role,
        status: member.status, waitingForModel: member.waitingForModel,
        team: team?.name ?? previous?.team, reviewer: team?.reviewers?.includes(name) ?? previous?.reviewer,
        ...(activity ? { activity: { tool: activity.tool, args: activity.args, status: activity.status } } : {}),
      })
    }
  }
  const all = [...members.values()]
  return { ...(teamId ? { teamId } : {}), sessionId: original, members: all, teams: [...teams.values()], total: all.length,
    live: all.filter(m => m.status === 'running' || m.status === 'pending').length,
  }
}

/** 有归属的团队每队一处卡片；跨轮续派入口仍指向首次派出。旧记录按原任务兼容。 */
export function teamCards(steps: readonly AgentStep[], sessionId?: string): Map<string, OrganizationView> {
  const cards = new Map<string, OrganizationView>()
  const seenTeams = new Set<string>()
  let seenLegacy = false
  let session: string | undefined
  for (const step of steps) {
    const source = sourceOf(step, sessionId)
    if (isTask(step) || (source && session && source !== session)) seenLegacy = false
    if (source) session = source
    if (!hasTeam(step)) continue
    const teamId = teamIdOfStep(step, steps, sessionId)
    const identity = teamId ? JSON.stringify([source ?? sessionId, teamId]) : undefined
    if (identity ? seenTeams.has(identity) : seenLegacy) continue
    const view = teamViewForStep(steps, step.id, sessionId)
    if (view) cards.set(step.id, view)
    if (identity) seenTeams.add(identity)
    else seenLegacy = true
  }
  return cards
}

/** 一次遍历建立本任务最新成员快照，供展开名单共用，避免逐行重复扫描千人。 */
export function teamMemberSnapshots(steps: readonly AgentStep[], stepId: string, sessionId?: string): Map<string, SubAgentResult> {
  const found = new Map<string, SubAgentResult>()
  const updated = new Map<string, number>()
  for (const step of teamSources(steps, stepId, sessionId)) {
    const at = step.snapshotAt ?? step.timestamp
    for (const member of step.subAgents ?? []) {
      const name = member.name ?? member.id
      if (at >= (updated.get(name) ?? -Infinity)) { updated.set(name, at); found.set(name, member) }
    }
  }
  return found
}

export function teamMemberSnapshot(steps: readonly AgentStep[], stepId: string, name: string, sessionId?: string): SubAgentResult | undefined {
  return teamMemberSnapshots(steps, stepId, sessionId).get(name)
}
