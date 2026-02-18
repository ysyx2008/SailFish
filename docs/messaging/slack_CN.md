# Slack 配置

中文 | [English](./slack.md)

按以下步骤创建 Slack 应用并获取旗鱼所需凭证。集成说明总览请见 [IM 集成指南](./README_CN.md)。

---

## 第 1 步：创建 Slack App

1. 打开 [Slack API](https://api.slack.com/apps)，点击 **Create New App**
2. 选择 **From scratch**，填写 App 名称，选择要安装到的 Workspace
3. 创建完成后进入 App 设置页

---

## 第 2 步：启用 Socket Mode

1. 左侧菜单进入 **Socket Mode**
2. 开启 **Enable Socket Mode**
3. 系统会提示生成一个 App-Level Token，输入 Token 名称（如 `socket`），Scope 选择 `connections:write`
4. 生成后复制 **App-Level Token**（以 `xapp-` 开头），后面需要填入旗鱼

---

## 第 3 步：添加 Bot Token Scopes

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

---

## 第 4 步：订阅事件

1. 进入左侧 **Event Subscriptions**
2. 开启 **Enable Events**
3. 在 **Subscribe to bot events** 中添加以下事件：
   - `message.im`（接收私聊消息）
   - `message.channels`（接收公共频道消息）
   - `message.groups`（接收私有频道消息）
4. 点击 **Save Changes**

---

## 第 5 步：启用 App Home 消息功能

1. 进入左侧 **App Home**
2. 在 **Show Tabs** 区域，确保 **Messages Tab** 已勾选
3. 勾选下方的 **Allow users to send Slash commands and messages from the messages tab**

> ⚠️ 这一步很关键。如果不启用，用户私聊机器人时会看到「向此应用发送消息的功能已关闭」的提示，无法发送消息。

---

## 第 6 步：安装 App 并获取 Bot Token

1. 进入左侧 **Install App**（或 **OAuth & Permissions** 页面顶部）
2. 点击 **Install to Workspace**，授权安装
3. 安装完成后，复制 **Bot User OAuth Token**（以 `xoxb-` 开头）

> 如果后续修改了 Scopes 或 Event Subscriptions，Slack 会提示需要 **Reinstall App**，重新安装后凭证不变。

---

## 后续步骤

在旗鱼中进入 **设置** → **远程访问**，展开 **Slack** 卡片，填入：

- **Bot User OAuth Token**（xoxb-...）
- **App-Level Token**（xapp-...）

然后点击 **连接**。使用方式与常见问题见 [在旗鱼中连接](./README_CN.md#在旗鱼中连接)。
