# Watch Service SPEC

> Last verified: 2026-07-30（心跳 Markdown 章节）

## 设计目标

### 电脑睡过去的关切，真正恢复后再做完（2026-10-24）

- **问题**：合盖后系统会自己黑屏醒几十秒。到点的关切在这个窗口里开工，电脑马上又睡回去。15 分钟上限把睡觉的时间也算进去，再次醒来就被停掉。人真正开盖时，这一次已经记成失败，不会再做。
- **取舍**：黑屏那种短醒来不重跑——窗口不够，重跑也做不完。只在电脑真正恢复（开盖、屏幕亮）时，把被睡眠打断的那次重新做一遍。关切每次从头做，不接半截对话。
- **成功标准**：
  - 人醒着、关切真的跑满 15 分钟被停，仍算超时失败，开盖不会自动再跑。
  - 跑的过程中电脑睡了、因此被停：不算熔断，也不因此去叫醒唤醒。总览写明电脑睡了、醒来会继续。
  - 下次真正恢复时自动再跑一次。做成了就结束。再被睡打断，还记着，下次恢复再做。
  - 接口报错这类失败，不因为开盖就自动重跑。
  - 唤醒自己的心跳不参与。
- **明确不做**：不靠黑屏醒来把事情做完；不把睡眠时间从 15 分钟里扣掉后硬续同一轮已经断开的请求。

### 心跳 prompt 用 Markdown 章节分区；联络摘要不得压过通道指令（2026-07-30）

- **问题**：通道约束只是散文一句，夹在大段情境与上万字联络 transcript 之间；模型把心跳当成「继续聊天」，用最终文本回话、不调 `talk_to_user`，用户在联络/IM 收不到。
- **取舍**：用 **Markdown 章节**（`# 通道` / `# 情境` / `# 身份与判断`，联络由代码追加 `# 联络摘要`）把层次拆开；**不写细提醒表**。联络用 **L4 一句话概要**（复用 `generateSummary`），总预算超限时丢最旧整行——不对单条正文中段硬截断。
- **成功标准**：
  - 默认 `HEARTBEAT.md` 以 `# 通道` 开头，明确：最终文本用户看不到，要对用户说必须 `talk_to_user`。
  - `# 情境` 承载 `{{TIME}}` / `{{EVENTS}}` / `{{TODO}}` / `{{ACTIVITY}}`。
  - `# 身份与判断` 点明私人秘书 + 轻量决策（含「没新事件 ≠ 没事」）。
  - 联络注入为 `# 联络摘要`：最近 **12** 次互动的 L4 行；总预算约 **2500** 字符（超限丢最旧行）；steps 只取 user_task / final_result / proactive_notice；**不注入** `message.images` / 多模态附件 / `message` 内心独白。
  - 已有 `HEARTBEAT.md` 若无 `# 通道` 且仍是系统默认系模板（含模板变量且含旧文案），启动时升级为新章节模板。
- **明确不做**：不改宿主「漏调 talk_to_user 不自动转发最终文本」；不把面板视觉规则搬进心跳；不为自定义 HEARTBEAT 强行整份覆盖（仅识别默认系再升级）；不做单条 500 字中段硬截断。

### 心跳点明秘书身份；待办不被「无新事件」沉默吃掉（2026-07-30）

- **问题**：`{{TODO}}` 已注入唤醒 prompt，但默认 `HEARTBEAT.md` 写死「无新事件且间隔不到 6 小时 → 直接结束」，模型把例行检查当成没事，对临近/逾期待办一律沉默，从不 `talk_to_user`。
- **取舍**：大模型本来就会当秘书，**不写细提醒表**（不规定 48h/工期比例等）；只需**点明私人秘书身份**，并改掉与待办冲突的硬沉默规则，把判断交给模型。
- **成功标准**：
  - 默认心跳模板点明：你是私人秘书，除事件外也要盯待办；「没新事件」≠「没事」。
  - 「无新事件直接结束」改为：没新事件、**也没什么该跟进的待办**时才沉默；提醒过且状态没变不反复催。
  - 待办指引保持轻量（提一两件、别念清单），不做程序硬提示、不搬面板视觉规则进心跳。
  - 已有 `HEARTBEAT.md` 若仍含旧「6 小时直接结束」句：启动时**精确替换该句并补秘书身份段**，不整份覆盖，以免抹掉用户其它自定义。
- **明确不做**：不在心跳里写细决策树；不做宿主自动代发待办提醒；不改 `{{TODO}}` 注入机制本身。

### 默认执行超时放宽到 15 分钟（2026-07-25）

- **问题**：默认墙钟超时 300s，复杂关切（多轮工具 / 网页 / 技能）未跑完就被判超时；且易与「网络失败重试耗尽」语义混淆。
- **成功标准**：
  - 未显式配置 `execution.timeout` 时，默认 **900s（15 分钟）**。
  - 超时仅表示「任务跑太久」的墙钟上限；网络失败仍应由 AI 层有限重试后报网络错误（分语义修复另项推进）。
- **明确不做**：本次不改已显式写入的 `execution.timeout`；不做网络错误 vs 超时的完整分码改造。

### 基础设施失败不得高频重入；唤醒不因自身失败再触发（2026-07-23）

- **问题**：唤醒失败 → `notifyFailure` 发 `watch_failure` → 唤醒再匹配 → 立即重入；叠加非法 `apiUrl`（`ERR_INVALID_URL`）每轮冷启动 Agent，形成失败风暴。
- **成功标准**：
  - 唤醒 **不因自身失败** 再 emit / 再匹配 `watch_failure`（其它关切失败仍可叫醒唤醒，由 AI 决定是否 `talk_to_user`）。
  - 执行前结构化预检 AI profile（空 URL / `new URL` 抛错 / 缺 model）→ skip，不跑 Agent；用错误码/预检结果分类，**禁止** message 关键词匹配。
  - 按 `watchId` 的 circuit breaker：config 类长退避、transient 短退避；熔断时最多一次用户可见引导，不走 wakeup→`talk_to_user` 环。
- **明确不做**：不移除 `watch_failure` 触发器；不做「漏调 talk_to_user 时宿主自动转发最终文本」的兜底。

### 关切 = 后台执行 + 面板透明 + 需要时找人（2026-07-21）

- **问题**：曾用 `output` 分流「助手 vs 绑 PTY」；silent/local 走 PTY 不推步骤，关切面板假「正在启动」，过程黑盒。PTY 路径并非 CLI 无头设计，而是旧实现残留。
- **成功标准**：
  - 关切 Agent **一律本机助手形态**（`__watch__:${watchId}` / wakeup 用 `__wakeup__`）；需要跑命令时用 `exec` 等工具，**不再为关切创建/绑定专用 PTY**。
  - 执行过程一律进关切面板（`agent:step`）；手动触发必开内心独白。
  - 后台无确认 UI，执行模式为 `free`（避免卡在 dangerous 确认上）。
  - 不进任务面板；需要打扰用户时走 `talk_to_user` → 联络（关切存在的目的）。
  - `output` 只影响对外派发/打扰策略，**不再选择执行形态**。
- **明确不做**：不为 silent 保留 PTY 旁路；不把每次执行灌进任务侧栏。

### 普通关切对用户可见通道与唤醒对齐（2026-07-22）

- **问题**：唤醒 prompt 已写明「用户看不到常规输出，只有 talk_to_user 能送达」；普通关切仅有弱提示「最终文本仅作内部日志」，模型常把任务指令里的「提醒用户」写成普通文本收工，漏调 `talk_to_user`，联络/IM 收不到。
- **成功标准**：
  - `buildEnhancedPrompt` 对普通关切明确区分两通道：**关切面板**可见内心独白 ≠ **联络/IM** 已送达。
  - 措辞与唤醒同级：用户在联络/IM **看不到**常规文本回复；要对用户说话必须调用 `talk_to_user`；纯文本收工等于没通知。
  - 无需打扰时直接结束（可短内部日志），不要把「本该发给用户的话」写进最终文本假装已送达。
- **明确不做**：不做「漏调 talk_to_user 时宿主自动把最终文本当通知」的兜底（避免误打扰；与 wakeup 一致靠 prompt 约束）。

### 运营总览：异常关切点重试不离开总览（2026-08-21）

- **问题**：总览异常关切点「重试」会切到关切详情页，只想再跑一次却被拉走。
- **成功标准**：总览异常关切点重试，就地触发再跑，人留在总览；该项随后出现在「正在执行」。
- **明确不做**：不把总览重试当成进详情的入口；点关切名称、看失败流水仍可进详情。

### 运营总览：即将执行 ↔ 流水主从，列表不折叠（2026-07-22）

- **问题**：总览「即将执行」单击跳进关切配置页，从值班台日程心智切到设置；列表又用「展开剩余 N 项」折叠，空间未用尽仍要多点一次。另：右侧流水若只在「全局最近 N 条」里前端过滤，低频关切会被今日活跃关切挤出窗口，误显示「尚无执行记录」。
- **成功标准**：
  - 点「即将执行」一行：留在总览；右侧「最近执行流水」过滤为该关切；行有选中态；标题体现当前关切名。
  - **聚焦某关切时按 `watchId` 向后端拉取该关切历史**（`getHistory(watchId, N)`），不得仅在全局最近窗口里前端筛。
  - 再点同一行，或点「返回」，取消选中，右侧恢复全部流水。
  - 选中态提供「查看更多」：进入运行历史页并按该关切拉取完整流水（可翻页）；未选中时「查看全部」仍进运行历史总表。
  - 点右侧流水仍进执行详情叠层（既有行为）；进关切配置不靠整行跳转（异常/运行中区既有动作保留）。
  - 「即将执行」「最近流水」列表不折叠；超出容器高度用滚动条。
- **明确不做**：不做点击即将执行即切到关切详情/配置页；不做「展开/收起」折叠条；总览内不做流水翻页。

### 执行速览存储：用户关切与唤醒分桶（2026-07-22）

- **问题**：产品/UI 已把唤醒与关切拆开（总览隐藏 wakeup、觉醒历史独立页），但 `WatchStore.history` 仍混写；心跳高频占满 500 条上限，挤掉用户关切速览。前端「过取再滤」治标不治本。
- **成功标准**：
  - **两本账**：`history`（用户关切速览）与 `wakeupHistory`（唤醒速览）物理分桶，**各自**上限（默认各 500），互不挤占。
  - 写入：`recordExecution` / `addHistory` 按 `watchId === '__wakeup__'` 分流；唤醒**不丢**，只是不进用户关切账。
  - 读取：`getHistory()` 无 id → 仅用户关切；`getHistory('__wakeup__')` → 仅唤醒；其它 id → 用户账内按关切过滤。
  - 清除：`clearHistory()` → 清用户关切账；`clearHistory('__wakeup__')` → 清唤醒账。
  - 启动时若尚无 `wakeupHistory` 键，从旧混写 `history` **一次性拆分迁移**，不丢已有记录。
  - Agent 正文仍在 `history/watch/` 树（与本次速览分桶正交，不变）。
- **明确不做**：不靠前端过取过滤伪装分桶；不把唤醒从速览里「删掉不记」。

### 单关切流水以正文树为准（2026-07-22）

- **问题**：分桶前心跳已挤掉大量用户关切速览；某关切在 `history/watch` 正文树里仍有完整执行（如数十条），但 `getHistory(watchId)` 只读速览账，总览聚焦后只剩一两天。
- **成功标准**：
  - `getHistory(watchId)`（普通关切）以 **`history/watch` 索引**为列表真相源，按该 `watchId` 筛（`__watch__:${id}` 或 session id 前缀 `watch_${id}_`），再与速览账按 `agentSessionId` 合并补齐 output/error/triggerType。
  - 无参 / `__wakeup__` 仍走速览分桶（唤醒列表、全局最近流水）。
  - 点进详情仍用 `agentSessionId` 拉正文（既有行为）。
- **明确不做**：不把正文树全量灌回速览账（避免再撑爆 500）；不靠过取速览假装完整。

### 不同 Watch 允许并发（2026-07-21）

- **问题**：EventBus + `handleEvent` 串行 `await`，且曾共用单一 `__watch__` Agent，导致不同关切互相堵。
- **成功标准**：
  - **不同** `watchId` 可并行；**同一** `watchId` 互斥。
  - **wakeup** 自身单实例，可与普通关切并行。
  - 全局并发软上限默认 **5**；超额排队不丢弃。
  - 每关切独立 Agent：`__watch__:${watchId}`；历史 `kind=watch`。
- **明确不做**：不改 companion / 任务并行模型；不无限并发。

## 职责

定时/事件驱动的自动化任务引擎。Watch 是 Agent 的「关注点」：后台用本机助手 Agent 执行 prompt，过程在关切面板可见，需要时经 `talk_to_user` 进联络。旧 Scheduler 已迁移进关切系统。

## 文件 / 规模

多文件，主入口：`electron/services/watch/watch.service.ts`（~1677 行）

| 文件 | 行数 | 说明 |
|------|:---:|------|
| `watch.service.ts` | 1677 | 核心引擎：调度、事件匹配、Agent 执行、结果派发、心跳管理 |
| `store.ts` | ~320 | 持久化：Watch 定义 + 用户关切/唤醒分桶执行速览 |
| `event-pool.ts` | 256 | 事件池：消抖、批量合并 |
| `templates.ts` | 290 | 预置模板（8 个内置模板） |
| `types.ts` | 24 | 共享类型 |

## 公开 API（WatchService，25 个 public 方法）

### 生命周期 / 注入

| 方法签名 | 用途 |
|---------|------|
| `init(config: WatchServiceConfig): void` | 初始化引擎（注入依赖、加载持久化数据） |
| `async start(): Promise<void>` | 启动调度器与传感器，激活已启用的 Watch |
| `stop(): void` | 停止引擎 |
| `setMainWindow(win: BrowserWindow \| null): void` | 设置主窗口（桌面通知/标签页通道） |

### Watch CRUD

| 方法签名 | 用途 |
|---------|------|
| `create(params: CreateWatchParams): WatchDefinition` | 创建 Watch（**注意**：不是 `createWatch`） |
| `update(id, updates: Partial<CreateWatchParams>): WatchDefinition \| null` | 更新 Watch |
| `delete(id: string): boolean` | 删除 Watch |
| `get(id: string): WatchDefinition \| undefined` | 获取单个 Watch |
| `getAll(): WatchDefinition[]` | 获取全部 Watch |
| `toggle(id: string): WatchDefinition \| null` | 启停切换 |

### 执行 / 状态

| 方法签名 | 用途 |
|---------|------|
| `async triggerWatch(id): Promise<WatchExecutionResult>` | 手动触发一次执行 |
| `isWatchRunning(id: string): boolean` | 单个 Watch 是否在执行 |
| `getRunningWatches(): string[]` | 当前正在执行的 Watch ID 列表 |
| `cancelRunningWatch(id: string): boolean` | 取消正在执行的关切（abort 助手 Agent）；未在跑返回 false |
| `updateWatchState(id, state: Record<string, unknown>): void` | 更新 Watch 自定义状态（Agent 通过 `STATE_UPDATE` 指令调用） |

### 历史

| 方法签名 | 用途 |
|---------|------|
| `getHistory(watchId?, limit?): WatchHistoryRecord[]` | 获取执行历史 |
| `clearHistory(watchId?): void` | 清空历史 |

### 模板

| 方法签名 | 用途 |
|---------|------|
| `getTemplates(): WatchTemplate[]` | 全部模板 |
| `getTemplateCategories(): {id, name, nameEn}[]` | 模板分类列表 |
| `createFromTemplate(templateId, options?): WatchDefinition` | 从模板创建 Watch |

### 关切心跳 / 唤醒

| 方法签名 | 用途 |
|---------|------|
| `ensureWakeup(): boolean` | 确保唤醒态心跳文件存在 |
| `removeWakeup(): void` | 清除唤醒态 |
| `resetHeartbeatFile(): boolean` | 重置心跳文件 |

### 环境查询 / 数据迁移

| 方法签名 | 用途 |
|---------|------|
| `getSshSessions(): SshSession[]` | 获取可用 SSH 会话（兼容旧创建 UI；执行已统一助手，不再绑 SSH PTY） |
| `migrateFromScheduler(schedulerStore): {migrated, skipped, errors[]}` | 从废弃的 Scheduler 一次性迁移数据（启动时自动调用） |

## 核心类型 / 接口

```ts
interface WatchServiceConfig {
  configService: ConfigService; agentService: AgentService
  aiService: AiService; sensorService: SensorService
  historyService?: HistoryService
  mainWindow?: BrowserWindow | null
}

interface WatchTemplate {
  id: string; name: string; nameEn: string
  description: string; descriptionEn: string
  category: string; icon: string
  create: (options?) => CreateWatchParams
}

// WatchDefinition、CreateWatchParams、WatchHistoryRecord、
// WatchExecutionResult、SensorEvent 等定义在 shared/types/watch.ts
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `ConfigService` | **必需** | 持久化设置 / SSH 会话列表（兼容） |
| `AgentService` | **必需** | 本机助手 Agent 执行关切 |
| `AiService` | **必需** | Agent 内部依赖（间接） |
| `SensorService` | **必需** | 传感器事件源 |
| `HistoryService` | 可选 | 对话上下文召回 |
| `IMService`（`getIMService()`） | 可选 | 结果推送 IM 渠道 |
| `EventBus` | 可选 | 全局事件广播 |

## 关键行为 / 数据流

**Watch 执行生命周期**：
1. cron/事件触发 → `EventPool` 消抖合并 → `handleEvent(event)`（派发后即返回，不等执行结束）
2. → `findMatchingWatches(event)` → 命中的 Watch 列表
3. → 调度器按全局并发上限（默认 5）排队/放行 → `executeWatch` → **一律** `executeWithAssistantAgent`（`__watch__:${watchId}` / wakeup 用 `__wakeup__`）；步骤经 `agent:step` 推关切面板
4. → `WatchExecutionResult` → `deliverOutput`（**极窄兜底，用户可见消息走 `talk_to_user`**）：
   - 自动触发 / wakeup / 已调 `talk_to_user` → **不派发完成通知**
   - `output.type === 'im'` 且未调 `talk_to_user` → **不派发**
   - 仅手动触发且应用不在前台时，`desktop` / `notification` 可走 IM / 系统通知兜底
   - 执行失败走 `notifyFailure`

**事件消抖**：`EventPool` 在静默窗口内合并同类型事件，触发后清空。

**并发模型**：不同 `watchId` 可并行；同一 `watchId` 互斥；wakeup 可与普通关切并行；全局软上限默认 5，超额排队不丢弃。

**心跳机制**：`HEARTBEAT_FILENAME` 为 Agent 可读的心跳上下文文件（非全局执行锁）；`ensureWakeup` / `removeWakeup` 控制"唤醒态"。默认模板为 Markdown 章节（`# 通道` / `# 情境` / `# 身份与判断`）；`migrateHeartbeatFileIfNeeded` 升级默认系旧模板，并对残留旧沉默句做精确替换。

**联络上下文注入**：`buildEnhancedPrompt` 在**所有** Watch（含内置 `__wakeup__` 心跳）执行前，经 `Companion.formatRecentTurnsForWatchPrompt()` 注入 **`# 联络摘要`（L4）**：最近 **12** 次互动压成一句话概要（`generateSummary`）；总预算约 2500 字符，超限丢最旧整行。只读文本 content，**不带** `images`/base64 附件。steps 仅 user_task / final_result / proactive_notice。10s TTL；`talk_to_user` 落盘后失效缓存。联络页按大约十段真对话来拼，主动提醒不占这段名额。普通关切另注「通道说明」，与唤醒 `# 通道` 同级。

## 关键约束

- **方法名遵循 store 风格**（`create` / `update` / `get` / `getAll` / `delete` / `toggle`），**不是** `createWatch`/`updateWatch`/...
- **执行形态**：关切一律本机助手 Agent（`__watch__:${watchId}` / `__wakeup__`）；禁止再为关切创建专用 PTY
- **过程透明**：执行步骤必须推关切面板；`output` 只约束对外打扰，不关掉面板可见性
- **后台执行模式**：`executionMode: 'free'`（面板隐藏 confirm，否则会卡在 dangerous 工具）
- **旧 `execution.type=ssh`**：不再连 SSH PTY，回退本机助手并打 warn；远程巡检需另方案（如 SSH 工具）
- **`init()` 必须在 `start()` 之前调用**——依赖在 init 时冻结，运行时不可改
- **落盘输出受 `MAX_OUTPUT_LENGTH` 截断**——`HistoryStore` 也对单条记录有上限
- **EventPool 消抖时间不得硬编码**——必须从 Watch 定义读取
- **心跳文件由 `HEARTBEAT_FILENAME` 唯一管理**——禁止任何代码自建心跳锁
- **`migrateFromScheduler` 是一次性操作**——重复调用以现存 Watch 为准（去重）
- **`updateWatchState` 是 Agent 状态更新接口**——禁止外部直接调用，必须经 Agent 的 `STATE_UPDATE` 指令
- **同 Watch 不重入**；**全局并发默认上限 5**（超额排队）
- **前端内心独白**：手动触发 / 运行中在关切面板展示过程（与 `output` 类型无关）
