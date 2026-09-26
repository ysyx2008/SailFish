# 编程技能：检查点瘦身（2026-09-27）

状态：已完成（2026-09-27）

## 1. 背景

检查点是 `{userData}/coding/checkpoints/<项目路径哈希>/` 下的影子 git 仓库。每轮只多存改动，但打开项目那一个要整份存一遍（旗鱼仓库实测 74MB、2.3 秒），每个打开过的项目各一份，且从不回收。

用户确认的三条（2026-09-27）：
1. git 项目借读项目自己 git 里已有的内容；SPEC 承诺从「不碰项目的 git」改为「不改」。
2. 检查点只留 7 天；项目没了或 30 天没打开，整份清掉。
3. 单个超过 20MB 的文件不进检查点，并说明。

## 2. 实测依据

| | 首个检查点 | 用时 |
|---|---|---|
| 现状（整份另存） | 74MB | 2293ms |
| 借读（alternates 指向项目 objects） | 332KB | 266ms |

- 借读后连目录结构（tree）都来自项目仓库。项目 `.git` 挪走后，下一次 `commit` 直接失败（`bad tree object HEAD`），旧检查点也缺对象。所以必须检测借读来源变化，并核对完整性。
- 回收旧检查点：写 `shallow` 文件截断历史（保留的提交 id 不变），再 `reflog expire --expire=now --all` 加 `gc --prune`。实测 1761KB 降到 587KB，`fsck` 通过。不清 reflog 时 gc 什么都不回收。

## 3. 方案

### 3.1 借读（`CheckpointStore`）
- 每次留检查点前 `ensureIntact(kind === 'open')`：在项目目录跑 `git rev-parse --git-common-dir`，拼出 `objects`，和影子仓库 `objects/info/alternates` 比。
- **没查到不等于没了**（审查修订）：`rev-parse` 失败时，只有项目目录还在、原借读目录 `ENOENT` 才算来源没了；否则 alternates 不动，记 `verifiable=false`，这一轮不做任何基于完整性的重来（借读目录读不了时内容看起来也像缺了）。
- 来源变了（含从有到无）就写新的；`kind === 'open'` 时即使没变也整体核对（同路径内容被 gc 清掉只有这样才发现；旗鱼仓库 21 个检查点实测 79ms）。影子仓库有引用时核对：先 `rev-parse --verify` 取 oid 再 `cat-file -e`（退出 1 = 提交本身缺），再流式扫 `rev-list --objects --no-object-names --missing=print`（`GitCli.findLine`，不整份攒输出）。缺就整库重建（保留 alternates 和大文件表），结果带 `restarted: true`。
- 留检查点失败时（且来源确认过）也核对一次：缺对象就重建后重试一次（按结构判断，不看报错文字）。
- 退回前 `plan()` 先核对目标提交（`--no-walk`），缺对象抛 `CheckpointError('incomplete')`；准备/执行退回时碰上重来抛 `CheckpointError('restarted')`。这一步还没动任何文件。

### 3.2 大文件
- 每次 `add` 前：候选 = `ls-files -o --exclude-standard` + `ls-files -m` + 上次的大文件表。逐个 `lstat`，超过 20MB 的先 `rm --cached --ignore-unmatch`（失败这一轮不留、表不更新，下轮再移），再记进 `sailfish-large-files`（NUL 分隔）并生成影子仓库的 `info/exclude`（`/` 开头，转义通配符）。
- 每个检查点的提交信息正文记 `{"largeFiles":[…]}`（`-F` + `--cleanup=verbatim`）。`plan()` 的跳过集 = 现在的大文件 ∪ 目标当时的大文件——后者防止「当时太大没收、后来变小」的文件被当成新建删掉（审查修订）。
- `SnapshotResult` 带 `largeFiles`（全部）和 `newLargeFiles`（这次新出现的）。`RestorePlan.largeFiles` = 现在的大文件 ∪ 这次因目标当时太大而跳过的；确认框参数也带上。
- 呈现：打开项目的「撤回」段列全部；一轮开始时新出现的，挂在这一轮第一个工具结果后面（沿用漏拍提示那条通道）；撤回结果里列全部。

### 3.3 回收
- `CheckpointStore.prune(now)`：保留 `createdAt >= now - 7 天` 的提交，全都更旧就只留最新一个。写 `shallow` 文件，清 reflog，`gc --quiet --prune=1.hour.ago`（留一小时余量，防另一个进程刚写的对象被删）。
- 每次留检查点时写 `sailfish-last-used`（时间戳）。
- `CheckpointJanitor`（新文件）遍历基础目录：
  - 读 `sailfish-project`：`sailfish-last-used` 超过 30 天整库删；项目目录不存在**且**超过 7 天没用也整库删（外置盘没插不能一找不到就删；7 天前的检查点本来也不留）。判断和删除都在 `cleanup()` 的排队里做。
  - 否则执行 `prune`；`gc` 失败不报 `pruned`。
  - 用 `.last-cleanup` 节流，一天最多一次；跑完才盖章。
- 触发：`CheckpointKeeper.take()` 时后台 fire-and-forget（每进程一次）。技能关掉之后不再触发，下次用时补清（已知限制）。

## 4. 任务拆解

| # | 任务 | 验收 | 状态 |
|---|---|---|---|
| 1 | SPEC 设计目标 + 本方案 | 用户已确认三条 | ✅ |
| 2 | 借读 + 完整性核对 + 重建 | 单测：借读后本库几乎不存对象、退回正确；项目 `.git` 挪走后重建并说明；目标缺对象时退回拒绝且不动文件；一时读不到不作废；同路径内容被清、打开时发现；自己的提交丢了能自愈；退回路上重来明说 | ✅ |
| 3 | 大文件不进检查点 | 单测：21MB 文件不进快照、撤回不删它、结果列出；缩小后重新纳入；当时大后来小的撤回不删 | ✅ |
| 4 | 回收（prune + janitor） | 单测：7 天前的检查点回收，保留的 id 不变；30 天没用 / 找不到且 7 天没用整库删；刚找不到的留着 | ✅ |
| 5 | 端到端 + 审查 + 文档 | 旗鱼仓库真实跑：首个检查点 74MB/2.3s → 528KB/0.34s，每轮 ~50ms，撤回正确、项目 git 不变；过宽限期后回收实测 1.8MB → 0.3MB；claude-review 两轮 | ✅ |

## 5. 已知限制

- 清理只在用到编程技能（留检查点）时触发；技能一直关着就不清。
- git 可能会刷新项目 `.git` 里被借读对象的修改时间（内容不变），效果是项目自己的 gc 晚一点回收它们。
- 排队只在一个进程内有效：桌面和命令行共用数据目录、同时开同一个项目时，没有跨进程锁（回收对象留了一小时宽限，整份删只发生在 7/30 天没用的仓库上）。
- 打开项目时整体核对发现缺内容，整份作废，不挑出完好的留着（SPEC 已写明取舍）。
- 项目用 git-lfs 等过滤器时，影子仓库会跑同样的过滤器（改造之前就这样，本次未处理）。
