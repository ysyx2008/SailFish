/**
 * 把步骤流按用户任务切成画面上的一组组。
 * 任务已经结束后再出现的压缩过程，跟在收场后面，不塞回上一场过程里。
 */
import type { AgentStep, AttachmentInfo } from '@shared/types'

export interface AgentTaskGroupDraft {
  id: string
  index: number
  userTask: string
  images?: string[]
  /** 扫描版 PDF 的页面图：仅调试模式下显示（老记录没有，页面图混在 images 里） */
  docPreviewImages?: string[]
  attachments?: AttachmentInfo[]
  steps: AgentStep[]
  afterEndSteps: AgentStep[]
  finalResult?: string
  /** 收场那一步的时间。过程行用它停表，不再一直转到现在 */
  endedAt?: number
  isProactive?: boolean
  isOnboarding?: boolean
  /** 闲着时收到任务回执另起的一轮：不是用户开的口 */
  isReceipt?: boolean
}

const AFTER_END_STEP_TYPES = new Set(['tool_call', 'tool_result', 'thinking'])

export function isFailureFinalResult(result?: string): boolean {
  if (!result) return false
  return result.startsWith('❌') || result.startsWith('⚠️')
}

/** 成功收场才显示「任务完成」。失败和中断另有卡片。 */
export function groupNeedsProcessCompleteFooter(group: {
  finalResult?: string
}): boolean {
  return !!group.finalResult && !isFailureFinalResult(group.finalResult)
}

/**
 * 「任务完成」挂在这一场的最后一格（步骤或折叠行），不挂在中途说过的那句话上。
 * 后头还有干活时，标记跟到那些后面。
 */
export function findTaskCompleteFooterIndex(
  items: ReadonlyArray<{ type: string; group?: { id: string } }>,
  groupId: string,
): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.group?.id !== groupId) continue
    if (item.type !== 'step' && item.type !== 'folded_turn') continue
    return i
  }
  return -1
}

export function groupAgentSteps(allSteps: readonly AgentStep[]): {
  groups: AgentTaskGroupDraft[]
  orphanedStepCount: number
} {
  const groups: AgentTaskGroupDraft[] = []
  let currentGroup: AgentTaskGroupDraft | null = null
  let orphanedStepCount = 0
  let leadingSupplements: AgentStep[] = []

  for (const step of allSteps) {
    if (step.type === 'user_task') {
      const isProactive = step.content === '__proactive__'
      const isOnboarding = step.content === '__onboarding__'
      currentGroup = {
        id: step.id,
        index: groups.length,
        userTask: (isProactive || isOnboarding) ? '' : step.content,
        images: step.images,
        docPreviewImages: step.docPreviewImages,
        attachments: step.attachments,
        steps: [...leadingSupplements],
        afterEndSteps: [],
        isProactive,
        isOnboarding,
      }
      leadingSupplements = []
      groups.push(currentGroup)
    } else if (step.type === 'final_result') {
      if (currentGroup) {
        currentGroup.finalResult = step.content
        currentGroup.endedAt = step.timestamp
        currentGroup = null
      }
    } else if (step.type === 'user_supplement' && !currentGroup) {
      leadingSupplements.push(step)
    } else if (step.type === 'task_receipt' && !currentGroup) {
      currentGroup = {
        id: step.id,
        index: groups.length,
        userTask: '',
        steps: [...leadingSupplements, step],
        afterEndSteps: [],
        isReceipt: true,
      }
      leadingSupplements = []
      groups.push(currentGroup)
    } else if (step.type === 'proactive_notice') {
      if (currentGroup) {
        currentGroup.steps.push(step)
      } else {
        groups.push({
          id: step.id,
          index: groups.length,
          userTask: '',
          steps: [],
          afterEndSteps: [],
          isProactive: true,
          isOnboarding: false,
          finalResult: step.content,
        })
      }
    } else if (step.type !== 'confirm') {
      if (currentGroup) {
        currentGroup.steps.push(step)
      } else if (groups.length > 0 && AFTER_END_STEP_TYPES.has(step.type)) {
        groups[groups.length - 1].afterEndSteps.push(step)
      } else {
        orphanedStepCount++
      }
    }
  }

  return { groups, orphanedStepCount }
}
