<script setup lang="ts">
/**
 * 欢迎页组件
 * 程序启动后显示，提供快速启动各类终端的入口
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SquareTerminal, Monitor } from 'lucide-vue-next'
import { useConfigStore, type SshSession } from '../stores/config'
import MatrixRain from './EasterEgg/MatrixRain.vue'
import sailfishLogo from '../../resources/logo.png'

const { t } = useI18n()
const configStore = useConfigStore()

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

// 随机选择一条 tip 显示，支持点击切换
const tipKeys = [
  'tip1', 'tip2', 'tip3', 'tip4', 'tip5', 'tip6', 'tip7', 'tip8', 'tip9', 'tip10',
  'tip11', 'tip12', 'tip13', 'tip14', 'tip15', 'tip16', 'tip17', 'tip18', 'tip19', 'tip20',
  'tip21', 'tip22', 'tip23', 'tip24', 'tip25', 'tip26', 'tip27', 'tip28', 'tip29', 'tip30'
]
const currentTipIndex = ref(Math.floor(Math.random() * tipKeys.length))
const currentTip = computed(() => t(`welcome.${tipKeys[currentTipIndex.value]}`))

// 点击切换到下一条 tip
const nextTip = () => {
  currentTipIndex.value = (currentTipIndex.value + 1) % tipKeys.length
}

const emit = defineEmits<{
  'open-local': []
  'open-ssh': [session: SshSession]
  'open-session-manager': []
  'open-smart-patrol': []
}>()

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
</script>

<template>
  <div class="welcome-page">
    <div class="welcome-content">
      <!-- Logo 和标题 -->
      <div class="welcome-header">
        <div class="logo-container" @click="handleLogoClick">
          <div class="logo">
            <img :src="sailfishLogo" alt="Sailfish" class="sailfish-logo" />
          </div>
        </div>
        <h1 class="welcome-title">{{ t('welcome.title') }}</h1>
        <p class="welcome-subtitle">{{ t('welcome.subtitle') }}</p>
      </div>

      <!-- 快速启动卡片 -->
      <div class="quick-start">
        <h2 class="section-title">{{ t('welcome.quickStart') }}</h2>
        <div class="action-cards">
          <!-- 本地终端 -->
          <div class="action-card" @click="openLocalTerminal">
            <div class="card-icon local">
              <SquareTerminal :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.localTerminal') }}</div>
              <div class="card-desc">{{ t('welcome.localTerminalDesc') }}</div>
            </div>
          </div>

          <!-- SSH 连接 -->
          <div class="action-card" @click="openSessionManager">
            <div class="card-icon ssh">
              <Monitor :size="32" :stroke-width="1.5" />
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.sshConnect') }}</div>
              <div class="card-desc">{{ t('welcome.sshConnectDesc') }}</div>
            </div>
          </div>

          <!-- 智能巡检（暂时隐藏）
          <div class="action-card" @click="openSmartPatrol">
            <div class="card-icon patrol">
              <Bot :size="32" :stroke-width="1.5" />
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
      <div v-if="hasSessions" class="recent-sessions">
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

      <!-- 提示信息 -->
      <div class="tips" @click="nextTip" title="点击切换提示">
        <div class="tip-item">
          <span class="tip-icon">💡</span>
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
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  overflow-y: auto;
  padding: 24px 20px;
}

/* 深色主题：微妙的渐变背景 */
[data-color-scheme="dark"] .welcome-page {
  background: 
    radial-gradient(ellipse at 30% 20%, rgba(var(--accent-rgb, 137, 180, 250), 0.08) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 80%, rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.05) 0%, transparent 50%),
    var(--bg-primary);
}

/* 浅色主题：更柔和的渐变 */
[data-color-scheme="light"] .welcome-page {
  background: 
    radial-gradient(ellipse at 30% 20%, rgba(var(--accent-rgb, 0, 120, 212), 0.04) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 80%, rgba(var(--accent-secondary-rgb, 16, 110, 190), 0.03) 0%, transparent 50%),
    var(--bg-primary);
}

.welcome-content {
  max-width: 720px;
  width: 100%;
  margin: auto;
  /* 入场动画 */
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
  text-align: center;
  margin-bottom: 32px;
  animation: headerEnter 0.35s cubic-bezier(0.16, 1, 0.3, 1) 0.05s forwards;
  opacity: 0;
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
  margin-bottom: 16px;
  cursor: pointer;
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
  animation: float 3s ease-in-out infinite;
}

.sailfish-logo {
  width: 80px;
  height: 80px;
  object-fit: contain;
  filter: drop-shadow(0 4px 16px rgba(var(--accent-rgb, 59, 130, 246), 0.4));
  transition: filter 0.3s ease;
}

.logo-container:hover .sailfish-logo {
  filter: drop-shadow(0 6px 30px rgba(var(--accent-rgb, 59, 130, 246), 0.6));
}

@keyframes float {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-6px) rotate(1deg); }
  50% { transform: translateY(-10px) rotate(0deg); }
  75% { transform: translateY(-6px) rotate(-1deg); }
}

.welcome-title {
  font-size: 28px;
  font-weight: 800;
  color: var(--text-primary);
  margin: 0 0 8px 0;
  letter-spacing: -0.5px;
  /* 渐变文字效果 */
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-primary) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

/* 浅色主题：调整标题渐变 */
[data-color-scheme="light"] .welcome-title {
  background: linear-gradient(135deg, var(--text-primary) 20%, var(--accent-primary) 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.welcome-subtitle {
  font-size: 15px;
  color: var(--text-muted);
  margin: 0;
  opacity: 0.9;
}

/* Section Title */
.section-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  text-transform: uppercase;
  letter-spacing: 1px;
  opacity: 0.8;
}

/* Quick Start Cards */
.quick-start {
  margin-bottom: 28px;
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

.action-cards {
  display: flex;
  justify-content: center;
  gap: 20px;
}

@media (max-width: 640px) {
  .action-cards {
    flex-direction: column;
    align-items: center;
  }
}

.action-card {
  position: relative;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 20px;
  padding: 28px;
  cursor: pointer;
  transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), 
              border-color 0.3s ease, 
              border-width 0.3s ease,
              box-shadow 0.3s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
  width: 170px;
  height: 165px;
  flex-shrink: 0;
  overflow: hidden;
  /* 入场动画只用 opacity，让 hover transform 正常工作 */
  animation: cardFadeIn 0.25s ease-out both;
}

.action-card:nth-child(1) { animation-delay: 0.12s; }
.action-card:nth-child(2) { animation-delay: 0.18s; }
.action-card:nth-child(3) { animation-delay: 0.24s; }

@keyframes cardFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* 卡片悬停发光效果 */
.action-card::before {
  content: '';
  position: absolute;
  inset: -2px;
  border-radius: 22px;
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  opacity: 0;
  z-index: -1;
  transition: opacity 0.3s ease;
}

.action-card:hover:not(.disabled)::before {
  opacity: 0.5;
}

/* 卡片内部光晕 */
.action-card::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at center, rgba(255,255,255,0.05) 0%, transparent 60%);
  opacity: 0;
  transition: opacity 0.3s ease;
  pointer-events: none;
}

.action-card:hover:not(.disabled)::after {
  opacity: 1;
}

.action-card:hover:not(.disabled) {
  border-color: var(--accent-primary);
  border-width: 3px;
  transform: translateY(-8px) scale(1.06);
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.2),
    0 0 30px rgba(var(--accent-rgb, 137, 180, 250), 0.2);
}

.action-card:active:not(.disabled) {
  transform: translateY(-2px) scale(0.97);
  transition: transform 0.15s ease;
}

.action-card.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.card-icon {
  width: 60px;
  height: 60px;
  min-width: 60px;
  min-height: 60px;
  flex-shrink: 0;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.action-card:hover:not(.disabled) .card-icon {
  transform: scale(1.06) translateY(-3px);
  box-shadow: 0 12px 25px rgba(0, 0, 0, 0.35);
}

.card-icon.local {
  background: linear-gradient(135deg, #10b981, #059669);
  box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);
}

.card-icon.ssh {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
  box-shadow: 0 4px 15px rgba(59, 130, 246, 0.3);
}

.card-icon.patrol {
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  box-shadow: 0 4px 15px rgba(139, 92, 246, 0.3);
}

.card-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
  transition: color 0.2s ease;
}

.action-card:hover:not(.disabled) .card-title {
  color: var(--accent-primary);
}

.card-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.coming-soon-badge {
  position: absolute;
  top: 12px;
  right: 12px;
  font-size: 10px;
  font-weight: 600;
  color: #8b5cf6;
  background: rgba(139, 92, 246, 0.1);
  padding: 2px 8px;
  border-radius: 4px;
}

/* Recent Sessions */
.recent-sessions {
  margin-bottom: 20px;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.2s forwards;
  opacity: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.section-header .section-title {
  margin-bottom: 0;
}

.session-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  position: relative;
  overflow: hidden;
}

/* 会话卡片光效 */
.session-item::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
  transition: left 0.5s ease;
}

.session-item:hover::before {
  left: 100%;
}

.session-item:hover {
  border-color: var(--accent-primary);
  background: var(--bg-tertiary);
  transform: translateX(4px);
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
}

.session-icon {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(59, 130, 246, 0.1));
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent-primary);
  flex-shrink: 0;
  transition: transform 0.2s ease, background 0.2s ease;
}

.session-item:hover .session-icon {
  transform: scale(1.1);
  background: linear-gradient(135deg, var(--accent-primary), var(--accent-secondary));
  color: white;
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}

.session-item:hover .session-name {
  color: var(--accent-primary);
}

.session-host {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.view-all {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent-primary);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
  padding: 4px 8px;
  border-radius: 6px;
}

.view-all:hover {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.1);
  transform: translateX(4px);
}

/* Tips */
.tips {
  padding: 12px 16px;
  margin-top: 38px;
  background: linear-gradient(135deg, rgba(var(--accent-rgb, 59, 130, 246), 0.08), rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.05));
  border: 1px solid rgba(var(--accent-rgb, 59, 130, 246), 0.15);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.3s ease;
  user-select: none;
  animation: sectionEnter 0.3s cubic-bezier(0.16, 1, 0.3, 1) 0.25s forwards;
  opacity: 0;
  position: relative;
  overflow: hidden;
}

/* 提示框闪光效果 */
.tips::after {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 30%, rgba(255,255,255,0.1) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.tips:hover::after {
  opacity: 1;
}

.tips:hover {
  background: linear-gradient(135deg, rgba(var(--accent-rgb, 59, 130, 246), 0.12), rgba(var(--accent-secondary-rgb, 116, 199, 236), 0.08));
  border-color: rgba(var(--accent-rgb, 59, 130, 246), 0.25);
  transform: scale(1.01);
  box-shadow: 0 4px 20px rgba(var(--accent-rgb, 59, 130, 246), 0.1);
}

.tips:active {
  transform: scale(0.99);
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
  font-size: 18px;
  flex-shrink: 0;
  animation: tipPulse 2s ease-in-out infinite;
}

@keyframes tipPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

.tip-text {
  flex: 1;
  line-height: 1.5;
}

.tip-next {
  font-size: 16px;
  color: var(--accent-primary);
  opacity: 0;
  transition: all 0.3s ease;
  flex-shrink: 0;
}

.tips:hover .tip-next {
  opacity: 0.8;
  transform: rotate(180deg);
}
</style>

