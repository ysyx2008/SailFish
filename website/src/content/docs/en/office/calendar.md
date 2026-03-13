---
title: "Calendar & Tasks"
description: "Configure calendar so AI can manage your schedule and to-do items"
---

# Calendar & Tasks

After configuring your calendar, the AI can view your schedule, create events, and set reminders—like a personal assistant.

## Configure Calendar

### Step 1: Open Settings

Go to **Settings** → **Calendar**

### Step 2: Choose Calendar Service

SailFish connects to calendar services via CalDAV. Supported providers:

| Service | CalDAV URL | Notes |
|---------|------------|-------|
| Apple iCloud | `https://caldav.icloud.com` | Requires app-specific password |
| Google Calendar | `https://www.googleapis.com/caldav/v2` | Requires app password or OAuth |
| Outlook 365 | `https://outlook.office365.com/CalDAV` | Use Microsoft account |
| NextCloud | Your NextCloud URL + `/remote.php/dav` | Use NextCloud account |
| Synology Calendar | NAS URL + `/caldav.php` | Use DSM account |

### Step 3: Enter Credentials

| Field | Description |
|-------|-------------|
| CalDAV server URL | The URL from the table above |
| Username | Account name for the calendar service |
| Password | Account password or app-specific password |

#### How to Obtain Credentials

**Apple iCloud**:
1. Log in to [Apple ID account management](https://appleid.apple.com)
2. Under "Sign-In and Security" → "App-Specific Passwords", generate a new password
3. Username: Your Apple ID (email)
4. Password: The generated app-specific password

**Google Calendar**:
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Create an "App password", select "Calendar" as the app type
3. Username: Your Gmail address
4. Password: The generated app-specific password

**Outlook 365**:
- Username: Your Microsoft account email
- Password: Your Microsoft account password

### Step 4: Sync Calendar

After configuration, click **Sync**. SailFish will:

1. Connect to the calendar server
2. Retrieve your calendar list
3. Sync schedule data

On success, your calendar list and upcoming events will appear.

## Using Calendar Features

### View Schedule

```
What do I have scheduled today?
```

```
Am I free Wednesday afternoon?
```

```
What meetings do I have this week?
```

```
List next week's schedule
```

### Create Events

```
Create a "Product Review" meeting tomorrow at 3 PM, 1 hour
```

```
Schedule a "Requirements Discussion" Monday at 10 AM, location B栋 3F Meeting Room
```

```
Create a recurring event: every Friday 2–3 PM, "Team Weekly Sync"
```

### Modify and Delete

```
Move tomorrow afternoon's meeting to the next morning
```

```
Cancel Friday's Team Weekly Sync
```

### Schedule Analysis

```
How much of my time this month is spent in meetings?
```

```
Were there any days in the last two weeks with meetings back-to-back for over 3 hours?
```

## With Awaken Mode

Calendar combined with Awaken Mode enables smart reminders and preparation:

### Daily Schedule Push

```
Create a Watch: every day at 8 AM, push today's schedule to Feishu.
If there's nothing scheduled, skip the push
```

### Pre-Meeting Reminders

```
Create a Watch: 15 minutes before any meeting,
prepare a summary of relevant materials and remind me on DingTalk
```

### Schedule Conflict Detection

```
Create a Watch: every evening at 8 PM, check tomorrow's schedule.
If there are conflicts, notify me on Telegram
```

## Troubleshooting

**Sync fails — "Authentication failed"**
- iCloud: Use an app-specific password, not your Apple ID password
- Google: Use an app-specific password
- Ensure the username is your full email address

**Sync fails — "Connection refused"**
- Verify the CalDAV URL is correct
- Check that your network can reach the calendar server
- Google and iCloud may require a proxy in some environments

**Calendar list is empty**
- Confirm the account actually has calendars (at least one default)
- Some services require creating a calendar in the web interface first

**Created events don't show on my phone**
- Wait a few minutes for the calendar server to sync
- Check that your phone calendar app has auto-sync enabled
- Confirm you are viewing the correct calendar (the default calendar may differ from what you expect)
