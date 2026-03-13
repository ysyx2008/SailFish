---
title: 'Settings'
description: 'Configure all aspects of SailFish'
---

# Settings

Click the **⚙️ gear icon** in the bottom-left corner to open Settings. Here you can configure all of SailFish's features.

## AI Model Configuration

Manage your AI providers and models. You can configure multiple models at once:

- **Add or edit models**: Set provider, API key, and model name
- **Set active model**: Click "Use" to switch the current model
- **Model type**: General or Vision (affects how images are handled)
- **Associated vision model**: Link a vision model to a text-only model
- **Per-model proxy**: Configure separate HTTP/SOCKS proxies per model

> For details, see [Model Configuration](/docs/ai-advanced/model-config).

## General Settings

- **Language**: 中文 / English
- **Execution mode**: Default Agent mode (Strict / Relaxed / Free)
- **Auto vision model switch**: Switch to a vision model when you send images
- **Context length**: How many tokens the AI can use in a single conversation
- **Log level**: Log detail level (use debug when troubleshooting)

## Terminal Settings

- **Font**: Monospace font for the terminal
- **Font size**: Text size
- **Theme**: Terminal color scheme
- **Cursor style**: Block / Underline / Bar
- **Default shell**: On macOS/Linux, choose bash, zsh, etc.
- **Scroll buffer**: How many lines of terminal history to keep

## SSH Management

Manage saved SSH server configurations:

- **Add servers**: Host, port, username, authentication method
- **Key management**: Add and manage SSH private keys
- **Groups**: Organize servers by project or environment
- **Xshell import**: Import sessions from Xshell

> For details, see [SSH Connection](/docs/server/ssh-connection).

## IM Integrations

Set up remote access so you can talk to the Agent from your phone:

- **DingTalk**: Client ID / Client Secret
- **Feishu (Lark)**: App ID / App Secret
- **WeCom**: Bot ID / Secret
- **Slack**: Bot Token / App Token
- **Telegram**: Bot Token

Each platform can be connected or disconnected independently, with optional auto-connect on startup.

> For details, see [Remote Access Overview](/docs/remote-access/overview).

## Web Service & Gateway

Enable the gateway to access the Agent from a browser:

- **Enable or disable gateway**
- **Port** (default 3721)
- **Access token** (for authentication)

> For details, see [Web Remote Access](/docs/remote-access/web-remote).

## Email

Configure email accounts for sending and receiving mail:

- Supports Gmail, Outlook, QQ Mail, 163 Mail, and others
- Custom IMAP/SMTP servers supported

> For details, see [Email Management](/docs/office/email).

## Calendar

Configure calendar services for schedules and todos:

- Supports Google Calendar, Apple iCloud, Outlook, and others
- Uses the CalDAV protocol

> For details, see [Calendar & Todos](/docs/office/calendar).

## Skill Management

Manage the AI's extended skills:

- **Installed skills**: View and uninstall skills
- **Skill market**: Browse and install community skills

> For details, see [Skill System](/docs/ai-advanced/skill-system).

## MCP Configuration

Manage Model Context Protocol tools:

- **Add MCP servers**: Configure connection (stdio / SSE)
- **Preset templates**: One-click add for common MCP tools
- **Status**: Enable, disable, or reconnect

> For details, see [MCP Extensions](/docs/ai-advanced/mcp-extensions).

## About

View version, check for updates, and read the license.
