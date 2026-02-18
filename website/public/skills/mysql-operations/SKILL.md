---
name: mysql-operations
description: MySQL 运维手册。备份恢复、用户权限、慢查询诊断、常见故障排查。涉及 mysqldump、用户管理、权限、slow query log 时使用。
version: 1.0.0
---

# MySQL 运维手册

## 备份与恢复

**全库备份**：
```bash
mysqldump -u root -p --single-transaction --routines --triggers --all-databases > backup_$(date +%Y%m%d).sql
```

**单库备份**：
```bash
mysqldump -u root -p --single-transaction dbname > dbname_backup.sql
```

**恢复**：
```bash
mysql -u root -p < backup.sql
# 或指定库
mysql -u root -p dbname < dbname_backup.sql
```

## 用户与权限

**创建用户**：
```sql
CREATE USER 'appuser'@'%' IDENTIFIED BY 'password';
GRANT SELECT, INSERT, UPDATE ON dbname.* TO 'appuser'@'%';
FLUSH PRIVILEGES;
```

**查看权限**：`SHOW GRANTS FOR 'user'@'host';`  
**撤销权限**：`REVOKE ALL ON dbname.* FROM 'user'@'host';`

## 慢查询诊断

**开启慢查询日志**（my.cnf）：
```ini
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow.log
long_query_time = 2
```

**分析慢查询**：
```bash
mysqldumpslow -s t -t 10 /var/log/mysql/slow.log   # 按耗时排序 Top 10
pt-query-digest /var/log/mysql/slow.log            # 若已安装 percona-toolkit
```

## 常见故障排查

| 问题 | 排查命令 |
|------|----------|
| 连接数满 | `SHOW STATUS LIKE 'Threads_connected';` |
| 锁等待 | `SHOW ENGINE INNODB STATUS\G` 查看 LATEST DETECTED DEADLOCK |
| 进程列表 | `SHOW FULL PROCESSLIST;` |
| 杀掉长查询 | `KILL <process_id>;` |

**连接失败**：检查 `bind-address`、防火墙、用户 `host` 限制。
