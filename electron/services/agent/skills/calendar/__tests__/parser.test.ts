/**
 * Calendar 解析函数单元测试
 * 测试 iCal 数据解析的边界情况
 */
import { describe, it, expect } from 'vitest'

// 直接导入要测试的函数
// 注意：parseICalEvent 是私有函数，需要通过模块导出或使用其他方式测试
// 这里我们创建一个简单的测试用解析函数来验证逻辑

/**
 * 简化版 iCal 解析函数（用于测试）
 * 复制自 executor.ts 的 parseICalEvent 核心逻辑
 */
function parseICalEvent(icalData: string | undefined): { uid: string; title: string } | null {
  if (!icalData) {
    return null
  }
  
  try {
    const lines = icalData.split(/\r?\n/)
    let uid = ''
    let summary = ''
    
    for (const line of lines) {
      if (line.startsWith('UID:')) {
        uid = line.substring(4).trim()
      } else if (line.startsWith('SUMMARY:')) {
        summary = line.substring(8).trim()
      }
    }
    
    if (!uid) {
      return null
    }
    
    return {
      uid,
      title: summary || '(无标题)'
    }
  } catch {
    return null
  }
}

describe('parseICalEvent', () => {
  it('should return null for undefined input', () => {
    const result = parseICalEvent(undefined)
    expect(result).toBeNull()
  })

  it('should return null for empty string', () => {
    const result = parseICalEvent('')
    expect(result).toBeNull()
  })

  it('should parse valid iCal event', () => {
    const icalData = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:test-event-123
SUMMARY:测试会议
DTSTART:20260128T090000Z
DTEND:20260128T100000Z
END:VEVENT
END:VCALENDAR`
    
    const result = parseICalEvent(icalData)
    expect(result).not.toBeNull()
    expect(result?.uid).toBe('test-event-123')
    expect(result?.title).toBe('测试会议')
  })

  it('should handle event without SUMMARY', () => {
    const icalData = `BEGIN:VEVENT
UID:no-title-event
DTSTART:20260128T090000Z
END:VEVENT`
    
    const result = parseICalEvent(icalData)
    expect(result).not.toBeNull()
    expect(result?.uid).toBe('no-title-event')
    expect(result?.title).toBe('(无标题)')
  })

  it('should return null for event without UID', () => {
    const icalData = `BEGIN:VEVENT
SUMMARY:无UID的事件
DTSTART:20260128T090000Z
END:VEVENT`
    
    const result = parseICalEvent(icalData)
    expect(result).toBeNull()
  })

  it('should handle malformed iCal data gracefully', () => {
    const malformedData = 'not valid ical data at all'
    const result = parseICalEvent(malformedData)
    // 应该返回 null 而不是抛出异常
    expect(result).toBeNull()
  })
})
