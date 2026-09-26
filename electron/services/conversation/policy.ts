/**
 * CONVERSATION_POLICY —— 按 kind 的数据驱动行为策略表
 *
 * 设计依据：docs/conversation-refactor-design.md §3.4。
 *
 * 为什么用一张表而不是散落的 `if (_persistentNamedAgent)` / `if (wakeup)` / `if (agentKey==='__watch__')`：
 * 四类会话（task / companion / watch / wakeup）的行为差异是**数据差异**，不是**类型差异**——一个
 * `Conversation` 类即可，不需要继承树。把差异收进这张表，决策点只读表、不写分支，
 * 遵循 `agent-oop-boundary` 规矩（不在 Agent/会话逻辑里散布 kind 字面量分支）。
 *
 * 今天散在 agent.ts 的血泪 if-else（`_persistentNamedAgent` 回种 / wakeup 跳过 cache /
 * watch 独立历史树 / watch 不进列表）都应收敛成读这张表。
 */
import type { ConversationKind } from '@shared/types'

export interface ConversationPolicy {
  /**
   * 是否累积成一条长期线。
   * - task/companion=true：跨 run 累积 transcript，是一条连续的线。
   * - watch/wakeup=false：逐次触发、用完即弃（单次执行不积累成长期对话）。
   */
  accumulates: boolean

  /**
   * 冷启动时是否从全局最近历史回种（== 旧的 `_persistentNamedAgent`：固定 ID、跨 App 重启复用
   * 的「持久命名 Agent」）。它驱动两处：
   *   ① run 初始化：无 sessionId 入口（IM/网关/主动消息）从最近一条同 agentKey 历史回种
   *      sessionId（再经 `!suppressSeed` 门控）；
   *   ② 恢复阶段：taskMemory 为空时 `restoreRecentTaskMemory` 从全局最近历史重建工作记忆。
   *
   * - companion=true：联络是「同一条长期关系线」，①② 都要——重启后续上同一条、记得最近聊过什么。
   * - wakeup=true：唤醒是 Agent 的内心独白与自主循环，需要看用户最近活动做决策——②重建最近
   *   工作记忆（用户近况、最近主动说过什么）；①因记录在独立 watch 树（latestByAgentKey 只查
   *   主树）天然无法回种，恒新起独立 session（每次执行仍经 startNewSession 双保险）。
   * - watch=false：关切是用户配置的一次性任务，prompt 自带完整指令与上下文，逐次失忆避免串味
   *   （曾发生：晨间简报被前一条暑假提醒的工作记忆带偏，跑去发暑假提醒）。
   * - task=false：新 tab 第一次对话本就是新任务，注入历史会造成工具名幻觉调用。
   */
  seedFromHistoryOnColdStart: boolean

  /**
   * 是否进会话列表 / 任务侧栏。
   * - task/companion=true（companion 另进独立常驻 tab，由前端按 agentKey 再做区分）。
   * - watch/wakeup=false：不进用户会话列表（要让用户看见须经 talk_to_user 冒泡进联络）。
   */
  visibleInList: boolean

  /**
   * 历史存储树。
   * - task/companion='main'：进主历史树。
   * - watch/wakeup='watch'：进独立历史树，避免高频触发把主索引压舱（曾达 149MB/2.6w 条）。
   *   wakeup 与 watch 同源，共用 watch 树；前端按 watchId 区分。
   */
  historyTree: 'main' | 'watch'

  /**
   * 【预留钩子，默认 false=维持现状】每个**具体 Watch**（watchId 维度，非 `__watch__` 整体）
   * 是否保留跨执行的连续时间线——即「记得自己上次这个 watch 做过什么」。
   *
   * 现状：watch 逐次失忆（`accumulates=false`）。这个 hook 用于将来按真机表现，
   * 给**部分**有状态巡检类 watch 单独开启连续性，而不影响整体。
   *
   * ⚠️ 心跳（高频、重复、无状态）应**始终保持 false**，否则会把无意义的重复独白
   * 累积成噪声，污染上下文与成本。开启前须先想清楚「哪些 watch 值得记」。
   *
   * 当前所有 kind 一律 false；真正按 watchId 细分的开关晚于本阶段再落，且应落在
   * Watch 配置层（watchId 维度），不在这张 kind 级表上扩展。
   */
  perWatchContinuity: boolean

  /**
   * 用户打开「替我审批」后，本来要问用户的那一下能否先交给独立评审员。
   * - task=true：用户坐在桌面前支使 AI 做事，没放行还能当场交回给他。
   * - companion=false：联络跨渠道汇流，这一刻未必有人在桌面前看确认卡。
   * - watch/wakeup=false：后台执行，没有人当场兜底。
   */
  autoApprovalReview: boolean
}

/**
 * 四类会话的行为策略。
 *
 * | kind      | accumulates | seedFromHistoryOnColdStart | visibleInList | historyTree | perWatchContinuity | autoApprovalReview |
 * |-----------|-------------|----------------------------|---------------|-------------|--------------------|--------------------|
 * | task      | true        | false                      | true          | main        | false              | true               |
 * | companion | true        | true                       | true          | main        | false              | false              |
 * | watch     | false       | false                      | false         | watch       | false（预留）       | false              |
 * | wakeup    | false       | true                       | false         | watch       | false（预留）       | false              |
 *
 * 注：wakeup 从 watch 中独立出来——关切是用户配置的一次性任务（prompt 自带指令，逐次失忆，
 * 避免 A 关切串味到 B），wakeup 是 Agent 自主循环（需要历史记忆辅助决策「该不该主动找人、
 * 上次说过什么避免重复通知」）。两者共用 watch 历史树但 agentKey 分离：`__watch__` vs `__wakeup__`。
 */
export const CONVERSATION_POLICY: Record<ConversationKind, ConversationPolicy> = {
  task: {
    accumulates: true,
    seedFromHistoryOnColdStart: false,
    visibleInList: true,
    historyTree: 'main',
    perWatchContinuity: false,
    autoApprovalReview: true
  },
  companion: {
    accumulates: true,
    seedFromHistoryOnColdStart: true,
    visibleInList: true,
    historyTree: 'main',
    perWatchContinuity: false,
    autoApprovalReview: false
  },
  watch: {
    accumulates: false,
    seedFromHistoryOnColdStart: false,
    visibleInList: false,
    historyTree: 'watch',
    perWatchContinuity: false,
    autoApprovalReview: false
  },
  wakeup: {
    accumulates: false,
    seedFromHistoryOnColdStart: true,
    visibleInList: false,
    historyTree: 'watch',
    perWatchContinuity: false,
    autoApprovalReview: false
  }
}

/** 取某个 kind 的策略（封装 record 访问，便于将来加运行期覆盖/校验）。 */
export function conversationPolicy(kind: ConversationKind): ConversationPolicy {
  return CONVERSATION_POLICY[kind]
}
