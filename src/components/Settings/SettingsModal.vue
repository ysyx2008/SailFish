<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
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

// 更新相关状态
const updateStatus = ref<{
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
  info?: {
    version?: string
    releaseNotes?: string
    releaseDate?: string
  }
  progress?: {
    percent: number
    bytesPerSecond: number
    total: number
    transferred: number
  }
  error?: string
}>({ status: 'idle' })
const showUnlockAnimation = ref(false)
const showBadgeWithAnimation = ref(false)
const aboutContentRef = ref<HTMLElement | null>(null)

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

// 烟花数据 - 丰富多彩的烟花效果
const fireworkColors = ['#ff0044', '#ffd700', '#00ff88', '#ff6b6b', '#4ecdc4', '#a855f7', '#ff9f43', '#00ffcc', '#ff0066', '#ff1493', '#00ffff', '#ff4500']
const fireworksWave1 = Array.from({ length: 12 }, (_, i) => ({
  color: fireworkColors[i % fireworkColors.length],
  height: `${50 + Math.random() * 35}vh`,
  left: `${5 + i * 8}%`
}))
const fireworksWave2 = Array.from({ length: 10 }, (_, i) => ({
  color: fireworkColors[(i + 4) % fireworkColors.length],
  height: `${50 + Math.random() * 35}vh`,
  left: `${8 + i * 9}%`
}))
const fireworksWave3 = Array.from({ length: 10 }, (_, i) => ({
  color: fireworkColors[(i + 7) % fireworkColors.length],
  height: `${50 + Math.random() * 35}vh`,
  left: `${3 + i * 10}%`
}))
const shootingStars = [
  { color: '#ff6b6b', left: '20%', top: '10%' },
  { color: '#ffd700', left: '70%', top: '15%' },
  { color: '#4ecdc4', left: '40%', top: '8%' },
  { color: '#a855f7', left: '85%', top: '20%' },
  { color: '#00ff88', left: '10%', top: '25%' },
  { color: '#ff9f43', left: '55%', top: '12%' },
  { color: '#ff0066', left: '30%', top: '18%' },
  { color: '#00ffcc', left: '75%', top: '5%' },
  { color: '#ff0044', left: '5%', top: '30%' },
  { color: '#ffd700', left: '90%', top: '8%' },
  { color: '#00ff88', left: '50%', top: '22%' },
  { color: '#a855f7', left: '15%', top: '5%' }
]

// 闪烁星星
const sparkleStars = Array.from({ length: 30 }, () => ({
  color: fireworkColors[Math.floor(Math.random() * fireworkColors.length)],
  left: `${Math.random() * 100}%`,
  top: `${Math.random() * 60}%`,
  delay: Math.random() * 8,
  size: 3 + Math.random() * 4
}))

// 多种烟花爆炸形状
// 形状1: 大圆形爆炸 (24个粒子，更大距离)
const shapeCircle = Array.from({ length: 24 }, (_, i) => {
  const angle = (i * 15) * Math.PI / 180
  const distance = 100 + Math.random() * 60
  return { tx: Math.round(Math.cos(angle) * distance), ty: Math.round(Math.sin(angle) * distance) }
})

// 形状2: 心形爆炸
const shapeHeart = Array.from({ length: 32 }, (_, i) => {
  const t = (i / 32) * Math.PI * 2
  const scale = 8
  const x = scale * 16 * Math.pow(Math.sin(t), 3)
  const y = -scale * (13 * Math.cos(t) - 5 * Math.cos(2*t) - 2 * Math.cos(3*t) - Math.cos(4*t))
  return { tx: Math.round(x), ty: Math.round(y) }
})

// 形状3: 星形爆炸 (5角星)
const shapeStar = Array.from({ length: 30 }, (_, i) => {
  const angle = (i * 12) * Math.PI / 180
  const isOuter = i % 2 === 0
  const distance = isOuter ? (120 + Math.random() * 40) : (50 + Math.random() * 20)
  return { tx: Math.round(Math.cos(angle) * distance), ty: Math.round(Math.sin(angle) * distance) }
})

// 形状4: 双层圆环爆炸
const shapeDoubleRing = [
  ...Array.from({ length: 16 }, (_, i) => {
    const angle = (i * 22.5) * Math.PI / 180
    const distance = 70 + Math.random() * 20
    return { tx: Math.round(Math.cos(angle) * distance), ty: Math.round(Math.sin(angle) * distance) }
  }),
  ...Array.from({ length: 16 }, (_, i) => {
    const angle = ((i * 22.5) + 11.25) * Math.PI / 180
    const distance = 130 + Math.random() * 30
    return { tx: Math.round(Math.cos(angle) * distance), ty: Math.round(Math.sin(angle) * distance) }
  })
]

// 形状5: 螺旋爆炸
const shapeSpiral = Array.from({ length: 28 }, (_, i) => {
  const angle = (i * 40) * Math.PI / 180
  const distance = 40 + i * 4 + Math.random() * 15
  return { tx: Math.round(Math.cos(angle) * distance), ty: Math.round(Math.sin(angle) * distance) }
})

// 形状6: 菊花爆炸（带尾迹感）
const shapeChrysanthemum = Array.from({ length: 36 }, (_, i) => {
  const angle = (i * 10) * Math.PI / 180
  const wave = Math.sin(i * 3) * 20
  const distance = 90 + wave + Math.random() * 30
  return { tx: Math.round(Math.cos(angle) * distance), ty: Math.round(Math.sin(angle) * distance) }
})

// 所有形状数组
const allShapes = [shapeCircle, shapeHeart, shapeStar, shapeDoubleRing, shapeSpiral, shapeChrysanthemum]

// 为每个烟花预分配形状
const getRandomShape = () => allShapes[Math.floor(Math.random() * allShapes.length)]
const fireworkShapes1 = fireworksWave1.map(() => getRandomShape())
const fireworkShapes2 = fireworksWave2.map(() => getRandomShape())
const fireworkShapes3 = fireworksWave3.map(() => getRandomShape())

// 平滑滚动到顶部
const smoothScrollToTop = (element: HTMLElement, duration: number = 1500): Promise<void> => {
  return new Promise((resolve) => {
    const start = element.scrollTop
    const end = 0 // 滚动到顶部
    const distance = end - start
    const startTime = performance.now()

    const easeInOutCubic = (t: number): number => {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
    }

    const scroll = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / duration, 1)
      const easeProgress = easeInOutCubic(progress)
      
      element.scrollTop = start + distance * easeProgress

      if (progress < 1) {
        requestAnimationFrame(scroll)
      } else {
        resolve()
      }
    }

    requestAnimationFrame(scroll)
  })
}

// 确认支持
const handleConfirmSupport = async () => {
  showConfirmDialog.value = false
  await configStore.setSponsorStatus(true)
  showUnlockAnimation.value = true
  showFireworks.value = true
  
  // 延长庆祝时间，让用户充分感受
  setTimeout(async () => {
    showUnlockAnimation.value = false
    
    // 等待1秒，增加戏剧感
    await new Promise(resolve => setTimeout(resolve, 1000))
    
    // 获取滚动容器并执行渐进式滚动到顶部（徽章在顶部）
    const scrollContainer = aboutContentRef.value?.closest('.settings-content') as HTMLElement
    if (scrollContainer) {
      await smoothScrollToTop(scrollContainer, 1500)
    }
    
    // 滚动完成后，显示赞助者徽章（带动画）
    showBadgeWithAnimation.value = true
  }, 4000)
  
  // 烟花持续 10 秒（三波烟花）
  setTimeout(() => {
    showFireworks.value = false
  }, 10000)
}

// 重置赞助状态（用于测试）
const resetSponsorStatus = async () => {
  if (confirm(t('sponsor.resetConfirm'))) {
    await configStore.setSponsorStatus(false)
  }
}

// 检查更新
const checkForUpdates = async () => {
  updateStatus.value = { status: 'checking' }
  const result = await window.electronAPI.updater.checkForUpdates()
  if (!result.success && result.error) {
    updateStatus.value = { status: 'error', error: result.error }
  }
}

// 下载更新
const downloadUpdate = async () => {
  const result = await window.electronAPI.updater.downloadUpdate()
  if (!result.success && result.error) {
    updateStatus.value = { status: 'error', error: result.error }
  }
}

// 安装更新并重启
const installUpdate = async () => {
  await window.electronAPI.updater.quitAndInstall()
}

// 格式化文件大小
const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// ESC 关闭处理
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    // 如果有内部弹窗，先关闭内部弹窗，并阻止事件继续传播
    if (showConfirmDialog.value) {
      e.stopImmediatePropagation()
      showConfirmDialog.value = false
    } else {
      emit('close')
    }
  }
}

// 模态框引用
const modalRef = ref<HTMLElement | null>(null)

// 更新状态变化监听器清理函数
let unsubscribeUpdater: (() => void) | null = null

// 初始化时设置初始 tab 和获取版本号
onMounted(async () => {
  if (props.initialTab && ['ai', 'mcp', 'knowledge', 'theme', 'terminal', 'data', 'language', 'about'].includes(props.initialTab)) {
    activeTab.value = props.initialTab as SettingsTab
  }
  // 获取应用版本号
  appVersion.value = await window.electronAPI.app.getVersion()
  
  // 添加键盘事件监听
  document.addEventListener('keydown', handleKeydown)
  
  // 监听更新状态变化
  unsubscribeUpdater = window.electronAPI.updater.onStatusChanged((status) => {
    updateStatus.value = status
  })
  
  // 获取当前更新状态
  updateStatus.value = await window.electronAPI.updater.getStatus()
  
  // 聚焦到模态框容器使其可接收键盘事件
  await nextTick()
  modalRef.value?.focus()
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
  // 清理更新状态监听器
  if (unsubscribeUpdater) {
    unsubscribeUpdater()
    unsubscribeUpdater = null
  }
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
      <!-- 第一波烟花 -->
      <div 
        v-for="(fw, i) in fireworksWave1" 
        :key="`w1-${i}`" 
        class="firework wave-1"
        :style="{ '--i': i, '--color': fw.color, '--height': fw.height, left: fw.left }"
      >
        <div 
          v-for="(p, j) in fireworkShapes1[i]" 
          :key="j" 
          class="firework-particle"
          :style="{ '--tx': p.tx + 'px', '--ty': p.ty + 'px' }"
        ></div>
      </div>
      <!-- 第二波烟花 -->
      <div 
        v-for="(fw, i) in fireworksWave2" 
        :key="`w2-${i}`" 
        class="firework wave-2"
        :style="{ '--i': i, '--color': fw.color, '--height': fw.height, left: fw.left }"
      >
        <div 
          v-for="(p, j) in fireworkShapes2[i]" 
          :key="j" 
          class="firework-particle"
          :style="{ '--tx': p.tx + 'px', '--ty': p.ty + 'px' }"
        ></div>
      </div>
      <!-- 第三波烟花 -->
      <div 
        v-for="(fw, i) in fireworksWave3" 
        :key="`w3-${i}`" 
        class="firework wave-3"
        :style="{ '--i': i, '--color': fw.color, '--height': fw.height, left: fw.left }"
      >
        <div 
          v-for="(p, j) in fireworkShapes3[i]" 
          :key="j" 
          class="firework-particle"
          :style="{ '--tx': p.tx + 'px', '--ty': p.ty + 'px' }"
        ></div>
      </div>
      <!-- 流星尾迹 -->
      <div 
        v-for="(star, i) in shootingStars" 
        :key="`star-${i}`" 
        class="shooting-star"
        :style="{ '--i': i, '--color': star.color, left: star.left, top: star.top }"
      ></div>
      <!-- 闪烁星星 -->
      <div 
        v-for="(star, i) in sparkleStars" 
        :key="`sparkle-${i}`" 
        class="sparkle-star"
        :style="{ 
          '--color': star.color, 
          '--delay': star.delay + 's',
          '--size': star.size + 'px',
          left: star.left, 
          top: star.top 
        }"
      ></div>
    </div>
    <div ref="modalRef" class="settings-modal" tabindex="-1">
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
          <div v-else-if="activeTab === 'about'" ref="aboutContentRef" class="about-content">
            <div class="about-logo">{{ brandLogo }}</div>
            <h3>{{ brandName }}</h3>
            <p class="version">{{ t('common.version') }} {{ oemConfig.brand.version || appVersion }}</p>
            
            <!-- 更新检测区域 -->
            <div class="update-section">
              <!-- 检查更新按钮 -->
              <button 
                v-if="updateStatus.status === 'idle' || updateStatus.status === 'not-available' || updateStatus.status === 'error'"
                class="btn btn-outline update-btn"
                @click="checkForUpdates"
              >
                🔄 {{ t('about.checkUpdate') }}
              </button>
              
              <!-- 检查中状态 -->
              <div v-else-if="updateStatus.status === 'checking'" class="update-status checking">
                <span class="update-spinner"></span>
                <span>{{ t('about.checkingUpdate') }}</span>
              </div>
              
              <!-- 发现新版本 -->
              <div v-else-if="updateStatus.status === 'available'" class="update-status available">
                <div class="update-info">
                  <span class="update-icon">🎉</span>
                  <span>{{ t('about.newVersionAvailable', { version: updateStatus.info?.version }) }}</span>
                </div>
                <button class="btn btn-primary update-btn" @click="downloadUpdate">
                  ⬇️ {{ t('about.downloadUpdate') }}
                </button>
              </div>
              
              <!-- 下载中状态 -->
              <div v-else-if="updateStatus.status === 'downloading'" class="update-status downloading">
                <div class="update-info">
                  <span>{{ t('about.downloadingUpdate') }}</span>
                  <span class="download-percent">{{ updateStatus.progress?.percent.toFixed(1) }}%</span>
                </div>
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: `${updateStatus.progress?.percent || 0}%` }"></div>
                </div>
                <div class="download-details">
                  <span>{{ formatBytes(updateStatus.progress?.transferred || 0) }} / {{ formatBytes(updateStatus.progress?.total || 0) }}</span>
                  <span>{{ formatBytes(updateStatus.progress?.bytesPerSecond || 0) }}/s</span>
                </div>
              </div>
              
              <!-- 下载完成，等待安装 -->
              <div v-else-if="updateStatus.status === 'downloaded'" class="update-status downloaded">
                <div class="update-info">
                  <span class="update-icon">✅</span>
                  <span>{{ t('about.updateReady', { version: updateStatus.info?.version }) }}</span>
                </div>
                <button class="btn btn-primary update-btn" @click="installUpdate">
                  🚀 {{ t('about.installAndRestart') }}
                </button>
              </div>
              
              <!-- 已是最新版本（刚检查完） -->
              <div v-if="updateStatus.status === 'not-available'" class="update-hint success">
                ✓ {{ t('about.upToDate') }}
              </div>
              
              <!-- 错误状态 -->
              <div v-if="updateStatus.status === 'error'" class="update-hint error">
                ⚠️ {{ updateStatus.error || t('about.updateError') }}
              </div>
            </div>
            
            <p class="description">
              {{ t('about.description') }}
            </p>
            <div class="about-links">
              <a href="mailto:nuoyan_cfan@163.com" class="about-link">{{ t('about.contact') }}</a>
              <a href="www.gnu.org/licenses/agpl-3.0.html" target="_blank" class="about-link">{{ t('about.license') }}</a>
            </div>
            
            <!-- 赞助者徽章（放大醒目版） -->
            <div 
              v-if="showSponsor && isSponsor && (showBadgeWithAnimation || !showFireworks)" 
              class="sponsor-badge sponsor-badge-large"
              :class="{ 'badge-dramatic-entrance': showBadgeWithAnimation }"
            >
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
              <button hidden v-if="isSponsor" class="reset-sponsor-btn" @click="resetSponsorStatus">
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
  margin-bottom: 12px;
}

/* 更新检测区域 */
.update-section {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.update-btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.update-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.update-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.update-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--bg-tertiary);
  min-width: 280px;
}

.update-status.checking {
  color: var(--text-secondary);
}

.update-status.available {
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.1) 0%, rgba(139, 195, 74, 0.1) 100%);
  border: 1px solid rgba(76, 175, 80, 0.3);
}

.update-status.downloading {
  background: linear-gradient(135deg, rgba(33, 150, 243, 0.1) 0%, rgba(3, 169, 244, 0.1) 100%);
  border: 1px solid rgba(33, 150, 243, 0.3);
}

.update-status.downloaded {
  background: linear-gradient(135deg, rgba(76, 175, 80, 0.15) 0%, rgba(139, 195, 74, 0.15) 100%);
  border: 1px solid rgba(76, 175, 80, 0.4);
}

.update-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
}

.update-icon {
  font-size: 18px;
}

.update-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.progress-bar {
  width: 100%;
  height: 6px;
  background: var(--bg-primary);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-primary), #4ecdc4);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.download-percent {
  font-weight: 600;
  color: var(--accent-primary);
}

.download-details {
  display: flex;
  justify-content: space-between;
  width: 100%;
  font-size: 11px;
  color: var(--text-muted);
}

.update-hint {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 12px;
}

.update-hint.success {
  color: #4caf50;
  background: rgba(76, 175, 80, 0.1);
}

.update-hint.error {
  color: #f44336;
  background: rgba(244, 67, 54, 0.1);
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
  gap: 60px;
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
  width: 160px;
  height: 160px;
  border-radius: 8px;
  object-fit: contain;
  background: white;
  display: block;
}

.qr-placeholder {
  width: 160px;
  height: 160px;
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
  background: radial-gradient(ellipse at center bottom, rgba(0, 0, 0, 0.1) 0%, transparent 70%);
}

.firework {
  position: absolute;
  bottom: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  animation: fireworkMove 1.2s ease-out forwards;
  will-change: transform;
  contain: layout style;
}

.firework::before {
  content: '';
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  background: var(--color);
  box-shadow: 0 0 12px var(--color), 0 0 24px var(--color), 0 0 36px rgba(255, 255, 255, 0.3);
  animation: fireworkLaunch 1.2s ease-out forwards;
}

/* 烟花发射尾迹 */
.firework::after {
  content: '';
  position: absolute;
  width: 4px;
  height: 30px;
  background: linear-gradient(to bottom, var(--color), transparent);
  border-radius: 2px;
  left: 50%;
  top: 100%;
  transform: translateX(-50%);
  opacity: 0.8;
  animation: fireworkTrail 1.2s ease-out forwards;
}

@keyframes fireworkTrail {
  0% { opacity: 0.8; height: 30px; }
  50% { opacity: 0.4; height: 15px; }
  51% { opacity: 0; }
  100% { opacity: 0; }
}

/* 第一波烟花 - 立即发射 */
.firework.wave-1 {
  animation-delay: calc(var(--i) * 0.15s);
}
.firework.wave-1::before {
  animation-delay: calc(var(--i) * 0.15s);
}

/* 第二波烟花 - 延迟发射 */
.firework.wave-2 {
  animation-delay: calc(2s + var(--i) * 0.18s);
}
.firework.wave-2::before {
  animation-delay: calc(2s + var(--i) * 0.18s);
}

/* 第三波烟花 - 更晚发射 */
.firework.wave-3 {
  animation-delay: calc(4s + var(--i) * 0.2s);
}
.firework.wave-3::before {
  animation-delay: calc(4s + var(--i) * 0.2s);
}

/* fireworkMove 让父元素移动到爆炸位置并保持在那里（粒子跟随） */
@keyframes fireworkMove {
  0% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(calc(var(--height) * -1));
  }
  100% {
    transform: translateY(calc(var(--height) * -1));
  }
}

/* fireworkLaunch 控制烟花弹（::before 伪元素）的发光和消失 */
@keyframes fireworkLaunch {
  0% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1);
    opacity: 1;
  }
  51% {
    transform: scale(2);
    opacity: 0;
  }
  100% {
    transform: scale(2);
    opacity: 0;
  }
}

.firework-particle {
  position: absolute;
  top: 50%;
  left: 50%;
  margin-left: -5px;
  margin-top: -5px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--color);
  box-shadow: 0 0 6px var(--color), 0 0 12px var(--color);
  opacity: 0;
  will-change: transform, opacity;
  contain: layout style;
}

.wave-1 .firework-particle {
  animation: fireworkExplode 1.8s ease-out forwards;
  animation-delay: calc(var(--i) * 0.15s + 0.6s);
}

.wave-2 .firework-particle {
  animation: fireworkExplode 1.8s ease-out forwards;
  animation-delay: calc(2s + var(--i) * 0.18s + 0.6s);
}

.wave-3 .firework-particle {
  animation: fireworkExplode 1.8s ease-out forwards;
  animation-delay: calc(4s + var(--i) * 0.2s + 0.6s);
}

@keyframes fireworkExplode {
  0% {
    transform: translate(0, 0) scale(0);
    opacity: 1;
    filter: brightness(2);
  }
  8% {
    transform: translate(0, 0) scale(1.8);
    opacity: 1;
    filter: brightness(2);
  }
  15% {
    transform: translate(calc(var(--tx) * 0.15), calc(var(--ty) * 0.15)) scale(1.4);
    opacity: 1;
    filter: brightness(1.5);
  }
  40% {
    transform: translate(calc(var(--tx) * 0.6), calc(var(--ty) * 0.6)) scale(1);
    opacity: 0.9;
    filter: brightness(1.2);
  }
  70% {
    transform: translate(calc(var(--tx) * 0.9), calc(var(--ty) * 0.9 + 20px)) scale(0.6);
    opacity: 0.5;
    filter: brightness(1);
  }
  100% {
    transform: translate(var(--tx), calc(var(--ty) + 40px)) scale(0.1);
    opacity: 0;
    filter: brightness(0.8);
  }
}

/* 流星尾迹效果 */
.shooting-star {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--color);
  opacity: 0;
  animation: shootingStar 3s ease-out infinite;
  animation-delay: calc(var(--i) * 0.7s);
}

@keyframes shootingStar {
  0% {
    transform: translateX(0) translateY(0) scale(1);
    opacity: 0;
    background: var(--color);
    box-shadow: 0 0 6px var(--color);
  }
  5% {
    opacity: 1;
  }
  40% {
    transform: translateX(150px) translateY(80px) scale(0.5);
    opacity: 0.8;
  }
  100% {
    transform: translateX(300px) translateY(160px) scale(0);
    opacity: 0;
  }
}

/* 闪烁星星效果 */
.sparkle-star {
  position: absolute;
  width: var(--size);
  height: var(--size);
  background: var(--color);
  border-radius: 50%;
  box-shadow: 0 0 6px var(--color), 0 0 12px var(--color);
  animation: sparkle 1.5s ease-in-out infinite;
  animation-delay: var(--delay);
}

.sparkle-star::before,
.sparkle-star::after {
  content: '';
  position: absolute;
  background: var(--color);
}

.sparkle-star::before {
  width: 100%;
  height: 2px;
  top: 50%;
  left: -50%;
  transform: translateY(-50%);
  width: 200%;
}

.sparkle-star::after {
  width: 2px;
  height: 200%;
  left: 50%;
  top: -50%;
  transform: translateX(-50%);
}

@keyframes sparkle {
  0%, 100% {
    transform: scale(0.3) rotate(0deg);
    opacity: 0.3;
  }
  50% {
    transform: scale(1.2) rotate(180deg);
    opacity: 1;
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
  transform: scale(0.7);
  transform-origin: center;
  margin: -15px 0;
  opacity: 0.85;
}

.qr-codes-small .qr-image {
  width: 120px;
  height: 120px;
}

/* 放大版赞助者徽章 */
.sponsor-badge-large {
  padding: 12px 24px !important;
  font-size: 15px;
  position: relative;
  overflow: visible;
}

/* 戏剧性入场动画 */
.badge-dramatic-entrance {
  animation: dramaticBadgeAppear 1.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards, 
             badgeShine 3s ease-in-out infinite 1.2s !important;
}

@keyframes dramaticBadgeAppear {
  0% {
    transform: scale(0) rotate(-180deg);
    opacity: 0;
    filter: blur(10px);
  }
  30% {
    transform: scale(0.3) rotate(-90deg);
    opacity: 0.3;
    filter: blur(5px);
  }
  60% {
    transform: scale(1.3) rotate(10deg);
    opacity: 1;
    filter: blur(0);
  }
  75% {
    transform: scale(0.9) rotate(-5deg);
  }
  90% {
    transform: scale(1.1) rotate(2deg);
  }
  100% {
    transform: scale(1) rotate(0deg);
    opacity: 1;
    filter: blur(0);
  }
}

/* 入场时的光芒爆发效果 */
.badge-dramatic-entrance::after {
  content: '';
  position: absolute;
  inset: -20px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 215, 0, 0.6) 0%, transparent 70%);
  animation: badgeBurst 1s ease-out forwards;
  pointer-events: none;
  z-index: -1;
}

@keyframes badgeBurst {
  0% {
    transform: scale(0);
    opacity: 1;
  }
  50% {
    transform: scale(2);
    opacity: 0.6;
  }
  100% {
    transform: scale(3);
    opacity: 0;
  }
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

