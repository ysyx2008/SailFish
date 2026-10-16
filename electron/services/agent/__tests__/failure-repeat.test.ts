import { describe, it, expect } from 'vitest'
import {
  ALTERNATING_ROUNDS,
  IDENTICAL_FAILURE_LIMIT,
  emptyFailureRepeatState,
  noteFailureRepeat,
  type FailureRepeatState,
  type RepeatNotice,
  type ToolAttempt,
} from '../failure-repeat'

function fail(toolName: string, args: Record<string, unknown> = { command: 'node -e "x"' }): ToolAttempt {
  return { toolName, args, failed: true }
}

function ok(toolName: string, args: Record<string, unknown> = { command: 'node -e "x"' }): ToolAttempt {
  return { toolName, args, failed: false }
}

function feed(attempts: ToolAttempt[]): { state: FailureRepeatState; notices: RepeatNotice[] } {
  let state = emptyFailureRepeatState()
  const notices: RepeatNotice[] = []
  for (const attempt of attempts) {
    const noted = noteFailureRepeat(state, attempt)
    state = noted.state
    if (noted.notice) notices.push(noted.notice)
  }
  return { state, notices }
}

describe('noteFailureRepeat', () => {
  it('同一参数连着失败 4 次还不点明，第 5 次点明一次', () => {
    const attempts = Array.from({ length: IDENTICAL_FAILURE_LIMIT }, () => fail('exec'))
    const { notices } = feed(attempts)
    expect(notices).toEqual([
      { kind: 'identical', toolName: 'exec', times: IDENTICAL_FAILURE_LIMIT },
    ])
  })

  it('点明之后继续用同一参数失败，不再说第二遍', () => {
    const { notices } = feed(Array.from({ length: IDENTICAL_FAILURE_LIMIT + 4 }, () => fail('exec')))
    expect(notices).toHaveLength(1)
  })

  it('中间成功一次，或参数变了，再连着失败 5 次会重新点明', () => {
    const same = () => fail('exec', { command: 'node -e "x"' })
    const changed = fail('exec', { command: 'node -e "y"' })
    const afterSuccess = feed([
      ...Array.from({ length: IDENTICAL_FAILURE_LIMIT }, same),
      ok('exec'),
      ...Array.from({ length: IDENTICAL_FAILURE_LIMIT }, same),
    ])
    expect(afterSuccess.notices).toHaveLength(2)

    const afterChange = feed([
      ...Array.from({ length: IDENTICAL_FAILURE_LIMIT }, same),
      changed,
      ...Array.from({ length: IDENTICAL_FAILURE_LIMIT }, same),
    ])
    expect(afterChange.notices).toHaveLength(2)
  })

  it('参数键的顺序不同，仍算同一次调用', () => {
    const { notices } = feed([
      fail('exec', { command: 'node -e "x"', cwd: '/tmp' }),
      fail('exec', { cwd: '/tmp', command: 'node -e "x"' }),
      fail('exec', { command: 'node -e "x"', cwd: '/tmp' }),
      fail('exec', { cwd: '/tmp', command: 'node -e "x"' }),
      fail('exec', { command: 'node -e "x"', cwd: '/tmp' }),
    ])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ kind: 'identical', times: 5 })
  })

  it('成功、还在跑、参数不同，都不算进这 5 次', () => {
    const running: ToolAttempt = { toolName: 'exec', args: { command: 'node -e "x"' }, failed: false, unsettled: true }
    const { notices } = feed([
      fail('exec'),
      fail('exec'),
      ok('exec'),
      fail('exec'),
      running,
      fail('exec', { command: 'node -e "y"' }),
      fail('exec'),
      fail('exec'),
      fail('exec'),
    ])
    expect(notices).toHaveLength(0)
  })

  it('两个动作交替失败满 3 轮才点明，之后继续交替不再说', () => {
    const rounds = ALTERNATING_ROUNDS
    const pair = [
      fail('exec', { command: 'a' }),
      fail('read_file', { path: '/tmp/a' }),
    ]
    const { notices } = feed([
      ...Array.from({ length: rounds - 1 }, () => pair).flat(),
      ...pair,
      ...pair,
    ])
    expect(notices).toEqual([
      { kind: 'alternating', firstName: 'exec', secondName: 'read_file', rounds },
    ])
  })

  it('交替里夹了一次成功，不算', () => {
    const { notices } = feed([
      fail('exec', { command: 'a' }),
      fail('read_file', { path: '/tmp/a' }),
      fail('exec', { command: 'a' }),
      ok('read_file', { path: '/tmp/a' }),
      fail('exec', { command: 'a' }),
      fail('read_file', { path: '/tmp/a' }),
    ])
    expect(notices).toHaveLength(0)
  })

  it('交替点明之后收成同一步连着失败，会再点明', () => {
    const pair = [
      fail('exec', { command: 'a' }),
      fail('exec', { command: 'b' }),
    ]
    const { notices } = feed([
      ...Array.from({ length: ALTERNATING_ROUNDS }, () => pair).flat(),
      ...Array.from({ length: IDENTICAL_FAILURE_LIMIT }, () => fail('exec', { command: 'a' })),
    ])
    expect(notices.map(notice => notice.kind)).toEqual(['alternating', 'identical'])
  })

  it('没解析到参数时按模型原文比，不同原文不算同一次', () => {
    const raw = (command: string): ToolAttempt => ({
      toolName: 'exec',
      args: {},
      rawArguments: JSON.stringify({ command }),
      failed: true,
    })
    const { notices } = feed([
      raw('a'), raw('b'), raw('c'), raw('d'), raw('e'),
      ...Array.from({ length: IDENTICAL_FAILURE_LIMIT }, () => raw('node -e "x"')),
    ])
    expect(notices).toEqual([
      { kind: 'identical', toolName: 'exec', times: IDENTICAL_FAILURE_LIMIT },
    ])
  })

  it('换了第三个动作之后再陷进同一种交替，可以再点明', () => {
    const pair = [
      fail('exec', { command: 'a' }),
      fail('read_file', { path: '/tmp/a' }),
    ]
    const { notices } = feed([
      ...Array.from({ length: ALTERNATING_ROUNDS }, () => pair).flat(),
      fail('exec', { command: 'other' }),
      ...Array.from({ length: ALTERNATING_ROUNDS }, () => pair).flat(),
    ])
    expect(notices).toHaveLength(2)
    expect(notices.every(notice => notice.kind === 'alternating')).toBe(true)
  })
})
