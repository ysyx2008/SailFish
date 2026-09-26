/**
 * 编程技能 - 这场对话里的状态（放在技能会话的状态数据里，不落盘）
 * 伙计拿到的是浅拷贝：这里改数组一律换新数组，不原地改，免得写回主人那份。
 */
import type { SkillData } from '../types'
import type { ToolExecutorConfig } from '../../tools/types'

export const CODING_SKILL_ID = 'coding'

export class CodingState {
  constructor(private readonly data: SkillData) {}

  static of(executor: ToolExecutorConfig): CodingState {
    return new CodingState(executor.skillSession?.getSkillData<SkillData>(CODING_SKILL_ID) ?? {})
  }

  /** 换了项目才清空这场的检查点记录；重开同一个项目接着记 */
  static setRoot(executor: ToolExecutorConfig, root: string): CodingState {
    const session = executor.skillSession
    const current = session?.getSkillData<SkillData>(CODING_SKILL_ID)
    if (current && current.root === root) return new CodingState(current)
    const data: SkillData = { root }
    session?.setSkillData(CODING_SKILL_ID, data)
    return new CodingState(session?.getSkillData<SkillData>(CODING_SKILL_ID) ?? data)
  }

  get root(): string | undefined {
    return typeof this.data.root === 'string' ? this.data.root : undefined
  }

  recordCheckpoint(id: string): void {
    this.data.checkpointIds = [...this.checkpointIds(), id]
  }

  isFromThisConversation(id: string): boolean {
    return this.checkpointIds().includes(id)
  }

  /** 这一轮没留住检查点：下一次工具结果里转告模型 */
  setMissedNote(note: string): void {
    this.data.missedNote = note
  }

  takeMissedNote(): string | undefined {
    const note = typeof this.data.missedNote === 'string' ? this.data.missedNote : undefined
    if (note) delete this.data.missedNote
    return note
  }

  private checkpointIds(): string[] {
    return Array.isArray(this.data.checkpointIds) ? (this.data.checkpointIds as string[]) : []
  }
}
