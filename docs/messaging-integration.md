# Messaging Integration Guide

This guide explains how to connect SailFish's AI Agent to Slack, Telegram, DingTalk, and Feishu (Lark), enabling you to chat with the AI directly from your messaging app.

Once connected, you can interact with the AI Agent just like chatting with a colleague — send a message, and the Agent will execute tasks on your machine and reply with the results.

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [Slack Setup](#slack-setup)
3. [Telegram Setup](#telegram-setup)
4. [DingTalk Setup](#dingtalk-setup)
5. [Feishu (Lark) Setup](#feishu-lark-setup)
6. [Connect in SailFish](#connect-in-sailfish)
7. [Usage](#usage)
8. [FAQ](#faq)

---

## How It Works

```
User sends a message in chat
       │
       ▼
  Slack/Telegram/DingTalk/Feishu server
       │ (WebSocket / Long Polling)
       ▼
  SailFish Messaging Service
       │
       ▼
  Local AI Agent processes the request
       │
       ▼
  Reply sent back via API
```

- **No public server required**: Uses WebSocket long connections or Long Polling initiated from the client side. No need to expose ports or configure domain names.
- **Messages processed locally**: All AI inference and tool calls run on your machine.
- **Independent of Gateway**: Messaging integration does not depend on the remote access (Gateway) service and can be used standalone.

---

## Slack Setup

### Step 1: Create a Slack App

1. Go to [Slack API](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**, enter your App name, and select the Workspace to install it to
3. After creation, you'll be taken to the App settings page

### Step 2: Enable Socket Mode

1. In the left menu, go to **Socket Mode**
2. Toggle on **Enable Socket Mode**
3. You'll be prompted to generate an App-Level Token — enter a token name (e.g. `socket`), select the `connections:write` scope
4. Copy the generated **App-Level Token** (starts with `xapp-`), you'll need it later in SailFish

### Step 3: Add Bot Token Scopes

Go to **OAuth & Permissions** in the left menu, and add the following **Bot Token Scopes**:

| Scope | Description |
|-------|-------------|
| `chat:write` | Send messages (for replies) |
| `files:read` | Read files |
| `files:write` | Upload and send files |
| `im:history` | Read DM message history |
| `im:read` | View DM channel info |
| `im:write` | Start DM conversations |
| `channels:history` | Read public channel message history |
| `channels:read` | View public channel info |
| `groups:history` | Read private channel message history |
| `groups:read` | View private channel info |
| `users:read` | View user info (to get sender names) |

### Step 4: Subscribe to Events

1. Go to **Event Subscriptions** in the left menu
2. Toggle on **Enable Events**
3. Under **Subscribe to bot events**, add:
   - `message.im` (receive DM messages)
   - `message.channels` (receive public channel messages)
   - `message.groups` (receive private channel messages)
4. Click **Save Changes**

### Step 5: Enable App Home Messaging

1. Go to **App Home** in the left menu
2. In the **Show Tabs** section, ensure **Messages Tab** is checked
3. Check **Allow users to send Slash commands and messages from the messages tab**

> ⚠️ This step is critical. Without it, users will see "Sending messages to this app has been turned off" when trying to DM the bot.

### Step 6: Install the App and Get Bot Token

1. Go to **Install App** in the left menu (or the top of the **OAuth & Permissions** page)
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

> If you later modify Scopes or Event Subscriptions, Slack will prompt you to **Reinstall App**. Credentials remain the same after reinstalling.

---

## Telegram Setup

Telegram is the simplest platform to set up — you only need a single Bot Token, and the entire process is done within the Telegram chat interface. No web console required.

### Step 1: Create a Bot via BotFather

1. Open your Telegram client (mobile or desktop)
2. Search for **@BotFather** and start a conversation (this is Telegram's official bot management tool)
3. Send the `/newbot` command
4. Follow the prompts to set:
   - **Bot display name** (e.g. `My Agent`, can be anything)
   - **Bot username** (must end with `bot`, e.g. `my_sf_agent_bot`, must be globally unique)
5. Once created, BotFather will return a **Bot Token** in the format `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

> Copy and save this token — you'll need it in SailFish.

### Step 2: (Optional) Allow the Bot to Join Groups

If you want to use the bot in group chats:

1. Send `/mybots` to @BotFather
2. Select the bot you just created
3. Go to **Bot Settings** → **Allow Groups?** → Select **Turn on**

> Skip this step if you only plan to use the bot in private chats.

---

## DingTalk Setup

### Step 1: Create an Internal App

1. Go to [DingTalk Open Platform](https://open-dev.dingtalk.com/) and log in with an admin account
2. Navigate to **App Development** → **Internal Development** → **Create App**
3. Fill in the app name and description, then create

### Step 2: Get Credentials

In the app details page under **Credentials & Basic Info**, copy:

- **ClientID** (also known as AppKey)
- **ClientSecret** (also known as AppSecret)

### Step 3: Add Bot Capability

1. In the left menu, find **Add App Capabilities**
2. Add the **Bot** capability
3. In the bot configuration, select **Stream Mode** (not HTTP callback mode)

### Step 4: Publish the App

1. Go to **Version Management & Release**
2. Create a version and publish
3. Internal apps typically don't require review and are available immediately after publishing

---

## Feishu (Lark) Setup

### Step 1: Create an Internal App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and log in
2. Click **Create Custom App**, fill in the app name and description
3. After creation, enter the app details page

### Step 2: Get Credentials

In the app details page under **Credentials & Basic Info**, copy:

- **App ID**
- **App Secret**

### Step 3: Add Bot Capability

1. In the left menu, find **Add App Capabilities**
2. Add the **Bot** capability

### Step 4: Enable Permissions

Go to **Permission Management** in the left menu, search for and enable these permissions:

| Permission | Description |
|------------|-------------|
| `im:message:send_as_bot` | Send messages as the app (for replies) |
| `im:message.p2p_msg:readonly` | Read DM messages sent to the bot |
| `im:message:readonly` | Read DM and group messages |
| `im:resource` | Access and upload images/files (for file sending) |

### Step 5: Connect SailFish First

Feishu requires an active long connection before allowing event subscription configuration. So you need to **connect from SailFish first**:

1. Open SailFish, go to **Settings** → **Messaging**
2. Expand the **Feishu** card, enter the App ID and App Secret from Step 2
3. Click **Connect** and wait for the status to show ✅ **Connected**

> Keep SailFish connected, then return to the Feishu Open Platform for the next steps.

### Step 6: Configure Event Subscription (Long Connection Mode)

1. Go to **Events & Callbacks** → **Event Configuration** in the left menu
2. Select **Use long connection to receive events** as the subscription method, then click **Save** (SailFish is already connected, so the platform won't report errors)
3. After saving, click **Add Event** and add:
   - **im.message.receive_v1** (receive messages)

### Step 7: Publish the App

1. Go to **Version Management & Release**
2. Create a version and submit
3. Internal review is usually fast; the app takes effect after approval

---

## Connect in SailFish

1. Open SailFish, go to **Settings** → **Messaging**
2. Expand the card for your platform (Slack / Telegram / DingTalk / Feishu)
3. Enter the credentials obtained above:
   - Slack: Bot Token (xoxb-...) + App-Level Token (xapp-...)
   - Telegram: Bot Token
   - DingTalk: ClientID + ClientSecret
   - Feishu: App ID + App Secret
4. Click **Connect** and wait for the status to show ✅ **Connected**
5. Optional: Check **Auto-connect on startup** so SailFish reconnects automatically next time

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
  - Slack uses mrkdwn format, Telegram uses Markdown, DingTalk uses Markdown messages, Feishu uses interactive cards
  - AI can send files from your machine directly to the chat (Slack limit: 1GB, Telegram: 50MB, DingTalk: 20MB, Feishu: 30MB)

### File Sending

The AI Agent can send local files via the bot. Typical use cases:

- Ask the AI to check a log file, and it can send the file directly to you
- After generating reports, screenshots, or exports, the AI sends them to the chat automatically
- When you need a config file from the server, just tell the AI "send me the xxx file"

> For Feishu, file sending works out of the box if you've enabled the `im:resource` permission as described above.

---

## FAQ

### Connection Failed

- Verify your credentials are correct (watch out for extra spaces)
- Make sure the app is published and active (DingTalk/Feishu require publishing a version, Slack requires Install to Workspace, Telegram works immediately after bot creation)
- Check that your network can reach the platform's servers

### Feishu Shows "App Has No Active Long Connection"

This is expected. You need to connect from SailFish first (Step 5) to establish a WebSocket long connection before the Feishu platform allows saving the long connection subscription configuration.

### Bot Doesn't Reply

- Confirm SailFish is running and the connection status shows "Connected"
- In group chats, you must **@mention the bot** to trigger a response
- Check that the AI model configuration in SailFish is correct

### Messages Truncated

Messaging platforms have message length limits. When Agent replies are too long, they are automatically truncated with a note indicating the content was cut off.

### Slack Shows "Sending Messages to This App Has Been Turned Off"

You need to enable **Messages Tab** and check **Allow users to send Slash commands and messages from the messages tab** in the Slack App settings under **App Home** → **Show Tabs**. See [Slack Setup Step 5](#step-5-enable-app-home-messaging).

### Credential Security

All credentials are stored locally on your device only and are never uploaded to any server. Ensure your device is secure to prevent credential leaks.
