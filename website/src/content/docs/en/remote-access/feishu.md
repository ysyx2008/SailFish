---
title: "Feishu Integration"
description: "Connect SailFish AI Agent to Feishu and chat with the Agent in Feishu"
---

# Feishu Integration

Once SailFish is connected to Feishu, you can chat with the AI Agent directly in Feishu. Feishu supports interactive card messages, giving the best formatting and layout of all IM platforms.

## Prerequisites

- Feishu account (personal or enterprise)
- Permission to create apps on the Feishu Open Platform

## Setup Steps

### Step 1: Create a Feishu App

1. Open [Feishu Open Platform](https://open.feishu.cn/app)
2. Click "Create Enterprise Self-Built App"
3. Fill in:
   - **App Name**: e.g. "SailFish Assistant"
   - **App Description**: e.g. "AI assistant to help manage servers and daily tasks"
   - **App Icon**: Upload an icon
4. Click Create

### Step 2: Get Credentials

On the app "Credentials & Basic Info" page, note:

| Field | Description |
|-------|-------------|
| **App ID** | Unique identifier for the app |
| **App Secret** | App secret—click "Show" to view |

Keep these credentials secure.

### Step 3: Configure Event Subscription

This is the most important step. You **must** choose the **long connection** method:

1. Go to "Events & Callbacks" → "Event Configuration"
2. Set encryption strategy to **Enabled**
3. Under "Subscription Method", select **"Use long connection to receive events"**

> ⚠️ **Long connection is required.** The callback URL method needs a publicly accessible address and is more complex to configure. With the long connection method, SailFish connects to Feishu servers actively, so no public IP is needed.

### Step 4: Add Permissions and Events

**Add permissions** (under "Permissions"):

| Permission | ID | Purpose |
|------------|----|---------|
| Read messages | `im:message` | Receive user messages |
| Send messages as bot | `im:message:send_as_bot` | Agent replies |
| Read resources | `im:resource` | Handle images and other resources in messages |
| Read group info | `im:chat` | Recognize @mentions in groups |

**Add events** (under "Events & Callbacks"):

| Event | ID | Purpose |
|-------|----|---------|
| Receive messages | `im.message.receive_v1` | Receive user messages |

### Step 5: Connect SailFish First (Critical Order)

> ⚠️ Feishu requires the app to establish a long connection **before** it can be published. Configure credentials in SailFish and connect successfully first, then go back to Feishu to submit for publication.

1. Open SailFish → Settings → Instant Messaging
2. Expand the "Feishu" card
3. Enter App ID and App Secret
4. Click "Connect"
5. Wait until status shows ✅ "Connected"

> If status stays "Connecting" for a long time, check that App ID and App Secret are correct and that long connection is selected for event subscription.

### Step 6: Publish the App

1. Go back to Feishu Open Platform
2. Go to "App Publishing" → "Version Management & Release"
3. Create a new version
4. Set availability (all members or specific departments/people)
5. Submit for review

> Personal editions usually pass review automatically. Enterprise editions may require admin approval.

### Step 7: Enable the Bot

1. Under "App Capabilities" → "Bot", enable the bot
2. Fill in bot name and description

## Using It

### Direct Chat

In Feishu, search for your bot name (e.g. "SailFish Assistant"), open the conversation, and send text messages directly.

### Group Chat

1. Add the bot to a Feishu group
2. In the group, **@SailFish Assistant** and then type your message
3. The bot will reply in the group

### Message Format

Feishu replies use **interactive cards**, which provide the best layout of all IM platforms:

- Titles, body text, and code blocks are well formatted
- Tables render correctly
- Links are clickable
- Code blocks have syntax highlighting

The Agent can also send files to chats directly (up to 30MB), which is among the more generous limits on IM platforms.

### Example

```
You: Check the Web server status
Agent: [Feishu interactive card]
       🖥 Server Status Report
       ─────────────────
       CPU: 32.1% | Memory: 8.5GB/16GB
       Disk: /data 67% | Network: OK
       nginx: ✅ Running | MySQL: ✅ Running

       No error logs in the last hour
```

## FAQ

**Connection status stays "Connecting"**
- Verify App ID and App Secret are correct
- Ensure "Use long connection to receive events" is selected for event subscription (not callback URL)
- Check network connectivity to Feishu servers

**App review fails**
- Ensure all required permissions are added (Step 4)
- Ensure a long connection is established before submitting for review (Step 5 must come before Step 6)
- Check the rejection reason and add any missing information

**Bot does not reply**
- Ensure the app is published and approved
- Ensure SailFish shows "Connected"
- In group chat, you must @mention the bot
- Check that SailFish AI model configuration is working

**Message format displays incorrectly**
- Ensure you are using the latest Feishu client
- Card messages may fall back to plain text on older clients
