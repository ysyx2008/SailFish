import { describe, expect, it } from 'vitest'
import {
  countActions,
  describeLiveProcess,
  extractProgressLine,
  foldProcessSteps,
  isPinnedProcessStep,
  lastProgressLine,
  type ProcessSegment,
  type ProcessStepLike,
} from './process-fold'

let clock = 0
function step(partial: Partial<ProcessStepLike> & Pick<ProcessStepLike, 'id' | 'type'>): ProcessStepLike {
  clock += 1000
  return { success: true, timestamp: clock, ...partial }
}

function thinkingMessage(id: string, reasoning: string, body = '', timestamp?: number): ProcessStepLike {
  return step({
    id,
    type: 'message',
    ...(timestamp === undefined ? {} : { timestamp }),
    content:
      `<details>\n<summary>🤔 Thinking</summary>\n<blockquote>\n\n${reasoning}\n\n</blockquote>\n</details>` +
      (body ? `\n\n${body}` : ''),
  })
}

/** 思考还在一个字一个字地写 */
function streamingThinking(id: string, reasoning: string): ProcessStepLike {
  return step({
    id,
    type: 'message',
    isStreaming: true,
    content: `<details open>\n<summary>🤔 Thinking</summary>\n<blockquote>\n\n${reasoning}`,
  })
}

/** 展开后（或未折叠时）用户读到的步骤顺序。一条步骤拆成两半时仍只算一次 */
function readingOrder(segments: ProcessSegment[]): string[] {
  const ids = segments.flatMap(seg => seg.steps.map(ref => ref.step.id))
  return ids.filter((id, i) => id !== ids[i - 1])
}

function longRun(): ProcessStepLike[] {
  return [
    thinkingMessage('m1', '先看负载\n负载不高'),
    step({ id: 't1', type: 'tool_call', toolName: 'read_file' }),
    step({ id: 't2', type: 'tool_call', toolName: 'read_file' }),
    step({ id: 't3', type: 'tool_call', toolName: 'execute_command' }),
    step({ id: 't4', type: 'tool_call', toolName: 'execute_command' }),
  ]
}

describe('isPinnedProcessStep', () => {
  it('keeps out what needs you, and what it hands you', () => {
    expect(isPinnedProcessStep(step({ id: 'a', type: 'asking' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'b', type: 'waiting_password' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'c', type: 'error' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'd', type: 'tool_call', toolName: 'exec', riskLevel: 'dangerous' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'e', type: 'tool_call', toolName: 'talk_to_user' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'f', type: 'tool_call', toolName: 'x', echartsOption: {} }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'g', type: 'tool_call', toolName: 'send_file_to_chat' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'h', type: 'tool_call', toolName: 'send_image_to_chat' }))).toBe(true)
    expect(isPinnedProcessStep(step({ id: 'i', type: 'tool_call', toolName: 'send_to_chat' }))).toBe(true)
  })

  it('keeps out anything it says to you, so fold rows stay in place', () => {
    expect(isPinnedProcessStep(thinkingMessage('m', '只是在想', '我先跑几条命令'))).toBe(true)
    expect(isPinnedProcessStep(thinkingMessage('m2', '只是在想'))).toBe(false)
  })

  it('takes auto-review inside — already approved is process, not something you need to act on', () => {
    expect(isPinnedProcessStep(step({
      id: 'r1',
      type: 'auto_review',
      toolName: 'exec',
      riskLevel: 'dangerous',
    }))).toBe(false)
    expect(isPinnedProcessStep(step({
      id: 'r2',
      type: 'auto_review',
      toolName: 'write_text_file',
      riskLevel: 'moderate',
    }))).toBe(false)
  })

  it('takes a mid-task tool failure inside — trying three times and succeeding is still success', () => {
    expect(isPinnedProcessStep(step({ id: 'a', type: 'tool_call', toolName: 'read_file', success: false }))).toBe(false)
  })

  it('takes the step in flight inside — the fold row speaks for it while it runs', () => {
    expect(isPinnedProcessStep(step({ id: 'a', type: 'tool_call', toolName: 'read_file', success: undefined }))).toBe(false)
    expect(isPinnedProcessStep(step({ id: 'b', type: 'thinking', isStreaming: true }))).toBe(false)
  })

  it('takes search results and sub-task progress inside — those are process, not something it hands you', () => {
    expect(isPinnedProcessStep(step({
      id: 's',
      type: 'tool_result',
      toolName: 'web_search',
      webSearchResults: [{ title: 'x' }],
    }))).toBe(false)
    expect(isPinnedProcessStep(step({
      id: 'd',
      type: 'tool_call',
      toolName: 'dispatch_agents',
      subAgents: [{ id: 'sa1', status: 'running' }],
    }))).toBe(false)
  })
})

describe('countActions / extractProgressLine', () => {
  it('counts tool_call buckets', () => {
    expect(countActions(longRun())).toEqual({ read: 2, command: 2 })
  })

  it('takes the last line of the most recent thinking', () => {
    expect(extractProgressLine(longRun())).toBe('负载不高')
    expect(lastProgressLine('- 先看\n- 磁盘在排队')).toBe('磁盘在排队')
  })

  it('takes the last finished sentence out of a run-on paragraph', () => {
    expect(lastProgressLine('先看负载。磁盘在排队。')).toBe('磁盘在排队')
    expect(lastProgressLine('Checked load. Disk is queueing.')).toBe('Disk is queueing')
  })

  it('does not shout half a sentence while it is still being written', () => {
    const steps = [streamingThinking('m1', '负载不高。等等，也许 192.168.31.2 是旁路由。而跑监')]
    expect(extractProgressLine(steps)).toBe('等等，也许 192.168.31.2 是旁路由')
  })

  it('uses the startup waiting label even while that thinking step is still spinning', () => {
    for (const phrase of ['深潜中', '灵感加载中']) {
      const steps = [step({ id: 'prep', type: 'thinking', content: phrase, isStreaming: true })]
      expect(extractProgressLine(steps)).toBe(phrase)
      const segs = foldProcessSteps(steps, { enabled: true })
      expect(segs[0].kind === 'fold' && segs[0].fold.live).toBe(true)
      expect(segs[0].kind === 'fold' && segs[0].fold.thinkingOnly).toBe(true)
      expect(segs[0].kind === 'fold' && segs[0].fold.liveText).toBe(phrase)
      expect(segs[0].kind === 'fold' && segs[0].fold.waitingHint).toBe(true)
    }
  })

  it('drops the waiting hint once it starts writing real thoughts', () => {
    const steps = [
      step({ id: 'prep', type: 'thinking', content: '深潜中', isStreaming: true }),
      streamingThinking('m1', '先看负载。磁盘在排队。'),
    ]
    expect(extractProgressLine(steps)).toBe('磁盘在排队')
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs[0].kind === 'fold' && segs[0].fold.liveText).toBe('磁盘在排队')
    expect(segs[0].kind === 'fold' && segs[0].fold.waitingHint).toBe(false)
  })

  it('stays on the previous line until the new thought finishes a sentence', () => {
    const steps = [
      thinkingMessage('m1', '先看负载。负载不高。'),
      step({ id: 't1', type: 'tool_call', toolName: 'exec' }),
      streamingThinking('m2', '接下来我'),
    ]
    expect(extractProgressLine(steps)).toBe('负载不高')
  })
})

describe('foldProcessSteps', () => {
  it('folds auto-review into the process — the confirm card is what stays out if it did not approve', () => {
    const steps = [
      thinkingMessage('m1', '先对一下你刚说的'),
      step({ id: 'r1', type: 'auto_review', toolName: 'exec', riskLevel: 'dangerous' }),
      step({ id: 't1', type: 'tool_call', toolName: 'exec', riskLevel: 'dangerous' }),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold', 'open'])
    if (segs[0].kind !== 'fold') throw new Error('expected fold')
    expect(segs[0].fold.stepIds).toEqual(['m1', 'r1'])
    expect(segs[1].kind === 'open' && segs[1].steps.map(ref => ref.step.id)).toEqual(['t1'])
  })

  it('folds even a one-step task — the shape never changes', () => {
    const steps = [step({ id: 't1', type: 'tool_call', toolName: 'execute_command' })]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold'])
  })

  it('folds a finished run into action counts + elapsed', () => {
    const steps = longRun()
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs).toHaveLength(1)
    if (segs[0].kind !== 'fold') throw new Error('expected fold')
    expect(segs[0].fold.counts).toEqual({ read: 2, command: 2 })
    expect(segs[0].fold.live).toBe(false)
    expect(segs[0].fold.durationMs).toBe(4000)
  })

  it('leaves elapsed off when the stretch took under a second', () => {
    const steps = [
      step({ id: 't1', type: 'tool_call', toolName: 'read_file', timestamp: 1000 }),
      step({ id: 't2', type: 'tool_call', toolName: 'read_file', timestamp: 1200 }),
    ]
    expect(foldProcessSteps(steps, { enabled: true })[0].kind === 'fold').toBe(true)
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs[0].kind === 'fold' && segs[0].fold.durationMs).toBeUndefined()
  })

  it('stops the live clock when the user interrupts a write still in flight', () => {
    const steps = [
      step({
        id: 'w1',
        type: 'tool_call',
        toolName: 'write_text_file',
        success: undefined,
        isStreaming: true,
        timestamp: 1000,
      }),
      step({ id: 'u1', type: 'user_supplement', content: '改一下图', timestamp: 5000 }),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold', 'open'])
    if (segs[0].kind !== 'fold') throw new Error('expected fold')
    expect(segs[0].fold.live).toBe(false)
    expect(segs[0].fold.counts).toEqual({ write: 1 })
    expect(segs[0].fold.durationMs).toBe(4000)
  })

  it('times a stretch up to the moment the next thing happened', () => {
    const steps = [
      step({ id: 't1', type: 'tool_call', toolName: 'read_file', timestamp: 1000 }),
      step({ id: 't2', type: 'tool_call', toolName: 'read_file', timestamp: 4000 }),
      thinkingMessage('m1', '想想', '看完了', 12000),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs[0].kind === 'fold' && segs[0].fold.durationMs).toBe(11000)
  })

  it('keeps out the prompt asking you to type something', () => {
    expect(isPinnedProcessStep(step({ id: 'w', type: 'waiting_input' }))).toBe(true)
  })

  it('keeps every remark in place and folds each stretch of work where it happened', () => {
    const steps = [
      thinkingMessage('m1', '先看时间', '我先跑几条命令'),
      step({ id: 't1', type: 'tool_call', toolName: 'execute_command' }),
      step({ id: 't2', type: 'tool_call', toolName: 'execute_command' }),
      thinkingMessage('m2', '再看进程', '接着看进程'),
      step({ id: 't3', type: 'tool_call', toolName: 'execute_command' }),
      thinkingMessage('m3', '汇总', '测试结果汇总'),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    // 每句话的"想"跟着前面那截活收进折叠行，说出口的那句留在外面
    expect(segs.map(s => s.kind)).toEqual(['fold', 'open', 'fold', 'open', 'fold', 'open'])
    expect(readingOrder(segs)).toEqual(steps.map(s => s.id))
  })

  it('folds the thinking half of a remark and leaves only what it said out loud', () => {
    const steps = [
      step({ id: 't1', type: 'tool_call', toolName: 'execute_command' }),
      thinkingMessage('m1', '看起来是磁盘满了', '磁盘满了，我清一下缓存'),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold', 'open'])
    if (segs[0].kind !== 'fold') throw new Error('expected fold')
    expect(segs[0].steps.map(ref => [ref.step.id, ref.part])).toEqual([
      ['t1', 'full'],
      ['m1', 'thinking'],
    ])
    expect(segs[1].steps.map(ref => [ref.step.id, ref.part])).toEqual([['m1', 'body']])
    // 只进来半截的不算收在里面：点历史来源要落到外面那句话上
    expect(segs[0].fold.stepIds).toEqual(['t1'])
  })

  it('says it merely thought when a remark came with no work before it', () => {
    const steps = [thinkingMessage('m1', '这个我知道', '不用查，答案是 42')]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold', 'open'])
    expect(segs[0].kind === 'fold' && segs[0].fold.thinkingOnly).toBe(true)
    expect(segs[0].kind === 'fold' && segs[0].fold.live).toBe(false)
  })

  it('keeps a remark whole when it also hands you something', () => {
    const steps = [
      { ...thinkingMessage('m1', '画好了', '图在这儿'), echartsOption: {} },
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['open'])
    expect(segs[0].steps.map(ref => ref.part)).toEqual(['full'])
  })

  it('folds search results and sub-task progress with the rest of the work', () => {
    const steps = [
      thinkingMessage('m1', '先搜再分派'),
      step({ id: 't1', type: 'tool_call', toolName: 'web_search' }),
      step({
        id: 'r1',
        type: 'tool_result',
        toolName: 'web_search',
        webSearchResults: [{ title: 'a' }, { title: 'b' }],
      }),
      step({
        id: 'd1',
        type: 'tool_call',
        toolName: 'dispatch_agents',
        subAgents: [{ id: 'sa1', status: 'running' }],
      }),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold'])
    expect(readingOrder(segs)).toEqual(steps.map(s => s.id))
  })

  it('keeps the fold live while colleagues are still running even after dispatch returned', () => {
    const steps = [
      thinkingMessage('m1', '先派人'),
      step({
        id: 'd1',
        type: 'tool_call',
        toolName: 'dispatch_agents',
        success: true,
        subAgents: [
          { id: 'alice', status: 'running' },
          { id: 'bob', status: 'pending' },
        ],
      }),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs[0].kind === 'fold' && segs[0].fold.live).toBe(true)
    expect(segs[0].kind === 'fold' && segs[0].fold.liveColleagueCount).toBe(2)
  })

  it('marks the stretch in flight as live and says what it is busy with', () => {
    const steps = [
      ...longRun(),
      thinkingMessage('m2', '现在去查上个月的账'),
      step({ id: 'live', type: 'tool_call', toolName: 'execute_command', success: undefined }),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold'])
    if (segs[0].kind !== 'fold') throw new Error('expected fold')
    expect(segs[0].fold.live).toBe(true)
    expect(segs[0].fold.liveText).toBe('现在去查上个月的账')
    expect(segs[0].fold.durationMs).toBeUndefined()
  })

  it('falls back to the action kind when it has not written anything down', () => {
    const steps = [step({ id: 'live', type: 'tool_call', toolName: 'read_file', success: undefined })]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs[0].kind === 'fold' && segs[0].fold.liveAction).toBe('read')
  })

  it('takes a mid-task failure inside the fold, not out', () => {
    const steps = [
      ...longRun(),
      step({ id: 'fail', type: 'tool_call', toolName: 'exec', success: false }),
      step({ id: 't5', type: 'tool_call', toolName: 'read_file' }),
    ]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold'])
    expect(readingOrder(segs)).toEqual(steps.map(s => s.id))
  })

  it('still shows a task-level error outside', () => {
    const steps = [...longRun(), step({ id: 'err', type: 'error', content: '任务失败' })]
    const segs = foldProcessSteps(steps, { enabled: true })
    expect(segs.map(s => s.kind)).toEqual(['fold', 'open'])
    expect(segs[1].kind === 'open' && segs[1].steps[0].step.id).toBe('err')
  })

  it('keeps the fold id stable as the stretch grows, so an opened drawer stays open', () => {
    const steps = longRun()
    const before = foldProcessSteps(steps, { enabled: true })
    const after = foldProcessSteps(
      [...steps, step({ id: 't5', type: 'tool_call', toolName: 'read_file' })],
      { enabled: true },
    )
    expect(before[0].kind === 'fold' && before[0].fold.id).toBe(
      after[0].kind === 'fold' ? after[0].fold.id : '',
    )
  })

  it('does not fold when turned off', () => {
    const steps = longRun()
    expect(foldProcessSteps(steps, { enabled: false })).toEqual([
      { kind: 'open', steps: steps.map(step => ({ step, part: 'full' })) },
    ])
  })
})

describe('describeLiveProcess', () => {
  it('uses the last settled thinking line', () => {
    const view = describeLiveProcess([
      thinkingMessage('m1', '先列提纲。\n再改第三章。'),
    ])
    expect(view.liveText).toBe('再改第三章')
    expect(view.thinkingOnly).toBe(true)
  })

  it('falls back to the current tool kind when there is no thinking yet', () => {
    const view = describeLiveProcess([
      step({ id: 't1', type: 'tool_call', toolName: 'read_file', success: undefined }),
    ])
    expect(view.liveText).toBeUndefined()
    expect(view.liveAction).toBe('read')
    expect(view.counts.read).toBe(1)
  })
})
