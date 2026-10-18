<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  BookUser,
  Eye,
  Brain,
  Heart,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  Settings,
  SquareTerminal,
} from 'lucide-vue-next'
import { isOemFeatureEnabled } from '@shared/oem-features'
import { isWorkbenchAvailable } from '../workbench/registry'
import { useTerminalStore } from '../stores/terminal'
import { useAuthStore } from '../stores/auth'
import { useConfigStore } from '../stores/config'
import { resolveAssistantName } from '../utils/assistant-name'
import { useTodoOverdueCount } from '../composables/useTodoOverdueCount'
import { useWatchAnomalyCount } from '../composables/useWatchAnomalyCount'
import RecentConversationsPanel from './RecentConversationsPanel.vue'
import ConnectionStatusPopover from './ConnectionStatusPopover.vue'
import SkillStatusPopover from './SkillStatusPopover.vue'

const props = defineProps<{
  awakened: boolean
}>()

const emit = defineEmits<{
  'open-todos': []
  'open-contacts': []
  'open-memory': []
  'open-watch': []
  'open-awaken': []
  /** tab：连接面板里「去设置」指向的具体页（渠道 / MCP / 浏览器助手） */
  'open-connection': [tab?: string]
  'open-settings': [tab?: string]
  logout: []
}>()

const { t } = useI18n()
const terminalStore = useTerminalStore()
const authStore = useAuthStore()
const configStore = useConfigStore()
const { overdueCount, hasUnseenOverdue } = useTodoOverdueCount()
const { anomalyCount: watchAnomalyCount } = useWatchAnomalyCount()

const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__
const canShowAssistant = !isSteamBuild && isWorkbenchAvailable('assistant')
const canShowCompanion = isWorkbenchAvailable('companion')
const canShowTerminal = isWorkbenchAvailable('local') || isWorkbenchAvailable('ssh')
const canShowAwaken = !isSteamBuild && isOemFeatureEnabled('awaken')
const canShowWatch = !isSteamBuild && isOemFeatureEnabled('watch')
/** 简化版没有知识库设置，也就没有记忆栏目 */
const canShowMemory = !isSteamBuild

/** 秘书就是这个应用本身；名字的解析口径统一在 resolveAssistantName */
const secretaryName = computed(() => resolveAssistantName())

/** 已经用公司账号登录时，这张脸换成员工。没开登录或还没登录，仍是旗鱼或秘书。 */
const showingEmployee = computed(() => !!authStore.face)
const pictureBroken = ref(false)
watch(() => authStore.face?.picture, () => { pictureBroken.value = false })

const faceName = computed(() => showingEmployee.value ? authStore.face!.name : secretaryName.value)
const faceInitial = computed(() => faceName.value.slice(0, 1))
const faceAvatar = computed(() => {
  if (showingEmployee.value) return pictureBroken.value ? '' : authStore.face!.picture
  return configStore.agentAvatar?.trim() || ''
})

const appVersion = ref('')

/**
 * 副文案：登录后是邮箱。还没登录时，常态是版本号，未觉醒时让位。
 */
const faceSub = computed(() => {
  if (showingEmployee.value) return authStore.face!.email
  if (canShowAwaken && !props.awakened) return t('shell.notAwakened')
  return appVersion.value ? `v${appVersion.value}` : ''
})

/** 登录后悬停就是这个人。还没登录时，悬停仍能确认觉醒状态。 */
const faceTitle = computed(() => {
  if (showingEmployee.value) return faceName.value
  if (!canShowAwaken) return secretaryName.value
  const state = props.awakened ? t('shell.awakened') : t('shell.notAwakened')
  return `${secretaryName.value} · ${state}`
})

const place = computed(() => terminalStore.shellPlace)

/**
 * 「新对话」只在主区真是空白起点时高亮。
 * 正在看某条会话时高亮落在最近对话列表里那条，避免两处同时亮。
 */
const atNewChat = computed(() =>
  place.value === 'tasks' && !terminalStore.activeTabId && !terminalStore.hubFocusedTab
)

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

const secretaryHasBadge = computed(() =>
  hasUnseenOverdue.value || watchAnomalyCount.value > 0
)

function closeMenu() {
  menuOpen.value = false
}

function onDocClick(e: MouseEvent) {
  if (!menuRef.value?.contains(e.target as Node)) closeMenu()
}

onMounted(async () => {
  document.addEventListener('click', onDocClick)
  try {
    appVersion.value = await window.electronAPI.app.getVersion()
  } catch { /* 版本号拿不到就不显示，不影响其他 */ }
})
onUnmounted(() => document.removeEventListener('click', onDocClick))

/** 点「新对话」就是开新的：清掉正在看的会话，主区回到空白起点 */
function goTasks() {
  terminalStore.goToHome()
}

function goCompanion() {
  terminalStore.focusCompanionPlace()
}

function goTerminal() {
  terminalStore.focusTerminalPlace()
}

function pick(action: 'open-todos' | 'open-contacts' | 'open-memory' | 'open-watch' | 'open-awaken' | 'open-settings') {
  closeMenu()
  if (action === 'open-todos') emit('open-todos')
  else if (action === 'open-contacts') emit('open-contacts')
  else if (action === 'open-memory') emit('open-memory')
  else if (action === 'open-watch') emit('open-watch')
  else if (action === 'open-awaken') emit('open-awaken')
  else emit('open-settings')
}
</script>

<template>
  <div class="app-sidebar">
    <nav class="place-nav" aria-label="shell">
      <button
        v-if="canShowAssistant"
        type="button"
        class="place-item"
        :class="{ active: atNewChat }"
        @click="goTasks"
      >
        <MessageSquare :size="16" :stroke-width="1.75" />
        <span>{{ t('shell.newChat') }}</span>
      </button>
      <button
        v-if="canShowCompanion"
        type="button"
        class="place-item"
        :class="{ active: place === 'companion' }"
        @click="goCompanion"
      >
        <MessagesSquare :size="16" :stroke-width="1.75" />
        <span>{{ t('shell.companion') }}</span>
        <span v-if="terminalStore.hasCompanionAttention" class="dot" />
      </button>
      <button
        v-if="canShowTerminal"
        type="button"
        class="place-item"
        :class="{ active: place === 'terminal' }"
        @click="goTerminal"
      >
        <SquareTerminal :size="16" :stroke-width="1.75" />
        <span>{{ t('shell.terminal') }}</span>
        <span v-if="terminalStore.hasTerminalPlaceAttention" class="dot" />
      </button>
    </nav>

    <div v-if="canShowAssistant" class="recent-slot">
      <RecentConversationsPanel embedded />
    </div>

    <div ref="menuRef" class="secretary">
      <div class="secretary-row">
        <button type="button" class="secretary-btn" :title="faceTitle" @click.stop="menuOpen = !menuOpen">
          <span class="avatar" :class="{ awakened: !showingEmployee && props.awakened }">
            <img v-if="faceAvatar" :src="faceAvatar" class="avatar-img" alt="" @error="pictureBroken = true" />
            <template v-else>{{ faceInitial }}</template>
            <span v-if="secretaryHasBadge" class="avatar-dot" />
          </span>
          <span class="secretary-meta">
            <span class="secretary-name">{{ faceName }}</span>
            <span v-if="faceSub" class="secretary-sub">{{ faceSub }}</span>
          </span>
        </button>
        <!-- 装备位：上面连接、下面技能。点这里先收起秘书菜单，避免浮层叠在一起 -->
        <span v-if="canShowAssistant" class="equip-slot" @click="closeMenu">
          <ConnectionStatusPopover
            variant="sidebar"
            @open-settings="(tab?: string) => emit('open-connection', tab)"
          />
          <SkillStatusPopover
            @open-settings="emit('open-settings', 'skills')"
          />
        </span>
      </div>

      <div v-if="menuOpen" class="secretary-menu" @click.stop>
        <!-- 菜单从按钮向上弹出：越靠下越近手边，所以自下而上按使用频率从高到低排 -->
        <button
          v-if="showingEmployee"
          type="button"
          class="menu-item menu-item--danger"
          @click="closeMenu(); emit('logout')"
        >
          <span>{{ t('header.ssoLogout') }}</span>
        </button>
        <button type="button" class="menu-item" @click="pick('open-settings')">
          <Settings :size="14" />
          <span>{{ t('shell.settings') }}</span>
        </button>
        <div v-if="canShowMemory || canShowWatch || canShowAwaken" class="menu-sep" role="separator" />
        <button v-if="canShowAwaken" type="button" class="menu-item" @click="pick('open-awaken')">
          <Heart :size="14" :fill="props.awakened ? 'currentColor' : 'none'" />
          <span>{{ t('shell.awaken') }}</span>
          <span v-if="showingEmployee && !props.awakened" class="menu-hint">{{ t('shell.notAwakened') }}</span>
        </button>
        <button v-if="canShowMemory" type="button" class="menu-item" @click="pick('open-memory')">
          <Brain :size="14" />
          <span>{{ t('shell.memory') }}</span>
        </button>
        <button v-if="canShowWatch" type="button" class="menu-item" @click="pick('open-watch')">
          <Eye :size="14" />
          <span>{{ t('shell.watch') }}</span>
          <span v-if="watchAnomalyCount > 0" class="menu-badge">{{ watchAnomalyCount > 99 ? '99+' : watchAnomalyCount }}</span>
        </button>
        <div class="menu-sep" role="separator" />
        <button type="button" class="menu-item" @click="pick('open-contacts')">
          <BookUser :size="14" />
          <span>{{ t('shell.contacts') }}</span>
        </button>
        <button type="button" class="menu-item" @click="pick('open-todos')">
          <ListTodo :size="14" />
          <span>{{ t('shell.todos') }}</span>
          <span v-if="overdueCount > 0" class="menu-badge">{{ overdueCount > 99 ? '99+' : overdueCount }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.place-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 8px 6px;
}

.place-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.place-item:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--text-primary);
}

.place-item.active {
  background: var(--bg-active, rgba(127, 127, 127, 0.18));
  color: var(--text-primary);
  font-weight: 600;
}

.recent-slot {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.secretary {
  position: relative;
  padding: 8px;
  border-top: 1px solid var(--border-color);
}

/* 身份在左、装备在右：两个独立按钮并排，各点各的 */
.secretary-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.equip-slot {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  flex-shrink: 0;
}

.equip-slot :deep(.conn-wrapper),
.equip-slot :deep(.skill-wrapper) {
  width: 100%;
}

.secretary-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}

.secretary-btn:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.12));
}

.avatar {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary, rgba(127, 127, 127, 0.2));
  font-size: 13px;
  font-weight: 700;
  flex-shrink: 0;
}

.avatar.awakened {
  color: var(--brand-vital, #3d9a6a);
  box-shadow: 0 0 0 1px var(--brand-vital, #3d9a6a);
}

.avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}

/* 待办逾期 / 关切异常打在头像上，右侧让给装备位 */
.avatar-dot {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent, #7aa2f7);
  box-shadow: 0 0 0 2px var(--bg-secondary);
}

.secretary-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.secretary-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.secretary-sub {
  font-size: 11px;
  color: var(--text-tertiary, var(--text-secondary));
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.secretary-menu {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% + 4px);
  padding: 6px;
  border-radius: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  z-index: 20;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 32px;
  padding: 0 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.menu-item:hover {
  background: var(--bg-hover, rgba(127, 127, 127, 0.12));
}

.menu-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-color);
}

.menu-item--danger {
  color: var(--text-secondary);
}

.menu-hint {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-tertiary, var(--text-secondary));
}

.menu-badge {
  margin-left: auto;
  min-width: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--danger, #c45c5c);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.dot {
  position: absolute;
  right: 10px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #7aa2f7);
}
</style>
