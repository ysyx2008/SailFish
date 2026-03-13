---
title: "Web Remote Access"
description: "Access SailFish Agent remotely via web browser"
---

# Web Remote Access

SailFish includes a built-in Gateway service. You can access your Agent from a web browser with a near-desktop experience. Suitable for tablets, phones, or another computer.

## Enable the Gateway

1. Open **Settings** → **Web Service**
2. Turn on **Enable Gateway**
3. Set the port (default `3721`)
4. Set an access **Token** (security credential; use at least 16 random characters)
5. Click **Save**

Once enabled, SailFish starts an HTTP server on your machine to accept browser connections.

> After the gateway starts, you can see the current access URL and status on the settings page.

## Access Methods

### Same Local Network (Simplest)

If your phone/tablet and computer are on the same Wi‑Fi or LAN:

1. Find your computer’s IP:
   - **macOS**: System Settings → Network, or run `ifconfig | grep "inet "` in a terminal
   - **Windows**: Run `ipconfig` in CMD
   - **Linux**: Run `ip addr` in a terminal
2. On your phone or tablet, open `http://YOUR_IP:3721` (e.g. `http://192.168.1.100:3721`) in a browser
3. Enter the Token to authenticate
4. Start chatting with the Agent

> **Tip**: On mobile, add the page to your home screen for an app-like experience.

### External Access

To access from outside your network (e.g. away from home or office):

#### Option 1: Tunneling (Recommended)

Expose the local port to the internet with a tunneling tool:

- **frp**: Open-source, self-hosted, for users with a server
- **ngrok**: Quick setup, free tier has traffic limits
- **花生壳 (PeanutHull)**: China-based, sign up and use
- **Cloudflare Tunnel**: Free and stable

Example with ngrok:

```bash
ngrok http 3721
```

You get a public URL (e.g. `https://xxx.ngrok-free.app`) that you can open from anywhere.

#### Option 2: Port Forwarding

Configure your router to forward an external port (e.g. 13721) to your computer’s port 3721. Then access via `http://YOUR_PUBLIC_IP:13721`.

#### Option 3: VPN

Connect via WireGuard or OpenVPN to your home/office network, then use it like local network access.

> **Security**: For external access, always:
> - Use a strong Token (at least 16 chars, mixed case and numbers)
> - Prefer HTTPS (via tunneling or reverse proxy)
> - Rotate the Token periodically

## Web Interface Features

The web remote interface is a lightweight Agent page with:

### AI Conversation

- Type messages and chat with the Agent like on desktop
- The Agent can run terminal commands, operate files, and call tools
- Supports text input only

### Real-Time Execution

- Uses SSE (Server-Sent Events) to stream Agent execution
- You see thinking, tool calls, and results in real time
- No manual refresh; content updates automatically

### Conversation History

- View previous conversations
- Cross-device—tasks started on a computer can be viewed on a phone

## Webhook Endpoint

The gateway also exposes a Webhook endpoint so external systems can trigger Awaken-mode Watches via HTTP POST.

### How to Call

```
POST http://YOUR_IP:3721/hooks/<watch-token>
```

`<watch-token>` is the unique token generated when you create a Webhook-type Watch.

### Request Body

You can send JSON in the request body; the Agent can read it when running the Watch task:

```json
{
  "event": "deploy_complete",
  "status": "success",
  "commit": "abc123"
}
```

### Common Uses

| Scenario | Approach |
|----------|----------|
| CI/CD deploy notification | GitHub Actions / Jenkins POST Webhook when pipeline finishes |
| Monitoring alert triggers investigation | Prometheus AlertManager configures Webhook to SailFish |
| Cron callback | crontab job posts to SailFish when done |
| Form submission handling | Third-party form tool triggers Agent to process |

### Example: GitHub Actions

Add to `.github/workflows/deploy.yml`:

```yaml
- name: Notify SailFish Agent
  if: always()
  run: |
    curl -X POST http://your-ip:3721/hooks/your-watch-token \
      -H "Content-Type: application/json" \
      -d '{"status": "${{ job.status }}", "commit": "${{ github.sha }}"}'
```

## Web Remote vs IM Remote

| Feature | Web Remote | IM Bot |
|---------|------------|--------|
| Public IP needed | Yes (or tunneling) | No |
| Interaction | Richer, near desktop | Mainly text |
| Real-time process | Yes (SSE streaming) | Final result only |
| Setup complexity | Low (enable and go) | Medium (create IM app) |
| Mobile experience | In browser | Native app |

> Both can be used together—IM for daily notifications and simple commands, Web for heavier tasks.
