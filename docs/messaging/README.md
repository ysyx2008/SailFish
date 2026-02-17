# Messaging Integration Guide

[中文](./README_CN.md) | English

This guide explains how to connect SFTerminal's AI Agent to Slack, Telegram, DingTalk, Feishu (Lark), and WeCom (WeChat Work), enabling you to chat with the AI directly from your messaging app.

Once connected, you can interact with the AI Agent just like chatting with a colleague — send a message, and the Agent will execute tasks on your machine and reply with the results.

---

## How It Works

```
User sends a message in chat
       │
       ▼
  Slack/Telegram/DingTalk/Feishu/WeCom server
       │ (WebSocket / Long Polling)
       ▼
  SFTerminal Messaging Service
       │
       ▼
  Local AI Agent processes the request
       │
       ▼
  Reply sent back via API
```

- **Most platforms need no public server**: Slack, Telegram, DingTalk, and Feishu use WebSocket or long polling initiated from the client—no need to expose ports or configure a domain. **WeCom** uses HTTP callback and requires a publicly accessible callback URL (e.g. via a tunnel).
- **Messages processed locally**: All AI inference and tool calls run on your machine.
- **Independent of Gateway**: Messaging integration does not depend on the remote access (Gateway) service and can be used standalone.

---

## Platform Setup

Choose your platform and follow its setup guide:

| Platform | Setup Guide |
|----------|-------------|
| **Slack** | [Slack Setup](./slack.md) |
| **Telegram** | [Telegram Setup](./telegram.md) |
| **DingTalk** | [DingTalk Setup](./dingtalk.md) |
| **Feishu (Lark)** | [Feishu Setup](./feishu.md) |
| **WeCom (WeChat Work)** | [WeCom Setup](./wecom.md) |

---

## Connect in SFTerminal

1. Open SFTerminal, go to **Settings** → **Remote Access**
2. In the **Messaging Integration** section, expand the card for your platform (Slack / Telegram / DingTalk / Feishu / WeCom)
3. Enter the credentials obtained from the setup guide above:
   - **Slack**: Bot Token (xoxb-...) + App-Level Token (xapp-...)
   - **Telegram**: Bot Token
   - **DingTalk**: ClientID + ClientSecret
   - **Feishu**: App ID + App Secret
   - **WeCom**: Corp ID, Corp Secret, Agent ID, Callback Token, EncodingAESKey, Callback Port
4. Click **Connect** and wait for the status to show ✅ **Connected**
5. Optional: Check **Auto-connect on startup** so SFTerminal reconnects automatically next time

---

## Usage

### Direct Messages

Search for the bot by name in your messaging app, start a direct conversation, and send a text message.

### Group Chats

1. Add the bot to a group chat
2. **@mention the bot** followed by your message
3. The bot will reply in the group

### Supported Message Types

- **Input**: Currently supports text messages only
- **Output**: Supports plain text, Markdown-formatted replies, and file sending
  - Slack uses mrkdwn format, Telegram uses Markdown, DingTalk/WeCom use Markdown messages, Feishu uses interactive cards
  - AI can send files from your machine directly to the chat (Slack: 1GB, Telegram: 50MB, DingTalk/WeCom: 20MB, Feishu: 30MB)

### File Sending

The AI Agent can send local files via the bot. Typical use cases:

- Ask the AI to check a log file, and it can send the file directly to you
- After generating reports, screenshots, or exports, the AI sends them to the chat automatically
- When you need a config file from the server, just tell the AI "send me the xxx file"

---

## FAQ

### Connection Failed

- Verify your credentials are correct (watch out for extra spaces)
- Make sure the app is published and active (DingTalk/Feishu require publishing a version, Slack requires Install to Workspace, Telegram works immediately after bot creation)
- Check that your network can reach the platform's servers

### Bot Doesn't Reply

- Confirm SFTerminal is running and the connection status shows "Connected"
- In group chats, you must **@mention the bot** to trigger a response
- Check that the AI model configuration in SFTerminal is correct

### Messages Truncated

Messaging platforms have message length limits. When Agent replies are too long, they are automatically truncated with a note indicating the content was cut off.

### Platform-Specific FAQ

- **Slack**: "Sending messages to this app has been turned off" → see [Slack Setup Step 5](./slack.md#step-5-enable-app-home-messaging)
- **Feishu**: "App has no active long connection" → see [Feishu Setup Step 5](./feishu.md#step-5-connect-sfterminal-first)
- **WeCom**: Callback URL not receiving messages → see [WeCom Setup](./wecom.md#faq-callback-not-receiving-messages) (ensure URL is publicly accessible)

### Credential Security

All credentials are stored locally on your device only and are never uploaded to any server. Ensure your device is secure to prevent credential leaks.
