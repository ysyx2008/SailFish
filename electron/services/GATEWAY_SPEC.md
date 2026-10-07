# Gateway Service SPEC

> Last verified: 2026-05-07

## 职责

远程 Agent 交互 HTTP 网关。在 Electron 主进程内启动轻量 Express 服务器，提供浏览器端远程对话能力——包括 SSE 流式输出、多通道事件旁听、运行中补充输入、交互式确认等。内嵌自包含聊天 Web 页面。

## 文件 / 规模

单文件：`electron/services/gateway.service.ts`（~1722 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `setDependencies(deps: GatewayDependencies): void` | 注入 WebChatService 等依赖（禁止无注入调用） | `main.ts` |
| `setMainWindow(win): void` | 设置主窗口引用，用于桌面通知推送 | `main.ts` |
| `registerPluginRoutes(routes): void` | 注册插件自定义 HTTP 路由（整体替换语义；插件禁用/卸载后由 main.ts 用过滤后的快照重新同步，被移除插件的路由立即 404） | `main.ts`（插件加载/启停/装卸阶段） |
| `async start(config: GatewayConfig): Promise<{success, error?}>` | 启动 HTTP 服务器，全局最长可调用一次 | `main.ts` |
| `async stop(): Promise<void>` | 优雅关闭 HTTP 服务器 | `main.ts` |
| `getConfig(): GatewayConfig` | 返回当前网关配置 | `cli/index.ts` |
| `isRunning(): boolean` | 查询服务器运行状态 | `main.ts` |
| `getAuditLog(limit?: number): AuditLogEntry[]` | 获取审计日志（按时间倒序） | 调试 UI |

## 核心类型 / 接口

### GatewayConfig（配置 schema）
```ts
interface GatewayConfig {
  enabled: boolean   // 是否启用
  port: number       // 监听端口
  apiToken: string   // API 鉴权 Token（空则自动生成）
  host: string       // 监听地址（默认 0.0.0.0）
}
```

### GatewayDependencies（注入边界）
```ts
interface GatewayDependencies {
  webChatService: WebChatService   // 必需：Agent 对话通信核心
  mainWindow: { ... }              // 必需：桌面通知通道
}
```
不得绕过此接口直接 import 服务实例。

### AuditLogEntry（审计记录）
```ts
interface AuditLogEntry {
  id: string                              // UUID
  timestamp: number                       // Unix 毫秒
  type: "connection" | "task_start"
      | "tool_call" | "task_complete"
      | "webhook" | "clear"               // 事件类型
  clientIp?: string                       // 客户端 IP
  summary: string                         // 人类可读摘要
  details?: Record<string, unknown>       // 事件附加数据
}
```
最多保留 500 条，内存存储，重启即清。

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `WebChatService` | **必需** | Agent 对话核心；通过 `GatewayDependencies` 注入 |
| `WatchStore` | 可选 | 只读查询 Watch 任务状态（通过 `getWatchStore()` 获取） |
| `EventBus` | 可选 | 订阅全局 Agent 事件用于多通道旁听（通过 `getEventBus()` 获取） |

## API 端点

| 路径 | 方法 | 鉴权 | 处理函数 | 说明 |
|------|:----:|:----:|---------|------|
| `/api/health` | GET | 无 | `handleHealth` | 健康检查（公开） |
| `/chat` | GET | 无 | `serveChatPage` | 内嵌聊天页面（公开） |
| `/api/auth/validate` | GET | 无 | `handleAuthValidate` | Token 有效性验证 |
| `/api/chat` | POST | Bearer | `handleChatMessage` | 发送消息 / 补充输入 |
| `/api/chat/history` | GET | Bearer | `handleChatHistory` | 获取对话历史 |
| `/api/chat/abort` | POST | Bearer | `handleChatAbort` | 中止当前 Agent 任务 |
| `/api/chat/confirm` | POST | Bearer | `handleChatConfirm` | 交互式确认回复 |
| `/api/chat/status` | GET | Bearer | `handleChatStatus` | 查询 Agent 运行状态 |
| `/api/chat/clear` | POST | Bearer | `handleChatClear` | 清空对话上下文 |
| `/api/chat/events` | GET | Bearer | `handleChatEvents` | SSE 事件流（多通道旁听） |
| `POST /hooks/:token` | POST | Token-in-URL | `handleWebhook` | 外部 Webhook 触发 Watch |
| 插件路由 | 自定义 | Bearer | 插件注册 handler | 由 `registerPluginRoutes` 注入；路径强制约束在 `/api/plugins/{pluginId}/` 命名空间内（loader 归一化 + Gateway 入口二次校验归属与合法性），无法覆盖核心 API；method+path 冲突时保留先注册者 |

## 关键行为 / 数据流

**典型对话请求（POST /api/chat）**：

1. 客户端 POST → `authenticate()` 校验 Bearer Token
2. `handleChatMessage()` 读取请求体，写入审计日志（`addAuditLog`）
3. 调用 `webChatService.isRunning()` 判断 Agent 状态
4. **空闲 → 主模式**：设置 SSE 响应头 → 通过 `EventBus` 订阅 Agent 事件 → 调用 `webChatService.sendMessage()` → 逐帧 SSE 推送至客户端
5. **运行中 → 补充模式**：调用 `webChatService.sendSupplement()` → 返回 JSON `{ status: "supplement_sent" }`，后续事件通过 `/api/chat/events` SSE 流推送
6. 客户端断开 → `AbortController` 自动清理

**交互式确认流程**：

1. Agent 触发 `ask_user` → SSE 推送 `need_confirm` 事件（含 toolCallId、message、options）
2. 用户选择 → `POST /api/chat/confirm`（含 toolCallId, accept, feedback）
3. Gateway 调用 `webChatService.resolveConfirm()` → 返回 JSON 确认结果

**全局事件旁听（GET /api/chat/events）**：

1. 客户端建立 SSE 长连接
2. 订阅 `EventBus` 所有 `agent:event`
3. 跨通道 Agent 事件（IM 等）实时推送到 Web 端
4. 支持 watch/monitor 等多仪表盘租户并存

## 关键约束

- **Gateway 层不得耦合具体 Agent / Watch 业务逻辑**，仅做 HTTP/SSE 传输和鉴权
- **新增端点必须使用同一 `authenticate()` 鉴权中间件**，严禁绕开
- **嵌入式 HTML 必须保持自包含**——无外部 JS/CSS 依赖，配置仅通过 `VITE_*` 环境变量注入
- **API Token 生成不可外部控制**——若配置未指定 Token，系统自动生成且不可从外部读取
- **审计日志仅内存存储**，不得写入磁盘（隐私红线）
- **SSE 连接用 AbortController 管理**，严禁手动 track 连接导致泄漏
- **Webhook 端点限流每 token 每分钟 30 次**（`GatewayService.WEBHOOK_RATE_LIMIT`），超限返回 429，不得移除或绕开此限流
