<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, HelpCircle } from 'lucide-vue-next'
import type { ConfirmDialogOptions } from '../../composables/useConfirm'

const { t } = useI18n()

const props = withDefaults(defineProps<{
  show: boolean
  options: ConfirmDialogOptions
}>(), {
  show: false
})

const emit = defineEmits<{
  confirm: []
  cancel: []
  neutral: []
  close: []
}>()

const dialogRef = ref<HTMLDivElement | null>(null)
const confirmBtnRef = ref<HTMLButtonElement | null>(null)
const typedInputRef = ref<HTMLInputElement | null>(null)
const typedValue = ref('')

const typedPhrase = computed(() => props.options.typedPhrase?.trim() || '')
const canConfirm = computed(() => !typedPhrase.value || typedValue.value.trim() === typedPhrase.value)

const handleConfirm = () => {
  if (!canConfirm.value) return
  emit('confirm')
  emit('close')
}

const handleCancel = () => {
  emit('cancel')
  emit('close')
}

const handleNeutral = () => {
  emit('neutral')
  emit('close')
}

const handleKeydown = (e: KeyboardEvent) => {
  if (!props.show) return

  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopImmediatePropagation()
    handleCancel()
  } else if (e.key === 'Enter') {
    const focused = document.activeElement
    if (focused instanceof HTMLButtonElement && dialogRef.value?.contains(focused)) {
      return
    }
    if (!canConfirm.value) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    handleConfirm()
  }
}

watch(() => props.show, async (show) => {
  if (show) {
    typedValue.value = ''
    await nextTick()
    if (typedPhrase.value) {
      typedInputRef.value?.focus()
    } else {
      confirmBtnRef.value?.focus()
    }
  } else {
    typedValue.value = ''
  }
})

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

const dialogType = computed(() => props.options.type || 'default')

const confirmBtnClass = computed(() => {
  switch (dialogType.value) {
    case 'danger':
      return 'btn-danger'
    case 'warning':
      return 'btn-warning'
    default:
      return 'btn-primary'
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="show" class="confirm-overlay" @click.self="handleCancel">
        <Transition name="scale">
          <div
            v-if="show"
            ref="dialogRef"
            class="confirm-dialog"
            :class="{ 'has-neutral': !!options.neutralText, 'has-typed': !!typedPhrase }"
          >
            <div class="dialog-header">
              <div class="dialog-header-title">
                <span class="header-icon" :class="dialogType">
                  <AlertTriangle v-if="dialogType === 'danger' || dialogType === 'warning'" :size="18" />
                  <HelpCircle v-else :size="16" />
                </span>
                <h3 class="dialog-title">{{ options.title }}</h3>
              </div>
            </div>

            <div class="dialog-body">
              <p class="dialog-message">{{ options.message }}</p>

              <div v-if="options.fileInfo" class="file-info">
                <div v-if="options.fileInfo.name" class="file-info-item">
                  <span class="label">{{ t('common.name') }}</span>
                  <span class="value" :title="options.fileInfo.name">{{ options.fileInfo.name }}</span>
                </div>
                <div v-if="options.fileInfo.type" class="file-info-item">
                  <span class="label">{{ t('common.type') }}</span>
                  <span class="value">{{ options.fileInfo.type }}</span>
                </div>
                <div v-if="options.fileInfo.size" class="file-info-item">
                  <span class="label">{{ t('common.size') }}</span>
                  <span class="value">{{ options.fileInfo.size }}</span>
                </div>
                <div v-if="options.fileInfo.count" class="file-info-item">
                  <span class="label">{{ t('common.count') }}</span>
                  <span class="value">{{ options.fileInfo.count }} {{ t('common.items') }}</span>
                </div>
              </div>

              <p v-if="options.detail" class="dialog-detail">{{ options.detail }}</p>

              <label v-if="typedPhrase" class="typed-confirm">
                <span>{{ t('common.typeToConfirm', { phrase: typedPhrase }) }}</span>
                <input
                  ref="typedInputRef"
                  v-model="typedValue"
                  type="text"
                  class="typed-confirm-input"
                  :placeholder="typedPhrase"
                  autocomplete="off"
                  spellcheck="false"
                />
              </label>
            </div>

            <div class="dialog-footer">
              <button
                v-if="options.showCancel !== false"
                type="button"
                class="btn"
                @click="handleCancel"
              >
                {{ options.cancelText || t('common.cancel') }}
              </button>
              <button
                v-if="options.neutralText"
                type="button"
                class="btn btn-neutral"
                @click="handleNeutral"
              >
                {{ options.neutralText }}
              </button>
              <button
                ref="confirmBtnRef"
                type="button"
                class="btn"
                :class="confirmBtnClass"
                data-testid="confirm-ok"
                :disabled="!canConfirm"
                @click="handleConfirm"
              >
                {{ options.confirmText || t('common.confirm') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 必须高于挂到 body 的二级窗（API 配置 / 插件安装 / 历史查看器等都是 10000） */
  z-index: 200000;
}

.confirm-dialog {
  width: 360px;
  max-width: 90vw;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.confirm-dialog.has-neutral,
.confirm-dialog.has-typed {
  width: 420px;
}

.dialog-header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
}

.dialog-header-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.header-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.header-icon.default,
.header-icon.info {
  color: var(--accent-primary);
}

.header-icon.warning {
  color: var(--color-warning);
}

.header-icon.danger {
  color: var(--color-error);
}

.dialog-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.3;
}

.dialog-body {
  padding: 16px 18px;
}

.dialog-message {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.55;
  white-space: pre-wrap;
}

.file-info {
  margin-top: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 10px 12px;
}

.file-info-item {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
  font-size: 12px;
}

.file-info-item .label {
  color: var(--text-muted);
  flex-shrink: 0;
}

.file-info-item .value {
  color: var(--text-primary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dialog-detail {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.typed-confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-secondary);
}

.typed-confirm-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
}

.typed-confirm-input:focus {
  outline: none;
  border-color: var(--color-error);
}

.dialog-footer .btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--border-color);
}

.dialog-footer .btn {
  flex: 0 0 auto;
  min-width: 72px;
  padding: 7px 14px;
  font-size: 13px;
}

.dialog-footer .btn-neutral {
  color: var(--accent-primary);
  border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-color));
  background: transparent;
}

.dialog-footer .btn-neutral:hover {
  background: rgba(var(--accent-rgb), 0.08);
  border-color: var(--accent-primary);
}

.dialog-footer .btn-danger {
  color: var(--color-error);
  border-color: rgba(var(--color-error-rgb), 0.45);
  background: transparent;
}

.dialog-footer .btn-danger:hover {
  background: rgba(var(--color-error-rgb), 0.1);
  border-color: var(--color-error);
}

.dialog-footer .btn-warning {
  color: var(--color-warning);
  border-color: rgba(var(--color-warning-rgb), 0.45);
  background: transparent;
}

.dialog-footer .btn-warning:hover {
  background: rgba(var(--color-warning-rgb), 0.1);
  border-color: var(--color-warning);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}

.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.97);
}
</style>
