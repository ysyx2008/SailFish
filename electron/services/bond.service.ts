/**
 * 羁绊系统服务
 *
 * 量化用户与 Agent 的关系深度，影响对话语气。
 * 数据源全部来自已有的 config（daysTogether、totalConversations、executionMode），
 * 无需新增数据采集，纯数学计算。
 */
import { getConfigService, type ConfigService } from './config.service'
import type { BondMetrics, BondTrustLevel } from '@shared/types'
import { createLogger } from '../utils/logger'

const log = createLogger('BondService')

const TRUST_THRESHOLDS: Array<{ max: number; level: BondTrustLevel }> = [
  { max: 15, level: 'stranger' },
  { max: 40, level: 'acquaintance' },
  { max: 70, level: 'companion' },
  { max: Infinity, level: 'soulmate' },
]

const BOND_MILESTONES = [
  { id: 'bond_first_meet',     threshold: 1,  label_zh: '初次相见',     label_en: 'First Meeting' },
  { id: 'bond_getting_along',  threshold: 20, label_zh: '渐入佳境',     label_en: 'Getting Along' },
  { id: 'bond_trusted_partner',threshold: 40, label_zh: '信赖伙伴',     label_en: 'Trusted Partner' },
  { id: 'bond_old_friend',     threshold: 60, label_zh: '莫逆之交',     label_en: 'Old Friend' },
  { id: 'bond_soulmate',       threshold: 80, label_zh: '心意相通',     label_en: 'Soulmates' },
  { id: 'bond_unbreakable',    threshold: 95, label_zh: '坚不可摧',     label_en: 'Unbreakable' },
]

const TRUST_LABELS: Record<BondTrustLevel, { zh: string; en: string }> = {
  stranger:     { zh: '陌生人', en: 'Stranger' },
  acquaintance: { zh: '相识',   en: 'Acquaintance' },
  companion:    { zh: '伙伴',   en: 'Companion' },
  soulmate:     { zh: '知己',   en: 'Soulmate' },
}

/**
 * 计算天数贡献分 (0-70)
 * 前几天快速上升，之后递减
 */
function calcDaysScore(days: number): number {
  if (days <= 0) return 0
  if (days <= 7)   return days * 1.5                         // 0-10.5
  if (days <= 30)  return 10.5 + (days - 7)   * 0.63        // 10.5-25
  if (days <= 100) return 25   + (days - 30)  * 0.21        // 25-39.7
  if (days <= 365) return 40   + (days - 100) * 0.075       // 40-59.9
  return Math.min(70, 60 + (days - 365) * 0.01)             // 60-70
}

/**
 * 计算任务数贡献分 (0-25)
 */
function calcTasksScore(tasks: number): number {
  if (tasks <= 0) return 0
  if (tasks <= 10)  return tasks * 0.5                       // 0-5
  if (tasks <= 50)  return 5  + (tasks - 10) * 0.125        // 5-10
  if (tasks <= 200) return 10 + (tasks - 50) * 0.067        // 10-20
  return Math.min(25, 20 + (tasks - 200) * 0.01)            // 20-25
}

/**
 * 执行模式信任加成 (0-5)
 */
function calcTrustBonus(mode: string): number {
  switch (mode) {
    case 'free':    return 5
    case 'relaxed': return 3
    default:        return 0
  }
}

function getTrustLevel(level: number): BondTrustLevel {
  for (const { max, level: trust } of TRUST_THRESHOLDS) {
    if (level <= max) return trust
  }
  return 'soulmate'
}

const CACHE_TTL_MS = 60 * 1000

class BondService {
  private configService: ConfigService | null = null
  private cachedMetrics: BondMetrics | null = null
  private cacheTime = 0

  private ensureConfig(): ConfigService {
    if (!this.configService) {
      this.configService = getConfigService()
    }
    return this.configService
  }

  /**
   * 计算当前羁绊度量（带缓存，1 分钟 TTL）
   */
  calculate(): BondMetrics {
    if (this.cachedMetrics && Date.now() - this.cacheTime < CACHE_TTL_MS) {
      return this.cachedMetrics
    }
    return this.computeFresh()
  }

  private computeFresh(): BondMetrics {
    const config = this.ensureConfig()

    const firstUseDate = config.get('appLifecycleFirstUseDate') || Date.now()
    const daysTogether = Math.floor((Date.now() - firstUseDate) / 86400000) + 1
    const tasksCompleted = config.get('appLifecycleTotalConversations') || 0
    const executionMode = config.get('imExecutionMode') || 'relaxed'

    const rawLevel = calcDaysScore(daysTogether)
      + calcTasksScore(tasksCompleted)
      + calcTrustBonus(executionMode)
    const level = Math.round(Math.min(100, Math.max(0, rawLevel)))
    const trustLevel = getTrustLevel(level)

    const savedMilestones = new Set<string>(config.get('bondMilestones') || [])
    const milestones = Array.from(savedMilestones)

    const metrics: BondMetrics = {
      level,
      trustLevel,
      daysTogether,
      tasksCompleted,
      executionMode,
      milestones,
      lastCalculatedAt: Date.now(),
    }
    this.cachedMetrics = metrics
    this.cacheTime = Date.now()
    return metrics
  }

  /**
   * 重新计算并持久化，同时检查新里程碑
   * 返回新解锁的里程碑列表（空 = 无新解锁）
   */
  recalculate(): string[] {
    this.cachedMetrics = null
    const metrics = this.computeFresh()
    const config = this.ensureConfig()

    config.set('bondLevel', metrics.level)
    config.set('bondLastCalculatedAt', metrics.lastCalculatedAt)

    const savedMilestones = new Set<string>(config.get('bondMilestones') || [])
    const newMilestones: string[] = []

    for (const m of BOND_MILESTONES) {
      if (metrics.level >= m.threshold && !savedMilestones.has(m.id)) {
        savedMilestones.add(m.id)
        newMilestones.push(m.id)
        log.info(`Milestone unlocked: ${m.id} (level=${metrics.level})`)
      }
    }

    if (newMilestones.length > 0) {
      config.set('bondMilestones', Array.from(savedMilestones))
    }

    return newMilestones
  }

  /**
   * 生成注入 prompt 的羁绊上下文文本（系统提示词统一中文）
   */
  getBondContext(): string {
    const m = this.calculate()
    if (m.daysTogether === 0 && m.tasksCompleted === 0) return ''

    const trustLabel = TRUST_LABELS[m.trustLevel].zh
    const base = `你和用户已相伴 ${m.daysTogether} 天，一起完成了 ${m.tasksCompleted} 次任务。你们的关系：${trustLabel}（羁绊值 ${m.level}/100）。`
    const caveat = '\n以下语气建议仅供参考，若与上方灵魂定义冲突，以灵魂定义为准。'

    switch (m.trustLevel) {
      case 'stranger':
        return `${base}${caveat}\n你们刚认识不久，保持专业友好即可。`
      case 'acquaintance':
        return `${base}${caveat}\n你们已经有了一些默契，可以自然轻松些。`
      case 'companion':
        return `${base}${caveat}\n你们是老伙伴了，可以自然亲切地交流，偶尔开个玩笑也无妨。`
      case 'soulmate':
        return `${base}${caveat}\n你们心意相通，可以用最自然的方式交流——幽默、调侃、关心对方状态都行。`
    }
  }

  /** 获取所有里程碑定义（供 CLI / UI 展示） */
  getAllMilestones(): Array<{ id: string; threshold: number; label_zh: string; label_en: string; achieved: boolean }> {
    const config = this.ensureConfig()
    const achieved = new Set<string>(config.get('bondMilestones') || [])
    return BOND_MILESTONES.map(m => ({ ...m, achieved: achieved.has(m.id) }))
  }

  /** 信任阶段标签 */
  static getTrustLabels(): Record<BondTrustLevel, { zh: string; en: string }> {
    return TRUST_LABELS
  }
}

let instance: BondService | null = null

export function getBondService(): BondService {
  if (!instance) {
    instance = new BondService()
  }
  return instance
}

export { BondService }
