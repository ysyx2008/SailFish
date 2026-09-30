
<div align="center">

<pre>
███████╗ █████╗ ██╗██╗     ███████╗██╗███████╗██╗  ██╗
██╔════╝██╔══██╗██║██║     ██╔════╝██║██╔════╝██║  ██║
███████╗███████║██║██║     █████╗  ██║███████╗███████║
╚════██║██╔══██║██║██║     ██╔══╝  ██║╚════██║██╔══██║
███████║██║  ██║██║███████╗██║     ██║███████║██║  ██║
╚══════╝╚═╝  ╚═╝╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
</pre>

<img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/resources/logo.png" alt="SailFish Logo" width="80">

**SailFish**

**Your Personal Desktop Secretary**

*Not just chat — it runs your computer, reaches out first, and remembers what matters about you*

[![Build](https://github.com/ysyx2008/SailFish/actions/workflows/build-release.yml/badge.svg)](https://github.com/ysyx2008/SailFish/actions)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![en](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![cn](https://img.shields.io/badge/lang-中文-red.svg)](./README_CN.md)

[Website](https://www.sfterm.com/en/) · [Download](https://www.sfterm.com/en/#download) · [Docs](https://www.sfterm.com/en/docs/getting-started/what-is-sailfish/) · [Skill Market](https://www.sfterm.com/en/skills/)

Bring your own AI API · macOS / Windows

</div>

---

## Why a Secretary, Not Just a Tool

SailFish isn't a chatbot waiting for commands. It's a **personal secretary** living on your desktop — with its own rhythm, proactive monitoring, the ability to reach out to you, memory of who you are and what you discussed, and the power to actually operate your computer.

| Pain Point | SailFish Approach |
|------------|-------------------|
| Chat-only AI can't act | Your secretary runs commands, reads/writes files, controls the browser, sends email, and makes documents |
| Every conversation starts from zero | Three-tier memory + knowledge base: knows you, recalls past work, file archive on demand |
| You have to watch and wait | Awaken + Watch: proactive monitoring, scheduled work, push notifications |
| Tied to your desk | The same secretary via WeChat, DingTalk, Feishu, WeCom, Slack, Telegram, or the web |
| Don't know the command? | Describe it in natural language; your secretary plans and executes. Risky steps ask first |
| Intranet / offline | Private models, local Ollama, and proxies |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-welcome_en.jpg" width="800" alt="SailFish">
</p>

## Two Ways to Work, One Workspace

| Entry | Relationship | Character |
|-------|--------------|-----------|
| **Tasks** | You delegate specific work | One-off, parallel, isolated; the desktop mainstay. Queue the next message while a task is still running |
| **Reach** | Your ongoing relationship | Always-on, multi-channel; your secretary can reach out first |

Tasks come first on desktop. All IM channels flow into one Reach line — not a different bot each time.

The window is three columns: new chat, Reach, Terminal, and recent conversations on the left; the current work in the middle; artifacts on the right, gone when collapsed. Watch and Todos have their own panels.

## Core Capabilities

### It remembers

| Feature | Description |
|---------|-------------|
| 🧬 **Identity & Personality** | Your secretary has a character; a birth conversation on first launch, more “yours” the more you use it |
| 🧠 **Three-Tier Memory** | Knows your habits and facts; recalls past work on demand; the knowledge base is the archive you hand over |
| 📚 **Knowledge Base** | Documents stay on your machine and are retrieved when needed |

### It actually works

| Feature | Description |
|---------|-------------|
| 🖥️ **Local & SSH Terminal** | Operates your machine and remote servers; an SSH session can also work on local files and commands; split panes can mix local and multiple hosts; reconnects after a drop |
| 👥 **Sub-agents** | Dispatch several at once; they report back and you can follow up |
| 📁 **File Manager** | Dual-pane local and remote files, drag-and-drop transfer |
| 🌐 **Browser Bridge** | Control the Chrome / Edge / Firefox you already have open — logins preserved |
| 📦 **Artifacts** | WYSIWYG Markdown, live HTML/URL preview, screenshot follow-ups, send to phone; Word / Excel / PDF / WPS open in place |
| 💻 **Coding** | Edit a local project, check syntax, and roll back by turn; off by default, for advanced users to enable |
| 🛡️ **Safety** | Command risk levels; dangerous steps ask first; strict / relaxed / free, or “Approve for me” |

### Secretary work

| Feature | Description |
|---------|-------------|
| ✅ **Todos** | Local todos with due-soon reminders and importance sorting; hand one off into a new task |
| 📧 **Email** | Read, search, write, reply — Gmail, Outlook, QQ Mail, 163, and more |
| 📅 **Calendar** | Google, iCloud, Outlook, CalDAV — manage the schedule in natural language |
| 📊 **Office Skills** | Word, Excel, editable PowerPoint, charts, PDF; official-document styles and WPS formats |
| 🐦 **Feishu / DingTalk / WeCom** | Calendar, tasks, approvals, docs, Bitable, and other workplace skills |

### It reaches you

| Feature | Description |
|---------|-------------|
| 🌅 **Awaken** | Your secretary keeps its own rhythm and contacts you when it should |
| 👁️ **Watch & Sensors** | Heartbeat, file-watch, calendar, email, webhooks, and more; a dedicated ops panel so you see problems at a glance |
| 💬 **Multi-Channel Reach** | WeChat (scan to sign in), DingTalk, Feishu, WeCom, Slack, Telegram, web remote — one secretary |
| 🔊 **Speech** | Replies can be read aloud; speech recognition is download-on-demand so the installer stays small |

### It can grow

| Feature | Description |
|---------|-------------|
| 🛒 **Skill Market & Plugins** | One-click community skills; plugins extend tools, providers, and IM channels |
| 🔌 **Connectors (MCP)** | Databases, APIs, and other external tools; connect when enabled, load on demand |
| 🔍 **Web Search** | Bocha, Zhipu, Kimi, Tavily, Google, Jina, and more |
| 🖥️ **CLI** | `sailfish` runs the full backend headless; share desktop data or isolate with a sandbox |
| 💾 **Your data** | Full backup and restore; move the data directory to another disk; copy a redacted crash summary |
| 🔒 **Always there** | System tray and launch-at-login |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-agent-exec.png" width="800" alt="Secretary working in the local terminal">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-im.png" width="800" alt="Reach: scan WeChat to chat on your phone">
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SailFish/main/website/public/screenshot-memory.png" width="800" alt="Memory and knowledge base">
</p>

## Quick Start

### Download

Get the latest release from the [website](https://www.sfterm.com/en/#download) or [GitHub Releases](https://github.com/ysyx2008/SailFish/releases). In mainland China, the site’s Aliyun mirror is usually faster.

| Platform | Requirements | Packages |
|----------|--------------|----------|
| **macOS** | 10.15+, Intel and Apple Silicon | `.dmg` (arm64 / x64) |
| **Windows** | Windows 10 / 11, Server 2016+ | NSIS installer, plus a **portable ZIP** |

No official Linux desktop build. On Windows, if the installer fails (e.g. some Windows Server 2016 hosts), use the ZIP.

First launch on macOS may say the developer cannot be verified: System Settings → Privacy & Security → Open Anyway, or `xattr -cr /Applications/SailFish.app`.

### AI Configuration

SailFish does not ship a model — you bring an API key. Settings include one-click presets; configure several and switch anytime.

```json
{
  "name": "Daily DeepSeek",
  "apiUrl": "https://api.deepseek.com/chat/completions",
  "apiKey": "sk-xxx",
  "model": "deepseek-v4-flash-vision-exp"
}
```

**Recommended models** (Function Calling required):

- **Daily** (fast, affordable, and can see images): DeepSeek V4 Flash Vision · Qwen 3.7 Plus · Claude Sonnet 5 · Gemini 3.7 Flash
- **Complex** (long reasoning, multi-step): DeepSeek V4 Pro · GPT-5.6 · Claude Opus 5 · Grok 4.6
- **Vision** (screenshots, images, scanned PDFs): DeepSeek V4 Flash Vision (enough as the default) · Doubao Seed 2.1 · Qwen 3.7 Plus · GPT-5.6 · Gemini 3.7 Flash · Claude Sonnet 5
- **Local / offline**: Ollama (preset `qwen3.5:9b`; small context windows struggle with multi-step work)
- **More**: Zhipu GLM-5.3, Kimi K3, MiniMax M3, Mistral Large, and any OpenAI-compatible endpoint

A text-only model can be paired with a vision model: pictures go there, then conversation returns. For web search in China, Bocha, Zhipu, or Kimi all work. Step-by-step: [First setup](https://www.sfterm.com/en/docs/getting-started/first-setup/).

### Development

```bash
npm install
npm run dev              # development
npm run build:mac        # macOS package
npm run build:win        # Windows package
npm run test             # unit tests
bash electron/cli/test-cli.sh --no-ai   # CLI regression (no model calls)
```

> **Dev Windows build** (for the author’s cross-platform testing only): `npm run build:win:remote` triggers a GitHub Actions build; the artifact overwrites a fixed OSS path in 8–10 minutes. Stability is not guaranteed.
> <https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/dev/SailFish-Setup-dev.exe>

See [CONTRIBUTING.md](./CONTRIBUTING.md). Day-to-day work is on `develop`; open PRs against `develop`, not `main`.

## CLI

After install, add the `sailfish` command from Settings → Data Management. In a checkout, use `npm run sailfish` or `npm run install:cli`.

```bash
sailfish "list markdown files in this folder"
sailfish --sandbox "try this without touching desktop data"
sailfish models
sailfish --help
```

By default it shares desktop data and asks before dangerous steps (`--mode relaxed`). `--sandbox` isolates runtime data while still borrowing AI profiles and credentials. `--mode free` / `--free` skips confirmations — use with care.

Running from the repo defaults to the sandbox so desktop history is not overwritten.

## Architecture

<p align="center">
  <img src="./docs/architecture.png" width="800" alt="SailFish Architecture">
</p>

The desktop app (Electron) and the CLI share one backend. The UI renders; sessions, memory, and tool execution live in the backend. IM and web remote use that same backend — not a separate bot.

## Documentation

**For users**

- [What is SailFish](https://www.sfterm.com/en/docs/getting-started/what-is-sailfish/)
- [Install](https://www.sfterm.com/en/docs/getting-started/installation/)
- [User guide](https://www.sfterm.com/en/docs/)
- [Skill market](https://www.sfterm.com/en/skills/)
- [Data safety](https://www.sfterm.com/en/data-privacy/)
- [Changelog](./CHANGELOG.md) · [Website changelog](https://www.sfterm.com/en/changelog/)

**For developers and integrators**

- [How the Agent works](./docs/agent-architecture.md)
- [IM integration](./docs/messaging-integration.md)
- [Plugin development](./docs/plugin-dev-guide.md)
- [Contributing](./CONTRIBUTING.md)

## License

**Dual licensing**: AGPL v3.0 for open source use; commercial license available.

- ✅ Personal use, research, education
- ✅ Medical and non-profit organizations
- ✅ Enterprise internal use (≤1000 installations; modifications must be open-sourced under AGPL)
- 💼 Commercial license required for: >1000 installations, SaaS / product embedding, closed-source modifications, changing the logo or name, or removing “Support the author”

See [LICENSE](./LICENSE).

## Links

- 🌐 [Website](https://www.sfterm.com/en/)
- 📦 [GitHub](https://github.com/ysyx2008/SailFish)
- 🐛 [Issues](https://github.com/ysyx2008/SailFish/issues)
- 💬 QQ group: `1078041072`

## Acknowledgements

Built with [Electron](https://www.electronjs.org/), [Vue.js](https://vuejs.org/), [xterm.js](https://xtermjs.org/), [LanceDB](https://lancedb.com/), and many other open source projects.
