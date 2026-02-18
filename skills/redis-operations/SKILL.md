---
name: Redis 运维手册
description: Redis 数据操作、持久化配置、主从复制、内存分析、慢日志排查、集群管理
version: 1.0.0
---

# Redis 运维手册

## 连接与基本信息

```bash
redis-cli -h <host> -p <port> -a <password>
redis-cli INFO server       # 版本、运行时间
redis-cli INFO memory       # 内存使用
redis-cli INFO replication  # 主从状态
redis-cli INFO clients      # 客户端连接数
```

## 常用数据操作

```bash
# 键空间
DBSIZE                       # 当前库 key 数量
KEYS pattern                 # 生产环境禁用，用 SCAN 替代
SCAN 0 MATCH "user:*" COUNT 100

# 过期与淘汰
TTL key                      # 剩余过期时间（秒）
EXPIRE key 3600              # 设置过期
PERSIST key                  # 移除过期
```

## 持久化配置

### RDB 快照
```bash
# redis.conf
save 900 1       # 900秒内至少1次写入则快照
save 300 10
save 60 10000
dbfilename dump.rdb
dir /var/lib/redis

# 手动触发（不阻塞）
BGSAVE
LASTSAVE         # 上次快照时间
```

### AOF 日志
```bash
# redis.conf
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec          # 推荐：每秒刷盘，兼顾性能与安全

# AOF 重写（压缩体积）
BGREWRITEAOF
```

**生产建议**：同时开启 RDB + AOF，RDB 用于冷备份，AOF 保证数据安全。

## 内存分析

```bash
INFO memory                          # 总览
MEMORY USAGE key                     # 单个 key 占用字节
redis-cli --bigkeys                  # 扫描大 key
redis-cli --memkeys --memkeys-samples 100  # 内存采样

MEMORY DOCTOR                        # 内存诊断建议
```

**大 key 处理**：
- Hash/Set/ZSet 大于 1 万元素 → 拆分为多个小 key
- String 大于 1MB → 考虑压缩或拆分
- 删除大 key 使用 `UNLINK`（异步删除）而非 `DEL`

## 慢日志排查

```bash
# 配置（单位：微秒，10000 = 10ms）
CONFIG SET slowlog-log-slower-than 10000
CONFIG SET slowlog-max-len 128

# 查看慢日志
SLOWLOG GET 10               # 最近 10 条
SLOWLOG LEN                  # 慢日志条数
SLOWLOG RESET                # 清空
```

## 主从复制

```bash
# 从节点配置
REPLICAOF <master-host> <master-port>
CONFIG SET masterauth <password>

# 查看复制状态
INFO replication
# 关注：role、connected_slaves、master_link_status、master_last_io_seconds_ago
```

## 哨兵模式要点

```bash
# sentinel.conf
sentinel monitor mymaster 127.0.0.1 6379 2
sentinel down-after-milliseconds mymaster 5000
sentinel failover-timeout mymaster 60000

# 查看哨兵状态
redis-cli -p 26379 SENTINEL masters
redis-cli -p 26379 SENTINEL get-master-addr-by-name mymaster
```

## 常见故障排查

| 问题 | 排查方式 |
|------|----------|
| 连接被拒 | 检查 `bind`、`protected-mode`、防火墙、`maxclients` |
| 内存超限 | `INFO memory` → 检查 `maxmemory` 和淘汰策略 `maxmemory-policy` |
| 主从延迟 | `INFO replication` → `master_last_io_seconds_ago`、网络带宽 |
| 响应变慢 | `SLOWLOG GET` + `CLIENT LIST` 检查阻塞命令 |
| 数据丢失 | 确认持久化配置，检查 AOF/RDB 文件完整性 |

## 安全建议

- 设置强密码：`requirepass`
- 禁用危险命令：`rename-command FLUSHALL ""`
- 不要将 Redis 暴露到公网，使用 `bind 127.0.0.1`
- 以非 root 用户运行
