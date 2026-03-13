---
title: "Model Configuration"
description: "Manage multiple AI model configurations and advanced options"
---

# Model Configuration

SailFish supports multiple AI model configurations simultaneously. You can switch between them on the fly depending on the task. This page covers all model management features.

## Supported Providers

SailFish includes preset templates for these providers — click to auto-fill the API URL and default model:

| Provider | Description | Recommended Models |
|----------|-------------|-------------------|
| DeepSeek | Chinese reasoning model, excellent value | deepseek-chat / deepseek-reasoner |
| Qwen (Tongyi) | Alibaba Cloud LLM | qwen-plus / qwen-max |
| OpenAI | GPT series, industry leader | gpt-4o / gpt-4o-mini / o1 |
| Claude | By Anthropic, strong at long text and code | claude-sonnet-4-6 / claude-3.5-haiku |
| Gemini | By Google, strong multimodal | gemini-2.0-flash |
| Ollama | Local deployment, free & offline | Any Ollama model |

Also supports Doubao, Zhipu, Kimi, Grok, Mistral, and any other provider with an OpenAI-compatible API.

> **No API Key yet?** [DeepSeek](https://platform.deepseek.com) offers free credits on sign-up, has strong models, and is the best value to get started.

## Adding a Model Configuration

1. Open Settings → AI Model Configuration
2. Click "Add"
3. Select a **provider template** (auto-fills the API URL) or enter details manually
4. Fill in the fields:

| Field | Required | Description |
|-------|:--------:|-------------|
| Name | ✅ | Custom label to distinguish configs (e.g. "Daily DeepSeek", "Complex Tasks Claude") |
| API URL | ✅ | Provider's API endpoint; auto-filled from template |
| API Key | ⚠️ | Secret key from the provider (leave blank for Ollama / local) |
| Model | ✅ | Model identifier (e.g. `gpt-4o`, `deepseek-chat`) |
| Type | ✅ | General or Vision — affects multimodal routing |
| Linked Vision Model | — | Associate a vision-capable model for image handling |
| Proxy | — | Per-config HTTP/SOCKS proxy, optional |

5. Click Save
6. Click "Use" to make this the active model

## Multi-Model Strategy

We recommend configuring 2–3 models and switching by scenario:

| Scenario | Recommended | Why |
|----------|-------------|-----|
| Everyday use | DeepSeek Chat / Qwen Plus | Cheap, fast, good at Chinese |
| Complex reasoning | DeepSeek R1 / Claude / o1 | Strong chain-of-thought reasoning |
| Image analysis | GPT-4o / Claude Sonnet / Gemini | Best vision capabilities |
| Offline use | Ollama (Qwen2.5 / Llama) | Completely free, no internet needed |

Switch models anytime using the selector at the top of the chat area — the current conversation context is preserved.

## Hybrid Multimodal (Linked Vision Model)

Many powerful reasoning models (like DeepSeek R1) don't support image input, while vision models may not match them at complex reasoning. SailFish's "linked model" feature gives you the best of both worlds.

### How It Works

1. You send a message containing an image or screenshot
2. SailFish detects the image in the message
3. Checks whether the current primary model supports vision
4. If not → automatically routes this request to the linked vision model
5. After the vision model responds, subsequent text-only messages go back to the primary model

### Setup Steps

1. Open Settings → AI Model Configuration
2. Make sure you have a vision-capable model (e.g. GPT-4o) with "Type" set to **Vision**
3. Edit your primary text model (e.g. DeepSeek R1), set "Type" to **General**
4. In the "Linked Vision Model" dropdown, select the vision model
5. Ensure "Auto Vision Model Switch" is enabled (Settings → General)

### Typical Usage

Primary model: DeepSeek R1. Linked vision model: GPT-4o.

| Your message | Model used | Reason |
|-------------|------------|--------|
| Text: "Analyze this code for performance issues" | DeepSeek R1 | Strong reasoning |
| Screenshot: "What does this error mean?" | Auto-switches to GPT-4o | Can see images |
| Follow-up: "Any other suggestions?" | Back to DeepSeek R1 | Text only |

### Tips

- Pick the strongest reasoner as primary (DeepSeek R1, o1), and the best vision model as linked (GPT-4o, Claude Sonnet)
- If your primary model already supports vision (e.g. GPT-4o), no linked model is needed
- Switching happens per-request and doesn't break conversation flow

## Proxy Settings

If you need a proxy to reach overseas AI services (OpenAI, Claude, Gemini, etc.), you can configure one per model:

1. Edit the model configuration
2. Enter the proxy address in the "Proxy" field:
   - HTTP: `http://127.0.0.1:7890`
   - SOCKS5: `socks5://127.0.0.1:1080`
3. Save

Proxy settings are per-configuration — DeepSeek can go direct while OpenAI uses a proxy, with no interference.

## Ollama (Local Deployment)

Run AI models locally for free, with no internet required:

### Install Ollama

1. Visit [ollama.com](https://ollama.com) to download and install
2. Pull a model in your terminal:

```bash
ollama pull qwen2.5:7b    # recommended for Chinese
ollama pull llama3.1:8b    # strong for English
```

### Configure in SailFish

1. Add a new AI configuration, select the Ollama template
2. API URL auto-fills to `http://localhost:11434`
3. Leave API Key blank
4. Enter the model name you pulled (e.g. `qwen2.5:7b`)

> **Note**: Local model capability depends on model size and your hardware. 7B models work well for everyday tasks; for complex operations, pair with a cloud model.

## Common Issues

**API Key entered but getting 401 errors**
- Check the key is complete (no extra spaces or missing characters)
- Confirm the account has credit/balance remaining
- Some providers require a deposit before keys work

**What model name should I enter?**
- Use the model ID from the provider's documentation (case-sensitive)
- e.g. `gpt-4o` (not `GPT-4o`), `deepseek-chat` (not `DeepSeek Chat`)

**AI behavior changed after switching models**
- Different models have very different capabilities — this is expected
- Smaller models may struggle with complex multi-step tasks
- If a task doesn't work well with the current model, try a more capable one
