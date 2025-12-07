import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/main.css'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.mount('#app')

// 设置窗口标题包含版本号
window.electronAPI?.app.getVersion().then((version: string) => {
  document.title = `旗鱼终端 v${version}`
})

