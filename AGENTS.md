# SailFish 项目指令

请始终用中文回答。所有编辑器共用 `.cursor/rules/` 的规则源，入口只负责加载，不复制规则正文。

## 每次新对话必读

先完整阅读以下文件，再进行项目操作：

- `.cursor/rules/collaboration.mdc`
- `.cursor/rules/local-dev.mdc`
- `.cursor/rules/spec-driven.mdc`
- `.cursor/rules/product-philosophy.mdc`
- `.cursor/rules/project-architecture.mdc` 的「概览」「目录结构」及各章节标题；任务涉及的章节在动手前完整阅读。

## 按任务必读

- 查询代码结构前：`.cursor/rules/codegraph.mdc`。
- 修改提示词、工具描述或模型收到的文案前：`.cursor/rules/agent-prompt-principles.mdc`。
- 修改 Agent 抽象层指定文件前：`.cursor/rules/agent-oop-boundary.mdc`（范围见该文件）。
- 验证界面前：`.cursor/rules/ui-e2e-quiet.mdc`。
- 用户提出产品点子、或完成相关功能时：`.cursor/rules/ideas.mdc`。
- 修改模块前：对应 `SPEC.md` / `*_SPEC.md` 的设计目标与行为契约；阅读架构总览中该模块的章节，并沿引用读取与任务有关的专题设计和未完成方案。历史 Plan 只作背景，不能覆盖已确认的当前需求。
- 测试、审查、提交、SPEC 管理、版本发布时：分别读取 `.cursor/skills/` 下的 `cli-testing`、`claude-review`、`commit-scoped-changes`、`spec-management`、`release` 的 `SKILL.md`。Steam 发布时若本机存在 `.cursor/skills/steam-publish/SKILL.md` 则读取；该技能当前未纳入仓库，缺失时先说明，不假定其他机器拥有。不执行发布等未获授权的操作。

无需每次通读所有 SPEC、历史 Plan、README、网站内容和应用内技能。若新增规则，检查其适用条件并同步本入口。

## 工具与权威来源

- 用户当前明确指令优先于仓库约定；已有确认在本任务内持续有效，不重复索取确认。
- 协作、验收与合入以 `collaboration.mdc` 为准；产品目标以 `product-philosophy.mdc` 和模块 SPEC 为准；代码结构以源码为准，架构总览是导航；测试和发布命令以对应开发技能为准；提交标题以 `CONTRIBUTING.md` 的提交规范为准。
- 同级文档对行为承诺存在实质冲突时，说明冲突并向用户确认；普通实现细节由智能体判断，不用历史方案推翻当前契约。
- Cursor 的搬移对话、改标题工具不可用时，使用当前环境的工作树工具或 Git，明确实际工作目录并记录分支状态；不得声称执行过不存在的工具。优先使用当前环境管理的工作树，分支按环境约定命名。
- CodeGraph 或 Claude CLI 不可用时按对应规则降级，说明验证限制，不阻塞可独立完成的工作。
