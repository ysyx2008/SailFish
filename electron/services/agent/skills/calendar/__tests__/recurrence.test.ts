import { describe, expect, it } from 'vitest'
import {
  mergeRRule,
  readRRuleValue,
  readRecurrencePatch,
  recurrenceEndedBefore,
  replaceEventRRule,
  untilOnOrAfterStart,
  viewRecurrence,
} from '../recurrence'

describe('readRecurrencePatch', () => {
  it('creates a weekly series through a date', () => {
    const result = readRecurrencePatch({
      recurrence: 'weekly',
      recurrence_until: '2027-07-31',
    }, 'create')
    expect(result).toEqual({
      ok: true,
      patch: {
        freq: 'weekly',
        until: {
          year: 2027,
          month: 7,
          day: 31,
          hour: 23,
          minute: 59,
          second: 59,
          dateOnly: true,
        },
      },
    })
  })

  it('rejects an end date and a count together', () => {
    const result = readRecurrencePatch({
      recurrence: 'weekly',
      recurrence_until: '2027-07-31',
      recurrence_count: 12,
    }, 'create')
    expect(result).toEqual({ ok: false, error: 'bound_conflict' })
  })

  it('requires a frequency when creating with an end date', () => {
    const result = readRecurrencePatch({ recurrence_until: '2027-07-31' }, 'create')
    expect(result).toEqual({ ok: false, error: 'freq_required' })
  })

  it('treats 0 as clearing the count on update', () => {
    const result = readRecurrencePatch({ recurrence_count: 0 }, 'update')
    expect(result).toEqual({ ok: true, patch: { count: null } })
  })

  it('treats an empty end date as clearing it on update', () => {
    const result = readRecurrencePatch({ recurrence_until: '' }, 'update')
    expect(result).toEqual({ ok: true, patch: { until: null } })
  })

  it('rejects a count of 0 when creating', () => {
    const result = readRecurrencePatch({ recurrence: 'daily', recurrence_count: 0 }, 'create')
    expect(result).toEqual({ ok: false, error: 'count_invalid' })
  })
})

describe('mergeRRule', () => {
  const until = {
    year: 2027,
    month: 7,
    day: 31,
    hour: 23,
    minute: 59,
    second: 59,
    dateOnly: true,
  }

  it('writes an open-ended weekly rule', () => {
    expect(mergeRRule(undefined, { freq: 'weekly' }, false)).toBe('FREQ=WEEKLY')
  })

  it('writes an inclusive end of day for a date-only deadline', () => {
    expect(mergeRRule(undefined, { freq: 'weekly', until }, false)).toBe('FREQ=WEEKLY;UNTIL=20270731T235959')
  })

  it('writes a date until for an all-day event', () => {
    expect(mergeRRule(undefined, { freq: 'weekly', until }, true)).toBe('FREQ=WEEKLY;UNTIL=20270731')
  })

  it('writes an exact time when one was given', () => {
    expect(mergeRRule(undefined, {
      freq: 'weekly',
      until: { ...until, hour: 18, minute: 0, second: 0, dateOnly: false },
    }, false)).toBe('FREQ=WEEKLY;UNTIL=20270731T180000')
  })

  it('writes a count', () => {
    expect(mergeRRule(undefined, { freq: 'weekly', count: 20 }, false)).toBe('FREQ=WEEKLY;COUNT=20')
  })

  it('keeps weekday and replaces a count with an end date', () => {
    expect(mergeRRule('FREQ=WEEKLY;BYDAY=TH;COUNT=40', { until }, false))
      .toBe('FREQ=WEEKLY;BYDAY=TH;UNTIL=20270731T235959')
  })

  it('leaves an existing rule untouched when there is no patch', () => {
    expect(mergeRRule('FREQ=WEEKLY;UNTIL=20270731T155959Z', null, false))
      .toBe('FREQ=WEEKLY;UNTIL=20270731T155959Z')
  })

  it('drops the end date when cleared', () => {
    expect(mergeRRule('FREQ=WEEKLY;BYDAY=TH;UNTIL=20270731T235959', { until: null }, false))
      .toBe('FREQ=WEEKLY;BYDAY=TH')
  })
})

describe('untilOnOrAfterStart', () => {
  const until = {
    year: 2027,
    month: 7,
    day: 31,
    hour: 23,
    minute: 59,
    second: 59,
    dateOnly: true,
  }

  it('accepts a deadline on the same day as the first occurrence', () => {
    expect(untilOnOrAfterStart(until, new Date(2027, 6, 31, 14, 0, 0), false)).toBe(true)
  })

  it('rejects a deadline before the first day', () => {
    expect(untilOnOrAfterStart(until, new Date(2027, 8, 1, 14, 0, 0), false)).toBe(false)
  })
})

describe('viewRecurrence', () => {
  it('shows a date-only deadline without the end-of-day time', () => {
    expect(viewRecurrence('FREQ=WEEKLY;UNTIL=20270731T235959')).toEqual({
      freq: 'weekly',
      until: '2027-07-31',
    })
  })

  it('shows a count', () => {
    expect(viewRecurrence('FREQ=DAILY;COUNT=12')).toEqual({ freq: 'daily', count: 12 })
  })
})

describe('recurrenceEndedBefore', () => {
  it('treats the deadline day as still inside the series', () => {
    expect(recurrenceEndedBefore('FREQ=WEEKLY;UNTIL=20270731T235959', new Date(2027, 6, 31, 0, 0, 0))).toBe(false)
  })

  it('treats the day after the deadline as finished', () => {
    expect(recurrenceEndedBefore('FREQ=WEEKLY;UNTIL=20270731T235959', new Date(2027, 7, 1, 0, 0, 0))).toBe(true)
  })

  it('does not treat an open-ended series as finished', () => {
    expect(recurrenceEndedBefore('FREQ=WEEKLY', new Date(2027, 7, 1))).toBe(false)
  })

  it('treats a counted series as finished after the last occurrence', () => {
    const start = new Date(2026, 9, 1, 14, 0, 0)
    const end = new Date(2026, 9, 1, 15, 0, 0)
    expect(recurrenceEndedBefore('FREQ=DAILY;COUNT=3', new Date(2026, 9, 3, 14, 30, 0), start, end)).toBe(false)
    expect(recurrenceEndedBefore('FREQ=DAILY;COUNT=3', new Date(2026, 9, 3, 15, 1, 0), start, end)).toBe(true)
  })
})

describe('replaceEventRRule', () => {
  const ical = `BEGIN:VCALENDAR
BEGIN:VTIMEZONE
BEGIN:DAYLIGHT
RRULE:FREQ=YEARLY;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:abc
DTSTART;TZID=Asia/Shanghai:20261022T140000
RRULE:FREQ=WEEKLY;UNTIL=20270731T2
 35959
BEGIN:VALARM
TRIGGER:-PT15M
END:VALARM
END:VEVENT
END:VCALENDAR`

  it('replaces only the event rule and keeps timezone, time, and reminder', () => {
    const updated = replaceEventRRule(ical, 'FREQ=WEEKLY;UNTIL=20270731T235959')
    expect(updated).toContain('RRULE:FREQ=YEARLY;BYMONTH=3')
    expect(updated).toContain('DTSTART;TZID=Asia/Shanghai:20261022T140000')
    expect(updated).toContain('TRIGGER:-PT15M')
    expect(updated).toContain('RRULE:FREQ=WEEKLY;UNTIL=20270731T235959')
    expect(updated).not.toContain('UNTIL=20270731T235959\n 35959')
    expect(readRRuleValue(updated)).toBe('FREQ=WEEKLY;UNTIL=20270731T235959')
  })
})

describe('readRRuleValue', () => {
  it('reads the event rule and ignores a timezone rule', () => {
    const ical = `BEGIN:VCALENDAR
BEGIN:VTIMEZONE
BEGIN:DAYLIGHT
RRULE:FREQ=YEARLY;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
RRULE:FREQ=WEEKLY;UNTIL=20270731T2
 35959
END:VEVENT
END:VCALENDAR`
    expect(readRRuleValue(ical)).toBe('FREQ=WEEKLY;UNTIL=20270731T235959')
  })
})
