---
name: 新服务器初始化
description: Linux 云服务器购买后的标准化初始化流程：用户创建、SSH 加固、时区、常用工具、防火墙、swap 配置
version: 1.0.0
---

# 新服务器初始化

新购云服务器（ECS/CVM/轻量）的标准化初始化清单。

## 1. 创建管理用户

```bash
# 创建用户并加入 sudo 组
useradd -m -s /bin/bash admin
echo 'admin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/admin
chmod 440 /etc/sudoers.d/admin

# 设置密码（或后续配置密钥登录后禁用密码）
passwd admin
```

## 2. SSH 密钥登录

```bash
# 在本地生成密钥（如未有）
ssh-keygen -t ed25519 -C "your@email.com"

# 复制公钥到服务器
ssh-copy-id -i ~/.ssh/id_ed25519.pub admin@<server-ip>

# 在服务器上加固 sshd_config
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

> 修改 SSH 配置前，保持一个已连接的会话以防配置出错被锁定。

## 3. 时区与时间同步

```bash
sudo timedatectl set-timezone Asia/Shanghai
sudo timedatectl set-ntp true

# 验证
timedatectl
date
```

## 4. 系统更新与常用工具

```bash
# Ubuntu/Debian
sudo apt update && sudo apt upgrade -y
sudo apt install -y vim curl wget git htop tmux lsof net-tools unzip

# CentOS/Rocky
sudo yum update -y
sudo yum install -y vim curl wget git htop tmux lsof net-tools unzip epel-release
```

## 5. 主机名

```bash
sudo hostnamectl set-hostname <your-hostname>
# 写入 hosts 避免 sudo 警告
echo "127.0.0.1 $(hostname)" | sudo tee -a /etc/hosts
```

## 6. 防火墙基础规则

```bash
# Ubuntu (ufw)
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# CentOS (firewalld)
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

## 7. Swap 配置

内存 ≤ 2GB 的机器建议配置 swap：
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 调整 swappiness（云服务器推荐 10）
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 8. 内核参数优化（可选）

```bash
cat >> /etc/sysctl.conf << 'EOF'
# 网络优化
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_tw_reuse = 1

# 文件描述符
fs.file-max = 655350
EOF
sudo sysctl -p

# 进程限制
cat >> /etc/security/limits.conf << 'EOF'
* soft nofile 655350
* hard nofile 655350
EOF
```

## 初始化后验证清单

- [ ] 能以非 root 用户通过密钥登录
- [ ] root 密码登录已禁用
- [ ] 时区为 Asia/Shanghai，NTP 已开启
- [ ] 防火墙已启用，仅开放必要端口
- [ ] swap 已配置（小内存机器）
- [ ] `reboot` 后以上配置仍生效
