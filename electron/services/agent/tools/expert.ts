/**
 * 专家在专家团的群里说话。派专家走 dispatch_agents（带 role / team），专家在运行上就是伙计。
 */
import type { ToolExecutorConfig, ToolResult } from './types'
import { WAKES_PER_CHECKPOINT } from '../expert-team'
import { t } from '../i18n'

export async function teamSay(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const seat = executor.teamSeat
  if (!seat) return { success: false, output: '', error: t('expert.say_denied') }
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!message) return { success: false, output: '', error: '需要 message' }
  const to = Array.isArray(args.to)
    ? (args.to as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim() !== '').map(n => n.trim())
    : typeof args.to === 'string' && args.to.trim() ? [args.to.trim()] : []

  const result = seat.say(to, message)
  if (!result.ok) {
    const error = result.members
      ? t('expert.say_unknown', { names: to.filter(n => !result.members!.includes(n)).join('、'), members: result.members.join('、') })
      : result.error
    return { success: false, output: '', error }
  }
  const parts = [t('expert.say_ok')]
  if (result.woke.length) parts.push(t('expert.say_woke', { names: result.woke.join('、') }))
  if (result.queued.length) parts.push(t('expert.say_queued', { names: result.queued.join('、') }))
  if (result.skipped.length) parts.push(t('expert.say_skipped', { names: result.skipped.join('、') }))
  if (result.toLeader) parts.push(t('expert.say_leader'))
  if (result.checkpointReached) parts.push(t('expert.say_checkpoint', { limit: WAKES_PER_CHECKPOINT }))
  return { success: true, output: parts.join('') }
}
