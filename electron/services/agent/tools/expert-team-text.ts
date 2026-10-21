/**
 * 专家和专家团交给模型的话：开工第一条、被叫醒时、敲组长的门。
 */
import type { ChildSnapshot, TeamTexts } from '../sub-agent-roster'
import { WAKES_PER_CHECKPOINT, type ExpertTeam, type TeamMessage } from '../expert-team'
import { t } from '../i18n'

/** 敲门里带群里最后几条 */
const RECENT_IN_KNOCK = 6
/** 敲门里每条群消息最多带这么多字，全文在群聊文件里 */
const KNOCK_LINE_MAX = 600
/** 叫醒时补看的未读：总字数和单条上限，更早的去群聊文件里看 */
const WAKE_UNREAD_BUDGET = 20000
const WAKE_LINE_MAX = 8000
const ERROR_MAX = 2000

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

export function formatTeamMessage(team: ExpertTeam, m: TeamMessage, max?: number): string {
  return t('expert.message_line', {
    from: team.label(m.from),
    to: m.to.length ? m.to.map(n => team.label(n)).join('、') : t('expert.to_nobody'),
    text: max ? clip(m.text, max) : m.text,
  })
}

/**
 * 开工第一条话。同团每人开头的团说明逐字一样，好复用模型缓存；
 * 「你是谁」和各自的指令在后面。伙计没有角色，就是指令本身。
 */
export function expertOpening(child: ChildSnapshot, team?: ExpertTeam): string {
  if (!child.role) return child.prompt
  const youAre = t('expert.you_are', { name: child.name, role: child.role })
  if (!team) return `${youAre}\n\n${child.prompt}`
  const roster = team.roster()
    .map(m => t('expert.list_item', { name: m.name, role: m.role, description: m.description }))
    .join('\n')
  const brief = t('expert.team_brief', { team: team.name, roster })
  return `${brief}\n\n${youAre}\n\n${child.prompt}`
}

/** 各人状态；带上交的东西（团停下来时）或只报状态（等组长时） */
function memberLines(team: ExpertTeam, members: ChildSnapshot[], withDeliverables: boolean): string {
  return members.map(c => {
    const label = team.label(c.name)
    const status = statusLabel(c.status)
    if (!withDeliverables) return t('expert.member_status_line', { label, status })
    const detail = c.status === 'completed' ? (c.result || '(no output)') : clip(c.error || '-', ERROR_MAX)
    return t('expert.member_line', { label, status, detail })
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
        ? t('expert.wake_trigger', { from: team.label(trigger.from), text: trigger.text })
        : t('expert.wake_released'))
      return parts.join('\n\n')
    },
    leaderMention(team, message) {
      return t('expert.knock_leader', { team: team.name, from: team.label(message.from), text: message.text })
    },
    checkpoint(team, members) {
      return t('expert.knock_checkpoint', {
        team: team.name,
        limit: WAKES_PER_CHECKPOINT,
        members: memberLines(team, members, false),
        recent: recentLines(team),
        path: transcriptPath(team),
      })
    },
    stopped(team, members) {
      const text = t('expert.knock_stopped', {
        team: team.name,
        members: memberLines(team, members, true),
        recent: recentLines(team),
        path: transcriptPath(team),
      })
      const queued = team.queuedWakes()
      if (!queued.length) return text
      return `${text}\n${t('expert.knock_stopped_queued', { names: queued.map(n => team.label(n)).join('、') })}`
    },
  }
}

/** 落盘的群聊全文 */
export function formatTranscript(team: ExpertTeam): string {
  const lines = team.transcript().map(m => {
    const time = new Date(m.at).toISOString().slice(11, 19)
    return `${time} ${formatTeamMessage(team, m)}`
  })
  return [t('expert.transcript_title', { team: team.name }), '', ...lines].join('\n') + '\n'
}
