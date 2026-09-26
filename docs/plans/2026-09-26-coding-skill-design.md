# 编程技能方案

> 落盘日期：2026-09-26
> 状态：未完成
> 来源：`docs/ideas.md`「专门的『编程』工作台」；替代同日的 `2026-09-26-coding-workbench-design.md`（工作台形态暂缓）。
> 分支：`feat/coding-skill`（worktree `~/.cursor/worktrees/coding-skill/SFTerminal`）

## 1. 已对齐的设计目标（开工前写进 SPEC）

- 编码是高级能力：做成**默认关闭的内置技能**。一般用户看不见、用不上；高级用户在设置里自己打开。像人要编程就开 IDE——秘书要编程时把这份技能拿起来，平时的对话里一件编程工具都没有。
- 定位：让秘书更好地接手不太复杂的编程活，不是做 IDE，也不是去指挥 Cursor / Claude Code。
- 初版像 Claude Code：靠搜索、读、改、跑命令。**不做**类浏览器 / 结构索引、专门的自检工具、专门的 git 工具、改动对比界面。
- git 用现有跑命令；推送、丢活类命令该问人——那是命令审计的事，另记在想法本，不在本方案里修。
- 改完自动查语法：只报这次改动**新引入**的语法错误，不拦修改，只提示「可能有」。
- 搜索程序（约 6MB）直接打进安装包；语法解析器（约 17MB）也直接打包。
- 第一版只做本机项目。

## 2. 新增工具（前缀 `code_`，走现有技能工具路由）

| 工具 | 做什么 |
|---|---|
| `code_open_project` | 指定这场的项目目录。之后本机文件工具的相对路径、`exec` 的默认工作目录都以它为准。返回：目录骨架（浅层、认忽略规则）、git 分支与改动概况、识别到的语言 / 检查 / 测试命令、项目开发约定（`AGENTS.md`、`CLAUDE.md`、`.cursor/rules` 下总是生效的规则、`.github/copilot-instructions.md`），有预算上限 |
| `code_search` | 项目内按内容搜：正则 / 原文、大小写、按 glob 或文件类型筛、上下文行、`content` / `files` / `count` 三种输出、结果上限 |
| `code_find_files` | 按 glob 找文件，认忽略规则，按修改时间倒序，有上限 |
| `code_multi_edit` | 一个文件里多处查找替换，按顺序应用在内存里，全部唯一匹配才落盘，否则整次不改；新文件用 `write_text_file` |
| `code_rewind` | `list` 列出这场的检查点；`restore` 把项目退回某一轮开始前（默认上一轮）。退回前先给当前状态再拍一张，退回本身也能撤 |

改后语法检查不是独立工具：`edit_file` / `write_text_file` / `code_multi_edit` 成功后，结果里追加「这次可能引入的语法错误」。

## 3. 技能系统的通用补丁（不写死 coding）

| 补丁 | 做法 |
|---|---|
| 默认关闭 | `Skill.defaultEnabled?: false`；配置加 `enabledOptInSkills: string[]`。新建 `BuiltinSkillEnablement`（skills/ 下）统一回答「这个内置技能开着吗」，替换现在散在 `tools.ts` / `misc.ts` / `agent.ts` / `main.ts` 的 `disabledBuiltinSkills` 判断 |
| 工作目录 | `Skill.workingDirectory?(state)`；`SkillSession.getWorkingDirectory()`。`resolveLocalFilePath` 加可选基准参数，`file.ts` 调用点和 `exec` 默认 cwd 用它 |
| 每轮开始 | `Skill.onRunStart?(ctx)`；Agent 每次 run 开始时对已加载技能调用（给检查点拍快照） |
| 包住工具调用 | `Skill.wrapToolCall?(call, proceed, ctx)`；`executeTool` 把分派包进已加载技能的中间件链（先加载的在外层）。语法检查要在改前读一次原文、改后再比，单纯的「结果补充」拿不到改前内容，所以做成包裹式 |
| 子 agent 继承 | `Skill.inheritToSubAgents?: true`；`spawnChild` 时把主人已加载的这类技能连同状态数据一起装给伙计 |

技能状态（项目根、检查点列表）放 `SkillSession.setSkillData('coding', …)`。重开对话时技能会自动装回，但状态不持久化：工具发现没打开项目，就提示先 `code_open_project`（模型从历史里知道路径）。

## 4. 模块（`electron/services/agent/skills/coding/`）

| 文件 | 职责 |
|---|---|
| `index.ts` | Skill 定义 + 注册；挂上 §3 的几个钩子 |
| `tools.ts` | 工具定义 + 说明书（技能 content） |
| `executor.ts` | `code_*` 路由 |
| `project.ts` | `CodingProject`：根目录校验、骨架、约定文件、命令识别 |
| `ripgrep.ts` | `Ripgrep`：定位二进制（打包 → 开发态资源目录 → 系统 PATH），跑搜索、解析 `--json` 输出 |
| `syntax-checker.ts` | `SyntaxChecker`：web-tree-sitter 懒加载，按扩展名选语法，改前改后各解析一次，只报新增的错误节点 |
| `checkpoint.ts` | `CheckpointStore`：影子 git（`userData/coding/checkpoints/<项目哈希>/`，`--git-dir` + `--work-tree`，不碰用户 `.git`） |
| `SPEC.md` | 设计目标 + 行为契约 |

### 4.1 搜索程序打包

- `scripts/download-ripgrep.js`：按平台 + 架构从 ripgrep 官方 Release 下载到 `resources/ripgrep/<platform>-<arch>/`（mac x64 / arm64、win x64，开发机当前架构）。进 `build` / `build:mac` / `build:win` 脚本。
- `electron-builder.yml` 的 `extraResources` 用 `${os}-${arch}` 取对应那份。
- 缺二进制时退到系统 PATH 上的 `rg`；都没有就明确报错，不静默换实现。

### 4.2 语法解析器

- 依赖 `web-tree-sitter@0.25.10` + `tree-sitter-wasms@0.1.13`（CodeGraph 1.2.0 同款组合，已验证兼容）。
- 只带十种：JavaScript、TypeScript、TSX、Python、Go、Java、C#、C、C++、Rust（约 16MB）+ 底座约 1MB。其他扩展名不查。
- wasm 放 asar 外（`extraResources` 或 `asarUnpack`），开发态直接读 `node_modules`。
- 解析在主进程做：单文件毫秒级，只在改完那一下跑；大于 1MB 的文件跳过。若实测卡主线程再挪 utilityProcess。
- 只报「改后有、改前没有」的错误（按错误节点附近的文本比较，不按行号——行号会随改动整体偏移）。

### 4.3 检查点

- 打开项目时，以及之后每轮开始时：`add -A` + `commit --allow-empty`。项目自己的 `.gitignore` 照样生效，嵌套仓库不深入。
- 用 `-c core.hooksPath=` 空、`commit.gpgsign=false`、本地 user 名，不受用户全局 git 配置影响。
- 没有 git（mac 上先用 `xcode-select -p` 判断，避免弹出安装命令行工具的对话框）→ 撤回不可用，打开项目时说明。
- 单次快照超过 30 秒放弃这一轮的快照并说明。
- 退回：先拍当前 → `read-tree` + `checkout-index` 到目标 → 删掉「当前快照里有、目标里没有」的文件。只动快照里有记录的文件，被忽略的不动。
- 退回是覆盖文件：按现有确认规则走（宽松模式也问）。

## 5. 不做

- 类浏览器 / 结构索引 / LSP；专门的检查、测试、git 工具；改动对比界面；远程项目；编程工作台界面。
- 不改命令审计（相对路径、git 规则都另记在想法本）。

## 6. 任务拆解

| # | 任务 | 验收 |
|---|---|---|
| 0 | SPEC：agent/SPEC.md 加「编程技能」设计目标；新建 `skills/coding/SPEC.md` | 用户已在对话里确认方向 |
| 1 | 默认关闭的内置技能 | 单测：opt-in 技能默认不进目录、load 被拒；打开后可用；老配置不受影响 |
| 2 | 技能通用钩子（工作目录 / 每轮开始 / 结果补充 / 子 agent 继承） | 单测：钩子被调用；无技能时行为不变 |
| 3 | coding 骨架 + `code_open_project` + 说明书 | 单测：骨架、约定文件、命令识别；打开后相对路径落到项目根 |
| 4 | 搜索（ripgrep 下载脚本 + 打包配置 + `code_search` / `code_find_files`） | 在本仓库搜；忽略规则生效；上限截断 |
| 5 | `code_multi_edit` + 改后语法检查 | 单测：部分不匹配整次不改；新增语法错误被报、原有错误不报 |
| 6 | 检查点 + `code_rewind` | 端到端：改文件 + 用命令新建文件后退回，与改前一致；用户 `.git` 无变化 |
| 7 | 回归 + CLI 端到端（打开编程技能、在临时项目里改一个小 bug） + claude-review | 测试全绿；日志无异常 |
