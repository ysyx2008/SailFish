/** 用户逐字确认的寻址反馈与系统事实。组织范围由名册判断，不由文案猜测。 */
import type { ChildSnapshot, SubAgentRoster } from '../sub-agent-roster'
import { t } from '../i18n'

export function targetFeedback(
  issue: NonNullable<ReturnType<SubAgentRoster['targetIssue']>>,
  caller: string,
  target: string,
  path: string,
  waiting: boolean,
): string {
  if (issue.kind === 'self') return waiting
    ? `不能等待当前成员本人。\n当前成员：${caller}。\n直属成员名单：${path}。`
    : `不能对当前成员本人使用此工具。\n当前成员：${caller}。\n可操作成员名单：${path}。`
  if (issue.kind === 'foreign') return `成员“${target}”的直属负责人是“${issue.owner}”，不在当前成员“${caller}”的管理范围内。`
  return `没有名为“${target}”的可操作成员。\n当前成员：${caller}。\n可操作成员名单：${path}。请使用名单中的成员真名。`
}

export function emptyWaitFeedback(caller: string, summary: string): string {
  return `当前没有可等待的下属消息。\n当前成员：${caller}。\n直属成员状态：${summary || '无直属成员'}。`
}

/** 未取得系统事实时不猜“无”；模型正文继续使用既有JSON引用格式。 */
export function memberFactsPrefix(child: ChildSnapshot, parent?: string, withReport = true): string {
  if (!child.lead || !child.directMembers) return ''
  const names = child.directMembers.map(member => member.name).join('、') || '无'
  const states = child.directMembers.map(member => `${member.name}：${t(`dispatch.status_${member.status}`)}`).join('；') || '无'
  return [
    '系统记录：',
    `交回成员：${child.name}。`,
    `直属负责人：${parent ?? '秘书'}。`,
    `该成员名下的直属成员：${names}。`,
    `直属成员状态：${states}。`,
    ...(withReport ? ['', '以下为该成员自行撰写的汇报（引用）：'] : []),
  ].join('\n') + '\n'
}
