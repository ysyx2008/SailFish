---
title: "WeCom Integration"
description: "Connect SailFish AI Agent to WeCom (企业微信), chat with Agent in WeCom"
---

# WeCom Integration

Once WeCom (企业微信) is connected, you can chat with your AI Agent directly in WeCom and have the Agent run tasks anywhere.

## Prerequisites

- WeCom administrator access (or have an admin create the app for you)
- Access to WeCom admin console

## Setup Steps

### Step 1: Create a WeCom App

1. Log in to [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame)
2. Go to **Application Management** → **Custom Apps** → **Create Application**
3. Fill in:
   - **App name**: e.g. “SailFish Assistant”
   - **Description**: e.g. “AI assistant for servers and daily tasks”
   - **Logo**: Upload an icon
4. Set **Visibility** (departments or users who can use the app)
5. Click **Create**

### Step 2: Get Credentials

You need the following credentials:

**From the app details page**:

| Field | Description | Location |
|-------|-------------|----------|
| AgentId | Application ID | Top of app details |
| Secret | Application secret | App details, click **View** to get |

**From the My Enterprise page**:

| Field | Description | Location |
|-------|-------------|----------|
| CorpID | Enterprise ID | **My Enterprise** → **Enterprise Info** at bottom |

Keep these credentials secure.

### Step 3: Configure API Message Receiving

1. In the app details, find **API Message Receiving**
2. Choose a receiving method:

| Method | Description | Recommended |
|--------|-------------|:-----------:|
| **API long connection** | WeCom pushes to SailFish; no public IP | ✅ |
| Callback URL | Requires a public callback address | |

> **API long connection** is strongly recommended; it is easier to set up and does not require a public IP.

### Step 4: Connect SailFish

1. Open SailFish → **Settings** → **Instant Messaging**
2. Expand the WeCom card
3. Enter:
   - **BotID**: The AgentId from above
   - **Secret**: The Secret from above
4. Click **Connect**
5. Wait until status shows ✅ **Connected**

> Optional: Enable **Connect automatically on startup**.

## Using It

### Direct Chat

1. In WeCom, open **Workbench**
2. Find your app (e.g. “SailFish Assistant”)
3. Open the chat
4. Send text messages

### Group Chat

1. Add the app bot to a group
2. @mention the bot and type your message
3. The bot replies in the group

### Message Format

- **You send**: Plain text
- **Agent replies**: Markdown (headers, lists, code blocks, etc.)
- **Files**: Agent can send files (up to 20MB) to the chat

### Example

```
You: Check CPU and memory on the production server
Agent: 🔍 Checking server status...
       CPU: 45.2%
       Memory: 12.3GB / 32GB (38.4%)
       All good.
```

```
You: Download today's access log
Agent: Fetching log file...
       [Sending file: access-2026-03-13.log]
```

## FAQ

**Connection fails**
- Verify BotID (AgentId) and Secret (no extra spaces)
- Ensure API long connection is enabled in the admin console
- Ensure the network can reach WeCom servers

**Bot does not reply**
- Ensure the user is within the app’s visibility scope
- Ensure SailFish shows **Connected**
- In groups, you must @mention the bot
- Check SailFish AI model configuration

**Message formatting looks wrong**
- WeCom’s Markdown support has limits; some formats may not render perfectly
- Content is still correct; only formatting may differ

**Visibility limits**
- If colleagues cannot see the app, ask an admin to widen visibility in the app settings
