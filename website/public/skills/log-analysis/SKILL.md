---
name: log-analysis
description: 日志分析助手。journalctl 用法、常见日志路径、grep/awk 过滤、tail -f 模式、日志轮转。分析系统或应用日志时使用。
version: 1.0.0
---

# 日志分析助手

## journalctl（systemd）

```bash
journalctl -u nginx -f                    # 实时查看 nginx 日志
journalctl -u nginx --since "1 hour ago"  # 最近 1 小时
journalctl -u nginx --since "2024-01-15" --until "2024-01-16"
journalctl -p err -b                      # 本次启动的错误日志
journalctl -o short-precise                # 精确时间戳
journalctl -n 100 -u docker                # 最近 100 行
```

**持久化**：确保 `/etc/systemd/journald.conf` 中 `Storage=persistent`。

## 常见日志路径

| 类型 | 路径 |
|------|------|
| 系统 | `/var/log/syslog`、`/var/log/messages` |
| 认证 | `/var/log/auth.log` |
| Nginx | `/var/log/nginx/access.log`、`error.log` |
| Apache | `/var/log/apache2/access.log`、`error.log` |
| MySQL | `/var/log/mysql/error.log` |

## grep / awk 过滤

```bash
# 错误行
grep -i error /var/log/syslog

# 时间段（syslog 格式）
grep "Jan 15 14:" /var/log/syslog

# awk 按列过滤（Nginx access.log）
awk '$9 == 500' /var/log/nginx/access.log
awk '$7 ~ /\.php/' /var/log/nginx/access.log
```

## tail -f 模式

```bash
tail -f /var/log/nginx/access.log
tail -f /var/log/syslog | grep --line-buffered ERROR
```

## 日志轮转

配置：`/etc/logrotate.d/` 下各应用配置。  
**手动执行**：`sudo logrotate -f /etc/logrotate.conf`  
**检查配置**：`logrotate -d /etc/logrotate.d/nginx`
