# DingTalk Setup

[中文](./dingtalk_CN.md) | English

Follow these steps to create a DingTalk internal app and get the credentials needed for SFTerminal. For an overview of messaging integration, see [Messaging Integration Guide](./README.md).

---

## Step 1: Create an Internal App

1. Go to [DingTalk Open Platform](https://open-dev.dingtalk.com/) and log in with an admin account
2. Navigate to **App Development** → **Internal Development** → **Create App**
3. Fill in the app name and description, then create

---

## Step 2: Get Credentials

In the app details page under **Credentials & Basic Info**, copy:

- **ClientID** (also known as AppKey)
- **ClientSecret** (also known as AppSecret)

---

## Step 3: Add Bot Capability

1. In the left menu, find **Add App Capabilities**
2. Add the **Bot** capability
3. In the bot configuration, select **Stream Mode** (not HTTP callback mode)

---

## Step 4: Publish the App

1. Go to **Version Management & Release**
2. Create a version and publish
3. Internal apps typically don't require review and are available immediately after publishing

---

## Next Steps

In SFTerminal, go to **Settings** → **Remote Access**, expand the **DingTalk** card, and enter **ClientID** and **ClientSecret**. Then click **Connect**. See [Connect in SFTerminal](./README.md#connect-in-sfterminal) for full usage and FAQ.
