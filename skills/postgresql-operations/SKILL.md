---
name: PostgreSQL 运维手册
description: PostgreSQL 备份恢复、用户权限、慢查询分析、连接池配置、性能调优
version: 1.0.0
---

# PostgreSQL 运维手册

## 连接与基本信息

```bash
psql -h <host> -U <user> -d <dbname>

# 常用元命令
\l          # 列出数据库
\dt         # 列出表
\du         # 列出用户/角色
\conninfo   # 当前连接信息
\x          # 切换扩展显示
SELECT version();
```

## 备份与恢复

```bash
# 单库备份（自定义格式，支持并行恢复）
pg_dump -U postgres -Fc dbname > backup.dump

# 单库备份（SQL 格式）
pg_dump -U postgres dbname > backup.sql

# 全库备份
pg_dumpall -U postgres > all_databases.sql

# 恢复（自定义格式）
pg_restore -U postgres -d dbname backup.dump

# 恢复（SQL 格式）
psql -U postgres -d dbname < backup.sql

# 并行备份/恢复（加速大库）
pg_dump -U postgres -Fd -j 4 -f backup_dir dbname
pg_restore -U postgres -d dbname -j 4 backup_dir
```

## 用户与权限

```sql
-- 创建用户
CREATE USER appuser WITH PASSWORD 'password';

-- 授权
GRANT CONNECT ON DATABASE dbname TO appuser;
GRANT USAGE ON SCHEMA public TO appuser;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO appuser;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO appuser;

-- 只读用户
CREATE USER readonly WITH PASSWORD 'password';
GRANT CONNECT ON DATABASE dbname TO readonly;
GRANT USAGE ON SCHEMA public TO readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;

-- 查看权限
\du+
SELECT * FROM information_schema.role_table_grants WHERE grantee = 'appuser';
```

## 慢查询分析

```sql
-- 启用 pg_stat_statements（需在 postgresql.conf 中配置）
-- shared_preload_libraries = 'pg_stat_statements'
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 10 慢查询
SELECT query, calls, mean_exec_time, total_exec_time
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;

-- 当前活跃查询
SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY duration DESC;

-- 终止长查询
SELECT pg_terminate_backend(<pid>);
```

**日志中记录慢查询**（`postgresql.conf`）：
```ini
log_min_duration_statement = 1000   # 记录超过 1 秒的查询
log_statement = 'none'              # 避免记录所有查询
```

## 连接管理

```sql
-- 查看连接数
SELECT count(*) FROM pg_stat_activity;
SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname;

-- 最大连接数
SHOW max_connections;

-- 空闲连接
SELECT * FROM pg_stat_activity WHERE state = 'idle' AND query_start < now() - interval '10 minutes';
```

**PgBouncer 连接池**：
```ini
# pgbouncer.ini
[databases]
mydb = host=127.0.0.1 port=5432 dbname=mydb

[pgbouncer]
listen_port = 6432
pool_mode = transaction    # 推荐事务级池化
max_client_conn = 1000
default_pool_size = 20
```

## 关键配置调优

```ini
# postgresql.conf
shared_buffers = '内存的25%'
effective_cache_size = '内存的75%'
work_mem = 64MB
maintenance_work_mem = 512MB
wal_buffers = 64MB
max_connections = 200
```

## 常见故障排查

| 问题 | 排查 |
|------|------|
| 连接数满 | `SELECT count(*) FROM pg_stat_activity;` → 使用连接池 |
| 表膨胀 | `SELECT pg_size_pretty(pg_total_relation_size('tablename'));` → `VACUUM FULL` |
| 锁等待 | `SELECT * FROM pg_locks WHERE NOT granted;` |
| 复制延迟 | `SELECT * FROM pg_stat_replication;` 检查 `replay_lag` |
| 磁盘满 | 清理 WAL：`SELECT pg_switch_wal();`，检查 `pg_wal/` 目录大小 |

## 维护操作

```bash
# VACUUM（回收死行空间）
VACUUM VERBOSE tablename;
VACUUM ANALYZE;          # 同时更新统计信息

# REINDEX（索引膨胀时）
REINDEX INDEX indexname;
REINDEX TABLE tablename;

# 数据库大小
SELECT pg_size_pretty(pg_database_size('dbname'));
```
