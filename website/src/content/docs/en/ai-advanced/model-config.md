---
title: 'Model Configuration'
description: 'Manage multiple AI model configurations and advanced options'
---

# Model Configuration

SailFish supports configuring multiple AI models simultaneously. You can switch between them for different scenarios. This guide covers the full model management capabilities.

## Supported Providers

SailFish includes presets for the following providers. Selecting a template automatically fills in the API URL and default model:

| Provider | Description | Recommended Models |
|----------|-------------|-------------------|
| DeepSeek | Strong reasoning model, excellent value | deepseek-chat / deepseek-reasoner |
| Qwen | Alibaba Cloud large language model | qwen-plus / qwen-max |
| OpenAI | GPT series, industry leading | gpt-4o / gpt-4o-mini / o1 |
| Claude | Anthropic, excels at long-form text | claude-sonnet-4-6 / claude-3.5-haiku |
| Gemini | Google's model family | gemini-2.0-flash |
| Ollama | Local deployment, no API key required | All Ollama models |

Additional providers compatible with the OpenAI API are supported, including ByteDance, Zhipu, Kimi, Grok, Mistral, and others.

## Configuration Fields

| Field | Description |
|-------|-------------|
| **Name** | Custom label to distinguish configurations (e.g. "Daily DeepSeek", "Complex Tasks Claude") |
| **API URL** | Provider's API endpoint, auto-filled when using a template |
| **API Key** | Secret key from the provider; leave empty for local deployments like Ollama |
| **Model** | Model name to use (e.g. gpt-4o, deepseek-chat) |
| **Model Type** | General or Vision—affects multimodal routing |
| **Linked Vision Model** | Associate a vision-capable model with a text-only model |
| **Proxy** | Per-config HTTP/SOCKS proxy, optional |

## Multi-Model Strategy

We recommend configuring 2–3 models and switching as needed:

- **Daily use**: DeepSeek or Qwen (cost-effective, fast)
- **Complex tasks**: Claude or GPT-4o (stronger reasoning)
- **Local/offline**: Ollama (free, no internet required)

Use the model selector at the top of the conversation panel to switch anytime. The current conversation context is preserved.

## Hybrid Multimodal (Linked Vision Model)

Many powerful reasoning models (e.g. DeepSeek R1) do not accept image input, while vision models may lag in complex reasoning. SailFish's linked model feature lets you combine both strengths.

### How It Works

1. You send a message with an image or screenshot.
2. SailFish detects that the message contains an image.
3. It checks whether the current model supports vision.
4. If not → it automatically switches to the linked vision model for that request.
5. After the vision model responds, subsequent text-only messages continue with the primary model.

### Setup Steps

1. Open **Settings → AI Model Configuration**.
2. Set **Model Type** to **General** for your main text model (e.g. DeepSeek R1).
3. In **Linked Vision Model**, choose a vision-capable model (e.g. GPT-4o, Claude Sonnet).
4. Ensure **Auto Vision Model Switch** is enabled under Settings → General.

### Typical Scenarios

Primary model: DeepSeek R1; linked vision model: GPT-4o.

| Your message | Model used |
|--------------|------------|
| Text only: "Analyze this code for performance issues" | DeepSeek R1 (strong reasoning) |
| Screenshot: "How do I fix this error?" | Automatically switches to GPT-4o (can read images) |
| Follow-up: "Any other optimization suggestions?" | Back to DeepSeek R1 (text only) |

### Tips

- Choose the strongest reasoning model as primary (e.g. DeepSeek R1, o1) and a capable vision model for linked (e.g. GPT-4o, Claude Sonnet).
- If your primary model already supports vision (e.g. GPT-4o), no linked model is needed.
- Switching happens per request and does not affect conversation coherence.

## Per-Model Proxy Settings

When you need a proxy to access AI services (e.g. for certain regions):

1. Edit the corresponding AI configuration.
2. Enter the proxy URL in the **Proxy** field, e.g. `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`.
3. Save.

Proxy settings are per configuration—DeepSeek can use a direct connection while OpenAI uses a proxy, independently.
