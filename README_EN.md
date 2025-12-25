# SFTerminal

English | [中文](./README.md)

> AI-Powered Cross-Platform Terminal for DevOps Efficiency

🌐 **Official Website**: [www.sfterm.com](http://www.sfterm.com/en/)

## Introduction

SFTerminal is a modern terminal tool designed for DevOps engineers and developers. It deeply integrates traditional terminal capabilities with an AI intelligent assistant, making command-line operations more efficient and intelligent.

Unfamiliar with a command? Let AI explain it for you.
Confused by error messages? AI analyzes the cause and provides solutions.
Want to perform an operation but don't know the command? Describe it in natural language, and AI generates it for you.

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-welcome_en.png" width="900" alt="SFTerminal Welcome Page">
</p>

For enterprise users, SFTerminal is designed with intranet environments in mind: it supports privately deployed AI models and allows one-click import of Xshell session configurations for quick team onboarding and smooth migration.

## Features

### Terminal Features
- 🖥️ **Cross-Platform Support**: Full coverage for Windows, macOS, and Linux
- 🔐 **SSH Management**: Supports password and private key authentication
- 📂 **Session Groups**: Flexible group management with group-level jump host configuration
  - Create, edit, and delete groups
  - Each group can configure an independent jump host; sessions in the group automatically connect through the jump host
  - Drag-and-drop session sorting
- 📥 **Xshell Import**: One-click import of Xshell session configurations for quick migration
- 🎨 **Rich Themes**: Built-in multiple beautiful color schemes
- ⚡ **High Performance**: Based on xterm.js for smooth terminal experience

### AI Agent Mode

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-agent-exec_en.png" width="900" alt="AI Agent Execution">
</p>

- 🤖 **Automated Task Execution**: Describe tasks, and the Agent automatically plans and executes multi-step commands
- 🎭 **Agent Personality System**: Supports 16 MBTI personality types to customize Agent response style
  - INTJ, INTP, ENTJ, ENTP (Rationalists)
  - INFJ, INFP, ENFJ, ENFP (Idealists)
  - ISTJ, ISFJ, ESTJ, ESFJ (Guardians)
  - ISTP, ISFP, ESTP, ESFP (Artisans)
- 🔧 **Rich Toolset**:
  - `execute_command` - Execute shell commands, supports real-time commands like top/htop/watch/tail -f
  - `get_terminal_context` - Get terminal output, view command execution results
  - `send_control_key` - Send control keys (Ctrl+C/D/Z, etc.) to handle stuck commands
  - `read_file` / `write_file` - File read/write operations
  - `remember_info` - Remember key information with cross-session memory
  - `search_knowledge` - Search local knowledge base documents
- 🔌 **MCP Extension**: Supports Model Context Protocol for external tools and resources
- ⚠️ **Strict Mode**: Requires user confirmation before executing dangerous commands (enabled by default)
- ⏱️ **Command Timeout Control**: Configurable command execution timeout to avoid long waits
- 📜 **Task History**: Records the execution process and results of each Agent task

### MCP Extension Capabilities
- 🔗 **Protocol Support**: Full support for Model Context Protocol (MCP) standard
- 🚀 **Multiple Transports**: Supports both stdio and SSE transport modes
- 🧩 **Capability Aggregation**: Automatically aggregates tools, resources, and prompt templates from multiple MCP servers
- 📦 **Preset Templates**: Built-in configuration templates for Filesystem, GitHub, PostgreSQL, and other common MCP servers
- 🎛️ **Visual Management**: GUI for configuring and managing MCP server connections

### AI Chat Capabilities

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-analyse_en.png" width="900" alt="AI Chat">
</p>

- 💬 **Intelligent Chat**: Command explanation, error diagnosis, natural language command generation with real-time streaming response
- 📊 **Terminal Content Analysis**: Select terminal output, right-click for one-click analysis to quickly identify issues
- 📄 **Document Upload**: Upload PDF, Word, text, and other documents as AI context for document-aware answers
- 🧠 **Host Memory**: Automatically detects host information, remembers key paths and configurations across sessions for better environment understanding
- 📈 **Context Statistics**: Real-time display of token usage and context ratio to avoid exceeding limits

### Enterprise Features
- 🏢 **Intranet Friendly**: Supports configuring intranet AI API and HTTP/SOCKS proxy
- 🔒 **Data Security**: All data stored locally, supports privately deployed AI models

### Local Knowledge Base (RAG)
- 📚 **Document Import**: Supports PDF, Word, TXT, Markdown, and other formats
- 🧠 **Local Embedding**: Built-in lightweight vector model, runs completely offline without external API
- 🔍 **Semantic Search**: Intelligent retrieval based on vector similarity, understands document semantics
- 📖 **Smart Chunking**: Supports multiple chunking strategies (fixed length/paragraph/semantic)
- 📊 **Reranking Optimization**: Optional Rerank model to optimize search result ordering
- 💾 **Vector Storage**: Efficient local vector database based on LanceDB
- 🔗 **Agent Integration**: Deep integration with Agent, automatically retrieves relevant documents to assist answers

### File Management
- 📁 **Dual-Pane File Manager**: Standalone window with dual-panel file manager
  - Left-right dual-pane layout, supports local and remote file operations
  - Directory tree navigation for quick positioning
  - File preview for online text file viewing
  - File bookmarks for quick access to frequently used directories
  - Full keyboard shortcuts and context menu support
- 📂 **SFTP Sidebar**: Terminal sidebar integrated file browser, supports upload/download/preview/edit

## Tech Stack

- **Framework**: Electron 28 + Vue 3 + TypeScript
- **Terminal**: xterm.js 5.x
- **Build**: Vite 5 + electron-builder
- **State Management**: Pinia
- **Internationalization**: vue-i18n
- **AI**: OpenAI Compatible API (supports Function Calling) + MCP Protocol
- **Knowledge Base**: LanceDB + Transformers.js (Local Embedding) + BM25

## Quick Start

### Requirements

- Node.js 18+
- npm or pnpm

### Install Dependencies

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

### Build Application

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

### Quick Build (Skip Type Check)

```bash
npm run build:win:fast
npm run build:mac:fast
npm run build:linux:fast
```

## AI Configuration

SFTerminal supports OpenAI Compatible API and can connect to:

- Public Cloud Services: OpenAI, Qwen, DeepSeek, etc.
- Private Deployment: vLLM, FastChat, Ollama, etc.

### Configuration Example

Add AI configuration in settings:

```json
{
  "name": "Company Intranet Model",
  "apiUrl": "http://10.0.1.100:8080/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "qwen-72b",
  "proxy": null
}
```

### Agent Mode Requirements

Agent mode requires AI models that support **Function Calling** capability. Recommended models:
- OpenAI GPT-4 / GPT-4o / GPT-4o-mini
- Claude 3.5 Sonnet / Claude 3 Opus
- Qwen qwen-plus / qwen-max
- DeepSeek V3
- Gemini 1.5 Pro

## MCP Configuration

MCP (Model Context Protocol) allows extending Agent capabilities by connecting to external tools and resources.

### Adding MCP Servers

Add configuration in the "MCP Services" page in settings:

**stdio mode** (local process):
```json
{
  "name": "Filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "env": {}
}
```

**SSE mode** (remote service):
```json
{
  "name": "Remote Service",
  "transport": "sse",
  "url": "http://localhost:8080/sse"
}
```

### Common MCP Servers

- **Filesystem**: Local file read/write operations
- **GitHub**: GitHub repository operations (requires Token)
- **PostgreSQL**: Database query operations
- **Brave Search**: Web search capability

For more MCP servers, refer to: [MCP Servers](https://github.com/modelcontextprotocol/servers)

## Knowledge Base Configuration

The local knowledge base feature allows importing documents so the AI Agent can automatically retrieve relevant information during task execution.

### Enabling Knowledge Base

1. Open Settings → Knowledge Base
2. Enable the "Enable Knowledge Base" option
3. Wait for the local Embedding model to load

### Importing Documents

Supported document formats:
- **PDF**: Automatically extracts text content
- **Word**: Supports .doc and .docx formats
- **Text**: TXT, Markdown, code files, etc.

### Chunking Strategies

- **Fixed Length**: Evenly chunks by character count
- **Paragraph**: Maintains paragraph integrity
- **Semantic**: Intelligent splitting based on content semantics (recommended)

### Use Cases

- Import project documentation for Agent to understand project architecture and specifications
- Import operations manuals for Agent to automatically reference when handling failures
- Import API documentation to assist development and debugging

## Xshell Session Import

Supports importing existing session configurations from Xshell:

1. Click the "Import" button in the host management panel
2. Select "Import Xshell File" or "Import Xshell Directory"
3. Select `.xsh` file or Xshell Sessions directory

**Notes**:
- Supports importing single or multiple `.xsh` files
- Supports recursive import of entire directories, subdirectories automatically become groups
- Xshell Sessions directory is typically located at: `C:\Users\<Username>\Documents\NetSarang Computer\Xshell\Sessions`
- Since Xshell passwords are encrypted, you need to manually set passwords after import

## Project Structure

```
├── electron/                  # Electron Main Process
│   ├── main.ts               # Entry point
│   ├── preload.ts            # Preload script
│   └── services/             # Service layer
│       ├── agent/            # AI Agent module
│       │   ├── index.ts      # Agent service entry
│       │   ├── planner.ts    # Dynamic task planner
│       │   ├── progress-detector.ts   # Progress detector
│       │   ├── prompt-builder.ts  # Prompt builder
│       │   ├── risk-assessor.ts   # Command risk assessment
│       │   ├── tool-executor.ts   # Tool executor
│       │   ├── tools.ts      # Tool definitions
│       │   ├── i18n.ts       # Agent internationalization
│       │   └── types.ts      # Type definitions
│       ├── terminal-awareness/   # Terminal awareness module
│       │   ├── index.ts      # Awareness service entry
│       │   └── process-monitor.ts # Process state monitor
│       ├── knowledge/        # Knowledge base module
│       │   ├── index.ts      # Knowledge base service entry
│       │   ├── embedding.ts  # Embedding service
│       │   ├── storage.ts    # Vector storage (LanceDB)
│       │   ├── bm25.ts       # BM25 keyword search
│       │   ├── chunker.ts    # Document chunking
│       │   ├── reranker.ts   # Reranking
│       │   ├── crypto.ts     # Data encryption
│       │   ├── model-manager.ts   # Model management
│       │   ├── mcp-adapter.ts     # MCP adapter
│       │   └── types.ts      # Type definitions
│       ├── ai.service.ts     # AI API chat
│       ├── pty.service.ts    # Local terminal
│       ├── ssh.service.ts    # SSH connection
│       ├── sftp.service.ts   # SFTP file transfer
│       ├── unified-terminal.service.ts  # Unified terminal service
│       ├── terminal-state.service.ts    # Terminal state management
│       ├── screen-content.service.ts    # Screen content service
│       ├── command-executor.service.ts  # Command execution service
│       ├── host-profile.service.ts      # Host profile
│       ├── document-parser.service.ts   # Document parser
│       ├── mcp.service.ts        # MCP client service
│       ├── history.service.ts    # History records
│       ├── config.service.ts     # Configuration management
│       └── xshell-import.service.ts  # Xshell import
├── src/                       # Vue Renderer Process
│   ├── components/           # Components
│   │   ├── AiPanel.vue       # AI panel
│   │   ├── Terminal.vue      # Terminal component
│   │   ├── SessionManager.vue    # Session management
│   │   ├── AgentPlanView.vue     # Agent plan view
│   │   ├── FileExplorer/     # SFTP file browser
│   │   │   ├── FileExplorer.vue  # Main component
│   │   │   ├── FileList.vue      # File list
│   │   │   ├── PathBreadcrumb.vue # Path navigation
│   │   │   ├── FileContextMenu.vue # Context menu
│   │   │   └── TransferQueue.vue  # Transfer queue
│   │   ├── KnowledgeManager.vue   # Knowledge base management
│   │   └── Settings/         # Settings components
│   │       └── KnowledgeSettings.vue # Knowledge base settings
│   ├── composables/          # Composables
│   │   ├── useAgentMode.ts   # Agent mode logic
│   │   ├── useAiChat.ts      # AI chat logic
│   │   ├── useSftp.ts        # SFTP operation logic
│   │   ├── useHostProfile.ts # Host profile management
│   │   ├── useDocumentUpload.ts  # Document upload
│   │   ├── useContextStats.ts    # Context statistics
│   │   └── useMarkdown.ts    # Markdown rendering
│   ├── services/             # Frontend services
│   │   ├── terminal-screen.service.ts   # Terminal screen analysis
│   │   └── terminal-snapshot.service.ts # Terminal snapshot
│   ├── stores/               # Pinia stores
│   │   ├── terminal.ts       # Terminal state
│   │   └── config.ts         # Configuration state
│   ├── i18n/                 # Internationalization
│   │   ├── index.ts          # i18n configuration
│   │   └── locales/          # Language files
│   └── themes/               # Theme colors
├── resources/                # App icons and models
│   └── models/               # Local AI models
│       └── embedding/        # Embedding model
└── electron-builder.yml      # Build configuration
```

## Version History

### v8.4.0 (Current Version)
- 📋 **AI Rules**: Custom AI instructions and preferences
- 🌐 **Character Encoding**: SSH and local terminal support GBK, Big5, Shift_JIS, etc.
- 🔄 **Auto Update**: In-app update check, download and install
- 📊 **Session Sorting**: Sort by recently used time
- 🧠 **Smart Memory**: Enhanced memory conflict handling and knowledge base cleanup
- 🎨 **Theme Enhancement**: New Ayu Mirage and sponsor-exclusive themes (Gold, Sakura, Rosé Pine)

### v8.0.0
- 📂 **Dual-Pane File Manager**: Full-featured dual-pane file manager
  - Left-right dual-panel layout, supports local and remote file operations
  - Directory tree navigation for quick positioning
  - File preview for online text file viewing
  - Path editing and breadcrumb navigation
  - Full keyboard shortcuts support (Ctrl/Cmd+A select all, ESC cancel, etc.)
  - Context menu operations
- 🔖 **File Bookmarks**: Quick bookmark frequently used directories for one-click access
- 📋 **Plan Management Enhancement**: Support for plan archiving and clearing
- 🎨 **New Themes**: Solarized Light and GitHub Light themes
- 🖥️ **Terminal Enhancement**:
  - Right-click to open file manager
  - Enhanced terminal prompt parsing with smart current directory recognition
  - Terminal close confirmation prompt

### v7.7.0
- ⚡ **Startup Speed Optimization**: Async knowledge base loading for significantly faster startup
- 🌍 **Multi-language Enhancement**: AI response language follows interface language setting
- 📖 **English Documentation**: Added English version of README

### v7.6.0
- 🔀 **Session Sorting**: Drag-and-drop session sorting, can drag to end of group
- 💡 **Tips Enhancement**: Random tips on welcome page, click to switch to more tips

### v7.5.0
- 🔧 **Unified Terminal Service**: Abstracted common interface for PTY and SSH terminals
- 📊 **Progress Detector**: Intelligent command execution progress recognition
- 🛠️ **Agent Tool Enhancement**: Optimized tool executor and risk assessment

### v7.0.0
- 🏗️ **Architecture Refactoring**: Modular refactoring of Agent service
  - Enhanced tool executor
  - Optimized risk assessment
- 🔍 **BM25 Search**: Added keyword search support for knowledge base
- 🔐 **Data Encryption**: Encrypted storage for sensitive configurations

### v6.0.0
- 🖥️ **Screen Content Service**: Intelligent terminal screen content analysis
- 📝 **Command Execution Service**: Independent command execution management
- 🌐 **Internationalization Enhancement**: Improved Chinese and English support

### v5.0.0
- 🤖 **Agent Enhancement**:
  - Optimized task planner
  - Improved prompt builder
  - Extended toolset
- 📊 **Context Statistics**: Real-time token usage monitoring
- 🧠 **Host Profile Enhancement**: Smarter environment memory

### v4.5.0
- 🔍 **Terminal Awareness System**: Enhanced terminal state awareness
  - Comprehensive state detection: idle, busy, waiting for input, stuck
  - Smart input recognition: password, confirmation, selection, pager, editor
  - Output pattern analysis: progress bar, compilation, test, log stream
  - Stuck detection with automatic suggestions
- 🛡️ **Smart Command Handling**:
  - Four-level risk assessment (safe/moderate/dangerous/blocked)
  - Auto-correction for problematic commands (ping, apt install, etc.)
  - Auto-conversion for interactive commands (top → top -bn1)
  - Timed execution for continuous commands (tail -f, etc.)
- 📋 **Dynamic Task Planning**:
  - Task complexity analysis
  - Multiple execution strategies (default/conservative/aggressive/diagnostic)
  - Dynamic plan adjustment, step retry, alternative solutions

### v4.1.0
- 🧠 **Local Knowledge Base Enhancement**:
  - Optimized vector retrieval performance
  - Improved document chunking algorithm
  - Added `search_knowledge` tool for knowledge base search in Agent toolset

### v4.0.0
- 📚 **Local Knowledge Base (RAG)**: Brand new offline knowledge base feature
  - Built-in local Embedding model (bge-small-zh-v1.5), runs completely offline
  - Efficient vector storage and retrieval based on LanceDB
  - Supports PDF, Word, TXT, Markdown, and other document formats
  - Smart chunking strategies: fixed length, paragraph, semantic chunking
  - Optional Rerank model for optimized search results
  - Deep integration between knowledge base and Agent for automatic document retrieval

### v3.0.0
- 🔌 **MCP Protocol Support**: New Model Context Protocol extension capability
  - Support for connecting to external MCP servers to extend Agent toolset
  - Support for both stdio and SSE transport modes
  - Auto-aggregation of tools, resources, and prompt templates from multiple servers
  - Built-in preset templates for Filesystem, GitHub, PostgreSQL, etc.
  - Visual MCP server configuration and management interface

### v2.2.0
- 📁 **SFTP File Management**: Brand new visual file browser
  - Support for file/directory upload, download, delete, rename
  - Real-time transfer progress display
  - Online preview for text files
  - Path navigation and history
  - Right-click menu shortcuts

### v2.1.0
- 🔍 **Terminal State Detection**: Smart detection of command completion
- 💡 **Tips**: Added operation tip information
- 🛡️ **Strict Mode Optimization**: Fixed confirmation logic for auto-corrected commands
- 🧹 **Output Cleaning**: Unified ANSI escape sequence handling with strip-ansi library
- ⏹️ **Agent Abort Optimization**: Enhanced abort handling logic

### v2.0.0
- 🚀 New AI Agent mode supporting automated task execution
- 🔧 Rich toolset: command execution, terminal control, file operations, information memory
- ⚠️ Strict mode: dangerous command confirmation mechanism
- ⏱️ Configurable command timeout
- 📜 Agent task history records

### v1.0.0
- 🖥️ Cross-platform terminal basic features
- 🔐 SSH connection support
- 💬 AI chat assistant
- 📥 Xshell session import

## License

This project uses **Dual Licensing**:

### Open Source License: AGPL v3.0
Free use under the following scenarios, subject to all terms of [AGPL v3.0](https://www.gnu.org/licenses/agpl-3.0.html):
- ✅ Personal learning, research, daily use
- ✅ Enterprise internal use (**≤1000 installations**, modifications must be open-sourced)
- ✅ Non-profit organizations / Educational institutions
- ✅ Medical and medical research institutions

### Commercial License
Commercial authorization required for the following scenarios:
- Enterprise internal use exceeding 1000 installations
- Provided as part of a product/service
- Unwilling to open-source modified code
- Modifying the software's logo or name

For detailed and commercial terms, please see the [LICENSE](./LICENSE) file, or visit the [official website](http://www.sfterm.com/) to contact us for commercial licensing.

## Links

- 🌐 **Official Website**: [www.sfterm.com](http://www.sfterm.com/)
- 📦 **GitHub**: [https://github.com/ysyx2008/SFTerminal](https://github.com/ysyx2008/SFTerminal)
- 🐛 **Issue Tracker**: [GitHub Issues](https://github.com/ysyx2008/SFTerminal/issues)

## Acknowledgements

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/)
- [Vue.js](https://vuejs.org/)
- [node-pty](https://github.com/microsoft/node-pty)
- [ssh2](https://github.com/mscdex/ssh2)
- [LanceDB](https://lancedb.com/)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
