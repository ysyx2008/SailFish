/**
 * 从存下来的伙计记录把组织拼回来。
 *
 * 派出步骤上那份 organization 是快照；旧版本只在步骤第一次落盘时存过（最初的几层），
 * 组长后来派的人没进快照。伙计自己的 state.json 和组长自己的 steps.jsonl 都在，
 * 组长的那一步带着团名、团里的成员、验收状态和群聊文件，可以据此补齐成员和团。
 * 只补快照里没有的人/团，已有的不动；重复调用结果不变。
 */
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
): OrganizationView {
  const members: OrganizationMemberView[] = org.members.map(member => ({ ...member }))
  const byName = new Map(members.map(member => [member.name, member]))
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
    if (!existing.parent && state.parent) existing.parent = state.parent
    const team = state.team ?? teamName
    if (!existing.team && team) existing.team = team
    if (state.lead) existing.lead = true
    if (reviewer) existing.reviewer = true
  }

  // 组长本人先补齐（旧快照里通常已经有）；快照里的状态可能比伙计记录旧，按记录更新
  for (const { leader } of leaders) addMember(leader)
  for (const state of children) {
    const existing = byName.get(state.name)
    if (!existing) continue
    existing.status = state.status
    if (state.role) existing.role = state.role
    if (state.lead) existing.lead = true
    if (state.team) existing.team = state.team
    latest = Math.max(latest, state.updatedAt ?? 0)
  }

  // 组长自己的派出步骤里带着团名、团里的成员和验收状态
  for (const { leader, record } of leaders) {
    if (!leader.lead) continue
    for (const step of record?.steps ?? []) {
      const team = step.expertTeam
      if (!team?.name) continue
      if (!teams.some(t => t.name === team.name && t.owner === leader.name)) {
        teams.push({
          name: team.name,
          owner: leader.name,
          review: team.review ?? 'none',
          ...(team.reviewers ? { reviewers: [...team.reviewers] } : {}),
          messageCount: (team.messages?.length ?? 0) + (team.earlierOmitted ?? 0),
          waitingLeader: team.waitingLeader,
          wakeLimit: team.wakeLimit,
          ...(team.chatFile ? { chatFile: team.chatFile } : {}),
          ...(team.transcriptPath ? { transcriptPath: team.transcriptPath } : {}),
        })
      }
      latest = Math.max(latest, step.timestamp ?? 0)
      const reviewers = new Set(team.reviewers ?? [])
      for (const child of children) {
        if (child.parent !== leader.name) continue
        if (child.team && child.team !== team.name) continue
        fillMember(child, team.name, reviewers.has(child.name))
      }
    }
  }

  // 没有团可归的组员：按 parent 挂回去（比如组长的派出步骤没存到）
  for (const child of children) {
    if (!child.parent) continue
    fillMember(child)
  }

  const keptLive = members.filter(m => m.status === 'running' || m.status === 'pending').length
  const problems = members.filter(m => m.status === 'failed' || m.status === 'interrupted').length + omittedProblems
  return {
    ...org,
    members,
    teams,
    total: Math.max(org.total, members.length + (org.omitted ?? 0)),
    live: keptLive + omittedLive,
    problems,
    ...(latest > 0 ? { updatedAt: latest } : {}),
  }
}
