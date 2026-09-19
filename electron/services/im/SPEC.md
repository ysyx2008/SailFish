# IM Service SPEC

> Last verified: 2026-09-05（联络空着时微信没连上要直接出扫码）

## 职责

多平台即时通讯集成层。统一管理六平台（钉钉/飞书/企业微信/微信/Slack/Telegram）的连接、消息收发、入站消息→Agent 对话、Agent 回复→IM 渠道路由。每个平台有独立的启停 API（因配置和登录方式各异），通用功能通过"当前会话感知"的方法暴露。

## 设计目标

### 微信连上了还不等于能发

微信规定必须先在手机里给助手发一条，这边才能往回发；隔太久没聊也要再发一条。连接面板不能只显示「已连 / 未连」——微信还有第三种：已经连上但还不能发。用黄灯标出来，外面的总览灯也要跟着黄，不能里面黄、外面还绿。说明只写在面板里那一行的悬停上，外面不再另挂一条，免得挡住旁边的字。别的渠道没有这条规矩，不必多一种灯。回信被拒（会话没了）也算「还不能发」，必须亮黄，不能因为以前聊过就还亮绿；用户再发一条进来后恢复绿灯。

### 微信批量收附件

微信里转发一份东西就是一条消息。批量发过来时，必须尽快继续从微信那边拉下一批，不能等上一份附件下完才去拉，否则后面的会丢。

图片、文件、视频、语音都一样——只要需要下载，就不能挡住收消息。可以同时下几份，下完再按到达顺序一条条交给后面处理；不把多条合成一条。纯文字没有附件，照样按顺序处理。

### IM 进来的图也要带上文件地址

微信、钉钉这些渠道发过来的图片，跟任务里贴图一样：先落到本机，再把文件地址一起交给秘书。不能只给图不给路径——秘书以后要改这张图、另存、或告诉用户文件在哪，都得靠这个地址。正文里不必再重复列一遍路径。

### 联络空着时，微信没连上就要直接出扫码

联络里还没有任何对话时，如果微信还没连上，空页面里要直接出现扫码，不用先去设置里点一下。已经连上了就不要占地方。磁盘上还留着旧登录、但其实没连上时，也要自动出码，别当成已经配好。启动后如果旧登录正在自己重连，先等它一下；连上了就不用出码，连不上再出。

## 文件 / 规模

多文件，主入口：`electron/services/im/im.service.ts`（~1607 行）

| 文件 | 行数 | 说明 |
|------|:---:|------|
| `im.service.ts` | 1607 | 核心调度：会话路由、平台生命周期、Agent 桥接、当前会话状态 |
| `types.ts` | 166 | 共享接口：`IMAdapter`、`IMServiceConfig`、`IMIncomingMessage`、`SendFileResult` 等 |
| `dingtalk-adapter.ts` | 608 | 钉钉适配器 |
| `feishu-adapter.ts` | 1088 | 飞书适配器（最大，含完整飞书 SDK 接入） |
| `wecom-adapter.ts` | 368 | 企业微信适配器 |
| `wechat-adapter.ts` | ~650 | 微信适配器（依赖 `wechat/` 子目录） |
| `slack-adapter.ts` | 358 | Slack 适配器 |
| `telegram-adapter.ts` | 407 | Telegram 适配器 |

## 公开 API（IMService，32 个 public 方法）

### 生命周期 / 配置

| 方法签名 | 用途 |
|---------|------|
| `setDependencies(deps: IMServiceDependencies): void` | 注入 agentService、historyService、aiService 等依赖（`main.ts` 启动时调用） |
| `setMainWindow(win): void` | 设置主窗口引用（用于桌面通知/前端事件推送） |
| `setExecutionMode(mode: ExecutionMode): void` | 设置 Agent 执行模式（strict/relaxed/free） |
| `setSendProcessMessages(enabled: boolean): void` | 是否将 Agent 中间过程消息推送到 IM |
| `setSendThinkingProcess(enabled: boolean): void` | 是否推送 Agent reasoning content（思考过程） |
| `registerAdapter(adapter: IMAdapter): boolean` | 注册自定义适配器（插件扩展点）；同一 platform 只允许一个，冲突时拒绝后来者并返回 false。事务式：回调绑定全部成功后才写入注册表，绑定抛错（冻结/只读属性/throwing setter）时抛出且不留下占用 platform 的实例 |
| `async unregisterAdapter(adapter: IMAdapter): Promise<void>` | 撤销插件适配器：移除注册、切断入站回调并 stop；仅当当前注册实例与传入实例一致时生效。回调解绑失败只记录日志，不阻止 stop() |

### 钉钉

| 方法签名 | 用途 |
|---------|------|
| `async startDingTalk(config: DingTalkConfig): Promise<{success, error?}>` | 启动钉钉连接 |
| `async stopDingTalk(): Promise<void>` | 断开钉钉 |
| `isDingTalkConnected(): boolean` | 查询钉钉连接状态 |

### 飞书

| 方法签名 | 用途 |
|---------|------|
| `async startFeishu(config: FeishuConfig): Promise<{success, error?}>` | 启动飞书连接 |
| `async stopFeishu(): Promise<void>` | 断开飞书 |
| `isFeishuConnected(): boolean` | 查询飞书连接状态 |

### Slack

| 方法签名 | 用途 |
|---------|------|
| `async startSlack(config: SlackConfig): Promise<{success, error?}>` | 启动 Slack 连接 |
| `async stopSlack(): Promise<void>` | 断开 Slack |
| `isSlackConnected(): boolean` | 查询 Slack 连接状态 |

### Telegram

| 方法签名 | 用途 |
|---------|------|
| `async startTelegram(config: TelegramConfig): Promise<{success, error?}>` | 启动 Telegram 连接 |
| `async stopTelegram(): Promise<void>` | 断开 Telegram |
| `isTelegramConnected(): boolean` | 查询 Telegram 连接状态 |

### 企业微信

| 方法签名 | 用途 |
|---------|------|
| `async startWeCom(config: WeComConfig): Promise<{success, error?}>` | 启动企微连接 |
| `async stopWeCom(): Promise<void>` | 断开企微 |
| `isWeComConnected(): boolean` | 查询企微连接状态 |

### 微信（流程特殊：需先扫码登录）

| 方法签名 | 用途 |
|---------|------|
| `async loginWeChat(onCredentials?): Promise<{success, qrcodeUrl?, error?}>` | 启动微信扫码登录；拿到二维码即返回。`onCredentials` 在 QR `confirmed` 时触发一次（可异步，与连接态解耦），调用方须在此持久化 token/baseUrl。过程经 `im:wechatLoginStatus` 推送（qr/scanned/refreshing/confirmed/error）；过期自动换码 |
| `async cancelWeChatLogin(): Promise<void>` | 取消进行中的扫码（未连接时丢弃 adapter，停止刷码） |
| `async startWeChat(config: WeChatConfig): Promise<{success, error?}>` | 用 `loginWeChat` 拿到的凭证启动微信连接 |
| `async stopWeChat(): Promise<void>` | 断开微信 |
| `isWeChatConnected(): boolean` | 查询微信连接状态 |

### 统一操作（基于"当前活跃会话"）

| 方法签名 | 用途 |
|---------|------|
| `async stopAll(): Promise<void>` | 断开所有平台 |
| `getStatus(): IMServiceStatus` | 获取所有平台连接状态 |
| `getLastContact(): IMLastContact \| null` | 获取最近交互的联系人（跨平台） |
| `hasActiveSession(): boolean` | 是否有活跃 IM 会话 |
| `async sendNotification(text, options?): Promise<{success, platform?, error?}>` | 通用通知：自动选择最近联系平台投递 |
| `async sendFileForCurrentSession(filePath, fileName?): Promise<SendFileResult>` | 向当前会话发文件 |
| `async sendImageForCurrentSession(filePath): Promise<SendFileResult>` | 向当前会话发图片 |

## 核心类型 / 接口

```ts
type IMPlatform = "dingtalk" | "feishu" | "slack" | "telegram" | "wecom" | "wechat"
type ExecutionMode = "strict" | "relaxed" | "free"

interface IMAdapter {
  platform: IMPlatform
  start(config): Promise<{ success: boolean; error?: string }>
  stop(): Promise<void>
  isConnected(): boolean
  sendMessage(targetId, content, opts?): Promise<{ success: boolean; error?: string }>
  sendFile?(targetId, filePath, opts?): Promise<SendFileResult>
  onMessage(callback: (msg: IMIncomingMessage) => void): () => void
}

interface IMIncomingMessage {
  platform: IMPlatform
  contactId: string; contactName?: string
  content: string; timestamp: number
  messageId?: string; isGroup?: boolean; groupId?: string
  attachments?: IMAttachment[]
}

interface IMServiceDependencies {
  agentService: AgentService
  historyService?: HistoryService
  aiService?: AiService
  configService?: ConfigService
}

interface IMLastContact {
  platform: IMPlatform; contactId: string; contactName?: string
  isGroup?: boolean; groupId?: string; timestamp: number
}

interface SendFileResult { success: boolean; error?: string; messageId?: string }
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `AgentService` | **必需** | 通过 `IMServiceDependencies` 注入；入站消息进 Agent，Agent 回复出 IM |
| `DocumentParserService` | 可选（懒加载） | `prepareImAgentMedia` 解析 IM 入站 PDF/Word 等，对齐桌面上传的 `documentContext` |
| `HistoryService` | 可选 | 通过 `IMServiceDependencies` 注入；记录会话上下文 |
| `AiService` | 可选 | 通过 `IMServiceDependencies` 注入；某些适配器（如飞书图文）需要 |
| `EventBus`（`getEventBus()`） | 可选 | 平台连接事件全局广播 |

## 关键行为 / 数据流

**入站消息 → Agent 对话**：
1. 适配器内部 SDK 收到消息 → `onMessage` 回调
2. → IMService 内部把消息构造为 `IMIncomingMessage`，记录 `lastContact`
3. → `prepareImAgentMedia`：
   - 常见图片（jpg/png/gif/bmp/webp，≤10MB）→ `AgentContext.images` / `previewImages`（联络气泡直接显示 + 多模态）
   - 可解析文档（pdf/docx/xlsx/txt/md…）→ `DocumentParserService` 解析后经 `formatAsContext` 写入 `documentContext`（对齐桌面上传，无需再 `read_file`）；扫描版 PDF 预览页进 `images`
   - 其余附件 → `AgentContext.attachments`（UI chip）
4. → 通过 `agentService.runAssistant(COMPANION_AGENT_KEY, message, context)` 启动 Agent；已消费附件不再塞进「用户发送了文件」文案列表
5. → Agent 输出（含中间过程，受 `processMode` 控制）通过适配器发回原平台

**手动发通知（来自 Agent 工具或外部触发）**：
1. `sendNotification(text)` 检查 `lastContact` → 选定目标平台
2. → 调用对应适配器的 `sendMessage(targetId, text)`

**微信登录的两阶段流程**（其它平台单步）：
1. `loginWeChat(onCredentials)` → 启动扫码登录 → 凭证回调
2. → 用户保存凭证后，再调 `startWeChat(config)` 完成连接

**微信适配器（WeChatAdapter）长轮询可靠性设计**：
- `startPolling` 启动时：先立即 `setConnected(true)` + 启动 `pollLoop`，再后台并发发 `notifyStart`（不阻塞接收）。之前 `notifyStart` 串行阻塞时，若请求挂起会导致 `pollLoop` 迟迟不启动，造成"重启后收不到消息"。
- session 过期（`errcode=-14`）：`pauseSession` 暂停 1h 后自动 `continue` 继续轮询（自愈），不再 `break` 导致 loop 永久停止。
- `getUpdatesBuf` 游标持久化到 `~/.openclaw/openclaw-weixin/accounts/<accountKey>.sync.json`，进程重启后恢复，避免漏消息。
- **`errcode=-2` / `ret=-2` 静默对齐官方 SDK**：服务端 `sendmessage` 在 body 返回 `-2`（`errmsg` 可能是 `unknown` 或 `prepare failed`）是 ilink 的"软失败"信号（语义模糊：可能限流、可能会话未就绪），官方只看 HTTP status、不解析 body → 调用方视作这次没送到，但**下一条仍可继续**，不得抛成未处理拒绝、不得记成崩溃。同一用户持续软失败时，桌面提示一次「未能发送到微信。请在微信里再给我任意发一条消息。」；用户再发进来后才允许再提示。
- `context_token` 出入站同步：每条 inbound 消息携带新 `context_token`；若与上次不同，`handleMessage` 立即 `invalidateUser` + `await getForUser` 重新注册服务端 per-user session（对齐上游 `monitor.ts`）。出站 `runWithContextToken` 永远从持久化 store 取最新 token，避免 token 漂移。
- **`typing keepalive` 生命周期**：对齐上游 `createReplyDispatcherWithTyping`——`IMService.runAgentTask` 在任务开始时调 `beginOutboundSession`，`finally` **await** `endOutboundSession`；**不在**每条 `sendText` 时停止 keepalive（否则长任务约 2–3 分钟后出站失败）。同时设有 `TYPING_KEEPALIVE_LEAK_MS`（3h）泄漏保护，避免遗漏 `endOutboundSession` 时永久挂着。sendTyping 不抛 errcode（与官方一致），单次 HTTP 失败仅 log，由下次 interval 自动重发，**不再**做 consecutiveFailures + restart 那套额外机制。
- **出站串行 lane + `run_id`（2.4.4 对齐）**：`beginOutboundSession` 创建 `WeixinOutboundSession`（`wechat/outbound-session.ts`），同一用户任务内所有 `sendText`/媒体/工具进度消息经 **串行队列** 发出，相邻两条间隔 ≥ `WEIXIN_OUTBOUND_MIN_INTERVAL_MS`（450ms），且 `sendmessage` 请求体携带官方 `run_id`。
- **自带出站能力的工具跳过过程通知**：`talk_to_user`（经 `sendNotification` 投递）与 `ask_user` 不推「🔧 调用 …」卡片，避免与正文重复。
- **结构化工具进度（默认关）**：`processMode='all'` 时默认走纯文本「🔧 调用 …」进度通知。结构化 `TOOL_CALL_START` / `TOOL_CALL_RESULT`（`sf-reply-progress.ts` + `notifyToolProgress`）保留实现但默认不启用——手机微信普通会话客户端不渲染这两种 item type，开启反而会让用户看不到任何过程消息。
- **流式 partial 防外发**：`IMService.runAgentTask` 维护 `messageStreaming` 标志位，`flushTextBuffer` 在 message step 仍处于流式态时直接 return，防止 `sendToolNotify` 抢在 message 定稿前把"未收尾"的 partial 文本发出去（partial 与最终定稿差几个字符就会被 `lastFlushedBody` 字面去重漏掉，导致两条几乎一样的消息）。
- **vendored 版本**：`@tencent-weixin/openclaw-weixin@2.4.4`（含 `sendMessageItemWeixin`、`run_id`、`reply-progress-sender`、`error-notice`）。
- **微信发送失败的桌面兜底**：HTTP 错误 / 网络超时等真硬失败时，才尝试往微信里发「请再发一条」并同时弹桌面提示。软失败（`-2`）不走这条路——那条提示同样发不出去，只在桌面提示一次，见上条。
- **IM 投递工具失败必推送到聊天**：`send_file_to_chat` / `send_image_to_chat` / `send_to_chat` 的 `tool_result` 失败会经 `IMService` 发到当前 IM 会话（与 `processMode` 无关），避免错误仅出现在桌面 Companion 面板。
- **工具失败补 ❌ 提示**：`processMode='all'` 时，普通工具 `tool_result.success === false` 会经 `formatToolFailureNotification` 发一条「❌ {label} 失败：{原因首行}」到 IM，让用户能与"🔧 调用 …"开始通知配对、看清成败。成功工具不刷 ✅（频繁正面反馈会推高出站密度逼近微信 -2 阈值，最终回复会体现成果）。`processMode='messages'` 不发工具调用记录（🔧/❌），只发 AI 正文。
- **工具进度顺序对齐**：`IMService.runAgentTask` 维护 `pendingAfterMessage` 缓冲与 `enqueueAfterMessage`：流式 message 期间所有「🔧 调用 / ❌ 失败」入队都先挂起，待 message 定稿那一刻批量转入 `sendQueue`，使 IM 端顺序变为「message → 工具相关」与桌面 UI 一致（streaming-tool-executor 在 args 收齐就 finalize，原本会让工具通知早于 message）。`onComplete` / `onError` 兜底刷出，防止流式中途异常退出时通知卡住。
- **桌面 tab 运行态同步**：`runAssistant` 回调 `onStart` 向主窗口发 `agent:running { agentId, userTask }`，与 `agent:step` / `agent:complete` 并列；`App.vue` 据此置位联络 tab `isRunning`，使 Watch `talk_to_user` 在 companion 任务进行中走延迟注入而非立即打断 UI（详见 `agent/SPEC.md`「talk_to_user 主动消息与桌面 UI 同步」）。
- **过程消息三态（`processMode`）**：`IMServiceConfig.processMode` 替代旧的布尔 `sendProcessMessages`，三态语义：
  - `'final'`：仅最终结果，执行过程完全静默
  - `'messages'`（默认）：发 AI 写给用户的中间正文，不发工具调用记录（🔧/❌）。介于"完全静默"与"全量噪音"之间——用户能看到 AI 的对话节奏，但不被工具调用刷屏，也不逼微信触发风控
  - `'all'`：正文 + 工具调用记录都发，微信渠道用 digest buffer 节流防风控
  `IMService.runAgentTask` 派生两个布尔：`sendMessages = processMode !== 'final'`（控制正文出站）、`sendToolProgress = processMode === 'all'`（控制工具调用通知）。
- **微信过程消息 digest（progress buffer）**：`processMode !== 'final'` 时，`IMService` 在 `beginOutboundSession` 传入 `bufferProgress`；实现 `IMProgressOutboundCapable` 的适配器（当前仅 `WeChatAdapter`）经 `wechat/outbound-progress.ts` 累积工具进度（🔧/❌）与中间 message 正文，**25s 定时**或 **满 12 行**或 **`flushProgress` 调用**（任务结束 / ask / confirm 前）合并为 digest。**本会话首条正文立即 flush**（不等 25s），让用户发消息后尽快看到 AI 在回复；后续正文与工具进度仍走节流。digest 不带标题前缀——微信原生"输入中"状态已能表达进行中，digest 只发内容本身。`IMService` 只调 `sendProgressText`（工具通知，走 `push`）/ `sendProgressMarkdown`（正文，走 `pushBody`）/ `flushProgress` 可选方法，不感知微信平台细节。最终结果、任务错误、投递失败、ask/confirm 仍走 `sendText` / `sendMarkdown` 直发。
- **正文边界感知 flush（防腰斩）**：`WechatProgressBuffer.pushBody` 入队正文时**先 flush 当前 buffer 里已积攒的工具进度**（让 🔧/❌ 先走），再把正文单独入队；正文**不参与 maxLines 计数**（避免长正文被工具通知顶出去）。**首条 body 立即 flush**；非首条 body 入队后调 `scheduleFlush`，行为是"合并优先、定时兜底"：① 25s 内来了工具通知 `push`（`'all'` 模式）且 timer 未 fire，body 与工具通知并入同一 digest；② 25s 内没来工具通知（`'messages'` 模式或多轮间隔长），timer fire 把 body 切出，避免长任务正文堆积；③ `flushProgress` 调用（任务结束 / ask / confirm）无条件切。digest 渲染时正文不带 `· ` 前缀，工具进度带。这取代了旧版"纯时间/行数硬切"导致的正文腰斩问题。
- **配置隐式迁移**：旧布尔 `imSendProcessMessages` 升级到新枚举 `imProcessMode` 时不走 migration 框架，而是在 `main.ts` 启动读取与 `im:getConfig` handler 中做隐式推断——优先读新字段 `imProcessMode`，若无则按旧字段推断：`imSendProcessMessages=false` → `'final'`，`true` 或未设置 → `'messages'`（新默认）。启动时把推断结果写回 `imProcessMode` 完成一次性迁移。
- **`❌ → 🔧` 乱序自愈**：`onToolCompleted` 内顺序是 `ensureToolResultStep → finalizeToolCallStep`，对应 tool_result onStep 比 tool_call.isStreaming=false onStep 早到一拍。IMService 在 tool_result 失败分支若发现该 toolCallId 的 `tool_start_by_call_id:{id}` 还没在 `notifiedToolCalls` 中，会先补一条「🔧 调用 …」入队再发「❌ 失败」；后续真正的 tool_call finalize onStep 命中同一 callIdKey 自动跳过，确保 IM 端始终是「🔧 → ❌」。

**适配器架构**：每个平台一个 `*Adapter`，构造时从 `getEventBus()` 拿事件总线，注册到 IMService 的 `adapters: Map<IMPlatform, IMAdapter>` 中。

## 关键约束

- **每个平台必须实现 `IMAdapter` 接口**——新增平台必须走该接口规范
- **入站消息处理在 IMService 内集中**——适配器只能通过 `onMessage` 回调上报，**严禁**适配器内部直接调 `agentService.run`
- **微信连接必须先 `loginWeChat` 拿凭证**——不得跳过登录直接 `startWeChat`
- **`sendNotification` 依赖 `lastContact`**——无活跃会话（`hasActiveSession()` 返回 false）时返回 `success: false`
- **平台连接失败必须返回 `{success: false, error}`**，不得静默或抛异常
- **不得在 `setDependencies` 之前调任何 `start*` 方法**
