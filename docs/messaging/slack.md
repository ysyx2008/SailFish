# Slack Setup

[中文](./slack_CN.md) | English

Follow these steps to create a Slack app and get the credentials needed for SailFish. For an overview of messaging integration, see [Messaging Integration Guide](./README.md).

---

## Step 1: Create a Slack App

1. Go to [Slack API](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**, enter your App name, and select the Workspace to install it to
3. After creation, you'll be taken to the App settings page

---

## Step 2: Enable Socket Mode

1. In the left menu, go to **Socket Mode**
2. Toggle on **Enable Socket Mode**
3. You'll be prompted to generate an App-Level Token — enter a token name (e.g. `socket`), select the `connections:write` scope
4. Copy the generated **App-Level Token** (starts with `xapp-`), you'll need it later in SailFish

---

## Step 3: Add Bot Token Scopes

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

---

## Step 4: Subscribe to Events

1. Go to **Event Subscriptions** in the left menu
2. Toggle on **Enable Events**
3. Under **Subscribe to bot events**, add:
   - `message.im` (receive DM messages)
   - `message.channels` (receive public channel messages)
   - `message.groups` (receive private channel messages)
4. Click **Save Changes**

---

## Step 5: Enable App Home Messaging

1. Go to **App Home** in the left menu
2. In the **Show Tabs** section, ensure **Messages Tab** is checked
3. Check **Allow users to send Slash commands and messages from the messages tab**

> ⚠️ This step is critical. Without it, users will see "Sending messages to this app has been turned off" when trying to DM the bot.

---

## Step 6: Install the App and Get Bot Token

1. Go to **Install App** in the left menu (or the top of the **OAuth & Permissions** page)
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

> If you later modify Scopes or Event Subscriptions, Slack will prompt you to **Reinstall App**. Credentials remain the same after reinstalling.

---

## Next Steps

In SailFish, go to **Settings** → **Remote Access**, expand the **Slack** card, and enter:

- **Bot User OAuth Token** (xoxb-...)
- **App-Level Token** (xapp-...)

Then click **Connect**. See [Connect in SailFish](./README.md#connect-in-sailfish) for full usage and FAQ.
