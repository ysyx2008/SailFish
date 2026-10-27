/**
 * 项目组织里系统写的两样东西：共享的组织看板、组织里每个人开场多出的那一段。
 * 只拼文字，数据由调用方从账本和各份花名册里取来。
 */
import type { TeamReviewState } from '@shared/types'
import { t } from '../i18n'

export interface BoardTeam {
  name: string
  review: TeamReviewState
  reviewers: string[]
}

export interface BoardSection {
  /** 这份花名册的主人；秘书的写 undefined */
  owner?: string
  depth: number
  /** 主人向谁汇报；秘书直接派的组长写 undefined（向秘书） */
  reportsTo?: string
  /** 一人一行，已经拼好 */
  rows: string[]
  teams: BoardTeam[]
}

export interface BoardTotals {
  live: number
  total: number
}

function reviewText(team: BoardTeam): string {
  return t(`org.board_review_${team.review}`, { reviewers: team.reviewers.join('、') })
}

export function renderBoard(sections: BoardSection[], totals: BoardTotals): string {
  const secretary = t('org.secretary')
  const lines = [t('org.board_title'), t('org.board_totals', { live: totals.live, total: totals.total }), '']
  for (const section of sections) {
    lines.push(section.owner
      ? t('org.board_section', { owner: section.owner, depth: section.depth, reportsTo: section.reportsTo ?? secretary })
      : t('org.board_section_root'))
    for (const team of section.teams) lines.push(t('org.board_team', { team: team.name, review: reviewText(team) }))
    lines.push(t('dispatch.overview_header'), ...(section.rows.length ? section.rows : ['-']), '')
  }
  return lines.join('\n')
}

export interface OrgOpening {
  boardPath: string
  /** 这位的结果文件放在哪个目录 */
  resultDir: string
  /** 向谁汇报；秘书写 undefined */
  reportsTo?: string
  /** 是组长时，他名下的人的结果放在哪个目录 */
  leadDir?: string
}

/** 组织里每个人开场多出的一段：工作区和看板在哪、向谁汇报；组长再多一句他名下的东西放在哪 */
export function orgOpeningNote(info: OrgOpening): string {
  const lines = [
    t('org.opening_note', {
      board: info.boardPath,
      dir: info.resultDir,
      reportsTo: info.reportsTo ?? t('org.secretary'),
    }),
    t('org.file_rule'),
  ]
  if (info.leadDir) lines.push(t('org.opening_lead', { dir: info.leadDir }))
  return lines.join('\n')
}
