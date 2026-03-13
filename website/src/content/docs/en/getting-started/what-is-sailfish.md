---
title: "What is SailFish"
description: "Learn what SailFish is, what it can do for you, and how it differs from other tools"
---

# What is SailFish

SailFish is an **AI-powered smart assistant desktop application**. You describe what you want in natural language, and it autonomously plans steps, invokes tools, executes tasks, and reports results back to you.

In short: **You talk, it works.**

## What It Can Do for You

SailFish isn't just an AI chatbot. It can actually **perform operations** on your computer — run commands, manage files, send and receive emails, browse the web, and much more.

Here are some typical scenarios:

### Daily Office Work

- "Write me a meeting minutes document for attendees John and Jane" → Automatically generates a Word document
- "Check my unread emails today" → Connects to your inbox and lists unread messages
- "Create a product review meeting for tomorrow at 10 AM" → Creates the event on your calendar

### Server Management

- "Check the disk usage on my server" → Connects via SSH, runs commands, and analyzes results
- "Deploy the latest version to staging" → Plans deployment steps and executes them one by one
- "Analyze the nginx logs for anomalies" → Reads log files and provides an analysis report

### Learning Assistant

- "What does this command mean?" → Explains the command and each parameter
- "Teach me how to use Git" → Interactive teaching, learn by doing
- "Write me an automatic backup script" → Generates the script and explains each line

### Proactive Monitoring

- Set up AI to automatically report server status every morning
- Monitor log files and notify you via DingTalk/Feishu when anomalies are detected
- Automatically organize emails and push daily summaries

## Core Capabilities at a Glance

| Capability | Description |
|-----------|-------------|
| **AI Agent** | Autonomously plans and executes tasks; no need to spell out every step |
| **Terminal & SSH** | Built-in professional terminal with remote server support |
| **File Management** | Visual management of local and remote files (SFTP) |
| **Multi-Channel Access** | Desktop, DingTalk, Feishu, WeCom, Slack, Telegram, Web |
| **Awaken Mode** | AI proactively monitors and pushes notifications; no need to watch the screen |
| **Knowledge Base** | Import documents to build a private knowledge base; AI remembers what you teach it |
| **Skill Extensions** | Rich skills for email, calendar, Word, Excel, browser, and more |
| **MCP Ecosystem** | Connect databases, APIs, and external tools via standard protocol |

## How SailFish Differs from Other Tools

You may have used AI chat tools like ChatGPT and Claude, or terminal tools like Xshell and iTerm2. Here is how SailFish differs:

**Compared to AI chat tools (ChatGPT, Claude, etc.):**

- Those tools only chat; SailFish can **actually execute operations** — run commands, manage files, send emails
- SailFish connects to your real environment (computer, servers), not a sandbox
- SailFish has memory; it remembers your server configuration and habits

**Compared to terminal tools (Xshell, iTerm2, etc.):**

- Traditional terminals require you to type commands; SailFish lets you describe needs in natural language
- SailFish's AI understands context and troubleshoots autonomously
- SailFish is more than a terminal; it integrates file management, email, calendar, and other office capabilities

**In a nutshell: SailFish = AI brain + terminal hands + office skills, all in one.**

## How It Works

SailFish works like having a capable assistant at your side:

1. **You describe your need** — in natural language
2. **AI plans** — the Agent analyzes the need and breaks it into concrete steps
3. **Execute operations** — the Agent invokes tools (terminal, files, email, etc.) and executes step by step
4. **Report results** — after execution, tells you the outcome; for risky operations, asks for your confirmation first

Throughout the process, you can see what the AI is doing at any time, and interrupt or adjust. For dangerous operations (e.g., deleting files), the AI will ask for your approval first.

## What You Need to Prepare

SailFish itself is free and open source, but it **does not include a built-in AI model**. You need to provide an API Key for an AI service, like putting fuel in a car — SailFish is the car, the API is the fuel.

Don't worry; getting an API Key is simple. The next article, "First Setup," will walk you through it step by step.

Common AI providers:

- **DeepSeek** — Strong performance at low cost; recommended for beginners
- **OpenAI (GPT-4o)** — One of the most widely used AI services
- **Anthropic (Claude)** — Strong at long documents and complex reasoning
- **Ollama** — Local deployment, completely free, no API Key needed

## Next Steps

Ready to get started? Next we will guide you through:

1. [Download & Install](/docs/getting-started/installation) — Get SailFish on your computer
2. [First Setup](/docs/getting-started/first-setup) — Configure AI service so SailFish can "think"
3. [Interface Overview](/docs/getting-started/interface-overview) — Learn the main areas of the interface
4. [First Conversation](/docs/getting-started/first-conversation) — Have your first chat with the AI and complete your first task
