# IM 集成指南

本文档介绍如何将旗鱼的 AI Agent 接入钉钉、飞书、Slack 和 Telegram，实现在 IM 中直接与 AI 对话。

连接成功后，你可以在 IM 中像跟同事聊天一样与 AI Agent 交互——发一条消息，Agent 就会在你的电脑上执行任务并回复结果。

---

## 目录

1. [工作原理](#工作原理)
2. [钉钉配置](#钉钉配置)
3. [飞书配置](#飞书配置)
4. [Slack 配置](#slack-配置)
5. [Telegram 配置](#telegram-配置)
6. [在旗鱼中连接](#在旗鱼中连接)
7. [使用方式](#使用方式)
8. [常见问题](#常见问题)

---

## 工作原理

```
IM 用户发送消息
       │
       ▼
  钉钉/飞书/Slack/Telegram 服务器
       │ (WebSocket 长连接 / Long Polling 推送)
       ▼
  旗鱼 IM 服务
       │
       ▼
  本地 AI Agent 处理
       │
       ▼
  通过 API 回复到 IM
```

- **不需要公网服务器**：使用 WebSocket 长连接模式，由客户端主动连接平台，无需暴露端口或配置域名。
- **消息在本地处理**：所有 AI 推理和工具调用都在你的电脑上执行。
- **独立于 Gateway**：IM 集成不依赖远程访问（Gateway）服务，可以单独使用。

---

## 钉钉配置

### 第 1 步：创建企业内部应用

1. 打开 [钉钉开放平台](https://open-dev.dingtalk.com/)，使用管理员账号登录
2. 进入 **应用开发** → **企业内部开发** → **创建应用**
3. 填写应用名称和描述，完成创建

### 第 2 步：获取凭证

在应用详情页的 **凭证与基础信息** 中，复制：

- **ClientID**（即 AppKey）
- **ClientSecret**（即 AppSecret）

### 第 3 步：添加机器人能力

1. 在左侧菜单找到 **添加应用能力**
2. 添加 **机器人** 能力
3. 在机器人配置中选择 **Stream 模式**（非 HTTP 回调模式）

### 第 4 步：发布应用

1. 进入 **版本管理与发布**
2. 创建一个版本并发布
3. 企业内部应用通常无需审核，发布后即可使用

---

## 飞书配置

### 第 1 步：创建企业自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，登录你的飞书账号
2. 点击 **创建企业自建应用**，填写应用名称和描述
3. 创建成功后进入应用详情页

### 第 2 步：获取凭证

在应用详情页的 **凭证与基础信息** 中，复制：

- **App ID**
- **App Secret**

### 第 3 步：添加机器人能力

1. 在左侧菜单找到 **添加应用能力**
2. 添加 **机器人** 能力

### 第 4 步：开通权限

进入左侧 **权限管理**，搜索并开通以下权限：

| 权限 | 说明 |
|------|------|
| `im:message:send_as_bot` | 以应用的身份发消息（用于回复） |
| `im:message.p2p_msg:readonly` | 读取用户发给机器人的单聊消息 |
| `im:message:readonly` | 获取单聊、群组消息 |
| `im:resource` | 获取与上传图片或文件资源（用于文件发送功能） |

### 第 5 步：先连接旗鱼

飞书平台要求应用已建立长连接，才允许配置事件订阅。因此需要 **先从旗鱼发起连接**：

1. 打开旗鱼，进入 **设置** → **远程访问**
2. 展开 **飞书** 卡片，填入第 2 步获取的 App ID 和 App Secret
3. 点击 **连接**，等待状态变为 ✅ **已连接**

> 保持旗鱼的连接不要断开，然后回到飞书开放平台继续下面的步骤。

### 第 6 步：配置事件订阅（长连接模式）

1. 进入左侧 **事件与回调** → **事件配置**
2. 订阅方式选择 **使用长连接接收事件**，点击 **保存**（此时旗鱼已连接，平台不会再报错）
3. 保存成功后，点击 **添加事件**，搜索并添加：
   - **im.message.receive_v1**（接收消息）

### 第 7 步：发布应用版本

1. 进入 **版本管理与发布**
2. 创建一个版本并提交
3. 企业内审核通常很快，审核通过后应用正式生效

---

## Slack 配置

### 第 1 步：创建 Slack App

1. 打开 [Slack API](https://api.slack.com/apps)，点击 **Create New App**
2. 选择 **From scratch**，填写 App 名称，选择要安装到的 Workspace
3. 创建完成后进入 App 设置页

### 第 2 步：启用 Socket Mode

1. 左侧菜单进入 **Socket Mode**
2. 开启 **Enable Socket Mode**
3. 系统会提示生成一个 App-Level Token，输入 Token 名称（如 `socket`），Scope 选择 `connections:write`
4. 生成后复制 **App-Level Token**（以 `xapp-` 开头），后面需要填入旗鱼

### 第 3 步：添加 Bot Token Scopes

进入左侧 **OAuth & Permissions**，在 **Bot Token Scopes** 中添加以下权限：

| Scope | 说明 |
|-------|------|
| `chat:write` | 发送消息（用于回复） |
| `files:read` | 读取文件 |
| `files:write` | 上传和发送文件 |
| `im:history` | 读取私聊消息历史 |
| `im:read` | 查看私聊频道信息 |
| `im:write` | 发起私聊对话 |
| `channels:history` | 读取公共频道消息历史 |
| `channels:read` | 查看公共频道信息 |
| `groups:history` | 读取私有频道消息历史 |
| `groups:read` | 查看私有频道信息 |
| `users:read` | 查看用户信息（用于获取发送者名称） |

### 第 4 步：订阅事件

1. 进入左侧 **Event Subscriptions**
2. 开启 **Enable Events**
3. 在 **Subscribe to bot events** 中添加以下事件：
   - `message.im`（接收私聊消息）
   - `message.channels`（接收公共频道消息）
   - `message.groups`（接收私有频道消息）
4. 点击 **Save Changes**

### 第 5 步：启用 App Home 消息功能

1. 进入左侧 **App Home**
2. 在 **Show Tabs** 区域，确保 **Messages Tab** 已勾选
3. 勾选下方的 **Allow users to send Slash commands and messages from the messages tab**

> ⚠️ 这一步很关键。如果不启用，用户私聊机器人时会看到"向此应用发送消息的功能已关闭"的提示，无法发送消息。

### 第 6 步：安装 App 并获取 Bot Token

1. 进入左侧 **Install App**（或 **OAuth & Permissions** 页面顶部）
2. 点击 **Install to Workspace**，授权安装
3. 安装完成后，复制 **Bot User OAuth Token**（以 `xoxb-` 开头）

> 如果后续修改了 Scopes 或 Event Subscriptions，Slack 会提示需要 **Reinstall App**，重新安装后凭证不变。

---

## Telegram 配置

Telegram 是所有支持平台中配置最简单的——只需一个 Bot Token，全程在 Telegram 聊天界面中完成，不需要登录任何网站后台。

### 第 1 步：通过 BotFather 创建机器人

1. 打开 Telegram 客户端（手机或电脑版均可）
2. 搜索 **@BotFather** 并进入对话（这是 Telegram 官方的机器人管理工具）
3. 发送 `/newbot` 命令
4. 按提示依次输入：
   - **机器人显示名称**（如 `My Agent`，可以随意起）
   - **机器人用户名**（必须以 `bot` 结尾，如 `my_sf_agent_bot`，全局唯一）
5. 创建成功后，BotFather 会返回一个 **Bot Token**，格式如 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

> 复制并保存好这个 Token，后续需要填入旗鱼。

### 第 2 步：（可选）允许机器人加入群聊

如果你希望在群聊中使用机器人：

1. 在 @BotFather 对话中发送 `/mybots`
2. 选择你刚创建的机器人
3. 进入 **Bot Settings** → **Allow Groups?** → 选择 **Turn on**

> 如果只在私聊中使用，可以跳过这一步。

---

## 在旗鱼中连接

1. 打开旗鱼，进入 **设置** → **远程访问**
2. 在 **IM 集成** 区域，展开对应平台的卡片（钉钉 / 飞书 / Slack / Telegram）
3. 填入上面获取的凭证：
   - 钉钉：ClientID + ClientSecret
   - 飞书：App ID + App Secret
   - Slack：Bot Token（xoxb-...）+ App-Level Token（xapp-...）
   - Telegram：Bot Token
4. 点击 **连接**，等待状态变为 ✅ **已连接**
5. 可选：勾选 **启动时自动连接**，下次打开旗鱼会自动连上

---

## 使用方式

### 私聊

直接在 IM 中搜索你创建的机器人名称，发起私聊，发送文字消息即可。

### 群聊

1. 将机器人添加到群聊中
2. **@机器人** 后输入你的消息
3. 机器人会在群内回复

### 支持的消息类型

- **输入**：目前仅支持文本消息
- **输出**：支持纯文本、Markdown 格式回复和文件发送
  - 钉钉以 Markdown 消息发送，飞书以交互卡片形式发送，Slack 以 mrkdwn 格式发送，Telegram 以 Markdown 格式发送
  - AI 可以将机器上的文件直接发送到聊天中（钉钉限 20MB，飞书限 30MB，Slack 限 1GB，Telegram 限 50MB）

### 文件发送

AI Agent 可以将本地文件通过 IM 机器人发送给你。典型场景：

- 你让 AI 查看某个日志文件，AI 可以直接把文件发过来
- AI 生成了报告、截图、导出文件后，自动发送到聊天
- 需要拿到服务器上的配置文件时，直接告诉 AI "把 xxx 文件发给我"

> 如果按照上方步骤开通了 `im:resource` 权限，文件发送功能即可直接使用，无需额外配置。

---

## 常见问题

### 连接失败

- 检查凭证是否正确（注意不要有多余空格）
- 确认应用已发布上线（钉钉/飞书需要发布版本，Slack 需要 Install to Workspace，Telegram 创建机器人后即可使用）
- 检查网络是否能访问对应平台的服务器

### 飞书提示"应用未建立长连接"

这是正常现象。需要先在旗鱼中填入凭证并连接（第 5 步），建立 WebSocket 长连接后，飞书平台才允许保存长连接订阅方式的配置。

### 机器人不回复消息

- 确认旗鱼正在运行且 IM 连接状态为"已连接"
- 群聊中需要 **@机器人** 才会触发
- 检查旗鱼的 AI 模型配置是否正常

### 消息被截断

IM 平台对单条消息长度有限制。Agent 回复过长时会自动截断并提示"内容已截断"。

### Slack 提示"向此应用发送消息的功能已关闭"

需要在 Slack App 设置的 **App Home** → **Show Tabs** 中启用 **Messages Tab** 并勾选 **Allow users to send Slash commands and messages from the messages tab**。详见 [Slack 配置第 5 步](#第-5-步启用-app-home-消息功能)。

### 凭证安全

所有凭证仅保存在本地设备上，不会上传到任何服务器。请确保你的设备安全，避免凭证泄露。
