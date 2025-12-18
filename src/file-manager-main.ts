import { createApp } from 'vue'
import { createPinia } from 'pinia'
import FileManagerApp from './views/FileManagerView.vue'
import { useConfigStore } from './stores/config'
import i18n from './i18n'
import './styles/main.css'

const app = createApp(FileManagerApp)
const pinia = createPinia()

app.use(pinia)
app.use(i18n)
app.mount('#app')

// 设置窗口标题
document.title = '文件管理器'

// 加载并同步主题
const initTheme = async () => {
  const configStore = useConfigStore()
  await configStore.loadConfig()
  
  // 应用主题到 body
  document.body.setAttribute('data-ui-theme', configStore.uiTheme)
  
  // 监听主题变化
  configStore.$subscribe((_mutation, state) => {
    document.body.setAttribute('data-ui-theme', state.uiTheme)
  })
}

initTheme()

