---
name: 网络故障排查
description: DNS 解析、TCP 连接、路由追踪、抓包分析、防火墙排查等网络问题诊断流程
version: 1.0.0
---

# 网络故障排查

## 排查流程

1. **确认症状**：完全不通 or 间歇性 or 慢？
2. **DNS 解析** → 3. **网络连通性** → 4. **端口可达** → 5. **应用层**

## DNS 排查

```bash
# 基础解析
nslookup example.com
dig example.com
dig example.com +short            # 简洁输出
dig @8.8.8.8 example.com          # 指定 DNS 服务器

# 查看系统 DNS 配置
cat /etc/resolv.conf
resolvectl status                 # systemd-resolved

# 清除 DNS 缓存
# systemd-resolved
sudo resolvectl flush-caches
# nscd
sudo nscd -i hosts
# macOS
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

**常见 DNS 问题**：解析超时（DNS 服务器不可达）、解析结果错误（DNS 污染/缓存过期）。

## 网络连通性

```bash
# Ping 测试
ping -c 5 <host>
ping -c 5 -s 1400 <host>         # 大包测试（MTU 问题排查）

# 路由追踪
traceroute <host>                 # UDP 模式
traceroute -T -p 80 <host>       # TCP 模式（防火墙可能阻止 UDP）
mtr <host>                       # 综合工具（持续监测丢包率）
mtr --report --report-cycles 100 <host>  # 生成报告

# 查看路由表
ip route show
ip route get <destination>
```

## 端口可达性

```bash
# TCP 端口连接测试
nc -zv <host> <port>              # netcat
nc -zv <host> 80-443              # 端口范围
telnet <host> <port>              # 旧式方法

# curl 测试（HTTP 层）
curl -v http://<host>:<port>/
curl -o /dev/null -w "HTTP %{http_code} | DNS: %{time_namelookup}s | Connect: %{time_connect}s | Total: %{time_total}s\n" http://<url>

# 本机端口监听
ss -tlnp                         # TCP 监听
ss -ulnp                         # UDP 监听
lsof -i :<port>                  # 哪个进程在监听
```

## 抓包分析

```bash
# tcpdump 常用
tcpdump -i eth0 -nn host <ip>                     # 指定主机
tcpdump -i eth0 -nn port 80                        # 指定端口
tcpdump -i eth0 -nn 'tcp[tcpflags] & tcp-syn != 0' # SYN 包
tcpdump -i eth0 -nn -c 100 -w capture.pcap         # 保存为文件
tcpdump -r capture.pcap                             # 读取文件

# 按协议过滤
tcpdump -i eth0 -nn icmp
tcpdump -i eth0 -nn 'tcp port 443 and host 1.2.3.4'
```

保存的 `.pcap` 文件可以用 Wireshark 打开做详细分析。

## 连接状态分析

```bash
# 连接状态统计
ss -ant | awk '{print $1}' | sort | uniq -c | sort -rn

# TIME_WAIT 过多
ss -ant state time-wait | wc -l
# 优化：sysctl net.ipv4.tcp_tw_reuse=1

# CLOSE_WAIT 过多（通常是应用未正确关闭连接）
ss -antp state close-wait

# 半连接队列（SYN_RECV）
ss -ant state syn-recv | wc -l
```

## 防火墙排查

```bash
# iptables
sudo iptables -L -n -v --line-numbers
sudo iptables -L -n -t nat                       # NAT 表

# firewalld
sudo firewall-cmd --list-all
sudo firewall-cmd --list-ports

# ufw
sudo ufw status verbose

# 临时清空规则验证（谨慎操作！确保有其他访问方式）
sudo iptables -F
```

## 带宽与延迟测试

```bash
# iperf3 带宽测试（需两端安装）
# 服务端
iperf3 -s
# 客户端
iperf3 -c <server-ip> -t 10

# 单向延迟
ping -c 100 <host> | tail -1     # 看 min/avg/max/mdev
```

## 常见问题速查

| 症状 | 可能原因 | 排查 |
|------|----------|------|
| DNS 解析失败 | DNS 服务器不通或被劫持 | `dig @8.8.8.8`、检查 resolv.conf |
| ping 通但端口不通 | 防火墙、服务未启动 | `ss -tlnp`、`iptables -L` |
| 连接超时 | 安全组/防火墙阻挡 | 检查云平台安全组规则 |
| 连接被重置 | 应用崩溃、WAF 拦截 | 抓包看 RST 来源 |
| 间歇性丢包 | 链路质量、带宽饱和 | `mtr --report`、`iftop` |
| 延迟高 | 路由绕行、拥塞 | `traceroute`、不同时间段对比 |
