<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
import { oemConfig } from '../../config/oem.config'
import { getLocale } from '../../i18n'
import AiSettings from './AiSettings.vue'
import ThemeSettings from './ThemeSettings.vue'
import TerminalSettings from './TerminalSettings.vue'
import DataSettings from './DataSettings.vue'
import McpSettings from './McpSettings.vue'
import KnowledgeSettings from './KnowledgeSettings.vue'
import LanguageSettings from './LanguageSettings.vue'

const { t } = useI18n()

// Props
const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{
  close: []
  restartSetup: []
}>()

const configStore = useConfigStore()

type SettingsTab = 'ai' | 'mcp' | 'knowledge' | 'theme' | 'terminal' | 'data' | 'language' | 'about'
const activeTab = ref<SettingsTab>('ai')
const appVersion = ref<string>('')
const showConfirmDialog = ref(false)
const showUnlockAnimation = ref(false)

// 品牌信息
const brandName = computed(() => {
  const locale = getLocale()
  return locale === 'zh-CN' ? oemConfig.brand.name.zh : oemConfig.brand.name.en
})

const brandCopyright = computed(() => {
  const locale = getLocale()
  return locale === 'zh-CN' ? oemConfig.brand.copyright.zh : oemConfig.brand.copyright.en
})

const brandLogo = computed(() => oemConfig.brand.logo)

// 赞助状态
const isSponsor = computed(() => configStore.isSponsor)
const showSponsor = computed(() => oemConfig.features.showSponsor)
const showFireworks = ref(false)

// 确认支持
const handleConfirmSupport = async () => {
  showConfirmDialog.value = false
  await configStore.setSponsorStatus(true)
  showUnlockAnimation.value = true
  showFireworks.value = true
  // 延长庆祝时间，让用户充分感受
  setTimeout(() => {
    showUnlockAnimation.value = false
  }, 4000)
  // 烟花持续 6 秒
  setTimeout(() => {
    showFireworks.value = false
  }, 6000)
}

// 重置赞助状态（用于测试）
const resetSponsorStatus = async () => {
  if (confirm(t('sponsor.resetConfirm'))) {
    await configStore.setSponsorStatus(false)
  }
}

// 初始化时设置初始 tab 和获取版本号
onMounted(async () => {
  if (props.initialTab && ['ai', 'mcp', 'knowledge', 'theme', 'terminal', 'data', 'language', 'about'].includes(props.initialTab)) {
    activeTab.value = props.initialTab as SettingsTab
  }
  // 获取应用版本号
  appVersion.value = await window.electronAPI.app.getVersion()
})

const tabs = computed(() => [
  { id: 'ai' as const, label: t('settings.tabs.ai'), icon: '🤖' },
  { id: 'mcp' as const, label: t('settings.tabs.mcp'), icon: '🔌' },
  { id: 'knowledge' as const, label: t('settings.tabs.knowledge'), icon: '📚' },
  { id: 'theme' as const, label: t('settings.tabs.theme'), icon: '🎨' },
  { id: 'terminal' as const, label: t('settings.tabs.terminal'), icon: '⚙️' },
  { id: 'data' as const, label: t('settings.tabs.data'), icon: '💾' },
  { id: 'language' as const, label: t('settings.tabs.language'), icon: '🌐' },
  { id: 'about' as const, label: t('settings.tabs.about'), icon: 'ℹ️' }
])

const restartSetup = async () => {
  if (confirm(t('settings.restartSetupConfirm'))) {
    await configStore.setSetupCompleted(false)
    emit('restartSetup')
    emit('close')
  }
}

// 处理收款码图片加载失败
const onQrImageError = (event: Event) => {
  const img = event.target as HTMLImageElement
  img.style.display = 'none'
  // 在图片位置显示占位符
  const placeholder = document.createElement('div')
  placeholder.className = 'qr-placeholder'
  placeholder.textContent = '📷'
  img.parentElement?.insertBefore(placeholder, img)
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <!-- 全屏烟花效果 -->
    <div v-if="showFireworks" class="fireworks-container">
      <div class="firework" v-for="i in 12" :key="i" :style="{ '--i': i }">
        <div class="firework-particle" v-for="j in 12" :key="j" :style="{ '--j': j }"></div>
      </div>
    </div>
    <div class="settings-modal">
      <div class="settings-header">
        <h2>{{ t('settings.title') }}</h2>
        <button class="btn-icon" @click="emit('close')" :title="t('settings.closeSettings')">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="settings-body">
        <nav class="settings-nav">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="nav-item"
            :class="{ active: activeTab === tab.id }"
            @click="activeTab = tab.id"
          >
            <span class="nav-icon">{{ tab.icon }}</span>
            <span>{{ tab.label }}</span>
          </button>
        </nav>
        <div class="settings-content">
          <AiSettings v-if="activeTab === 'ai'" />
          <McpSettings v-else-if="activeTab === 'mcp'" />
          <KnowledgeSettings v-else-if="activeTab === 'knowledge'" />
          <ThemeSettings v-else-if="activeTab === 'theme'" />
          <TerminalSettings v-else-if="activeTab === 'terminal'" />
          <DataSettings v-else-if="activeTab === 'data'" />
          <LanguageSettings v-else-if="activeTab === 'language'" />
          <div v-else-if="activeTab === 'about'" class="about-content">
            <div class="about-logo">{{ brandLogo }}</div>
            <h3>{{ brandName }}</h3>
            <p class="version">{{ t('common.version') }} {{ oemConfig.brand.version || appVersion }}</p>
            <p class="description">
              {{ t('about.description') }}
            </p>
            <div class="about-links">
              <a href="mailto:nuoyan_cfan@163.com" class="about-link">{{ t('about.contact') }}</a>
              <a href="www.gnu.org/licenses/agpl-3.0.html" target="_blank" class="about-link">{{ t('about.license') }}</a>
            </div>
            
            <!-- 赞助者徽章（放大醒目版） -->
            <div v-if="showSponsor && isSponsor" class="sponsor-badge sponsor-badge-large">
              <span class="badge-icon">✨</span>
              <span class="badge-text">{{ t('sponsor.badge') }}</span>
              <!-- 常驻彩带效果 -->
              <div class="badge-confetti">
                <div class="mini-confetti" v-for="i in 8" :key="i" :style="{ '--i': i }"></div>
              </div>
            </div>
            
            <!-- 赞助支持部分 -->
            <div v-if="showSponsor" class="support-section" :class="{ 'sponsor-mode': isSponsor }">
              <div class="support-divider"></div>
              <h4 class="support-title">☕ {{ t('about.supportTitle') }}</h4>
              <p class="support-description">{{ t('about.supportDescription') }}</p>
              
              <!-- 收款码（赞助者模式下也保留显示） -->
              <div class="qr-codes" :class="{ 'qr-codes-small': isSponsor }">
                <div class="qr-code-item">
                  <div class="qr-wrapper wechat">
                    <img src="../../assets/wechat-pay.png" alt="WeChat Pay" class="qr-image" @error="onQrImageError" />
                    <div class="qr-hover-heart">❤️</div>
                  </div>
                  <span class="qr-label">💚 {{ t('about.wechatPay') }}</span>
                </div>
                <div class="qr-code-item">
                  <div class="qr-wrapper alipay">
                    <img src="../../assets/alipay.png" alt="Alipay" class="qr-image" @error="onQrImageError" />
                    <div class="qr-hover-heart">❤️</div>
                  </div>
                  <span class="qr-label">🔵 {{ t('about.alipay') }}</span>
                </div>
              </div>
              
              <!-- 我已支持按钮（仅非赞助者显示） -->
              <div v-if="!isSponsor" class="support-action">
                <button class="btn btn-primary sponsor-confirm-btn" @click="showConfirmDialog = true">
                  {{ t('sponsor.confirmButton') }}
                </button>
              </div>
              
              <!-- 感谢寄语 -->
              <div class="thanks-card" :class="{ 'unlocked': isSponsor, 'celebrating': showUnlockAnimation }">
                <!-- 庆祝彩带效果 -->
                <div v-if="showUnlockAnimation" class="confetti-container">
                  <div class="confetti" v-for="i in 20" :key="i" :style="{ '--i': i }"></div>
                </div>
                <div class="thanks-icon" :class="{ 'animate': showUnlockAnimation }">
                  {{ showUnlockAnimation ? '🎉' : '🎁' }}
                </div>
                <p class="thanks-message" :class="{ 'celebrate-text': showUnlockAnimation }">
                  {{ showUnlockAnimation ? '🎊 ' + t('sponsor.thanksUnlock') + ' 🎊' : t('about.thanksMessage') }}
                </p>
                <p v-if="!showUnlockAnimation" class="thanks-detail">{{ t('about.thanksDetail') }}</p>
                <div v-if="showUnlockAnimation" class="unlock-perks">
                  <span class="perk-item">✨ {{ t('sponsor.exclusive') }}{{ t('themeSettings.title') }}</span>
                  <span class="perk-item">🏅 {{ t('sponsor.badge') }}</span>
                </div>
              </div>
              
              <!-- 重置赞助状态（仅赞助者可见，用于测试） -->
              <button v-if="isSponsor" class="reset-sponsor-btn" @click="resetSponsorStatus">
                {{ t('sponsor.resetButton') }}
              </button>
            </div>
            
            <div class="about-actions">
              <button class="btn btn-outline" @click="restartSetup">
                🔄 {{ t('settings.restartSetup') }}
              </button>
            </div>
            <p class="copyright">
              {{ brandCopyright }}
            </p>
          </div>
          
          <!-- 确认支持弹窗 -->
          <div v-if="showConfirmDialog" class="confirm-dialog-overlay" @click.self="showConfirmDialog = false">
            <div class="confirm-dialog">
              <h3>{{ t('sponsor.confirmTitle') }}</h3>
              <p>{{ t('sponsor.confirmMessage') }}</p>
              <div class="dialog-actions">
                <button class="btn btn-outline" @click="showConfirmDialog = false">
                  {{ t('common.cancel') }}
                </button>
                <button class="btn btn-primary" @click="handleConfirmSupport">
                  {{ t('common.confirm') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.2s ease;
}

.settings-modal {
  width: 750px;
  max-width: 90vw;
  height: 560px;
  max-height: 85vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: slideIn 0.2s ease;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.settings-header h2 {
  font-size: 18px;
  font-weight: 600;
}

.settings-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.settings-nav {
  width: 180px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-right: 1px solid var(--border-color);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  text-align: left;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--accent-primary);
  color: var(--bg-primary);
}

.nav-icon {
  font-size: 16px;
}

.settings-content {
  flex: 1;
  padding: 20px;
  overflow-y: auto;
}

/* 关于页面 */
.about-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding-top: 20px;
  padding-bottom: 20px;
}

.about-logo {
  font-size: 64px;
  margin-bottom: 16px;
}

.about-content h3 {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 8px;
}

.version {
  color: var(--text-muted);
  font-size: 14px;
  margin-bottom: 16px;
}

.description {
  color: var(--text-secondary);
  font-size: 14px;
  max-width: 300px;
  margin-bottom: 24px;
}

.about-links {
  display: flex;
  gap: 20px;
  margin-bottom: 24px;
}

.about-link {
  color: var(--accent-primary);
  text-decoration: none;
  font-size: 13px;
}

.about-link:hover {
  text-decoration: underline;
}

.producer {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 12px;
}

.about-actions {
  margin: 24px 0;
}

.about-actions .btn {
  padding: 8px 16px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.about-actions .btn:hover {
  background: var(--bg-hover);
}

.btn-outline {
  background: transparent;
}

.copyright {
  color: var(--text-muted);
  font-size: 12px;
}

/* 赞助支持部分样式 */
.support-section {
  width: 100%;
  max-width: 400px;
  margin: 16px 0;
}

.support-divider {
  width: 100%;
  height: 1px;
  background: var(--border-color);
  margin: 16px 0;
}

.support-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 8px;
  color: var(--text-primary);
}

.support-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}

.qr-codes {
  display: flex;
  justify-content: center;
  gap: 32px;
  margin-bottom: 20px;
}

.qr-code-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.qr-wrapper {
  position: relative;
  border-radius: 12px;
  padding: 6px;
  transition: all 0.3s ease;
  cursor: pointer;
}

.qr-wrapper.wechat {
  background: linear-gradient(135deg, #07c160 0%, #2aae67 100%);
}

.qr-wrapper.alipay {
  background: linear-gradient(135deg, #1677ff 0%, #4096ff 100%);
}

.qr-wrapper:hover {
  transform: scale(1.05) translateY(-4px);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.15);
}

.qr-wrapper:hover .qr-hover-heart {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}

.qr-hover-heart {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.5);
  font-size: 32px;
  opacity: 0;
  transition: all 0.3s ease;
  pointer-events: none;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2));
  animation: heartPulse 1.5s ease-in-out infinite;
}

@keyframes heartPulse {
  0%, 100% { transform: translate(-50%, -50%) scale(1); }
  50% { transform: translate(-50%, -50%) scale(1.15); }
}

.qr-image {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  object-fit: contain;
  background: white;
  display: block;
}

.qr-placeholder {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  border: 1px dashed var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.qr-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* 感谢卡片 */
.thanks-card {
  background: linear-gradient(135deg, rgba(255, 107, 107, 0.08) 0%, rgba(255, 159, 67, 0.08) 100%);
  border: 1px solid rgba(255, 107, 107, 0.2);
  border-radius: 12px;
  padding: 16px 20px;
  text-align: center;
  margin-top: 8px;
}

.thanks-icon {
  font-size: 28px;
  margin-bottom: 8px;
  animation: giftBounce 2s ease-in-out infinite;
}

@keyframes giftBounce {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  25% { transform: translateY(-4px) rotate(-5deg); }
  75% { transform: translateY(-4px) rotate(5deg); }
}

.thanks-message {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 6px 0;
}

.thanks-detail {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.thanks-card.unlocked {
  background: linear-gradient(135deg, rgba(255, 215, 0, 0.15) 0%, rgba(255, 165, 0, 0.15) 100%);
  border-color: rgba(255, 215, 0, 0.3);
}

.thanks-card.celebrating {
  background: linear-gradient(135deg, rgba(255, 215, 0, 0.25) 0%, rgba(255, 165, 0, 0.25) 100%);
  border-color: rgba(255, 215, 0, 0.5);
  animation: cardGlow 1s ease-in-out infinite alternate;
  position: relative;
  overflow: hidden;
}

@keyframes cardGlow {
  from {
    box-shadow: 0 0 10px rgba(255, 215, 0, 0.3), 0 0 20px rgba(255, 165, 0, 0.2);
  }
  to {
    box-shadow: 0 0 20px rgba(255, 215, 0, 0.5), 0 0 40px rgba(255, 165, 0, 0.3);
  }
}

/* 彩带容器 */
.confetti-container {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.confetti {
  position: absolute;
  width: 10px;
  height: 10px;
  top: -10px;
  left: calc(var(--i) * 5%);
  animation: confettiFall 3s ease-out forwards;
  animation-delay: calc(var(--i) * 0.1s);
}

.confetti:nth-child(odd) {
  background: #ffd700;
  border-radius: 50%;
}

.confetti:nth-child(even) {
  background: #ff6b6b;
  transform: rotate(45deg);
}

.confetti:nth-child(3n) {
  background: #4ecdc4;
  border-radius: 2px;
}

.confetti:nth-child(4n) {
  background: #ff9f43;
  width: 8px;
  height: 8px;
}

@keyframes confettiFall {
  0% {
    transform: translateY(0) rotate(0deg) scale(0);
    opacity: 1;
  }
  20% {
    transform: translateY(20px) rotate(90deg) scale(1);
    opacity: 1;
  }
  100% {
    transform: translateY(150px) rotate(720deg) scale(0.5);
    opacity: 0;
  }
}

.thanks-icon.animate {
  animation: unlockCelebrate 1s ease-out;
  font-size: 36px;
}

@keyframes unlockCelebrate {
  0% { transform: scale(0) rotate(-180deg); opacity: 0; }
  50% { transform: scale(1.4) rotate(10deg); opacity: 1; }
  70% { transform: scale(0.9) rotate(-5deg); }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}

.celebrate-text {
  font-size: 16px !important;
  font-weight: 700 !important;
  background: linear-gradient(90deg, #ffd700, #ff6b6b, #ffd700);
  background-size: 200% auto;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: shimmer 2s linear infinite;
}

@keyframes shimmer {
  to {
    background-position: 200% center;
  }
}

.unlock-perks {
  display: flex;
  gap: 12px;
  justify-content: center;
  margin-top: 12px;
  animation: fadeInUp 0.5s ease-out 0.3s both;
}

.perk-item {
  padding: 6px 12px;
  background: rgba(255, 215, 0, 0.2);
  border: 1px solid rgba(255, 215, 0, 0.4);
  border-radius: 16px;
  font-size: 12px;
  font-weight: 600;
  color: #ffd700;
  animation: perkPop 0.4s ease-out backwards;
}

.perk-item:nth-child(1) { animation-delay: 0.5s; }
.perk-item:nth-child(2) { animation-delay: 0.7s; }

@keyframes perkPop {
  0% { transform: scale(0); opacity: 0; }
  70% { transform: scale(1.1); }
  100% { transform: scale(1); opacity: 1; }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 赞助者徽章 */
.sponsor-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: linear-gradient(135deg, rgba(255, 215, 0, 0.25) 0%, rgba(255, 165, 0, 0.25) 100%);
  border: 1px solid rgba(255, 215, 0, 0.5);
  border-radius: 20px;
  margin-bottom: 16px;
  animation: badgeAppear 0.6s ease-out, badgeShine 3s ease-in-out infinite;
  position: relative;
  overflow: hidden;
}

.sponsor-badge::before {
  content: '';
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
  animation: badgeSweep 3s ease-in-out infinite;
}

@keyframes badgeAppear {
  0% { transform: scale(0) rotate(-10deg); opacity: 0; }
  60% { transform: scale(1.1) rotate(3deg); }
  100% { transform: scale(1) rotate(0deg); opacity: 1; }
}

@keyframes badgeShine {
  0%, 100% { box-shadow: 0 0 10px rgba(255, 215, 0, 0.3); }
  50% { box-shadow: 0 0 20px rgba(255, 215, 0, 0.5), 0 0 30px rgba(255, 165, 0, 0.3); }
}

@keyframes badgeSweep {
  0%, 100% { left: -100%; }
  50% { left: 100%; }
}

.badge-icon {
  font-size: 16px;
  animation: badgeIconPulse 2s ease-in-out infinite;
}

@keyframes badgeIconPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.2); }
}

.badge-text {
  font-size: 13px;
  font-weight: 600;
  color: #ffd700;
  text-shadow: 0 0 10px rgba(255, 215, 0, 0.5);
}

/* 支持按钮 */
.support-action {
  margin: 16px 0;
  text-align: center;
}

.sponsor-confirm-btn {
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 600;
  background: linear-gradient(135deg, #ffd700 0%, #ffa500 100%);
  color: #1a1a1a;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.3s ease;
}

.sponsor-confirm-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 16px rgba(255, 215, 0, 0.3);
}

/* 确认弹窗 */
.confirm-dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  animation: fadeIn 0.2s ease;
}

.confirm-dialog {
  background: var(--bg-secondary);
  border-radius: 12px;
  padding: 24px;
  max-width: 400px;
  width: 90%;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
  animation: slideIn 0.3s ease;
}

.confirm-dialog h3 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-primary);
}

.confirm-dialog p {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 20px;
  line-height: 1.6;
}

.dialog-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

.dialog-actions .btn {
  padding: 8px 16px;
  font-size: 14px;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideIn {
  from {
    transform: translateY(-20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* 全屏烟花效果 */
.fireworks-container {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 3000;
  overflow: hidden;
}

.firework {
  position: absolute;
  bottom: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  animation: fireworkLaunch 1.5s ease-out forwards;
  animation-delay: calc(var(--i) * 0.3s);
}

.firework:nth-child(1) { left: 10%; --color: #ffd700; }
.firework:nth-child(2) { left: 20%; --color: #ff6b6b; }
.firework:nth-child(3) { left: 30%; --color: #4ecdc4; }
.firework:nth-child(4) { left: 40%; --color: #a855f7; }
.firework:nth-child(5) { left: 50%; --color: #ffd700; }
.firework:nth-child(6) { left: 60%; --color: #ff9f43; }
.firework:nth-child(7) { left: 70%; --color: #ff6b6b; }
.firework:nth-child(8) { left: 80%; --color: #4ecdc4; }
.firework:nth-child(9) { left: 15%; --color: #a855f7; }
.firework:nth-child(10) { left: 45%; --color: #ffd700; }
.firework:nth-child(11) { left: 65%; --color: #ff9f43; }
.firework:nth-child(12) { left: 85%; --color: #ff6b6b; }

@keyframes fireworkLaunch {
  0% {
    transform: translateY(0) scale(1);
    opacity: 1;
    background: var(--color);
    box-shadow: 0 0 6px var(--color);
  }
  50% {
    transform: translateY(-50vh) scale(1);
    opacity: 1;
  }
  60% {
    transform: translateY(-55vh) scale(0);
    opacity: 0;
  }
  100% {
    transform: translateY(-55vh) scale(0);
    opacity: 0;
  }
}

.firework-particle {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color);
  opacity: 0;
  animation: fireworkExplode 1.5s ease-out forwards;
  animation-delay: calc(var(--i) * 0.3s + 0.75s);
}

.firework-particle:nth-child(1) { --angle: 0deg; --distance: 80px; }
.firework-particle:nth-child(2) { --angle: 30deg; --distance: 90px; }
.firework-particle:nth-child(3) { --angle: 60deg; --distance: 70px; }
.firework-particle:nth-child(4) { --angle: 90deg; --distance: 85px; }
.firework-particle:nth-child(5) { --angle: 120deg; --distance: 75px; }
.firework-particle:nth-child(6) { --angle: 150deg; --distance: 95px; }
.firework-particle:nth-child(7) { --angle: 180deg; --distance: 80px; }
.firework-particle:nth-child(8) { --angle: 210deg; --distance: 70px; }
.firework-particle:nth-child(9) { --angle: 240deg; --distance: 90px; }
.firework-particle:nth-child(10) { --angle: 270deg; --distance: 85px; }
.firework-particle:nth-child(11) { --angle: 300deg; --distance: 75px; }
.firework-particle:nth-child(12) { --angle: 330deg; --distance: 80px; }

@keyframes fireworkExplode {
  0% {
    transform: translate(0, -55vh) scale(1);
    opacity: 1;
    box-shadow: 0 0 6px var(--color), 0 0 12px var(--color);
  }
  100% {
    transform: translate(
      calc(cos(var(--angle)) * var(--distance)),
      calc(-55vh + sin(var(--angle)) * var(--distance) + 40px)
    ) scale(0);
    opacity: 0;
  }
}

/* 赞助者模式下的样式弱化 */
.support-section.sponsor-mode .support-title {
  font-size: 13px;
  color: var(--text-muted);
  opacity: 0.7;
}

.support-section.sponsor-mode .support-description {
  font-size: 11px;
  color: var(--text-muted);
  opacity: 0.6;
}

/* 赞助者模式下二维码缩小 */
.qr-codes-small {
  transform: scale(0.75);
  transform-origin: center;
  margin: -10px 0;
  opacity: 0.85;
}

.qr-codes-small .qr-image {
  width: 100px;
  height: 100px;
}

/* 放大版赞助者徽章 */
.sponsor-badge-large {
  padding: 12px 24px !important;
  font-size: 15px;
  position: relative;
  overflow: visible;
}

.sponsor-badge-large .badge-icon {
  font-size: 20px !important;
}

.sponsor-badge-large .badge-text {
  font-size: 15px !important;
}

/* 徽章常驻彩带效果 */
.badge-confetti {
  position: absolute;
  inset: -20px;
  pointer-events: none;
  overflow: visible;
}

.mini-confetti {
  position: absolute;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  animation: miniConfettiFall 3s ease-in-out infinite;
  animation-delay: calc(var(--i) * 0.4s);
}

.mini-confetti:nth-child(1) { left: 0%; top: 50%; background: #ffd700; }
.mini-confetti:nth-child(2) { left: 100%; top: 50%; background: #ff6b6b; }
.mini-confetti:nth-child(3) { left: 20%; top: 0%; background: #4ecdc4; }
.mini-confetti:nth-child(4) { left: 80%; top: 0%; background: #a855f7; }
.mini-confetti:nth-child(5) { left: 10%; top: 100%; background: #ff9f43; }
.mini-confetti:nth-child(6) { left: 90%; top: 100%; background: #ffd700; }
.mini-confetti:nth-child(7) { left: 50%; top: 0%; background: #ff6b6b; }
.mini-confetti:nth-child(8) { left: 50%; top: 100%; background: #4ecdc4; }

@keyframes miniConfettiFall {
  0%, 100% {
    transform: translateY(0) scale(0.5);
    opacity: 0;
  }
  10% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  50% {
    opacity: 0.8;
    transform: translateY(5px) scale(0.8);
  }
  90% {
    opacity: 0.3;
    transform: translateY(10px) scale(0.5);
  }
}

/* 重置赞助状态按钮 */
.reset-sponsor-btn {
  margin-top: 12px;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.6;
  transition: all 0.2s ease;
}

.reset-sponsor-btn:hover {
  opacity: 1;
  color: var(--text-secondary);
  border-color: var(--text-muted);
}
</style>

