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

// 确认支持
const handleConfirmSupport = async () => {
  showConfirmDialog.value = false
  await configStore.setSponsorStatus(true)
  showUnlockAnimation.value = true
  setTimeout(() => {
    showUnlockAnimation.value = false
  }, 2000)
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
            
            <!-- 赞助者徽章 -->
            <div v-if="showSponsor && isSponsor" class="sponsor-badge">
              <span class="badge-icon">✨</span>
              <span class="badge-text">{{ t('sponsor.badge') }}</span>
            </div>
            
            <!-- 赞助支持部分 -->
            <div v-if="showSponsor" class="support-section">
              <div class="support-divider"></div>
              <h4 class="support-title">☕ {{ t('about.supportTitle') }}</h4>
              <p class="support-description">{{ t('about.supportDescription') }}</p>
              
              <!-- 收款码 -->
              <div v-if="!isSponsor" class="qr-codes">
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
              
              <!-- 我已支持按钮 -->
              <div v-if="!isSponsor" class="support-action">
                <button class="btn btn-primary sponsor-confirm-btn" @click="showConfirmDialog = true">
                  {{ t('sponsor.confirmButton') }}
                </button>
              </div>
              
              <!-- 感谢寄语 -->
              <div class="thanks-card" :class="{ 'unlocked': isSponsor }">
                <div class="thanks-icon" :class="{ 'animate': showUnlockAnimation }">🎁</div>
                <p class="thanks-message">{{ t('about.thanksMessage') }}</p>
                <p class="thanks-detail">{{ t('about.thanksDetail') }}</p>
                <p v-if="showUnlockAnimation" class="unlock-message">{{ t('sponsor.thanksUnlock') }}</p>
              </div>
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
  justify-content: center;
  height: 100%;
  text-align: center;
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

.thanks-icon.animate {
  animation: unlockCelebrate 0.6s ease-out;
}

@keyframes unlockCelebrate {
  0% { transform: scale(1) rotate(0deg); }
  50% { transform: scale(1.3) rotate(180deg); }
  100% { transform: scale(1) rotate(360deg); }
}

.unlock-message {
  font-size: 13px;
  font-weight: 600;
  color: #ffd700;
  margin-top: 8px;
  animation: fadeInUp 0.5s ease-out;
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
  padding: 6px 12px;
  background: linear-gradient(135deg, rgba(255, 215, 0, 0.2) 0%, rgba(255, 165, 0, 0.2) 100%);
  border: 1px solid rgba(255, 215, 0, 0.4);
  border-radius: 20px;
  margin-bottom: 16px;
}

.badge-icon {
  font-size: 16px;
}

.badge-text {
  font-size: 13px;
  font-weight: 600;
  color: #ffd700;
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
</style>

