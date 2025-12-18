import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import FileManagerApp from './views/FileManagerView.vue'
import { useConfigStore } from './stores/config'
import i18n from './i18n'
import { setLocale } from './i18n'
import './styles/main.css'

const app = createApp(FileManagerApp)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)
app.mount('#app')

// 加载配置并同步主题和语言
const initConfig = async () => {
  const configStore = useConfigStore()
  await configStore.loadConfig()
  
  // 应用主题到 body
  document.body.setAttribute('data-ui-theme', configStore.uiTheme)
  
  // 同步语言设置并设置窗口标题
  setLocale(configStore.language)
  document.title = i18n.global.t('fileManager.windowTitle')
  
  // 监听配置变化
  configStore.$subscribe((_mutation, state) => {
    document.body.setAttribute('data-ui-theme', state.uiTheme)
  })
  
  // 监听语言变化
  watch(() => configStore.language, (newLang) => {
    setLocale(newLang)
    document.title = i18n.global.t('fileManager.windowTitle')
  })
}

initConfig()

