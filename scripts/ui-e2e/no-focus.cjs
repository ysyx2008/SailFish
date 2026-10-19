/**
 * 界面测试专用：被测窗口不抢前台。
 * 只在测试启动时由 launch.mjs 预加载，不改产品代码。
 * 正常打开旗鱼仍然会到前台。
 *
 * - 不成为前台应用：macOS 上改成「配件」应用，没有 Dock 图标、不抢菜单栏
 * - 所有窗口 show() 改成不激活地显示；focus() / 置顶 / 激活应用全部空转
 * - 窗口完全透明、不接收鼠标：看不见，也点不到
 * - 渲染不能因为「看不见 / 被遮住」停掉（动画、过渡、布局测量照常走）
 *
 * 测试脚本经 Playwright 直连页面，截图和测量不受影响。
 */
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const safe = (fn) => { try { fn() } catch { /* 个别平台没有这个接口 */ } }

if (process.platform === 'darwin') {
  safe(() => app.setActivationPolicy('accessory'))
  safe(() => app.dock && app.dock.hide())
  safe(() => { if (app.dock) app.dock.show = () => Promise.resolve() })
}

app.focus = () => {}

BrowserWindow.prototype.show = function show() { this.showInactive() }
BrowserWindow.prototype.focus = function focus() {}
BrowserWindow.prototype.setAlwaysOnTop = function setAlwaysOnTop() {}
BrowserWindow.prototype.moveTop = function moveTop() {}

app.on('browser-window-created', (_event, win) => {
  safe(() => win.setOpacity(0))
  safe(() => win.setIgnoreMouseEvents(true))
})
