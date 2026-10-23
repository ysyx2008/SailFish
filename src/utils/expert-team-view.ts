import { EXPERT_TEAM_LEADER, type ExpertTeamMessageView, type SubAgentResult } from '@shared/types'

export interface ExpertTeamLabels {
  /** 界面语言里组长叫什么 */
  leader: string
}

/** 名字前带上角色：「产品专家·写需求」；组长换成界面语言里的叫法 */
export function memberLabel(name: string, agents: readonly SubAgentResult[], labels: ExpertTeamLabels): string {
  if (name === EXPERT_TEAM_LEADER) return labels.leader
  const role = agents.find(a => (a.name ?? a.id) === name)?.role
  return role ? `${role}·${name}` : name
}

/** 小卡片上那一行要的：最新一条是谁说的、压成一行并截短的正文开头 */
export function latestPreview(
  messages: readonly ExpertTeamMessageView[],
  labels: ExpertTeamLabels,
  maxChars = 80,
): { sender: string; text: string } | null {
  const last = messages[messages.length - 1]
  if (!last) return null
  const text = last.text.replace(/\s+/g, ' ').trim()
  return {
    sender: last.from === EXPERT_TEAM_LEADER ? labels.leader : last.from,
    text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
  }
}

/** 头像底色的色相：同一个名字在哪都是同一个颜色 */
export function avatarHue(name: string): number {
  let hash = 0
  for (const ch of name.trim()) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return hash % 360
}

/** 头像里写的那个字：名字的第一个字 */
export function avatarInitial(name: string): string {
  return Array.from(name.trim())[0] ?? '?'
}

/** 同一个人隔这么久还在接着说，算同一组，后面几条不再重复头像和名字 */
export const MESSAGE_GROUP_GAP_MS = 2 * 60 * 1000

export function continuesPrevious(prev: ExpertTeamMessageView | undefined, cur: ExpertTeamMessageView): boolean {
  return !!prev && prev.from === cur.from && cur.at - prev.at <= MESSAGE_GROUP_GAP_MS && cur.at >= prev.at
}
