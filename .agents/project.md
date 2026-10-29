# SailFish 项目约定

- 集成分支 `develop`，生产分支 `main`；主目录用 `git worktree list` 识别。
- 工作树优先由编辑器管理，否则建在仓库外；按环境命名（Codex 用 `codex/`），不改他人分支。
- 初始化：`bash .cursor/setup-worktree-unix.sh`，保留旧路径兼容 Cursor；纯文档不装依赖。
- 用户验收：`review` / `review <名字>` / `review --cli <名字> [一句话]`；未装短命令用 `npm run review` / `npm run review:cli`。外部工作树可能不在列表中，交付提供实际目录及适用命令。
- 界面验证走 `scripts/ui-e2e/launch.mjs` 的 launchApp 和临时数据；不自行跑 dev 或 review 使用真实数据、抢占用户窗口。
- 回归与发布分别见 `.agents/skills/cli-testing/SKILL.md`、`.agents/skills/release/SKILL.md`。
- 本项目使用 `--no-ff` 和开始/结束附注标签，操作前读 `.agents/workflow.md`。

发布需授权。本机 Steam 技能未纳入 Git；需要时查 `.agents/skills/steam-publish/SKILL.md` 或旧 `.cursor/skills/steam-publish/SKILL.md`，缺失则说明，不迁移或公开本机文件。
