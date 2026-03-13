---
title: 'Telegram 接入'
description: '将旗鱼 AI Agent 接入 Telegram，在 Telegram 中与 Agent 对话'
---

# Telegram 接入

Telegram 是所有 IM 平台中**配置最简单**的一个——只需 3 分钟、2 个步骤即可完成。

## 前置条件

- Telegram 账号
- 能正常访问 Telegram（国内网络可能需要代理）

## 配置步骤

### 第 1 步：创建 Bot

1. 打开 Telegram，搜索 **@BotFather**（官方机器人管理工具）
2. 向 BotFather 发送 `/newbot` 命令
3. 按提示操作：
   - 输入 Bot 的**显示名称**（如「旗鱼助手」）
   - 输入 Bot 的**用户名**（必须以 `bot` 结尾，如 `sailfish_ai_bot`）
4. 创建成功后，BotFather 会返回一个 **Bot Token**

Bot Token 的格式类似：

```
123456789:ABCdefGHI-JKLmnoPQRstUVwxyz
```

**请妥善保管这个 Token**，它是操控 Bot 的唯一凭证。

### 第 2 步：连接旗鱼

1. 打开旗鱼 → 设置 → 即时通讯
2. 展开「Telegram」卡片
3. 将刚才获取的 Bot Token 粘贴进去
4. 点击「连接」
5. 等待状态变为 ✅「已连接」

完成！就是这么简单。

## 开始使用

1. 在 Telegram 中搜索你刚创建的 Bot 用户名（如 `sailfish_ai_bot`）
2. 点击「**Start**」按钮开始对话
3. 直接发送文字消息即可

### 消息格式

- **你发送的**：纯文本消息
- **Agent 回复的**：Markdown 格式（代码块、加粗等）
- **文件发送**：Agent 可以把文件发送到聊天中（最大 50MB）

### 使用示例

```
你: 检查一下服务器状态
Agent: 🖥 服务器状态报告
       
       CPU: 23.5% (4 cores)
       Memory: 8.2GB / 16GB (51.3%)
       Disk: 45GB / 200GB (22.5%)
       Uptime: 32 days
       
       所有指标正常 ✅
```

```
你: 把 /var/log/app/error.log 最后 100 行发给我
Agent: 正在获取日志...
       [发送文件: error_tail100.txt]
```

## 可选配置

### 自定义 Bot 外观

通过 @BotFather 可以进一步定制你的 Bot：

| 命令 | 功能 |
|------|------|
| `/setdescription` | 设置 Bot 描述（在 Bot 信息页显示） |
| `/setabouttext` | 设置「关于」文字 |
| `/setuserpic` | 设置 Bot 头像 |
| `/setcommands` | 设置快捷命令菜单 |

### 限制访问者

默认情况下，任何知道 Bot 用户名的 Telegram 用户都可以向它发消息。如果你只想自己使用，旗鱼会记住第一个和 Bot 对话的用户作为主人。

### 使用代理

如果直连 Telegram 网络不通，可以在旗鱼设置中为 Telegram 配置代理：

| 代理类型 | 配置示例 |
|---------|---------|
| HTTP 代理 | `http://127.0.0.1:7890` |
| SOCKS5 代理 | `socks5://127.0.0.1:1080` |

在旗鱼 设置 → 即时通讯 → Telegram 中填入代理地址即可。

## 常见问题

**连接失败**
- 检查 Bot Token 是否完整正确（从 BotFather 的消息中重新复制）
- 确认网络能访问 Telegram（在浏览器中打开 `https://api.telegram.org` 测试）
- 如果网络受限，配置代理后重试

**Bot 不回复**
- 确认旗鱼的连接状态为「已连接」
- 确认你已经点击过「Start」按钮
- 检查旗鱼的 AI 模型配置是否正常

**消息发送延迟**
- Telegram 使用长轮询方式获取消息，通常延迟在 1-3 秒
- 如果延迟明显偏长，检查网络或代理的稳定性

**Token 泄露了怎么办**
- 在 @BotFather 中发送 `/revoke` 命令撤销当前 Token
- 生成新 Token 后在旗鱼中更新
