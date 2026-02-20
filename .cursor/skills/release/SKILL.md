---
name: release
description: Automates SFTerminal release workflow: fix build/type errors, update CHANGELOG (EN + CN), run npm version with pre/post hooks. Use when the user asks to release, 发版, 发布, bump version, or update changelog.
---

# SFTerminal 发版技能

本技能用于在本仓库内执行发版流程：解决构建/类型错误、更新更新日志、执行 `npm version`。

## 前置条件

- 必须在 **develop** 或 **main** 分支执行。
- 执行 `npm version` 前工作区必须干净（无未提交更改）。

---

## 发版流程（推荐顺序）

版本号由 `npm version` 产生，而更新日志需在之前提交，因此要**先定发版类型**，再按"即将产生的版本号"写日志，保证一致：

1. **确定发版类型**：先运行 `git log v<当前版本>..HEAD --oneline` 查看自上次发版以来的提交，根据改动内容**主动给出建议**（参考下方规则），让用户确认即可，不要让用户自己判断。
   - 含 breaking change / 大规模重构 → 建议 `major`
   - 含新功能 / 新模块 → 建议 `minor`
   - 仅修复、优化、文档 → 建议 `patch`
   确认后，读取 `package.json` 的 `version`，按 semver 推算出下一版本号（如 8.19.4 → patch 为 8.19.5，minor 为 8.20.0）。
2. **修复构建、检查与测试**：确保 `npm run check`、`npm run build:check`、`npm run test:run`、`bash electron/cli/test-cli.sh --no-ai` 全部通过。
3. **更新更新日志**：用**上一步算出的版本号**在 `CHANGELOG.md` 与 `CHANGELOG_CN.md` 中写入本版本条目（见下文格式）。
4. **检查 README 和网站是否需要更新**：对于 `minor` 或 `major` 版本，对比自上次发版以来的提交，检查以下文档是否需要同步更新（如新增功能/通道/文档链接等），若需要则一并修改：
   - `README.md` 和 `README_CN.md`（功能列表、描述、文档链接）
   - `website/src/i18n/translations.ts`（网站功能介绍、Hero 文案等）
5. **提交日志及文档变更**：`git add` 并 `git commit` 更新日志和可能的 README 变更。
6. **执行版本号更新**：执行与步骤 1 一致的 `npm version <patch|minor|major>`，此时产生的版本号会与日志中一致。

---

## 1. 解决构建/类型错误

**不要**用关键词匹配来"猜"错误类型，必须依据实际命令输出定位问题。

1. 运行检查、构建和测试，收集真实错误输出：
   - `npm run check` — 类型检查 + 静态检查
   - `npm run build:check` — 生产构建预检（`vue-tsc --noEmit && vite build --mode production`）
   - `npm run test:run` — 单元测试
   - `bash electron/cli/test-cli.sh --no-ai` — CLI 回归测试（参见 `.cursor/rules/cli-testing.mdc`）

2. 根据终端或 IDE 报错信息修复：
   - TypeScript/`vue-tsc`：按文件与行号修类型或实现。
   - ESLint：按规则修代码或配置。
   - Vite 构建错误：按报错模块与堆栈修复。

3. 修复后再次运行上述命令，直到全部通过。

---

## 2. 更新更新日志

写日志时使用的版本号必须是**即将通过 `npm version` 产生的版本号**（由当前 `package.json` 的 version + 已确定的 patch/minor/major 推算），这样先提交 changelog 再执行 `npm version` 时不会出现版本号不一致。

本项目有两个日志文件，需**同时**更新、内容对应：

| 文件 | 语言 |
|------|------|
| `CHANGELOG.md` | 英文 |
| `CHANGELOG_CN.md` | 中文 |

### 版本标题格式

每个版本标题都需要包含**发布日期**（`YYYY-MM-DD` 格式，取发版当天日期）：

- **CHANGELOG.md**：`## vX.Y.Z (YYYY-MM-DD) (Latest)`（当前最新）或 `## vX.Y.Z (YYYY-MM-DD)`（历史版本）。
- **CHANGELOG_CN.md**：`## vX.Y.Z (YYYY-MM-DD)（最新版本）` 或 `## vX.Y.Z (YYYY-MM-DD)`。

发版时把**上一版**的"(Latest)"/"（最新版本）"移到**本版**，上一版改为普通 `## vX.Y.Z (YYYY-MM-DD)`。

### 分类与条目格式

**CHANGELOG.md：**

- `### New Features` — 新功能
- `### Improvements` — 改进
- `### Bug Fixes` — 问题修复

**CHANGELOG_CN.md：**

- `### 新功能`
- `### 改进`
- `### 问题修复`

每条目一行，列表项格式示例：

- 英文：`- 📝 **简短标题**：说明文字` 或 `- 📝 说明文字`
- 中文：与英文一一对应翻译/改写

### 收集变更条目

用以下命令获取自上次发版 tag 以来的所有提交，作为写日志的素材：

```bash
git log v<当前版本>..HEAD --oneline
```

例如当前版本为 8.19.4：`git log v8.19.4..HEAD --oneline`。

根据提交记录归类到 New Features / Improvements / Bug Fixes，用户也可口述补充。**不编造未发生的改动**。

---

## 3. 执行 npm version

- 命令：`npm version patch` | `npm version minor` | `npm version major`
- 非交互场景（如脚本/CI）：`npm version patch --no-git-tag-version` 仅改 `package.json`；若需走完整钩子且自动确认，可使用 `npm_config_yes=true npm version patch`（会触发 preversion 中的确认为"是"）。

**preversion**（`scripts/preversion.js`）会：

1. 检查分支为 develop 或 main、工作区干净。
2. `git pull --ff-only`、`git fetch --tags`。
3. 运行 `npm run build:check`、`npm run test:run`。
4. 保存当前分支状态（不切换分支，避免 npm 在错误分支上重复 bump）。

**postversion**（`scripts/postversion.js`）会：

1. 若从 develop 发版：先推送 develop（含版本 commit），再切到 main、合并 develop、推送 main 和 tag，最后切回 develop。
2. 若从 main 发版：直接推送 main 和 tag。

发版前务必已**先提交 CHANGELOG 的修改**，再执行 `npm version`，否则 preversion 会因"工作区不干净"失败。

---

## 快速检查清单

- [ ] `npm run check` 通过
- [ ] `npm run build:check` 通过
- [ ] `npm run test:run` 通过
- [ ] `bash electron/cli/test-cli.sh --no-ai` 通过
- [ ] `CHANGELOG.md` 与 `CHANGELOG_CN.md` 已更新且版本号、日期、条目一致
- [ ] （minor/major）检查 `README.md`、`README_CN.md` 和 `website/src/i18n/translations.ts` 是否需要同步更新
- [ ] 更新日志及文档变更已提交
- [ ] 当前在 develop 或 main，无未提交更改
- [ ] 执行 `npm version <patch|minor|major>` 完成发版
