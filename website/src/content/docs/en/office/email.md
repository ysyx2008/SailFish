---
title: "Email Management"
description: "Configure email so AI can send, receive, and manage messages for you"
---

# Email Management

After configuring your email account, the AI Agent can send and receive email, search messages, and help with categorization—without opening a mail client. Just talk to the AI.

## Configure Email

### Step 1: Open Settings

Go to **Settings** → **Email**

### Step 2: Choose Email Type

SailFish presets server addresses for common providers:

| Provider | IMAP Server | SMTP Server | Notes |
|----------|-------------|-------------|-------|
| Gmail | imap.gmail.com | smtp.gmail.com | Requires app password |
| Outlook / Hotmail | outlook.office365.com | smtp.office365.com | Use Microsoft account password |
| QQ Mail | imap.qq.com | smtp.qq.com | Enable IMAP and obtain authorization code |
| 163 Mail | imap.163.com | smtp.163.com | Enable IMAP and set client authorization password |
| Custom | Enter manually | Enter manually | Any IMAP/SMTP-capable provider |

### Step 3: Enter Credentials

- **Email address**: Your full email (e.g., `user@gmail.com`)
- **Password / App password**: Email password or app-specific password

#### How to Obtain App Passwords

**Gmail**:
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Under "2-Step Verification" create an "App password"
3. Choose "Mail" as the app type and generate a 16-character password
4. Use this password in SailFish, not your Google account password

**QQ Mail**:
1. Log in to QQ Mail web
2. **Settings** → **Account** → **POP3/IMAP/SMTP Service**
3. Enable "IMAP/SMTP Service"
4. Follow the SMS verification to get an authorization code
5. Use the authorization code in SailFish, not your QQ password

**163 Mail**:
1. Log in to 163 Mail web
2. **Settings** → **POP3/SMTP/IMAP**
3. Enable "IMAP/SMTP Service"
4. Set a client authorization password
5. Use this password in SailFish

### Step 4: Test Connection

Click **Test Connection** after filling in the fields. SailFish will attempt to connect to IMAP and SMTP servers to verify the setup.

> If the test fails, the most common causes are IMAP not enabled or using the login password instead of an app password.

## Using Email Features

After configuration, use AI conversation to work with email:

### View Email

```
Show my recent unread emails
```

```
Search for emails from boss@company.com
```

```
Check if there were any emails about "invoice" in the past week
```

### Send Email

```
Send an email to team@company.com with subject "Weekly Report Reminder",
reminding everyone to submit their weekly reports by Friday
```

```
Send a leave request to hr@company.com for next Monday, one day, personal leave
```

### Reply to Email

```
Reply to that last email saying I agree with the proposal, we'll start next Monday
```

```
Reply to Zhang San's email saying I received the attachment and will review it by tomorrow
```

### Email Summary

```
Summarize today's important emails
```

```
Check if there are any emails from this week that need a reply but haven't been answered
```

## With Awaken Mode

Email combined with Awaken Mode enables powerful automation:

### Urgent Email Notifications

```
Create a Watch: when an email arrives from ceo@company.com or cto@company.com,
notify me on DingTalk immediately with the email summary
```

### Automatic Email Categorization

```
Create a Watch: every 30 minutes check for new email.
If it's an alert, notify me right away.
For normal email, generate summaries and send a consolidated push at 5 PM daily
```

### Timed Email Reminders

```
Create a Watch: every Friday at 4 PM, check for unreplied emails this week
and remind me on Feishu to handle them
```

## Troubleshooting

**Connection failure — "Authentication failed"**
- QQ/163: Confirm IMAP is enabled and you are using the authorization code, not the login password
- Gmail: Confirm you are using an app-specific password
- Check that the email address is spelled correctly

**Connection failure — "Connection timeout"**
- Verify your network can reach the email servers
- Gmail and Outlook may require a proxy in some environments
- Ensure the firewall allows ports 993 (IMAP) and 465/587 (SMTP)

**Send failure**
- Some providers enforce SMTP rate limits; try again later
- Confirm the sender address matches the configured email
- Check whether attachments exceed size limits

**Slow email search**
- First search can be slow (indexing)
- Narrow the search range (e.g., time range) to speed it up
