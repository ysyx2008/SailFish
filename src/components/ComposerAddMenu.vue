<script setup lang="ts">
/**
 * 输入框加号的小菜单：往这场对话里放东西的入口都收在这里（添加文件、添加技能）。
 * 设计目标见 AIPANEL_SPEC「输入框底部只留一个加号」。
 *
 * 加号按钮本身留在输入框里（沿用输入框那一排按钮的样式），这里只管弹出的菜单。
 * 菜单项按下时不抢输入框的焦点（mousedown.prevent）：「添加文件」的胶囊要落在光标处，
 * 焦点一旦离开输入框，光标位置就不可靠了。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Paperclip, Sparkles } from 'lucide-vue-next'

const props = defineProps<{
  open: boolean
  /** 加号按钮：菜单贴着它弹出（左边对齐，开在它正上方，上方放不下才开下方）；点它自己由父级处理，不算「点了外面」 */
  anchor: HTMLElement | null
  /** 用键盘打开时，焦点落到第一项，方便上下键选 */
  focusFirst?: boolean
}>()

const emit = defineEmits<{
  close: []
  attach: []
  skill: []
}>()

const { t } = useI18n()

const GAP = 6
const EDGE = 8

const menuEl = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({ visibility: 'hidden' })

function placeMenu() {
  const anchor = props.anchor
  const menu = menuEl.value
  if (!anchor || !menu) return
  const rect = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  const height = menu.offsetHeight
  const spaceAbove = rect.top - GAP - EDGE
  const spaceBelow = window.innerHeight - rect.bottom - GAP - EDGE
  const placeBelow = height > spaceAbove && spaceBelow > spaceAbove
  const wantTop = placeBelow ? rect.bottom + GAP : rect.top - GAP - height
  // 窗口太矮、两边都放不下时，宁可压住加号，也不能让菜单跑出窗口、点不到
  const top = Math.max(EDGE, Math.min(wantTop, window.innerHeight - EDGE - height))
  const left = Math.min(Math.max(EDGE, rect.left), Math.max(EDGE, window.innerWidth - width - EDGE))
  menuStyle.value = {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
  }
}

function menuItems(): HTMLElement[] {
  return Array.from(menuEl.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
}

function onMenuKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  const items = menuItems()
  if (items.length === 0) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLElement)
  const next = event.key === 'ArrowDown'
    ? (current + 1) % items.length
    : (current <= 0 ? items.length - 1 : current - 1)
  items[next].focus()
}

function isModifierKey(event: KeyboardEvent): boolean {
  return event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta'
}

function onDocumentMouseDown(event: MouseEvent) {
  const target = event.target as Node | null
  if (target && (menuEl.value?.contains(target) || props.anchor?.contains(target))) return
  emit('close')
}

/** 焦点从菜单里走到了菜单和加号之外（比如按 Tab）：菜单让开 */
function onMenuFocusOut(event: FocusEvent) {
  const next = event.relatedTarget as Node | null
  if (next && (menuEl.value?.contains(next) || props.anchor?.contains(next))) return
  emit('close')
}

function onDocumentKeydown(event: KeyboardEvent) {
  const focusInMenu = menuEl.value?.contains(document.activeElement) ?? false
  if (event.key === 'Escape') {
    // 只关菜单，不让这一下 Esc 再被输入框当成别的意思
    event.preventDefault()
    event.stopPropagation()
    emit('close')
    return
  }
  // 键盘打开时，回车/空格落在加号上：那一下是在「打开」，不是在「关」
  const target = event.target as Node | null
  if (target && props.anchor?.contains(target)) return
  // 焦点还在输入框里、用户接着打字：菜单让开
  if (!focusInMenu && !isModifierKey(event)) emit('close')
}

function bindListeners() {
  document.addEventListener('mousedown', onDocumentMouseDown, true)
  document.addEventListener('keydown', onDocumentKeydown, true)
  window.addEventListener('resize', placeMenu)
  window.addEventListener('scroll', placeMenu, true)
}

function unbindListeners() {
  document.removeEventListener('mousedown', onDocumentMouseDown, true)
  document.removeEventListener('keydown', onDocumentKeydown, true)
  window.removeEventListener('resize', placeMenu)
  window.removeEventListener('scroll', placeMenu, true)
}

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen) {
      unbindListeners()
      // 收起时焦点还在菜单里（键盘打开的）：菜单项马上卸载，把焦点还给加号，免得掉到页面上
      if (menuEl.value?.contains(document.activeElement)) props.anchor?.focus()
      return
    }
    // 先隐藏着渲染出来量尺寸，再摆到位，免得闪一下
    menuStyle.value = { visibility: 'hidden' }
    bindListeners()
    await nextTick()
    placeMenu()
    if (props.focusFirst) {
      // 位置摆好、菜单显示出来之后才聚焦：还隐藏着的元素聚焦不上
      await nextTick()
      menuItems()[0]?.focus()
    }
  },
  { immediate: true }
)

onBeforeUnmount(unbindListeners)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="composer-add-menu"
      role="menu"
      :aria-label="t('ai.addMenu')"
      :style="menuStyle"
      @keydown="onMenuKeydown"
      @focusout="onMenuFocusOut"
    >
      <button
        type="button"
        role="menuitem"
        class="composer-add-item"
        @mousedown.prevent
        @click="emit('attach')"
      >
        <Paperclip :size="14" :stroke-width="1.75" />
        <span>{{ t('ai.attach') }}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        class="composer-add-item"
        @mousedown.prevent
        @click="emit('skill')"
      >
        <Sparkles :size="14" :stroke-width="1.75" />
        <span>{{ t('ai.conversationSkillAdd') }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.composer-add-menu {
  position: fixed;
  min-width: 176px;
  padding: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  z-index: 10000;
}

.composer-add-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13.5px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.composer-add-item svg {
  flex-shrink: 0;
  color: var(--text-muted);
}

/* 悬停和键盘选中同一个样子，与技能列表的选中色一致 */
.composer-add-item:hover,
.composer-add-item:focus-visible {
  background: rgba(var(--accent-rgb), 0.12);
  outline: none;
}

.composer-add-item:hover svg,
.composer-add-item:focus-visible svg {
  color: var(--accent-primary);
}
</style>
