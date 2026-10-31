import type { OrgGroup, OrgNode } from './organization-view'

export const ORG_CARD_WIDTH = 240
export const ORG_CARD_HEIGHT = 76
const ROW_GAP = 24
const LEVEL_GAP = 56
export const ORG_TEAM_HEIGHT = 104

export interface OrgMemberPlacement { node: OrgNode; x: number; y: number; depth: number }
export interface OrgTeamPlacement { group: OrgGroup; x: number; y: number; width: number; key: string }
export interface OrgLine { x1: number; y1: number; x2: number; y2: number }
export interface OrgLayout {
  members: OrgMemberPlacement[]
  teams: OrgTeamPlacement[]
  lines: OrgLine[]
  width: number
  height: number
}
export interface OrgViewport { left: number; top: number; right: number; bottom: number }

/** 小组只是同级成员的分组标题，不作为管理节点，也不改变成员所在列。 */
export function layoutOrganization(groups: readonly OrgGroup[], availableWidth: number): OrgLayout {
  const result: OrgLayout = { members: [], teams: [], lines: [], width: 0, height: 0 }
  const hierarchical = groups.some(group => group.nodes.some(node => node.groups.length > 0))
  const columns = Math.max(1, Math.floor((availableWidth + ROW_GAP) / (ORG_CARD_WIDTH + ROW_GAP)))
  const gridWidth = columns * (ORG_CARD_WIDTH + ROW_GAP) - ROW_GAP
  function placeGroups(items: readonly OrgGroup[], depth: number, start: number): { bottom: number; roots: OrgMemberPlacement[] } {
    let cursor = start
    const roots: OrgMemberPlacement[] = []
    for (const group of items) {
      const x = depth * (ORG_CARD_WIDTH + LEVEL_GAP)
      if (group.team) {
        const width = hierarchical ? ORG_CARD_WIDTH : gridWidth
        result.teams.push({ group, x, y: cursor, width, key: JSON.stringify([group.team.owner, group.team.name]) })
        result.width = Math.max(result.width, x + width)
        cursor += ORG_TEAM_HEIGHT + ROW_GAP
      }
      const groupStart = cursor
      group.nodes.forEach((node, index) => {
        let y = cursor
        let children: OrgMemberPlacement[] = []
        if (hierarchical && node.groups.length) {
          const childLayout = placeGroups(node.groups, depth + 1, cursor)
          children = childLayout.roots
          if (children.length) y = (children[0].y + children[children.length - 1].y) / 2
          cursor = Math.max(cursor + ORG_CARD_HEIGHT, childLayout.bottom) + ROW_GAP
        } else if (hierarchical) cursor += ORG_CARD_HEIGHT + ROW_GAP
        else y = groupStart + Math.floor(index / columns) * (ORG_CARD_HEIGHT + ROW_GAP)
        const left = hierarchical ? x : (index % columns) * (ORG_CARD_WIDTH + ROW_GAP)
        const placed = { node, x: left, y, depth }
        result.members.push(placed)
        roots.push(placed)
        result.width = Math.max(result.width, left + ORG_CARD_WIDTH)
        if (children.length) {
          const right = left + ORG_CARD_WIDTH
          const bus = right + LEVEL_GAP / 2
          const center = y + ORG_CARD_HEIGHT / 2
          result.lines.push({ x1: right, y1: center, x2: bus, y2: center })
          result.lines.push({ x1: bus, y1: children[0].y + ORG_CARD_HEIGHT / 2, x2: bus, y2: children[children.length - 1].y + ORG_CARD_HEIGHT / 2 })
          for (const child of children) result.lines.push({ x1: bus, y1: child.y + ORG_CARD_HEIGHT / 2, x2: child.x, y2: child.y + ORG_CARD_HEIGHT / 2 })
        }
      })
      if (!hierarchical) cursor = groupStart + Math.ceil(group.nodes.length / columns) * (ORG_CARD_HEIGHT + ROW_GAP)
      cursor += ROW_GAP
    }
    return { bottom: Math.max(start, cursor - ROW_GAP), roots }
  }
  result.height = placeGroups(groups, 0, 0).bottom
  // DOM 顺序采用树的先序；键盘与辅助技术先到负责人，再到他名下的人。
  const order = new Map<string, number>()
  const visit = (items: readonly OrgGroup[]) => { for (const group of items) for (const node of group.nodes) { order.set(node.member.id, order.size); visit(node.groups) } }
  visit(groups)
  result.members.sort((a, b) => order.get(a.node.member.id)! - order.get(b.node.member.id)!)
  return result
}

/** 仅输出视口附近的线段；长主干也裁到视口，不创建整棵树的屏外 SVG。 */
export function visibleOrgLines(lines: readonly OrgLine[], view: OrgViewport): OrgLine[] {
  return lines.flatMap(line => {
    const left = Math.max(view.left, Math.min(line.x1, line.x2))
    const right = Math.min(view.right, Math.max(line.x1, line.x2))
    const top = Math.max(view.top, Math.min(line.y1, line.y2))
    const bottom = Math.min(view.bottom, Math.max(line.y1, line.y2))
    return left <= right && top <= bottom ? [{ x1: left, y1: top, x2: right, y2: bottom }] : []
  })
}
