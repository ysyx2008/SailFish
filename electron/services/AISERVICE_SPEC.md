# AiService SPEC

> Last verified: 2026-03-09

## 职责

AI API 的统一调用层。封装 OpenAI 兼容协议的 HTTP 请求，提供同步/流式、纯对话/工具调用四种模式。处理代理、超时、重试、中止、多模态降级等底层复杂性，上层服务只需传入消息和工具定义。

## 文件

单文件：`electron/services/ai.service.ts`（~1570 行）

## 公开 API

| 方法 | 用途 | 调用方 |
|---|---|---|
| `chat(messages, profileId?)` | 纯文本对话（同步） | 知识文档更新、对话索引等后台任务 |
| `chatStream(messages, onChunk, onDone, onError, profileId?)` | 纯文本对话（流式） | 前端 AI 对话面板 |
| `chatWithTools(messages, tools, profileId?)` | 工具调用（同步） | Agent 非流式路径（较少使用） |
| `chatWithToolsStream(messages, tools, onChunk, onToolCall, onDone, onError, profileId?, onToolCallProgress?, requestId?)` | 工具调用（流式） | Agent 主执行路径 |
| `abort(requestId?)` | 中止请求 | Agent.abort()、用户取消 |
| `static getExplainCommandPrompt(command)` | 命令解释 prompt 模板 | 前端命令解释功能 |
| `static getDiagnoseErrorPrompt(error, context?)` | 错误诊断 prompt 模板 | 前端错误诊断功能 |
| `static getNaturalToCommandPrompt(description, os?)` | 自然语言→命令 prompt 模板 | 前端命令生成功能 |

## 核心类型

见文件头部导出，共享给 Agent 等模块：

- `AiMessage` — 消息格式（role + content + 可选 images/tool_calls/reasoning_content）
- `ToolDefinition` — Function Calling 工具定义
- `ToolCall` — AI 返回的工具调用
- `ChatWithToolsResult` — 工具调用结果（content + tool_calls + finish_reason）
- `AiProfile` — AI 配置档案（apiUrl, apiKey, model, proxy, contextLength...）

## 依赖

- **ConfigService**：获取 AI 配置档案（profiles）、代理设置
- **AiDebugService**：调试日志（请求/响应追踪）

## 关键行为

### 多 Profile 支持

通过 `profileId` 选择使用哪个 AI 配置。未指定时使用 `configService.getActiveAiProfile()` 返回的默认档案。

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
| 网络错误（ECONNRESET 等） | 3 次 | 固定 2s |
| Rate Limit (429) | 3 次 | 指数退避，基础 5s |
| 服务端错误 (5xx) | 2 次 | 指数退避，基础 3s |

### 多模态降级

请求含图片时，如果 API 返回不支持 image_url 的错误，自动剥离图片重试（`stripImages = true`）。

### Think 模型支持

支持 DeepSeek-R1 等模型的 `reasoning_content` 字段，流式输出时包裹在折叠 HTML 块中。

### 中止机制

每个请求关联一个 `AbortController`，通过 `requestId` 索引。`abort()` 调用时销毁 HTTP 请求，流式回调安全收尾（返回已收到的部分结果）。

## 关键约束

1. **OpenAI 兼容协议**：所有 API 调用遵循 OpenAI Chat Completions 格式，支持 Anthropic 格式转换
2. **并发安全**：通过 `Map<string, AbortController>` 支持多个终端同时请求
3. **完成回调幂等**：流式请求的 `complete()` 函数保证回调只触发一次
4. **错误消息国际化**：网络错误码翻译为用户可读语言（通过 `translateNetworkError`）
5. **不含业务逻辑**：纯传输层，不理解消息内容或工具语义
