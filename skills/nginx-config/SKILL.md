---
name: Nginx 配置助手
description: Nginx 反向代理、SSL 配置、性能优化的常用模板和最佳实践
version: "1.0"
---

# Nginx 配置助手

配置 Nginx 时的常用模板和最佳实践。

## 反向代理模板

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## SSL + HTTPS 配置

```nginx
server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}
```

## WebSocket 代理

在 location 中添加：
```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

## 性能优化

- 开启 gzip：`gzip on; gzip_types text/plain application/json application/javascript text/css;`
- 静态文件缓存：`expires 7d;` 或使用 `add_header Cache-Control`
- 调整 `worker_connections`（建议 1024+）
- 使用 `keepalive` 连接池连接上游

## 安全加固

- 隐藏版本：`server_tokens off;`
- 限制请求体大小：`client_max_body_size 10m;`
- 添加安全头：X-Frame-Options、X-Content-Type-Options 等
- 限流：使用 `limit_req_zone` 防止暴力请求

## 配置检查

修改配置后必须：
1. 语法检查：`nginx -t`
2. 平滑重载：`nginx -s reload`（不要直接 restart）
