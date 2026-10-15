# Browser Bridge 服务 SPEC

> Last verified: 2026-09-14

## 设计目标

### 两款桌面程序同时安装时，先启动的占住浏览器连接（2026-10-15）

- **问题**：旗鱼和各 OEM 共用同一份浏览器助手。浏览器只认一个连接名字，两款同时开着时，后启动的会把连接改到自己身上，先开的那款正在用的浏览器就被抢走。
- **成功标准**：先启动并接上浏览器的那款占住连接。另一款后启动时不改这条连接，自己连不上就如实告诉用户：浏览器助手正被另一款已打开的程序使用。先开的那款退出之后，连接空出来，后开的那款才能接上。先开的那款已经不在了（崩溃、进程没了），不算还占着，后开的可以接上，避免连接永远空挂。
- **关键取舍**：各 OEM 不另做一份助手、不上架自己的商店应用。同一台电脑同时只让一款桌面程序连着这份助手。
- **明确不做**：不按厂商拆助手身份；不让后启动的抢占；不在对方还开着时悄悄改连接。

### 两场对话同时用浏览器不能互相抢（2026-09-14）

- **问题**：两个对话同时操作浏览器时，一边吸附用户火狐、一边开独立 Chrome，会互相动手、互相关掉对方的窗口。两场对话吸附同一只用户火狐时，点的是同一扇窗、同一批标签，也会互相动手。
- **成功标准**：每场对话各自绑自己的那一档、自己的窗口。没有终端窗格的助手对话也必须分开，不能因为少了窗格编号就收成同一条。一场对话关掉或卸掉浏览器，不能拆掉另一场还在用的窗口。同一场对话里派出去帮忙的伙计，继续用这场已经打开的浏览器，不另起一条。同一档用户浏览器（火狐一档、Chromium 一档）同时只给一场正在进行的对话吸附；另一场要吸附时，若占着的那场还在跑（含等人确认），就明白告诉它：这档正被另一场对话使用，等那场结束或改用独立窗口。占着的那场停了（人去干别的、忘了断开也算停了），下一场可以直接接过去，不必等人亲手断开。火狐被占着时，另一场仍可吸附 Chromium，互不挡。
- **关键取舍**：浏览器会话跟对话走，不跟眼前那扇终端窗格走。吸附占用看这场对话的助手是否还在跑，不看过了几分钟；独立窗口仍按自己的闲置规则关窗，不套到吸附上。命令只打到这场选定的浏览器。
- **明确不做**：不因此让两场对话共用一个独立窗口；不把用户日常火狐拆成两份配置；不把伙计的浏览器从这场对话里拆出去；不为吸附加闲置超时；不排队；对方还在跑时不悄悄抢走。

### Agent 能看见两档浏览器能力（2026-08-15）

- **问题**：助手连上用户浏览器时，说明几乎只写吸附档，独立窗口的能力边界没有中性呈现，Agent 不容易知道还有另一档。
- **成功标准**：技能说明和助手在线提示中性写清两档分别能做什么、不能做什么；未指定模式时助手在线仍默认吸附。不向 Agent 承诺「把用户浏览器的开发者工具挂过来」。
- **明确不做**：不改扩展权限、不上架调试器能力；不对 Agent 规定何时必须换档。

### 启动不堵主进程（2026-07-23）

- **问题**：`initBrowserBridgeService` 在 gateway `start()` 后同步 `install()`（全量 `copyDir` + Windows `execFileSync('reg')`），主线程可冻约 24s，窗口兜底 show 被拖死，标题「未响应」。
- **成功标准**：
  - Gateway（TCP + `gateway.json`）可尽早 `start`；**install 不得阻塞首屏**。
  - install 延后到窗口 `ready-to-show`（与后端 defer 同调度）且 **异步**（`fs.promises.cp` / `execFile`）；启动路径禁止 `execFileSync` / 递归 `copyFileSync`。
  - 已安装且路径未变时 **跳过全量拷贝**，只刷新 gateway / pointer / registry（若需要）。
- **明确不做**：不删自动注册能力；不把 install 挪进渲染进程；本热修不把 install 迁入独立 utilityProcess。

## 职责

让用户 **已打开** 的 Chrome / Edge / Firefox 标签页与登录态可被 Agent 复用。通过浏览器扩展 + Native Messaging Host + Electron TCP 网关实现。

**扩展定位**：长期稳定的「浏览器遥控 API」（protocol v1）。正文提取、Readability、DOM 启发式等**业务逻辑在 SailFish 桌面端**，扩展只负责 DOM 原语与 HTML 回传，以减少应用商店发版频率。

## 架构

```
Agent browser_* (attach 模式)
    ↕
BrowserBridgeService (Electron TCP :随机端口)
    ↕  extractPageContentFromHtml / Readability / html-article-extract
native-host/host.mjs (Chrome 按连接 spawn)
    ↕ Native Messaging (stdin/stdout)
扩展 background.js → content.js (DOM 原语 / 快照 / page_html)
```

## 协议 v1（扩展 ↔ 桌面端）

### 版本

- `BROWSER_BRIDGE_PROTOCOL_VERSION = 1`（`shared/types/browser-bridge.ts`）
- 扩展 `ping` 响应：`{ extension, version, protocol: 1 }`
- 桌面端 `parsePingResult` / `supportsProtocolV1` 做能力判断；旧扩展无 `protocol` 时 `get_content` 降级为 `mode: html` 整页抓取
- Firefox MV3：`host_permissions` 为可选权限；扩展 ping 上报 `hostPermissionsGranted`（v1.2.2+），设置页据此提示用户授权

### 冻结 action 名单

新能力**优先扩展 payload**，不新增 action（**例外**：`tabs` 为 1.2.0 最终 Tab 原语层，此后 Tab 相关策略均在桌面端组合 `tabs` op，扩展不再为 Tab 行为发版）：

`ping` | `tabs` | `list_tabs` | `switch_tab` | `goto` | `close_tab` | `reload` | `evaluate` | `snapshot` | `get_content` | `click` | `type` | `scroll`

legacy `list_tabs` / `switch_tab` / `goto` / `close_tab` 内部委托 `shared/tabs-api.js`，桌面端 1.2.0+ 优先直接发 `tabs`。

### tabs payload（1.2.0+，Tab 原语最终版）

| op | 说明 | 主要字段 |
|----|------|---------|
| `query` | 列出标签 | `query`（默认 `{ currentWindow: true }`） |
| `create` | 新建标签 | `url`, `active`（默认 true）, `index`, `windowId`, `wait`（默认 true 当有 url） |
| `update` | 更新标签（含当前标签导航） | `tabId` / `index` / 省略=活动标签, `url`, `active`, `wait` |
| `activate` | 激活标签 | `tabId` / `index` |
| `remove` | 关闭标签 | `tabId` / `index` / 省略=活动标签 |

扩展 `ping` capabilities：`tabs_manage`, `goto_new_tab`。桌面端 `extensionSupportsTabsManage()` 做能力判断。

### goto payload（legacy，委托 tabs）

| 字段 | 说明 |
|------|------|
| `url` | 目标 URL（必填） |
| `new_tab` | 省略或 `true` → `tabs.create`；**仅** `false` → 当前标签 `tabs.update` |

### get_content payload（protocol v1）

| mode | 扩展行为 | 桌面端 |
|------|---------|--------|
| `page_html` | 回传 `html` + `fallbackText`（body.innerText） | Readability → 启发式 → fallback |
| `text` / `html` | 整页或 selector 原语 | 一般不经桌面端二次提取 |
| `extract: full` | 整页 body / outerHTML | — |

## 公开契约

### IPC

| Channel | 说明 |
|---------|------|
| `browserBridge:getStatus` | 对已连接扩展 ping 后返回 `BrowserBridgeStatus`（含 `connections[].version`） |
| `browserBridge:install` | 复制扩展、写 manifest、注册 Native Host |
| `browserBridge:uninstall` | 移除 Native Host 注册与本机扩展文件 |
| `browserBridge:openExtensionGuide` | 用对应浏览器打开扩展管理页（`chrome://` 等内部 URL） |
| `browserBridge:connectionsChanged`（主→渲染 push） | 扩展连上/断开或 install/uninstall 后推送最新 `BrowserBridgeStatus` |

### Agent 集成

- `browser_launch` 增加 `attach: true` 或 `mode: 'attach'`：连接用户浏览器，不启动 Playwright
- 显式打开独立浏览器窗口后，后续操作必须继续走这个窗口，直到关掉或再次明确要求连回用户浏览器；不能因为浏览器助手在线就把后续操作悄悄切回去
- `browser_launch.browser`：`auto` | `firefox` | `chromium`（`chrome`/`edge` 别名）；双开时必须显式指定；会话绑定后后续 `browser_*` 走同一路由
- 每场对话各自一条浏览器会话；助手没有终端窗格时也按对话分开，不能收成同一条
- 同一档用户浏览器同时只给一场正在进行的对话吸附；那场停了，别的对话可以接过去
- attach 会话存于 `bridge-session.ts`（含 `origin` + `browserTarget` + `extensionPing`），与 Playwright `session.ts` 并行
- `browser_get_content`（auto/article）：扩展 `page_html` → 桌面端 `extractPageContentFromHtml`
- 未 attach 时行为不变
- 助手在线时，系统提示中性写清两档分别能做什么、不能做什么
- prompt cache 复用路径下，`agent.ts` 调用 `patchBrowserBridgeSectionInSystemPrompt()` 刷新 system 消息中的该章节，避免同会话追问时状态过期

### Native Host 名

固定 `com.sailfish.browser`（见 `shared/types/browser-bridge.ts`）。

### 扩展 ID

- Chromium 开发版（manifest `key`，临时加载）：`ocdljfppijcjpgaaamgeailkgajgjdml`
- Chromium 商店版（Chrome Web Store）：`dgmhdapfpihhkboikpgfanpgnijbpdhd`
- Native Host `allowed_origins` **同时包含**上述两个 ID
- Firefox：`sailfish-browser-bridge@yushen.dev`

### 扩展 content_scripts（protocol v1 起不再增文件）

`safe-eval.js` | `snapshot.js` | `content.js`

## 安装

1. 从 `resources/browser-bridge/` 复制到 `{userData}/browser-bridge/`（`userData` 随「数据管理」自定义目录变化，见 `bootstrap.ts`）
2. 写 `{userData}/browser-bridge/native-host/com.sailfish.browser.json` 并注册 NativeMessagingHosts（macOS 覆盖 Chrome / **Arc** / Brave / Edge / Chromium / Vivaldi / Opera 等各自目录）
   - **Chromium 系**：manifest 用 `allowed_origins`（`chrome-extension://…/`）
   - **Firefox**：manifest 用 `allowed_extensions`（扩展 ID 字符串，如 `sailfish-browser-bridge@yushen.dev`）
3. 写 `$HOME/.sailfish-browser-bridge.json` 指针（供 Chrome 拉起的 host 进程定位当前 gateway，**不硬编码** SFTerm/SailFish 路径）
4. macOS：`clang` 编译 `{Electron.app}/Contents/Helpers/sailfish-browser-host` Mach-O（与 Claude 同款路径；Chrome 无法稳定拉起 `$HOME` 下的 host）；manifest **按浏览器拆分**（Chrome 仅 `chrome-extension://`，Firefox 仅 `moz-extension://`）
5. Windows host 启动：`ELECTRON_RUN_AS_NODE=1` + 应用可执行文件 + `host.mjs`
   - **Windows 注册表路径（易错）**：Chrome=`Software\Google\Chrome\NativeMessagingHosts\<name>`、Edge=`Software\Microsoft\Edge\...`，但 **Firefox=`Software\Mozilla\NativeMessagingHosts\<name>`（无 `\Firefox` 子级）**。曾误写为 `Mozilla\Firefox` 导致 Firefox 找不到 Native Host；`installer.ts` 装/卸载时会顺带清除历史误写的旧 key。

**迁移/修改数据目录后**：首屏后再 `installAsync()` / `installIfNeeded()` 刷新 host-env、指针与浏览器注册（不堵主进程）；若仍异常，设置页「重新安装组件」并重启浏览器。

Firefox：安装器提供已解压扩展目录；正式持久安装需 Mozilla 签名 XPI（见 `docs/browser-bridge-firefox-amo.md`）。

## 桌面端正文提取模块

| 模块 | 职责 |
|------|------|
| `electron/utils/readability-extract.ts` | Mozilla Readability（与 web_fetch 共用） |
| `electron/utils/html-article-extract.ts` | DOM 启发式 fallback（原 article-extract.js） |
| `electron/utils/page-content-extract.ts` | 统一编排：Readability → 启发式 → plain fallback |

## 依赖

- `electron/services/agent/skills/browser/` — attach 模式执行器
- `{userData}/browser-bridge/gateway.json` — TCP 端口与 token（随运行更新）
- `$HOME/.sailfish-browser-bridge.json` — 当前 `{userData}` 下的 bridge 根路径指针

## 测试

- `electron/services/browser-bridge/__tests__/protocol.test.ts`
- `electron/utils/__tests__/html-article-extract.test.ts`
- `electron/utils/__tests__/page-content-extract.test.ts`
- `electron/utils/__tests__/readability-extract.test.ts`
- `electron/services/agent/skills/browser/__tests__/bridge-session.test.ts`

## 扩展发版策略

- **1.1.0** = protocol v1 基线（薄扩展 + 桌面端提取）
- **1.2.0** = Tab 原语最终版（`tabs` action + `shared/tabs-api.js`）；此后 Tab 策略（默认新开、后台开 tab、按 id 关闭等）**只在桌面端改**，扩展不再为 Tab 行为发版
- 此后功能迭代优先改 SailFish App；扩展仅在 permissions / 浏览器 API breaking change / DOM 原语（content script）时发版
- AMO 建议 Unlisted 分发（见 `docs/browser-bridge-firefox-amo.md`）
