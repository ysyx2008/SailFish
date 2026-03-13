---
title: '故障排查指南'
description: '系统化排查旗鱼使用中遇到的问题'
---

# 故障排查指南

当遇到问题时，按照以下步骤系统排查可以快速定位原因。

## 第 1 步：查看日志

旗鱼的日志文件是排查问题的第一手资料。

### 日志位置

| 系统 | 路径 |
|------|------|
| macOS | `~/Library/Application Support/SailFish/logs/` |
| Windows | `%APPDATA%/SailFish/logs/` |
| Linux | `~/.config/SailFish/logs/` |

日志按日期命名（如 `2026-03-13.log`），打开最新的文件查看。

### 调整日志级别

如果日志信息不够详细：

1. 打开 设置 → 通用
2. 将「日志级别」设为 `debug`
3. 复现问题
4. 查看日志中的详细信息

> 排查完成后建议将日志级别调回 `info`，避免日志文件过大。

## 第 2 步：确认网络

很多问题的根源是网络：

### AI 模型连接

```bash
# 测试是否能访问 AI 服务
curl https://api.deepseek.com/v1/models
curl https://api.openai.com/v1/models
```

如果不通，可能需要：
- 配置代理（设置中为模型配置独立代理）
- 检查 VPN/代理软件是否正常

### SSH 服务器连接

```bash
# 测试端口是否可达
nc -zv 服务器IP 22

# 测试 SSH 连接
ssh -v 用户名@服务器IP
```

### IM 平台连接

```bash
# 测试钉钉
curl https://api.dingtalk.com

# 测试飞书
curl https://open.feishu.cn

# 测试 Telegram
curl https://api.telegram.org
```

## 第 3 步：检查配置

### AI 模型配置

在 设置 → AI 模型 中确认：

- API 地址格式正确（包含 `https://`，不含多余路径）
- API Key 完整（没有被截断或有多余空格）
- 模型名称正确（如 `gpt-4o` 而非 `GPT-4o`）

### SSH 配置

- 主机名/IP 正确
- 端口正确（默认 22）
- 认证方式和凭证匹配
- 私钥文件路径有效

## 第 4 步：重置和恢复

如果上述步骤都不能解决：

### 清除会话状态

点击对话区的「清空对话」按钮，重新开始对话。

### 重启应用

完全退出旗鱼（不是最小化），重新打开。

### 重置配置

如果怀疑是配置问题：

1. 关闭旗鱼
2. 备份配置目录（路径见日志位置表）
3. 删除配置目录
4. 重新打开旗鱼（会使用默认配置）
5. 重新配置 AI 模型等

> 旗鱼每次更新前会自动备份配置，也可以手动从 `backups/` 目录恢复。

## 第 5 步：获取帮助

如果仍然无法解决：

1. **GitHub Issues**：到 [SailFish Issues](https://github.com/ysyx2008/SailFish/issues) 提交问题，附上：
   - 操作系统和版本
   - 旗鱼版本号
   - 问题描述和复现步骤
   - 相关日志截图（注意隐藏敏感信息如 API Key）

2. **QQ 群**：加入用户群 `1078041072` 交流
