---
name: Systemd 服务管理
description: 创建和管理 systemd 服务单元文件，处理服务启动、重启和日志
version: "1.0"
---

# Systemd 服务管理

在 Linux 系统上创建和管理 systemd 服务的最佳实践。

## 服务单元文件模板

路径：`/etc/systemd/system/<service-name>.service`

```ini
[Unit]
Description=My Application Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=appuser
Group=appuser
WorkingDirectory=/opt/myapp
ExecStart=/opt/myapp/start.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/myapp/data

# 资源限制
LimitNOFILE=65535
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

## 常用操作

| 操作 | 命令 |
|------|------|
| 启动 | `systemctl start <service>` |
| 停止 | `systemctl stop <service>` |
| 重启 | `systemctl restart <service>` |
| 平滑重载 | `systemctl reload <service>` |
| 查看状态 | `systemctl status <service>` |
| 开机自启 | `systemctl enable <service>` |
| 取消自启 | `systemctl disable <service>` |
| 查看日志 | `journalctl -u <service> -f` |

## 工作流程

### 创建新服务
1. 编写 `.service` 文件到 `/etc/systemd/system/`
2. `systemctl daemon-reload`
3. `systemctl start <service>`
4. `systemctl status <service>` 确认运行正常
5. `systemctl enable <service>` 设置开机自启

### 修改已有服务
1. 编辑 `.service` 文件
2. `systemctl daemon-reload`（必须！）
3. `systemctl restart <service>`

### 排查故障
1. `systemctl status <service>` — 查看当前状态和最近日志
2. `journalctl -u <service> -n 50 --no-pager` — 查看最近 50 行日志
3. `journalctl -u <service> --since "1 hour ago"` — 按时间范围查看
4. 检查 ExecStart 路径和权限是否正确
5. 检查 User/Group 是否存在且有权限

## 注意事项

- 修改 service 文件后必须 `daemon-reload`
- 不要用 `kill -9` 停止 systemd 管理的服务
- 生产环境建议配置 `Restart=on-failure` 和合理的 `RestartSec`
- 使用 `journalctl` 而非手动管理日志文件
