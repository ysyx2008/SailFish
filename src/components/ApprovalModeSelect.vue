<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, HelpCircle, X } from 'lucide-vue-next'

type ApprovalUiState = 'strict' | 'relaxed' | 'autoReview' | 'free'

const STATES: ApprovalUiState[] = ['strict', 'relaxed', 'autoReview', 'free']

const props = defineProps<{
  modelValue: ApprovalUiState
}>()

const emit = defineEmits<{
  'update:modelValue': [state: ApprovalUiState]
}>()

const { t } = useI18n()

const isOpen = ref(false)
const tipOpen = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const tipTriggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLDivElement | null>(null)
const tipRef = ref<HTMLDivElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const tipStyle = ref<Record<string, string>>({})

const triggerLabel = computed(() => t(`ai.approvalMode.${props.modelValue}.label`))
const triggerTitle = computed(() => t(`ai.approvalMode.${props.modelValue}.desc`))

const placePanel = (
  trigger: HTMLElement,
  panel: HTMLElement,
  minWidth: number,
): Record<string, string> => {
  const rect = trigger.getBoundingClientRect()
  const panelHeight = panel.offsetHeight
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const maxHeight = Math.max(160, Math.min(420, spaceBelow))
  const style: Record<string, string> = {
    top: `${rect.bottom + 4}px`,
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - panel.offsetWidth - 8))}px`,
    minWidth: `${Math.max(rect.width, minWidth)}px`,
    maxHeight: `${maxHeight}px`,
  }

  if (panelHeight > spaceBelow && rect.top > spaceBelow) {
    const above = Math.max(160, rect.top - 8)
    style.top = `${Math.max(8, rect.top - Math.min(panelHeight, above) - 4)}px`
    style.maxHeight = `${above}px`
  }
  return style
}

const updateMenuPosition = () => {
  const trigger = triggerRef.value
  const menu = menuRef.value
  if (!trigger || !menu) return
  menuStyle.value = placePanel(trigger, menu, 260)
}

const updateTipPosition = () => {
  const trigger = tipTriggerRef.value ?? triggerRef.value
  const tip = tipRef.value
  if (!trigger || !tip) return
  tipStyle.value = placePanel(trigger, tip, 300)
}

const closeMenu = () => {
  isOpen.value = false
}

const closeTip = () => {
  tipOpen.value = false
}

const openMenu = async () => {
  closeTip()
  isOpen.value = true
  await nextTick()
  requestAnimationFrame(updateMenuPosition)
}

const openTip = async () => {
  closeMenu()
  tipOpen.value = true
  await nextTick()
  requestAnimationFrame(updateTipPosition)
}

const toggleMenu = () => {
  if (isOpen.value) closeMenu()
  else void openMenu()
}

const toggleTip = () => {
  if (tipOpen.value) closeTip()
  else void openTip()
}

const selectState = (state: ApprovalUiState) => {
  if (state !== props.modelValue) {
    emit('update:modelValue', state)
  }
  closeMenu()
}

const handleDocumentClick = (event: MouseEvent) => {
  const target = event.target as Node
  if (isOpen.value) {
    if (!triggerRef.value?.contains(target) && !menuRef.value?.contains(target)) {
      closeMenu()
    }
  }
  if (tipOpen.value) {
    if (!tipTriggerRef.value?.contains(target) && !tipRef.value?.contains(target)) {
      closeTip()
    }
  }
}

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  if (tipOpen.value) {
    event.preventDefault()
    closeTip()
    return
  }
  if (isOpen.value) {
    event.preventDefault()
    closeMenu()
  }
}

watch(isOpen, (open) => {
  if (open) {
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return
  }
  window.removeEventListener('resize', updateMenuPosition)
  window.removeEventListener('scroll', updateMenuPosition, true)
})

watch(tipOpen, (open) => {
  if (open) {
    window.addEventListener('resize', updateTipPosition)
    window.addEventListener('scroll', updateTipPosition, true)
    return
  }
  window.removeEventListener('resize', updateTipPosition)
  window.removeEventListener('scroll', updateTipPosition, true)
})

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('keydown', handleDocumentKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', updateMenuPosition)
  window.removeEventListener('scroll', updateMenuPosition, true)
  window.removeEventListener('resize', updateTipPosition)
  window.removeEventListener('scroll', updateTipPosition, true)
})
</script>

<template>
  <div class="approval-mode-select" :class="{ open: isOpen, 'tip-open': tipOpen }">
    <button
      ref="triggerRef"
      type="button"
      class="approval-mode-trigger"
      :class="`state-${modelValue}`"
      :title="triggerTitle"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      :aria-label="t('ai.approvalMode.menuLabel')"
      @click.stop="toggleMenu"
    >
      <span class="approval-mode-label">{{ triggerLabel }}</span>
      <ChevronDown :size="12" class="approval-mode-chevron" />
    </button>
    <button
      ref="tipTriggerRef"
      type="button"
      class="approval-mode-help"
      :class="{ open: tipOpen }"
      :aria-expanded="tipOpen"
      :aria-label="t('ai.approvalMode.tipAria')"
      :title="t('ai.approvalMode.tipAria')"
      @click.stop="toggleTip"
    >
      <HelpCircle :size="13" />
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="menuRef"
        class="approval-mode-menu"
        :style="menuStyle"
        role="listbox"
        :aria-label="t('ai.approvalMode.menuLabel')"
        @click.stop
      >
        <p class="approval-mode-intro">{{ t('ai.approvalMode.tipIntro') }}</p>
        <button
          v-for="state in STATES"
          :key="state"
          type="button"
          class="approval-mode-item"
          :class="[`state-${state}`, { active: state === modelValue }]"
          role="option"
          :aria-selected="state === modelValue"
          @click="selectState(state)"
        >
          <Check v-if="state === modelValue" :size="14" class="approval-mode-check" />
          <span v-else class="approval-mode-check-placeholder" aria-hidden="true" />
          <span class="approval-mode-item-text">
            <span class="approval-mode-item-label">{{ t(`ai.approvalMode.${state}.label`) }}</span>
            <span class="approval-mode-item-desc">{{ t(`ai.approvalMode.${state}.desc`) }}</span>
          </span>
        </button>
      </div>
    </Teleport>

    <Teleport to="body">
      <div
        v-if="tipOpen"
        ref="tipRef"
        class="approval-mode-tip"
        :style="tipStyle"
        role="dialog"
        :aria-label="t('ai.approvalMode.tipTitle')"
        @click.stop
      >
        <header class="approval-mode-tip-head">
          <span class="approval-mode-tip-title">{{ t('ai.approvalMode.tipTitle') }}</span>
          <button type="button" class="approval-mode-tip-close" :aria-label="t('common.close')" @click="closeTip">
            <X :size="14" />
          </button>
        </header>
        <div class="approval-mode-tip-body">
          <p>{{ t('ai.approvalMode.tipIntro') }}</p>
          <dl>
            <div v-for="state in STATES" :key="state" class="approval-mode-tip-row">
              <dt>{{ t(`ai.approvalMode.${state}.label`) }}</dt>
              <dd>{{ t(`ai.approvalMode.${state}.tip`) }}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.approval-mode-select {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.approval-mode-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 500;
  font-family: inherit;
  line-height: 1;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
}

.approval-mode-trigger:hover,
.approval-mode-select.open .approval-mode-trigger {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.approval-mode-trigger.state-strict {
  color: var(--brand-vital);
  border-color: color-mix(in srgb, var(--brand-vital) 45%, var(--border-color));
  background: color-mix(in srgb, var(--brand-vital) 12%, var(--bg-tertiary));
}

.approval-mode-trigger.state-autoReview {
  color: var(--accent-primary);
  border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-color));
  background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-tertiary));
}

.approval-mode-trigger.state-free {
  color: var(--brand-alert);
  border-color: color-mix(in srgb, var(--brand-alert) 45%, var(--border-color));
  background: color-mix(in srgb, var(--brand-alert) 12%, var(--bg-tertiary));
}

.approval-mode-label {
  min-width: 0;
}

.approval-mode-chevron {
  flex-shrink: 0;
  opacity: 0.7;
  transition: transform 0.15s ease;
}

.approval-mode-select.open .approval-mode-chevron {
  transform: rotate(180deg);
}

.approval-mode-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 999px;
  cursor: pointer;
}

.approval-mode-help:hover,
.approval-mode-help.open {
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
}
</style>

<style>
.approval-mode-menu {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}

.approval-mode-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  font-family: inherit;
  text-align: left;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
}

.approval-mode-item:hover {
  background: var(--bg-surface);
}

.approval-mode-item.active {
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
}

.approval-mode-item.active.state-strict {
  background: color-mix(in srgb, var(--brand-vital) 14%, transparent);
}

.approval-mode-item.active.state-free {
  background: color-mix(in srgb, var(--brand-alert) 14%, transparent);
}

.approval-mode-check,
.approval-mode-check-placeholder {
  flex-shrink: 0;
  width: 14px;
  margin-top: 2px;
}

.approval-mode-item.active .approval-mode-check {
  color: var(--accent-primary);
}

.approval-mode-item.active.state-strict .approval-mode-check {
  color: var(--brand-vital);
}

.approval-mode-item.active.state-free .approval-mode-check {
  color: var(--brand-alert);
}

.approval-mode-item-text {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.approval-mode-item-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
}

.approval-mode-item-desc {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-secondary);
  white-space: normal;
}

.approval-mode-intro {
  margin: 0;
  padding: 8px 10px 6px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-secondary);
}

.approval-mode-tip {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}

.approval-mode-tip-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-color);
}

.approval-mode-tip-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.approval-mode-tip-close {
  display: inline-flex;
  padding: 2px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.approval-mode-tip-close:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.approval-mode-tip-body {
  padding: 12px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-secondary);
}

.approval-mode-tip-body p {
  margin: 0 0 10px;
}

.approval-mode-tip-body dl {
  margin: 0;
}

.approval-mode-tip-row + .approval-mode-tip-row {
  margin-top: 10px;
}

.approval-mode-tip-row dt {
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.approval-mode-tip-row dd {
  margin: 0;
}
</style>
