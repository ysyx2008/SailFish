---
name: spec-management
description: 生成或审计模块的 SPEC.md。使用场景：用户要求"给 XX 模块写 spec"、"审计所有 spec"、"检查 spec 是否过期"。
---

# Spec 管理技能

按需为模块生成 SPEC.md，或审计已有 spec 与代码的一致性。

## 何时使用本技能

- 用户要求"给 XX 写 spec"、"生成 spec"
- 用户要求"审计 spec"、"检查 spec"、"spec 是否过期"
- 新增服务/子系统后需要补 spec

## 生成 SPEC.md

### 步骤

1. **阅读目标模块源码**：重点关注公开 API（export 的类/函数）、类型定义、依赖（import）、README 或文件头注释。
2. **参考已有 SPEC 模板**：读取 `electron/services/agent/SPEC.md` 了解格式和详细度基准。
3. **撰写 SPEC.md**，包含以下章节：

```markdown
# <模块名> SPEC

> Last verified: <今天日期>

## 职责
<1-2 句话描述模块做什么>

## 文件结构（多文件模块才需要）
<文件列表 + 一句话说明>

## 公开 API
<方法/函数表格：名称 | 用途 | 关键参数>

## 依赖
<该模块依赖的其他服务/模块>

## 关键约束
<不变量、边界条件、性能限制等>
```

4. **遵循原则**：
   - 50-150 行，不超过 200 行
   - 指向而非复制：类型定义用"见 `types.ts`"引用，不要抄一遍
   - 只写稳定的契约信息，不写易变的实现细节
   - 用中文撰写

5. **放置位置**：
   - 子系统目录（如 `agent/`）→ 放在目录下 `SPEC.md`
   - 单文件服务（如 `ai.service.ts`）→ 放在同级目录，命名为 `<SERVICE>_SPEC.md`（如 `AISERVICE_SPEC.md`）

## 审计 SPEC.md

### 步骤

1. **扫描所有 SPEC 文件**：`find electron/services -name '*SPEC.md'`
2. **逐个对比**：读取 spec，然后检查对应源码的公开 API 是否匹配
3. **报告结果**：

| Spec 文件 | 状态 | 问题 |
|---|---|---|
| agent/SPEC.md | ✅ 同步 | - |
| AISERVICE_SPEC.md | ⚠️ 过期 | 新增了 `chatWithVision` 方法未记录 |
| config.service.ts | ❌ 缺失 | 无 SPEC.md |

4. **修复过期 spec**：自动更新不一致的部分，更新 `Last verified` 日期
5. **不自动生成缺失 spec**：仅报告缺失情况，让用户决定是否生成

## 注意事项

- 生成 spec 后不需要跑测试（spec 是纯文档，不影响代码行为）
- 审计时不要修改源码，只修改 SPEC.md
- 如果模块非常简单（< 100 行、只有 1-2 个函数），可以建议用户跳过，不必每个模块都有 spec
