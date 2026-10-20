/**
 * `/goal` 后面那串字怎么读。桌面输入框和命令行共用，写法只有这一份。
 */

export type GoalSlashAction =
  | { kind: 'status' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'clear' }
  | { kind: 'edit'; objective: string }
  | { kind: 'set'; objective: string }

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
