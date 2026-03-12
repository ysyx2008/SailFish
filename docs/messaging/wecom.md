# WeCom (WeChat Work) Setup

[中文](./wecom_CN.md) | English

WeCom uses **WebSocket long connection** to receive messages: SailFish connects to WeCom via the official SDK, maintaining a persistent connection. **No public IP or domain is required.**

For an overview of messaging integration, see [Messaging Integration Guide](./README.md).

---

## Step 1: Create an AI Bot

1. Open the **WeCom client** (desktop or mobile)
2. Go to **Workbench** → **AI Bot** → **Create Bot**
3. Fill in the bot name and description, then create

---

## Step 2: Enable API Mode

1. On the bot details page, find **API Mode**
2. Enable API mode and select **Long Connection**
3. Copy the **BotID** and **Secret**

---

## Step 3: Enter Credentials in SailFish

1. Open SailFish, go to **Settings** → **Messaging**
2. Expand the **WeCom** card
3. Enter:
   - **Bot ID** (from Step 2)
   - **Secret** (from Step 2)
4. Click **Connect**

SailFish will establish a WebSocket connection to WeCom. Wait until the status shows ✅ **Connected**.

---

## Next Steps

Keep SailFish running and connected. Optional: check **Auto-connect on startup**.

Both single chat and group chat are supported. In group chats, @mention the bot to trigger the Agent.

See [Connect in SailFish](./README.md#connect-in-sailfish) and [Usage](./README.md#usage) for full details.

### Deep Integration (WeCom Skill)

If you want the Agent to not only send/receive messages but also manage WeCom contacts, calendar, approvals, and attendance data, you need to create a **self-built app** (different from the AI bot above) and obtain CorpID / CorpSecret / AgentID.

WeCom skill uses enterprise internal API credentials, which are separate from the long-connection bot credentials. Skill credentials need to be configured separately in SailFish settings.

WeCom OA-related APIs require authorization in specific **system apps** within the admin console — enter each system app and add your self-built app to the "Apps allowed to call API" list:

| Feature | Authorization Path | Notes |
|---------|-------------------|-------|
| Contacts | Admin Console → Contacts → Organization → API Permissions | Usually enabled by default |
| Calendar | Admin Console → App Management → Calendar → Apps allowed to call API → **Edit** | May need to enable "Calendar" in App Management first |
| Approval | Admin Console → App Management → Approval → Apps allowed to call API → **Edit** | Enables querying approval records and submitting requests |
| Attendance | Admin Console → App Management → Check-in → Apps allowed to call API → **Edit** | Enables querying member check-in data |
