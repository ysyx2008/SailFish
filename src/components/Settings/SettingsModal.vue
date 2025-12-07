<script setup lang="ts">
import { ref, onMounted } from 'vue'
import AiSettings from './AiSettings.vue'
import ThemeSettings from './ThemeSettings.vue'
import TerminalSettings from './TerminalSettings.vue'
import DataSettings from './DataSettings.vue'
import McpSettings from './McpSettings.vue'
import KnowledgeSettings from './KnowledgeSettings.vue'

// Props
const props = defineProps<{
  initialTab?: string
}>()

const emit = defineEmits<{
  close: []
}>()

type SettingsTab = 'ai' | 'mcp' | 'knowledge' | 'theme' | 'terminal' | 'data' | 'about'
const activeTab = ref<SettingsTab>('ai')
const appVersion = ref<string>('')

// 初始化时设置初始 tab 和获取版本号
onMounted(async () => {
  if (props.initialTab && ['ai', 'mcp', 'knowledge', 'theme', 'terminal', 'data', 'about'].includes(props.initialTab)) {
    activeTab.value = props.initialTab as SettingsTab
  }
  // 获取应用版本号
  appVersion.value = await window.electronAPI.app.getVersion()
})

const tabs = [
  { id: 'ai' as const, label: 'AI 配置', icon: '🤖' },
  { id: 'mcp' as const, label: 'MCP 服务器', icon: '🔌' },
  { id: 'knowledge' as const, label: '知识库', icon: '📚' },
  { id: 'theme' as const, label: '主题配色', icon: '🎨' },
  { id: 'terminal' as const, label: '终端设置', icon: '⚙️' },
  { id: 'data' as const, label: '数据管理', icon: '💾' },
  { id: 'about' as const, label: '关于', icon: 'ℹ️' }
]
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="settings-modal">
      <div class="settings-header">
        <h2>设置</h2>
        <button class="btn-icon" @click="emit('close')" title="关闭设置">
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
          <div v-else-if="activeTab === 'about'" class="about-content">
            <div class="about-logo">🐟</div>
            <h3>旗鱼终端</h3>
            <p class="version">版本 {{ appVersion }}</p>
            <p class="description">
              AI 驱动的跨平台终端，助力运维提效
            </p>
            <div class="about-links">
              <a href="#" class="about-link">使用文档</a>
              <a href="#" class="about-link">问题反馈</a>
              <a href="#" class="about-link">开源协议</a>
            </div>
            <p class="producer">
              国元证券股份有限公司·金融科技创新实验室 出品
            </p>
            <p class="copyright">
              © 2024 旗鱼
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

.copyright {
  color: var(--text-muted);
  font-size: 12px;
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

