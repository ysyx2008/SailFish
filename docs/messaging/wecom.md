# WeCom (WeChat Work) Setup

[中文](./wecom_CN.md) | English

WeCom uses **HTTP callback** to receive messages: your SFTerminal runs a small HTTP server, and WeCom sends events to a callback URL. **The callback URL must be reachable from the internet** (e.g. public IP, domain, or via ngrok/frp).

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
   - `<port>` is the callback port you will use in SFTerminal (default **3722**)
   - Example: `http://203.0.113.10:3722/wecom/callback` or `https://your-domain.com/wecom/callback` if you put a reverse proxy in front
3. Click **Random** to generate **Token** and **EncodingAESKey**, or enter your own
4. **Do not click Save yet** — WeCom will verify the URL. You will save after SFTerminal is connected and the callback server is running (Step 5)

> The callback server is started by SFTerminal when you click **Connect**. Ensure the port is open on your machine and reachable from the internet (e.g. router port forwarding, or use [ngrok](https://ngrok.com/) / [frp](https://github.com/fatedier/frp) to expose it).

---

## Step 4: Enter Credentials in SFTerminal

1. Open SFTerminal, go to **Settings** → **Remote Access**
2. Expand the **WeCom** card
3. Enter:
   - **Corp ID** (from Step 2)
   - **Corp Secret** (app Secret from Step 2)
   - **Agent ID** (from Step 2)
   - **Callback Token** (Token from Step 3)
   - **Callback EncodingAESKey** (EncodingAESKey from Step 3)
   - **Callback Port** (default 3722; must match the port in the callback URL)
4. Click **Connect**

SFTerminal will start the callback HTTP server and fetch an access token to verify credentials. Wait until the status shows ✅ **Connected**.

---

## Step 5: Save Callback URL in WeCom

1. In WeCom Admin Console, go back to **Receive Messages** for your app
2. Confirm the URL is `http://<your-public-IP-or-domain>:<callbackPort>/wecom/callback`
3. Click **Save**

WeCom will send a GET request to verify the URL. SFTerminal will respond using your Token and EncodingAESKey. After verification succeeds, the configuration is active.

---

## EncodingAESKey Format

- WeCom requires a **43-character Base64** string (A-Za-z0-9+/).
- You can use the **Random** button in WeCom console to generate one, or generate your own and paste the same value into SFTerminal.

---

## Next Steps

Keep SFTerminal running and connected. Optional: check **Auto-connect on startup**. See [Connect in SFTerminal](./README.md#connect-in-sfterminal) and [Usage](./README.md#usage) for full details.

### File Sending

WeCom supports file sending; single file limit is **20MB**.

### FAQ: Callback Not Receiving Messages

- Ensure the callback URL is reachable from the internet (test with a browser or `curl` from another network).
- If you are behind NAT, use port forwarding or a tunnel (ngrok/frp) and use that URL in WeCom.
- Ensure SFTerminal is connected and the callback port is not blocked by firewall.
