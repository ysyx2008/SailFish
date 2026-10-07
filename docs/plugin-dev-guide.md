# 插件开发指南

SailFish 支持通过插件扩展 Agent 能力，无需修改源码。插件可以注册自定义工具、AI Provider、IM 渠道、Hook 拦截和 HTTP 路由。

## 快速开始

### 1. 创建插件目录

```bash
mkdir ~/Library/Application\ Support/SailFish/plugins/my-plugin
cd ~/Library/Application\ Support/SailFish/plugins/my-plugin
```

### 2. 创建 manifest

**openclaw.plugin.json**

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "一个示例插件",
  "version": "1.0.0",
  "configSchema": {},
  "enabledByDefault": true
}
```

### 3. 创建入口文件

**index.js**

```javascript
module.exports = {
  default: {
    id: "my-plugin",
    register(api) {
      api.registerTool({
        name: "greet",
        description: "向指定的人打招呼",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "要问候的人名" }
          },
          required: ["name"]
        },
        async execute(toolCallId, params) {
          return {
            content: [{ type: "text", text: `你好，${params.name}！` }]
          }
        }
      })
    }
  }
}
```

### 4. 重启 SailFish

插件会在启动时自动加载。对话中 Agent 即可调用 `greet` 工具。

## Manifest 规范

`openclaw.plugin.json` 是插件的入口声明文件：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 插件唯一标识（建议 kebab-case） |
| `name` | string | | 展示名称 |
| `description` | string | | 简短描述 |
| `version` | string | | 语义化版本号 |
| `configSchema` | object | ✅ | 配置的 JSON Schema（无配置传 `{}`） |
| `enabledByDefault` | true | | 安装后默认启用 |

## Registration API

插件入口的 `register(api)` 函数接收一个 API 对象，提供以下注册方法：

### api.registerTool(def, opts?)

注册一个工具，Agent 可以在对话中调用。

```javascript
api.registerTool({
  name: "fetch_price",
  description: "查询商品实时价格",
  parameters: {
    type: "object",
    properties: {
      product: { type: "string", description: "商品名称" },
      currency: { type: "string", enum: ["CNY", "USD"], description: "货币" }
    },
    required: ["product"]
  },
  async execute(toolCallId, params) {
    const price = await fetchPriceFromAPI(params.product, params.currency || "CNY")
    return {
      content: [{ type: "text", text: `${params.product} 当前价格：${price}` }]
    }
  }
}, { optional: false })
```

**工具命名规则**：工具会被自动映射为 `plugin_{pluginId}_{toolName}`，Agent 看到的是这个完整名称。

**返回格式**：

```javascript
{
  content: [
    { type: "text", text: "文本结果" },
    { type: "image", data: "base64..." }  // 可选，返回图片
  ]
}
```

### api.registerHook(event, handler)

注册生命周期 Hook，拦截或监听 Agent 行为。

**可用事件**：

| 事件 | 触发时机 | 典型用途 |
|------|----------|----------|
| `before_tool_call` | 工具执行前 | 审计日志、权限控制、参数校验 |
| `after_tool_call` | 工具执行后 | 结果审计、统计 |
| `before_ai_request` | AI 请求发送前 | 消息脱敏、prompt 注入 |
| `message_sending` | IM 消息发送前 | 内容过滤、格式转换 |

```javascript
api.registerHook("before_tool_call", (context) => {
  console.log(`工具调用: ${context.toolName}`, context.toolArgs)

  // 拦截危险操作
  if (context.toolName.includes("delete")) {
    return { block: true }  // 阻止执行
  }

  // 要求用户确认
  if (context.toolName.includes("write")) {
    return { requireApproval: true }
  }

  return {}  // 放行
})
```

### api.registerProvider(def)

注册自定义 AI 模型 Provider。

```javascript
api.registerProvider({
  id: "my-llm",
  name: "内部 LLM",
  match(profile) {
    return profile.apiUrl.includes("internal-llm.company.com")
  },
  async chatWithTools({ messages, tools, model, apiUrl, apiKey }) {
    const response = await fetch(`${apiUrl}/chat`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages, tools, model })
    })
    return await response.json()
  }
})
```

### api.registerChannel(def)

注册自定义 IM 渠道。

```javascript
api.registerChannel({
  id: "my-chat",
  name: "内部聊天系统",
  createAdapter(config) {
    return new MyInternalChatAdapter(config)
  }
})
```

Adapter 需实现 `IMAdapter` 接口（参考 `electron/services/im/types.ts`）。

### api.registerHttpRoute(method, path, handler)

在 Gateway 上注册自定义 HTTP 端点（需鉴权后才可访问）。

插件路由被强制约束在 `/api/plugins/{pluginId}/` 命名空间内：传入的相对路径会自动加上该前缀。例如下面注册的实际端点是 `GET /api/plugins/my-plugin/status`：

```javascript
api.registerHttpRoute("GET", "/status", (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ status: "ok", version: "1.0.0" }))
})
```

注意：

- 不得注册核心 API 保留路径（`/api/chat`、`/api/auth`、`/api/health`、`/hooks`、`/chat` 及其子路径），此类注册会被拒绝并记录错误日志。
- 不得占用其他插件的命名空间（`/api/plugins/{其他插件id}/...`），同样会被拒绝。
- 同一 method + path 只能有一个插件持有，冲突时保留先注册者，后注册者会被拒绝并记录错误日志。

## 使用 TypeScript

插件可以用 TypeScript 编写（SailFish 运行时已注册 tsx）：

**index.ts**

```typescript
import type { PluginRegistrationAPI, ToolRegistration } from "../../electron/services/plugin/types"

export default {
  id: "my-ts-plugin",
  register(api: PluginRegistrationAPI) {
    api.registerTool({
      name: "calculate",
      description: "执行数学计算",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "数学表达式" }
        },
        required: ["expression"]
      },
      async execute(_toolCallId, params) {
        const result = new Function(`return (${params.expression})`)()
        return { content: [{ type: "text", text: String(result) }] }
      }
    })
  }
}
```

## 通过 npm 安装

插件可以发布到 npm，用户在设置页点击「安装」输入包名即可。

发布时确保包里包含 `openclaw.plugin.json` 和入口文件。`package.json` 示例：

```json
{
  "name": "sailfish-plugin-example",
  "version": "1.0.0",
  "main": "index.js",
  "files": ["index.js", "openclaw.plugin.json"]
}
```

## 插件发现路径

SailFish 按以下顺序扫描插件（先找到的优先）：

1. 配置中指定的路径（`pluginsLoadPaths`）
2. `{userData}/plugins/`（直接放置的插件）
3. `{userData}/plugins/node_modules/`（npm 安装的插件）
4. `~/.openclaw/extensions/`（兼容 OpenClaw 全局扩展目录）

## 生命周期

- **加载**：应用启动时扫描目录 → 解析 manifest → import 入口 → 调用 `register(api)`
- **启用**：工具/Hook 立即生效，provider/TTS/IM channel/HTTP 路由同时装配到对应服务；IM channel 的装配包含 `start()`（建立连接，3 秒预算）。插件实现的 `stop()` 必须幂等、容忍在 `start()` 未完成或已失败时被调用（超时回滚与晚到完成监护可能先后调用两次）
- **禁用**：当前会话内立即撤销全部注册物——工具与 Hook 失效，provider 从 AI 服务移除，HTTP 路由不再可达（返回 404），TTS provider 被移除，IM adapter 停止（移除注册、切断消息回调、`stop()`）；不需要重启应用。**禁用不会调用 `onUnload()`**（插件只是停用，代码仍在内存中）
- **卸载**：npm 安装的插件可通过设置页卸载（先撤销注册物、调用 `onUnload()`，再执行 npm uninstall）；**手动放置的插件不能通过设置页卸载**，会返回失败提示——请直接删除插件目录后重启
- **清理**：插件可导出 `onUnload()` 方法，在**卸载或应用退出**时被调用，同一加载实例最多调用一次（不重启重新安装/重新加载视为新的加载实例，`onUnload()` 会再次调用）；`onUnload()` 抛错或超过 3 秒预算会被记录并随卸载结果返回失败，但不会阻止卸载流程或影响其他插件

## 调试

- 插件加载日志：`{userData}/logs/` 下搜索 `PluginLoader` / `PluginRegistry`
- 工具执行日志：搜索 `plugin_` 前缀的工具名
- 开发时修改插件后需重启应用

## 示例插件

完整示例见 `docs/examples/plugin-hello/` 目录。
