# Telegram 配置

中文 | [English](./telegram.md)

Telegram 是所有支持平台中配置最简单的——只需一个 Bot Token，全程在 Telegram 聊天界面中完成，不需要登录任何网站后台。

集成说明总览请见 [IM 集成指南](./README_CN.md)。

---

## 第 1 步：通过 BotFather 创建机器人

1. 打开 Telegram 客户端（手机或电脑版均可）
2. 搜索 **@BotFather** 并进入对话（这是 Telegram 官方的机器人管理工具）
3. 发送 `/newbot` 命令
4. 按提示依次输入：
   - **机器人显示名称**（如 `My Agent`，可以随意起）
   - **机器人用户名**（必须以 `bot` 结尾，如 `my_sf_agent_bot`，全局唯一）
5. 创建成功后，BotFather 会返回一个 **Bot Token**，格式如 `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

> 复制并保存好这个 Token，后续需要填入旗鱼。

---

## 第 2 步：（可选）允许机器人加入群聊

如果你希望在群聊中使用机器人：

1. 在 @BotFather 对话中发送 `/mybots`
2. 选择你刚创建的机器人
3. 进入 **Bot Settings** → **Allow Groups?** → 选择 **Turn on**

> 如果只在私聊中使用，可以跳过这一步。

---

## 后续步骤

在旗鱼中进入 **设置** → **即时通讯**，展开 **Telegram** 卡片，填入 **Bot Token** 后点击 **连接**。使用方式与常见问题见 [在旗鱼中连接](./README_CN.md#在旗鱼中连接)。
