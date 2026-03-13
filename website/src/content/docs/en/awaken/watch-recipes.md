---
title: 'Watch Recipes'
description: 'Practical configuration examples for Awaken mode'
---

# Watch Recipes

Here are example Watch configurations for common scenarios. You can adapt them or create similar watches by describing your needs to the Agent.

## Server Health Check

**Scenario**: Regular server checks with timely alerts on issues.

```
Create a watch that:
- Runs every morning at 8:30 and afternoon at 5:00
- Checks CPU, memory, disk usage, and key service status
- If abnormal (CPU > 80%, disk > 90%, service down), notify me via DingTalk
- If everything is fine, only log in-app, no notification
```

## Log Monitoring

**Scenario**: Monitor application logs and alert on serious errors.

```
Create a watch that:
- Monitors /var/log/app/error.log for changes
- When new content appears, analyze for severe errors (e.g. OOM, DB connection failure, timeout)
- If severe, notify me immediately on Feishu with error details and brief analysis
- Ignore low-priority warnings
```

## Morning Briefing

**Scenario**: Push today's key information every morning.

```
Create a watch that:
- Runs every morning at 8:00
- Includes: today's schedule, unread important email summaries, server status overview
- Delivers to me via WeCom
```

## Backup Verification

**Scenario**: Verify that automated backups ran correctly.

```
Create a watch that:
- Runs at 3:00 AM (backup script runs at 2:00)
- Checks that /backup/ has today's backup file
- Validates that backup size is reasonable (within ~20% of yesterday)
- If backup failed or looks wrong, notify me immediately on DingTalk
```

## CI/CD Notifications

**Scenario**: Use webhooks to receive CI/CD completion events.

```
Create a watch that:
- Uses Webhook trigger
- Parses deployment status from the webhook payload
- If deploy succeeded: verify app startup and notify the team on Feishu
- If deploy failed: analyze the error and suggest fixes
```

## File Change Tracking

**Scenario**: Monitor important config files for changes.

```
Create a watch that:
- Monitors /etc/nginx/nginx.conf for changes
- On change, diff the content and assess impact
- Tell me what changed and if there are security concerns
```

## Configuration Tips

### Output Channel Selection

- **IM** (DingTalk, Feishu, WeCom): Urgent alerts or things you need on your phone.
- **In-app chat**: Less urgent but still useful.
- **Silent log**: When you only need records.

### Pre-check Mechanism

Before running, the AI decides whether to execute. For a log monitor, if there are no new errors, it can skip execution and avoid noisy notifications.

### Stateful Workflows

Watches can store state across runs. For example, a server health watch can compare "CPU was 50% last time, now 85%" to detect meaningful increases.
