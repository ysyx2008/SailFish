import { describe, it, expect } from 'vitest'
import { inferConversationKind } from '@shared/types'
import { CONVERSATION_POLICY, conversationPolicy } from '../policy'

describe('CONVERSATION_POLICY 策略表', () => {
  it('四类 kind 全部有策略', () => {
    expect(Object.keys(CONVERSATION_POLICY).sort()).toEqual(['companion', 'task', 'wakeup', 'watch'])
  })

  it('task：累积、不回种、进列表、主树', () => {
    const p = conversationPolicy('task')
    expect(p).toEqual({
      accumulates: true,
      seedFromHistoryOnColdStart: false,
      visibleInList: true,
      historyTree: 'main',
      perWatchContinuity: false,
      autoApprovalReview: true,
      autoReviewEarlierWordsWithinMs: null,
      restoreSkillsOnReopen: true,
      skillNotesOnUserMessage: true,
      supportsGoal: true,
      hasArtifactPanel: true,
      hasTerminalSeat: true,
      modelRequestPriority: 'urgent',
      workersMayUseRemoteHosts: true,
    })
  })

  it('产出物面板只有任务的界面上有：联络只有聊天区，关切、唤醒没有界面', () => {
    expect(conversationPolicy('task').hasArtifactPanel).toBe(true)
    expect(conversationPolicy('companion').hasArtifactPanel).toBe(false)
    expect(conversationPolicy('watch').hasArtifactPanel).toBe(false)
    expect(conversationPolicy('wakeup').hasArtifactPanel).toBe(false)
  })

  it('终端座位同理：只有任务有，联络、关切、唤醒没有', () => {
    expect(conversationPolicy('task').hasTerminalSeat).toBe(true)
    expect(conversationPolicy('companion').hasTerminalSeat).toBe(false)
    expect(conversationPolicy('watch').hasTerminalSeat).toBe(false)
    expect(conversationPolicy('wakeup').hasTerminalSeat).toBe(false)
  })

  it('伙计连远程主机：用户在场的任务和联络可以，后台的关切和唤醒不可以', () => {
    expect(conversationPolicy('task').workersMayUseRemoteHosts).toBe(true)
    expect(conversationPolicy('companion').workersMayUseRemoteHosts).toBe(true)
    expect(conversationPolicy('watch').workersMayUseRemoteHosts).toBe(false)
    expect(conversationPolicy('wakeup').workersMayUseRemoteHosts).toBe(false)
  })

  it('模型请求：任务和联络有人当面等不排队，关切和唤醒在后台排队', () => {
    expect(conversationPolicy('task').modelRequestPriority).toBe('urgent')
    expect(conversationPolicy('companion').modelRequestPriority).toBe('urgent')
    expect(conversationPolicy('watch').modelRequestPriority).toBe('queued')
    expect(conversationPolicy('wakeup').modelRequestPriority).toBe('queued')
  })

  it('替我审批认早先的话：任务看整场，联络只往回看 24 小时', () => {
    expect(conversationPolicy('task').autoReviewEarlierWordsWithinMs).toBeNull()
    expect(conversationPolicy('companion').autoReviewEarlierWordsWithinMs).toBe(24 * 60 * 60 * 1000)
  })

  it('companion：累积、冷启动回种（长期关系线）、进列表、主树', () => {
    const p = conversationPolicy('companion')
    expect(p.accumulates).toBe(true)
    expect(p.seedFromHistoryOnColdStart).toBe(true) // 联络跨重启续上同一条
    expect(p.visibleInList).toBe(true)
    expect(p.historyTree).toBe('main')
    expect(p.supportsGoal).toBe(false)
  })

  it('watch：不累积、不回种（逐次失忆避免串味）、不进列表、独立 watch 树', () => {
    const p = conversationPolicy('watch')
    expect(p.accumulates).toBe(false)
    expect(p.visibleInList).toBe(false)
    expect(p.historyTree).toBe('watch')
    // 关切是用户配置的一次性任务，prompt 自带指令，逐次失忆避免 A 关切串味到 B
    expect(p.seedFromHistoryOnColdStart).toBe(false)
  })

  it('wakeup：不累积、冷启动回种（保留记忆辅助决策）、不进列表、watch 树', () => {
    const p = conversationPolicy('wakeup')
    expect(p.accumulates).toBe(false)
    expect(p.seedFromHistoryOnColdStart).toBe(true) // 唤醒需要看用户最近活动做决策
    expect(p.visibleInList).toBe(false)
    expect(p.historyTree).toBe('watch') // 与 watch 同源，共用 watch 树
    expect(p.supportsGoal).toBe(false)
  })

  it('supportsGoal 只开给 task', () => {
    expect(conversationPolicy('task').supportsGoal).toBe(true)
    expect(conversationPolicy('companion').supportsGoal).toBe(false)
    expect(conversationPolicy('watch').supportsGoal).toBe(false)
    expect(conversationPolicy('wakeup').supportsGoal).toBe(false)
  })

  it('重开时只有任务带回当时的技能；联络、关切、唤醒不按历史清单恢复', () => {
    expect(conversationPolicy('task').restoreSkillsOnReopen).toBe(true)
    expect(conversationPolicy('companion').restoreSkillsOnReopen).toBe(false)
    expect(conversationPolicy('watch').restoreSkillsOnReopen).toBe(false)
    expect(conversationPolicy('wakeup').restoreSkillsOnReopen).toBe(false)
  })

  it('替我审批给任务和联络：关切、唤醒是后台执行，没有人当场兜底', () => {
    expect(conversationPolicy('task').autoApprovalReview).toBe(true)
    expect(conversationPolicy('companion').autoApprovalReview).toBe(true)
    expect(conversationPolicy('watch').autoApprovalReview).toBe(false)
    expect(conversationPolicy('wakeup').autoApprovalReview).toBe(false)
  })

  it('perWatchContinuity 预留钩子：当前所有 kind 一律 false（维持现状逐次失忆）', () => {
    expect(conversationPolicy('task').perWatchContinuity).toBe(false)
    expect(conversationPolicy('companion').perWatchContinuity).toBe(false)
    expect(conversationPolicy('watch').perWatchContinuity).toBe(false)
    expect(conversationPolicy('wakeup').perWatchContinuity).toBe(false)
  })

  it('策略表与 inferConversationKind 口径一致：持久命名 Agent（companion+wakeup）冷启动回种，task/watch 不回种', () => {
    // companion + wakeup = true（需要历史记忆），task + watch = false（逐次失忆）。
    const seed = (k?: string) => conversationPolicy(inferConversationKind(k)).seedFromHistoryOnColdStart
    expect(seed('__companion__')).toBe(true)
    expect(seed('__wakeup__')).toBe(true)
    expect(seed('__watch__')).toBe(false)
    expect(seed('tab-123')).toBe(false)
    expect(seed(undefined)).toBe(false)
  })

  it('inferConversationKind 四类映射', () => {
    expect(inferConversationKind('__companion__')).toBe('companion')
    expect(inferConversationKind('__wakeup__')).toBe('wakeup')
    expect(inferConversationKind('__watch__')).toBe('watch')
    expect(inferConversationKind('__watch__:abc')).toBe('watch')
    expect(inferConversationKind('tab-123')).toBe('task')
    expect(inferConversationKind(undefined)).toBe('task')
  })

  it('per-watch agentKey 仍按 watch 策略（逐次失忆）', () => {
    const seed = (k?: string) => conversationPolicy(inferConversationKind(k)).seedFromHistoryOnColdStart
    expect(seed('__watch__:w1')).toBe(false)
  })
})
