---
title: 'Troubleshooting Guide'
description: 'Step-by-step guide to diagnose and fix SailFish issues'
---

# Troubleshooting Guide

When something goes wrong, follow these steps to narrow down the cause.

## Step 1: Check Logs

SailFish logs are the first place to look.

### Log Locations

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/SailFish/logs/` |
| Windows | `%APPDATA%/SailFish/logs/` |
| Linux | `~/.config/SailFish/logs/` |

Logs are named by date (e.g. `2026-03-13.log`). Open the latest file.

### Adjust Log Level

If logs are not detailed enough:

1. Open **Settings** → **General**
2. Set **Log level** to `debug`
3. Reproduce the issue
4. Check logs for details

> After troubleshooting, set the level back to `info` to avoid oversized log files.

## Step 2: Verify Network

Many issues stem from network problems:

### AI Model Connection

```bash
# Test access to AI services
curl https://api.deepseek.com/v1/models
curl https://api.openai.com/v1/models
```

If these fail, consider:

- Configuring a proxy (per-model proxy in settings)
- Checking VPN or proxy software

### SSH Server Connection

```bash
# Test reachability
nc -zv SERVER_IP 22

# Test SSH
ssh -v user@SERVER_IP
```

### IM Platform Connection

```bash
# Test DingTalk
curl https://api.dingtalk.com

# Test Feishu
curl https://open.feishu.cn

# Test Telegram
curl https://api.telegram.org
```

## Step 3: Check Configuration

### AI Model

In **Settings** → **AI Models**, verify:

- API URL format (include `https://`, no stray path segments)
- API Key is complete (no truncation or extra spaces)
- Model name is correct (e.g. `gpt-4o`, not `GPT-4o`)

### SSH

- Hostname / IP is correct
- Port is correct (22 by default)
- Auth method and credentials match
- Private key path exists and is valid

## Step 4: Reset & Recover

If the above steps don’t help:

### Clear Session State

Click **Clear conversation** in the chat area and start a new conversation.

### Restart the App

Quit SailFish completely (not just minimize) and start it again.

### Reset Configuration

If you suspect a bad config:

1. Quit SailFish
2. Back up your config directory (paths in the log locations table)
3. Delete the config directory
4. Start SailFish again (default config will be used)
5. Reconfigure AI models etc.

> SailFish backs up config automatically before updates. You can also restore from `backups/`.

## Step 5: Get Help

If the issue persists:

1. **GitHub Issues**: Open [SailFish Issues](https://github.com/ysyx2008/SailFish/issues) and include:
   - OS and version
   - SailFish version
   - Description and steps to reproduce
   - Relevant log excerpts (redact API keys and other secrets)

2. **QQ Group**: Join the user group `1078041072` for discussion
