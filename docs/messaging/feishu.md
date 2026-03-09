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

Go to **Permission Management** in the left menu, search for and enable the permissions below.

### IM Messaging Permissions (Required)

| Permission | Description |
|------------|-------------|
| `im:message:send_as_bot` | Send messages as the app (for replies) |
| `im:message.p2p_msg:readonly` | Read DM messages sent to the bot |
| `im:message:readonly` | Read DM and group messages |
| `im:resource` | Access and upload images/files (for file sending) |

### Deep Integration Permissions (Optional — required when using the Feishu skill)

If you want the Agent to operate on Feishu data such as Bitable, Docs, Calendar, etc. (not just send/receive messages), enable these additional permissions. Each permission typically has both read (`:readonly`) and write variants — enable as needed:

| Permission | Description |
|------------|-------------|
| `bitable:app` / `bitable:app:readonly` | Bitable: create apps, read/write records, manage fields and views |
| `docx:document` / `docx:document:readonly` | Docs: read and edit Feishu document content |
| `sheets:spreadsheet` / `sheets:spreadsheet:readonly` | Sheets: read and write cell data |
| `drive:drive` / `drive:drive:readonly` | Drive: browse folders and files, upload and download |
| `calendar:calendar` / `calendar:calendar:readonly` | Calendar: view and manage events |
| `task:task` / `task:task:readonly` | Tasks: view and manage todo tasks |
| `contact:user.base:readonly` | Contacts: read basic user info (read-only) |

> These permissions only take effect after you publish an app version (Step 8).

---

## Step 5: Configure Security Settings (Required for OAuth)

If you want the Agent to act as your personal Feishu identity (OAuth user authorization), add a redirect URL:

1. Go to **Security Settings** in the left menu
2. Add this **Redirect URL**: `http://localhost:19286/oauth/feishu/callback`
3. Save

> If you only use the app identity (default mode), you can skip this step.

---

## Step 6: Connect SailFish First

Feishu requires an active long connection before allowing event subscription configuration. So you need to **connect from SailFish first**:

1. Open SailFish, go to **Settings** → **Messaging**
2. Expand the **Feishu** card, enter the App ID and App Secret from Step 2
3. Click **Connect** and wait for the status to show ✅ **Connected**

> Keep SailFish connected, then return to the Feishu Open Platform for the next steps.

---

## Step 7: Configure Event Subscription (Long Connection Mode)

1. Go to **Events & Callbacks** → **Event Configuration** in the left menu
2. Select **Use long connection to receive events** as the subscription method, then click **Save** (SailFish is already connected, so the platform won't report errors)
3. After saving, click **Add Event** and add:
   - **im.message.receive_v1** (receive messages)

---

## Step 8: Publish the App

1. Go to **Version Management & Release**
2. Create a version and submit
3. Internal review is usually fast; the app takes effect after approval

> **Important**: Permissions from Step 4 only take effect after the app is published. If you add new permissions later, you'll need to create and publish a new version.

---

## Next Steps

Your Feishu app is ready. Keep SailFish connected; optional: check **Auto-connect on startup**. See [Connect in SailFish](./README.md#connect-in-sailfish) and [Usage](./README.md#usage) for full details.

### FAQ: "App Has No Active Long Connection"

This is expected. You must connect from SailFish first (Step 6) to establish a WebSocket long connection before the Feishu platform allows saving the long connection subscription configuration.

### File Sending

If you've enabled the `im:resource` permission as in Step 4, file sending works out of the box.
