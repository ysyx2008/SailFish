<script setup lang="ts">
/**
 * 欢迎页 AI 快速发起入口 —— 复用 AiComposer（附件、语音、@ 提及等）
 * 发送后创建独立助手 tab，并将文档/图片 handoff 给 AiPanel 自动 runAgent。
 */
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AiComposer from './AiComposer.vue'
import AiProfileSelect from './AiProfileSelect.vue'
import ApprovalModeSelect from './ApprovalModeSelect.vue'
import { useApprovalUiState } from '../composables/useApprovalUiState'
import { useConfigStore } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import { WELCOME_COMPOSER_TAB_ID } from '../constants/welcome-composer'
import { useDocumentUpload } from '../composables/useDocumentUpload'
import { useImageUpload } from '../composables/useImageUpload'
import { useSpeechRecognition, SPEECH_PACK_NOT_INSTALLED } from '../composables/useSpeechRecognition'
import { planComposerPaste, ingestComposerAttachments } from '../composables/useComposerPaste'
import { showConfirm } from '../composables/useConfirm'
import { toast } from '../composables/useToast'

const props = defineProps<{
  /** 欢迎页是否为当前主界面（切到 tab 时为 false，用于禁用全局 PTT 监听） */
  active?: boolean
}>()

const { t } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const showSettings = inject<() => void>('showSettings')
const {
  approvalUiState,
  applyApprovalUiState,
  showFreeModeConfirm,
  confirmEnableFreeMode,
  cancelFreeMode,
} = useApprovalUiState()
const openAppSettings = inject<(tab?: string, section?: string) => void>('openAppSettings')

const composerTabId = ref(WELCOME_COMPOSER_TAB_ID)
const composerRef = ref<InstanceType<typeof AiComposer> | null>(null)
const isMounted = ref(false)
const previewImageUrl = ref<string | null>(null)

const {
  uploadedDocs,
  parsingDocs,
  isUploadingDocs,
  removeUploadedDoc,
  clearUploadedDocs,
  formatFileSize,
  handleDroppedFiles
} = useDocumentUpload(composerTabId)

const {
  pendingImages,
  isProcessingImage,
  handleDroppedImages,
  removeImage,
  clearImages,
  discardImages,
  loadPendingImages,
  ensurePendingImagePaths,
  hasImages
} = useImageUpload()

const isAttaching = computed(() => isUploadingDocs.value || isProcessingImage.value)
const hasImagesComputed = computed(() => hasImages())
const hasComposerAttachments = computed(
  () =>
    uploadedDocs.value.length > 0 ||
    parsingDocs.value.length > 0 ||
    pendingImages.value.length > 0
)

const ingestAttachmentFiles = (files: FileList | File[]) =>
  ingestComposerAttachments(files, {
    ingestImages: handleDroppedImages,
    ingestDocuments: handleDroppedFiles
  })

const focusComposer = () => {
  composerRef.value?.focusInput()
}

defineExpose({ ingestAttachmentFiles, focusComposer })

const selectAttachment = () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = ''
  input.onchange = async () => {
    if (!input.files || input.files.length === 0) return
    await ingestAttachmentFiles(input.files)
  }
  input.click()
}

const handlePaste = async (event: ClipboardEvent) => {
  const plan = planComposerPaste(event)
  if (plan.kind === 'default') return
  event.preventDefault()
  await ingestAttachmentFiles(plan.files)
}

const {
  isRecording,
  isTranscribing,
  isInitializing: isSpeechInitializing,
  audioAvailable,
  modelAvailable,
  error: speechError,
  refreshSpeechPackAvailability,
  startRecording,
  stopRecording,
  cancelRecording
} = useSpeechRecognition()

watch(speechError, (error) => {
  if (!error) return
  if (error === SPEECH_PACK_NOT_INSTALLED) {
    toast.show(t('ai.speechPackNotInstalled'), 'warning', 6000, true, {
      action: t('ai.speechPackOpenSettings'),
      onClick: () => openAppSettings?.('voice', 'speechPack'),
    })
    return
  }
  toast.error(t('ai.speechError', { error }))
})

watch(() => props.active, (active) => {
  if (active) return
  if (!isPushToTalk.value && !pttStartTimer && !isRecording.value) return
  clearPTTStartTimer()
  clearPTTStopTimer()
  isPushToTalk.value = false
  cancelRecording()
})

const handleRecordClick = async () => {
  if (!props.active) return
  if (isRecording.value) {
    const result = await stopRecording()
    if (result?.text) composerRef.value?.appendText(result.text)
  } else {
    await startRecording()
  }
}

// Push-to-Talk（欢迎页无 active tab，独立监听）
const isPushToTalk = ref(false)
let pttStopTimer: ReturnType<typeof setTimeout> | null = null
let pttStartTimer: ReturnType<typeof setTimeout> | null = null
const PTT_HOLD_THRESHOLD = 300

const clearPTTStopTimer = () => {
  if (pttStopTimer) {
    clearTimeout(pttStopTimer)
    pttStopTimer = null
  }
}

const clearPTTStartTimer = () => {
  if (pttStartTimer) {
    clearTimeout(pttStartTimer)
    pttStartTimer = null
  }
}

const MODIFIER_EVENT_PROPS: Record<string, keyof KeyboardEvent> = {
  Control: 'ctrlKey',
  Meta: 'metaKey',
  Shift: 'shiftKey',
  Alt: 'altKey'
}

function hasOtherModifiers(event: KeyboardEvent, pttKey: string): boolean {
  for (const [key, prop] of Object.entries(MODIFIER_EVENT_PROPS)) {
    if (key !== pttKey && event[prop as keyof KeyboardEvent]) return true
  }
  return false
}

const handlePTTKeyDown = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (!pttKey || !audioAvailable.value || !isMounted.value || !props.active) return

  if (event.key !== pttKey) {
    if (isPushToTalk.value || pttStartTimer || isRecording.value) {
      clearPTTStartTimer()
      clearPTTStopTimer()
      isPushToTalk.value = false
      cancelRecording()
    }
    return
  }

  // 未安装语音模型时禁用 PTT 快捷键（麦克风按钮仍可点击引导安装）。
  // null = 尚未查到 pack 状态，放行由 startRecording 内再判定。
  if (modelAvailable.value === false) return

  if (event.repeat) return
  if (hasOtherModifiers(event, pttKey)) return
  if (pttStopTimer) {
    clearPTTStopTimer()
    return
  }
  if (pttStartTimer) return
  if (isRecording.value || isTranscribing.value || isSpeechInitializing.value) return

  isPushToTalk.value = true
  pttStartTimer = setTimeout(() => {
    pttStartTimer = null
    if (isPushToTalk.value) startRecording()
  }, PTT_HOLD_THRESHOLD)
}

const finishPTTRecording = async () => {
  pttStopTimer = null
  isPushToTalk.value = false
  const result = await stopRecording()
  if (!isMounted.value) return
  if (result?.text) composerRef.value?.appendText(result.text)
}

const handlePTTKeyUp = (event: KeyboardEvent) => {
  const pttKey = configStore.keyboardShortcuts.voiceInput
  if (!props.active || event.key !== pttKey || !isPushToTalk.value) return

  if (pttStartTimer) {
    clearPTTStartTimer()
    isPushToTalk.value = false
    return
  }

  clearPTTStopTimer()
  pttStopTimer = setTimeout(finishPTTRecording, 200)
}

const handlePTTWindowBlur = () => {
  if (isPushToTalk.value || pttStartTimer) {
    clearPTTStartTimer()
    clearPTTStopTimer()
    isPushToTalk.value = false
    cancelRecording()
  }
}

const activeAiProfile = computed(() =>
  configStore.aiProfiles.find(p => p.id === configStore.activeAiProfileId) || null
)

let visionWarningShown = false
const checkVisionSupport = async () => {
  if (visionWarningShown) return
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (!hasVision) {
    visionWarningShown = true
    toast.warning(t('ai.visionNotSupported', { model: activeAiProfile.value?.model || '' }), 6000)
  }
}

watch(() => pendingImages.value.length, (newLen, oldLen) => {
  if (newLen > oldLen) void checkVisionSupport()
})

const guardVisionBeforeSend = async (): Promise<boolean> => {
  if (!hasImages()) return true
  const hasVision = await window.electronAPI.config.hasVisionCapability()
  if (hasVision) return true

  const proceed = await showConfirm({
    type: 'warning',
    title: t('ai.visionGuardTitle'),
    message: t('ai.visionGuardMessage', { model: activeAiProfile.value?.model || t('ai.visionGuardCurrentModel') }),
    detail: t('ai.visionGuardDetail'),
    confirmText: t('ai.visionGuardSendAnyway'),
    cancelText: t('common.cancel'),
    neutralText: t('ai.visionGuardOpenSettings'),
    onNeutral: () => showSettings?.()
  })
  if (proceed) {
    discardImages()
    toast.info(t('ai.visionGuardImagesDropped'))
  }
  return proceed
}

const contextStats = computed(() => ({
  tokenEstimate: 0,
  maxTokens: 100_000,
  percentage: 0
}))

const openImagePreview = (url: string) => {
  previewImageUrl.value = url
}

const closeImagePreview = () => {
  previewImageUrl.value = null
}

const handlePreviewKeyDown = (event: KeyboardEvent) => {
  if (!previewImageUrl.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  closeImagePreview()
}

watch(previewImageUrl, (url) => {
  if (url) {
    document.addEventListener('keydown', handlePreviewKeyDown, true)
  } else {
    document.removeEventListener('keydown', handlePreviewKeyDown, true)
  }
})

const handleFreeModeKeyDown = (event: KeyboardEvent) => {
  if (!showFreeModeConfirm.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  cancelFreeMode()
}

watch(showFreeModeConfirm, (open) => {
  if (open) {
    document.addEventListener('keydown', handleFreeModeKeyDown, true)
    return
  }
  document.removeEventListener('keydown', handleFreeModeKeyDown, true)
})

/** 发送成功后跳过 onUnmounted 草稿回写（避免与 clearWelcomeComposerDraft 竞态） */
let skipDraftPersist = false

const persistWelcomeComposerDraft = () => {
  terminalStore.setWelcomeComposerDraft(
    composerRef.value?.getText() ?? '',
    pendingImages.value.map(img => ({ ...img }))
  )
}

const restoreWelcomeComposerDraft = () => {
  const draft = terminalStore.getWelcomeComposerDraft()
  loadPendingImages(draft.images)
  nextTick(() => {
    if (draft.text) composerRef.value?.setText(draft.text)
    composerRef.value?.focusInput()
  })
}

const noop = () => {}

const handleComposerSubmit = async (message: string) => {
  if (!(await guardVisionBeforeSend())) return
  await ensurePendingImagePaths()

  const imagesSnapshot = pendingImages.value.map(img => ({ ...img }))
  skipDraftPersist = true
  clearImages()
  terminalStore.clearWelcomeComposerDraft()
  const tabId = terminalStore.createAssistantTab({ activate: false })
  terminalStore.transferUploadedDocs(WELCOME_COMPOSER_TAB_ID, tabId)
  const { useConversationSkillsStore } = await import('../stores/conversation-skills')
  const skillChips = useConversationSkillsStore().transferWelcomeSkills(tabId)
  terminalStore.setPendingComposerHandoff(tabId, {
    message,
    images: imagesSnapshot,
    skillIds: skillChips.map(s => s.id)
  })
  terminalStore.markAssistantSkipOnboarding(tabId)
  terminalStore.focusHubConversation(tabId)
  // 任务已切入 Hub 后，关闭首页「初次见面」邀请
  void configStore.markAgentOnboardingShown()
}

onMounted(() => {
  isMounted.value = true
  skipDraftPersist = false
  restoreWelcomeComposerDraft()
  document.addEventListener('keydown', handlePTTKeyDown, true)
  document.addEventListener('keyup', handlePTTKeyUp, true)
  window.addEventListener('blur', handlePTTWindowBlur)
  // 尽早刷新 pack 状态，供 PTT 门控（不 toast）
  if (configStore.keyboardShortcuts.voiceInput) {
    void refreshSpeechPackAvailability()
  }
  // 初始可见时自动聚焦
  if (props.active) {
    nextTick(() => composerRef.value?.focusInput())
  }
})

// 每次切回欢迎页（active 变为 true）时聚焦输入框
watch(() => props.active, (active) => {
  if (active) {
    nextTick(() => {
      composerRef.value?.focusInput()
      composerRef.value?.refreshPlaceholder?.()
    })
  }
})

onUnmounted(() => {
  isMounted.value = false
  if (!skipDraftPersist) persistWelcomeComposerDraft()
  document.removeEventListener('keydown', handlePreviewKeyDown, true)
  document.removeEventListener('keydown', handleFreeModeKeyDown, true)
  document.removeEventListener('keydown', handlePTTKeyDown, true)
  document.removeEventListener('keyup', handlePTTKeyUp, true)
  window.removeEventListener('blur', handlePTTWindowBlur)
  clearPTTStartTimer()
  clearPTTStopTimer()
  cancelRecording()
})
</script>

<template>
  <div
    class="welcome-chat-composer"
    :class="{ 'has-attachments': hasComposerAttachments }"
  >
    <AiComposer
      ref="composerRef"
      embedded
      placeholder-pools-key="welcome.chatLeadPools"
      placeholder-fallback-key="welcome.chatLead"
      :current-tab-id="composerTabId"
      :visible="true"
      :context-stats="contextStats"
      :cache-bar-width="0"
      :uploaded-docs="uploadedDocs"
      :parsing-docs="parsingDocs"
      :pending-images="pendingImages"
      :is-attaching="isAttaching"
      :is-agent-running="false"
      :is-loading="false"
      :can-send-empty="false"
      :has-images="hasImagesComputed"
      :is-recording="isRecording"
      :is-transcribing="isTranscribing"
      :is-push-to-talk="isPushToTalk"
      :audio-available="audioAvailable"
      :is-speech-initializing="isSpeechInitializing"
      :voice-input-enabled="!!configStore.keyboardShortcuts.voiceInput"
      :format-file-size="(size?: number) => formatFileSize(size ?? 0)"
      :open-image-preview="openImagePreview"
      :remove-image="removeImage"
      :select-attachment="selectAttachment"
      :remove-uploaded-doc="removeUploadedDoc"
      :clear-uploaded-docs="clearUploadedDocs"
      :handle-paste="handlePaste"
      :handle-record-click="handleRecordClick"
      :stop-generation="noop"
      :abort-agent="noop"
      :tts-is-speaking="false"
      :tts-stop="noop"
      :submit-message="handleComposerSubmit"
      :submit-empty-message="noop"
      :clear-tab-error="noop"
    >
      <template #footer-left>
        <AiProfileSelect
          v-if="configStore.aiProfiles.length > 0"
          embedded
          :profiles="configStore.aiProfiles"
          :model-value="configStore.activeAiProfileId"
          @update:model-value="configStore.setActiveAiProfile"
        />
      </template>
      <template #footer-right>
        <ApprovalModeSelect
          :model-value="approvalUiState"
          @update:model-value="applyApprovalUiState"
        />
      </template>
    </AiComposer>
    <Teleport to="body">
      <div v-if="showFreeModeConfirm" class="free-mode-confirm-overlay" @click.self="cancelFreeMode">
        <div class="free-mode-confirm-dialog">
          <div class="confirm-dialog-header">
            <span class="confirm-dialog-icon">⚠️</span>
            <span class="confirm-dialog-title">{{ t('ai.freeModeConfirmTitle') }}</span>
          </div>
          <div class="confirm-dialog-content">
            <p>{{ t('ai.freeModeConfirmDesc') }}</p>
            <ul class="confirm-dialog-warnings">
              <li>{{ t('ai.freeModeWarning1') }}</li>
              <li>{{ t('ai.freeModeWarning2') }}</li>
              <li>{{ t('ai.freeModeWarning3') }}</li>
            </ul>
          </div>
          <div class="confirm-dialog-actions">
            <button class="btn btn-sm btn-outline" @click="cancelFreeMode">
              {{ t('common.no') }}
            </button>
            <button class="btn btn-sm btn-danger" @click="confirmEnableFreeMode">
              {{ t('common.yes') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    <!-- Teleport 到 body：父级 welcome-chat-composer 的 transform 动画会创建层叠上下文，
         导致 position:fixed 预览被限制在 composer 区域内，无法盖住下方快速启动卡片 -->
    <Teleport to="body">
      <div v-if="previewImageUrl" class="welcome-image-preview" @click.self="closeImagePreview">
        <button type="button" class="welcome-image-preview-close" @click="closeImagePreview">×</button>
        <img :src="previewImageUrl" alt="" class="welcome-image-preview-img" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.welcome-chat-composer {
  margin-bottom: 18px;
  animation: welcomeComposerEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.06s forwards;
  opacity: 0;
}

/* 欢迎页 textarea 最大高度比面板模式矮，避免把 logo 和卡片都撑出屏幕。
   曾给过 56px 最小高度（当时下半屏是空的，输入框是唯一主体）；卡片恢复后
   撤掉——加高会让输入框比卡片还高，成为整屏最高的单个元素，比例就反了。
   它该是一条清瘦的横条，让卡片比它高。 */
.welcome-chat-composer :deep(.ai-input textarea) {
  max-height: 160px;
}

@keyframes welcomeComposerEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}


.welcome-image-preview {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.75);
}

.welcome-image-preview-close {
  position: absolute;
  top: 16px;
  right: 20px;
  border: none;
  background: transparent;
  color: white;
  font-size: 28px;
  cursor: pointer;
  line-height: 1;
}

.welcome-image-preview-img {
  max-width: min(90vw, 960px);
  max-height: 85vh;
  object-fit: contain;
  border-radius: 8px;
}

.free-mode-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}

.free-mode-confirm-dialog {
  width: 100%;
  max-width: 400px;
  padding: 20px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.confirm-dialog-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}

.confirm-dialog-icon {
  font-size: 24px;
}

.confirm-dialog-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--brand-alert);
}

.confirm-dialog-content {
  margin-bottom: 20px;
}

.confirm-dialog-content p {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.confirm-dialog-warnings {
  margin: 12px 0;
  padding-left: 20px;
}

.confirm-dialog-warnings li {
  margin: 6px 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--brand-alert);
}

.confirm-dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
}
</style>
