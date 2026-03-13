---
title: "First Setup"
description: "Configure AI service from scratch so SailFish can think and work"
---

# First Setup

SailFish does not include a built-in AI model — you need to configure an AI service API, like inserting a SIM card into a phone to make calls.

Don't worry; the whole process takes about **5 minutes**. Just follow the steps below.

## What is an API Key

An API Key is a secret string your AI provider gives you to verify your identity. Think of it as an "AI membership card" — with it, SailFish can call the AI service to think and answer.

Most AI services bill by usage (like mobile plans). Typical monthly costs for normal use are usually low.

## Recommended: DeepSeek

If this is your first time using an AI API, we recommend starting with **DeepSeek**:

- Simple registration, no VPN required for most regions
- Very low cost (around 1 CNY per million tokens; daily use often under 10 CNY per month)
- Strong reasoning, good enough for most tasks

> SailFish supports dozens of AI providers (OpenAI, Claude, Qwen, Gemini, etc.). You can switch or configure multiple at any time. We use DeepSeek as an example; the flow is similar for others.

## Step 1: Register for DeepSeek and Get an API Key

1. Open [DeepSeek Platform](https://platform.deepseek.com/)
2. Click **Register** in the top-right and complete registration (e.g., phone number)
3. After login, go to the console
4. In the left menu, click **API Keys**
5. Click **Create API Key** and give it a name (e.g., "SailFish")
6. **Copy the generated API Key** — the string starting with `sk-` is your key

> **Keep your API Key secure** and do not share it. If it is leaked, delete the old key in the DeepSeek console and create a new one.

7. New users often get free credits. If balance is low, top up in the **Recharge** page (minimum 10 CNY)

## Step 2: Configure in SailFish

1. Open SailFish
2. Click the **Settings** icon (gear) at the bottom-left
3. Find the **"AI Model Configuration"** section in Settings
4. Click **"Add"** (新增)
5. Select **"DeepSeek"** in the provider list — the system will fill in the API URL and default model
6. In the **API Key** field, paste the API Key you copied
7. Choose model `deepseek-chat` (usually selected by default)
8. Click **"Save"**

## Step 3: Set as Active

After saving, you will see the new configuration in the model list. Click the **"Use"** button on the right (or the checkmark icon) to make it the active model.

Setup complete! SailFish can now "think."

## Verify the Configuration

Return to the main interface and try typing something, for example:

```
Hello, please introduce yourself
```

If the AI responds normally, the configuration is successful.

**If there is no reply or an error:**

- Check that the API Key is copied completely (starts with `sk-`)
- Check that your DeepSeek account has sufficient balance
- If you are on a corporate network, you may need to configure a proxy (see "Network Proxy" below)

## Other Common Providers

Besides DeepSeek, here are other common AI providers you can configure in SailFish:

| Provider | Highlights | Recommended Model | VPN Required |
|----------|------------|-------------------|--------------|
| DeepSeek | Cost-effective, strong reasoning | deepseek-chat | No |
| Qwen | Alibaba Cloud, generous free tier | qwen-plus | No |
| OpenAI | Widely used globally | gpt-4o | Yes |
| Claude | Long documents, complex reasoning | claude-sonnet-4-6 | Yes |
| Gemini | Google | gemini-2.0-flash | Yes |
| Ollama | Local deployment, free | Choose as needed | No |

> You can configure multiple models: use a cheaper one for daily tasks (e.g., DeepSeek) and switch to a stronger one (Claude, GPT-4o) for complex work. Switch in the top model selector in SailFish.

## Local Deployment (Ollama)

If you want fully free, offline AI, you can run a model locally with Ollama:

1. Go to [ollama.com](https://ollama.com/) and download/install Ollama
2. Run `ollama run qwen2.5` in a terminal to download and start a model
3. In SailFish, add a new AI config and select the **"Ollama"** template
4. Leave API Key empty; set model to `qwen2.5`
5. Save and set as active

> Local model quality depends on your hardware. At least 16GB RAM is recommended. A GPU improves performance noticeably.

## Network Proxy

If you need a proxy to reach overseas AI services (e.g., OpenAI, Claude), you can set a proxy per AI config:

1. Edit the corresponding AI configuration
2. In the **Proxy** field, enter the proxy URL (e.g., `http://127.0.0.1:7890`)
3. Save

Proxy settings are per config — you can have DeepSeek use direct connection and OpenAI use the proxy.

## Next Step

Configuration complete! Next, [get to know the interface](/docs/getting-started/interface-overview) and learn the main areas of SailFish.
