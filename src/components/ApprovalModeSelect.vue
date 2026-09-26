<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown } from 'lucide-vue-next'

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
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLDivElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

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

const closeMenu = () => {
  isOpen.value = false
}

const openMenu = async () => {
  isOpen.value = true
  await nextTick()
  requestAnimationFrame(updateMenuPosition)
}

const toggleMenu = () => {
  if (isOpen.value) closeMenu()
  else void openMenu()
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
}

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
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

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('keydown', handleDocumentKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', updateMenuPosition)
  window.removeEventListener('scroll', updateMenuPosition, true)
})
</script>

<template>
  <div class="approval-mode-select" :class="{ open: isOpen }">
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
            <span class="approval-mode-item-title">
              <span class="approval-mode-item-label">{{ t(`ai.approvalMode.${state}.label`) }}</span>
              <span v-if="state === 'autoReview'" class="approval-mode-recommended">{{ t('ai.askingRecommended') }}</span>
            </span>
            <span class="approval-mode-item-desc">{{ t(`ai.approvalMode.${state}.desc`) }}</span>
          </span>
        </button>
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
  height: var(--workbench-header-select-height, 22px);
  padding: 2px 6px;
  font-size: var(--workbench-header-select-font-size, 12px);
  font-weight: 500;
  font-family: inherit;
  line-height: 1;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.approval-mode-trigger:hover,
.approval-mode-select.open .approval-mode-trigger {
  color: var(--text-primary);
  background: var(--bg-surface);
}

.approval-mode-trigger.state-free {
  color: var(--brand-alert);
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

.approval-mode-item-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.approval-mode-item-label {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.35;
}

.approval-mode-recommended {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent-primary);
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
</style>
