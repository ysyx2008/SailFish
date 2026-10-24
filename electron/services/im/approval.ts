/**
 * IM 运行模式和落盘的两样东西怎么对上。
 * 界面上是四档（含替我审批）；盘上仍是执行档 + 一个开关，
 * 避免把「autoReview」写进只认三档的执行模式。
 */
import {
  approvalFromSettings,
  executionModeOfApproval,
  type ApprovalMode,
  type ExecutionMode,
} from '@shared/types'

export function imApprovalFromStored(mode: unknown, autoReview: unknown): ApprovalMode {
  const execution: ExecutionMode =
    mode === 'strict' || mode === 'free' || mode === 'relaxed' ? mode : 'relaxed'
  return approvalFromSettings(execution, autoReview === true)
}

export function storedFromImApproval(approval: ApprovalMode): {
  executionMode: ExecutionMode
  autoApprovalReview: boolean
} {
  return {
    executionMode: executionModeOfApproval(approval),
    autoApprovalReview: approval === 'autoReview',
  }
}

/**
 * 联络和即时通讯共用这一档。不写新对话的起步档。
 */
export function persistSharedApproval(
  set: (key: string, value: unknown) => void,
  approval: ApprovalMode,
): void {
  const stored = storedFromImApproval(approval)
  set('imExecutionMode', stored.executionMode)
  set('imAutoApprovalReview', stored.autoApprovalReview)
}
