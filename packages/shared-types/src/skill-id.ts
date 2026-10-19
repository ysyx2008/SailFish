/**
 * 技能 id 的口径（前后端同一份）。
 *
 * 用户自己装的技能在会话清单里写成 `user:<id>`，避免和内置技能重名；
 * `user:foo` 与 `foo` 指同一条用户技能。
 */
export const USER_SKILL_ID_PREFIX = 'user:'

export function toUserSkillId(skillId: string): string {
  return skillId.startsWith(USER_SKILL_ID_PREFIX) ? skillId : `${USER_SKILL_ID_PREFIX}${skillId}`
}

/** 若为 `user:…` 则返回原始技能 id，否则 null */
export function parseUserSkillId(skillId: string): string | null {
  const id = skillId.trim()
  if (!id.startsWith(USER_SKILL_ID_PREFIX)) return null
  const raw = id.slice(USER_SKILL_ID_PREFIX.length).trim()
  return raw || null
}

/** 用户自己装的技能（不是内置的） */
export function isUserSkillId(skillId: string): boolean {
  return parseUserSkillId(skillId) !== null
}

/** 两个 id 是否指同一条技能：带不带 `user:` 前缀都算同一条 */
export function isSameSkillId(a: string, b: string): boolean {
  return a === b || (parseUserSkillId(a) ?? a) === (parseUserSkillId(b) ?? b)
}
