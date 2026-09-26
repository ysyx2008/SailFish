<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown } from 'lucide-vue-next'
import type { AiProfile } from '@shared/types'

const props = withDefaults(
  defineProps<{
    profiles: AiProfile[]
    modelValue: string
    disabled?: boolean
    /** 嵌入 composer 底栏的紧凑样式 */
    compact?: boolean
    /** 欢迎页 composer 样式 */
    embedded?: boolean
  }>(),
  {
    disabled: false,
    compact: false,
    embedded: false,
  }
)

const emit = defineEmits<{
  'update:modelValue': [profileId: string]
}>()

const { t } = useI18n()

const isOpen = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLDivElement | null>(null)
const activeItemRef = ref<HTMLButtonElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const openUpward = ref(true)

const activeProfile = computed(
  () => props.profiles.find(p => p.id === props.modelValue) ?? props.profiles[0] ?? null
)

const formatProfileLabel = (profile: AiProfile): string => {
  const vision =
    profile.modelType === 'vision' ? ` [${t('aiSettings.modelTypeVision')}]` : ''
  return `${profile.name} (${profile.model})${vision}`
}

const triggerLabel = computed(() => {
  if (!activeProfile.value) return t('ai.switchModel')
  if (props.embedded) return activeProfile.value.name
  return formatProfileLabel(activeProfile.value)
})

const triggerTitle = computed(() => {
  if (!activeProfile.value) return t('ai.switchModel')
  return formatProfileLabel(activeProfile.value)
})

const updateMenuPosition = () => {
  const trigger = triggerRef.value
  const menu = menuRef.value
  if (!trigger || !menu) return

  const rect = trigger.getBoundingClientRect()
  const menuHeight = menu.offsetHeight
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  const shouldOpenUp = spaceBelow < menuHeight && spaceAbove > spaceBelow
  openUpward.value = shouldOpenUp

  const maxHeight = Math.max(120, Math.min(320, shouldOpenUp ? spaceAbove : spaceBelow))
  const top = shouldOpenUp
    ? Math.max(8, rect.top - Math.min(menuHeight, maxHeight) - 4)
    : rect.bottom + 4

  menuStyle.value = {
    top: `${top}px`,
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`,
    minWidth: `${Math.max(rect.width, 220)}px`,
    maxHeight: `${maxHeight}px`,
  }
}

const scrollActiveIntoView = () => {
  activeItemRef.value?.scrollIntoView({ block: 'nearest' })
}

const bindActiveItemRef = (el: unknown, profileId: string) => {
  if (profileId === props.modelValue && el instanceof HTMLButtonElement) {
    activeItemRef.value = el
  }
}

const openMenu = async () => {
  if (props.disabled || props.profiles.length === 0) return
  isOpen.value = true
  await nextTick()
  requestAnimationFrame(() => {
    updateMenuPosition()
    scrollActiveIntoView()
  })
}

const closeMenu = () => {
  isOpen.value = false
}

const toggleMenu = () => {
  if (isOpen.value) closeMenu()
  else void openMenu()
}

const selectProfile = (profileId: string) => {
  if (props.disabled) return
  if (profileId !== props.modelValue) {
    emit('update:modelValue', profileId)
  }
  closeMenu()
}

watch(() => props.disabled, (disabled) => {
  if (disabled) closeMenu()
})

const handleDocumentClick = (event: MouseEvent) => {
  if (!isOpen.value) return
  const target = event.target as Node
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return
  closeMenu()
}

const handleDocumentKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && isOpen.value) {
    event.preventDefault()
    closeMenu()
  }
}

watch(isOpen, (open) => {
  if (!open) return
  window.addEventListener('resize', updateMenuPosition)
  window.addEventListener('scroll', updateMenuPosition, true)
})

watch(isOpen, (open) => {
  if (open) return
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
  <div
    class="ai-profile-select"
    :class="{ compact, embedded, open: isOpen, disabled }"
  >
    <button
      ref="triggerRef"
      type="button"
      class="ai-profile-select-trigger"
      :disabled="disabled || profiles.length === 0"
      :title="triggerTitle"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      @click.stop="toggleMenu"
    >
      <span class="ai-profile-select-label">{{ triggerLabel }}</span>
      <ChevronDown :size="compact || embedded ? 12 : 14" class="ai-profile-select-chevron" />
    </button>

    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="menuRef"
        class="ai-profile-select-menu"
        :class="{ upward: openUpward }"
        :style="menuStyle"
        role="listbox"
        :aria-label="t('ai.switchModel')"
        @click.stop
      >
        <button
          v-for="profile in profiles"
          :key="profile.id"
          :ref="(el) => bindActiveItemRef(el, profile.id)"
          type="button"
          class="ai-profile-select-item"
          :class="{ active: profile.id === modelValue }"
          role="option"
          :aria-selected="profile.id === modelValue"
          @click="selectProfile(profile.id)"
        >
          <Check v-if="profile.id === modelValue" :size="14" class="ai-profile-select-check" />
          <span v-else class="ai-profile-select-check-placeholder" aria-hidden="true" />
          <span class="ai-profile-select-item-label">{{ formatProfileLabel(profile) }}</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ai-profile-select {
  position: relative;
  min-width: 0;
}

.ai-profile-select-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 4px 6px;
  font-size: 11px;
  font-family: inherit;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease, color 0.15s ease;
}

.ai-profile-select.compact .ai-profile-select-trigger,
.ai-profile-select.embedded .ai-profile-select-trigger {
  padding: 2px 6px;
  font-size: 12px;
}

.ai-profile-select-trigger:hover:not(:disabled) {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.ai-profile-select.open .ai-profile-select-trigger {
  background: var(--bg-surface);
  color: var(--text-primary);
}

.ai-profile-select-trigger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ai-profile-select-label {
  min-width: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-profile-select.embedded .ai-profile-select-label {
  max-width: 112px;
}

.ai-profile-select-chevron {
  flex-shrink: 0;
  opacity: 0.7;
  transition: transform 0.15s ease;
}

.ai-profile-select.open .ai-profile-select-chevron {
  transform: rotate(180deg);
}

.ai-profile-select-menu {
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

.ai-profile-select-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  color: var(--text-primary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.ai-profile-select-item:hover {
  background: var(--bg-surface);
}

.ai-profile-select-item.active {
  background: color-mix(in srgb, var(--accent-primary) 14%, transparent);
  color: var(--accent-primary);
}

.ai-profile-select-check,
.ai-profile-select-check-placeholder {
  flex-shrink: 0;
  width: 14px;
}

.ai-profile-select-item-label {
  min-width: 0;
  line-height: 1.35;
}
</style>
