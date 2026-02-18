---
name: SSL 证书管理
description: Certbot 安装、Let's Encrypt 证书申请、自动续期、nginx/apache 集成、泛域名证书
version: "1.0"
---

# SSL 证书管理

使用 Let's Encrypt 管理 HTTPS 证书的常用流程。

## Certbot 安装

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install certbot

# 使用 snap（推荐，自动更新）
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
```

## 证书申请

```bash
# 单域名（standalone 模式，需临时停 80 端口服务）
sudo certbot certonly --standalone -d example.com

# Webroot 模式（与 nginx/apache 共用 80 端口）
sudo certbot certonly --webroot -w /var/www/html -d example.com

# 泛域名（需 DNS 验证）
sudo certbot certonly --manual --preferred-challenges dns -d "*.example.com" -d example.com
```

## 自动续期

```bash
# 测试续期
sudo certbot renew --dry-run

# 续期后重载 nginx
# 在 /etc/letsencrypt/renewal-hooks/deploy/ 中放置脚本：
# echo "nginx -s reload" > deploy/nginx-reload.sh && chmod +x deploy/nginx-reload.sh
```

## Nginx 集成

```nginx
ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
```

## Apache 集成

```apache
SSLCertificateFile /etc/letsencrypt/live/example.com/fullchain.pem
SSLCertificateKeyFile /etc/letsencrypt/live/example.com/privkey.pem
```

## 泛域名证书注意

- 必须使用 DNS-01 挑战，需在域名服务商处添加 `_acme-challenge` TXT 记录
- 可使用 `certbot-dns-*` 插件（如 certbot-dns-cloudflare）实现自动化
