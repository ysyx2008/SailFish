<div align="center">

<pre>
███████╗███████╗████████╗███████╗██████╗ ███╗   ███╗
██╔════╝██╔════╝╚══██╔══╝██╔════╝██╔══██╗████╗ ████║
███████╗█████╗     ██║   █████╗  ██████╔╝██╔████╔██║
╚════██║██╔══╝     ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║
███████║██║        ██║   ███████╗██║  ██║██║ ╚═╝ ██║
╚══════╝╚═╝        ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝
</pre>

**SFTerm**

**AI-Powered Next-Gen Terminal**

*Tell AI what you need. It plans and executes autonomously.*

[![Build](https://github.com/ysyx2008/SFTerminal/actions/workflows/build-release.yml/badge.svg)](https://github.com/ysyx2008/SFTerminal/actions)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![en](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![cn](https://img.shields.io/badge/lang-中文-red.svg)](./README_CN.md)

[Website](http://www.sfterm.com/en/) · [Download](https://github.com/ysyx2008/SFTerminal/releases) · [Documentation](./docs/)

</div>

---

## Why SFTerm?

| Pain Point | SFTerm Solution |
|------------|-----------------|
| 🤯 Don't know the command? | Describe in natural language, AI executes for you |
| 😵 Confused by errors? | AI analyzes and provides solutions |
| 🔁 Repetitive tasks? | Agent automates multi-step operations |
| 🏢 Intranet restrictions? | Supports private AI models and proxies |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-welcome_en.png" width="800" alt="SFTerm">
</p>

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **AI Agent** | Describe tasks, Agent plans and executes automatically |
| 🖥️ **SSH/SFTP** | Full remote connection and file management |
| 📁 **File Manager** | Dual-pane file manager for local & remote |
| 📚 **Knowledge Base** | Local RAG, completely offline |
| 🔌 **MCP Extension** | Connect external tools via Model Context Protocol |
| 🗄️ **Database** | Natural language SQL execution and analysis |
| 📊 **Excel/Word** | Document processing skills |
| 🌐 **Browser** | Web automation with Playwright |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-agent-exec_en.png" width="800" alt="AI Agent">
</p>

## 🚀 Quick Start

### Download

Get the latest release from [GitHub Releases](https://github.com/ysyx2008/SFTerminal/releases) or [Official Website](http://www.sfterm.com/en/).

### Development

```bash
# Install dependencies
npm install

# Start development
npm run dev

# Build
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

### AI Configuration

SFTerm supports OpenAI-compatible APIs. Configure in Settings:

```json
{
  "name": "Your AI",
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "gpt-4o"
}
```

**Recommended models for Agent mode** (requires Function Calling):
- OpenAI GPT-4o / GPT-4o-mini
- Claude 4.5 Sonnet
- DeepSeek V3
- Qwen qwen-plus / qwen-max

## 📖 Documentation

- [Agent Architecture](./docs/agent-architecture.md)
- [Roadmap](./docs/ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)

## 📄 License

**Dual Licensing**: AGPL v3.0 for open source use, commercial license available.

- ✅ Personal use, research, education
- ✅ Enterprise internal use (≤1000 installations, modifications must be open-sourced)
- 💼 Commercial license required for: >1000 installations, SaaS/product integration, closed-source modifications

See [LICENSE](./LICENSE) for details.

## 🔗 Links

- 🌐 [Website](http://www.sfterm.com/en/)
- 📦 [GitHub](https://github.com/ysyx2008/SFTerminal)
- 🐛 [Issues](https://github.com/ysyx2008/SFTerminal/issues)

## 🙏 Acknowledgements

Built with [Electron](https://www.electronjs.org/), [Vue.js](https://vuejs.org/), [xterm.js](https://xtermjs.org/), [LanceDB](https://lancedb.com/), and many other amazing open source projects.
