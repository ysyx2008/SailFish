---
title: '设置详解'
description: '了解旗鱼设置页面的各个配置项'
---

# 设置详解

点击左下角的 **⚙️ 齿轮图标** 进入设置页面。这里可以配置旗鱼的所有功能。

## AI 模型配置

管理你的 AI 服务配置，支持同时配置多个模型：

- **新增/编辑模型**：添加服务商、API Key、模型名称
- **设为当前使用**：点击「使用」按钮切换活跃模型
- **模型类型**：通用 或 视觉（影响图片处理的路由）
- **关联视觉模型**：为纯文本模型绑定一个视觉模型
- **独立代理**：为每个模型配置专用的 HTTP/SOCKS 代理

> 详细说明见 [模型配置详解](/zh/docs/ai-advanced/model-config)。

## 通用设置

- **语言**：中文 / English
- **执行模式**：默认的 Agent 执行模式（严格/宽松/自由）
- **自动视觉模型切换**：发送图片时自动切换到视觉模型
- **上下文长度**：AI 单次对话能记住的 token 数量
- **日志级别**：控制日志的详细程度（排查问题时设为 debug）

## 终端设置

- **字体**：选择终端使用的等宽字体
- **字号**：调整终端文字大小
- **主题**：多种终端配色方案
- **光标样式**：方块 / 下划线 / 竖线
- **默认 Shell**：macOS/Linux 下可选 bash、zsh 等
- **滚动缓冲区**：终端保留多少行历史输出

## SSH 连接管理

管理你保存的 SSH 服务器配置：

- **添加服务器**：填写主机名、端口、用户名、认证方式
- **密钥管理**：添加和管理 SSH 私钥
- **分组管理**：将服务器按项目或环境分组
- **Xshell 导入**：从 Xshell 导入已有的会话配置

> 详细说明见 [SSH 连接](/zh/docs/server/ssh-connection)。

## 即时通讯（IM）

配置远程访问通道，让你通过手机 App 与 Agent 对话：

- **钉钉**：填入 ClientID / ClientSecret
- **飞书**：填入 App ID / App Secret
- **企业微信**：填入 BotID / Secret
- **Slack**：填入 Bot Token / App Token
- **Telegram**：填入 Bot Token

每个平台独立连接和断开，支持启动时自动连接。

> 详细说明见 [远程访问概览](/zh/docs/remote-access/overview)。

## Web 服务

开启网关服务后可以通过浏览器远程访问 Agent：

- **启用/关闭网关**
- **端口配置**（默认 3721）
- **访问 Token**（安全凭证）

> 详细说明见 [Web 远程访问](/zh/docs/remote-access/web-remote)。

## 邮箱

配置邮箱账号以使用邮件收发功能：

- 支持 Gmail、Outlook、QQ 邮箱、163 邮箱等
- 也支持自定义 IMAP/SMTP 服务器

> 详细说明见 [邮箱管理](/zh/docs/office/email)。

## 日历

配置日历服务以使用日程管理功能：

- 支持 Google Calendar、Apple iCloud、Outlook 等
- 基于 CalDAV 协议

> 详细说明见 [日历与待办](/zh/docs/office/calendar)。

## 技能管理

管理 AI 的扩展技能：

- **已安装技能**：查看和卸载已安装的技能
- **技能市场**：浏览和安装社区共享的技能

> 详细说明见 [技能系统](/zh/docs/ai-advanced/skill-system)。

## MCP 配置

管理 Model Context Protocol 工具：

- **添加 MCP 服务器**：配置连接方式（stdio / SSE）
- **预设模板**：一键添加常用 MCP 工具
- **状态管理**：启用/禁用/重连

> 详细说明见 [MCP 扩展](/zh/docs/ai-advanced/mcp-extensions)。

## 关于

查看版本信息、检查更新、查看开源协议等。
