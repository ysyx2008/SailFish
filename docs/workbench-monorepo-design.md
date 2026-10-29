# 工作台 Monorepo 化方案设计（v2，基于核实结论）

> 状态：方案设计阶段，未开始实施（v2 是 2026-07-03 重新核实后的精简版，废弃 v1 的 `@sailfish/core` 包与双入口设计）
> 范围：`src/workbench/`、`src/components/workbench/`、新增 `packages/`
> 关联：`electron/services/agent/SPEC.md`、`src/workbench/SPEC.md`、`docs/architecture.md`
> 起因：业务条线研发团队需自行研发并发布专用工作台；支撑开源主线可被快速 OEM（产品背景另文）
> 修订：2026-07-13 拆出 OEM 产品说明；同日对齐「Fork 优先 / features 统一可用性 / 双来源装配 / skills 包内自治」

---

## 产品背景（指针）

**为什么做、开源 vs OEM、一岗一台、品牌、能力开关、SSO**：见 [`oem-vision.md`](./oem-vision.md)。

本文只回答：**开源主线里工作台如何抽成可交付的包 / SDK，以便 OEM Fork 少改核心、快速加岗。**

与 OEM 总目标的衔接（工程必须遵守）：

1. **Fork 优先**：包边界清晰是为了 Fork 里加 `workbench-*` / 改配置；独立 npm 发版是可选加速，不是唯一主线  
2. **能力开关 × 工作台可用性**：`oem.config.features` + Steam + descriptor 经**统一判定**（如 `isWorkbenchAvailable(kind)`），禁止两套裁剪逻辑分叉  
3. **装配双来源**：descriptor 可来自「本地包 register」或「将来服务端下发」，走**同一 bootstrap**  
4. **skills 包内自治（已拍板）**：业务/OEM 工作台优先自带 skill 模块（入口 side-effect `registerSkill`）；`skills: string[]` 声明依赖并供校验；仅引用核心仓已有 skill id 为补充，不是唯一模式  

---

## 〇、设计原则（必读）

本方案基于"从消费者倒推，不从现状搬运"。每一条"该放哪"的决策都先回答一个问题：**业务工作台真的需要这个吗？**

- **消费者是谁**：业务条线研发团队（金融、运维、人事等），通过 AI 辅助编码（TS + Vue3 + Pinia）开发专用工作台
- **业务工作台需要什么**：① 自己的前端 UI；② 声明依赖哪些 skill；③ 声明自带哪些 MCP server；④ 一段给 Agent 的 system prompt 片段；（演进）记忆/召回等岗位级开关见产品说明
- **业务工作台不需要什么**：碰 `Agent` 类内部、`Conversation` 聚合根、`useAgentMode` 实现、后端服务源码；也不自己实现登录 / SSO

判据：**业务工作台不需要的，就不进 SDK**。判据反向也成立：core 里 desktop 应用层胶水（ai-debug / menu / xshell-import / skill-market 等）留在 `apps/desktop`，不抽进任何包。身份与 OEM 控制面见产品说明，不塞进业务工作台包。

历史教训：v1 方案把"现状搬运"误当"架构设计"——把 `useAgentMode` / `useArtifact` / `ai-debug` 等应用层或工作台专属的东西塞进 SDK/core。v2 砍掉这些。

---

## 一、目标与背景

### 1.1 目标

让业务条线 / OEM 研发能：

1. **一站式交付专用工作台**：前端 UI + 专用技能 + MCP server（优先打进工作台包或随包声明）  
2. **在 Fork 或 monorepo 内扩展**，少改 Agent 核心，降低合上游冲突  
3. **依赖旗鱼核心架构**（Agent、记忆、终端、IM 等），但不污染核心代码  
4. **（可选）包版本自治**：changesets / 内部 registry 发版——有多团队同仓协作时再用；纯 OEM Fork 可只靠 workspace 包边界  

产品层目标见 [`oem-vision.md`](./oem-vision.md)。

### 1.2 现状核实结论（v2 关键依据）

重新通读 `electron/services/agent/SPEC.md`、`src/workbench/SPEC.md`、`mcp.service.ts`、`skills/registry.ts` 后，得出五条核实结论，颠覆了 v1 方案：

**结论 1：工作台三件套解耦已存在**

`src/workbench/types.ts` 的 `WorkbenchKind = TerminalType | 'companion'` 已开放扩展；`registry.ts` 的 `DESCRIPTORS` 集中登记；`resolveWorkbenchKind(tab)` 是 tab→kind 唯一映射点。新增工作台本来就是"加目录 + 注册 + 写映射"三步，**不是黑盒**。

**结论 2：业务领域能力走技能系统，不走工作台包**

agent SPEC 显示 excel / word / email / calendar / browser / feishu / chart 等业务领域能力都是通过 `skills/` 系统按需加载的，跟工作台正交。`skills/registry.ts` 的 `registerSkill(skill)` 是后端函数注册。业务工作台要带专用技能，**只需要声明依赖哪些 skill id**，desktop 启动时自动注册。

**结论 3：MCP 是配置 + 运行时连接，不是代码注册**

`mcp.service.ts` 的 `McpService.connect(config)` 接收 `McpServerConfig`（纯数据：command/url/args/env/headers），运行时建立连接。业务工作台要带 MCP，**只需要塞一份 mcp config**，desktop 启动时自动 connect。

**结论 4：工作台 prompt 走前端注入 + IPC，后端不 import 工作台包**

`useAgentMode.ts` 第 1500 行显示：`resolveWorkbenchAgentPrompt(kind, tab)` 在前端调用，结果填进 `context.workbenchPrompt`，经 IPC 传给后端 `prompt-builder.ts`。**后端根本不 import 工作台包**。v1 方案 3.3 节设计的"业务包 ./node 后端入口 + `registerWorkbenchPrompt/Tools`"是过度设计，砍掉。

**结论 5：`useAgentMode` 是 2310 行应用层巨石，AiPanel 是 6600 行巨型组件**

两者深度依赖 desktop store（`useTerminalStore` / `useAssistantArtifactStore` / `useComposerQuoteStore`）、composable（`useMarkdown` / `useDocumentUpload` / `useHostProfile` / `useSpeechRecognition`）、FLIP 滚动动画、ResizeObserver 补偿等纯 desktop UI 实现。它们**不能包装进 SDK**——业务工作台要对话区，要么复用 AiPanel（需先把它解耦成可复用组件），要么自己写。

**结论 6：共享类型当前是 Vite alias，不是真包——抽 SDK 前必须先抽 `@sailfish/shared-types`**

`shared/types/` 通过 Vite alias `@shared` 暴露，前后端用相对路径 import。SDK 要 `import type { TerminalType }` 必须有真包。此外 `McpServerConfig` 在 `mcp.service.ts` / `config.service.ts` / `preload.ts` 三处重复定义（违反项目规则"禁止重复定义类型"），抽包时一并收敛到 `@sailfish/shared-types`。这是纯类型包、零运行时、1 天工作量。

### 1.3 与现有插件系统并存

| 机制 | 服务对象 | 信任级别 | 隔离方式 |
|---|---|---|---|
| Monorepo 内部包 | 业务条线研发团队 | 可信 | 编译时类型边界 + CODEOWNERS |
| 现有插件系统 `electron/services/plugin/` | 公开第三方 / 用户自装 | 不可信 | 运行时沙箱 + register API |

业务工作台不走插件系统，插件系统继续服务真正第三方扩展。

---

## 二、目标仓库结构（精简版）

v2 砍掉了 v1 的 `@sailfish/core` 包——业务工作台不直接调后端，只声明 skill/mcp 依赖，desktop 负责装配。所以后端服务全留 `apps/desktop`，不抽包。

```
sailfish/                                # monorepo 根
├── pnpm-workspace.yaml                  # workspace 配置
├── package.json                         # 根 package，只放 dev 工具
├── .npmrc                               # strict-peer-dependencies=true
├── tsconfig.base.json                   # 共享 tsconfig
├── packages/
│   ├── shared-types/                   # 共享类型包（核心团队维护，纯类型零运行时）
│   │   ├── package.json                # @sailfish/shared-types
│   │   └── src/
│   │       ├── agent.ts                # ← shared/types/agent.ts 迁入（TerminalType 等）
│   │       ├── mcp.ts                  # ← McpServerConfig 统一定义（消除 mcp.service/config.service/preload 三处重复）
│   │       └── ...                     # ← shared/types/ 其余文件迁入
│   │
│   ├── workbench-sdk/                   # 唯一的核心包（核心团队维护）
│   │   ├── package.json                 # @sailfish/workbench-sdk
│   │   └── src/
│   │       ├── types.ts                 # ← src/workbench/types.ts 迁入并扩展
│   │       ├── registry.ts              # ← src/workbench/registry.ts 迁入并重构
│   │       ├── shell/                   # WorkbenchShell 通用渲染器（新增）
│   │       └── region-renderers/        # 内置 region 渲染器枚举（新增）
│   │           ├── ai-panel.ts          # 聊天锚点区，所有工作台通用
│   │           ├── iframe-url.ts        # 嵌入网页，通用
│   │           └── data-table.ts        # 数据表格，通用
│   │           # 注：artifact-panel 不在此处 —— 产出物面板是 assistant 专属，
│   │           # 由 packages/workbench-assistant/ 导出
│   │           # 注：terminal 渲染器也不在此处 —— local/ssh 工作台专属，
│   │           # 因 Terminal 实例 Teleport 保命池所需，留在各自工作台包
│   │
│   ├── workbench-local/                 # 内置：本地终端工作台
│   │   └── src/{descriptor,prompt,agent-tools}.ts
│   │
│   ├── workbench-ssh/                   # 内置：SSH 终端工作台
│   │   └── src/{descriptor,prompt,agent-tools}.ts
│   │
│   ├── workbench-assistant/             # 内置：独立助手工作台（含产出物面板）
│   │   └── src/
│   │       ├── {descriptor,prompt,agent-tools}.ts
│   │       ├── components/AssistantWorkbench.vue
│   │       └── artifact/                # ← src/workbench/assistant/artifact/ 迁入
│   │
│   ├── workbench-companion/             # 内置：联络工作台
│   │   └── src/{descriptor,prompt}.ts
│   │
│   └── workbench-<business>/           # 业务工作台（各业务团队维护）
│       └── src/
│           ├── descriptor.ts            # 声明 kind + skills + mcpServers + agentPrompt
│           ├── prompt.ts                 # 工作台 prompt 片段
│           └── components/               # 业务专属 Vue 组件
│
└── apps/
    └── desktop/                         # 桌面应用聚合入口（核心团队维护）
        ├── package.json                 # depends on @sailfish/workbench-sdk + 各 workbench-* 包
        ├── electron/                    # main.ts / preload.ts / cli/ 保留（壳层）
        ├── src/                         # 前端 desktop 应用层（store / AiPanel / useAgentMode 等）
        ├── vite.config.ts               # 聚合所有工作台
        └── electron-builder.yml
```

### 2.1 两层职责划分

| 层 | 维护者 | 职责 | 包名 |
|---|---|---|---|
| **shared-types** | 核心团队 | 前后端共用的纯类型定义（TerminalType / McpServerConfig 等），零运行时代码 | `@sailfish/shared-types` |
| **workbench-sdk** | 核心团队 | 工作台类型、注册表、通用 Shell、内置 region 渲染器（ai-panel / iframe-url / data-table） | `@sailfish/workbench-sdk` |
| **workbench-\*** | 核心 / 业务团队 | 单个工作台的 descriptor（含 skills/mcp/agentPrompt 声明）+ 渲染组件 | `@sailfish/workbench-{name}` |
| **apps/desktop** | 核心团队 | 全部后端服务（`electron/services/`）、前端应用层（store / AiPanel / useAgentMode / desktop 胶水）、Electron 壳、IPC、打包 | （不发 npm） |

关键约束：

1. **workbench 包只能依赖 `workbench-sdk`**，不能依赖 `apps/desktop`，不能互相依赖
2. **后端能力通过声明依赖**：工作台在 descriptor 里声明 `skills` / `mcpServers`，desktop 启动时装配到 SkillRegistry / McpService。工作台包**不直接 import 后端服务**
3. **判据**：业务工作台不需要的，就不进 SDK；desktop 应用层胶水（ai-debug / menu / screen-content / xshell-import / skill-market / workbench-bridge / artifact-preview / bond 等）留在 `apps/desktop`

### 2.2 workspace 配置

`pnpm-workspace.yaml`：

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

根 `.npmrc`：

```ini
strict-peer-dependencies=true
auto-install-peers=true
shamefully-hoist=false
```

`strict-peer-dependencies=true` 强制 `vue` / `pinia` / `vue-router` 等运行时单例由 desktop app 统一提供，业务包各自带版本会被拒绝安装。

---

## 三、SDK 接口设计（声明式 + 一站式）

`@sailfish/workbench-sdk` 是业务团队接触旗鱼能力的**唯一入口**。v2 把 v1 的多个 register 函数收敛成**一个 descriptor**——业务工作台一次性声明全部能力依赖。

### 3.1 工作台 descriptor（核心）

```typescript
// packages/workbench-sdk/src/types.ts
import type { Component } from 'vue'

/**
 * MCP 服务器配置 —— 从 @sailfish/shared-types import
 *（shared-types 包统一了 mcp.service / config.service / preload 三处重复定义）
 */
import type { McpServerConfig } from '@sailfish/shared-types'

/** 终端类型 —— 同样从 shared-types import */
import type { TerminalType } from '@sailfish/shared-types'

/**
 * 工作台类型 —— 开放字符串，业务包自由命名
 * 内置：'local' | 'ssh' | 'assistant' | 'companion'
 * 业务：'finance' | 'ops-dashboard' | ...
 */
export type WorkbenchKind = string

export interface WorkbenchDescriptor {
  /** 工作台类型，业务包用 'business:<package-name>' 命名空间避免冲突 */
  kind: WorkbenchKind

  /** 自定义渲染器（逃生口）。提供则直接渲染整个工作台 */
  renderer?: Component

  /** 声明式区域。无 renderer 时由 WorkbenchShell 按此渲染 */
  regions?: RegionSpec[]

  /** 是否在 Steam 构建中可用，默认 true */
  availableInSteam?: boolean

  // ===== 一站式打包：业务工作台带的全栈能力 =====

  /** 本工作台依赖的技能 ID 列表（desktop 启动时自动 registerSkill） */
  skills?: string[]

  /** 本工作台自带的 MCP 服务器配置（desktop 启动时自动 McpService.connect） */
  mcpServers?: McpServerConfig[]

  /** 工作台 Agent system prompt 片段（前端注入 context.workbenchPrompt，走 IPC 到后端） */
  agentPrompt?: string | ((tab: WorkbenchAgentPromptTab) => string | undefined)

  /**
   * （预留）岗位级 Agent 策略：记忆 / 召回 / 执行松紧等。
   * 实现可后置，但字段挂在 descriptor 上，避免日后散进 Agent 私有逻辑。
   */
  agentPolicy?: {
    memory?: boolean
    recall?: boolean
    executionMode?: string
    // …随产品契约演进
  }
}

export interface RegionSpec {
  id: string
  role: 'anchor' | 'toggle'
  side?: 'left' | 'right'
  defaultVisible?: boolean
  resizable?: boolean
  /** 区域使用的内置渲染器 ID（声明式工作台必填） */
  renderer?: 'ai-panel' | 'iframe-url' | 'data-table' | (string & {})
  /** 渲染器参数，如 iframe-url 的 src、data-table 的 schema */
  rendererProps?: Record<string, unknown>
}

export interface WorkbenchAgentPromptTab {
  type: string
  isRemote?: boolean
  remoteChannel?: string
}
```

关键变化（对比 v1 和现状）：

| 字段 | v1 设计 | v2 核实后 | 理由 |
|---|---|---|---|
| `kind` | 联合类型扩成 string | 同 v1 | 业务自由命名 |
| `skills` | 无 | **新增** | 声明式声明技能依赖，desktop 装配 |
| `mcpServers` | 无 | **新增** | 声明式声明 MCP 配置，desktop 装配 |
| `agentPrompt` | v1 用 `registerWorkbenchPrompt()` 函数 | **改成 descriptor 字段** | 走前端注入 + IPC（结论 4），不需要后端注册 |
| `registerWorkbenchTools` | v1 设计了 | **砍掉** | 工具走技能/MCP，不需要单独注册 |
| 业务包双入口 | v1 设计了 | **砍掉** | 后端不 import 工作台包，单前端入口 |
| `@sailfish/core` 包 | v1 设计了 | **砍掉** | 后端留 apps/desktop，工作台通过声明依赖 |

### 3.2 工作台注册函数

```typescript
// packages/workbench-sdk/src/registry.ts

/** 注册一个工作台。在业务包的入口模块顶层调用。 */
export function registerWorkbench(descriptor: WorkbenchDescriptor): void

/** 按 kind 查询工作台描述符 */
export function getWorkbenchDescriptor(kind: WorkbenchKind): WorkbenchDescriptor | undefined

/**
 * 遍历所有已注册工作台。
 * @internal 仅供 apps/desktop 启动时装配 skills/mcp 使用，业务包不应调用。
 */
export function getAllWorkbenchDescriptors(): WorkbenchDescriptor[]

/** 把 tab 映射到工作台类型 —— tab → kind 的唯一映射点 */
export function resolveWorkbenchKind(tab: {
  type: TerminalType
  agentId?: string
  workbenchKind?: string  // 新增：tab 直接带 workbenchKind 字段优先
}): WorkbenchKind

/** 解析工作台渲染器 */
export function resolveWorkbenchRenderer(kind: WorkbenchKind): Component

/**
 * 工作台是否对当前构建/OEM 可用 —— 唯一裁剪判定点。
 * 合并：oem.config.features（如 localTerminal/sshTerminal/assistantWorkbench/companion）
 *      + Steam（availableInSteam）+ 其它构建旗标。
 * UI 创建入口、registry 渲染、ensureCompanion 等一律问这里，禁止另写一套 if。
 */
export function isWorkbenchAvailable(kind: WorkbenchKind): boolean

/** 解析工作台 Agent prompt（前端调用，结果填 context.workbenchPrompt） */
export function resolveWorkbenchAgentPrompt(kind: WorkbenchKind, tab: WorkbenchAgentPromptTab): string | undefined
```

### 3.3 desktop 启动时的一站式装配

**双来源、单装配**：descriptor 无论来自「import 工作台包 → `registerWorkbench`」还是「服务端下发 JSON → `registerWorkbench`」，都进入同一注册表，再由 bootstrap 装配 MCP / 校验 skills。

```typescript
// apps/desktop/src/workbench-bootstrap.ts （新增）
import { getAllWorkbenchDescriptors } from '@sailfish/workbench-sdk'
import { mcpService } from './electron/services/mcp.service'

export function bootstrapWorkbenches() {
  const descriptors = getAllWorkbenchDescriptors()

  // 1. skills：包入口 side-effect 已 registerSkill；此处按 d.skills 做存在性校验/日志
  //    （允许只引用核心仓已有 skill id；OEM 自治包则自带模块）

  // 2. 连接所有工作台声明的 MCP server
  for (const d of descriptors) {
    for (const mcpConfig of d.mcpServers ?? []) {
      mcpService.connect(mcpConfig).catch(err => log.error(err))
    }
  }

  // 3. agentPrompt 在 useAgentMode 里调 resolveWorkbenchAgentPrompt 拿，无需装配
}
```

**关键**：业务/OEM 工作台包**主入口**做两件事——`registerWorkbench(descriptor)`，并 side-effect import 自带 skill 模块。desktop 只需 import 各包主入口（或加载服务端下发的描述后再 register），一切走同一注册表。

### 3.4 业务工作台两种形态

核实结论 5 显示 AiPanel 是 6600 行巨型组件、深度耦合 desktop store。业务工作台要对话区有两种路径：

**形态 A：声明式工作台（推荐，零代码风险）**

业务团队不写 Vue 组件，只声明 region + 用内置 `ai-panel` 渲染器：

```typescript
// packages/workbench-finance/src/descriptor.ts
export const descriptor: WorkbenchDescriptor = {
  kind: 'business:finance',
  regions: [
    { id: 'chat', role: 'anchor', renderer: 'ai-panel' },           // 内置聊天区
    { id: 'dashboard', role: 'toggle', renderer: 'iframe-url',     // 内置 iframe 区
      rendererProps: { src: 'https://finance.internal/dashboard' } }
  ],
  skills: ['finance-data'],               // 声明依赖的技能
  mcpServers: [{                          // 声明自带的 MCP
    id: 'finance-mcp', name: '金融 MCP',
    transport: 'stdio', command: 'node', args: ['mcp-server.js']
  }],
  agentPrompt: '你在金融工作台中，可以查询实时行情、持仓、做风险分析...'
}
```

`WorkbenchShell` 按 regions 渲染，`ai-panel` region 用 SDK 内置的 AiPanel 组件。业务团队完全不写代码，AI 辅助也能产出。

**形态 B：自定义渲染器（逃生口，P2 之后可用）**

业务团队写自己的 `FinanceWorkbench.vue`，自己组合 AiPanel（需先解耦，见 3.5）+ 业务组件。**P0-P2 期间 AiPanel 尚未下沉，形态 B 走不通；P2 完成后形态 B 才可用**。

```typescript
export const descriptor: WorkbenchDescriptor = {
  kind: 'business:finance',
  renderer: FinanceWorkbench,            // 自定义组件
  skills: ['finance-data'],
  mcpServers: [...],
  agentPrompt: '...'
}
```

### 3.5 AiPanel 下沉路径（开放问题）

形态 A 要用 `ai-panel` region 渲染器，前提是 AiPanel 能被 SDK 复用。但当前 AiPanel 6600 行深度依赖 desktop store、composable、`useAssistantArtifactStore`。**下沉是 P1 之后的工作**，分三步：

1. **P1**：SDK 先只内置 `iframe-url` / `data-table` 渲染器。业务工作台要对话区走形态 B（自己 import AiPanel，但 AiPanel 还在 apps/desktop 内，业务包用不了——这时候业务工作台只能用 iframe 嵌入对话区，或等 P2）
2. **P2**：把 AiPanel 从 `apps/desktop/src/components/` 抽到 `packages/workbench-sdk/src/region-renderers/ai-panel/`，解耦它对 `useAssistantArtifactStore` 的依赖（artifact 改成可选注入）
3. **P3**：`useAgentMode` 拆分——核心原语（消息收发、状态）进 SDK，应用层胶水（FLIP 动画、ResizeObserver 补偿、草稿持久化）留 desktop

P0-P1 阶段，业务工作台若要对话区，**临时方案**是 iframe 嵌入一个本地 web 对话端（gateway.service 已支持 web 会话），或等 AiPanel 下沉。

### 3.6 各阶段业务工作台可用形态速查

| 阶段 | 形态 A（声明式） | 形态 B（自定义渲染器） | 说明 |
|---|---|---|---|
| P-1 完成 | ❌ SDK 前置工作 | ❌ | 抽 shared-types 包，让 SDK 能 import TerminalType / McpServerConfig |
| P0 完成 | ❌ SDK 还没抽出 | ❌ AiPanel 还在 desktop | 仅验证内置工作台抽包链路 |
| P1 完成 | ⚠️ 仅 `iframe-url` / `data-table` 渲染器可用，无 `ai-panel` | ❌ AiPanel 还在 desktop | 业务工作台只能做"数据面板 + iframe 嵌入对话端"形态 |
| P2 完成 | ✅ `ai-panel` 渲染器可用 | ✅ AiPanel 已下沉，可组合 | 形态 A 完整可用；形态 B 可用 |
| P3 完成 | ✅ | ✅ + `useAgentSession` 原语可用 | 形态 B 写得更顺手 |

**关键结论**：P0-P1 期间业务工作台能力受限（无对话区），P2 是真正可用的起点。P1 完成可先让业务团队做"非对话型"工作台（纯数据面板/iframe 嵌入）暖身。

---

## 四、版本管理与发版流程

### 4.0 主路径：Fork OEM（与今天产品模型对齐）

多数企业（含我们自己）是 **Fork 开源主线**，在 Fork 内加 `packages/workbench-*`、维护自有 `shared/oem.config.ts`（开源主线只提交 `oem.config.template.ts`，避免合版冲突）。此时：

- **不必**先上 GitHub Packages 才能 OEM  
- monorepo / workspace 包的价值是**边界清晰、少改核心**  
- 跟上游合并时只合开源主线，业务包留在 Fork  

### 4.1 （可选）同仓多团队时的包独立发版

若多个业务团队在**同一开源/内部 monorepo** 协作，再用 changesets + 内部 registry：

```json
// packages/workbench-finance/package.json
{
  "name": "@sailfish/workbench-finance",
  "version": "0.4.2",
  "peerDependencies": {
    "@sailfish/workbench-sdk": "^1.2.0",
    "vue": "^3.4.0",
    "pinia": "^2.1.0"
  }
}
```

业务团队改完代码，跑 `pnpm changeset` → `pnpm changeset version` → `pnpm changeset publish` 发到内部 registry。

### 4.2 内部 Registry 选项

| 选项 | 优点 | 缺点 |
|---|---|---|
| **GitHub Packages**（推荐） | 复用 GitHub Actions / CODEOWNERS / Branch Protection；零额外运维 | 强绑定 GitHub；私有包 token 配置稍繁琐 |
| verdaccio 自建 | 完全自控 | 要自己运维 |
| 公司内部 Nexus / Artifactory | 公司已有基建零成本接入 | 看公司基建 |

### 4.3 发版工作流（业务团队自治）

```bash
# 在 packages/workbench-finance/ 下
pnpm changeset                    # 描述本次改动
git commit -am "changeset: finance workbench 0.4.3"
gh pr create                      # PR 只触及 packages/workbench-finance/
# 业务团队 reviewer approve（CODEOWNERS 自动指派 finance-team）
# merge 后 GitHub Action 自动跑 changeset publish 到 GitHub Packages
```

桌面 app 聚合新版：

```bash
# 在 apps/desktop/ 下
pnpm update @sailfish/workbench-finance    # 拉最新版
git commit -am "bump finance workbench to 0.4.3"
# 走桌面 app 正常发版流程
```

业务团队发版与桌面 app 发版**完全解耦**。

### 4.4 CODEOWNERS 权限隔离

`.github/CODEOWNERS`：

```
packages/workbench-sdk/                     @sailfish/core-team
packages/workbench-local/                   @sailfish/core-team
packages/workbench-ssh/                    @sailfish/core-team
packages/workbench-assistant/              @sailfish/core-team
packages/workbench-companion/              @sailfish/core-team
packages/workbench-finance/                 @sailfish/finance-team
packages/workbench-ops/                    @sailfish/ops-team
apps/desktop/                               @sailfish/core-team
```

配合 Branch Protection：业务包 PR 改自己的包，core-team 不需要 approve；改 SDK 必须核心团队 approve。

---

## 五、版本冲突解决

四种冲突，严重程度递增。

### 5.1 peerDep 范围不满足（最常见，机制兜底）

**场景**：业务包声明 `@sailfish/workbench-sdk: "^1.2.0"`，desktop 升 SDK 到 1.3.0 改了 `WorkbenchDescriptor` 接口。

**机制**：pnpm 安装时直接报错；desktop 升 SDK 前 CI 跑 `pnpm install --frozen-lockfile` 验证兼容；核心发版前先发 pre-release 让业务团队适配。

### 5.2 运行时单例冲突（隐蔽会炸）

**场景**：业务包 A、B 各装一份 `pinia`，store 互相看不到。

**机制**：`vue` / `pinia` / `vue-router` 设为 strict peerDep，由 desktop app 统一提供。`.npmrc` 的 `strict-peer-dependencies=true` 强制执行。

### 5.3 SDK 接口 breaking change（最难，流程兜底）

**场景**：核心团队改 `WorkbenchDescriptor` 字段。

**三层防线**：

1. **SDK 越薄越稳**：v2 SDK 只暴露 `WorkbenchDescriptor` / `registerWorkbench` / `resolveWorkbenchKind` / 内置 region 渲染器，**不暴露** `useAgentMode` / `useArtifact` 等。接口面小，breaking 少
2. **semver 流程**：breaking 必须升 major（`1.x → 2.0`），保留 1.x 维护分支 3 个月
3. **类型层兜底**：`pnpm -r build` 跑所有包，TypeScript 编译失败立刻知道影响

### 5.4 业务包之间互相依赖（罕见，约定兜底）

**约定**：禁止业务包之间互相 import。共享能力必须沉淀到 `workbench-sdk`。lint 规则强制 `no-cross-workbench-imports`。

---

## 六、迁移路径（分阶段）

### 6.0 实施进度与 TODO（2026-07-13，分支 `feat/oem-platform`）

> **读本节再动手。** 设计终局 ≠ 当前仓库状态。骨架 / 接线已有一批，**真 monorepo 与业务台可用形态仍大段未做。**  
> 产品侧（换皮 / 换能力）见 [`oem-vision.md`](./oem-vision.md) 同日进度表。

#### 图例

- ✅ 已落地可用  
- ⚠️ 骨架 / 半成品（有代码，未达本节验收标准）  
- ❌ 未开始  
- ⏸ 明确后置（不阻塞 OEM 裁剪主路径）

#### 总览（对照 6.1 阶段）

| 阶段 | 设计目标（摘要） | 进度 | 剩余 TODO |
|---|---|---|---|
| **OEM features 接线** | `features` + `isWorkbenchAvailable` + UI/心跳 | ✅ | 扫漏：设置页 / 快捷键 / 个别 Steam 分支是否仍硬编码 |
| **Descriptor 声明** | `skills` / `mcpServers` / `agentPrompt` / `agentPolicy?` | ⚠️ | 内置台补真实 `skills`（若需要）；业务样例台；`agentPolicy` 实现 |
| **Bootstrap 装配** | 启动连 MCP、校验 skills | ⚠️ | 端到端验证；MCP 就绪信号；skills 缺失告警可产品化 |
| **P-1 shared-types** | **物理迁入**真包 + 全仓 import | ⚠️ | ✅ 物理迁入 `packages/shared-types`；`shared/types` 为兼容 re-export；全仓改 `@sailfish/shared-types` 可渐进 |
| **Workspace** | pnpm（决策）或过渡 npm workspaces | ✅ | **现网路径 = npm workspaces**（W1–W4 已验证）；pnpm 仍为可选终局，有同仓多团队 / 发版需求再切（见决策 #2） |
| **P0 assistant 抽包** | 物理迁 `workbench-assistant` + 构建冒烟 | ✅ | ✅ descriptor/prompt/agent-tools/AssistantWorkbench/**artifact** 真源在包内；`src/` 薄 re-export；electron-builder 全量冒烟待做 |
| **P1 全台 + SDK** | local/ssh/companion + sdk 真包；region 渲染器 | ⚠️ | ✅ 内置台真抽；✅ SDK 真核 + 壳门牌；✅ **W7c 复用只经 SDK**；❌ region / apps/desktop |
| **P2 AiPanel 下沉** | 对话区可被业务台复用 | ✅⏸ | ✅ 薄壳出口够用；⏸ W7b 不做实现迁包 |
| **P3 useAgentMode** | 原语进 SDK | ⏸❌ | 后置；薄壳模型下非刚需 |
| **P4 发版机制** | changesets / Packages / CODEOWNERS | ⏸❌ | **不做**：同仓内部协作，无跨公司独立发版需求 |
| **P5 业务试点** | 模板 + 第一个岗位台 | ⚠️ | sample 台已作模板；真实岗位按需加包即可 |
| **SSO 产品面** | 登录 UI / 回调窗 / 会话落盘 / refresh / JWKS | ✅ | W8 已落地；开源 `features.sso=false` 无感 |
| **品牌构建收拢** | productName / appId / 图标读 OEM | ⚠️ | 运行时品牌 ✅；打包配置未完全统一 |

#### 近期执行队列（建议顺序，可勾选）

- [x] **W1** 启用 **npm workspaces**（不换 pnpm）：`package.json#workspaces` + `@sailfish/*` 依赖声明；`npm install` / 类型检查冒烟（2026-07-13）  
- [x] **W2** **P-1 物理迁码**：`shared/types` → `packages/shared-types`；保留 `@shared/types` alias（2026-07-13）  
- [x] **W3** **P0**：`assistant` 真抽包（descriptor + prompt + agent-tools + AssistantWorkbench）+ desktop/registry/tools 改包名 import（2026-07-13）；artifact 与 AiPanel 仍留 desktop 
- [x] **W4** 样例业务台 `@sailfish/workbench-sample`（descriptor + skills + 假 MCP）+ bootstrap 单测（2026-07-13）；无 Welcome 入口，不污染日常 UI  
- [x] **W5** **评估结论（2026-07-13）**：暂不切 pnpm。理由：① 本机/CI 已稳定跑 npm workspaces；② W1–W4 链路已通；③ 切 pnpm 需改 lockfile、electron-builder、postinstall、文档与贡献者习惯，收益暂不明显。决策 #2 改为「目标仍可 pnpm，**当前官方路径 = npm workspaces**」。  
- [x] **W6** P1：local/ssh/companion **真抽包**；registry 全改包名 import（2026-07-13）  
- [x] **W7a** SDK 真核 + AiPanel **薄壳正式出口**（2026-07-13）  
- [x] **W7b** **明确不做**（2026-07-13）：同仓、公司内部团队；薄壳 SDK 即可，无需 AiPanel 实现迁包 / 独立编译 / 跨包发版  
- [x] **W7c** **复用只经 SDK**（2026-07-13）：岗包禁止 `@/components` / `@/stores`；允许列表 = SDK 门牌（`ai-panel` / `terminal-tab-view` / `workbench-shell` / `platform`）；手册写明；assistant artifact 为平台专属例外  
- [x] **W7d** **A：对话壳与 artifact 解耦**（2026-07-13）：`useArtifactAgentBridge` 仅助手岗挂载；AiPanel / useAgentMode 不再 import artifactStore（历史恢复 / workbench-handler 仍在 desktop 宿主）  
- [x] **W7d.1** **溯源跳转 = AiPanel 接口**（2026-07-13）：`scrollToAgentStep` defineExpose；AssistantWorkbench 持 ref 转给 ArtifactPanel；删除 `agent-step-navigation` 全局总线  
- [x] **W7e** **artifact 迁入 `@sailfish/workbench-assistant`**（2026-07-13）：岗内真源  
- [x] **W7f** **toast SDK + ArtifactDesktopHost**（2026-07-13）：toast 门牌；削 artifact 对 terminalStore 直引；删 desktop artifact shim  
- [x] **W7g** **markdown SDK 薄壳**（2026-07-13）：`@sailfish/workbench-sdk/markdown`；artifact MarkdownRenderer 改走门牌  
- [x] **W7h** **artifact 去 `@/` 收口**（2026-07-13）：`addComposerQuote` 经 AiPanel+岗壳；HoverTip 包内自持；assistant artifact 零 `@/`  
- [x] **OEM 加岗手册**：[`docs/oem-workbench-guide.md`](./oem-workbench-guide.md)（2026-07-13）  
- [x] **W8** SSO UI + 回调窗 + credential 落盘 + refresh + SDK auth 门牌 + enterpriseApiHosts 注入（2026-07-13）  

#### 刻意未做（避免误判为遗漏）

- 企业控制面（组织 / RBAC / 计费 / 策略下发服务端）  
- 业务包互相 import  
- `@sailfish/core` 抽后端（v2 已砍）  
- **AiPanel 实现下沉 / 独立编译发版**（薄壳模型 + 同仓内部协作，非目标）  

更新约定：每完成上表一行，同步改「进度」列与本节日期；合入 `develop` 前至少勾掉 W1 或写明仍 WIP。

### 6.1 工作量评估

| 阶段 | 内容 | 工作量 | 风险 | 进度（见 6.0） |
|---|---|---|---|---|
| **P-1** | 抽 `@sailfish/shared-types` 包：把 `shared/types/` 物理迁入；`McpServerConfig` 三处重复定义收敛到此处；全仓库 `@shared/types` import 改 `@sailfish/shared-types`（保留 alias 兼容） | 1-2 天 | 中，触及全仓库 import 路径 | ⚠️ 物理迁入完成；import 路径渐进切 `@sailfish/shared-types` |
| **P0** | pnpm workspace 骨架 + 把 `src/workbench/assistant/` 抽成独立包跑通 | 1-2 天 | 低，验证链路 | ⚠️ 包名骨架；workspace / 物理迁未做 |
| **P1** | 所有 `src/workbench/*` 抽包 + `workbench-sdk` 抽出 + `WorkbenchDescriptor` 扩展 skills/mcpServers/agentPrompt + desktop 装配逻辑 | 3-5 天 | 中，要重构 registry.ts 硬编码 | ⚠️ Descriptor+registry+bootstrap 已在 `src/workbench`；抽包未完成 |
| **P2** | AiPanel 下沉到 SDK，解耦对 assistant store 的依赖 | 5-7 天 | 高，6600 行组件重构 | ❌ |
| **P3** | `useAgentMode` 拆分：原语进 SDK，应用层留 desktop | 5-7 天 | 高，2310 行 composable 重构 | ❌ |
| **P4** | changesets + GitHub Packages + CI + CODEOWNERS | 2-3 天 | 低 | ❌ |
| **P5** | 业务工作台模板 + 文档 + 第一个业务包试点 | 持续 | 低 | ❌ |

注：v2 砍掉了 v1 的 `@sailfish/core` 抽包阶段（原 P2，5-10 天高风险），总工作量大幅下降。但新增了 P-1（shared-types 抽包）作为前置——这是 SDK 类型闭环的硬性前提，无法绕开。

### 6.2 P-1 shared-types 抽包（1-2 天，前置必须）

**目标**：让 `TerminalType` / `McpServerConfig` 等共享类型成为真包，SDK 能 import。

**步骤**：

1. 新建 `packages/shared-types/` + `package.json`（`@sailfish/shared-types`，纯类型，无运行时）
2. `shared/types/` 物理迁入 `packages/shared-types/src/`
3. `McpServerConfig` 从 `mcp.service.ts` / `config.service.ts` / `preload.ts` 三处收敛到 `packages/shared-types/src/mcp.ts`，三处改为 re-export
4. 全仓库 import 路径：`@shared/types` 改为 `@sailfish/shared-types`；保留 `@shared` Vite alias 一段时间做兼容过渡
5. `pnpm -r build` 验证编译通过
6. `bash electron/cli/test-cli.sh --no-ai` 跑回归

**验收标准**：dev 启动、CLI 测试通过、release 构建正常。

### 6.3 P0 最小验证（1-2 天）

**目标**：验证 pnpm workspace + Vite + electron-builder + Vue 单例链路可行。

**步骤**：

1. `pnpm init` 改造根 package.json 为 workspace 根
2. 新建 `pnpm-workspace.yaml`、`.npmrc`
3. 新建 `packages/workbench-assistant/` 目录 + package.json（`@sailfish/workbench-assistant`）
4. 把 `src/workbench/assistant/{descriptor,prompt,agent-tools}.ts` 物理迁入
5. 把 `src/components/workbench/AssistantWorkbench.vue` 物理迁入
6. 在 `apps/desktop/` package.json 加 `"@sailfish/workbench-assistant": "workspace:*"`
7. `registry.ts` 改为 `import { descriptor } from '@sailfish/workbench-assistant'`
8. `pnpm install && pnpm dev` 验证

**验收标准**：dev 启动、assistant 工作台打开、产出物面板正常、HMR 正常、release 构建能打出来跑起来。

### 6.4 P1 工作台全部抽包 + SDK 成型（3-5 天）

1. `src/workbench/{local,ssh,companion}/` 按同样模式抽包
2. 抽 `@sailfish/workbench-sdk`：`types.ts` / `registry.ts` / `resolve-workbench-agent-prompt.ts`
3. `WorkbenchDescriptor` 扩展 `skills` / `mcpServers` / `agentPrompt` 字段
4. `registry.ts`：`DESCRIPTORS` 从硬编码 import 改为运行时 `registerWorkbench()` 动态注册
5. `resolveWorkbenchKind(tab)` 增加 `tab.workbenchKind` 字段优先识别
6. 新增 `apps/desktop/src/workbench-bootstrap.ts`：desktop 启动时遍历 descriptor 装配 skills/mcp
7. 同步更新所有 SPEC.md

### 6.5 P2 AiPanel 下沉（5-7 天，可延后）

把 AiPanel 从 `apps/desktop/src/components/` 抽到 `packages/workbench-sdk/src/region-renderers/ai-panel/`：

- 解耦对 `useAssistantArtifactStore` 的依赖（artifact 改成可选注入）
- 解耦对 `useTerminalStore` 的硬依赖（通过 props 传 tabId）
- 保留 `useAgentMode` 调用（此时 useAgentMode 还在 desktop，AiPanel 通过 inject 拿）

### 6.6 P3 useAgentMode 拆分（5-7 天，可延后）

`useAgentMode` 2310 行拆两层：

- **SDK 原语**：`useAgentSession(tabId)` —— 消息收发、状态、cancel（薄，不依赖 desktop store）
- **应用层**：`useAgentMode` 留 desktop —— FLIP 动画、ResizeObserver 补偿、草稿持久化、任务分组

### 6.7 P4-P5 发版机制 + 试点

changesets + GitHub Packages + CI + CODEOWNERS + 业务工作台模板 + 试点。

---

## 七、风险与开放问题

### 7.1 业务团队技术栈前提（已确认）

业务团队统一用 TS + Vue3 + Pinia，通过 AI 辅助编码（Cursor / Claude Code）上手。技术栈统一不再是门槛。无需退到纯 JSON 配置方案。

### 7.2 Electron 重打包成本

每次业务包更新，desktop 都要重新 `electron-builder` 打包。缓解：业务包代码作为 external bundle，运行时从 `{userData}/workbench-bundles/<name>/` 加载（P5 之后考虑）。

### 7.3 SDK 接口稳定性 vs 演进

SDK 1.0 只暴露 `WorkbenchDescriptor` / `registerWorkbench` / `resolveWorkbenchKind` / 内置 region 渲染器。业务团队需求先在 desktop 内部消化，沉淀成熟后再提到 SDK。SDK 升 major 必须有 3 个月 1.x 维护期。

### 7.4 开放问题

1. **业务包是否随 desktop 一起打包进 release？** 还是作为可选下载？影响打包体积和首启体验。（Fork OEM 场景下通常打进自己的安装包。）
2. **业务包的 i18n 怎么处理？** 各自维护翻译，还是贡献到主 i18n bundle？
3. **业务包能否注册自己的 IPC handler？** 当前 IPC 全在 `main.ts` 注册。若允许，需 desktop 暴露安全的注册入口。
4. **业务包的测试怎么跑？** 各包 vitest 独立跑，还是聚合到根 CI？
5. **CLI 模式（`electron/cli/`）怎么处理业务工作台？** CLI 纯后端无 Vue，但声明的 skills/mcp 应加载。

**已拍板（不再当作开放问题）：**

- **skills 来源**：优先工作台包自带 skill 模块（side-effect `registerSkill`）+ descriptor 声明 id；引用核心 skill id 为补充。  
- **发版主路径**：Fork + 包边界清晰优先；GitHub Packages / changesets 为同仓多团队可选。  
- **可用性**：`isWorkbenchAvailable` 统一 features + Steam。  
- **装配**：本地注册与服务端下发同一 bootstrap。  

产品 / OEM 侧问题见 [`oem-vision.md`](./oem-vision.md)。其余工程问题建议在 P0 跑通后再讨论。

---

## 八、决策清单

| # | 决策项 | 推荐选项 | 待确认 |
|---|---|---|---|
| 1 | 整体方案是否走精简版 Monorepo（v2） | ✅ 是 | ☑ |
| 2 | 包管理器是否用 pnpm | 目标可选；**当前 = npm workspaces** | ☑ W5：暂不切；同仓内部无强动机 |
| 3 | 内部 registry / changesets 独立发版 | **不做**（同仓内部） | ☑ |
| 4 | 业务团队技术栈 TS + Vue3 + Pinia | ✅ 是 | ☑ |
| 5 | `WorkbenchDescriptor` 加 skills/mcpServers/agentPrompt（及预留 agentPolicy） | ✅ 是 | ☑ 字段已落地；agentPolicy 实现 ⏸ |
| 6 | 新增 `@sailfish/shared-types`（P-1） | ✅ 是 | ☑ 骨架；物理迁码见 6.0 |
| 7 | skills 包内自治优先 | ✅ 是 | ☑ |
| 8 | `isWorkbenchAvailable` 统一 features + Steam | ✅ 是 | ☑ 已落地 |
| 9 | descriptor 双来源同一 bootstrap | ✅ 是 | ☑ bootstrap 半成品；服务端下发 ❌ |

产品 / OEM 决策见 [`oem-vision.md`](./oem-vision.md)。

注：v1「是否同时支持配置型工作台」已并入形态 A，不单列。

---

## 九、参考

- 产品 / OEM 说明：[`oem-vision.md`](./oem-vision.md)
- [pnpm workspace 文档](https://pnpm.io/workspaces)
- [changesets 文档](https://github.com/changesets/changesets)
- [GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
- [CODEOWNERS 文档](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- 现有工作台体系：`src/workbench/SPEC.md`
- 现有插件系统：`electron/services/plugin/SPEC.md`
- Agent 子系统：`electron/services/agent/SPEC.md`
- 技能系统：`electron/services/agent/skills/registry.ts`
- MCP 服务：`electron/services/mcp.service.ts`
- 项目架构：`docs/architecture.md`

---

## 十、v1 → v2 变更记录（废弃项）

记录 v2 砍掉的 v1 设计，避免后续讨论时复活：

| v1 设计 | v2 处理 | 砍掉理由 |
|---|---|---|
| `@sailfish/core` 包，把 `electron/services/` 全迁入 | 砍掉，后端留 `apps/desktop` | 业务工作台不直接调后端，只声明 skill/mcp 依赖，desktop 装配 |
| 业务包 `./node` 后端入口 + `registerWorkbenchPrompt/Tools` | 砍掉，改 descriptor 字段 | 工作台 prompt 走前端注入+IPC（结论 4），后端不 import 工作台包 |
| `useAgentSession` / `useArtifact` / `useTerminal` 进 SDK | 砍掉，P2-P3 阶段 AiPanel/useAgentMode 拆分后再说 | 都是应用层/工作台专属，不该塞 SDK |
| `WorkbenchKind` 改 string | 保留 | 业务自由命名 |
| `RegionSpec.renderer` 加 `artifact-panel` | 砍掉，artifact-panel 由 assistant 包导出 | 产出物面板是 assistant 专属 |
| 五处"把应用层塞 SDK/core"的错误 | 全砍 | 违反"从消费者倒推"原则 |

### v2 自查修订（本次）

| 自查发现 | 处理 |
|---|---|
| SDK `import type { McpServerConfig } from '@sailfish/desktop/mcp'` —— `apps/desktop` 不是 npm 包，路径不存在 | 新增 P-1 阶段：抽 `@sailfish/shared-types` 包，把 `shared/types/` + `McpServerConfig`（三处重复定义）迁入收敛。SDK 从此包 import |
| `TerminalType` 在 `shared/types/agent.ts`，是 Vite alias 不是真包，SDK 无法 import | 同上，P-1 一并解决 |
| `getAllWorkbenchDescriptors` 在 SDK 公开导出但只被 desktop 用 | 标 `@internal` JSDoc |
| 形态 B（自定义渲染器）可用阶段未明确 | 3.4 节标注"P2 之后可用"；3.6 速查表加 P-1 行 |

