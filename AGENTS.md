# SailFish 项目指令

始终用中文。规则正文在 `.agents/`，项目知识在 `docs/`；编辑器入口只引用，不复制正文。

## 新对话必读

- `.agents/rules/collaboration.md`
- `.agents/rules/local-dev.md`
- `.agents/rules/spec-driven.md`
- `.agents/project.md`
- `docs/product-philosophy.md`
- `docs/architecture.md` 的「快速导航」；动手前读相关章节及引用。

## 按任务读取

| 任务 | 必读 |
|---|---|
| 修改模块 | 对应 SPEC 的设计目标、行为契约及相关当前方案 |
| 查代码结构 | `.agents/rules/codegraph.md` |
| 改提示词或模型可见文案 | `.agents/rules/agent-prompt-principles.md` |
| 改 Agent 抽象层 | `.agents/rules/agent-oop-boundary.md`，范围见正文 |
| 验证界面 | `.agents/rules/ui-e2e-quiet.md` |
| 提出点子、完成相关功能 | `.agents/rules/ideas.md` |
| 交付、变基、合入、清理、盘点分支 | `.agents/workflow.md` |
| 测试、审查、提交、管理 SPEC、发布 | `.agents/skills/` 中对应的 `cli-testing`、`claude-review`、`commit-scoped-changes`、`spec-management`、`release` 的 `SKILL.md` |

Steam 技能未纳入 Git；需要时查 `.agents/skills/steam-publish/SKILL.md` 或旧 `.cursor/skills/steam-publish/SKILL.md`，缺失则说明。发布需用户授权。

用户明确指令优先，已有授权不重复确认。协作流程以 collaboration 为准；产品目标以产品理念和模块 SPEC 为准；结构以源码为准；命令以对应技能、提交格式以 CONTRIBUTING 为准。历史 Plan 仅供参考；行为契约实质冲突需确认。

已在上下文完整加载且未变化的正文不重读。工具不可用按规则降级，不虚报操作或检查结果。新增规则同步本入口和编辑器适配；不预读无关文档。
