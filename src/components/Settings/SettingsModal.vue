<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useConfigStore } from '../../stores/config'
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
            <div class="about-logo">🐟</div>
            <h3>{{ t('about.title') }}</h3>
            <p class="version">{{ t('common.version') }} {{ appVersion }}</p>
            <p class="description">
              {{ t('about.description') }}
            </p>
            <div class="about-links">
              <a href="mailto:nuoyan_cfan@163.com" class="about-link">{{ t('about.contact') }}</a>
              <a href="www.gnu.org/licenses/agpl-3.0.html" target="_blank" class="about-link">{{ t('about.license') }}</a>
            </div>
            
            <!-- 赞助支持部分 -->
            <div class="support-section">
              <div class="support-divider"></div>
              <h4 class="support-title">☕ {{ t('about.supportTitle') }}</h4>
              <p class="support-description">{{ t('about.supportDescription') }}</p>
              
              <!-- 国内收款码 -->
              <div class="qr-codes">
                <div class="qr-code-item">
                  <img src="../../assets/wechat-pay.png" alt="WeChat Pay" class="qr-image" @error="onQrImageError" />
                  <span class="qr-label">💚 {{ t('about.wechatPay') }}</span>
                </div>
                <div class="qr-code-item">
                  <img src="../../assets/alipay.png" alt="Alipay" class="qr-image" @error="onQrImageError" />
                  <span class="qr-label">🔵 {{ t('about.alipay') }}</span>
                </div>
              </div>
              
              <!-- 国际支持 -->
              <div class="international-support">
                <span class="international-label">🌍 {{ t('about.internationalSupport') }}:</span>
                <div class="international-links">
                  <a href="https://github.com/sponsors/anthropics" target="_blank" class="sponsor-link github">
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                    </svg>
                    {{ t('about.githubSponsors') }}
                  </a>
                  <a href="https://paypal.me/yourpaypal" target="_blank" class="sponsor-link paypal">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944 3.72a.77.77 0 0 1 .757-.639h6.513c2.166 0 3.869.567 4.947 1.64.533.532.907 1.165 1.112 1.88.218.76.255 1.64.11 2.61-.083.553-.21 1.06-.382 1.52-.17.46-.386.88-.647 1.26-.26.38-.565.72-.913 1.02-.347.3-.738.54-1.17.72-.43.19-.9.33-1.41.41-.51.08-1.06.12-1.65.12H9.41a.77.77 0 0 0-.758.639l-.808 5.125a.64.64 0 0 1-.632.54H7.076zm11.525-15.2c-.046.3-.1.6-.163.9-.562 2.755-2.487 3.71-4.95 3.71h-1.252a.61.61 0 0 0-.604.52l-.641 4.06-.182 1.15a.32.32 0 0 0 .316.37h2.22a.675.675 0 0 0 .667-.57l.027-.14.53-3.36.034-.18a.675.675 0 0 1 .667-.57h.42c2.72 0 4.85-1.1 5.47-4.29.26-1.33.126-2.44-.56-3.22a2.69 2.69 0 0 0-.77-.56l-.23.18z"/>
                    </svg>
                    {{ t('about.paypal') }}
                  </a>
                </div>
              </div>
              <p class="thanks-message">{{ t('about.thanksMessage') }}</p>
            </div>
            
            <div class="about-actions">
              <button class="btn btn-outline" @click="restartSetup">
                🔄 {{ t('settings.restartSetup') }}
              </button>
            </div>
            <p class="copyright">
              {{ t('about.copyright') }}
            </p>
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
  gap: 24px;
  margin-bottom: 16px;
}

.qr-code-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.qr-image {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  object-fit: contain;
  background: white;
  padding: 4px;
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
  font-size: 12px;
  color: var(--text-secondary);
}

.international-support {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.international-label {
  font-size: 12px;
  color: var(--text-muted);
}

.international-links {
  display: flex;
  gap: 12px;
}

.sponsor-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  text-decoration: none;
  transition: all 0.2s ease;
}

.sponsor-link.github {
  background: #24292e;
  color: #fff;
}

.sponsor-link.github:hover {
  background: #1b1f23;
}

.sponsor-link.paypal {
  background: #0070ba;
  color: #fff;
}

.sponsor-link.paypal:hover {
  background: #005ea6;
}

.thanks-message {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 16px;
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

