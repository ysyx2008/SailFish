import type { OrganizationMemberView, OrganizationTeamView, OrganizationView } from '@shared/types'
import { subAgentBucket, type SubAgentBucket, type Translate, type DockKind } from './sub-agent-summary'

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

/** 顶部那一行：有人在干就写在干几人、共几人；都做完写「都干完了」 */
export function describeOrgDock(t: Translate, org: OrganizationView): { kind: DockKind; headline: string } {
  if (org.live > 0) return { kind: 'working', headline: t('ai.organization.dockWorking', { live: org.live, total: org.total }) }
  const problem = org.members.some(m => m.status === 'failed' || m.status === 'interrupted')
  if (problem) return { kind: 'problem', headline: t('ai.organization.dockProblem', { total: org.total }) }
  return { kind: 'done', headline: t('ai.organization.dockDone', { total: org.total }) }
}

/** 组织里的团数 */
export const orgTeamCount = (org: OrganizationView): number => org.teams.length
