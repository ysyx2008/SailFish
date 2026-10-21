---
name: release
description: Automates SailFish release workflow: fix build/type errors, update CHANGELOG (EN + CN), run npm version with pre/post hooks. Use when the user asks to release, 发版, 发布, bump version, update changelog, hotfix, or 热修.
---

# SailFish 发版技能

本技能用于在本仓库内执行发版流程：解决构建/类型错误、更新更新日志、执行 `npm version`。

## 前置条件

- 常规发版在 **develop**（或 **main**）；热修在 **hotfix/**\*。
- 执行 `npm version` 前工作区必须干净（无未提交更改）。

---

## 发版节奏（提醒，不硬拦）

用户侧已有「软件更新太快」反馈。启动发版时根据上次 tag 日期**主动提醒**用户，**不要擅自拒绝发版**；用户确认继续则照常往下走。

| 类型 | 节奏 | 说明 |
|------|------|------|
| 常规（minor / 非紧急 patch） | 建议 **每周最多 1 次** | 功能继续合 develop，凑窗口再发；避免同一自然周连发多个正式版 |
| 热修（紧急 patch） | 可破例 | 仅限启动崩溃、数据损坏、严重安全等必须立刻推给用户的问题 |

判断提示（写入步骤 1 预览里即可，一两句）：

1. 读上一版 tag 的提交日期（如 `git log -1 --format=%ci v<当前版本>`）。
2. 若距今 **不足约 7 天**，且本次**不是**上述热修：提醒「距上次发版仅 X 天，按周更节奏建议先攒着；若坚持发可确认后继续」。
3. 若同一自然周内已发过正式版：额外提一句「本周已发过版，连发会加重更新打扰」。

---

## 热修（已发出的版本有严重问题）

develop 已经在做新功能时，**不要在 develop 上直接发正式版**，否则会把没做完的东西一起推给用户。走热修：

1. **从该版 tag 拉分支**（不要从 develop，也不要从已经超前的 main）:

   ```bash
   git fetch origin --tags
   git checkout -b hotfix/11.6.1 v11.6.0
   ```

   分支名用即将打出的版本号。只带这次要修的问题；已经在 develop 上修好的，把那几笔挑过来。

2. 按下方常规流程写变更日志、跑 `npm run verify`，然后 **`npm_config_yes=true npm version patch`**（热修只用 patch）。

3. postversion 会自动：推热修支 → **先把热修合回 develop**（修复和版本号一起带走）→ 再推 tag → 若 main 还停在旧版点则快进，否则跳过（正式包以 tag 为准）。合回有冲突时不会先发 tag，解决后按终端提示做完即可。

4. **功能分支 rebase 到最新 develop**，热修就带上了。不要 rebase develop 本身。

合回 develop 若有冲突（两边改了同一处，变更日志常见）：先解决再推。脚本失败时终端会打印手工命令，热修**必须**回到 develop，不要只打 tag。

preversion 会检查热修支是不是从已发布的 `vX.Y.Z` 拉的；从 develop / 超前的 main 拉会直接拒绝。

---

## 发版流程（推荐顺序）

版本号由 `npm version` 产生，而更新日志需在之前提交，因此要**先定发版类型**，再按"即将产生的版本号"写日志，保证一致：

1. **确定发版类型并预览变更日志**：先运行 `git log v<当前版本>..HEAD --oneline` 查看自上次发版以来的提交，根据改动内容**主动给出建议**（参考下方规则），让用户确认即可，不要让用户自己判断。同时按上方「发版节奏」检查距上次发版间隔，必要时提醒用户。
   - 含 breaking change / 大规模重构 → 建议 `major`
   - 含新功能 / 新模块 → 建议 `minor`
   - 仅修复、优化、文档 → 建议 `patch`
   确认后，读取 `package.json` 的 `version`，按 semver 推算出下一版本号（如 8.19.4 → patch 为 8.19.5，minor 为 8.20.0）。同时根据提交记录拟定 `CHANGELOG_CN.md` 的完整条目（版本标题、一句话总结、分类列表），一并展示给用户预览确认。**用户确认后**再继续后续步骤。
2. **修复构建、检查与测试**：运行 `npm run verify`（并行执行类型检查、lint、构建、单元测试、CLI 回归测试），确保全部通过。
3. **更新更新日志**：用**步骤 1 确认的版本号**在 `CHANGELOG.md` 与 `CHANGELOG_CN.md` 中写入本版本条目（见下文格式），内容以步骤 1 用户确认的中文版为准，英文版对应翻译。
4. **检查 README 和网站是否需要更新**：对于 `minor` 或 `major` 版本，对比自上次发版以来的提交，检查以下文档是否需要同步更新（如新增功能/通道/文档链接等），若需要则一并修改：
   - `README.md` 和 `README_CN.md`（功能列表、描述、文档链接）
   - `website/src/i18n/translations.ts`（网站功能介绍、Hero 文案等）
5. **提交日志及文档变更**：`git add` 并 `git commit` 更新日志和可能的 README 变更。
6. **在 CI 上试打包**：把当前分支推到远程，手动触发一次发版工作流并等它结束，通过后再进入下一步。

   ```bash
   git push origin <当前分支>
   gh workflow run build-release.yml --ref <当前分支>
   gh run list --workflow=build-release.yml --branch <当前分支> --event workflow_dispatch --limit 1   # 取最新一条的 id
   gh run watch <id> --exit-status
   ```

   - 手动触发只跑 Windows 与 macOS 的打包；上传 OSS、创建 Release 两个任务只在 tag 上执行，试打包不会对外发布任何东西。
   - 耗时：Windows 约 17 分钟，macOS 约 6 到 10 分钟，两边同时跑，合计约 17 到 19 分钟；Windows 是长的那一边。
   - 触发时机：安装包只由代码和依赖决定，更新日志、README、官网文案不进安装包。步骤 1 确认之后就可以先触发，等待的时候写日志、改文档、跑 `npm run verify`。若 `verify` 之后又改了代码，需要重新触发。
   - 是否需要：`npm run verify` 跑在本机已装好的 `node_modules` 上，看不到只在 CI 出现的环节：干净安装（`npm ci` 与 postinstall 补丁）、打包脚本的下载与校验、electron-builder、runner 的内存与下载镜像。过去几次发版失败都出在这里，见下方「tag 已推出但 CI 失败」。这些环节由下面这些文件决定：`package.json`、`package-lock.json`、`patches/`、`electron-builder.config.cjs`、`vite.config.*`、`tsconfig*.json`、`.github/workflows/`、`scripts/download-*`、`scripts/fix-*`。拿它们对比**上一个成功发出安装包的版本**（以 `gh release list` 为准，不是最新的 tag；失败的 tag 里的改动没有真正打过包），没有变化时 CI 上没有新东西，可以不试，在步骤 1 的预览里写明；有变化或拿不准就试。
   - 失败时用 `gh run view <id> --log-failed` 看原因，修好后重新试打包。
   - 热修在热修支上同样处理。
7. **执行版本号更新**：执行与步骤 1 一致的 `npm_config_yes=true npm version <patch|minor|major>`，此时产生的版本号会与日志中一致。

   > ⚠️ AI 工具调用 / 脚本 / 任何无 TTY 场景**必须加 `npm_config_yes=true` 前缀**，否则 preversion 的交互式"确认继续? (y/N)"会挂死。preversion 已加非 TTY 检测，缺前缀时会快速失败并报错而非挂起。
8. **等 Release 出来**：tag 推送会触发发版工作流。安装包与 Release 在这个工作流的最后几个任务里才生成，工作流没跑完时用户还拿不到新版本。`gh run watch <id> --exit-status` 全部通过，且 `gh release view v<版本>` 能查到，才算发出去；工作流失败按下方「tag 已推出但 CI 失败」处理。

---

## tag 已推出但 CI 失败

这时 tag 已在远程，`main` 也已指向这个版本，官网部署随 `main` 执行，但没有安装包和 Release，用户能拿到的最新版仍是上一个。`npm run verify` 全绿也可能走到这一步。

过去的失败原因（都出在本机验证看不到的环节）：

| 版本 | 失败环节 | 原因 |
|---|---|---|
| v11.14.0 | 装依赖 | 飞书 SDK 的补丁按旧版本制作，锁文件里已是新版本，补丁打不上 |
| v11.13.0 | Windows 打包 | 新增的 ripgrep 下载脚本，校验说明的格式在 Windows 上对不上 |
| v10.40.1 | 打包 | 类型检查输出缺失（TS6305） |
| v10.37.2 到 v10.39.0（2026-05） | 打包 | 同样的 TS6305，另有内存不够、Electron 下载镜像 404 |

处理方式：

- 已推送的 tag 不再移动，也不复用这个版本号；在 `develop` 修好后，用下一个版本号重发。
- 失败版本没有发给用户，它的更新说明并入新版本的条目；原条目保留版本标题，下面只留一行「未发布，内容并入 vX.Y.Z」。`CHANGELOG.md` 与 `CHANGELOG_CN.md` 同步。
- 按流程里的试打包（步骤 6）通过后再重新打 tag。
- 网站部署工作流（Deploy Website）在 `develop` 上的 github-pages 环节一直是红的，是环境保护规则所致，与打包成败无关。

---

## 1. 解决构建/类型错误

**不要**用关键词匹配来"猜"错误类型，必须依据实际命令输出定位问题。

1. 运行 `npm run verify` 一次性并行执行所有检查，收集真实错误输出：
   - 类型检查（`vue-tsc --noEmit`）
   - 静态检查（`eslint`）
   - 生产构建预检（`vite build --mode production`）
   - 单元测试（`vitest run`）
   - CLI 回归测试（`test-cli.sh --no-ai`，参见 `.cursor/rules/cli-testing.mdc`）

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

### 版本一句话总结

每个版本标题下方、分类列表之前，需要写一段**一句话总结**（1-2 句），概括该版本的核心主题和亮点。总结应聚焦于"这个版本最重要的变化是什么"，而非罗列所有改动。中英文日志均需包含，内容对应。

### 文案要求（强制）

更新日志是给**用户**看的产品说明，不是 commit 摘要，也不是聊天。预览与落盘都写**正常书面语**：完整句子，读起来像人写的发布说明。

- **写用户能感知的变化**：会怎样更好用、修了什么问题。少写模块名、类名、内部机制（`asarUnpack`、`utilityProcess`、`contextLoss`、熔断闩锁等，除非用户设置里真能看见）
- **像正常人说话，不要两种偏**：
  - 不要工程师黑话：`**Embedding worker 初始化失败熔断**` ❌
  - 也不要故意口语、口号腔、网络词：`冲死窗口`、`真能点到了`、`网页也能划一段改` ❌
  - 要平静、具体：`**大量 SSH 输出不再导致窗口卡死**`、`**待办截止日期可以正常选择**`、`**网页划选修改**：在 HTML 预览里划选文字，助手只改这一段` ✅
- **标题短、说明清楚**：`**语音按需安装**：需要时在设置里下载` ✅
- **新功能带出的小修不单列**：例如「按需安装」引入的进度条修缮，写进该新功能条目即可，不要再开一条问题修复刷存在感
- **中英文同一语气**：英文用 plain, professional English，不是中文机翻，也不是 slang
- 预览时用户觉得「太工程」「太口语」「不像正常人说话」，先改文案再继续发版

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

- 英文：`- 📝 **Short title**: what the user gains or what is fixed`
- 中文：与英文一一对应，按上文「文案要求」改写（不是字面翻译，也不是再口语化一层）

### 收集变更条目

用以下命令获取自上次发版 tag 以来的所有提交，作为写日志的素材：

```bash
git log v<当前版本>..HEAD --oneline
```

例如当前版本为 8.19.4：`git log v8.19.4..HEAD --oneline`。

根据提交记录归类到 New Features / Improvements / Bug Fixes，用户也可口述补充。**不编造未发生的改动**。素材来自 commit，**成稿必须符合上文「文案要求」**。

---

## 3. 执行 npm version

`preversion` 钩子带交互式确认（"确认继续? (y/N)"）。**AI 工具调用 / 脚本 / CI / 任何无 TTY 场景必须加 `npm_config_yes=true` 前缀**，否则 preversion 会快速失败（已加 TTY 检测，不再无限期挂起）。

- **AI / 脚本（推荐）**：`npm_config_yes=true npm version patch`（或 `minor` / `major`）
- 仅人工终端：`npm version patch`
- 仅改 `package.json` 不打 tag：追加 `--no-git-tag-version`（跳过钩子）

**preversion**（`scripts/preversion.js`）会：

1. 检查分支为 develop / main / hotfix/*、工作区干净；热修还会检查起点是已发布的版本 tag。
2. `git fetch origin --tags`；有上游则 `git pull --ff-only`（新建热修支无上游会跳过 pull）。
3. 保存当前分支状态（不切换分支，避免 npm 在错误分支上重复 bump）。

> 注意：preversion 不再重复运行验证。完整的代码验证（`npm run verify`）在发版流程步骤 2 已执行，之后只改文档不改代码，无需再跑。

**postversion**（`scripts/postversion.js`）会：

1. 若从 develop 发版：先推送 develop（含版本 commit），再切到 main、合并 develop、推送 main 和 tag，最后切回 develop。
2. 若从 hotfix/* 发版：推送热修支，先合回 develop，再推 tag；main 能快进才更新。
3. 若从 main 发版：直接推送 main 和 tag。

发版前务必已**先提交 CHANGELOG 的修改**，再执行 `npm version`，否则 preversion 会因"工作区不干净"失败。

---

## 快速检查清单

- [ ] 已按「发版节奏」提醒（距上次不足约 7 天且非热修时）；用户确认继续或不适用
- [ ] 中文变更日志已预览并经用户确认；文案符合「文案要求」（用户能看懂，书面语，不装口语）
- [ ] `npm run verify` 通过（类型检查 + lint + 构建 + 单元测试 + CLI 回归，并行执行）
- [ ] `CHANGELOG.md` 与 `CHANGELOG_CN.md` 已更新且版本号、日期、条目一致
- [ ] （minor/major）检查 `README.md`、`README_CN.md` 和 `website/src/i18n/translations.ts` 是否需要同步更新
- [ ] 更新日志及文档变更已提交
- [ ] CI 试打包通过（`gh workflow run build-release.yml --ref <分支>`，Windows 与 macOS 都绿）；或步骤 6 里打包相关文件自上一个成功发出的版本以来没有变化，已向用户写明
- [ ] 当前在 develop、main 或 hotfix/*，无未提交更改；热修须从已发布 tag 拉出
- [ ] 执行 `npm_config_yes=true npm version <patch|minor|major>` 完成发版（热修用 patch；AI / 脚本场景必加前缀）
- [ ] tag 触发的工作流全部通过，`gh release view v<版本>` 能查到 Release
- [ ] （热修）发完确认 develop 已含本次修复和版本号；功能分支 rebase 到最新 develop

---

## OSS 与自动更新布局

tag 推送后 CI 会上传 GitHub Releases + 阿里云 OSS。桶根目录（官网固定文件名）与 `releases/`（应用内更新、带版本号、blockmap 永久保留）**勿混用**。

详见 **[docs/auto-update-oss.md](../../docs/auto-update-oss.md)**。
