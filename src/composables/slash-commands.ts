export interface SlashCommandDef {
  id: 'compact' | 'goal'
  names: string[]
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { id: 'compact', names: ['compact', '压缩'] },
  { id: 'goal', names: ['goal'] }
]

export interface ParsedSlash {
  raw: string
  name: string
  rest: string
}

/** 只认输入开头的 `/命令`，后面的字当作补充。 */
export function parseLeadingSlash(text: string): ParsedSlash | null {
  if (!text.startsWith('/')) return null
  const match = text.match(/^\/([^\s]*)(\s[\s\S]*)?$/)
  if (!match) return null
  return {
    raw: `/${match[1]}`,
    name: match[1],
    rest: (match[2] ?? '').replace(/^\s+/, '')
  }
}

export function matchSlashCommands(name: string, defs: SlashCommandDef[] = SLASH_COMMANDS): SlashCommandDef[] {
  const query = name.toLowerCase()
  if (!query) return [...defs]
  return defs.filter(def => def.names.some(n => n.toLowerCase().startsWith(query)))
}

export function exactSlashCommand(name: string, defs: SlashCommandDef[] = SLASH_COMMANDS): SlashCommandDef | null {
  const query = name.toLowerCase()
  return defs.find(def => def.names.some(n => n.toLowerCase() === query)) ?? null
}

export function primarySlashName(def: SlashCommandDef): string {
  return def.names[0]
}

export function formatSlashInvocation(def: SlashCommandDef, hint?: string): string {
  const extra = hint?.trim()
  return extra ? `/${primarySlashName(def)} ${extra}` : `/${primarySlashName(def)}`
}

/** 输入已经是完整命令名（`/compact` / `/压缩`）时才能拿去执行或排队。 */
export function resolveExactSlash(text: string, defs: SlashCommandDef[] = SLASH_COMMANDS): {
  def: SlashCommandDef
  hint: string
} | null {
  const parsed = parseLeadingSlash(text.trim())
  if (!parsed) return null
  const def = exactSlashCommand(parsed.name, defs)
  if (!def) return null
  return { def, hint: parsed.rest }
}

/** 补全条只在还没对上完整命令名时出现；已经是 /compact 或后面开始写补充就收起来。 */
export function shouldShowSlashHint(text: string, defs: SlashCommandDef[] = SLASH_COMMANDS): boolean {
  const parsed = parseLeadingSlash(text.trimStart())
  if (!parsed) return false
  if (exactSlashCommand(parsed.name, defs)) return false
  return matchSlashCommands(parsed.name, defs).length > 0
}

export type GoalSlashAction =
  | { kind: 'status' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'edit'; objective: string }
  | { kind: 'set'; objective: string }

/** 上墙可以带 `/goal`，挂到胶囊上的是后面那句目标正文。 */
export function goalObjectiveFromUserText(text: string): string {
  const slash = resolveExactSlash(text)
  if (slash?.def.id !== 'goal') return text.trim()
  const parsed = parseGoalHint(slash.hint)
  if (parsed.kind === 'set' || parsed.kind === 'edit') return parsed.objective
  return text.trim()
}

/**
 * `/goal` 后面的字：空是看状态；单独一个 pause / resume / clear 是管理命令；`edit` 后面跟新正文；
 * 其余都当新目标（以 clear、pause 开头的一句话是目标正文，不是命令）。
 */
export function parseGoalHint(hint: string): GoalSlashAction {
  const trimmed = hint.trim()
  if (!trimmed) return { kind: 'status' }
  const [verb, ...tail] = trimmed.split(/\s+/)
  const rest = tail.join(' ').trim()
  if (!rest && (verb === 'pause' || verb === 'resume' || verb === 'clear')) return { kind: verb }
  if (verb === 'edit') return { kind: 'edit', objective: rest }
  return { kind: 'set', objective: trimmed }
}
