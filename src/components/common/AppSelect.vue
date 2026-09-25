<script lang="ts">
let closeCurrent: (() => void) | null = null
</script>

<script setup lang="ts">
/**
 * 页面内下拉。不用系统 select：Windows 上菜单超出窗口下沿会画成黑块，点不中。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

export interface AppSelectOption {
  value: string
  label: string
  group?: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: ReadonlyArray<AppSelectOption>
    disabled?: boolean
    /** 撑满可用宽度 */
    block?: boolean
    /** field：表单里和输入框同高；compact：设置行右侧较窄 */
    size?: 'field' | 'compact'
  }>(),
  { disabled: false, block: false, size: 'compact' }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const isOpen = ref(false)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuRef = ref<HTMLDivElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

const currentLabel = computed(() => {
  const found = props.options.find(opt => opt.value === props.modelValue)
  return found?.label ?? props.modelValue
})

const placeMenu = () => {
  const trigger = triggerRef.value
  const menu = menuRef.value
  if (!trigger || !menu) return
  const rect = trigger.getBoundingClientRect()
  const menuHeight = menu.offsetHeight
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const spaceAbove = rect.top - 8
  const openUp = spaceBelow < menuHeight && spaceAbove > spaceBelow
  const maxHeight = Math.max(120, Math.min(280, openUp ? spaceAbove : spaceBelow))
  const top = openUp
    ? Math.max(8, rect.top - Math.min(menuHeight, maxHeight) - 4)
    : rect.bottom + 4
  const width = Math.max(rect.width, props.size === 'compact' ? 120 : rect.width)
  menuStyle.value = {
    top: `${top}px`,
    left: `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`,
    width: `${width}px`,
    maxHeight: `${maxHeight}px`,
  }
}

const closeMenu = () => {
  isOpen.value = false
  if (closeCurrent === closeMenu) closeCurrent = null
}

const openMenu = async () => {
  if (props.disabled) return
  if (closeCurrent && closeCurrent !== closeMenu) closeCurrent()
  closeCurrent = closeMenu
  isOpen.value = true
  await nextTick()
  requestAnimationFrame(placeMenu)
}

const toggleMenu = () => {
  if (isOpen.value) closeMenu()
  else void openMenu()
}

const pick = (value: string) => {
  if (value !== props.modelValue) emit('update:modelValue', value)
  closeMenu()
}

const showGroup = (opt: AppSelectOption, index: number) => {
  if (!opt.group) return false
  return index === 0 || props.options[index - 1]?.group !== opt.group
}

const onPointerDown = (event: MouseEvent) => {
  if (!isOpen.value) return
  const target = event.target as Node | null
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return
  closeMenu()
}

const onKeydown = (event: KeyboardEvent) => {
  if (!isOpen.value || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeMenu()
}

watch(isOpen, (open) => {
  if (open) {
    window.addEventListener('resize', placeMenu)
    window.addEventListener('scroll', placeMenu, true)
    return
  }
  window.removeEventListener('resize', placeMenu)
  window.removeEventListener('scroll', placeMenu, true)
})

watch(() => props.disabled, (disabled) => {
  if (disabled) closeMenu()
})

window.addEventListener('mousedown', onPointerDown, true)
window.addEventListener('keydown', onKeydown, true)

onUnmounted(() => {
  closeMenu()
  window.removeEventListener('mousedown', onPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  window.removeEventListener('resize', placeMenu)
  window.removeEventListener('scroll', placeMenu, true)
})
</script>

<template>
  <div class="app-select" :class="[size, { block, open: isOpen, disabled }]">
    <button
      ref="triggerRef"
      type="button"
      class="app-select-trigger"
      :disabled="disabled"
      :aria-expanded="isOpen"
      aria-haspopup="listbox"
      @click.stop="toggleMenu"
    >
      <span class="app-select-label">{{ currentLabel }}</span>
      <ChevronDown :size="14" class="app-select-chevron" />
    </button>
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="menuRef"
        class="app-select-menu"
        :style="menuStyle"
        role="listbox"
        @mousedown.stop
      >
        <template v-for="(opt, index) in options" :key="`${opt.group || ''}:${opt.value}`">
          <div v-if="showGroup(opt, index)" class="app-select-group">{{ opt.group }}</div>
          <button
            type="button"
            class="app-select-option"
            role="option"
            :aria-selected="opt.value === modelValue"
            :class="{ active: opt.value === modelValue }"
            @click="pick(opt.value)"
          >
            {{ opt.label }}
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app-select.block {
  width: 100%;
}

.app-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-width: 120px;
  padding: var(--sp-1) var(--sp-2);
  font-family: inherit;
  font-size: var(--fs-desc);
  color: var(--text-primary);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  outline: none;
  text-align: left;
}

.app-select.field .app-select-trigger {
  padding: 8px 12px;
  font-size: 14px;
  border-radius: var(--border-radius);
}

.app-select.block .app-select-trigger {
  min-width: 0;
}

.app-select-trigger:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent-primary) 50%, var(--border-color));
}

.app-select-trigger:focus-visible {
  outline: 2px solid var(--accent-primary);
  outline-offset: 1px;
}

.app-select-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.app-select-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-select-chevron {
  flex-shrink: 0;
  opacity: 0.7;
}

.app-select.open .app-select-chevron {
  transform: rotate(180deg);
}

.app-select-menu {
  position: fixed;
  z-index: 20000;
  overflow-y: auto;
  padding: 4px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
}

.app-select-group {
  padding: 6px 10px 2px;
  font-size: 11px;
  color: var(--text-muted);
}

.app-select-option {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.app-select-option:hover {
  background: var(--bg-hover);
}

.app-select-option.active {
  color: var(--accent-primary);
}
</style>
