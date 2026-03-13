---
title: 'Data Privacy & Security'
description: 'Understand AI provider data policies to protect your sensitive information'
---

# Data Privacy & Security

As an AI Agent application, SailFish sends your conversations, terminal output, and other context to AI providers for processing. This guide helps you understand each provider's data policies so you can make informed choices.

## Why It Matters

When using SailFish, data sent to AI providers may include:

- **Terminal output** — IP addresses, file paths, process information
- **Command history** — potentially containing passwords, keys, tokens
- **Server details** — SSH connection parameters, hostnames, configurations
- **Business content** — code, logs, documents

This data is far more sensitive than typical chat conversations, making it important to understand how each provider handles it.

## Provider Policy Overview

> Information below is based on publicly available policies as of March 2026. Policies may change at any time.

### International Providers

| Provider | API Data Used for Training | Data Retention | Zero Retention Option |
|---|---|---|---|
| **Anthropic** (Claude) | **No** by default | Auto-deleted in 30 days | Available |
| **OpenAI** (GPT-4o / o3) | **No** by default (since Mar 2023) | 30 days | Available (by request) |
| **Google** (Gemini) | Paid API: **No**; Free tier: may use | 55 days | Not available |

**Common traits**:
- API data is not used for model training by default, with explicit contractual commitments
- Users own all inputs and outputs
- Transport encryption (TLS) and at-rest encryption (AES-256)

### China-based Providers

| Provider | API Data Used for Training | Opt-out Method | Policy Clarity |
|---|---|---|---|
| **DeepSeek** | May use (de-identified) | Toggle off "data optimization" | Relatively clear |
| **Doubao** (ByteDance) | May use (de-identified) | Toggle off "help improve model" | Relatively clear |
| **Ernie Bot** (Baidu) | May use after de-identification | Only "memory" requires consent; unclear for regular chats | Moderate |
| **Qwen** (Alibaba) | Not explicitly stated | Not specified | Vague |
| **GLM** (Zhipu AI) | Not explicitly stated | Not specified | Vague |
| **Kimi** (Moonshot) | May use to "improve service" | Not specified | Vague |

**Common traits**:
- Most default to "may use for training with opt-out available"
- All claim de-identification / anonymization
- API vs. consumer product policy boundaries are sometimes unclear

## Safety Ranking

From a data protection perspective, approximate safety levels for API usage:

```
Safest ──────────────────────────────────── Use with caution
Anthropic ≈ OpenAI > Google(paid) > DeepSeek ≈ Doubao > Zhipu > Baidu ≈ Qwen ≈ Kimi
```

## Legal Landscape

### China

China was among the first countries to legislate specifically on generative AI:

- **Interim Measures for Generative AI Services** (effective Aug 2023): using personal information for model training **requires user consent**; providers must not illegally retain identifiable user input
- **Personal Information Protection Law (PIPL)**: consent must be "fully informed, voluntary, and explicit"; users can withdraw consent; bundled consent is prohibited

However, a 2024 assessment found most domestic platforms still lack adequate notice and convenient opt-out mechanisms.

### European Union

- **GDPR**: data minimization and purpose limitation — data collected for one purpose cannot be repurposed for training without consent
- **EU AI Act**: fully effective August 2026, requiring training data summaries and granular user consent

### United States

- No comprehensive federal AI legislation
- California's AI Training Data Transparency Act requires disclosure of training data sources
- Over 30 states have enacted or are pursuing AI-related legislation

## Recommendations

### Choose by Security Needs

| Scenario | Recommended Approach |
|---|---|
| Finance, government, high-sensitivity | Self-host open-source models (DeepSeek, Qwen, etc.) |
| Enterprise, production servers | Anthropic / OpenAI paid API |
| Personal development, learning | Any API (ensure training opt-out is enabled) |
| Public information processing | Any provider |

### General Security Practices

1. **Prefer API over consumer products**: API data policies are generally stricter than ChatGPT, Ernie Bot app, etc.
2. **Check settings for China-based providers**: confirm that "data used for model improvement" toggles are disabled
3. **Avoid plaintext secrets**: never paste passwords, API keys, or tokens directly in conversations
4. **Review policies periodically**: privacy policies can change — review every six months

## Policy Links

| Provider | Link |
|---|---|
| OpenAI | [Enterprise Privacy](https://openai.com/policies/api-data-usage-policies) |
| Anthropic | [Privacy Policy](https://www.anthropic.com/privacy) |
| Google Gemini | [Usage Policies](https://ai.google.dev/gemini-api/docs/usage-policies) |
| DeepSeek | [Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy-2025-02-14.html) |
| Baidu Ernie | [Privacy Rules](https://yiyan.baidu.com/docUrl/EB118_infoprotect/llf9tqa4r) |
| ByteDance Doubao | [Privacy Policy](https://www.doubao.com/legal/privacy) |
| Alibaba Qwen | [Terms of Service](https://terms.alicdn.com/legal-agreement/terms/c_end_product_protocol/20231011201348415/20231011201348415.html) |
| Zhipu GLM | [Service Agreement](https://docs.bigmodel.cn/cn/terms/service-agreement) |
| Kimi / Moonshot | [Platform Terms](https://platform.moonshot.ai/docs/agreement/modeluse) |

---

*This page is based on publicly available information as of March 2026 and is provided for reference only, not as legal advice.*
