# SailFish 项目约定

此文件保存项目相关设置；复用框架时替换本文件，不复制本机绝对路径。

- 集成分支：`develop`；生产分支：`main`。主目录以 `git worktree list` 中的主工作树为准，不以当前目录猜测。
- 工作树：优先由当前编辑器管理；手动创建时放仓库之外、使用不与现有工作树重复的目录。Cursor 既有目录布局可继续使用。分支遵循当前环境约定（例如 Codex 的 `codex/`）；不得改名他人分支。
- 初始化：`bash .cursor/setup-worktree-unix.sh`，这是当前项目脚本，路径保留以兼容已有 Cursor 配置；纯文档工作无需安装或克隆依赖。
- 用户验收：`review` 列表、`review <名字>` 界面验收、`review --cli <名字> [一句话]` 命令行验收；未安装短命令时用 `npm run review` / `npm run review:cli`。外部工具创建的工作树可能不在列表中，交付时提供准确目录和文档 diff，界面验收先确认脚本支持该路径。
- 智能体验证界面：`scripts/ui-e2e/launch.mjs` 的 `launchApp`，使用临时数据目录；不用用户的真实数据。
- 后端回归：`.agents/skills/cli-testing/SKILL.md`；发布：`.agents/skills/release/SKILL.md`。
- 合入批次：沿用开始/结束附注标签及 `--no-ff` 合并，细节见 `rules/collaboration.md`。这是本项目的追踪习惯，不是通用框架的必要条件。
