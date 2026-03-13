---
title: 'Slack 接入'
description: '将旗鱼 AI Agent 接入 Slack，在 Slack 中与 Agent 对话'
---

# Slack 接入

将旗鱼接入 Slack 后，你可以在 Slack 工作区中直接与 AI Agent 对话。适合海外团队或使用 Slack 的国际化团队。

## 前置条件

- Slack 工作区（免费版或付费版均可）
- 工作区管理员权限（或由管理员帮你安装应用）

## 配置步骤

### 第 1 步：创建 Slack 应用

1. 打开 [Slack API](https://api.slack.com/apps)
2. 点击「Create New App」→「From scratch」
3. 填写：
   - **App Name**：如「SailFish Agent」
   - **Workspace**：选择你的工作区
4. 点击「Create App」

### 第 2 步：配置 Socket Mode

Socket Mode 让 Slack 通过 WebSocket 推送消息，无需公网地址：

1. 在左侧菜单选择「Socket Mode」
2. 点击开启 **Enable Socket Mode**
3. 创建 **App-Level Token**：
   - Token Name 填写如 `sailfish-socket`
   - 权限选择 `connections:write`
   - 点击 Generate
4. 记录生成的 Token（`xapp-...` 开头）

### 第 3 步：配置事件订阅

1. 在左侧菜单选择「Event Subscriptions」
2. 开启 **Enable Events**
3. 在 **Subscribe to bot events** 中添加以下事件：

| 事件 | 用途 |
|------|------|
| `message.im` | 接收私聊消息 |
| `message.groups` | 接收群组消息 |
| `app_mention` | 收到 @提及时触发 |

4. 点击「Save Changes」

### 第 4 步：配置 OAuth 权限

在「OAuth & Permissions」→「Bot Token Scopes」中添加以下权限：

| 权限 | 用途 |
|------|------|
| `chat:write` | Bot 发送消息 |
| `files:write` | Bot 发送文件 |
| `im:history` | 读取私聊消息历史 |
| `im:read` | 读取私聊列表 |
| `groups:history` | 读取群组消息历史 |
| `app_mentions:read` | 读取 @提及消息 |

### 第 5 步：启用 App Home 消息功能

> ⚠️ **这步容易遗漏**。不配置的话，用户在私聊 Bot 时会看到"向此应用发送消息的功能已关闭"的错误。

1. 在左侧菜单选择「App Home」
2. 开启 **Messages Tab**
3. 勾选 **Allow users to send Slash commands and messages from the messages tab**

### 第 6 步：安装到工作区

1. 在「OAuth & Permissions」页面点击 **Install to Workspace**
2. 查看权限清单，点击「Allow」授权
3. 安装成功后，记录 **Bot User OAuth Token**（`xoxb-...` 开头）

### 第 7 步：连接旗鱼

1. 打开旗鱼 → 设置 → 即时通讯
2. 展开「Slack」卡片
3. 填入两个 Token：
   - **Bot Token**：`xoxb-...`（第 6 步获得）
   - **App Token**：`xapp-...`（第 2 步获得）
4. 点击「连接」
5. 等待状态变为 ✅「已连接」

## 开始使用

### 私聊

1. 在 Slack 左侧边栏的「Apps」区域找到你的 Bot
2. 点击打开消息标签（Messages Tab）
3. 直接发送文字消息

### 频道

1. 将 Bot 添加到某个频道中
2. 在频道里 **@SailFish Agent** 后输入消息
3. Bot 会在频道内回复

### 消息格式

- **你发送的**：纯文本消息
- **Agent 回复的**：mrkdwn 格式（Slack 的 Markdown 变体），支持粗体、代码块、链接等
- **文件发送**：Agent 可以发送文件到聊天中（最大 1GB，远高于其他 IM 平台）

### 使用示例

```
你: Check the server disk usage
Agent: *Disk Usage Report*
       ```
       Filesystem      Size  Used  Avail  Use%
       /dev/sda1       100G   45G    55G   45%
       /dev/sdb1       500G  180G   320G   36%
       ```
       All partitions have sufficient space. ✅
```

## 常见问题

**"向此应用发送消息的功能已关闭"（Messaging has been turned off）**
- 这是最常见的问题，原因是没有完成第 5 步
- 进入 Slack API → App Home，开启 Messages Tab 并勾选允许用户发送消息

**Bot 不响应消息**
- 确认 Socket Mode 已开启（第 2 步）
- 确认 Bot Token 和 App Token 都已正确填入
- 确认 Event Subscriptions 中添加了 `message.im` 事件
- 确认旗鱼连接状态为「已连接」

**安装时看不到权限选项**
- 确认已在「Bot Token Scopes」中添加了所有必需的权限（第 4 步）
- 添加权限后需要重新安装应用（Reinstall App）

**频道中 Bot 不回复**
- 确认 Bot 已被添加到该频道（在频道中输入 `/invite @SailFish Agent`）
- 确认消息中 @了 Bot
- 确认 Event Subscriptions 中添加了 `app_mention` 事件
