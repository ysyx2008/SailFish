---
name: 防火墙规则管理
description: ufw 基础、iptables 常用规则、firewalld 区域、端口管理、白名单/黑名单模式
version: "1.0"
---

# 防火墙规则管理

Linux 防火墙配置的常用命令和模式。

## UFW 基础

```bash
# 启用/禁用
sudo ufw enable
sudo ufw disable

# 允许/拒绝端口
sudo ufw allow 22/tcp
sudo ufw deny 3306

# 按 IP 允许
sudo ufw allow from 192.168.1.0/24
sudo ufw allow from 10.0.0.5

# 查看状态
sudo ufw status numbered

# 删除规则（按编号）
sudo ufw delete 3
```

## iptables 常用规则

```bash
# 允许 SSH
iptables -A INPUT -p tcp --dport 22 -j ACCEPT

# 允许已建立连接的回包
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

# 限制某 IP 访问
iptables -A INPUT -s 192.168.1.100 -j DROP

# 限速（示例：每秒 10 个新连接）
iptables -A INPUT -p tcp --syn -m limit --limit 10/s -j ACCEPT
```

## Firewalld 区域

```bash
# 查看默认区域和已开放端口
firewall-cmd --list-all

# 开放端口
firewall-cmd --permanent --add-port=8080/tcp

# 添加富规则（白名单 IP）
firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="1.2.3.4" accept'

# 重载
firewall-cmd --reload
```

## 白名单/黑名单模式

| 模式 | 思路 | 示例 |
|------|------|------|
| 白名单 | 默认拒绝，仅放行已知 IP/端口 | `ufw default deny` + `ufw allow from TRUSTED_IP` |
| 黑名单 | 默认允许，仅封禁异常 IP | `ufw default allow` + `ufw deny from BAD_IP` |

生产环境推荐**白名单**，先 `ufw default deny incoming` 再逐条放行。

## 操作前注意

- 远程修改前先放行本机 SSH 端口，避免被锁在外面
- 使用 `--permanent` 或 `iptables-save` 持久化，否则重启丢失
