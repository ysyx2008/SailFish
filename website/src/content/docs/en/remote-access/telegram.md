---
title: "Telegram Integration"
description: "Connect SailFish AI Agent to Telegram, chat with Agent in Telegram"
---

# Telegram Integration

Telegram has the **simplest setup** among IM platforms—about 3 minutes and 2 steps.

## Prerequisites

- Telegram account
- Network access to Telegram (a proxy may be needed in some regions)

## Setup Steps

### Step 1: Create a Bot

1. In Telegram, search for **@BotFather** (official bot management tool)
2. Send `/newbot` to BotFather
3. Follow the prompts:
   - Enter a **display name** (e.g. “SailFish Assistant”)
   - Enter a **username** (must end with `bot`, e.g. `sailfish_ai_bot`)
4. After creation, BotFather returns a **Bot Token**

The token format looks like:

```
123456789:ABCdefGHI-JKLmnoPQRstUVwxyz
```

**Keep this token safe**—it is the only credential that controls the bot.

### Step 2: Connect SailFish

1. Open SailFish → **Settings** → **Instant Messaging**
2. Expand the Telegram card
3. Paste the Bot Token
4. Click **Connect**
5. Wait until status shows ✅ **Connected**

Done.

## Using It

1. In Telegram, search for your bot’s username (e.g. `sailfish_ai_bot`)
2. Click **Start** to begin
3. Send text messages

### Message Format

- **You send**: Plain text
- **Agent replies**: Markdown (code blocks, bold, etc.)
- **Files**: Agent can send files to the chat (up to 50MB)

### Example

```
You: Check server status
Agent: 🖥 Server status report
       
       CPU: 23.5% (4 cores)
       Memory: 8.2GB / 16GB (51.3%)
       Disk: 45GB / 200GB (22.5%)
       Uptime: 32 days
       
       All metrics OK ✅
```

```
You: Send the last 100 lines of /var/log/app/error.log
Agent: Fetching log...
       [Sending file: error_tail100.txt]
```

## Optional Configuration

### Customize the Bot

With @BotFather you can further customize your bot:

| Command | Purpose |
|---------|---------|
| `/setdescription` | Set bot description (shown on bot info page) |
| `/setabouttext` | Set “About” text |
| `/setuserpic` | Set bot avatar |
| `/setcommands` | Set shortcut command menu |

### Restrict Access

By default, any Telegram user who knows the bot username can message it. If you want it for personal use only, SailFish remembers the first user who chats with the bot as the owner.

### Use a Proxy

If direct connections to Telegram fail, configure a proxy in SailFish:

| Proxy type | Example |
|------------|---------|
| HTTP | `http://127.0.0.1:7890` |
| SOCKS5 | `socks5://127.0.0.1:1080` |

Set this in SailFish **Settings** → **Instant Messaging** → **Telegram**.

## FAQ

**Connection fails**
- Check the Bot Token (re-copy from BotFather if needed)
- Ensure the network can reach Telegram (try `https://api.telegram.org` in a browser)
- If blocked, configure a proxy and try again

**Bot does not reply**
- Ensure SailFish shows **Connected**
- Ensure you have clicked **Start** with the bot
- Check SailFish AI model configuration

**Message delay**
- Telegram uses long polling; typical delay is 1–3 seconds
- If delay is longer, check network or proxy stability

**Token leaked**
- Send `/revoke` to @BotFather to revoke the current token
- Generate a new token and update it in SailFish
