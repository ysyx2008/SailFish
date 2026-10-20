/**
 * 日程写入前后的判断（纯函数，不碰网络）。
 * 设计目标见同目录 SPEC.md「写入以服务端实际结果为准」。
 */

import { viewRecurrence } from './recurrence'
import type { CalendarEvent } from './types'

/** 回读时可以核对的项 */
export type CheckedField = 'title' | 'start' | 'end' | 'location' | 'description' | 'recurrence'

/** 这次写入预期的结果；没给的项不核对 */
export interface ExpectedWrite {
  /** 日程是否全天：全天按日期比，定时按时刻比 */
  allDay: boolean
  title?: string
  start?: Date
  end?: Date
  location?: string
  description?: string
  /** 重复规则正文；空字符串表示预期没有重复 */
  recurrence?: string
}

export interface Mismatch {
  field: CheckedField
  expected: string
  actual: string
}

/** 把对不上的值写成给人看的文字，由调用方按界面语言提供 */
export interface MismatchLabels {
  moment(date: Date, allDay: boolean): string
  recurrence(rrule: string | undefined): string
  /** 空值的写法，如「(无)」 */
  empty: string
}

/** 定时日程允许的时刻误差（服务端可能把秒数抹掉） */
const TIME_TOLERANCE_MS = 60 * 1000

export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

function sameMoment(a: Date, b: Date, allDay: boolean): boolean {
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false
  if (allDay) return isSameLocalDay(a, b)
  return Math.abs(a.getTime() - b.getTime()) <= TIME_TOLERANCE_MS
}

/** 比较文字前的归一：忽略空白与换行的差别 */
export function normalizeText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

/** 只看频率、截止、次数，不拘泥于服务端把规则写成什么顺序和写法 */
function recurrenceKey(rrule: string | undefined): string {
  const view = viewRecurrence(rrule)
  return view ? JSON.stringify([view.freq, view.until ?? '', view.count ?? '']) : ''
}

function canCompareMoments(expected: ExpectedWrite, actual: CalendarEvent): boolean {
  return expected.allDay || !actual.timeZoneUnknown
}

/**
 * 这次预期里有、但因回读到的时区认不出而没能核对的时刻项。
 * 调用方据此如实告知「时间未核对」，不能把没核对的当成对上了。
 */
export function unverifiedMoments(expected: ExpectedWrite, actual: CalendarEvent): Array<'start' | 'end'> {
  if (canCompareMoments(expected, actual)) return []
  const skipped: Array<'start' | 'end'> = []
  if (expected.start) skipped.push('start')
  if (expected.end) skipped.push('end')
  return skipped
}

/**
 * 对照预期与回读到的日程，返回第一处对不上的项；全部对上返回 null。
 */
export function findMismatch(
  expected: ExpectedWrite,
  actual: CalendarEvent,
  labels: MismatchLabels
): Mismatch | null {
  const text = (value: string | undefined) => normalizeText(value) || labels.empty

  if (expected.title !== undefined && normalizeText(expected.title) !== normalizeText(actual.title)) {
    return { field: 'title', expected: text(expected.title), actual: text(actual.title) }
  }
  // 回读到的时区认不出来时，时刻只是估算，拿它判成败会冤枉写成功的服务端：这时不比时刻
  const momentsComparable = canCompareMoments(expected, actual)
  if (momentsComparable && expected.start && !sameMoment(expected.start, actual.start, expected.allDay)) {
    return {
      field: 'start',
      expected: labels.moment(expected.start, expected.allDay),
      actual: labels.moment(actual.start, expected.allDay)
    }
  }
  if (momentsComparable && expected.end && !sameMoment(expected.end, actual.end, expected.allDay)) {
    return {
      field: 'end',
      expected: labels.moment(expected.end, expected.allDay),
      actual: labels.moment(actual.end, expected.allDay)
    }
  }
  if (expected.location !== undefined && normalizeText(expected.location) !== normalizeText(actual.location)) {
    return { field: 'location', expected: text(expected.location), actual: text(actual.location) }
  }
  if (expected.description !== undefined && normalizeText(expected.description) !== normalizeText(actual.description)) {
    return { field: 'description', expected: text(expected.description), actual: text(actual.description) }
  }
  if (expected.recurrence !== undefined && recurrenceKey(expected.recurrence) !== recurrenceKey(actual.recurrence)) {
    return {
      field: 'recurrence',
      expected: labels.recurrence(expected.recurrence || undefined),
      actual: labels.recurrence(actual.recurrence)
    }
  }
  return null
}

/**
 * 日程的发起人是不是当前账户以外的人。
 * 返回 false 表示：发起人就是当前账户，或者两边信息不足、无从判断。
 * 账户只写了账号没带域名时，只比账号部分。
 */
export function organizerIsOther(organizer: string | undefined, username: string | undefined): boolean {
  const o = (organizer ?? '').trim().toLowerCase()
  const u = (username ?? '').trim().toLowerCase()
  if (!o || !u || o === u) return false
  const account = (value: string) => (value.includes('@') ? value.slice(0, value.indexOf('@')) : value)
  if (!o.includes('@') || !u.includes('@')) return account(o) !== account(u)
  return true
}

export type WriteOperation = 'create' | 'update' | 'delete'

/** 各种写操作各自需要的权限：新建要往日历里放东西，改要写内容，删要从日历里移走 */
const REQUIRED_PRIVILEGE: Record<WriteOperation, string> = {
  create: 'bind',
  update: 'write-content',
  delete: 'unbind'
}

/** 这些权限出现任意一项，说明账户不是纯只读 */
const WRITE_FAMILY = ['write', 'write-content', 'write-properties', 'bind', 'unbind']

/**
 * 从权限查询的返回里读出当前账户能不能做这种写操作。
 * 只认「权限」节点里列出的项；有写类权限、但没有这种操作要的那一项时，
 * 说不准（服务端常把不同权限挂在日历或日程上），返回 unknown 而不是冤枉成只读。
 */
export function readWritePrivilege(
  xml: string,
  operation: WriteOperation = 'update'
): 'write' | 'read-only' | 'unknown' {
  const granted = new Set<string>()
  const pattern = /<(?:[\w.-]+:)?privilege\s*>\s*<(?:[\w.-]+:)?([\w-]+)\s*\/?>/gi
  for (const match of xml.matchAll(pattern)) {
    granted.add(match[1].toLowerCase())
  }
  if (granted.has('all') || granted.has('write') || granted.has(REQUIRED_PRIVILEGE[operation])) return 'write'
  if (WRITE_FAMILY.some(name => granted.has(name))) return 'unknown'
  if (granted.has('read')) return 'read-only'
  return 'unknown'
}

/**
 * 读取调用方传来的时间文字。
 * 只写日期（如 2026-10-26）按本机当天的零点理解，而不是 UTC 零点——
 * 否则在东八区以西的机器上会落到前一天。
 * 全天日程只认日期部分：即使带了时刻或时区偏移，也取文字里写的那一天，不做时区换算。
 * 无法识别时返回 null。
 */
export function parseUserDateTime(value: unknown, allDay = false): Date | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  const leadingDate = allDay ? /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(text) : null
  const dayParts = dateOnly ?? leadingDate
  if (dayParts) {
    const year = Number(dayParts[1])
    const month = Number(dayParts[2])
    const day = Number(dayParts[3])
    const date = new Date(year, month - 1, day)
    const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    return real ? date : null
  }
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * 保证结束晚于开始。
 * 全天日程结束不晚于开始时按一天算；定时日程返回 null，由调用方报错。
 */
export function resolveEnd(start: Date, end: Date, allDay: boolean): Date | null {
  if (end.getTime() > start.getTime()) return end
  if (!allDay) return null
  const next = new Date(start.getTime())
  next.setDate(next.getDate() + 1)
  return next
}

/**
 * 只改了开始时间时，让会议时长不变：结束时间跟着后移。
 * 全天日程按天数平移，不受夏令时一天不满 24 小时的影响。
 */
export function shiftEnd(originalStart: Date, originalEnd: Date, nextStart: Date, allDay: boolean): Date {
  if (!allDay) {
    return new Date(nextStart.getTime() + (originalEnd.getTime() - originalStart.getTime()))
  }
  const days = Math.max(1, Math.round((originalEnd.getTime() - originalStart.getTime()) / (24 * 60 * 60 * 1000)))
  const shifted = new Date(nextStart.getTime())
  shifted.setDate(shifted.getDate() + days)
  return shifted
}
