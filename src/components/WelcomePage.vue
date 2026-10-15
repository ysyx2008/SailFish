<script setup lang="ts">
/**
 * 欢迎页组件
 * 程序启动后显示，提供快速启动各类终端的入口
 */
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bot, SquareTerminal, Monitor, Eye, Upload, Lightbulb } from 'lucide-vue-next'
import { useConfigStore, type SshSession } from '../stores/config'
import { useTerminalStore } from '../stores/terminal'
import MatrixRain from './EasterEgg/MatrixRain.vue'
import WelcomeChatComposer from './WelcomeChatComposer.vue'
import DropOverlay from './DropOverlay.vue'
import sailfishLogo from 'virtual:oem-app-logo'
import { useWatchAnomalyCount } from '../composables/useWatchAnomalyCount'
import { useWelcomeSubtitle } from '../composables/useWelcomeSubtitle'
import { useFileDropTarget } from '../composables/useFileDropTarget'
import { isWorkbenchAvailable } from '../workbench/registry'
import { isOemFeatureEnabled } from '@shared/oem-features'

const { t } = useI18n()
const configStore = useConfigStore()
const terminalStore = useTerminalStore()
const isSteamBuild = typeof __STEAM_BUILD__ !== 'undefined' && __STEAM_BUILD__
const welcomeSubtitle = useWelcomeSubtitle(isSteamBuild)
const canShowAssistant = !isSteamBuild && isWorkbenchAvailable('assistant')
const canShowLocal = isWorkbenchAvailable('local')
const canShowSsh = isWorkbenchAvailable('ssh')
const canShowWatch = !isSteamBuild && isOemFeatureEnabled('watch')

/** 未完成诞生引导时，在首页展示「初次见面」邀请 */
const onboardingMeetPending = ref(false)

const showOnboardingInvite = computed(() =>
  canShowAssistant &&
  configStore.hasAiConfig &&
  !configStore.agentOnboardingShown &&
  !configStore.agentOnboardingCompleted &&
  !onboardingMeetPending.value
)

/** 文字与 logo 挥手同步：先显示默认文案，3s 后（logo 开始摆动时）切换成「初次见面」 */
const onboardingGreetActive = ref(false)
let onboardingGreetTimer: ReturnType<typeof setTimeout> | undefined
watch(
  showOnboardingInvite,
  (show) => {
    if (onboardingGreetTimer) clearTimeout(onboardingGreetTimer)
    if (show) {
      onboardingGreetTimer = setTimeout(() => {
        onboardingGreetActive.value = true
      }, 3000)
    } else {
      onboardingGreetActive.value = false
    }
  },
  { immediate: true }
)
onUnmounted(() => {
  if (onboardingGreetTimer) clearTimeout(onboardingGreetTimer)
})

const startOnboardingMeet = () => {
  if (!showOnboardingInvite.value) return
  onboardingMeetPending.value = true
  const tabId = terminalStore.createAssistantTab({
    activate: false,
    title: t('ai.onboardingConversationTitle'),
  })
  // 不 markAssistantSkipOnboarding —— 让 AiPanel 在聚焦后自动跑 __onboarding__
  terminalStore.focusHubConversation(tabId)
}

const dismissOnboardingInvite = async () => {
  if (onboardingMeetPending.value || configStore.agentOnboardingShown) return
  onboardingMeetPending.value = true
  await configStore.markAgentOnboardingShown()
  onboardingMeetPending.value = false
}

const welcomeComposerRef = ref<InstanceType<typeof WelcomeChatComposer> | null>(null)

const ingestWelcomeFiles = async (files: FileList) => {
  await welcomeComposerRef.value?.ingestAttachmentFiles(files)
  welcomeComposerRef.value?.focusComposer()
}

const {
  isDragOver: isFileDragOver,
  handleDragEnter: handleFileDragEnter,
  handleDragOver: handleFileDragOver,
  handleDragLeave: handleFileDragLeave,
  handleDrop: handleFileDrop,
} = useFileDropTarget(ingestWelcomeFiles)

const onWelcomeDragEnter = (event: DragEvent) => {
  if (!isSteamBuild) handleFileDragEnter(event)
}

const onWelcomeDragOver = (event: DragEvent) => {
  if (!isSteamBuild) handleFileDragOver(event)
}

const onWelcomeDragLeave = (event: DragEvent) => {
  if (!isSteamBuild) handleFileDragLeave(event)
}

const onWelcomeDrop = (event: DragEvent) => {
  if (!isSteamBuild) handleFileDrop(event)
}

// 彩蛋：连续点击 Logo 20 次触发 Matrix 数字雨
const showMatrixEasterEgg = ref(false)
const logoClickCount = ref(0)
const lastLogoClickTime = ref(0)
const EASTER_EGG_CLICK_COUNT = 20
const EASTER_EGG_CLICK_INTERVAL = 1000 // 毫秒

const handleLogoClick = () => {
  const now = Date.now()
  // 如果距离上次点击超过 1000ms，重置计数
  if (now - lastLogoClickTime.value > EASTER_EGG_CLICK_INTERVAL) {
    logoClickCount.value = 1
  } else {
    logoClickCount.value++
  }
  lastLogoClickTime.value = now

  // 达到 20 次触发彩蛋
  if (logoClickCount.value >= EASTER_EGG_CLICK_COUNT) {
    showMatrixEasterEgg.value = true
    logoClickCount.value = 0
  }
}

const closeMatrixEasterEgg = () => {
  showMatrixEasterEgg.value = false
}

// 随机选择一条 tip 显示，支持点击切换（Steam 版过滤掉 AI 相关提示）
const allTipKeys = [
  'tip1', 'tip2', 'tip3', 'tip4', 'tip5', 'tip6', 'tip7', 'tip8', 'tip9', 'tip10',
  'tip11', 'tip12', 'tip13', 'tip14', 'tip15', 'tip16', 'tip17', 'tip18', 'tip19', 'tip20',
  'tip21', 'tip22', 'tip23', 'tip24', 'tip25', 'tip26', 'tip27', 'tip28', 'tip29', 'tip30'
]
const steamTipKeys = ['tip1', 'tip4', 'tip6', 'tip13', 'tip14', 'tip15', 'tip17', 'tip25', 'tip26', 'tip27']
const tipKeys = isSteamBuild ? steamTipKeys : allTipKeys
const currentTipIndex = ref(Math.floor(Math.random() * tipKeys.length))
const currentTip = computed(() => t(`welcome.${tipKeys[currentTipIndex.value]}`))

// 点击切换到下一条 tip
const nextTip = () => {
  currentTipIndex.value = (currentTipIndex.value + 1) % tipKeys.length
}

/** 本次程序启动是否已播过欢迎页入场动画（进程级，重启后重置） */
let welcomeEnterLocked = false

const props = defineProps<{
  /** 主区是否为欢迎页（切 tab 时为 false） */
  active?: boolean
  /** 欢迎页是否真正展示给用户（启动完成且无全屏遮挡） */
  ready?: boolean
}>()

const emit = defineEmits<{
  'open-assistant': []
  'open-local': []
  'open-ssh': [session: SshSession]
  'open-session-manager': []
  'open-smart-patrol': []
  'open-watches': []
}>()

const openAssistant = () => {
  emit('open-assistant')
}

const openWatches = () => {
  emit('open-watches')
}

const { anomalyCount: watchAnomalyCount } = useWatchAnomalyCount()

// 最近连接的会话（最多显示 5 个，按最近使用时间逆序排序）
const recentSessions = computed(() => {
  return [...configStore.sshSessions]
    .sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    .slice(0, 3)
})

// 是否有保存的会话
const hasSessions = computed(() => configStore.sshSessions.length > 0)

// 快速连接 SSH
const connectToSession = (session: SshSession) => {
  emit('open-ssh', session)
}

// 打开本地终端
const openLocalTerminal = () => {
  emit('open-local')
}

// 打开会话管理器选择更多
const openSessionManager = () => {
  emit('open-session-manager')
}

// 格式化主机显示
const formatHost = (session: SshSession) => {
  return `${session.username}@${session.host}:${session.port}`
}

/** 跳过入场动画（回首页或动画已播完） */
const enterAnimationDone = ref(welcomeEnterLocked)
let enterLockTimer: number | null = null
let hasStartedEnter = false

const lockWelcomeEnter = () => {
  if (welcomeEnterLocked) return
  welcomeEnterLocked = true
  enterAnimationDone.value = true
  if (enterLockTimer) {
    clearTimeout(enterLockTimer)
    enterLockTimer = null
  }
}

const scheduleEnterLock = () => {
  if (welcomeEnterLocked || enterLockTimer) return
  enterLockTimer = window.setTimeout(() => {
    enterLockTimer = null
    lockWelcomeEnter()
  }, 700)
}

const startEnterAnimation = () => {
  if (welcomeEnterLocked || !props.ready) return
  hasStartedEnter = true
  enterAnimationDone.value = false
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!props.ready || welcomeEnterLocked) return
      scheduleEnterLock()
    })
  })
}

watch(
  () => props.active,
  (active) => {
    if (!active && hasStartedEnter) {
      lockWelcomeEnter()
    }
  },
  { immediate: true }
)

watch(
  () => props.ready,
  (ready) => {
    if (welcomeEnterLocked) {
      enterAnimationDone.value = true
      return
    }
    if (ready) {
      startEnterAnimation()
    }
  },
  { immediate: true }
)

onUnmounted(() => {
  if (enterLockTimer) clearTimeout(enterLockTimer)
})
</script>

<template>
  <div
    class="welcome-page"
    :class="{ 'enter-done': enterAnimationDone }"
    @dragenter="onWelcomeDragEnter"
    @dragover="onWelcomeDragOver"
    @dragleave="onWelcomeDragLeave"
    @drop="onWelcomeDrop"
  >
    <DropOverlay
      v-if="!isSteamBuild && isFileDragOver"
      :title="t('ai.dropToUpload')"
      :hint="t('ai.dropHint')"
    >
      <template #icon>
        <Upload :size="48" :stroke-width="1.5" />
      </template>
    </DropOverlay>

    <div class="welcome-content">
      <!-- Logo 和标题 -->
      <div class="welcome-header">
        <div class="logo-container" @click="handleLogoClick">
          <div class="logo">
            <span class="logo-float" :class="{ 'is-greeting': showOnboardingInvite }">
              <img :src="sailfishLogo" alt="Sailfish" class="sailfish-logo" />
            </span>
          </div>
        </div>
        <!-- 首次运行：先显示默认文案；3s 后 logo 原地左右摆，标题交叉淡入「初次见面」，
             副标题位换成按钮行。默认文案始终留在流内撑宽度，「初次见面」态以浮层叠加，
             这样文案长短变化不会把 logo 推离页面中线。 -->
        <div class="header-text">
          <div class="header-title-slot">
            <h1 class="welcome-title" :class="{ 'is-faded': onboardingGreetActive }">
              {{ t(isSteamBuild ? 'welcome.titleSteam' : 'welcome.title') }}
            </h1>
            <Transition name="greet-fade">
              <h1 v-if="onboardingGreetActive" class="welcome-title greet-overlay">
                {{ t('welcome.onboardingInvite.title') }}
              </h1>
            </Transition>
          </div>
          <div class="header-sub-slot">
            <p class="welcome-subtitle" :class="{ 'is-faded': onboardingGreetActive }">
              {{ welcomeSubtitle }}
            </p>
            <Transition name="greet-fade">
              <div v-if="onboardingGreetActive" class="onboarding-invite-actions greet-overlay">
                <button
                  type="button"
                  class="onboarding-invite-meet"
                  :disabled="onboardingMeetPending"
                  @click="startOnboardingMeet"
                >
                  {{ t('welcome.onboardingInvite.meet') }}
                </button>
                <button
                  type="button"
                  class="onboarding-invite-later"
                  :disabled="onboardingMeetPending"
                  @click="dismissOnboardingInvite"
                >
                  {{ t('welcome.onboardingInvite.later') }}
                </button>
              </div>
            </Transition>
          </div>
        </div>
      </div>

      <!-- AI 快速发起对话（Steam 版隐藏，复用 AiComposer） -->
      <WelcomeChatComposer v-if="canShowAssistant" ref="welcomeComposerRef" :active="!!active" />

      <!-- 查看示例入口 -->
      <div v-if="canShowAssistant" class="examples-hint">
        <button type="button" class="examples-hint-btn" @click="openAssistant">
          <Lightbulb :size="13" :stroke-width="1.75" />
          <span>{{ t('welcome.viewExamples') }}</span>
        </button>
      </div>

      <!-- 快速启动卡片 -->
      <div class="quick-start">
        <h2 class="section-title">{{ t('welcome.quickStart') }}</h2>
        <div class="action-cards">
          <!-- AI 助手（Steam 版隐藏） -->
          <div v-if="canShowAssistant" class="action-card" @click="openAssistant">
            <div class="card-icon assistant">
              <Bot :size="24" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.assistant') }}</div>
              <div class="card-desc">{{ t('welcome.assistantDesc') }}</div>
            </div>
          </div>

          <!-- 本地终端 -->
          <div v-if="canShowLocal" class="action-card" @click="openLocalTerminal">
            <div class="card-icon local">
              <SquareTerminal :size="24" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.localTerminal') }}</div>
              <div class="card-desc">{{ t('welcome.localTerminalDesc') }}</div>
            </div>
          </div>

          <!-- SSH 连接 -->
          <div v-if="canShowSsh" class="action-card" @click="openSessionManager">
            <div class="card-icon ssh">
              <Monitor :size="24" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.sshConnect') }}</div>
              <div class="card-desc">{{ t('welcome.sshConnectDesc') }}</div>
            </div>
          </div>

          <!-- 关切总览（Steam 版隐藏，无 Agent 即无关切） -->
          <div v-if="canShowWatch" class="action-card" @click="openWatches">
            <div class="card-icon watch">
              <Eye :size="24" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.watch') }}</div>
              <div class="card-desc">{{ t('welcome.watchDesc') }}</div>
            </div>
            <span v-if="watchAnomalyCount > 0" class="watch-anomaly-badge">
              {{ watchAnomalyCount > 99 ? '99+' : watchAnomalyCount }}
            </span>
          </div>

          <!-- 智能巡检（暂时隐藏）
          <div class="action-card" @click="openSmartPatrol">
            <div class="card-icon patrol">
              <Bot :size="24" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.smartPatrol') }}</div>
              <div class="card-desc">{{ t('welcome.smartPatrolDesc') }}</div>
            </div>
          </div>
          -->
        </div>
      </div>

      <!-- 最近连接 -->
      <div v-if="canShowSsh && hasSessions" class="recent-sessions">
        <div class="section-header">
          <h2 class="section-title">{{ t('welcome.recentConnections') }}</h2>
          <div v-if="configStore.sshSessions.length > 3" class="view-all" @click="openSessionManager">
            {{ t('welcome.viewAllSessions') }} →
          </div>
        </div>
        <div class="session-grid">
          <div 
            v-for="session in recentSessions" 
            :key="session.id"
            class="session-item"
            @click="connectToSession(session)"
          >
            <div class="session-icon">
              <Monitor :size="16" />
            </div>
            <div class="session-info">
              <div class="session-name">{{ session.name }}</div>
              <div class="session-host">{{ formatHost(session) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 提示信息（非 Steam 版有对话入口，为节省纵向空间隐藏 tips） -->
      <div v-if="isSteamBuild" class="tips" @click="nextTip" :title="t('welcome.clickToSwitchTip')">
        <div class="tip-item">
          <span class="tip-icon"><Lightbulb :size="15" :stroke-width="1.75" /></span>
          <span class="tip-text">{{ currentTip }}</span>
          <span class="tip-next">↻</span>
        </div>
      </div>
    </div>

    <!-- Matrix 数字雨彩蛋 -->
    <MatrixRain v-if="showMatrixEasterEgg" @close="closeMatrixEasterEgg" />
  </div>
</template>

<style scoped>
.welcome-page {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  /* 居中交给 .welcome-content 的 auto 外边距，这里只管四边的最小呼吸量。
     左右这 40px 平时是空转的（内容被 760px 上限锁住、居中留白更宽），
     只在面板窄到顶着上限时才真的收进来——而那正是内容会贴着边缘的场合。 */
  padding: 40px;
}

.welcome-content {
  max-width: 760px;
  width: 100%;
  /* 真居中：空白均分到上下，读起来才是刻意的留白而不是没写完。
     代价是内容增减（输入框变高、注意事项出现）时整块会上下移——这是选过的，
     换来的是内容一旦变短不会全部堆在底部。

     用 auto 外边距而不是父级 justify-content: center：后者在可滚动容器里
     内容超高时会把顶部溢出的部分顶到滚不到的地方。 */
  margin: auto;
  animation: pageEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes pageEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Header */
.welcome-header {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-bottom: 20px;
  /* 光学配重：包围盒居中时，右侧粗体标题比左侧线稿 logo 显得更重，
     整组读起来偏右。右侧多留 16px 让居中结果左移 8px 找回视觉平衡。
     用 padding 而非 transform——入场动画收尾会把 transform 清成 none。 */
  padding-right: 16px;
  animation: headerEnter 0.35s cubic-bezier(0.16, 1, 0.3, 1) 0.05s forwards;
  opacity: 0;
}

/* 诞生引导邀请：logo 开始挥手时，标题换成「初次见面」、副标题位置换成按钮行。
   宽度随文案自然撑开，让 logo + 文案整体相对内容列真正视觉居中；
   文案切换的稳定性由 .greet-overlay 浮层保证，不靠预留空白。 */
.header-text {
  text-align: left;
  flex-shrink: 0;
}

.header-title-slot,
.header-sub-slot {
  position: relative;
}

/* 「初次见面」态叠在默认文案之上、不占布局宽度：
   文案变长只向右溢出，不会把 logo 推离中线 */
.greet-overlay {
  position: absolute;
  left: 0;
  top: 0;
  white-space: nowrap;
}

/* 被浮层顶替的默认文案：淡出但继续占位撑宽度 */
.welcome-title,
.welcome-subtitle {
  transition: opacity 0.35s ease;
}

.welcome-title.is-faded,
.welcome-subtitle.is-faded {
  opacity: 0;
}

.header-title-slot {
  min-height: 1.2em; /* 对齐 .welcome-title 行高，交叉淡入时不塌陷 */
  margin-bottom: 4px;
}

.header-sub-slot {
  min-height: 21px;
}

.onboarding-invite-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 21px;
}

/* 文案切换：旧文案淡出，新文案带上滑 + 轻微放大强调进场——
   比纯淡入更抓视线，明确提示「这里变了、看这里」。 */
.greet-fade-enter-active {
  transition: opacity 0.5s ease, transform 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.greet-fade-leave-active {
  transition: opacity 0.35s ease;
}

.greet-fade-enter-from {
  opacity: 0;
  transform: translateY(10px) scale(0.96);
}

.greet-fade-leave-to {
  opacity: 0;
}

/* 「认识一下」：实心药丸按钮，一眼可点 */
.onboarding-invite-meet {
  display: inline-flex;
  align-items: center;
  background: var(--accent-primary, #58a6ff);
  color: #fff;
  border: none;
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  box-shadow: 0 2px 8px color-mix(in srgb, var(--accent-primary, #58a6ff) 40%, transparent);
  transition: transform 0.15s ease, box-shadow 0.15s ease, filter 0.15s ease;
  /* 按钮行是文字切换时才插入 DOM 的：站稳后轻微呼吸脉动 3 次吸引注意 */
  animation: meetPulse 1.6s ease-in-out 0.7s 3;
}

@keyframes meetPulse {
  0%, 100% {
    box-shadow: 0 2px 8px color-mix(in srgb, var(--accent-primary, #58a6ff) 40%, transparent);
    transform: scale(1);
  }
  50% {
    box-shadow: 0 4px 18px color-mix(in srgb, var(--accent-primary, #58a6ff) 70%, transparent);
    transform: scale(1.06);
  }
}

.onboarding-invite-meet:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent-primary, #58a6ff) 55%, transparent);
  filter: brightness(1.06);
}

.onboarding-invite-meet:active:not(:disabled) {
  transform: translateY(0);
}

/* 「稍后再说」：次要文字链接 */
.onboarding-invite-later {
  background: transparent;
  border: none;
  padding: 5px 8px;
  font-size: 13px;
  font-family: inherit;
  color: var(--text-muted);
  opacity: 0.75;
  cursor: pointer;
  transition: color 0.15s ease, opacity 0.15s ease;
}

.onboarding-invite-later:hover:not(:disabled) {
  opacity: 1;
  color: var(--text-secondary);
  text-decoration: underline;
}

.onboarding-invite-meet:disabled,
.onboarding-invite-later:disabled {
  opacity: 0.5;
  cursor: default;
}

@keyframes headerEnter {
  from {
    opacity: 0;
    transform: translateY(-10px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.logo-container {
  transition: transform 0.3s ease;
}

.logo-container:hover {
  transform: scale(1.05);
}

.logo-container:active {
  transform: scale(0.98);
}

.logo {
  display: flex;
  justify-content: center;
  align-items: center;
}

/* 动画落在这层不带滤镜的包裹上，drop-shadow 留在 img 上保持静态。
   带滤镜的元素自己做 transform 动画时每帧都要重算滤镜、走不了合成器；
   拆成两层后位移纯走合成器，而光晕依旧贴着旗鱼的轮廓。
   不能放 .logo 上：那一层会被 enter-done 强制 animation:none，动画会提前掐掉。 */
.logo-float {
  display: flex;
  will-change: transform;
  animation: float 3s ease-in-out infinite;
}

/* 首次运行：先浮动 3s，之后开始持续挥手——只要邀请还在（用户没点按钮）就一直挥。
   每轮「挥几下 + 停一拍」循环，像真的在打招呼。 */
.logo-float.is-greeting {
  transform-origin: 50% 88%;
  animation:
    float 3s ease-in-out 1,
    logoGreet 2.6s ease-in-out 3s infinite;
}

.sailfish-logo {
  width: 88px;
  height: 88px;
  object-fit: contain;
  filter: drop-shadow(0 4px 16px rgba(var(--accent-decorative-rgb), 0.4));
  transition: filter 0.3s ease;
}

.logo-container:hover .sailfish-logo {
  filter: drop-shadow(0 6px 30px rgba(var(--accent-decorative-rgb), 0.6));
}

@keyframes logoGreet {
  0% { transform: rotate(0deg); }
  7% { transform: rotate(-12deg); }
  14% { transform: rotate(11deg); }
  21% { transform: rotate(-9deg); }
  28% { transform: rotate(8deg); }
  35% { transform: rotate(-5deg); }
  42% { transform: rotate(0deg); }
  /* 42%~100% 停一拍再进入下一轮，避免无限抽动显得焦躁 */
  100% { transform: rotate(0deg); }
}

@keyframes float {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(0, -10px, 0); }
}

/* 纯色而非渐变：渐变文字一旦在某套主题下失效会整段透明变不可读，
   而 12 套主题里此前只验证过 dark / light 两套。
   字号则要给足——显得廉价的是渐变不是字号，两个一起砍会把底气也砍掉。 */
.welcome-title {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 4px 0;
  letter-spacing: -0.4px;
  white-space: nowrap;
}

.welcome-subtitle {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
  letter-spacing: 0.3px;
}

/* Section Title —— 与侧栏分组标签、设置面板分组标题同一套排版。
   不用 text-transform: uppercase：对中文是空操作，只会留下多余字距。 */
.section-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 10px 0;
  letter-spacing: 0.05em;
}

/* 查看示例入口 */
.examples-hint {
  display: flex;
  justify-content: center;
  margin-top: -4px;
  margin-bottom: 10px;
}

.examples-hint-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 4px;
  transition: color 0.15s ease;
  font-family: inherit;
}

.examples-hint-btn:hover {
  color: var(--text-primary);
}

/* Quick Start Cards */
.quick-start {
  margin-bottom: 18px;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.08s forwards;
  opacity: 0;
}

@keyframes sectionEnter {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 卡片容器：4 列等宽 grid 填满内容宽度，与输入框、最近连接左右对齐 */
.action-cards {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 14px;
}

@media (max-width: 640px) {
  .action-cards {
    grid-template-columns: 1fr;
    justify-items: center;
  }
  .action-card {
    width: min(280px, 100%);
  }
}

/* 静态态全中性（底色、边框、图标都不带色相），品牌色只在 hover 时透出一圈边框。
   卡片本体不再参与"氛围"——整屏的色彩预算留给真正的主行动（输入框）。 */
.action-card {
  --card-glow-color: var(--accent-decorative-primary);
  position: relative;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px 12px;
  cursor: pointer;
  /* 立体感交给卡片本体的高度阴影，而不是图标色块底下的彩色投影——
     后者是"悬浮的实体物件"观感的来源，但也是糖果色的重量来源。 */
  box-shadow: var(--shadow-sm);
  transition: transform 0.2s ease,
              border-color 0.2s ease,
              background 0.2s ease,
              box-shadow 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  /* 让内容定高度，不再硬撑出半屏空白 */
  min-width: 0;
  min-height: 104px;
  overflow: hidden;
  /* 入场动画只用 opacity，让 hover transform 正常工作 */
  animation: cardFadeIn 0.25s ease-out both;
}

/* 通过 :has() 让卡片继承自己图标的品牌色（不需要改模板加 class）。
   现在只用于 hover 的边框与极轻底色，静态态不透出任何色相。 */
.action-card:has(.card-icon.assistant) { --card-glow-color: var(--brand-assistant); }
.action-card:has(.card-icon.local) { --card-glow-color: var(--brand-local); }
.action-card:has(.card-icon.ssh) { --card-glow-color: var(--brand-ssh); }
.action-card:has(.card-icon.patrol) { --card-glow-color: var(--brand-patrol); }
.action-card:has(.card-icon.watch) { --card-glow-color: #f59e0b; }

.action-card:nth-child(1) { animation-delay: 0.10s; }
.action-card:nth-child(2) { animation-delay: 0.16s; }
.action-card:nth-child(3) { animation-delay: 0.22s; }
.action-card:nth-child(4) { animation-delay: 0.28s; }

@keyframes cardFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* hover：上浮 + 抬高阴影（这两者一起才有"被拿起来"的手感）+ 品牌色边框 + 极轻底色。
   边框宽度保持 1px 不变（1px→2px 会引起亚像素重排，内容跟着抖）。 */
.action-card:hover:not(.disabled) {
  border-color: var(--card-glow-color);
  transform: translateY(-3px);
  background: color-mix(in srgb, var(--card-glow-color) 5%, var(--bg-surface));
  box-shadow: var(--shadow-lg);
}

.action-card:active:not(.disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-xs);
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.action-card.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 线稿 + 品牌色前景，配一层极淡的同色底板。
   问题从来不是"有颜色"，而是色彩的载体：同一个色相铺在实心渐变块上是噪音，
   落在 1.5px 的线条上是点缀——识别性（紫=助手/绿=本地/蓝=SSH/橙=关切）留下，
   重量只有原来的零头。 */
.card-icon {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--card-glow-color);
  background: color-mix(in srgb, var(--card-glow-color) 12%, transparent);
  /* 发丝边给底板一个清晰轮廓——不靠加重底色就能站住 */
  border: 1px solid color-mix(in srgb, var(--card-glow-color) 24%, transparent);
  transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease;
}

/* 关切异常角标：定位在卡片右上角，像 app 图标角标一样自然 */
.watch-anomaly-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  background: #ef4444;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  box-shadow: 0 2px 8px rgba(239, 68, 68, 0.45);
  pointer-events: none;
  animation: badgePop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes badgePop {
  from { transform: scale(0.4); opacity: 0; }
  to   { transform: scale(1);   opacity: 1; }
}

.action-card:hover:not(.disabled) .card-icon {
  background: color-mix(in srgb, var(--card-glow-color) 20%, transparent);
  border-color: color-mix(in srgb, var(--card-glow-color) 40%, transparent);
  transform: scale(1.04);
}

/* 标题 hover 不再变色：
   hover 反馈已经由卡片上浮、图标放大、玻璃浮层、柔光描边合力表达，
   再给文字变色会在深色主题下形成"中性卡片 + 蓝色文字孤岛"的割裂感。
   保持 text-primary，让信息层级稳定、氛围内敛。 */
.card-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.card-desc {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.coming-soon-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  font-size: 10px;
  font-weight: 600;
  color: var(--brand-patrol);
  background: rgba(var(--brand-patrol-rgb), 0.1);
  padding: 2px 8px;
  border-radius: 4px;
}

/* Recent Sessions */
.recent-sessions {
  margin-bottom: 12px;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.2s forwards;
  opacity: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.section-header .section-title {
  margin-bottom: 0;
}

.session-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  box-shadow: var(--shadow-xs);
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  position: relative;
}

/* 与卡片 hover 同向：底色只能往"更浮起"走。
   原先 hover 换 --bg-tertiary，而它在多数主题里比 --bg-surface 更暗，
   手感上是"被按下去"，方向正好反了。 */
.session-item:hover {
  border-color: var(--brand-ssh);
  background: color-mix(in srgb, var(--brand-ssh) 5%, var(--bg-surface));
  box-shadow: var(--shadow-sm);
}

/* 与卡片图标同一套语言：线稿 + 淡底板。取 SSH 品牌色，
   和「SSH 连接」卡片形成呼应——这一组入口通向同一件事。 */
.session-icon {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--brand-ssh);
  background: color-mix(in srgb, var(--brand-ssh) 12%, transparent);
  flex-shrink: 0;
  transition: background 0.2s ease;
}

.session-item:hover .session-icon {
  background: color-mix(in srgb, var(--brand-ssh) 20%, transparent);
}

.session-info {
  flex: 1;
  min-width: 0;
}

/* 与 card-title 同理：hover 不变色，信息层级更稳，深色下不再出现蓝色文字孤岛。
   hover 反馈已经由 session-item 的背景变化 + 位移 + 图标饱和承担。 */
.session-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-host {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* "查看全部会话 →" 改为次级文本色：→ 箭头已经承担"可点击"信号，
   深色下不再是孤立的蓝色链接。hover 时提亮到 text-primary 表达可交互。 */
.view-all {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
}

.view-all:hover {
  color: var(--text-primary);
  background: rgba(var(--accent-decorative-rgb), 0.1);
  transform: translateX(4px);
}

/* Tips（仅 Steam 版）：与卡片同一套表面语言，不再用渐变底 + 闪光 + 缩放 */
.tips {
  padding: 12px 16px;
  margin-top: 38px;
  background: var(--bg-surface);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.2s ease;
  user-select: none;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.25s forwards;
  opacity: 0;
  position: relative;
}

.tips:hover {
  border-color: var(--accent-decorative-primary);
}

.tip-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-secondary);
  position: relative;
  z-index: 1;
}

.tip-icon {
  display: flex;
  flex-shrink: 0;
  color: var(--text-secondary);
}

/* 回首页时跳过入场动画（组件用 v-show 保持挂载，否则会反复重播） */
/* 注意：浮动 / 挥手动画都放在 .sailfish-logo（img）上而非 .logo——
   .logo 在此列表中，会被 enter-done 的 animation:none 拍死。 */
.welcome-page.enter-done .welcome-content,
.welcome-page.enter-done .welcome-header,
.welcome-page.enter-done .quick-start,
.welcome-page.enter-done .recent-sessions,
.welcome-page.enter-done .tips,
.welcome-page.enter-done .action-card,
.welcome-page.enter-done .logo {
  animation: none !important;
  opacity: 1 !important;
  transform: none !important;
}

@media (prefers-reduced-motion: reduce) {
  .logo,
  .logo-float,
  .logo-float.is-greeting,
  .onboarding-invite-meet {
    animation: none !important;
  }

  .greet-fade-enter-active,
  .greet-fade-leave-active {
    transition: none !important;
  }
}

.welcome-page.enter-done :deep(.welcome-chat-composer) {
  animation: none !important;
  opacity: 1 !important;
  transform: none !important;
}

.tip-text {
  flex: 1;
  line-height: 1.5;
}

/* ↻ 切换指示符：和 view-all 的 → 一致走次级文本色，
   深色下不出现孤立蓝色图标。 */
.tip-next {
  font-size: 16px;
  color: var(--text-secondary);
  opacity: 0;
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.tips:hover .tip-next {
  opacity: 0.8;
  transform: rotate(180deg);
}
</style>

