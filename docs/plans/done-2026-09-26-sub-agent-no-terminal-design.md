# 伙计不碰终端窗

> 落盘日期：2026-09-26
> 状态：已完成（2026-09-26）。遗留一个待定取舍见文末。
> 设计目标：`electron/services/agent/SPEC.md`「伙计不碰终端窗（设计目标，2026-09-26）」

## 现状（改之前）

- 伙计开工时拿的是主人 run 上下文的浅拷贝（`spawnDeps.getParentContext` → `{ ...ctx, unattended: true }`），带着主人的 `ptyId` / `panes` / `terminalType` / `systemInfo` / `hostId`。
- 伙计工具清单 = `getAgentTools({ mode: getAgentMode() })` 再过 `filterSubAgentTools`（只看 `allowedForSubAgent`）。
  - 本地终端页派出：`mode=local` → 有 PTY 版 `execute_command` 等整组终端工具，打进主人那扇窗；没有 `exec`（`supportedModes: ['assistant','ssh']`）。
  - 独立助手派出：`mode=assistant` → 终端工具组无条件注入（为主人「先开窗再打命令」），伙计没窗时必然报错。
- `list_workbench_artifacts` / `manage_workbench_artifacts` 按 `executor.agentId` 找面板；伙计的 agentId 是 `<主人>:sub:<名字>`，找不到面板，本来就用不了。
- `exec` 不传 `cwd` 时直接继承主进程目录（打包后 macOS 通常是 `/`），而助手形态的提示词宣称「命令默认执行目录：<context.cwd>」（助手缺省填主目录）。说的与跑的不一致。

## 方案（已落实）

1. **终端工具组标成伙计不能用**：`skills/terminal/tools.ts` 里 `execute_command`、`check_terminal_status`、`get_terminal_context`、`send_control_key`、`send_input` 加 `allowedForSubAgent: false`。`wait` 保留。清单与运行时拦截（`denyIfParentOnly`）都读这一个标记。
2. **伙计上下文收成「无窗的本机助手」**：`tools/sub-agent.ts` 的 `toSubAgentContext(parent)`：
   - `terminalType: 'assistant'`，去掉 `ptyId` / `panes` / `activePaneId` / `mode` / `sshHost` / `workbenchPrompt`，`terminalOutput: []`；
   - `systemInfo` 取本机，`hostId: 'local'`；
   - `cwd`：主人是本地终端页或助手时沿用（都是本机目录）；主人是 SSH 形态时换成主目录。
   - 其余字段照旧带（黑名单式；函数注释要求以后新增窗格/远程字段时在此剥掉）。
3. **产出物面板两件工具标成伙计不能用**：`packages/workbench-assistant/src/agent-tools.ts`。
4. **「本机默认目录」单一出处**（代码审查后加）：`tools/file.ts` 的 `announcedLocalCwd(context)`——助手形态、绝对路径、确实是目录才算。
   - 文件工具相对路径基准：本机终端当前目录 → 宣称的默认目录 → 主目录（`resolveLocalFilePath` 第三参数，四个调用点经 `resolveToolLocalPath`）。
   - `exec` 不传 `cwd`：宣称的默认目录 → 主目录（不再继承主进程目录，SSH 形态也一样落到主目录，与文件工具一致）。
   - 为什么需要：伙计以前带着主人的 ptyId，文件相对路径跟那扇窗的目录走；窗拿掉后若文件工具只认终端，本地终端页的伙计会出现「命令在项目目录、读文件在主目录」的分叉。
5. SPEC「不能给伙计的」清单补上「碰终端窗」「动产出物面板」。

## 任务拆解

- [x] T1 终端工具组 + 产出物面板工具加 `allowedForSubAgent: false`；单测：清单不含这 7 个、仍含 `exec`；运行时拦截单测
- [x] T2 `toSubAgentContext`；单测：本地终端页 / 助手开着远程窗（非主目录 cwd）/ SSH 形态 三种主人上下文
- [x] T3 `announcedLocalCwd` + exec / 文件工具共用；单测：助手形态在宣称目录跑、显式 cwd 优先、SSH 与本地终端形态落主目录、目录不存在或是文件不算
- [x] T4 回归：`bash electron/cli/test-cli.sh --no-ai` 通过；agent + workbench vitest 1818 通过
- [x] T5 端到端（CLI 真实模型）：伙计工具里跟命令相关的只剩 `exec` / `await_exec`；`pwd` 落在宣称的主目录；`exec` 写相对路径文件、`read_file` 相对路径读回一致

端到端没覆盖「从本地终端页派出」（CLI 没有终端页，主人 cwd 就是主目录），这条靠单测，桌面上需人工点一次。

## 待定取舍

- **伙计搜历史 / 搜知识库的范围**：记忆分区按「助手形态一律个人」算。伙计改成助手形态后，从本地终端页派出的伙计主动搜索时，范围从「本机」变成「个人」。伙计的提示词本来就不注入知识文档和历史召回，只影响它主动调搜索工具。待用户定：跟主人一样，还是就按个人。

## 不在本次范围

- 主人自己的终端工具在独立助手没开终端时仍常驻（见想法本）。
- `send_control_key` / `send_input` 的 `supportedModes` 在助手模式不生效（终端组在按模式筛选之后才注入）——随上一条一起看。
- 伙计仍会带上主人这一轮的附件、图片、文档正文、首次联系提醒等（审查指出，改之前就这样）。
