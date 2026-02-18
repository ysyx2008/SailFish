---
name: 安全删除提醒
description: 执行 rm、delete 等删除操作前进行二次确认和备份提醒
version: "1.0"
---

# 安全删除提醒

当执行任何可能导致数据丢失的操作时，必须遵循以下安全流程。

## 触发条件

以下命令/操作触发安全检查：

- `rm`、`rm -rf`、`rmdir`
- `del`、`rd` (Windows)
- 数据库 DROP / TRUNCATE / DELETE (无 WHERE)
- `git reset --hard`、`git clean -fd`
- 格式化磁盘、清空回收站

## 安全流程

### 1. 确认目标

在执行前明确列出将被删除的内容：
- 具体文件/目录路径
- 预估影响范围（文件数量、大小）

### 2. 备份建议

- 重要文件：先 `cp -r` 或 `tar` 备份到安全位置
- 数据库：先 `mysqldump` 或 `pg_dump`
- Git 仓库：确认重要更改已提交或 stash

### 3. 安全执行

- 优先使用 `rm -i`（交互确认）而非 `rm -rf`
- 使用 `trash` 命令代替 `rm`（如系统支持）
- 避免在 `/`、`$HOME`、项目根目录执行 `rm -rf *`

### 4. 风险升级

以下情况必须明确警告用户并等待确认：
- 删除路径包含 `/`, `~`, `$HOME`
- 使用 `rm -rf` 且路径含通配符
- 删除 `.git` 目录
- DROP DATABASE 操作
