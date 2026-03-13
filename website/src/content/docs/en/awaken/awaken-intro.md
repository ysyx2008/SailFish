---
title: "Awaken Mode"
description: "Set up triggers so AI proactively monitors and acts on your behalf"
---

# Awaken Mode

Awaken Mode turns your AI from a passive assistant into a proactive operator. You define "watches" — trigger conditions paired with tasks — and the Agent automatically executes them and delivers results. Think: automatic server health reports every morning, instant alerts when error logs spike, or weekly summary generation.

## What Is Awaken Mode?

In normal mode, the AI only works when you send a message. Awaken Mode gives it the ability to **sense events and act independently**:

| Normal Mode | Awaken Mode |
|------------|-------------|
| You ask, AI answers | AI monitors and notifies you |
| You manually check systems | Automatic scheduled inspections |
| Post-incident troubleshooting | Real-time anomaly detection |
| Repeat instructions every time | Configure once, runs continuously |

**Analogy**: Normal mode is like an assistant waiting for instructions. Awaken Mode is like having an on-call engineer watching your systems 24/7 — you set the rules, it does the watching.

## Core Concepts

### Watch

A "watch" is a monitoring configuration that defines three things:

1. **When to act** (Trigger) — schedule, file change, new email, etc.
2. **What to do** (Task prompt) — a natural-language description of what the Agent should do
3. **Where to send results** (Output channel) — IM push, in-app chat, system notification, or silent log

### Triggers

Triggers determine when a watch fires:

| Trigger Type | Description | Use Cases |
|-------------|-------------|-----------|
| Cron | Cron expression schedule | Every day at 9 AM, every Monday at 10 AM |
| Interval | Fixed time intervals | Every 30 minutes, every 2 hours |
| File change | File/directory created, modified, or deleted | Log file updated, config file changed |
| New email | New email arrives | Alert emails, important client messages |
| Calendar event | N minutes before an event starts | Meeting reminders, deadline alerts |
| Webhook | External HTTP POST callback | CI/CD completion, monitoring alerts |
| Heartbeat | Agent periodic health check | System health detection |
| Manual | Triggered only from the panel | On-demand one-off checks |

### Sensors

Sensors are the low-level event detectors. They run continuously but consume no AI resources — they only trigger an Agent execution when an event is detected.

Built-in sensors:

- **Heartbeat Sensor**: Periodic system status checks
- **File Watch Sensor**: Monitors file system changes
- **Calendar Sensor**: Detects upcoming calendar events
- **Email Sensor**: Detects new incoming emails
- **App Lifecycle Sensor**: Detects app startup/shutdown and milestone events

### Output Channels

Where watch results are delivered:

| Channel | Description | Best For |
|---------|-------------|----------|
| IM push | Send to DingTalk/Feishu/WeCom/Slack/Telegram | Urgent notifications, mobile access |
| In-app chat | Display in SailFish's chat area | Non-urgent but worth reviewing |
| System notification | OS-level notification | Brief reminders |
| Silent log | Log only, no notification | Record keeping, later analysis |

## Creating Watches

### Method 1: Talk to the Agent (Recommended)

Describe what you want in natural language and the Agent will create the watch automatically:

```
Check server status every morning at 9 AM and notify me on DingTalk.
```

```
Monitor /var/log/nginx/error.log — if new 500 errors appear, alert me on Feishu.
```

```
Every Friday at 4 PM, generate a weekly work summary and send it to WeCom.
```

The Agent understands your intent and configures the trigger, task description, and output channel automatically.

### Method 2: Awaken Panel

1. Click the **Awaken panel icon** in the left sidebar (lightbulb shape)
2. Click "New Watch"
3. Choose a built-in template for a quick start, or configure from scratch:
   - Select trigger type and parameters
   - Write the task description (what the AI should do)
   - Choose the output channel

## Built-in Templates

SailFish provides templates for common scenarios — select and create in one click:

| Template | Trigger | What It Does |
|----------|---------|-------------|
| Daily Morning Briefing | Daily schedule | Pushes weather, calendar, email summary, and news |
| Calendar Event Reminder | Before event | Smart reminders with context information |
| Email Smart Classification | New email | Auto-classifies; important emails notified instantly |
| Log File Monitoring | File change | Analyzes logs; alerts on errors |
| Server Health Check | Scheduled | Checks CPU, memory, disk, and service status |
| File Change Notification | File change | Monitors directory changes and notifies |

## The Awaken Panel

Click the Awaken icon in the sidebar to open the panel, where you can:

- **View all watches** — see status (running / paused / error)
- **Pause / Resume** — temporarily disable or re-enable a watch
- **Edit** — modify trigger conditions or task description
- **Delete** — remove watches you no longer need
- **Execution history** — see each trigger time, result, and AI analysis
- **Sensor events** — raw events detected by the underlying sensors

## Advanced Features

### Pre-check Mechanism

Before executing, the AI first evaluates whether it *should* run. For example, a log monitoring watch triggers, but the AI checks and finds no new errors — so it skips execution, avoiding unnecessary notifications.

This is called **Agency of Omission** — the AI has the authority to decide "this time, nothing needs to be done."

### Stateful Workflows

Watches remember their state across executions, enabling comparative analysis:

- Server health check: "CPU was 50% last time, now it's 85% — significant increase"
- Log monitoring: "Last checked up to line 1000, starting from line 1001 this time"
- Watches can also share state with each other for coordinated workflows

### Isolated Agent

Awaken Mode uses a dedicated Agent instance (`__watch__`), completely isolated from your regular conversations:

- Won't interfere with your ongoing chat sessions
- Has its own context and memory
- All watches execute sequentially — no concurrency conflicts

## Tips

- **Start with templates**: Pick a template and customize — much faster than building from scratch
- **Pair with IM**: Set output to an IM channel so you get notifications on your phone
- **Don't create too many watches**: More watches = more frequent AI execution; keep it manageable
- **Leverage pre-check**: Let the AI decide whether to act, reducing notification noise

> For practical configuration examples, see [Watch Recipes](/docs/awaken/watch-recipes).
