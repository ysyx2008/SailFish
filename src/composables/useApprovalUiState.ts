import { computed, ref, type Ref } from 'vue'
import type { ExecutionMode } from '@shared/types'
import { useConfigStore } from '../stores/config'

export type ApprovalUiState = 'strict' | 'relaxed' | 'autoReview' | 'free'

function isExecutionMode(value: string): value is ExecutionMode {
  return value === 'strict' || value === 'relaxed' || value === 'free'
}

export function useApprovalUiState(executionMode?: Ref<ExecutionMode>) {
  const configStore = useConfigStore()
  const showFreeModeConfirm = ref(false)

  const currentMode = computed<ExecutionMode>(() => {
    if (executionMode) return executionMode.value
    return isExecutionMode(configStore.executionMode) ? configStore.executionMode : 'relaxed'
  })

  const approvalUiState = computed<ApprovalUiState>(() => {
    if (currentMode.value === 'free') return 'free'
    if (configStore.autoApprovalReview) return 'autoReview'
    return currentMode.value === 'strict' ? 'strict' : 'relaxed'
  })

  const commitMode = (mode: ExecutionMode, review: boolean) => {
    if (executionMode) executionMode.value = mode
    void configStore.setExecutionMode(mode)
    void configStore.setAutoApprovalReview(review)
  }

  const applyApprovalUiState = (next: ApprovalUiState) => {
    if (next === approvalUiState.value) return
    if (next === 'free') {
      showFreeModeConfirm.value = true
      return
    }
    if (next === 'autoReview') {
      commitMode('relaxed', true)
      return
    }
    commitMode(next, false)
  }

  const confirmEnableFreeMode = () => {
    commitMode('free', false)
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
