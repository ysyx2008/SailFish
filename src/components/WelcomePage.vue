<script setup lang="ts">
/**
 * 欢迎页组件
 * 程序启动后显示，提供快速启动各类终端的入口
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore, type SshSession } from '../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

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
        <div class="logo-container">
          <div class="logo">🐟</div>
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
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="4" width="20" height="16" rx="2"/>
                <path d="M6 9l3 3-3 3"/>
                <path d="M11 15h5"/>
              </svg>
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.localTerminal') }}</div>
              <div class="card-desc">{{ t('welcome.localTerminalDesc') }}</div>
            </div>
          </div>

          <!-- SSH 连接 -->
          <div class="action-card" @click="openSessionManager">
            <div class="card-icon ssh">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8"/>
                <path d="M12 17v4"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
            </div>
            <div class="card-content">
              <div class="card-title">{{ t('welcome.sshConnect') }}</div>
              <div class="card-desc">{{ t('welcome.sshConnectDesc') }}</div>
            </div>
          </div>

          <!-- 智能巡检（暂时隐藏）
          <div class="action-card" @click="openSmartPatrol">
            <div class="card-icon patrol">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                <circle cx="7.5" cy="14.5" r="1.5"/>
                <circle cx="16.5" cy="14.5" r="1.5"/>
              </svg>
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8"/>
                <path d="M12 17v4"/>
              </svg>
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
  </div>
</template>

<style scoped>
.welcome-page {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  overflow-y: auto;
  padding: 40px 20px;
}

.welcome-content {
  max-width: 720px;
  width: 100%;
  margin: auto;
}

/* Header */
.welcome-header {
  text-align: center;
  margin-bottom: 48px;
}

.logo-container {
  margin-bottom: 16px;
}

.logo {
  font-size: 64px;
  line-height: 1;
  filter: drop-shadow(0 4px 12px rgba(59, 130, 246, 0.3));
  animation: float 3s ease-in-out infinite;
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}

.welcome-title {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px 0;
  letter-spacing: -0.5px;
}

.welcome-subtitle {
  font-size: 15px;
  color: var(--text-muted);
  margin: 0;
}

/* Section Title */
.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

/* Quick Start Cards */
.quick-start {
  margin-bottom: 40px;
}

.action-cards {
  display: flex;
  justify-content: center;
  gap: 16px;
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
  border-radius: 16px;
  padding: 24px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 12px;
  width: 180px;
  height: 180px;
  flex-shrink: 0;
}

.action-card:hover:not(.disabled) {
  border-color: var(--accent-primary);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
}

.action-card.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.card-icon {
  width: 56px;
  height: 56px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
}

.card-icon.local {
  background: linear-gradient(135deg, #10b981, #059669);
}

.card-icon.ssh {
  background: linear-gradient(135deg, #3b82f6, #2563eb);
}

.card-icon.patrol {
  background: linear-gradient(135deg, #8b5cf6, #7c3aed);
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.card-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
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
  margin-bottom: 32px;
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
  gap: 10px;
}

.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.session-item:hover {
  border-color: var(--accent-primary);
  background: var(--bg-tertiary);
}

.session-icon {
  width: 32px;
  height: 32px;
  background: rgba(59, 130, 246, 0.1);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #3b82f6;
  flex-shrink: 0;
}

.session-info {
  flex: 1;
  min-width: 0;
}

.session-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-host {
  font-size: 11px;
  color: var(--text-muted);
  font-family: 'SF Mono', Monaco, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.view-all {
  font-size: 13px;
  color: var(--accent-primary);
  cursor: pointer;
  transition: opacity 0.15s ease;
  white-space: nowrap;
}

.view-all:hover {
  opacity: 0.8;
}

/* Tips */
.tips {
  padding: 16px;
  background: rgba(59, 130, 246, 0.05);
  border: 1px solid rgba(59, 130, 246, 0.1);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.tips:hover {
  background: rgba(59, 130, 246, 0.08);
  border-color: rgba(59, 130, 246, 0.2);
}

.tips:active {
  transform: scale(0.99);
}

.tip-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.tip-icon {
  font-size: 16px;
  flex-shrink: 0;
}

.tip-text {
  flex: 1;
  transition: opacity 0.15s ease;
}

.tip-next {
  font-size: 14px;
  color: var(--text-muted);
  opacity: 0;
  transition: opacity 0.2s ease;
  flex-shrink: 0;
}

.tips:hover .tip-next {
  opacity: 0.6;
}
</style>

