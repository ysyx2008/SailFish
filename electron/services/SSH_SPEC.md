# SSH Service SPEC

> Last verified: 2026-08-21（断开不能冻住窗口）

## 职责

SSH 远程连接管理。建立、维持多路 SSH 会话，支持跳板机直连和跳板机 Shell 两种级联模式，提供终端 I/O、远程命令执行、终端状态查询、工作目录和进程探测。

## 设计目标（重连身份）

- **对外会话实例 id 在重连时保持不变**：`connect(config, { reuseId })` 卸掉旧连接后，新 ssh2 客户端挂在同一 Map key 上。该 id 即前端/Agent 口中的 `ptyId`（命名历史包袱：SSH 侧并非本机 PTY）。
- **新开连接仍分配新 uuid**；仅「同一窗格重连」传 `reuseId`。
- **重连后调用方负责重绑 I/O**（`ssh:subscribe` / Agent `onData`）——id 不变不会自动把旧回调迁到新实例。
- **旧 client 异步 close/error 不得误伤新实例**：`close`/`error`/`stream close` 须校验 `instances.get(id)?.client === 本 client`（跳板同理校验 `jumpClient`），不匹配则忽略。
- **主动断开必须立刻通知界面**：先从会话表摘掉再收底层连路；旧连路的迟到关闭不得误伤新实例。不通知的话，重连按钮不会出现（含重连半路失败）。

## 设计目标（断开不能冻住窗口，2026-08-21）

- **主动断开必须立刻让窗口恢复响应**：用户或助手说断开之后，界面要马上能点、能停，不能整窗假死。
- **不能干等远端收尾**：对面不回断开确认，也不能把应用卡住；连路在后台收掉即可。

## 设计目标（海量输出不能冻住窗口，2026-09-04）

- **远端刷出大量内容时，窗口必须还能点、还能停**：比如跑很长的脚本、连续倒日志，不能整窗假死、标题栏变成「未响应」。
- **后台可以继续跑，界面可以晚一点跟上**：输出不必逐字实时刷完，但不能把整窗冲死。
- **用户必须随时能打断**：刷屏再快，键盘和按钮也要进得去（比如 Ctrl+C），不能因为刷屏而点不了。

## 设计目标（连接过程可中止，2026-08-20）

- **连接建立期间用户随时可以放弃**：从点下「连接」到握手完成之前，界面必须一直留有可点的退路（标签页上的关闭、连接中页面的取消连接），不能出现「只能转圈干等」的状态。
- **取消必须立即生效**：点了取消，进行中的握手当场掐断，不等连接超时；跳板机级联的两段连接一并掐断。
- **取消不留幽灵连接**：即使取消与连接成功撞在同一瞬间，那条已经建立的连接也必须被收掉，不允许后台留着没人用的会话。
- **取消不算连接失败**：用户主动放弃后不弹连接失败报错，界面就是干净地回到取消前的地方。

## 设计目标（跳板机不让转发时要说清楚，2026-09-25）

- **跳板机不允许端口转发时，必须告诉用户连不上的原因**，不能假装已经连上目标机器。
- **从堡垒机同步来的 JumpServer，以及用户在跳板机配置里标明的 JumpServer，仍走原来的备用连接**（在堡垒机终端里选资产），不要被这条提示打断。
- **手填但没标明的 JumpServer 会看到这条说明**，说明里要告诉用户去勾选，而不是只叫他打开端口转发。

## 设计目标（Agent 连通所有权，2026-07-28）

- Agent / UI 共用同一条 `reconnectSsh` 路径（经 split-pane bridge `reconnect` op），对已保存会话的 SSH 窗格做**原地重连**。
- `hasInstance` 只表示本进程侧实例仍在；列表里的 `connected` 同源，不是远端健康检查。
- 重连成功对 Agent 一律按**新 shell** 告知；不在 service 层自动重试业务命令。

## 文件 / 规模

单文件：`electron/services/ssh.service.ts`（~943 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `async connect(config, options?: { reuseId?: string }): Promise<string>` | 建立 SSH 连接；`reuseId` 时复用该 id | main.ts, CLI, 前端重连 |
| `write(id, data): boolean` | 向终端写入数据 | PtyService |
| `resize(id, cols, rows): void` | 调整终端窗口大小 | PtyService |
| `onData(id, callback): () => void` | 注册终端数据回调，返回取消函数 | PtyService |
| `hasInstance(id): boolean` | 查询 session 是否存活 | tool/ssh |
| `getActiveInstanceCount(): number` | 当前活跃 SSH 会话数（退出确认主进程兜底） | `main.ts` |
| `onDisconnect(id, callback): () => void` | 注册断连回调 | PtyService |
| `disconnect(id): void` | 断开单个会话 | CLI, UI |
| `disposeAll(): void` | 断开所有会话 | 生命周期 |
| `async probe(id, timeout?): Promise<string>` | 执行探测命令（来自 host-profile） | HostProfileService |
| `getConfig(id): SshConfig \| null` | 获取会话原始配置 | UI |
| `executeInTerminal(id, cmd, timeout?): Promise<ExecuteInTerminalResult>` | 在远程终端执行命令并返回结果 | agent/tools |
| `async getTerminalStatus(id): Promise<TerminalStatus>` | 查询终端空闲状态和前/后台进程 | TerminalStateService |
| `async getRemoteCwd(id): Promise<string \| null>` | 获取远程当前工作目录 | TerminalStateService |
| `async getRemoteProcesses(id): Promise<{shellPid?, children[]}>` | 探测远程 Shell 进程树 | TerminalStateService |

## 核心类型 / 接口

```ts
interface TerminalStatus {
  isIdle: boolean; shellPid?: number
  foregroundPid?: number; foregroundProcess?: string
  stateDescription?: string
}
interface SshDisconnectEvent {
  id: string; reason: "closed" | "error" | "stream_closed" | "jump_host_closed"
  error?: Error
}
```

内部类型（不对外暴露）：
```ts
interface SshInstance {
  client: Client; jumpClient?: Client; stream: ClientChannel | null
  dataCallbacks: ((data: string) => void)[]; config: SshConfig; encoding: string
}
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `HostProfileService` | 可选 | `probe()` 获取探测命令模板（`getUnixProbeCommands`） |
| `PtyService` | 可选 | 仅 `ExecuteInTerminalResult` 类型引用 |
| `ssh-error.ts` | 必需 | 错误信息国际化映射 |

## 关键行为 / 数据流

**三种连接模式**：
1. **直连**：SSH→目标主机
2. **跳板机直连**（`directConnect`）：SSH→跳板机→forwardOut→目标主机
3. **跳板机 Shell**（`connectViaJumpServerShell`）：SSH→跳板机→Shell 执行 `ssh` 命令→目标主机

**断连处理**：`on('close')` → 清理 `dataCallbacks` → `emitDisconnect(event)` → 通知所有监听者

**终端探测**：`getTerminalStatus` / `getRemoteCwd` / `getRemoteProcesses` 均通过 `execCommand` 在远程执行 Shell 命令并解析输出

## 关键约束

- **跳板机 Shell 模式不得泄露跳板机密码**——配置中的 `jumpServerPassword` 不出现在日志
- **断连后必须清理回调**——`instances` Map 和 `disconnectCallbacks` Map 同步清理，防止内存泄漏
- **连���超时需有上限**——`connect_config.timeout` 默认可配置，不得无限制等待
