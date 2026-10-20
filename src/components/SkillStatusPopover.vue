<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Sparkles, Settings } from 'lucide-vue-next'
import { useBuiltinSkillText } from '../composables/useBuiltinSkillText'
import { sortSkillsByName } from '@sailfish/shared-types'

interface SkillItem {
  id: string
  name: string
  description: string
  enabled: boolean
  kind: 'builtin' | 'user'
}

const emit = defineEmits<{
  openSettings: []
}>()

const { t } = useI18n()
const { builtinSkillName, builtinSkillDescription } = useBuiltinSkillText()

const showPopover = ref(false)
const popoverRef = ref<HTMLElement | null>(null)
const buttonRef = ref<HTMLElement | null>(null)
const popoverStyle = ref<Record<string, string>>({})
const searchQuery = ref('')
const togglingIds = ref(new Set<string>())

const builtinSkills = ref<SkillItem[]>([])
const userSkills = ref<SkillItem[]>([])

const allSkills = computed(() => [...builtinSkills.value, ...userSkills.value])
const enabledCount = computed(() => allSkills.value.filter(s => s.enabled).length)
const totalCount = computed(() => allSkills.value.length)

const statusClass = computed(() =>
  enabledCount.value > 0 ? 'status-all' : 'status-none'
)

const statusIcon = computed(() => (enabledCount.value > 0 ? '●' : '○'))

const statusTooltip = computed(() => {
  if (totalCount.value === 0) return t('skills.none')
  return t('skills.loaded', { enabled: enabledCount.value, total: totalCount.value })
})

function localizedName(skill: SkillItem): string {
  return skill.kind === 'builtin' ? builtinSkillName(skill) : skill.name
}

function localizedDetail(skill: SkillItem): string {
  return skill.kind === 'builtin' ? builtinSkillDescription(skill) : skill.description
}

const query = computed(() => searchQuery.value.trim().toLowerCase())

function matches(skill: SkillItem): boolean {
  if (!query.value) return true
  return localizedName(skill).toLowerCase().includes(query.value)
    || skill.id.toLowerCase().includes(query.value)
}

// 两组各按眼前看到的名字拼音排
const visibleBuiltin = computed(() => sortSkillsByName(builtinSkills.value.filter(matches), localizedName))
const visibleUser = computed(() => sortSkillsByName(userSkills.value.filter(matches), localizedName))
const hasVisible = computed(() => visibleBuiltin.value.length + visibleUser.value.length > 0)

const loadAll = async () => {
  const [builtin, user] = await Promise.allSettled([
    window.electronAPI.builtinSkill.list(),
    window.electronAPI.userSkill.list(),
  ])
  if (builtin.status === 'fulfilled') {
    builtinSkills.value = builtin.value.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
      kind: 'builtin' as const,
    }))
  } else {
    console.error('Failed to load builtin skills:', builtin.reason)
  }
  if (user.status === 'fulfilled') {
    userSkills.value = user.value.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description ?? '',
      enabled: s.enabled,
      kind: 'user' as const,
    }))
  } else {
    console.error('Failed to load user skills:', user.reason)
  }
}

const POPOVER_WIDTH = 280
const VIEWPORT_MARGIN = 8

const updatePosition = () => {
  const rect = buttonRef.value?.getBoundingClientRect()
  if (!rect) return
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(rect.right + VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
  )
  popoverStyle.value = {
    left: `${left}px`,
    bottom: `${Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.bottom)}px`,
    maxHeight: `${Math.max(240, rect.bottom - VIEWPORT_MARGIN * 2)}px`,
    top: 'auto',
    right: 'auto',
  }
}

const togglePopover = async () => {
  showPopover.value = !showPopover.value
  if (showPopover.value) {
    searchQuery.value = ''
    updatePosition()
    window.addEventListener('resize', updatePosition)
    await loadAll()
  } else {
    window.removeEventListener('resize', updatePosition)
  }
}

const closePopover = () => {
  showPopover.value = false
  window.removeEventListener('resize', updatePosition)
}

/** 捕获阶段听按下：控制面板等处的 stop 拦不住 */
const handlePointerDownOutside = (e: PointerEvent) => {
  if (!showPopover.value) return
  const target = e.target
  if (!(target instanceof Node)) {
    closePopover()
    return
  }
  if (popoverRef.value?.contains(target) || buttonRef.value?.contains(target)) return
  closePopover()
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showPopover.value) {
    e.stopImmediatePropagation()
    closePopover()
  }
}

function skillKey(skill: SkillItem): string {
  return `${skill.kind}:${skill.id}`
}

const toggleSkill = async (skill: SkillItem) => {
  const key = skillKey(skill)
  if (togglingIds.value.has(key)) return
  const next = !skill.enabled
  togglingIds.value = new Set(togglingIds.value).add(key)
  skill.enabled = next
  try {
    const ok = skill.kind === 'builtin'
      ? await window.electronAPI.builtinSkill.toggle(skill.id, next)
      : await window.electronAPI.userSkill.toggle(skill.id, next)
    if (!ok) skill.enabled = !next
  } catch (error) {
    console.error('Failed to toggle skill:', error)
    skill.enabled = !next
  } finally {
    const nextSet = new Set(togglingIds.value)
    nextSet.delete(key)
    togglingIds.value = nextSet
  }
}

const openSettings = () => {
  closePopover()
  emit('openSettings')
}

onMounted(() => {
  document.addEventListener('pointerdown', handlePointerDownOutside, true)
  document.addEventListener('keydown', handleKeydown)
  void loadAll()
})

onUnmounted(() => {
  document.removeEventListener('pointerdown', handlePointerDownOutside, true)
  document.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('resize', updatePosition)
})
</script>

<template>
  <div class="skill-wrapper">
    <button
      ref="buttonRef"
      type="button"
      class="btn-icon skill-btn"
      :class="statusClass"
      :title="statusTooltip"
      @click="togglePopover"
    >
      <span class="equip-icon">
        <Sparkles :size="13" :stroke-width="1.75" />
      </span>
      <span class="status-badge" :class="statusClass">
        <span class="status-dot">{{ statusIcon }}</span>
        <span class="status-count">{{ enabledCount }}/{{ totalCount }}</span>
      </span>
    </button>

    <Teleport to="body">
      <div
        v-if="showPopover"
        ref="popoverRef"
        class="skill-popover"
        :style="popoverStyle"
      >
        <div class="popover-header">
          <span class="popover-title">{{ t('skills.title') }}</span>
          <span class="popover-count" :class="statusClass">{{ enabledCount }}/{{ totalCount }}</span>
          <button
            type="button"
            class="btn-gear"
            :title="t('conn.goSetup')"
            @click="openSettings"
          >
            <Settings :size="14" />
          </button>
        </div>

        <div v-if="totalCount > 0" class="search-row">
          <input
            v-model="searchQuery"
            type="search"
            class="search-input"
            :placeholder="t('skills.search')"
          >
        </div>

        <div class="popover-body">
          <div v-if="totalCount === 0" class="empty-hint">{{ t('skills.none') }}</div>
          <div v-else-if="!hasVisible" class="empty-hint">{{ t('skills.emptyFilter') }}</div>
          <template v-else>
            <div v-if="visibleUser.length" class="section">
              <div class="section-label">{{ t('skillSettings.extensionSkills') }}</div>
              <label
                v-for="skill in visibleUser"
                :key="'user-' + skill.id"
                class="item"
                :class="{ disabled: !skill.enabled }"
              >
                <span class="item-name" :title="localizedDetail(skill) || undefined">{{ localizedName(skill) }}</span>
                <span class="toggle-switch">
                  <input
                    type="checkbox"
                    :checked="skill.enabled"
                    :disabled="togglingIds.has(skillKey(skill))"
                    :title="t('skillSettings.toggleEnable')"
                    @change="toggleSkill(skill)"
                  >
                  <span class="toggle-slider" />
                </span>
              </label>
            </div>
            <div v-if="visibleBuiltin.length" class="section">
              <div class="section-label">{{ t('skillSettings.builtinSkills') }}</div>
              <label
                v-for="skill in visibleBuiltin"
                :key="'builtin-' + skill.id"
                class="item"
                :class="{ disabled: !skill.enabled }"
              >
                <span class="item-name" :title="localizedDetail(skill) || undefined">{{ localizedName(skill) }}</span>
                <span class="toggle-switch">
                  <input
                    type="checkbox"
                    :checked="skill.enabled"
                    :disabled="togglingIds.has(skillKey(skill))"
                    :title="t('skillSettings.toggleEnable')"
                    @change="toggleSkill(skill)"
                  >
                  <span class="toggle-slider" />
                </span>
              </label>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.skill-wrapper {
  position: relative;
}

.skill-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 3px;
  width: 100%;
  height: 22px;
  padding: 0 5px;
  border-radius: 6px;
  flex-shrink: 0;
  color: var(--text-secondary);
}

.equip-icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.status-dot {
  width: 8px;
  text-align: center;
  flex-shrink: 0;
}

.skill-btn:hover,
.skill-btn:active {
  transform: none;
  color: var(--text-primary);
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
}

.status-badge {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  font-weight: 500;
  padding: 0;
  background: transparent;
}

.status-dot { font-size: 9px; }
.status-count { font-family: var(--font-mono); font-size: 10px; }

.status-all .status-dot,
.status-all.status-badge,
.status-all.popover-count { color: var(--brand-vital); }

.status-none .status-dot,
.status-none.status-badge,
.status-none.popover-count { color: var(--text-muted); }

.skill-popover {
  position: fixed;
  width: 280px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 1100;
  overflow: hidden;
  animation: popInUp 0.15s ease;
}

@keyframes popInUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

.popover-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px 8px;
  flex-shrink: 0;
}

.popover-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.popover-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}

.btn-gear {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.btn-gear:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.14));
  color: var(--text-primary);
}

.search-row {
  padding: 0 12px 8px;
  flex-shrink: 0;
}

.search-input {
  width: 100%;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary, var(--bg-primary));
  color: var(--text-primary);
  font-size: 12px;
  outline: none;
}

.search-input:focus {
  border-color: var(--accent-primary);
}

.search-input::placeholder {
  color: var(--text-muted);
}

.popover-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 0 8px;
}

.empty-hint {
  padding: 16px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 11px;
}

.section-label {
  padding: 6px 12px 2px;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.02em;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  cursor: pointer;
}

.item:hover {
  background: var(--bg-hover);
}

.item.disabled .item-name {
  color: var(--text-muted);
}

.item-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggle-switch {
  position: relative;
  display: inline-block;
  width: 28px;
  height: 16px;
  flex-shrink: 0;
}

.toggle-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  inset: 0;
  background: var(--bg-tertiary, var(--bg-primary));
  border: 1px solid var(--border-color);
  border-radius: 16px;
  transition: 0.15s;
}

.toggle-slider::before {
  position: absolute;
  content: "";
  width: 10px;
  height: 10px;
  left: 2px;
  top: 2px;
  background: var(--text-muted);
  border-radius: 50%;
  transition: 0.15s;
}

.toggle-switch input:checked + .toggle-slider {
  background: var(--brand-vital);
  border-color: var(--brand-vital);
}

.toggle-switch input:checked + .toggle-slider::before {
  transform: translateX(12px);
  background: #fff;
}

.toggle-switch input:disabled + .toggle-slider {
  opacity: 0.5;
}
</style>
