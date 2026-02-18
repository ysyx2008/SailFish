---
name: Linux 性能诊断工具箱
description: CPU、内存、磁盘、网络性能排查的系统化流程，覆盖 top/vmstat/iostat/ss/strace 等工具
version: 1.0.0
---

# Linux 性能诊断工具箱

遵循 USE 方法论（Utilization 使用率 / Saturation 饱和度 / Errors 错误）系统化排查。

## 快速总览

```bash
# 一分钟快速诊断（按顺序执行）
uptime                  # 负载趋势
dmesg -T | tail -20     # 内核报错（OOM、硬件）
vmstat 1 5              # CPU/内存/IO 概览
mpstat -P ALL 1 3       # 各 CPU 核使用率
iostat -xz 1 3          # 磁盘 IO
free -h                 # 内存
df -h                   # 磁盘空间
ss -s                   # 网络连接统计
top -bn1 | head -20     # 进程 Top
```

## CPU 诊断

```bash
# 整体负载
uptime                          # load average > CPU 核数 → 过载
nproc                           # CPU 核数

# 实时查看
top                             # 按 1 查看各核，P 按 CPU 排序
htop                            # 更直观（需安装）

# 各核使用率
mpstat -P ALL 1 5

# 进程级 CPU（找出 CPU 大户）
pidstat 1 5

# CPU 被谁占了（采样分析）
perf top                        # 实时热点函数
perf record -g -p <pid> -- sleep 30 && perf report
```

**常见原因**：死循环、正则回溯、GC 风暴、锁竞争。

## 内存诊断

```bash
# 整体
free -h
# buffers/cache 不算真正占用，看 available

# 进程级内存
ps aux --sort=-%mem | head -20
pidstat -r 1 5

# 详细映射
pmap -x <pid>
cat /proc/<pid>/smaps_rollup

# OOM 历史
dmesg -T | grep -i 'oom\|kill'
journalctl -k | grep -i 'oom'
```

**常见原因**：内存泄漏、缓存未限制、JVM 堆配置不合理。

## 磁盘 I/O 诊断

```bash
# 磁盘使用
df -h                           # 空间
df -i                           # inode 使用率
du -sh /var/* | sort -rh | head # 大目录排查

# I/O 性能
iostat -xz 1 5
# 关注：%util > 80% 表示接近饱和，await > 10ms 需关注

# 哪个进程在读写
iotop -oP                       # 实时 IO（需 root）
pidstat -d 1 5                  # 进程 IO 统计

# 查找大文件
find / -xdev -type f -size +100M 2>/dev/null | head -20

# 已删除但未释放的文件
lsof +L1
```

**常见原因**：日志撑满磁盘、大量小文件、swap 抖动。

## 网络诊断

```bash
# 连接统计
ss -s                           # 连接总览
ss -tlnp                        # 监听端口
ss -tnp state established       # 已建立连接

# 网络流量
iftop -i eth0                   # 实时流量（需安装）
nethogs                         # 按进程看流量

# 连通性
ping -c 5 <host>
traceroute <host>               # 路由跟踪
mtr <host>                      # 综合 ping + traceroute
curl -o /dev/null -w "time_total: %{time_total}s\n" http://<url>

# 抓包
tcpdump -i eth0 -nn port 80 -c 100
tcpdump -i eth0 host <ip> -w capture.pcap
```

**常见原因**：连接数耗尽（TIME_WAIT）、DNS 解析慢、带宽饱和。

## 进程级深入诊断

```bash
# 打开的文件/连接
lsof -p <pid>
ls -la /proc/<pid>/fd | wc -l  # 文件描述符数量

# 系统调用跟踪
strace -p <pid> -c              # 统计系统调用耗时
strace -p <pid> -e trace=network -f  # 跟踪网络调用

# 进程树
pstree -p <pid>
```

## 排查流程建议

1. **先看全局**：`uptime` + `vmstat` + `free` + `df` 定位瓶颈类型
2. **锁定资源**：是 CPU / 内存 / 磁盘 / 网络 中的哪一个
3. **找到进程**：`top` / `iotop` / `ss` 找到占用最高的进程
4. **深入分析**：对目标进程用 `strace` / `perf` / `lsof` 分析根因
5. **确认修复**：修改后持续观察指标是否恢复正常
