import type { OrganizationView } from '@shared/types'
import { buildOrgTree, type OrgGroup, type OrgNode } from './organization-view'
import { SUB_AGENT_FOLD_THRESHOLD, sortSubAgentsByBucket } from './sub-agent-summary'

interface Entry { node: OrgNode; parent?: Entry }

/** 快捷名单分页，不修改全量组织图；必要祖先也占一行，前缀随“更多”单调扩大。 */
export function teamMemberList(view: OrganizationView, limit: number): { groups: OrgGroup[]; shown: number; hidden: number; unavailable: number } {
  const original = buildOrgTree(view)
  const entries: Entry[] = []
  const collect = (groups: OrgGroup[], parent?: Entry) => {
    for (const group of groups) for (const node of group.nodes) {
      const entry = { node, parent }
      entries.push(entry)
      collect(node.groups, entry)
    }
  }
  collect(original)
  const byId = new Map(entries.map(entry => [entry.node.member.id, entry]))
  const available = view.members.filter(member => byId.has(member.id))
  const candidates = view.total > SUB_AGENT_FOLD_THRESHOLD
    ? sortSubAgentsByBucket(available).map(member => byId.get(member.id)!) : entries
  const order = new Map<string, number>()
  const include = (entry: Entry) => {
    if (order.has(entry.node.member.id)) return
    if (entry.parent) include(entry.parent)
    order.set(entry.node.member.id, order.size)
  }
  for (const entry of candidates) include(entry)
  const shown = Math.min(order.size, Math.max(0, Math.floor(limit)))
  const selected = (node: OrgNode) => (order.get(node.member.id) ?? Infinity) < shown
  const rank = (node: OrgNode) => order.get(node.member.id) ?? Infinity
  const prune = (groups: OrgGroup[]): OrgGroup[] => groups.map(group => ({
    ...group,
    nodes: group.nodes.filter(selected).map(node => ({ ...node, groups: prune(node.groups) })).sort((a,b) => rank(a)-rank(b)),
  })).filter(group => group.nodes.length).sort((a,b) => rank(a.nodes[0])-rank(b.nodes[0]))
  return { groups: prune(original), shown, hidden: order.size-shown,
    unavailable: Math.max(0, view.total, view.members.length + (view.omitted ?? 0)) - order.size }
}
