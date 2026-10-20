# Web Search Service — 联网搜索服务

> Last verified: 2026-10-20

## 设计目标

联网搜索要能换成国内可单独采购的接口，不能只绑在博查上。智谱、Kimi 和 DeepSeek 提供的是与对话模型分开的搜索接口：填各自的密钥就能用，检索结果是结构化的标题、链接和摘要，方便核对来源。档位不填时走较便宜的一档（智谱基础版、Kimi Basic）；想要更高召回，或只要和问题最相关的正文片段时，在设置里改档位即可。智谱、Kimi、DeepSeek 的搜索密钥和对话模型是同一把：模型里已经填过的，搜索不用再填；搜索里另填一把时，以搜索这把为准。沿用模型密钥时，设置页的密钥框不能空着让人分不清到底有没有：框里直接显示正在用的那一把，显示方式和用户自己填的一模一样（遮住时露开头 3 位和末尾 4 位、中间圆点补满原长度，点眼睛看全文），不能让「填了」和「没填但沿用」看上去是两种样子；框本身仍是空的，只有用户另填的才算搜索自己的密钥，所以模型那边换了密钥，搜索跟着换。密钥框和模型设置页一样带显示/隐藏按钮，沿用的那一把也能点开看全文。

DeepSeek 接入的主要理由是价格：按成功次数计费、失败和没结果不收费，比博查便宜得多。它只有一档，没有档位可选。给 AI 看的是接口专门为模型准备的长摘要，不拉网页全文——全文会随对话记录一起存盘，体积涨得快；AI 需要读全文时，走网页读取。搜索词超过接口上限时截断后再搜，不因为太长而直接失败。DeepSeek 的失败原因（余额不足、请求太频繁等）原样带回，让用户和 AI 都看得见。默认的搜索引擎不因此改变，仍是博查。

不接「写在模型里面、由模型自己决定搜不搜」的内置联网，那种检索过程看不见，也换不了模型。每次搜索都在运行日志里留下当时用的哪一家、搜的原话、返回的标题和链接；失败时留下原话和原因。整页正文不整段写入日志。

## 职责

为 AI Agent 的 `web_search` 工具提供统一的联网搜索入口：管理 provider 注册、设置读取、API Key 路由，并把原始搜索结果同时送给 AI（文本摘要）和 UI（结构化列表）。

## 架构

```
Main Process
─────────────
main.ts (startup)
  └── initWebSearch(webSearchSettings)
         └── 注册内置 providers (Bocha / Tavily / Jina)

electron/services/web-search/
  ├── index.ts                provider 注册表 + search() 路由
  ├── types.ts                WebSearchProvider / WebSearchOptions / WebSearchResult
  └── providers/
      ├── bocha.ts            博查（国内 AI 搜索，默认）
      ├── zhipu.ts            智谱（独立搜索，默认可选基础版）
      ├── kimi.ts             Kimi（独立搜索，Basic / Pro）
      ├── tavily.ts           Tavily（AI Agent 体验最好）
      ├── jina.ts             Jina（支持 URL 阅读，返回 Markdown）
      └── google.ts           Google Custom Search（需 API Key + cx，国内需代理）

Agent Tool
─────────────
electron/services/agent/tools/web-search.ts
  └── executeWebSearch(args)
         ├── search(query, { maxResults })   ← 调用本模块
         ├── addStep({ type: 'tool_result',  ← 附 webSearchResults 给 UI
         │            content: 'Found N results',
         │            webSearchResults: [...] })
         └── return { output: 多行文本 }     → 给 AI 阅读
```

## 公开 API

### 模块级函数（`electron/services/web-search/index.ts`）

| 函数 | 说明 |
|------|------|
| `initWebSearch(settings)` | 启动时调用：迁移旧配置、注册 3 个内置 provider |
| `registerProvider(provider)` | 注册（或替换）一个 provider，插件通过此接口扩展 |
| `removeProvider(id)` | 移除 provider 并 `dispose()` |
| `updateSettings(settings)` | 配置变更（用户在设置页修改时触发） |
| `getSettings()` | 获取当前配置副本 |
| `getProvider(id?)` | 获取 provider，未指定时用当前激活 providerId |
| `getApiKey(providerId?)` | 获取指定 provider 的 API Key |
| `getApiExtra(providerId, key)` | 获取 provider 的额外配置字段（如 Google 的 `cx`） |
| `isConfigured()` | 是否可用（已启用 + 当前 provider 已注册 + 必要 Key 与 extraFields 都已填） |
| `search(query, opts?)` | 执行搜索 → `WebSearchResult[]`，provider 未注册会抛错 |
| `dispose()` | 清空所有 provider |

### `WebSearchProvider` 契约（`types.ts`）

```ts
interface WebSearchProvider {
  id: string
  name: string
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>
  dispose?(): void
}
```

`WebSearchOptions`：`maxResults?`（默认 5）、`language?`、`signal?`。

`WebSearchResult`：`title` / `url` / `snippet` / `content?`（正文，仅部分 provider 支持）。

## Provider 插拔

- 内置 provider 在 `initWebSearch` 里通过动态 import + `registerProvider` 注册，构造函数接受懒加载的 Key getter（`() => string`），避免 Key 变更后需重建实例。
- 需要额外配置的 provider（如 Google 需要 `cx`）通过元数据 `extraFields` 声明，构造函数额外接收对应的 `() => string` extras getter，前端 `Settings` 自动按 `extraFields` 渲染输入框。
- 插件可在主进程启动后调用 `registerProvider({ id, name, search })` 注入自定义 provider，id 冲突时会先 dispose 旧的再替换。
- 已下线的 provider id（如 `duckduckgo`/`bing`）在 `initWebSearch` 里自动回退到默认，避免旧配置导致启动失败。

## 配置

存储在 `config.service.ts` 的 `webSearchSettings` key（`@shared/types` 的 `WebSearchSettings`）：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| enabled | boolean | false | 总开关（`isConfigured()` 依赖） |
| providerId | `WebSearchProviderId` | `'bocha'` | 当前激活 provider |
| apiKeys | `Partial<Record<id, string>>` | `{}` | 每个 provider 独立的 Key |
| apiExtras | `Partial<Record<id, Record<string, string>>>` | `{}` | provider 额外配置（如 `google.cx`），由 `extraFields` 元数据驱动 |
| apiKey | string? | - | @deprecated，初始化时自动迁移到 apiKeys |

IPC：渲染端通过通用的 `config:get` / `config:set` 读写，无专用 IPC 通道。

## 依赖

- `@shared/types` — `WebSearchSettings` / `WebSearchProviderId` / `WEB_SEARCH_PROVIDERS` 元数据
- `config.service.ts` — 读写 `webSearchSettings`
- `electron/main.ts` — 启动时调用 `initWebSearch`
- 各 provider 自身的第三方 HTTP API（Bocha / Tavily / Jina）

## 与 Agent 集成

`agent/tools/web-search.ts` 是本模块唯一的 agent 消费者。契约：

- `search()` 返回的 `WebSearchResult[]` 会以两种形态进入对话：
  1. 文本 `output`（编号列表 + URL + snippet + content 截断到 500 字）→ 给 AI 阅读。
  2. `executor.addStep({ type: 'tool_result', webSearchResults: [...] })` → 给前端 `AiPanel.vue` 渲染可展开的标题+域名链接列表。
- 字段映射到 `AgentStep.webSearchResults`（见 `shared/types/agent.ts` 的 `WebSearchResultItem`），由 `agent.ts` 的 4 处 step↔record 序列化带入历史记录并恢复。

## 约束

- `search()` 不在本模块做缓存或去重，完全透传给 provider。
- provider 的 `search()` 必须返回可 JSON 序列化的对象（会进入 agent 消息历史和 `AgentStepRecord` 持久化）。
- 若当前 provider 未注册或 Key 缺失，`search()` 会抛错，由调用方（`executeWebSearch`）捕获并回写 `tool_result`，不会导致进程崩溃。
- 设置中禁用（`enabled = false`）只影响 `isConfigured()` 判断，不会阻止已经拿到模块引用的调用方执行 `search()`——启用状态应在工具调度侧判断。
