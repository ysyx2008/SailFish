/**
 * 成员在所属协作群里说话。通过dispatch_agents的team入群，role选填。
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

  const verdict = args.verdict === 'pass' || args.verdict === 'reject' ? args.verdict : undefined
  if (args.verdict !== undefined && !verdict) return { success: false, output: '', error: t('expert.say_verdict_invalid') }
  const result = seat.say(to, message, verdict)
  if (!result.ok) {
    const error = result.members
      ? t('expert.say_unknown', { names: to.filter(n => !result.members!.includes(n)).join('、'), members: result.members.join('、') })
      : result.error
    return { success: false, output: '', error }
  }
  const parts = [t('expert.say_ok')]
  if (result.woke.length) parts.push(t('expert.say_woke', { names: result.woke.join('、') }))
  if (result.handed.length) parts.push(t('expert.say_handed', { names: result.handed.join('、') }))
  if (result.queued.length) parts.push(t('expert.say_queued', { names: result.queued.join('、') }))
  if (result.skipped.length) parts.push(t('expert.say_skipped', { names: result.skipped.join('、') }))
  if (result.toLeader) parts.push(t('expert.say_leader'))
  if (result.toSecretary) parts.push(t('expert.say_secretary'))
  if (verdict) parts.push(t(verdict === 'pass' ? 'expert.say_verdict_pass' : 'expert.say_verdict_reject'))
  if (result.checkpointReached) parts.push(t('expert.say_checkpoint', { limit: WAKES_PER_CHECKPOINT }))
  return { success: true, output: parts.join('') }
}
