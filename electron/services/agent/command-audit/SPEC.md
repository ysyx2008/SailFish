# command-audit SPEC

> 命令执行风险审计模块：评估 Agent 要执行的命令是否安全。
> 供 `exec` / `execute_command` 工具调用。

## 设计目标

- **日志和会话历史可以只读**：秘书要能打开应用日志和会话记录，用来回溯对话、排查消息有没有到。不能改、不能删这两处。
- **其余应用数据仍完全不能碰**：凭据、安全规则、配置等照旧读和写都拦。不开放整个数据目录。
- **不做第二套查询口**：已有历史搜索；再放开只读文件访问即可，不为日志另做专用接口。
- **硬墙只拦毁机，不拦改得回来的事**：在根目录或引导分区上改权限、改属主，先问再跑，不直接拒绝。删根、格式化根目录或引导分区、格式化 Windows 系统盘（C:），照旧硬拒。格式化某块数据盘或 U 盘先确认，不硬拒——`/dev/sdX` 看不出哪块是系统盘，不猜；C: 就是系统盘，不跟它们混。
- **用户可以加严硬拒，不能放松内置硬墙**：设置里可以把某条命令标成永远硬拒，也可以把已经认识的命令升成硬拒。删根、格式化系统盘、碰凭据这类内置硬墙关不掉。秘书看不见、也改不了这份名单。
- **硬拒回传原因**：命令被硬拒时，把审计原因原样告诉秘书，只陈述事实，不附加该怎么做。

## 职责

1. **风险分级**：safe / moderate / dangerous / blocked
2. **双通道（AST）**：
   - Unix / Windows cmd 回退：命令经 `@questi0nm4rk/shell-ast` 解析为 AST
   - **Windows PowerShell（默认 shell）**：经官方 `Parser::ParseInput`（`pwsh-extract.ps1`）解析
   - 拆出子命令 + flags + 参数 + 重定向，再走白名单 + 路径分区
3. **路径分区审计**：根据 cwd + 路径所在 zone（free/protected/workspace/outside）调整风险；`resolveCommandPath` 会解开 shell 转义并展开 `~`/`~/`（避免 `~/Desktop` 相对 scratch 误入 free）
4. **Fail-Closed**：解析失败 / 未知命令按 `executionMode` + 用户可配 `commandRiskPolicy` 选档（默认 strict→dangerous、relaxed/free→moderate）；写操作动态路径 -> dangerous

## 模块结构

```
command-audit/
├── types.ts              # AuditedCall / AuditContext / CallRiskAssessment
├── whitelist.ts          # CommandRule + splitArgv + normalizeFlags + 内置白名单
├── user-command-rules.ts # 用户追加命令规则（持久化）
├── resolve-argv-rule.ts  # getArgvCommandRule：内置优先，其次用户规则
├── indirection-guard.ts  # 间接执行守卫（命中 -> dangerous）
├── assess-call.ts        # 单条 AuditedCall 评估（guard -> 规则 -> 路径分区）
├── assess-shell.ts       # 审计入口 + defaultAuditContext
├── extract-calls.ts      # bash shell-ast 解析 + unwrap（bash -c 递归）
├── extract-pwsh-calls.ts # PowerShell 官方 AST 提取（Windows 默认 shell）
├── pwsh-extract.ps1      # Parser::ParseInput 子进程脚本
├── confirm-policy.ts     # isHardBlocked + riskNeedsConfirm（blocked 硬拒；strict 全确认）
├── fail-closed-policy.ts # 解析失败 / 未知命令 按 mode+policy 选档
├── workspace-guard.ts    # 路径分区 zone 计算 + 系统路径黑名单
├── risk-level.ts         # maxRisk 聚合
└── __tests__/            # 单元测试
```

## 数据流

```
   shell 命令字符串
        │
        ▼
 ┌──────┴──────┐
 │ Win PS 默认? │
 └──────┬──────┘
   yes  │  no
        ▼       ▼
 extractPwsh   extractAuditedCalls (shell-ast)
   AuditedCalls
        │
        ▼
  assessAuditedCall
        │
        ▼
 ① indirection-guard   ← 命中标 dangerous（非 blocked）
        │
        ▼
 ② getArgvCommandRule  ← 内置 ARGV + 用户命令规则
        │
        ┌──────┴──────┐
        │ 无 rule     │ 有 rule
        ▼             ▼
   assessUnknownCall  assessCommandFlags -> 路径分区
        │             │
        └──────┬──────┘
               ▼
        CallRiskAssessment (level + reasons + pathZones)
               │
               ▼
        ③ 路径守卫（workspace-guard）
               │
               ┌──────┬──────┴──────┐
               │      │             │
               ▼      ▼             ▼
        userData   critical       hardened/其他
        禁区       系统路径
        (读+写)    (写)          
           │        │             │
           ▼        ▼             ▼
        blocked  blocked    dangerous/safe/...
```

## 核心不变量

### 1. 命令拦截是"安全性补充"，主防线是 executionMode

- 真正高风险场景 -> 用户切 strict（全确认）
- 日常使用 -> relaxed（危险命令确认）
- 信任 AI 自主 -> free（自担风险）

guard 把"确实危险的间接执行模式"鉴别出来标 dangerous，让 strict/relaxed 弹确认时理由清楚。**free 模式照常放行**--用户既然选了信任，不该由 guard 越俎代庖硬拦。

### 2. blocked 级别只留给不可逆伤害

`blocked` 表示"绝对禁止"，不受执行模式影响。触发条件：
- **删除或覆写** critical 系统路径（`/`、`/boot`）——不可逆系统灾难
- 访问 **userData 禁区**（凭据等安全文件读+写都拦；日志和会话历史只允许读）

在 critical 路径上**只改权限或属主**不是毁机：改得回来，标危险（先确认），不硬拒。
写 **hardened 系统路径**（`/etc`、`/dev`、`/sys` 等）仍标危险（弹确认放行）。间接执行也标危险，不标 blocked。

### 3. 自由区降级只认「静态可证」的绝对路径（写/删）

审计**不模拟 shell 的 cwd 语义**（`cd && …`、子 shell、PTY 实际所在目录都无法静态证明），
因此写/删操作降级为 safe（免确认）的前提是：路径**词法上是绝对路径**（`/…`、`~/…`、
Windows 盘符/UNC），且 resolve 后落在自由区。**相对路径的写/删一律不降级**，按「outside」
处理、保持命令基线（`rm` → dangerous → relaxed 弹确认）。

背景：曾出现 `cd ~/Desktop && rm foo.txt` 被按审计默认 cwd（scratch）解析成自由区、
宽松模式免确认删掉桌面文件。跟踪 `cd` 是补丁式方案（子 shell、`bash -c`、变量仍会漏），
Fail-Closed 的「只认绝对路径」才是可靠不变量。

代价（已接受）：Agent 想在 scratch 免确认，必须写绝对路径；system prompt 已同步此约定。
升级方向的检查（userData 禁区 / critical / hardened / protected / workspace）不受影响，
仍按 cwd 尽力解析——解析错了顶多少升级，不会少确认。

### 4. normalizeFlags 只拆合并短 flag

`normalizeFlags` 只拆长度 ≤ 4 的短 flag 合并（`-rf` -> `-r -f` + 保留原 `-rf`），保留 `-print`/`-exec`/`-delete` 等多字母长 flag 不被误拆。`assessCommandFlags` 对未知 flag 回退检查"是否由已知单字符 flag 组合而成"（`-lart` 不误报）。

## 风险等级

| 等级 | 含义 | strict | relaxed | free |
|---|---|---|---|---|
| safe | 只读，工作区内 | 确认 | 放行 | 放行 |
| dangerous | 高危：不可逆破坏/提权/关机/防火墙/账户（dd/mkfs/sudo/reboot/iptables/userdel 等）/ 写 hardened 系统路径 / 在 / 或 /boot 上改权限或属主 / 解析失败与未知命令（strict 默认） | 确认 | 确认 | 放行 |
| moderate | 写 protected 或 workspace 内 / 未知命令（relaxed 默认）/ 轻度写（mv/touch/chmod 普通路径）/ 日常运维（pip/brew/docker/kill/systemctl/mount/crontab 等） | 确认 | 放行 | 放行 |
| **blocked** | 删除或覆写 critical 系统路径（/ /boot），或碰 userData 禁区（含改/删日志和会话历史） | **拒绝** | **拒绝** | **拒绝** |

注意：blocked 是硬墙（不可逆伤害），dangerous 是风险标记（先确认）。在根目录改权限不算毁机。

### Fail-Closed 兜底（解析失败 / 未知命令 / 间接执行 / 动态路径）

| 场景 | strict 默认 | relaxed / free 默认 | 可配置？ |
|---|---|---|---|
| AST 解析抛错 / 无可审计子命令 | dangerous | moderate | 是 |
| 白名单未命中 | dangerous | moderate | 是 |
| 间接执行（node -e / python -c 等） | dangerous | moderate | 是 |
| 动态路径（写命令） | dangerous | moderate* | 是 |

\* 高危命令（`baseLevel=dangerous`，如 rm）动态路径保底 dangerous，策略只能升级不能降级。

其它开关（同属 `CommandRiskPolicy`）：
- `relaxedConfirmModerate`：宽松模式是否也确认 moderate（默认 false）
- `outsideWritesUpgrade`：工作区外 safe 写是否升 moderate（默认 false）
- `extraFreeDirs`：额外自由区绝对路径列表
- `subAgentBlockDangerous`：额外禁止伙计做高风险（默认不禁止；不禁止时跟主人同一道门。硬墙仍拦）

用户可在「设置 → 安全与权限 → 风险策略」修改；`AuditContext` 经 `auditContextFromConfig` 注入。

### 系统路径分级（仅对写操作生效）

| severity | 路径 | 删除/覆写 | 改权限或属主 | 说明 |
|---|---|---|---|---|
| critical | `/`、`/boot` | blocked | dangerous | 删根、格式化这两处仍硬拒；Windows 格式化 C: 仍硬拒；格式化其它盘符或 `/dev/sdX` 先确认；改权限或属主先问再跑 |
| hardened | `/etc`、`/dev`、`/sys`、`/proc`、`/System`、`/Library`、`/root` 等 | dangerous | dangerous | 有风险但可恢复，或存在合法操作（如往设备里烧录） |

**黑洞设备豁免**：`/dev/null`、`/dev/stdout`、`/dev/stderr` 作为写重定向目标时直接判 safe（写它们等于丢弃或重定向输出）。命令参数中的 `/dev/null` 不受此豁免影响。

**userData 禁区**：userData 下默认读+写都 blocked（保护凭据、安全规则等）。例外：工作区与技能目录可读写；日志和会话历史只允许读，改或删仍 blocked。

## 依赖

- `@shared/types/agent` -- RiskLevel / ExecutionMode
- `@questi0nm4rk/shell-ast` -- bash 通道 AST 解析（含 unwrap bash -c）
- PowerShell `System.Management.Automation.Language.Parser` -- Windows 默认 shell AST（`pwsh-extract.ps1`）
- `../tools/file` -- getScratchPath / getWorkspacePath

## 测试

```bash
npx vitest run electron/services/agent/command-audit/__tests__/
```

覆盖：
- 白名单匹配（safe/moderate/dangerous）
- 用户命令规则追加 / 内置冲突拒绝 / 合并查找
- 路径分区（free/protected/workspace/outside/system）
- indirection-guard（解释器内联 / 包装器 / 调度器 / 结构性 flag）
- shell 通道 unwrap + 递归审计
- confirm-policy：`blocked` 硬拒绝（`isHardBlocked`）；其余由 `riskNeedsConfirm` — strict 全确认；relaxed 确认 dangerous；free 不确认

## 变更历史

- 2026-08-26：用户命令规则可标硬拒，并可把内置命令升成硬拒（不能放松内置硬墙）；格式化某块盘（`/dev/sdX`、非 C: 盘符）改为危险（先确认），格式化根目录、引导分区或 Windows 系统盘 C: 仍硬拒；硬拒回传审计原因；在 `/`、`/boot` 上改权限或属主改为危险
- 2026-07-18：自由区降级只认词法绝对路径（不变量 3）。相对路径写/删不再按审计 cwd 解析进 free，修复 `cd ~/Desktop && rm foo.txt` 在宽松模式免确认删除工作区外文件
- 2026-07-14：`resolveCommandPath` 展开 `~`/`~/`，修复宽松模式下 `rm ~/…` 误判 free/safe 不弹确认
- 2026-07-13：明确 blocked 不走确认弹窗（硬拒绝）；`riskNeedsConfirm('blocked')` 恒 false，新增 `isHardBlocked`
- 2026-07-13：`riskNeedsConfirm` 修正为 strict 含 safe 全确认（与产品「严格=全确认」一致）；`commandNeedsConfirm` 完全委托
- 2026-07-13：抽出 `riskNeedsConfirm`，文件/Office/邮件/日历/SFTP/技能安装/插件审批统一按 riskLevel × executionMode 决定是否弹窗；命令路径仍用 `commandNeedsConfirm`（strict 含 safe）
- 2026-07-12：Windows 默认 PowerShell 走官方 AST（`extract-pwsh-calls.ts` + `pwsh-extract.ps1`），复用白名单 + 路径分区；新增 cmdlet 规则；cmd 回退仍用 regex
- 2026-07-12：系统临时目录（/tmp、os.tmpdir 等）纳入自由区；确认原因区分「高危命令」与「工作区外升档」；outside 不再误标「需确认」
- 2026-07-12：扩展 ARGV 清单并分档——高危仅保留不可逆/提权/关机/防火墙/账户；chmod/mount/crontab/包管理/容器/kill/systemctl 等为 moderate（写系统路径仍由路径守卫升级）。`assessCommandFlags` 未知 flag 不得低于 baseLevel；indirection 命中且 ARGV 为 dangerous 时保底 dangerous（sudo 在 relaxed 下也确认）
- 2026-07-12：用户命令规则（`user-command-rules.ts`）：可追加未收录命令的 CommandRule；`getArgvCommandRule` 内置优先再查用户表
- 2026-07-12：确认弹窗「加入规则并允许」（`trust-command-offer.ts`）：未知单命令 → `PendingConfirmation.trustCommandOffer`
- 2026-07-12：扩展 CommandRiskPolicy（间接执行/动态路径档位、relaxedConfirmModerate、outsideWritesUpgrade、extraFreeDirs、subAgentBlockDangerous）；授权清单支持手动添加
- 2026-07-12：Fail-Closed 按 executionMode 分档。解析失败 / 未知命令默认 strict→dangerous、relaxed/free→moderate；新增 `CommandRiskPolicy`（配置可改）+ `fail-closed-policy.ts`；设置页「风险策略」可编辑四档
- 2026-07-09：系统路径分级。引入 `severity: critical | hardened` 字段，`/`、`/boot` 保持 blocked（critical），`/etc`、`/dev`、`/sys` 等降为 dangerous（hardened，弹确认放行）。新增 `DEV_NULL_EXEMPTIONS` 豁免 `/dev/null`、`/dev/stdout`、`/dev/stderr`（写重定向到黑洞设备直接 safe）。修复只读命令带写重定向时命令参数被误判为写路径的 bug（`find /tmp 2>/dev/null` 不再被拦）。修复 `whitelist.ts` 重复 `env` key 警告
- 2026-07-09：收口为单通道（AST）。砍掉 argv 通道入口（`assess-argv.ts` / `exec_argv` 工具 / `spawnArgv`），`defaultAuditContext` 移至 `assess-shell.ts`。理由：shell 通道已 AST 化，审计精度与 argv 通道趋同；Agent 场景无不可信输入注入，`shell:false` 的注入面优势不成立；双工具增加 AI 选择负担且 shell 通道是 bug 温床
- 2026-07-07：新增 indirection-guard，修 node -e / python -c / env bash -c 漏洞
- 2026-07-07：guard 返回值从 blocked 调整为 dangerous（命令拦截是安全性补充，
  主防线是 executionMode；blocked 只留给路径守卫）
