# Agent 抽象层 OOP 边界

## 规则

`electron/services/agent/` 下的**抽象层文件**（agent.ts、streaming-tool-executor.ts、tool-output-budget.ts、task-memory.ts、context-builder.ts、tool-metadata.ts）**禁止包含具体工具名字符串字面量**。

具体工具名包括：`'read_file'` / `'execute_command'` / `'write_text_file'` / `'edit_file'` / `'word_from_markdown'` / `'excel_from_markdown'` / `'dispatch_agents'` / `'ask_user'` / `'plan'` / `'recall'` / `'personality_craft'` 等所有内置工具与技能工具的名字。

## 为什么

`agent.ts` 是 Agent **抽象基类**，其它几个文件是横切关注点。按 OOP 原则，抽象层不应知道具体子类（具体工具）的名字。任何"按工具名做行为分支"的代码都应通过 `ToolDefinition._meta` 在工具自己的定义里声明，让抽象层**只读元数据决策**——这是 SPEC.md「工具元数据驱动模型」一节的核心承诺。

历史教训：之前抽象层有多处违反（`buildPreToolCallDisplay` 的 switch / `PARALLELIZABLE_TOOLS` 的 Set / `setExecutionPhase` 的 if-else / `generateAllowedToolKey` 的三元 / 已移除的 tool-result-budget 白名单 / `task-memory` 的 ask_user 与 execute_command 硬编码 / personality_craft 引导判断 / streaming-tool-executor 的 CONCURRENCY_SAFE_TOOLS 复制粘贴 / mcp_ 前缀启发式）。每一处都是"看起来很合理"的小妥协，每一次都让抽象与具体的边界往基类里塌一点。

## 不要这样写

```ts
// ❌ agent.ts 中
if (toolName === 'execute_command' || toolName === 'exec') {
  return { command: toolArgs.command }
}

// ❌ task-memory.ts 中
if (step.toolName === 'ask_user') { ... }
```

## 应该这样写

工具自己声明元数据，抽象层读元数据：

```ts
// ✅ tools.ts 或 skills/*/tools.ts —— 工具自己声明
{
  function: { name: 'execute_command', ... },
  _meta: {
    idempotencyKey: ['command'],
    argRole: { summaryLine: 'command' },
  }
} as ToolDefinitionWithMeta

// ✅ agent.ts —— 通过 helper 查元数据
const meta = getMetaByName(this.getAvailableTools(), toolName)
const summaryField = meta?.argRole?.summaryLine
```

可用的元数据字段（详见 `electron/services/agent/tools.ts` 的 `ToolMeta` 定义）：

- `streamDisplay`：流式预卡片标题/字段/进度尾缀
- `parallelizable`：是否可并行执行
- `phase`：执行此工具时的 Agent 阶段
- `idempotencyKey`：白名单/幂等键的字段子集
- `lifecycle.marksOnboardingComplete` / `lifecycle.blocksUntilUserInput`：生命周期标志
- `argRole.summaryLine`：历史摘要中"主命令字段"

如果你需要的行为没有现成的元数据字段：**扩 `ToolMeta` 加新字段**，而不是在抽象层加 switch。

## 机械护栏

`electron/services/agent/__tests__/oop-boundary.test.ts` 在 CI 中遍历所有工具名，断言抽象层文件源码不含任何一个字面量。任何往这些文件里加工具名的尝试都会让测试失败。

如果你确实需要在抽象层引用某个工具名（例如某些极特殊的兼容性场景），先想想能不能用元数据解决；实在不行，更新 `oop-boundary.test.ts` 里的 `ALLOWED_LITERALS` 集合并写明原因——这是个公开的"已知豁免"清单，不是隐式偷渡的口子。
