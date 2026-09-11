# Plugin 子系统 SPEC

> Last verified: 2026-04-03

## 职责

为 SailFish 提供插件扩展机制。插件可注册自定义工具、AI Provider、IM 渠道、Hook 拦截和 HTTP 路由，无需修改宿主源码。Manifest 格式兼容 OpenClaw `openclaw.plugin.json` 规范。

## 公开契约（Breaking Change 需要走 deprecation 流程）

以下接口一旦有插件依赖就不可随意更改：

### Manifest 格式

文件名固定为 `openclaw.plugin.json`，必须包含：

| 字段 | 类型 | 约束 |
|------|------|------|
| `id` | string | 必填，插件唯一标识 |
| `configSchema` | object | 必填，JSON Schema（无配置传 `{}`） |

可选字段：`name`, `description`, `version`, `enabledByDefault`, `channels`, `providers`, `contracts`, `skills`

### 插件入口签名

```typescript
interface PluginEntry {
  id: string
  register(api: PluginRegistrationAPI): void
  onUnload?(): void | Promise<void>
}
```

入口通过 `module.exports.default` 或 `module.exports` 暴露，必须有 `id`（string）和 `register`（function）。

### Registration API

`register(api)` 的 `api` 参数提供以下方法，签名即契约：

```typescript
api.registerTool(def: ToolRegistration, opts?: { optional?: boolean }): void
api.registerProvider(def: ProviderRegistration): void
api.registerChannel(def: ChannelRegistration): void
api.registerTtsProvider(def: TtsProviderRegistration): void
api.registerHook(event: HookEvent, handler: HookHandler): void
api.registerHttpRoute(method: string, path: string, handler: RouteHandler): void
```

`registerHttpRoute` 的路径会被强制约束在 `/api/plugins/{pluginId}/` 命名空间内（相对路径自动加前缀）；核心 API 保留路径（`/api/chat`、`/api/auth`、`/api/health`、`/hooks`、`/chat` 及子路径）和其他插件的命名空间一律拒绝注册。同一 method + path 只允许一个 owner，冲突时保留先注册者并记录错误。

### 生命周期与撤销契约

插件注册物装配到外部服务（AiService provider、Gateway route、TTS provider、IM channel）后，生命周期操作必须立即反映到这些服务，不要求重启：

| 操作 | 工具/Hook | provider/route/TTS/IM channel | `onUnload()` |
|------|-----------|-------------------------------|--------------|
| enable | 生效 | 装配 | 不调用 |
| disable | 移除 | 当前会话内立即撤销 | 不调用 |
| uninstall | 移除 | 先撤销，再执行 npm uninstall | 调用（同一加载实例最多一次） |
| 应用退出 | — | IM adapter 停止 | 所有已加载插件（含禁用）各调用一次 |

关键约束：

- 禁用/卸载的撤销是会话内**立即尽力执行**：providers/routes/tts/im 各段独立容错（一段失败不影响其他段）。失败段列表的准确含义：段级异常 + IM 段内**装配失败**（createAdapter / registerAdapter / start 抛错或超时）；platform 冲突拒绝不计入（既定争用状态，自动重试）；撤销侧 stop 类清理失败仅记录日志不计入。失败段带操作上下文（操作类型 + 插件 id）合并记录错误日志；禁用靠持久化 enabled=false、卸载靠包删除，重启后均不再激活；
- uninstall 在运行时撤销存在失败段时仍会继续删除安装包（撤销失败不回滚、不阻塞；残留为内存对象，保留文件也无法补救清理），破坏性操作前在日志中显式警告；「重启后不再加载」的保证以 npm 删除成功为前提；
- **uninstall IPC 以 pluginId 为参数**（渲染层插件列表的 manifest id）；npm 包名由主进程从插件根目录 package.json 解析（manifest id 与包名没有相等契约，scoped/改名包由此正确处理），且包名必须**回环解析回同一插件目录**（防止被篡改/不规范的 name 把 npm uninstall 指向其他包，校验失败早退：不动运行时、不动文件）；registry 未命中时兼容按包名调用。手动放置（非 `plugins/node_modules` 下）的插件返回结构化失败——文件删除只能手动，见 `docs/plugin-dev-guide.md`；
- 禁用最后一个插件时，外部服务的空快照同样要同步（否则旧快照残留）；
- 插件 TTS provider 与内置 provider 共池：插件不得占用内置 id（装配时跳过并告警），撤销只按 owner 删除插件自己的注册；
- IM adapter 同一 platform 只允许一个注册，后来者拒绝并记录（避免遮蔽前者、令其失去管理引用而无法停止）；被拒的 channel 在后续同步事件（enable/disable/install/uninstall）中自动重试，platform 释放后自动接管。装配语义为 `createAdapter → registerAdapter → start()`（注册是事务式的：回调绑定全部成功后才生效，绑定抛错不留下占用 platform 的未跟踪实例；3s 预算；start 失败/超时回滚注册并不入跟踪，下次同步重试；**超时后晚到完成的 start 由监护逻辑立即 stop 该实例**，不产生任何地方都不再持有引用的活动连接），撤销语义为移除注册、立即切断入站回调并调用 `stop()`——契约遵从的插件获得完整 start/stop 生命周期。插件实现的 `stop()` 必须幂等可重入，且容忍在 `start()` 未完成或已失败时被调用：超时回滚与晚到完成监护可能先后调用两次（第一次作用于未完成的 start，多为 no-op；第二次拆除晚建立的资源）；
- 插件清理动作（`onUnload`、adapter `start()`/`stop()`）有 3 秒预算：挂起时放行后续流程，`onUnload` 超时随 `PluginUnloadResult.error` 返回失败但插件仍被移除；
- `onUnload()` 抛错被记录，并随 registry 层的运行时卸载结果（`PluginUnloadResult.error`）返回；npm 卸载的返回结果不受影响（当前 uninstall IPC 对 onUnload 失败只记录日志）。错误不回滚卸载、不影响其他插件；
- `onUnload()` 的「最多一次」以**加载实例**为单位：不重启重新安装/重新加载会产生新的加载实例，其 `onUnload()` 会被再次调用（插件实现应按"每个生命周期清理一次"的语义编写清理逻辑）；
- uninstall 的 npm 文件删除不能代替运行时卸载，顺序是「撤销注册物 → onUnload → npm uninstall」。

### ToolRegistration 签名

```typescript
{
  name: string
  description: string
  parameters: object                    // JSON Schema
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolExecuteResult>
}
```

### ToolExecuteResult 格式

```typescript
{
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string }
  >
}
```

### HookEvent 枚举

`'before_tool_call' | 'after_tool_call' | 'before_ai_request' | 'message_sending'`

### HookDecision 返回

```typescript
{ block?: boolean; requireApproval?: boolean; cancel?: boolean }
```

### 工具命名规则

插件工具映射到 Agent 时命名为 `plugin_{sanitizedPluginId}_{sanitizedToolName}`，前缀 `plugin_` 固定。

### 插件发现路径

按优先级递减：配置路径 → `{userData}/plugins/` → `{userData}/plugins/node_modules/` → `~/.openclaw/extensions/`

## 内部实现（可自由重构）

以下为内部实现细节，不构成公开契约：

- `PluginRegistry` 类的内部字段和私有方法
- `PluginLoader` 的扫描策略和 import 实现
- `HookBus` 的 handler 存储结构
- `sdk-shim.js` / `sdk-shim-register.js` 的实现方式
- `installer.ts` 的 npm 命令拼接细节
- 与 `AgentService`、`GatewayService`、`AiService`、`IMService` 的内部对接方式

## 依赖

- 被 `AgentService`（工具注入）、`agent.ts`（Hook 触发）、`GatewayService`（HTTP 路由）、`AiService`（Provider）、`IMService`（Channel）、`TtsService`（TTS Provider）消费
- 依赖 `ConfigService` 获取 allow/deny/entries 配置
- 依赖 `electron-log` 日志

## 类型定义

所有公开类型定义在 `types.ts` 中，导出供插件作者使用。参见 `docs/plugin-dev-guide.md`。

## 测试

`__tests__/plugin-contract.test.ts` — 契约测试，验证公开 API 稳定性。修改插件系统代码后此测试必须通过。

## 覆盖面与演进路线

### 与 OpenClaw 的对比（2026-04-05 评估）

| 能力 | OpenClaw | SailFish | 备注 |
|------|:--------:|:--------:|------|
| `registerTool` | ✅ | ✅ | Agent 工具，最高频需求 |
| `registerProvider` | ✅ | ✅ | LLM 文字推理 |
| `registerChannel` | ✅ | ✅ | IM 消息渠道 |
| `registerHook` | ✅ | ✅ | 生命周期拦截 |
| `registerHttpRoute` | ❌ | ✅ | SailFish 独有，Webhook 集成 |
| `registerTtsProvider` | — | ✅ | TTS 语音合成 provider |
| `registerCli` | ✅ | ❌ | CLI 命令扩展 |
| `registerSpeechProvider` | ✅ | ❌ | 语音识别（STT）provider |
| `registerRealtimeTranscriptionProvider` | ✅ | ❌ | 实时转写 |
| `registerRealtimeVoiceProvider` | ✅ | ❌ | 实时语音对话 |
| `registerMediaUnderstandingProvider` | ✅ | ❌ | 图片/视频理解 |
| `registerImageGenerationProvider` | ✅ | ❌ | 图片生成 |
| `registerVideoGenerationProvider` | ✅ | ❌ | 视频生成 |
| `registerWebFetchProvider` | ✅ | ❌ | 网页抓取 |
| `registerWebSearchProvider` | ✅ | ❌ | 网页搜索 |
| `registerCliBackend` | ✅ | ❌ | CLI 推理后端 |

Hook 事件差异：OpenClaw 有 `before_agent_start`、`before_model_resolve`、`before_prompt_build`、`after_tools_resolved` 等；SailFish 有 `before_tool_call`、`after_tool_call`、`before_ai_request`、`message_sending`。

### 现状结论

当前覆盖了 OpenClaw 14 个注册 API 中的 4 个核心 API，另有 2 个 SailFish 独有 API（`registerHttpRoute` + `registerTtsProvider`）。

**已够用的场景**：自定义 Agent 工具、自定义 AI Provider、自定义 IM 渠道、Hook 拦截（审计/权限）、HTTP 路由（Webhook）、TTS 语音合成。

**缺失的部分不是"加个 register 方法"能解决的** — 图片生成、网页搜索等模块在 SailFish 内部尚未做成可替换的 Provider 架构，暴露插件接口无意义。应随 SailFish 自身功能演进，在内部模块重构为 Provider 模式后再逐步补充对应的 `registerXxxProvider`。
