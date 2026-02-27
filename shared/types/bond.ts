/**
 * 羁绊系统共享类型
 * 量化用户与 Agent 的关系深度，影响对话语气和行为
 */

/** 羁绊等级（信任阶段） */
export type BondTrustLevel = 'stranger' | 'acquaintance' | 'companion' | 'soulmate'

/** 羁绊度量数据 */
export interface BondMetrics {
  /** 综合羁绊值 (0-100) */
  level: number
  /** 信任阶段 */
  trustLevel: BondTrustLevel
  /** 相伴天数 */
  daysTogether: number
  /** 累计完成任务数 */
  tasksCompleted: number
  /** 当前执行模式 */
  executionMode: string
  /** 已达成的羁绊里程碑 */
  milestones: string[]
  /** 上次计算时间 */
  lastCalculatedAt: number
}
