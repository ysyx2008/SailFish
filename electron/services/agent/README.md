# Agent 服务模块

本目录包含 SFTerminal 的 AI Agent 实现，采用 ReAct (Reasoning + Acting) 架构。

## 目录结构

```
agent/
├── index.ts              # Agent 主入口，包含核心执行循环
├── types.ts              # 类型定义
├── i18n.ts               # 国际化
├── risk-assessor.ts      # 命令风险评估
├── system-prompt.ts      # 系统提示词生成
├── task-memory.ts        # 任务记忆管理
├── reflection-tracker.ts # 反思追踪
├── tools/                # 工具执行器（已拆分）
│   ├── index.ts          # 工具模块入口
│   ├── types.ts          # 工具类型定义
│   ├── utils.ts          # 通用工具函数
│   ├── command.ts        # 命令执行
│   ├── terminal.ts       # 终端操作
│   ├── file.ts           # 文件操作
│   ├── knowledge.ts      # 知识库操作
│   ├── plan.ts           # 计划/待办
│   ├── memory.ts         # 任务记忆
│   ├── misc.ts           # 其他工具
│   └── README.md         # 工具模块文档
├── skills/               # 技能系统
│   ├── index.ts          # 技能管理器
│   ├── excel/            # Excel 技能
│   ├── email/            # 邮件技能
│   ├── browser/          # 浏览器技能
│   └── word/             # Word 技能
└── tool-executor.ts      # 兼容层（重导出 tools/）
```

## 核心概念

### ReAct 循环

Agent 采用 ReAct 机制：
1. **Reasoning (推理)** - AI 分析当前状态，决定下一步行动
2. **Acting (行动)** - 调用工具执行具体操作
3. **Observation (观察)** - 获取工具执行结果
4. **Loop (循环)** - 根据结果继续推理或结束

### 工具调用

Agent 可以调用的工具类型：
- **终端工具** - 执行命令、检查状态、发送输入
- **文件工具** - 读写文件、搜索文件
- **知识工具** - 记忆、搜索、文档获取
- **计划工具** - 创建/更新/归档执行计划
- **交互工具** - 等待、向用户提问
- **技能工具** - Excel、邮件、浏览器等专业技能
- **MCP 工具** - 第三方 MCP 服务器提供的工具

### 风险控制

- 命令风险评估 (safe/moderate/dangerous/blocked)
- 执行模式 (strict/relaxed/free)
- 用户确认机制
- 反思追踪（连续失败检测）

## 模块职责

| 模块 | 职责 | 行数 |
|------|------|------|
| index.ts | Agent 主循环、状态管理、AI 调用 | ~1900 |
| tools/ | 工具执行实现 | ~1600 (拆分后) |
| skills/ | 技能系统 | ~1500 |
| system-prompt.ts | 系统提示词 | ~400 |
| risk-assessor.ts | 风险评估 | ~300 |
| task-memory.ts | 任务记忆 | ~400 |

## 扩展指南

### 添加新工具

1. 在 `tools/` 下对应模块添加函数
2. 在 `tools/index.ts` 的 switch 语句中添加分支
3. 在 `system-prompt.ts` 中添加工具定义

### 添加新技能

1. 在 `skills/` 下创建新目录
2. 实现 `SKILL.md` 和 `executor.ts`
3. 在 `skills/index.ts` 中注册

## 相关文档

- [工具模块详细文档](./tools/README.md)
- [Agent 架构设计](../../docs/agent-architecture.md)
