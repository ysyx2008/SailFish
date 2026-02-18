---
name: Git 提交规范
description: 规范化 Git 提交信息，遵循 Conventional Commits 标准
version: "1.0"
---

# Git 提交规范

当用户要求进行 git commit 时，必须遵循以下规范。

## 提交信息格式

```
<type>(<scope>): <subject>

<body>
```

### Type（必填）

| 类型 | 说明 |
|------|------|
| feat | 新功能 |
| fix | 修复 bug |
| docs | 文档变更 |
| style | 代码格式（不影响功能） |
| refactor | 重构（非 feat、非 fix） |
| perf | 性能优化 |
| test | 测试相关 |
| chore | 构建/工具/依赖变更 |
| ci | CI/CD 配置变更 |
| revert | 回退提交 |

### Scope（可选）

说明影响范围，如模块名、文件名。

### Subject（必填）

- 简短描述，不超过 50 个字符
- 使用祈使句，如"添加"而非"添加了"
- 首字母小写，末尾不加句号

### Body（可选）

- 详细描述修改原因和内容
- 与 subject 之间空一行

## 工作流程

1. 先用 `git diff --staged` 查看已暂存的变更
2. 分析变更类型和范围
3. 生成符合规范的提交信息
4. 如果变更涉及多个不相关的修改，建议拆分为多次提交
