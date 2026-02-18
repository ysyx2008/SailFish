---
name: ssh-security
description: SSH 安全加固。密钥认证、禁用密码登录、修改端口、fail2ban、authorized_keys 管理。涉及 SSH 安全配置时使用。
version: 1.0.0
---

# SSH 安全加固

## 密钥认证

**生成密钥**（ed25519 推荐）：
```bash
ssh-keygen -t ed25519 -C "user@host" -f ~/.ssh/id_ed25519 -N ""
```

**分发公钥**：
```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@remote
# 或手动追加
cat ~/.ssh/id_ed25519.pub >> ~/.ssh/authorized_keys
```

## 禁用密码认证

编辑 `/etc/ssh/sshd_config`：
```
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password   # 或 no
```

生效：`sudo systemctl restart sshd`。**先确认密钥登录可用再禁用密码**。

## 修改默认端口

```bash
# sshd_config
Port 2222
```

防火墙放行：`sudo ufw allow 2222/tcp`（若用 ufw）。

## Fail2ban

**安装**：`sudo apt install fail2ban`  
**配置** `/etc/fail2ban/jail.local`：
```ini
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600
```

**操作**：
```bash
sudo systemctl enable fail2ban
sudo fail2ban-client status sshd
```

## authorized_keys 管理

**限制命令**：
```
command="/usr/bin/rsync --server -vlogDtprze.Lsf ." ssh-ed25519 AAAAC3... backup@server
```

**限制来源 IP**：`from="192.168.1.0/24"`  
**禁用端口转发**：`restrict`（OpenSSH 8.0+）
