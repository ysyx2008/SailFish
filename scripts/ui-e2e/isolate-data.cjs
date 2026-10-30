/** 必须早于业务入口：测试自己的数据、迁移指针和协议注册都不能落到用户环境。 */
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const dataDir = process.env.SFT_UI_TEST_DATA_DIR
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('UI 测试必须显式提供隔离数据目录')
const appData = path.join(dataDir, 'app-data')
fs.mkdirSync(appData, { recursive: true })
app.setPath('appData', appData)
app.setPath('userData', dataDir)
app.setAsDefaultProtocolClient = () => false
app.removeAsDefaultProtocolClient = () => false

// 仅静音隔离测试窗口，保留音频触发及处理逻辑；不改真实配置或系统音量。
// 专门验音效时由 launchApp(dataDir, { audio: true }) 显式开启。
if (process.env.SFT_UI_TEST_AUDIO !== '1') {
  app.on('browser-window-created', (_event, window) => window.webContents.setAudioMuted(true))
}
