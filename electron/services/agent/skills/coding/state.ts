/**
 * 编程技能 - 这场对话里的状态（放在技能会话的状态数据里，不落盘）
 */
import type { SkillData } from '../types'
import type { ToolExecutorConfig } from '../../tools/types'

export const CODING_SKILL_ID = 'coding'

export class CodingState {
  constructor(private readonly data: SkillData) {}

  static of(executor: ToolExecutorConfig): CodingState {
    return new CodingState(executor.skillSession?.getSkillData<SkillData>(CODING_SKILL_ID) ?? {})
  }

  static setRoot(executor: ToolExecutorConfig, root: string): void {
    executor.skillSession?.setSkillData(CODING_SKILL_ID, { root })
  }

  get root(): string | undefined {
    return typeof this.data.root === 'string' ? this.data.root : undefined
  }
}
