# AiService SPEC

> Last verified: 2026-09-11

## 职责

AI API 的统一调用层。封装 OpenAI 兼容协议的 HTTP 请求，提供同步/流式、纯对话/工具调用四种模式。处理代理、超时、重试、中止、多模态降级等底层复杂性，上层服务只需传入消息和工具定义。

## 设计目标

### 发给视觉接口的图必须是接口认的格式

请求里的图片若不是常见位图（png / jpeg / gif / webp / bmp），不要发出去——文档抽图应已先转成位图，这里挡住残留。若接口仍因图片格式拒收（例如「Invalid base64 image_url」），剥掉图片用正文重试，不得让整次任务失败。

### 单次输出上限不要让用户猜

用户不必知道该填多少。没填时按三万二——现在主流模型都吃得下，也够一次思考再写一大段。拉模型列表时，如果对方告诉了这款模型的输出上限、且这个数明显小于窗口，选中就按这个数用。对方报的数跟窗口一样大或更大，不要填进输出上限——那只是「最多能写这么多」，不是每次都要预留的额度。用户自己填了一个比窗口小的数，仍然听用户的。不为每家模型维护一份手写上限表。

### 能发多少，先扣下它还要说话的地方（设计目标，2026-09-11）

估「这场装得下装不下」时，先扣掉这一次还要留给它说话的额度，再留一点余量。界面上的用量仍按整窗，好跟账单对上。写交接小结时，输出单独收得更紧，小结自己也要先过这道输入检查。

对方报的「单次输出上限」如果大到跟窗口一样、甚至更大，按没填来处理——预留三万二、且不超过窗口的四分之一。预留之后，输入至少还要留下窗口的四分之一。否则十几 K 的对话也会被当成装不下，压缩也救不了（压的是对话，扣掉的却是整窗输出）。

指定的那份模型配置找不到时，按保守窗口来估，不借用旁边另一套模型的大窗口——否则会以为装得下，发出去才被对方拒。真正发请求时仍可以回退到别的可用配置；两件事分开。

明确不做：网关实际路由到哪一款、窗口多大，对方还没告诉我们之前，不假装已经知道。不把对方报的「等于窗口」的输出上限当真去扣。

### 各家报的「输入」按同一个口径记（设计目标，2026-09-26）

各家服务商报用量的方式不一样：有的「输入」本来就含缓存命中的部分，有的把没命中、命中、写缓存拆成三个数分开报。记账时一律折成同一个口径——这一次送过去的全部输入，其中多少是缓存命中的另记一笔。缓存命中和写缓存都是真消耗，不能因为某家拆开报就漏掉。

成功标准：同一场对话换一家服务商，消耗数、上下文占了多少、缓存命中率的意思都不变；不会出现「缓存命中比输入还多」「命中率超过百分之百」。

### 上下文窗口偏小的模型，配的时候就要说清楚不合适

这个软件几乎每一步都在调工具。窗口小的模型通常也是老一代或小参数模型，稳定吐出合法工具调用、多轮不跑偏、长指令不漏条件这几件事都做不好——用户配好、跑了一半才发现不对，那时候的挫败感和时间成本都白付了。窗口本身不是根因，但它跟模型代际高度相关，当代主流模型基本十二万八千起步，所以拿它当「这是不是一个能干活的模型」的粗略判断依据够用了。

成功标准：
- 填写模型窗口时，低于十二万八千就在字段旁常驻一条说明，讲清这个档位的模型通常难以稳定完成多步任务
- 真要存成小窗口时（新配一个，或把窗口从大改小）弹一次确认，让用户在「仍然保存」和「返回修改」之间明确选一次——字段旁的小字容易被划过去，而配错的代价是跑到一半才发现
- 不反复打扰：已经在用小窗口模型的人回来改别的设置，不再拦
- 首次配置向导里选到小窗口的预设也要提醒，新用户最需要提前知道
- 拦得住但不禁止：确认过后照常保存、照常使用。本地离线、断网、省钱都是真实需求，用户有权自己权衡
- 措辞讲事实和后果，不推销、不吓唬，也不替用户下结论

明确不做：
- 不按窗口大小裁剪工具清单，也不为小窗口做其他特殊适配——省出来的空间救不了模型能力，是在给一个救不回来的场景做优化
- 不设硬性下限、不禁用，也不维护「推荐模型白名单」

### 自动重试要对用户说清楚

网络抖动、接口限流、服务端临时出错时会自动再试，但再试本身也可能再等很久（连不上、模型一直不回）。用户不能只看到「几秒后重试」然后干等、以为卡住了。

成功标准：
- 开始等重试间隔时，说清原因、第几次、还要等几秒；秒数要倒数，不能写死一个数字干等
- 间隔一过、请求已经发出去，立刻改成「正在重试、等待模型」
- 这一轮结束（成功、再试下一次、或彻底失败），卡片收成「已重试第几次」
- 彻底失败时，错误本身也要说已经自动重试过，不要只丢一句超时
- 等重试间隔时点停止，必须马上停，不能干等到点再停

明确不做：不把内部超时秒数摊给用户；不让用户配置重试次数。

### 欠费要直接说，不要装成限流或模型坏了

供应商账户没钱了、欠费了，再试、再换模型都没用。用户要立刻知道是该去充值，而不是看着「模型连续无法使用」「频率受限、几秒后重试」干等。

成功标准：
- 对方明确告知是欠费、余额不足或账户配额用尽时，直接告诉用户去供应商控制台充值或检查配额
- 这种错误不自动重试，也不当成「这款模型用不了」去换下一个——换过去多半还是同一笔账
- 真的是请求太频繁（限流）的，仍按原来的自动重试

明确不做：
- 不靠错误句子里有没有「欠费」两个字来猜（说法会变，对方给出的稳定错误类别才算数）
- 某一款模型自己的用量额度用尽、换另一款可能还有额度的，仍按「换模型」处理

### 模型连续用不了时，可以自动换下一个，但只改这场对话

默认模型按上面那套自动重试仍然失败，或这款模型本身明显用不了（不存在、服务过载、这一款的额度用尽）时，如果用户开了「自动切换可用模型」，按配置列表从第一个开始换能用的；当前就是第一个，则从下一个开始。开关默认开；只配了一个模型时没有效果。

成功标准：
- 每一个模型都先走完自己的自动重试，再考虑换；换过去的那个同样先重试，再失败再换
- 切成功后，这场对话继续用新模型，输入框上的模型选择器跟着变
- 对话里留一条说明，并给用户一条轻提示：从哪个换到了哪个
- 用户在设置里排好的顺序就是尝试顺序：从头试，跳过已经失败过的，不从当前这条后面绕一圈

明确不做：
- 不改默认模型——下一场新对话仍用原来的默认
- 对话太长、内容违规、用户点了停止，不因为这些去换模型
- 账户欠费、余额不足不换模型——换了还是同一笔账，只会把真实原因藏起来
- 不先发探测请求；不让用户配置重试次数或切换名单
- 后台小事（比如生成标题）不因为失败去改这场对话用的模型

## 文件

单文件：`electron/services/ai.service.ts`（~2316 行）

## 公开 API

| 方法 | 用途 | 调用方 |
|---|---|---|
| `constructor(configService?)` | 注入与主进程/CLI **同一** `ConfigService` 单例（禁止再 `new ConfigService()`） | `main.ts` / CLI |
| `onProfileFallback(listener)` | 指定 profileId 失效并已回退时回调；返回取消订阅 | `main.ts`（toast）、Agent（步骤提示） |
| `setPluginProviders(providers: ProviderRegistration[])` | 注入插件 AI provider（启动时调用） | `main.ts` 插件加载阶段 |
| `chat(messages, profileId?)` | 纯文本对话（同步） | 知识文档更新、对话索引等后台任务 |
| `chatStream(messages, onChunk, onDone, onError, profileId?)` | 纯文本对话（流式） | 前端 AI 对话面板 |
| `chatWithTools(messages, tools, profileId?)` | 工具调用（同步） | Agent 非流式路径（较少使用） |
| `chatWithToolsStream(messages, tools, onChunk, onToolCall, onDone, onError, profileId?, onToolCallProgress?, requestId?, onRetry?, onToolCallReady?)` | 工具调用（流式）。`onToolCallProgress(id, name, partialArgs)` 在 tool_call 参数流式片段到达时回调，`partialArgs` 为截至当前的完整 JSON 前缀，Agent 据此在"生成参数"阶段即可显示该工具卡片的实时命令文本。`onRetry(retryInfo?)` 在网络错误 / 429 / 5xx 触发自动重试前调用，`retryInfo` 包含 `{ attempt, max, delayMs, reason, statusCode? }`，用于在 UI 上展示「正在重试 N/M」避免用户误以为应用卡死；同时承担"重置已流出脏内容"职责（提供 onRetry 时上层 onChunk 不再收到 `⚠️ 重试中` 文本，由调用方自行渲染）。视觉降级等内部重试不传 `retryInfo`。 | Agent 主执行路径 |
| `abort(requestId?)` | 中止请求 | Agent.abort()、用户取消 |
| `dispose()` | 释放 keep-alive HTTP/HTTPS Agent；CLI 退出前调用避免进程空转 | `electron/cli/index.ts` agent:run finally |
| `static getExplainCommandPrompt(command)` | 命令解释 prompt 模板 | 前端命令解释功能 |
| `static getDiagnoseErrorPrompt(error, context?)` | 错误诊断 prompt 模板 | 前端错误诊断功能 |
| `static getNaturalToCommandPrompt(description, os?)` | 自然语言→命令 prompt 模板 | 前端命令生成功能 |

## 核心类型 / 接口

| 类型 | 说明 |
|------|------|
| `AiMessage` | 消息格式（role + content + 可选 images/tool_calls/reasoning_content/tool_call_id） |
| `ToolDefinition` | Function Calling 工具定义（name + description + parameters schema） |
| `ToolCall` | AI 返回的工具调用（id + name + arguments JSON） |
| `ChatWithToolsResult` | 工具调用结果（content + tool_calls + finish_reason + usage + aborted） |
| `ApiRequestError` | API 请求错误（statusCode + retryAfter + apiErrorCode） |
| `RetryInfo` | 重试信息（attempt + max + delayMs + reason + statusCode） |
| `TokenUsageInfo` | Token 消耗统计（prompt + completion + total + cache_hit/miss） |
| `AnthropicStreamDelta` | Anthropic 流式增量（content/reasoning_content/tool_calls/finish_reason/usage） |
| `AiContentPart` | 多模态内容块（text \| image_url） |

注：`AiProfile` 来自 `@shared/types`，非本文件定义。

## 依赖

- **ConfigService**：获取 AI 配置档案（profiles）、代理设置
- **AiDebugService**：调试日志（请求/响应追踪）

## 关键行为

### 多 Profile 支持

通过 `profileId` 选择使用哪个 AI 配置。未指定时使用 `configService.getActiveAiProfile()` 返回的默认档案。

解析逻辑见导出纯函数 `resolveAiProfile`：
- 列表为空 → 抛/回调 `error.ai_no_config`
- 指定 id 命中 → 使用该配置
- **指定 id 未命中但列表非空** → 回退到 active（再不行则第一个），并 `onProfileFallback` 通知 UI（toast + Agent 步骤流），避免误报「未配置」
- 未指定 id 时 active 失效 → 同样回退到第一个并通知

`AiService` 必须与设置页/Agent 共用同一 `ConfigService` 实例，否则会出现「设置已更新但请求仍读旧列表 / id 对不上」的双缓存问题。

### 代理支持

支持 HTTP/HTTPS/SOCKS5 代理。优先级：Profile 自带代理 > 全局代理设置。

### 超时机制

三层超时保护：
- 连接超时：15s
- 空闲超时：120s（流式数据中断检测）
- 总超时：10min

### 自动重试

| 错误类型 | 最大重试 | 退避策略 |
|---|---|---|
| 网络错误（`err.code`：ECONNRESET / EPROTO / ETIMEDOUT 等；含 TLS 握手中断） | 3 次 | 指数退避 + jitter，基础 2s。判定优先看 Node 系统错误码，不只扫 message（VPN/代理切换时 TLS 断开的 message 常不含错误码字样） |
| Rate Limit (429) | 5 次 | 指数退避 + jitter，基础 5s（优先 `Retry-After` header） |
| 服务端错误 (5xx) | 3 次 | 指数退避 + jitter，基础 3s |

调用方提供 `onRetry` 时可拿到重试信息（第几次、最多几次、还要等几秒、原因；超时会单独标出来）以驱动界面。Agent 路径用一张持续更新的等待卡片：先说「多久后重试」，请求发出后改成「正在重试、等待模型」，结束后收成「已重试第几次」。彻底失败的错误文案也要写明已经自动重试过。

### 多模态降级

请求含图片时，如果 API 返回不支持图片，或因图片本身格式无效而拒收，自动剥离图片用正文重试。不支持的图片格式在发出前就会丢掉，避免无谓打到视觉模型。

### Think 模型支持

支持 DeepSeek-R1 / DeepSeek V3.2+ 等模型的 `reasoning_content` 字段，流式输出时包裹在折叠 HTML 块中。

**DeepSeek V3.2+ 思考模式 + 工具调用的严格规则**（[官方文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)）：带有 `tool_calls` 的 assistant 消息在后续所有请求中必须回传 `reasoning_content` 字段，否则 API 返回 400（`The reasoning_content in the thinking mode must be passed back to the API`）。

`formatMessageForApi` 中对带 `tool_calls` 的 assistant 消息始终输出 `reasoning_content` 字段（缺失时补空串），以同时兼容：

- DeepSeek V3.2+ 思考模式（必须回传）
- DeepSeek R1 / 非思考模式（回传被忽略，无副作用）
- OpenAI 及其他 OpenAI 兼容 API（忽略未知字段）
- Anthropic 原生 API（走 `convertToAnthropicBody` 单独转换，不受影响）

流式收集处用 `hasReasoningOutput` 标志（是否收到过 `delta.reasoning_content`）而非字符串非空作为"是否思考模式"的判定依据，避免空字符串被 `||` 转为 `undefined` 后在后续请求中字段消失。

### 中止机制

每个请求关联一个中止信号，通过请求编号索引。点停止时销毁进行中的请求，流式回调安全收尾。正在等自动重试的间隔里点停止，也必须马上结束，不再发出下一次请求。

## 关键约束

- **API 协议必须保持 OpenAI 兼容**——不得引入厂商专有扩展作为必需路径，Anthropic 格式必须在 `convertToAnthropicBody` 中透明转换
- **并发安全靠 `requestId` → `AbortController` 映射保证**——严禁跨 requestId 共享 AbortController
- **流式完成回调必须幂等**——`complete()` 函数必须只 trigger 一次
- **重试逻辑封装在 `chatWithToolsStream` 内部**——调用方不得自行实现重试
- **Think 模型 reasoning_content 必须回传**——带 `tool_calls` 的消息在后续请求中缺此字段必 400
- **AiService 不得理解消息内容或工具语义**——纯传输层，判断逻辑在上层
