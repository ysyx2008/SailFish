# CLI（无头模式）

> Last verified: 2026-08-21

## 职责

提供无头 Agent / 运维命令入口。开发态与打包态共用命令面（`runCli`）。

## 设计目标

### 开发态不碰真实数据（2026-08-21）

- **问题**：从仓库跑命令行做验证时，任务会写进桌面真实历史，侧栏出现一堆测试对话。
- **成功标准**：从仓库跑的命令行默认写到独立虚拟目录，桌面侧栏看不到这些记录。装好的正式命令仍然跟桌面共用真实数据。
- **关键取舍**：开发默认隔离，只借用模型配置和密钥，不借用历史。要碰真实数据必须显式说。
- **明确不做**：不改桌面 App 自己的数据目录；不把装机后的正式命令改成默认沙箱。

## 入口

| 入口 | 场景 |
|------|------|
| `electron/cli/main.js` | 开发：`npm run sailfish`（`sft`/`cli` 为别名；tsx + electron-shim） |
| `electron/cli/cli.ts` → `dist-electron/cli.js` | 打包：`ELECTRON_RUN_AS_NODE=1 SailFish.app/.../SailFish cli.js` |
| `~/.local/bin/sailfish` | 薄壳（设置页安装或 `npm run install:cli`） |

## 数据

- **从仓库跑**（开发入口 / 开发态薄壳）：默认进虚拟目录，借用桌面的模型配置和密钥
- **装机后的正式命令**：默认与桌面共用真实数据
- **`--sandbox`**：显式进虚拟目录（装机命令要隔离时用）
- **`--share-desktop`**：开发态显式改用桌面真实数据
- 回归测试用一次性临时目录
- Agent 默认 **`--mode relaxed`**；`--free` 跳过确认
- 命令结束后 **`process.exit(0)`**（`main.js` / `cli.ts`）；`agent:run` 另调 `AiService.dispose()` 关掉 keep-alive，避免空转十几秒才退出

## 命令面（摘要）

- `sailfish "任务"` / `--task` / `agent:run` → Agent
- `sailfish companion <消息>` → 以联络身份对话（见下节）
- `models` / `history list` / `watch list` / …
- 冒号内部命令仍可用
- 对外命令名：`SFT_CLI_NAME`（默认 / 薄壳均为 `sailfish`）

## companion 命令（联络）

无头回归联络专属能力（任务管理工具仅对联络注册，普通任务入口测不到）。

- **同一条联络线**：与桌面/IM 共用同一个联络身份与历史，CLI 里说的话桌面联络侧可见、可续。
- **任务值班**：联络回复后，若其创建了后台任务（CLI 无窗口，任务由后端直驱执行），CLI 不立即退出，而是轮询任务直至全部空闲；任务待确认时交互式询问并转达（真实走一遍转述制确认链路），`--mode free` 下自动批准。`--task-wait <秒>` 控制值班上限（默认 600；`0` = 不值班，回复后即退出），超时打印未完成任务后退出。
- **退出前必须冲刷复命事件**：任务完成事件的回流有防抖窗口，进程退出前立即冲刷，避免回流上下文丢失。

装机薄壳见 `electron/services/SHELL_CLI_SPEC.md`。
