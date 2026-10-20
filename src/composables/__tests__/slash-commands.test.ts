import { describe, expect, it } from 'vitest'
import {
  exactSlashCommand,
  formatSlashInvocation,
  matchSlashCommands,
  goalObjectiveFromUserText,
  parseGoalHint,
  parseLeadingSlash,
  primarySlashName,
  resolveExactSlash,
  shouldShowSlashHint
} from '../slash-commands'

describe('parseLeadingSlash', () => {
  it('只认开头的斜杠', () => {
    expect(parseLeadingSlash('hello /compact')).toBeNull()
    expect(parseLeadingSlash('/compact')).toEqual({ raw: '/compact', name: 'compact', rest: '' })
    expect(parseLeadingSlash('/压缩 重点留部署')).toEqual({
      raw: '/压缩',
      name: '压缩',
      rest: '重点留部署'
    })
  })
})

describe('matchSlashCommands', () => {
  it('打 / 列出全部，打前缀能筛到 compact', () => {
    expect(matchSlashCommands('').map(c => c.id)).toEqual(['compact', 'goal'])
    expect(matchSlashCommands('c').map(c => c.id)).toEqual(['compact'])
    expect(matchSlashCommands('压').map(c => c.id)).toEqual(['compact'])
    expect(matchSlashCommands('zzz')).toEqual([])
  })
})

describe('exactSlashCommand', () => {
  it('认 compact 和 压缩', () => {
    expect(exactSlashCommand('compact')?.id).toBe('compact')
    expect(exactSlashCommand('压缩')?.id).toBe('compact')
    expect(exactSlashCommand('c')).toBeNull()
    expect(primarySlashName(exactSlashCommand('压缩')!)).toBe('compact')
  })
})

describe('shouldShowSlashHint', () => {
  it('只在还没对上完整命令名时出现', () => {
    expect(shouldShowSlashHint('/')).toBe(true)
    expect(shouldShowSlashHint('/c')).toBe(true)
    expect(shouldShowSlashHint('/compact')).toBe(false)
    expect(shouldShowSlashHint('/compact 好')).toBe(false)
    expect(shouldShowSlashHint('/压缩')).toBe(false)
    expect(shouldShowSlashHint('/zzz')).toBe(false)
    expect(shouldShowSlashHint('hello')).toBe(false)
  })
})

describe('formatSlashInvocation / resolveExactSlash', () => {
  it('补全后的字可以拿去执行或排队', () => {
    const def = exactSlashCommand('压缩')!
    expect(formatSlashInvocation(def)).toBe('/compact')
    expect(formatSlashInvocation(def, '重点留部署')).toBe('/compact 重点留部署')
    expect(resolveExactSlash('/压缩 重点留部署')).toEqual({ def, hint: '重点留部署' })
    expect(resolveExactSlash('/c')).toBeNull()
    expect(resolveExactSlash('hello')).toBeNull()
    expect(resolveExactSlash('/goal 全面测试goal功能')).toEqual({
      def: exactSlashCommand('goal')!,
      hint: '全面测试goal功能'
    })
  })
})

describe('parseGoalHint', () => {
  it('空是看状态，pause/resume/clear/edit 是管理，其余当新目标', () => {
    expect(parseGoalHint('')).toEqual({ kind: 'status' })
    expect(parseGoalHint('pause')).toEqual({ kind: 'pause' })
    expect(parseGoalHint('resume')).toEqual({ kind: 'resume' })
    expect(parseGoalHint('clear')).toEqual({ kind: 'clear' })
    expect(parseGoalHint('edit')).toEqual({ kind: 'edit', objective: '' })
    expect(parseGoalHint('edit 把测试跑绿')).toEqual({ kind: 'edit', objective: '把测试跑绿' })
    expect(parseGoalHint('全面测试goal功能')).toEqual({ kind: 'set', objective: '全面测试goal功能' })
  })

  it('以 clear / pause / resume 开头的一句话是目标正文，不是命令', () => {
    expect(parseGoalHint('clear the build errors')).toEqual({ kind: 'set', objective: 'clear the build errors' })
    expect(parseGoalHint('pause 掉所有过期的定时任务')).toEqual({ kind: 'set', objective: 'pause 掉所有过期的定时任务' })
    expect(parseGoalHint('resume deployment')).toEqual({ kind: 'set', objective: 'resume deployment' })
  })
})

describe('goalObjectiveFromUserText', () => {
  it('上墙带 /goal 时，胶囊只要后面的目标正文', () => {
    expect(goalObjectiveFromUserText('/goal 全面测试goal功能')).toBe('全面测试goal功能')
    expect(goalObjectiveFromUserText('全面测试goal功能')).toBe('全面测试goal功能')
  })
})
