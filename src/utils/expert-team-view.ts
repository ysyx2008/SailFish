import { EXPERT_TEAM_LEADER, type ExpertTeamMessageView, type SubAgentResult } from '@shared/types'

export interface ExpertTeamLabels {
  /** 界面语言里组长叫什么 */
  leader: string
  /** 没点名任何人时「给谁」那一格 */
  toNobody: string
  /** 点了好几个人时名字之间用什么隔开 */
  listSeparator: string
}

/** 名字前带上角色：「产品专家·写需求」；组长换成界面语言里的叫法 */
export function memberLabel(name: string, agents: readonly SubAgentResult[], labels: ExpertTeamLabels): string {
  if (name === EXPERT_TEAM_LEADER) return labels.leader
  const role = agents.find(a => (a.name ?? a.id) === name)?.role
  return role ? `${role}·${name}` : name
}

/** 「谁 → 谁、谁」 */
export function messageRoute(m: ExpertTeamMessageView, agents: readonly SubAgentResult[], labels: ExpertTeamLabels): string {
  const to = m.to.length ? m.to.map(n => memberLabel(n, agents, labels)).join(labels.listSeparator) : labels.toNobody
  return `${memberLabel(m.from, agents, labels)} → ${to}`
}

/** 小卡片上那一行要的：最新一条的「谁 → 谁」和压成一行、截短的正文开头 */
export function latestPreview(
  messages: readonly ExpertTeamMessageView[],
  agents: readonly SubAgentResult[],
  labels: ExpertTeamLabels,
  maxChars = 80,
): { route: string; text: string } | null {
  const last = messages[messages.length - 1]
  if (!last) return null
  const text = last.text.replace(/\s+/g, ' ').trim()
  return {
    route: messageRoute(last, agents, labels),
    text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
  }
}
