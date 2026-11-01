/**
 * 从存下来的伙计记录把组织拼回来。
 *
 * 派出步骤上那份 organization 是快照；旧版本只在步骤第一次落盘时存过（最初的几层），
 * 组长后来派的人没进快照。伙计自己的 state.json 和组长自己的 steps.jsonl 都在，
 * 组长的那一步带着团名、团里的成员、验收状态和群聊文件，可以据此补齐成员和团。
 * 按身份合并成员，按群消息进度更新团；补齐截断部分后同步扣除遗漏合计。
 */
import { LEGACY_TEAM_ID } from '@shared/types'
import type { AgentRecord, OrganizationMemberView, OrganizationTeamView, OrganizationView } from '@shared/types'
import type { ChildState } from './sub-agent-record-store'

export interface LeaderRecord {
  leader: ChildState
  record: AgentRecord | null
}

export function rebuildOrganization(
  org: OrganizationView,
  children: readonly ChildState[],
  leaders: readonly LeaderRecord[],
  rootRecord?: AgentRecord,
): OrganizationView {
  const scope = org.teamId ?? LEGACY_TEAM_ID
  const belongs = (teamId: string | undefined) => (teamId ?? LEGACY_TEAM_ID) === scope
  const removed = org.members.filter(member => !belongs(member.teamId))
  const kept = org.members.filter(member => belongs(member.teamId))
  org = { ...org, members: kept,
    teams: org.teams.filter(team => belongs(team.teamId ?? org.members.find(member => member.parent === team.owner && member.team === team.name)?.teamId)),
    total: Math.max(0, org.total - removed.length),
    live: Math.max(0, org.live - removed.filter(member => member.status === 'pending' || member.status === 'running').length),
    ...(org.problems !== undefined ? { problems: Math.max(0, org.problems - removed.filter(member => member.status === 'failed' || member.status === 'interrupted').length) } : {}),
  }
  children = children.filter(child => belongs(child.teamId))
  leaders = leaders.filter(({leader}) => belongs(leader.teamId))
  const byName = new Map(org.members.map(member => [member.name, { ...member }]))
  const members: OrganizationMemberView[] = [...byName.values()]
  const initialMembers = members.length
  const initialTeams = org.teams.length
  const initiallyOmitted = Math.max(org.omitted ?? 0, org.total - org.members.length, 0)
  const teams: OrganizationTeamView[] = org.teams.map(team => ({ ...team }))
  const baseLiveFromMembers = members.filter(m => m.status === 'running' || m.status === 'pending').length
  // 快照里没放进来的那部分人的 live / 出问题人数只能从合计里扣出来
  const omittedLive = Math.max(0, org.live - baseLiveFromMembers)
  const baseProblems = org.problems ?? members.filter(m => m.status === 'failed' || m.status === 'interrupted').length
  const omittedProblems = Math.max(0, baseProblems - members.filter(m => m.status === 'failed' || m.status === 'interrupted').length)
  let latest = org.updatedAt ?? 0

  const addMember = (state: ChildState, teamName?: string, reviewer?: boolean): void => {
    if (byName.has(state.name)) return
    const team = state.team ?? teamName
    const member: OrganizationMemberView = {
      id: state.name,
      ...(state.teamId ? { teamId: state.teamId } : {}),
      name: state.name,
      description: state.description,
      status: state.status,
      ...(state.role ? { role: state.role } : {}),
      ...(state.parent ? { parent: state.parent } : {}),
      ...(state.lead ? { lead: true } : {}),
      ...(team ? { team } : {}),
      ...(reviewer ? { reviewer: true } : {}),
    }
    members.push(member)
    byName.set(state.name, member)
  }

  /** 已有的成员不重复加，但快照里缺的归属、组长、验收人身份补上 */
  const fillMember = (state: ChildState, teamName?: string, reviewer?: boolean): void => {
    const existing = byName.get(state.name)
    if (!existing) {
      addMember(state, teamName, reviewer)
      return
    }
    if (state.teamId) existing.teamId = state.teamId
    if (!existing.parent && state.parent) existing.parent = state.parent
    const team = state.team ?? teamName
    if (!existing.team && team) existing.team = team
    if (state.lead) existing.lead = true
    if (reviewer) existing.reviewer = true
  }

  // 组长本人先补齐（旧快照里通常已经有）；快照里的状态可能比伙计记录旧，按记录更新
  for (const { leader } of leaders) addMember(leader)
  for (const state of children) {
    latest = Math.max(latest, state.updatedAt ?? 0)
    const existing = byName.get(state.name)
    if (!existing) continue
    existing.status = state.status
    if (state.role) existing.role = state.role
    if (state.lead) existing.lead = true
    if (state.team) existing.team = state.team
  }

  // 每份派出记录带着它自己的团；根记录同时修正秘书直接带的团。
  const teamRecords = [
    ...(rootRecord ? [{ owner: undefined as string | undefined, record: rootRecord }] : []),
    ...leaders.filter(({ leader }) => leader.lead).map(({ leader, record }) => ({ owner: leader.name as string | undefined, record })),
  ]
  for (const { owner, record } of teamRecords) {
    for (const step of record?.steps ?? []) {
      const stepTeamId = step.organization?.teamId ?? step.subAgents?.find(member => member.teamId)?.teamId
      if (!belongs(stepTeamId ?? (owner ? scope : undefined))) continue
      const team = step.expertTeam
      if (!team?.name) continue
      const existing = teams.find(t => t.name === team.name && t.owner === owner)
      const messageCount = (team.messages?.length ?? 0) + (team.earlierOmitted ?? 0)
      // 群消息只追加：旧步骤不能盖过消息序号更靠后的现存结论。
      if (!existing || messageCount >= existing.messageCount) {
        const refreshed: OrganizationTeamView = {
          ...existing,
          name: team.name,
          ...(org.teamId ? { teamId: org.teamId } : {}),
          owner,
          review: team.review ?? existing?.review ?? 'none',
          ...(team.reviewers ? { reviewers: [...team.reviewers] } : {}),
          messageCount,
          waitingLeader: team.waitingLeader,
          wakeLimit: team.wakeLimit,
          ...(team.chatFile ? { chatFile: team.chatFile } : {}),
          ...(team.transcriptPath ? { transcriptPath: team.transcriptPath } : {}),
        }
        if (existing) Object.assign(existing, refreshed)
        else teams.push(refreshed)
      }
      latest = Math.max(latest, step.timestamp ?? 0)
      const reviewers = new Set(team.reviewers ?? [])
      for (const child of children) {
        if (child.parent !== owner) continue
        if (child.team && child.team !== team.name) continue
        fillMember(child, team.name, reviewers.has(child.name))
      }
    }
  }

  // 没有团可归的组员：按 parent 挂回去（比如组长的派出步骤没存到）
  for (const child of children) {
    fillMember(child)
  }

  // 新补回的成员已在 members 里，不能再在遗漏总数里算一遍。
  const omitted = Math.max(0, initiallyOmitted - (members.length - initialMembers))
  const omittedTeams = Math.max(0, (org.omittedTeams ?? 0) - (teams.length - initialTeams))
  const missingLive = Math.min(omitted, omittedLive)
  const missingProblems = Math.min(omitted - missingLive, omittedProblems)
  const keptLive = members.filter(m => m.status === 'running' || m.status === 'pending').length
  const problems = members.filter(m => m.status === 'failed' || m.status === 'interrupted').length + missingProblems
  const result: OrganizationView = {
    ...org,
    members,
    teams,
    total: members.length + omitted,
    live: keptLive + missingLive,
    problems,
    ...(latest > 0 ? { updatedAt: latest } : {}),
  }
  if (omitted) result.omitted = omitted
  else delete result.omitted
  if (omittedTeams) result.omittedTeams = omittedTeams
  else delete result.omittedTeams
  return result
}
