# WeCom (WeChat Work) Setup

[中文](./wecom_CN.md) | English

WeCom uses **HTTP callback** to receive messages: your SailFish runs a small HTTP server, and WeCom sends events to a callback URL. **The callback URL must be reachable from the internet** (e.g. public IP, domain, or via ngrok/frp).

For an overview of messaging integration, see [Messaging Integration Guide](./README.md).

---

## Step 1: Create a Self-Built App

1. Log in to [WeCom Admin Console](https://work.weixin.qq.com/) (work.weixin.qq.com)
2. Go to **App Management** (应用管理) → **Application** (应用) → **Self-built** (自建)
3. Click **Create Application** (创建应用), fill in name, logo, and description, then create

---

## Step 2: Get App Credentials

On the app details page, copy:

- **AgentId** (应用 AgentId)
- **Secret** (应用 Secret)

Go to **My Enterprise** (我的企业) → **Enterprise Information** (企业信息) and copy:

- **Enterprise ID (Corp ID)** (企业ID)

---

## Step 3: Configure "Receive Messages" in WeCom

1. In the app details page, find **Receive Messages** (接收消息)
2. Set **URL** to: `http://<your-public-IP-or-domain>:<port>/wecom/callback`
   - `<port>` is the callback port you will use in SailFish (default **3722**)
   - Example: `http://203.0.113.10:3722/wecom/callback` or `https://your-domain.com/wecom/callback` if you put a reverse proxy in front
3. Click **Random** to generate **Token** and **EncodingAESKey**, or enter your own
4. **Do not click Save yet** — WeCom will verify the URL. You will save after SailFish is connected and the callback server is running (Step 5)

> The callback server is started by SailFish when you click **Connect**. Ensure the port is open on your machine and reachable from the internet (e.g. router port forwarding, or use [ngrok](https://ngrok.com/) / [frp](https://github.com/fatedier/frp) to expose it).

---

## Step 4: Enter Credentials in SailFish

1. Open SailFish, go to **Settings** → **Messaging**
2. Expand the **WeCom** card
3. Enter:
   - **Corp ID** (from Step 2)
   - **Corp Secret** (app Secret from Step 2)
   - **Agent ID** (from Step 2)
   - **Callback Token** (Token from Step 3)
   - **Callback EncodingAESKey** (EncodingAESKey from Step 3)
   - **Callback Port** (default 3722; must match the port in the callback URL)
4. Click **Connect**

SailFish will start the callback HTTP server and fetch an access token to verify credentials. Wait until the status shows ✅ **Connected**.

---

## Step 5: Save Callback URL in WeCom

1. In WeCom Admin Console, go back to **Receive Messages** for your app
2. Confirm the URL is `http://<your-public-IP-or-domain>:<callbackPort>/wecom/callback`
3. Click **Save**

WeCom will send a GET request to verify the URL. SailFish will respond using your Token and EncodingAESKey. After verification succeeds, the configuration is active.

---

## EncodingAESKey Format

- WeCom requires a **43-character Base64** string (A-Za-z0-9+/).
- You can use the **Random** button in WeCom console to generate one, or generate your own and paste the same value into SailFish.

---

## Next Steps

Keep SailFish running and connected. Optional: check **Auto-connect on startup**. See [Connect in SailFish](./README.md#connect-in-sailfish) and [Usage](./README.md#usage) for full details.

### Deep Integration (WeCom Skill) Permissions

If you want the Agent to not only send/receive messages but also manage WeCom contacts, calendar, approvals, and attendance data, you need to enable additional permissions.

WeCom OA-related APIs require authorization in specific **system apps** within the admin console — enter each system app and add your self-built app to the "Apps allowed to call API" list:

| Feature | Authorization Path | Notes |
|---------|-------------------|-------|
| Contacts | Admin Console → Contacts → Organization → API Permissions | Usually enabled by default |
| Calendar | Admin Console → App Management → Calendar → Apps allowed to call API → **Edit** | May need to enable "Calendar" in App Management first |
| Approval | Admin Console → App Management → Approval → Apps allowed to call API → **Edit** | Enables querying approval records and submitting requests |
| Attendance | Admin Console → App Management → Check-in → Apps allowed to call API → **Edit** | Enables querying member check-in data |

Additionally, API calls require your public egress IP to be added to **"Trusted Enterprise IPs"** in the self-built app details (check your IP with `curl ifconfig.me`). The callback URL must be configured first (Steps 3-5) before adding trusted IPs.

---

### File Sending

WeCom supports file sending; single file limit is **20MB**.

### FAQ: Callback Not Receiving Messages

- Ensure the callback URL is reachable from the internet (test with a browser or `curl` from another network).
- If you are behind NAT, use port forwarding or a tunnel (ngrok/frp) and use that URL in WeCom.
- Ensure SailFish is connected and the callback port is not blocked by firewall.
