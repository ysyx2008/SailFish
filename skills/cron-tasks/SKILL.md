---
name: Cron 定时任务
description: crontab 表达式语法、常见调度、输出重定向、调试技巧、环境变量
version: "1.0"
---

# Cron 定时任务

编写和调试 cron 任务的最佳实践。

## 表达式语法

```
分  时  日  月  周  命令
0-59 0-23 1-31 1-12 0-7
```

`周`：0 和 7 均为周日；或用 `mon`、`tue` 等名称。

## 常见调度示例

```cron
# 每天 2:00
0 2 * * * /path/to/script.sh

# 每小时
0 * * * * /path/to/script.sh

# 每 5 分钟
*/5 * * * * /path/to/script.sh

# 每周一 9:00
0 9 * * 1 /path/to/script.sh

# 每月 1 号 0:00
0 0 1 * * /path/to/script.sh
```

## 输出重定向

```cron
# 丢弃所有输出
0 2 * * * /path/script.sh > /dev/null 2>&1

# 输出到日志
0 2 * * * /path/script.sh >> /var/log/cron.log 2>&1

# 错误单独记录
0 2 * * * /path/script.sh >> /var/log/out.log 2>> /var/log/err.log
```

## 环境变量

cron 环境极简，不含 `PATH`、`HOME` 等，需显式设置：

```cron
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=admin@example.com

0 2 * * * cd /app && /usr/bin/node script.js
```

或在脚本内：`export PATH=/usr/local/bin:$PATH`。

## 调试技巧

- 先手动执行：`/path/to/script.sh` 确认可用
- 临时改成每分钟跑一次做联调：`* * * * *`
- 日志加时间戳：`echo "$(date): started" >> /var/log/cron.log`
- 查看 cron 日志：`grep CRON /var/log/syslog`（Debian/Ubuntu）或 `journalctl -u crond`
