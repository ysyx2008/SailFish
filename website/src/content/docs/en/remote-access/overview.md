---
title: "Remote Access Overview"
description: "Learn how to remotely control your SailFish AI Agent from anywhere"
---

# Remote Access Overview

SailFish supports multiple ways to remotely access your AI Agent. Even when away from your computer, you can give your Agent commands from your phone, receive notifications, and view results.

## Why Remote Access?

SailFish AI Agent runs on your computer and directly operates your system and servers. Remote access helps you in these scenarios:

- **Server alerts while away**: Pull out your phone and ask the Agent in DingTalk to investigate
- **Ideas before sleep**: Have the Agent create a calendar reminder from your phone
- **During commute**: Review the Agent’s morning briefing
- **Deploy results in meetings**: IM bot auto-pushes CI/CD status

## Access Methods at a Glance

| Method | Description | Public IP Needed | Setup Difficulty | Best For |
|--------|-------------|:----------------:|:----------------:|----------|
| Web Remote | Browser access | Yes* | ★☆☆ | Full interaction experience |
| DingTalk (钉钉) | DingTalk bot | No | ★★☆ | Personal/enterprise users in China |
| Feishu (飞书) | Feishu bot | No | ★★☆ | ByteDance ecosystem users |
| WeCom (企业微信) | WeCom bot | No | ★★☆ | Tencent ecosystem users |
| Slack | Slack Bot | No | ★★☆ | International teams |
| Telegram | Telegram Bot | No | ★☆☆ | Personal use, fastest setup |

> *Web Remote does not need a public IP on the local network; external access requires tunneling or port forwarding.

## How It Works

```
Your phone / tablet / other computer
       │  Send messages
       ▼
  IM platform / Web browser
       │  WebSocket / HTTP
       ▼
  SailFish app (running on your computer)
       │  Agent runs tasks
       ▼
  Local files / remote servers
       │
       ▼
  Results returned via IM / Web
```

### Key Characteristics

- **IM methods need no public IP**: All IM platforms use WebSocket long connections or long polling. SailFish connects to platform servers, and the platform forwards messages to SailFish—your computer does not need a public IP or domain
- **Processing stays local**: AI inference, tool calls, and file operations run on your computer; data is not sent to IM platforms
- **Credentials stored locally**: All IM tokens and secrets are stored only on your computer and are not uploaded elsewhere
- **Multiple platforms at once**: You can connect DingTalk, Feishu, Telegram, and other channels simultaneously

## Which Option to Choose?

### Personal Users

| If you… | Recommended | Reason |
|---------|-------------|--------|
| Want the fastest setup | **Telegram** | About 3 minutes, no enterprise account |
| Use DingTalk often | **DingTalk** | Widely used in China |
| Want rich interaction | **Web Remote** | Near-desktop experience |

### Enterprise / Team Users

| If you… | Recommended | Reason |
|---------|-------------|--------|
| Team uses Feishu | **Feishu** | Best interactive cards and layout |
| Team uses WeCom | **WeCom** | Native integration, easy IT management |
| International team | **Slack** | Global coverage, strong ecosystem |

### Use Multiple Channels

You can enable several channels at once. Common setups:

- **DingTalk + Web Remote**: Daily chat in DingTalk, complex tasks in Web
- **Feishu + Telegram**: Work in Feishu, personal in Telegram
- **Web Remote + Awaken mode**: Web UI + Webhook for external events

## Message Capability Comparison

| Capability | DingTalk | Feishu | WeCom | Slack | Telegram |
|------------|:--------:|:------:|:-----:|:-----:|:--------:|
| Text | ✅ | ✅ | ✅ | ✅ | ✅ |
| Markdown | ✅ | Cards | ✅ | mrkdwn | ✅ |
| File send | 20MB | 30MB | 20MB | 1GB | 50MB |
| Direct chat | ✅ | ✅ | ✅ | ✅ | ✅ |
| Group @bot | ✅ | ✅ | ✅ | ✅ | — |

## Security

Remote access security is layered:

1. **Platform encryption**: IM traffic is TLS-encrypted
2. **Local processing**: AI and tools run on your machine; data does not pass through middle servers
3. **Credential storage**: API keys and tokens are stored only on local disk
4. **Agent risk control**: Agent risk assessment and execution modes (strict/relaxed/free) apply even over remote

## Quick Start

1. Pick your most-used platform
2. Follow the setup guide (typically 10–15 minutes)
3. Enter credentials in SailFish Settings
4. Click **Connect** and wait until status shows ✅ Connected
5. Search for your bot in the IM app and send your first message

Detailed setup for each platform:

- [Web Remote Access](/docs/remote-access/web-remote)
- [Feishu Integration](/docs/remote-access/feishu)
- [DingTalk Integration](/docs/remote-access/dingtalk)
- [WeCom Integration](/docs/remote-access/wecom)
- [Slack Integration](/docs/remote-access/slack)
- [Telegram Integration](/docs/remote-access/telegram)
