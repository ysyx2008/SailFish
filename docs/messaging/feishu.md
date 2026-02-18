# Feishu (Lark) Setup

[中文](./feishu_CN.md) | English

Follow these steps to create a Feishu app and connect it to SailFish. For an overview of messaging integration, see [Messaging Integration Guide](./README.md).

---

## Step 1: Create an Internal App

1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and log in
2. Click **Create Custom App**, fill in the app name and description
3. After creation, enter the app details page

---

## Step 2: Get Credentials

In the app details page under **Credentials & Basic Info**, copy:

- **App ID**
- **App Secret**

---

## Step 3: Add Bot Capability

1. In the left menu, find **Add App Capabilities**
2. Add the **Bot** capability

---

## Step 4: Enable Permissions

Go to **Permission Management** in the left menu, search for and enable these permissions:

| Permission | Description |
|------------|-------------|
| `im:message:send_as_bot` | Send messages as the app (for replies) |
| `im:message.p2p_msg:readonly` | Read DM messages sent to the bot |
| `im:message:readonly` | Read DM and group messages |
| `im:resource` | Access and upload images/files (for file sending) |

---

## Step 5: Connect SailFish First

Feishu requires an active long connection before allowing event subscription configuration. So you need to **connect from SailFish first**:

1. Open SailFish, go to **Settings** → **Remote Access**
2. Expand the **Feishu** card, enter the App ID and App Secret from Step 2
3. Click **Connect** and wait for the status to show ✅ **Connected**

> Keep SailFish connected, then return to the Feishu Open Platform for the next steps.

---

## Step 6: Configure Event Subscription (Long Connection Mode)

1. Go to **Events & Callbacks** → **Event Configuration** in the left menu
2. Select **Use long connection to receive events** as the subscription method, then click **Save** (SailFish is already connected, so the platform won't report errors)
3. After saving, click **Add Event** and add:
   - **im.message.receive_v1** (receive messages)

---

## Step 7: Publish the App

1. Go to **Version Management & Release**
2. Create a version and submit
3. Internal review is usually fast; the app takes effect after approval

---

## Next Steps

Your Feishu app is ready. Keep SailFish connected; optional: check **Auto-connect on startup**. See [Connect in SailFish](./README.md#connect-in-sailfish) and [Usage](./README.md#usage) for full details.

### FAQ: "App Has No Active Long Connection"

This is expected. You must connect from SailFish first (Step 5) to establish a WebSocket long connection before the Feishu platform allows saving the long connection subscription configuration.

### File Sending

If you've enabled the `im:resource` permission as in Step 4, file sending works out of the box.
