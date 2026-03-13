---
title: "DingTalk Integration"
description: "Connect SailFish AI Agent to DingTalk (钉钉), chat with Agent in DingTalk"
---

# DingTalk Integration

Once DingTalk (钉钉) is connected, you can chat with your AI Agent directly in DingTalk—send a message, and the Agent runs tasks on your computer and replies.

## Prerequisites

- DingTalk account
- Access to DingTalk Open Platform

## Setup Steps

### Step 1: Create a DingTalk App

1. Open [DingTalk Open Platform](https://open-dev.dingtalk.com)
2. Log in and go to **Application Development**
3. Click **Create Application**
4. Fill in:
   - **App name**: e.g. “SailFish Assistant”
   - **Description**: e.g. “AI-powered assistant”
   - **Icon**: Upload an icon

### Step 2: Get Credentials

On the app’s **Credentials & Basic Info** page, note:

| Field | Description |
|-------|-------------|
| **ClientID** (AppKey) | Unique app identifier |
| **ClientSecret** (AppSecret) | App secret; keep it safe |

### Step 3: Enable Bot Capability

1. In the app management page, go to **App Capabilities**
2. Add the **Bot** capability
3. Configure the bot:
   - **Bot name**: e.g. “SailFish Assistant”
   - **Message receiving**: Choose **Stream mode** (long connection, no public IP needed)

> Stream mode is recommended. SailFish connects to DingTalk’s servers, so you do not need to set a callback URL or public IP.

### Step 4: Add Permissions

In **Permissions**, add as needed:

| Permission | Purpose |
|------------|---------|
| Send messages as enterprise bot | Agent replies |
| Read address book | Identify @bot in group chats |

### Step 5: Publish the App

1. In **Version Management**, create a new version
2. Set visibility (who can use the app)
3. Submit for release

> Apps created by individual developers are usually auto-approved.

### Step 6: Connect SailFish

1. Open SailFish → **Settings** → **Instant Messaging**
2. Expand the DingTalk card
3. Enter ClientID and ClientSecret
4. Click **Connect**
5. Wait until status shows ✅ **Connected**

> Optional: Enable **Connect automatically on startup**.

## Using It

### Direct Chat

In DingTalk, search for your bot (e.g. “SailFish Assistant”) and start a conversation.

### Group Chat

1. Add the bot to a DingTalk group
2. @mention the bot (e.g. **@SailFish Assistant**) and type your message
3. The bot replies in the group

### Message Format

- **You send**: Plain text
- **Agent replies**: Markdown (headers, lists, code blocks, links, etc.)
- **Files**: Agent can send files (up to 20MB) to the chat

### Example

Direct chat:

```
You: Check disk space on the server
Agent: 📊 Disk usage:
       / (root): 45.2GB / 100GB (45%)
       /data: 180GB / 500GB (36%)
       All partitions have sufficient space.
```

```
You: Check nginx error log for recent issues
Agent: Checked error.log for the last hour, found 3 errors:
       - 10:23 upstream timeout (2x)
       - 10:45 connection refused (1x)
       Consider reviewing backend response times.
```

## FAQ

**Bot does not reply**
- Ensure the app is published (status “Live” in version management)
- Ensure SailFish shows **Connected**
- In groups, you must @mention the bot
- Check SailFish AI model configuration

**Connection fails**
- Verify ClientID and ClientSecret (no extra spaces)
- Ensure Stream mode is enabled correctly
- Check that your network can reach DingTalk servers

**Messages are truncated**
- DingTalk limits message length (around 20,000 characters)
- Long Agent replies are truncated with a notice

**File send fails**
- Ensure file size is under 20MB
- Check SailFish logs for details
