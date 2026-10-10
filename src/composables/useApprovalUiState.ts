import { computed, ref, type ComputedRef } from 'vue'
import { approvalFromSettings, type ApprovalMode, type ExecutionMode } from '@shared/types'
import { useConfigStore } from '../stores/config'

/** 下拉框显示和修改的是谁的审批方式 */
export interface ApprovalTarget {
  current: ComputedRef<ApprovalMode>
  commit: (next: ApprovalMode) => void
}

function isExecutionMode(value: string): value is ExecutionMode {
  return value === 'strict' || value === 'relaxed' || value === 'free'
}

/** 起步值：「新对话」起始界面上选的，之后新开的对话从它起步 */
export function useDefaultApproval(): ApprovalTarget {
  const configStore = useConfigStore()
  const current = computed<ApprovalMode>(() => approvalFromSettings(
    isExecutionMode(configStore.executionMode) ? configStore.executionMode : 'relaxed',
    configStore.autoApprovalReview
  ))
  const commit = (next: ApprovalMode) => {
    void configStore.setExecutionMode(next === 'autoReview' ? 'relaxed' : next)
    void configStore.setAutoApprovalReview(next === 'autoReview')
  }
  return { current, commit }
}

export function useApprovalUiState(target: ApprovalTarget = useDefaultApproval()) {
  const showFreeModeConfirm = ref(false)

  const approvalUiState = computed<ApprovalMode>(() => target.current.value)

  const applyApprovalUiState = (next: ApprovalMode) => {
    if (next === approvalUiState.value) return
    if (next === 'free') {
      showFreeModeConfirm.value = true
      return
    }
    target.commit(next)
  }

  const confirmEnableFreeMode = () => {
    target.commit('free')
    showFreeModeConfirm.value = false
  }

  const cancelFreeMode = () => {
    showFreeModeConfirm.value = false
  }

  return {
    approvalUiState,
    applyApprovalUiState,
    showFreeModeConfirm,
    confirmEnableFreeMode,
    cancelFreeMode,
  }
}
