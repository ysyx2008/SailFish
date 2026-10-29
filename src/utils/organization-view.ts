import type { OrganizationMemberView, OrganizationTeamView, OrganizationView } from '@shared/types'
import { subAgentBucket, type SubAgentBucket, type Translate, type DockKind } from './sub-agent-summary'

/** 组织图上的状态标签：个人用 SubAgentBucket，团另有「有人出问题」和「还没有人」 */
export type OrgStatusBucket = SubAgentBucket | 'problem' | 'empty'

/** 一位组长（或秘书）名下的一组人：一个团，或没组团的散人 */
export interface OrgGroup {
  team?: OrganizationTeamView
  nodes: OrgNode[]
}

/** 组织图上的一个人；组长下面还挂着他名下的几组 */
export interface OrgNode {
  member: OrganizationMemberView
  bucket: SubAgentBucket
  groups: OrgGroup[]
}

const bucketOf = (m: OrganizationMemberView): SubAgentBucket => subAgentBucket({
  id: m.id, description: m.description, status: m.status, waitingForModel: m.waitingForModel,
})

/** 一位主人（秘书写 undefined）名下的人，按团分组，没组团的放最前面 */
function groupsOf(view: OrganizationView, owner: string | undefined, depth: number): OrgGroup[] {
  const mine = view.members.filter(m => m.parent === owner)
  const teams = view.teams.filter(team => team.owner === owner)
  const node = (member: OrganizationMemberView): OrgNode => ({
    member,
    bucket: bucketOf(member),
    // 防御：层数不会超过 3，万一数据成环也不无限往下走
    groups: member.lead && depth < 8 ? groupsOf(view, member.name, depth + 1) : [],
  })
  const loose = mine.filter(m => !m.team || !teams.some(team => team.name === m.team))
  const groups: OrgGroup[] = []
  if (loose.length) groups.push({ nodes: loose.map(node) })
  for (const team of teams) {
    const members = mine.filter(m => m.team === team.name)
    if (members.length) groups.push({ team, nodes: members.map(node) })
  }
  return groups
}

/** 从扁平的全貌还原成树：秘书名下几组，组长名下再几组 */
export function buildOrgTree(view: OrganizationView): OrgGroup[] {
  return groupsOf(view, undefined, 0)
}

/** 执行状态与验收分开统计，不把收工等同于验收通过。 */
export function organizationAttention(org: OrganizationView) {
  return {
    problems: Math.max(org.problems ?? 0, org.members.filter(m => m.status === 'failed' || m.status === 'interrupted').length),
    rejected: org.teams.filter(team => team.review === 'reject').length,
    pending: org.teams.filter(team => team.review === 'pending').length,
    waiting: org.teams.filter(team => team.waitingLeader).length,
  }
}

/** 顶部概览同时保留正在进行、执行异常和验收异常，不用一种状态盖掉另一种。 */
export function describeOrgDock(t: Translate, org: OrganizationView): { kind: DockKind; headline: string } {
  const { problems, rejected, pending, waiting } = organizationAttention(org)
  const kind: DockKind = problems > 0 || rejected > 0 ? 'problem' : org.live > 0 ? 'working' : pending > 0 || waiting > 0 ? 'problem' : 'done'
  const base = org.live > 0
    ? t('ai.organization.dockWorking', { live: org.live, total: org.total })
    : problems > 0 ? t('ai.organization.dockProblem', { total: org.total })
      : rejected > 0 || pending > 0 || waiting > 0 ? t('ai.organization.dockStopped', { total: org.total })
        : t('ai.organization.dockDone', { total: org.total })
  return { kind, headline: [
    base,
    org.live > 0 && problems > 0 ? t('ai.organization.cardProblem', { count: problems }) : '',
    rejected > 0 ? t('ai.organization.summaryRejected', { count: rejected }) : '',
    pending > 0 ? t('ai.organization.summaryPending', { count: pending }) : '',
    waiting > 0 ? t('ai.organization.summaryWaiting', { count: waiting }) : '',
  ].filter(Boolean).join(' · ') }
}

/** 组织里的团数 */
export const orgTeamCount = (org: OrganizationView): number => org.teams.length + (org.omittedTeams ?? 0)
