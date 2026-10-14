/**
 * 用户开口时，问一遍开着的内置技能有没有要附给模型的背景。
 * 技能不必装上；附什么由技能自己决定，这里不认识具体技能。
 */
import { getAllSkills } from './registry'
import type { BuiltinSkillEnablement } from './enablement'
import type { UserMessageNoteContext } from './types'
import { createLogger } from '../../../utils/logger'

const log = createLogger('SkillUserMessageNotes')

export function collectUserMessageNotes(
  enablement: BuiltinSkillEnablement,
  text: string,
  ctx: UserMessageNoteContext,
): string[] {
  if (!text.trim()) return []
  const notes: string[] = []
  for (const skill of getAllSkills()) {
    if (!skill.noteForUserMessage || !enablement.isEnabled(skill.id)) continue
    try {
      const note = skill.noteForUserMessage(text, ctx)?.trim()
      if (note) notes.push(note)
    } catch (e) {
      log.warn(`Skill "${skill.id}" failed to note user message:`, e)
    }
  }
  return notes
}
