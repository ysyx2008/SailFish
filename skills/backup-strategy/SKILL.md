---
name: 备份策略指南
description: 3-2-1 备份规则、rsync 用法、数据库备份脚本、cron 自动化、恢复验证的最佳实践
version: "1.0"
---

# 备份策略指南

配置数据备份时的规则、命令和验证方法。

## 3-2-1 备份规则

- **3** 份副本：原始数据 + 2 份备份
- **2** 种介质：如本机磁盘 + 外部存储/云
- **1** 份异地：至少一份在物理位置以外

## Rsync 常用命令

```bash
# 增量同步（保留权限、排除缓存）
rsync -avz --progress --exclude='node_modules' --exclude='.git' \
  /source/ /backup/

# 远程同步
rsync -avz -e ssh user@host:/path/ ./local-backup/

# 差异备份（仅传输增量，支持断点续传）
rsync -avz --partial --progress src/ dest/
```

## 数据库备份脚本示例

```bash
# MySQL
mysqldump -u user -p --single-transaction --routines dbname > backup_$(date +%Y%m%d).sql

# PostgreSQL
pg_dump -U user -Fc dbname > backup_$(date +%Y%m%d).dump
```

## Cron 自动化

```bash
# 每日凌晨 2 点备份
0 2 * * * /path/to/backup-script.sh >> /var/log/backup.log 2>&1

# 每周日凌晨全量备份
0 3 * * 0 /path/to/full-backup.sh
```

## 恢复验证清单

- [ ] 定期（如每季度）执行一次**恢复演练**
- [ ] 验证恢复后的数据完整性（checksum、抽样检查）
- [ ] 记录恢复耗时，确保 RTO 满足要求
- [ ] 备份日志轮转，避免占满磁盘：`logrotate` 或定期 `rm` 旧日志
