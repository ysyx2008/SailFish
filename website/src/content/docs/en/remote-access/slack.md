---
title: "Slack Integration"
description: "Connect SailFish AI Agent to Slack and chat with the Agent in Slack"
---

# Slack Integration

Once SailFish is connected to Slack, you can chat with the AI Agent directly in your Slack workspace. Suitable for international teams or teams using Slack overseas.

## Prerequisites

- Slack workspace (free or paid)
- Workspace admin access (or have an admin install the app for you)

## Setup Steps

### Step 1: Create a Slack App

1. Open [Slack API](https://api.slack.com/apps)
2. Click "Create New App" → "From scratch"
3. Fill in:
   - **App Name**: e.g. "SailFish Agent"
   - **Workspace**: Select your workspace
4. Click "Create App"

### Step 2: Configure Socket Mode

Socket Mode lets Slack push messages over WebSocket so you do not need a public URL:

1. In the left menu, select "Socket Mode"
2. Turn on **Enable Socket Mode**
3. Create an **App-Level Token**:
   - Token Name: e.g. `sailfish-socket`
   - Scopes: select `connections:write`
   - Click Generate
4. Note the generated token (starts with `xapp-...`)

### Step 3: Configure Event Subscriptions

1. In the left menu, select "Event Subscriptions"
2. Turn on **Enable Events**
3. Under **Subscribe to bot events**, add:

| Event | Purpose |
|-------|---------|
| `message.im` | Receive direct messages |
| `message.groups` | Receive private channel messages |
| `app_mention` | Trigger when @mentioned |

4. Click "Save Changes"

### Step 4: Configure OAuth Permissions

Under "OAuth & Permissions" → "Bot Token Scopes", add:

| Permission | Purpose |
|------------|---------|
| `chat:write` | Bot sends messages |
| `files:write` | Bot sends files |
| `im:history` | Read direct message history |
| `im:read` | Read direct message list |
| `groups:history` | Read private channel message history |
| `app_mentions:read` | Read @mention messages |

### Step 5: Enable App Home Messages

> ⚠️ **This step is easy to miss.** Without it, users will see "Messaging has been turned off for this app" when direct messaging the Bot.

1. In the left menu, select "App Home"
2. Enable **Messages Tab**
3. Check **Allow users to send Slash commands and messages from the messages tab**

### Step 6: Install to Workspace

1. On the "OAuth & Permissions" page, click **Install to Workspace**
2. Review the permission list and click "Allow" to authorize
3. After installation, note the **Bot User OAuth Token** (starts with `xoxb-...`)

### Step 7: Connect SailFish

1. Open SailFish → Settings → Instant Messaging
2. Expand the "Slack" card
3. Enter both tokens:
   - **Bot Token**: `xoxb-...` (from Step 6)
   - **App Token**: `xapp-...` (from Step 2)
4. Click "Connect"
5. Wait until status shows ✅ "Connected"

## Using It

### Direct Chat

1. In the Slack left sidebar, under "Apps", find your Bot
2. Click to open the Messages tab
3. Send text messages directly

### Channels

1. Add the Bot to a channel
2. In the channel, **@SailFish Agent** and then type your message
3. The Bot will reply in the channel

### Message Format

- **What you send**: Plain text messages
- **Agent replies**: mrkdwn format (Slack Markdown variant), supports bold, code blocks, links, etc.
- **File sending**: The Agent can send files to chats (up to 1GB—more generous than other IM platforms)

### Example

```
You: Check the server disk usage
Agent: *Disk Usage Report*
       ```
       Filesystem      Size  Used  Avail  Use%
       /dev/sda1       100G   45G    55G   45%
       /dev/sdb1       500G  180G   320G   36%
       ```
       All partitions have sufficient space. ✅
```

## FAQ

**"Messaging has been turned off for this app"**
- This is the most common issue; usually because Step 5 was not completed
- Go to Slack API → App Home, enable Messages Tab and check the option to allow users to send messages

**Bot does not respond to messages**
- Ensure Socket Mode is enabled (Step 2)
- Verify both Bot Token and App Token are entered correctly
- Verify `message.im` is added under Event Subscriptions
- Ensure SailFish shows "Connected"

**Cannot see permission options during install**
- Ensure all required permissions are added under "Bot Token Scopes" (Step 4)
- After adding permissions, reinstall the app (Reinstall App)

**Bot does not reply in channels**
- Ensure the Bot has been added to the channel (type `/invite @SailFish Agent` in the channel)
- Ensure the Bot is @mentioned in your message
- Ensure `app_mention` is added under Event Subscriptions
