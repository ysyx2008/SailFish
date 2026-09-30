# 完整数据备份 / 恢复

> Last verified: 2026-09-30

## 职责

- 将 `userData` 打包为带标记的 `.zip` 备份
- 校验备份包并在启动早期解压到 staging、替换 userData
- 可取消、按字节进度；不阻塞主进程事件循环过久

## 公开 API

见 `data-backup.ts` / `dir-copy.ts`：

| 符号 | 说明 |
|------|------|
| `exportUserData` | 打包到 `target`；先写 `*.sft-partial`，成功后 rename |
| `validateBackupArchive` | 校验 `.zip` 且含根目录 `sfterm-backup.json` |
| `extractBackupToStaging` | 解压到 staging（跳过 data-location 等） |
| `replaceUserDataFromStaging` | 两阶段替换，失败尽量回滚 |
| `requestFullRestore` / `runStartupRestoreIfNeeded` | 在 `bootstrap.ts` |

## 交互约定（IPC）

1. **备份**：另存为 →（必要时覆盖确认）→ 进度/可取消打包 → 成功提示  
   - 关对话框 / 拒绝覆盖：`canceled` + `cancelReason: dialog|overwrite`（前端不 toast）  
   - 打包中取消：`cancelReason: export`（toast + 删 partial）
2. **恢复**：选 zip → **先校验** → 确认（含版本/时间）→ 写 pending → relaunch → 启动早期解压

## 约束

- 备份不包含：数据目录位置指针、恢复用的临时目录，以及浏览器自己的磁盘缓存、代码缓存、着色器缓存和崩溃转储。登录状态和配置仍在
- 某个文件正被占用、读不了：跳过这一份，其余照常打成压缩包。跳过的记在日志里，完成提示里也会说有几个没装进去
- 压缩包不得位于当前 userData 内
- 与数据目录迁移互斥（`pendingMigration`）
- 热备份不保证与正在跑的 Agent 完全一致；前端有运行中提示
- 已压缩/二进制扩展名使用 ZIP STORE（不二次压缩）；文本类始终 DEFLATE
