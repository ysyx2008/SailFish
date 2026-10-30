# 界面测试不抢前台

正常使用时旗鱼就该到前台。这是产品行为，不要改产品代码来迁就测试。

用真实窗口看界面时，一律走 `scripts/ui-e2e/launch.mjs` 的 `launchApp`。默认：不抢前台、不进 Dock、窗口完全透明、鼠标点不到、窗口静音。静音只作用于隔离测试窗口，不改用户设置或系统音量；音频触发和处理逻辑仍照常运行。专门测试音效时才显式传 `{ audio: true }`。跟页面通信、截图、测量照常。

```js
import { launchApp } from '<仓库>/scripts/ui-e2e/launch.mjs'
const app = await launchApp(dataDir)
```

只有用户明确要亲眼看这一次，才传 `{ visible: true }`。不要自己 `electron.launch`。
