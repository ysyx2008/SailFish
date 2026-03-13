---
title: 'Awaken Mode'
description: 'Set up triggers so AI proactively monitors and acts on your behalf'
---

# Awaken Mode

Awaken Mode lets the AI work proactively instead of waiting for you to send messages. You define **Watches**—configurations that tell the Agent when to run and where to deliver results. Examples: daily server status reports, instant alerts on important emails, or log monitoring that notifies you when anomalies appear.

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Watch** | A configuration that defines when to run, what to do, and where to send the result |
| **Trigger** | The condition that starts a watch—cron, interval, file change, email, calendar, webhook, etc. |
| **Sensor** | Low-level event detectors that generate triggers without using AI |
| **Output Channel** | Where results go: in-app chat, IM, system notification, or silent log |

## Supported Triggers

| Trigger Type | Description | Example |
|--------------|-------------|---------|
| Cron | Cron expression | Daily at 9:00, every Monday at 10:00 |
| Interval | Fixed interval execution | Every 30 minutes, every 2 hours |
| File change | Watch files or directories for add/change/delete | `/var/log/error.log` changes |
| Email | New email received | Emails from boss@company.com |
| Calendar | Minutes before a calendar event | 15 minutes before a meeting |
| Webhook | HTTP callback from external systems | CI/CD completion notification |
| Manual | Only from the Awaken panel | On-demand runs |

## Creating Watches

### Option 1: Via AI Conversation (Recommended)

Describe what you need in natural language; the Agent will create the watch:

```
Every morning at 9:00, check server status and notify me via DingTalk
```

```
Monitor /var/log/nginx/error.log and alert me on Feishu when new 500 errors appear
```

```
Generate a weekly summary every Friday at 4:00 PM
```

### Option 2: Awaken Panel

1. Click the Awaken icon in the left sidebar.
2. Click **New Watch**.
3. Pick a built-in template or configure from scratch.
4. Set trigger, task description, and output channel.

## Built-in Templates

SailFish provides built-in templates for common scenarios:

| Template | Function |
|----------|----------|
| Morning Briefing | Daily push of weather, schedule, important emails, and news summary |
| Calendar Event Reminder | Remind before events with relevant context |
| Smart Email Triage | Auto-classify and summarize new emails, notify for important ones |
| Log File Monitor | Monitor log changes and alert on errors or anomalies |
| Webhook Deploy Notification | Receive CI/CD webhooks, verify deployment, and notify |
| Server Health Check | Periodic checks of CPU, memory, disk, and services |
| File Change Notifier | Notify when files in a directory change |
| Deadline Reminder | Daily check of todos and reminders for approaching deadlines |
| Periodic Work Summary | Periodic summary and todo reminders based on heartbeat |

## Awaken Panel

Click the Awaken icon in the left sidebar to view:

- **Status** of all watches (running, paused, error).
- **Execution history**: When each watch ran and what it produced.
- **Sensor events**: Raw events from sensors.

You can pause, resume, edit, or delete watches from the panel.

## Tips

- Start with a template, then adjust trigger times and task descriptions.
- Watches use a separate Agent and do not affect your regular conversations.
- Set output to IM to receive notifications on your phone.
- Before running, the AI checks whether it should execute (pre-check) to avoid unnecessary runs.

For more practical examples, see [Watch Recipes](/docs/awaken/watch-recipes).
