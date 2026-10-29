/**
 * 专家和专家团交给模型的话：开工第一条、被叫醒时、敲组长的门。
 */
import type { ChildSnapshot, TeamTexts } from '../sub-agent-roster'
import { TEAM_LEADER, WAKES_PER_CHECKPOINT, type ExpertTeam, type TeamMessage } from '../expert-team'
import { t } from '../i18n'

/** 敲门里带群里最后几条 */
const RECENT_IN_KNOCK = 6
/** 敲门里每条群消息最多带这么多字，全文在群聊文件里 */
const KNOCK_LINE_MAX = 600
/** 叫醒时补看的未读：总字数和单条上限，更早的去群聊文件里看 */
const WAKE_UNREAD_BUDGET = 20000
const WAKE_LINE_MAX = 8000
const ERROR_MAX = 2000

/** 模型可见正文明确作为数据引用；群聊原始消息仍按原样落盘。 */
export function quoteMemberText(text: string, max?: number): string {
  const encode = (value: string) => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const quoted = encode(text)
  if (max === undefined || quoted.length <= max) return quoted
  // 预算按转义后的长度算，避免很多换行或控制字符把一条未读膨胀数倍。
  let low = 0
  let high = Math.min(text.length, max)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encode(`${text.slice(0, middle)}…`).length <= max) low = middle
    else high = middle - 1
  }
  return encode(`${text.slice(0, low)}…`)
}

function statusLabel(status: ChildSnapshot['status']): string {
  switch (status) {
    case 'completed': return t('dispatch.status_completed')
    case 'interrupted': return t('dispatch.status_interrupted')
    case 'failed': return t('dispatch.status_failed')
    case 'pending': return t('dispatch.status_pending')
    default: return t('dispatch.status_running')
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 指定的名字最多写这么长，再长的截掉（实际名字最长 32 个字） */
const ASKED_NAME_MAX = 40

/** 名字和指定的不一样的人，写成「指定的 → 现在的」；没有就是空串 */
export function renamedList(items: ReadonlyArray<{ name: string; askedName?: string }>): string {
  return items
    .filter(m => m.askedName)
    .map(m => `${clip(m.askedName!, ASKED_NAME_MAX)} → ${m.name}`)
    .join('、')
}

export function formatTeamMessage(team: ExpertTeam, m: TeamMessage, max?: number): string {
  const line = t('expert.message_line', {
    from: team.label(m.from),
    to: m.to.length ? m.to.map(n => team.label(n)).join('、') : t('expert.to_nobody'),
    text: quoteMemberText(m.text, max),
  })
  return m.verdict ? `${line} ${t(m.verdict === 'pass' ? 'expert.verdict_mark_pass' : 'expert.verdict_mark_reject')}` : line
}

/** 团有验收人时，交给组长的话里附一行验收状态；没有验收人就不写这一行 */
function reviewLine(team: ExpertTeam): string {
  const state = team.reviewState()
  if (state === 'none') return ''
  const reviewers = team.reviewerNames().map(n => team.label(n)).join('、')
  return `\n${t(`expert.review_${state}`, { reviewers })}`
}

/**
 * 开工第一条话。同团每人开头的团说明逐字一样，好复用模型缓存；
 * 「你是谁」和各自的指令在后面。伙计没有角色，就是指令本身。
 */
export function expertOpening(child: ChildSnapshot, team?: ExpertTeam): string {
  if (!child.role) return child.prompt
  const youAre = t('expert.you_are', { name: child.name, role: child.role }) + (child.reviewer ? `\n${t('expert.you_are_reviewer')}` : '')
  if (!team) return `${youAre}\n\n${child.prompt}`
  const roster = team.roster()
    .map(m => t('expert.list_item', { name: m.name, role: m.role, description: m.description }) + (m.reviewer ? t('expert.reviewer_mark') : ''))
    .join('\n')
  const renamed = renamedList(team.roster())
  const brief = t('expert.team_brief', { team: team.name, roster })
    + `\n${t('expert.team_identity', { leader: team.label(TEAM_LEADER) })}`
    + (renamed ? `\n${t('expert.team_renamed', { list: renamed })}` : '')
  return `${brief}\n\n${youAre}\n\n${child.prompt}`
}

/** 各人状态；带上交的东西（团停下来时）或只报状态（等组长时） */
function memberLines(team: ExpertTeam, members: ChildSnapshot[], withDeliverables: boolean): string {
  return members.map(c => {
    const label = team.label(c.name)
    const status = statusLabel(c.status)
    if (!withDeliverables) return t('expert.member_status_line', { label, status })
    const detail = c.status === 'completed' ? (c.result || '(no output)') : clip(c.error || '-', ERROR_MAX)
    return t('expert.member_line', { label, status, detail: quoteMemberText(detail) })
  }).join('\n')
}

function recentLines(team: ExpertTeam): string {
  const recent = team.recent(RECENT_IN_KNOCK)
  return recent.length ? recent.map(m => formatTeamMessage(team, m, KNOCK_LINE_MAX)).join('\n') : '-'
}

/** 从最新往前取，装满预算为止；返回装下的（按先后）和没装下的条数 */
function fitUnread(team: ExpertTeam, messages: TeamMessage[]): { lines: string[]; dropped: number } {
  const lines: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = formatTeamMessage(team, messages[i], WAKE_LINE_MAX)
    if (lines.length > 0 && used + line.length > WAKE_UNREAD_BUDGET) {
      return { lines: lines.reverse(), dropped: i + 1 }
    }
    lines.push(line)
    used += line.length
  }
  return { lines: lines.reverse(), dropped: 0 }
}

export function createTeamTexts(transcriptPath: (team: ExpertTeam) => string): TeamTexts {
  return {
    wake(team, _member, unread, trigger) {
      const others = trigger ? unread.filter(m => m.seq !== trigger.seq) : unread
      const parts: string[] = []
      if (others.length) {
        const { lines, dropped } = fitUnread(team, others)
        const earlier = dropped ? `${t('expert.wake_earlier', { count: dropped, path: transcriptPath(team) })}\n` : ''
        parts.push(t('expert.wake_unread', { lines: earlier + lines.join('\n') }))
      }
      parts.push(trigger
        ? t('expert.wake_trigger', { from: team.label(trigger.from), text: quoteMemberText(trigger.text) })
        : t('expert.wake_released'))
      return parts.join('\n\n')
    },
    leaderMention(team, message) {
      return t('expert.knock_leader', { team: team.name, from: team.label(message.from), text: quoteMemberText(message.text) })
    },
    secretaryMention(team, message) {
      return t('expert.knock_secretary', {
        team: team.name,
        from: team.label(message.from),
        text: quoteMemberText(message.text),
        path: transcriptPath(team),
      })
    },
    checkpoint(team, members) {
      return t('expert.knock_checkpoint', {
        team: team.name,
        limit: WAKES_PER_CHECKPOINT,
        members: memberLines(team, members, false),
        recent: recentLines(team),
        path: transcriptPath(team),
      }) + reviewLine(team)
    },
    stopped(team, members) {
      const text = t('expert.knock_stopped', {
        team: team.name,
        members: memberLines(team, members, true),
        recent: recentLines(team),
        path: transcriptPath(team),
      }) + reviewLine(team)
      const queued = team.queuedWakes()
      if (!queued.length) return text
      return `${text}\n${t('expert.knock_stopped_queued', { names: queued.map(n => team.label(n)).join('、') })}`
    },
  }
}

/** 落盘的群聊全文 */
/** 群聊全文里一条一行（续写老文件时只拼这些行，不再重复标题） */
export function formatTranscriptLines(team: ExpertTeam, messages: TeamMessage[] = team.transcript()): string[] {
  return messages.map(m => {
    const time = new Date(m.at).toISOString().slice(11, 19)
    return `${time} ${formatTeamMessage(team, m)}`
  })
}

export function formatTranscript(team: ExpertTeam): string {
  return [t('expert.transcript_title', { team: team.name }), '', ...formatTranscriptLines(team)].join('\n') + '\n'
}
