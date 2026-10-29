# 贡献指南

感谢你对旗鱼的关注！本文档介绍项目的分支策略和开发流程。

## 分支策略

本项目采用简化的 Git Flow 分支模型：

| 分支 | 用途 | 生命周期 |
|------|------|----------|
| `main` | 稳定的生产分支，始终保持可发布状态 | 永久 |
| `develop` | 开发主分支，日常开发和功能集成 | 永久 |
| `feature/*` | 新功能开发分支 | 临时，合并后删除 |

### 分支工作流

```
feature/xxx  →  develop  →  main (打标签发布)
```

## 外部贡献者（Fork & PR）

如果你不是项目协作者，请通过 fork + Pull Request 的方式贡献代码。

### 1. Fork 与同步主仓库

```bash
# 1. 在 GitHub 上点击 Fork 把本仓库复制到你的账号下

# 2. 克隆你 fork 出来的仓库到本地
git clone https://github.com/<你的用户名>/SailFish.git
cd SailFish

# 3. 添加 upstream 远端，方便后续同步主仓库
git remote add upstream https://github.com/ysyx2008/SailFish.git
git fetch upstream
```

### 2. 创建分支并提交 PR

```bash
# 基于 upstream/develop 创建功能分支（注意：不要基于 main）
git checkout -b feature/你的功能名 upstream/develop

# 开发、提交后推送到你 fork 出来的仓库
git push -u origin feature/你的功能名
```

然后到 GitHub 创建 Pull Request：

- **目标分支务必选 `develop`**（GitHub 默认会指向 `main`，记得手动切换）
- PR 标题使用[约定式提交](#提交规范)格式
- 单个 PR 聚焦一个清晰目标，避免把多个无关改动捆在一起

### 3. PR 等待期间同步上游

如果 review 期间主仓库有新进展，可以把最新代码合到你的分支：

```bash
git fetch upstream
git rebase upstream/develop   # 或 git merge upstream/develop
git push --force-with-lease   # rebase 后需要强制推送
```

## 内部协作者开发流程

智能体协作入口为 [AGENTS.md](AGENTS.md)，工作树、分支、测试、验收及合入流程以 [.agents/rules/collaboration.md](.agents/rules/collaboration.md) 为准，不在此重复维护。用户验收并明确同意合入后，才合入 `develop`。

发布与热修以 [.agents/skills/release/SKILL.md](.agents/skills/release/SKILL.md) 为准；Steam 发布另见对应技能。外部贡献者仍使用上面的 Fork 与 PR 流程。

## 提交规范

使用约定式提交 (Conventional Commits) 格式：

```
<type>(<scope>): <description>
```

`scope`（范围）可选，写改动所在的模块名，如 `composer`、`knowledge`、`memory`、`skills`；改动跨得太散、说不出单一模块时可省略，写成 `<type>: <description>`。

`description`（描述）用中文，写用户能感知的结果。

### 类型说明

| 类型 | 说明 |
|------|------|
| `feat` | 新增功能 |
| `fix` | 修复 bug |
| `docs` | 文档更新（技能、提示词文件的改动也算） |
| `style` | 代码格式调整（不影响逻辑） |
| `refactor` | 代码重构 |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建/工具相关 |

### 示例

```
feat(ssh): 添加 SSH 密钥认证功能
fix(terminal): 修复终端中文乱码问题
docs: 更新 README 安装说明
refactor(ai): 重构 AI 对话模块
```

## Pull Request 流程

1. 按改动范围验证，代码改动执行适用的 lint 检查：`npm run lint`
2. TypeScript 改动执行类型检查：`npm run typecheck`；纯文档检查引用和内容一致性
3. 创建 PR 时填写清晰的描述
4. 等待代码审查通过后合并

## 版本号说明

项目使用语义化版本 (Semantic Versioning)：

- **主版本号 (MAJOR)**：不兼容的 API 变更
- **次版本号 (MINOR)**：向后兼容的功能新增
- **修订号 (PATCH)**：向后兼容的 bug 修复

示例：`v3.1.2` 表示第 3 个大版本，第 1 次功能更新，第 2 次 bug 修复。
