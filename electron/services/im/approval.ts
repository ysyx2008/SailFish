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

/** 联络输入框那一档：执行档 + 替我审批开关。IM 运行模式和它是同一个。 */
export function sharedApprovalFromConfig(executionMode: unknown, autoReview: unknown): ApprovalMode {
  const mode: ExecutionMode =
    executionMode === 'strict' || executionMode === 'free' || executionMode === 'relaxed'
      ? executionMode
      : 'relaxed'
  return approvalFromSettings(mode, autoReview === true)
}

/**
 * 把这一档写进联络用的那两份，也写进 IM 原来的那两份，避免再各记各的。
 */
export function persistSharedApproval(
  set: (key: string, value: unknown) => void,
  approval: ApprovalMode,
): void {
  const stored = storedFromImApproval(approval)
  set('executionMode', stored.executionMode)
  set('autoApprovalReview', stored.autoApprovalReview)
  set('imExecutionMode', stored.executionMode)
  set('imAutoApprovalReview', stored.autoApprovalReview)
}

/**
 * IM 上明确选过、又和联络那一档不一致时，以 IM 上选的为准。
 * 没选过（仍是默认的宽松、也没开替我审批）就不动联络那一档。
 */
export function imChoiceAheadOfShared(
  imMode: unknown,
  imAutoReview: unknown,
  executionMode: unknown,
  autoReview: unknown,
): ApprovalMode | undefined {
  const explicit = imMode === 'strict' || imMode === 'free' || imAutoReview === true
  if (!explicit) return undefined
  const chosen = imApprovalFromStored(imMode, imAutoReview)
  return chosen === sharedApprovalFromConfig(executionMode, autoReview) ? undefined : chosen
}
