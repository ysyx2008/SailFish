# Changelog

All notable changes to SFTerm will be documented in this file.

## v10.1.0 (2026-02-16) (Latest)

### New Features
- 📨 **IM Media Message Support**: Receive images, audio, video, and file messages from Feishu and DingTalk, with automatic download and local storage
- 📤 **File & Image Sending**: Agent can now send files and images through IM channels, with proactive notification support
- 🎛️ **Control Panel**: Settings redesigned as a full-screen Control Panel with improved sub-dialog ESC key handling

### Improvements
- 🎨 **Gateway Settings UI**: Reorganized IM integration and Web service display order, removed non-standard IM icons and styles
- 🌐 **Website Repositioning**: Website content repositioned from "Terminal" to "AI Agent" branding
- 🔍 **Remote Agent Diagnostics**: Added diagnostic logging for remote Agent message display issues

### Bug Fixes
- 🔧 Fixed Agent `read_file` tool attempting to read binary media files
- 🔧 Fixed Feishu image/file download failures with correct SDK response handling
- 🔧 Fixed shell continuation prompt detection (e.g. `dquote>`) that could cause terminal to hang

## v10.0.0 (2026-02-15)

### New Features
- 🚀 **Remote Agent Access**: New Gateway service enables browser-based AI Agent interaction — access your Agent from any device via Web UI, with real-time SSE streaming and `ask_user` confirmation support
- 💬 **DingTalk Integration**: Connect DingTalk to chat with AI Agent directly in your IM app using Stream mode, supporting both private and group conversations
- 💬 **Feishu (Lark) Integration**: Connect Feishu to chat with AI Agent via WebSocket long connection, with interactive card-based Markdown replies
- 🔄 **Cross-Channel Real-Time Sync**: Replaced polling with SSE event streams for real-time synchronization across Web and IM channels
- 📋 **Audit Logging**: New desktop sync and audit log for tracking all remote Agent interactions
- 🤖 **Remote Context Awareness**: System prompts now inject remote interaction channel information for context-aware responses

### Improvements
- 🏗️ **Unified Remote Session Architecture**: Web and IM channels now share a single session, simplifying state management
- 🎨 **Remote Access Settings UI**: Redesigned settings page with improved naming and layout
- ⚡ **Stream Processing**: Optimized assistant end handling to retain streaming text blocks
- 📝 **IM Integration Guide**: Added comprehensive documentation for DingTalk and Feishu setup
- 🐟 **Rebranding**: Product renamed from "SFTerm" to "SailFish" (旗鱼)

### Bug Fixes
- 🔧 Fixed IM message duplication, SDK loading failures, and auto-connect UX issues
- 🔧 Fixed remote tab auto-rebuild after close, with PTY lifecycle managed by Gateway
- 🔧 Fixed chat page JS syntax errors and unified settings page styling
- 🔧 Fixed timer-based refresh replaced with single complete message send after stream ends
- 🔧 Fixed Gateway service cleanup on stop and variable declaration positioning

## v8.20.1 (2026-02-13)

### New Features
- 🌐 **Website Agent Skills Showcase**: Merged AI feature cards and added built-in Agent skills display on the website

### Improvements
- 📝 **Word XML Editing**: Rewritten Word editing tools to direct XML operations, preserving original document formatting
- 📝 **Word Session Cache**: Word editing now uses session-based in-memory cache, only persisting changes on save

### Bug Fixes
- 🔧 Fixed browser dual-window and login state loss by switching to persistent context
- 🔧 Fixed browser startup failure caused by residual SingletonLock files
- 🔧 Fixed browser session cookies not being preserved across restarts
- 🔧 Fixed Word HTML paragraph parsing to support unindented paragraphs and spacing before signatures

## v8.20.0 (2025-02-12)

### New Features
- 🖼️ **Image Upload**: Added image upload support for multimodal AI messages
- 🔍 **Image Preview**: Enhanced image preview with zoom and drag support
- 📸 **Browser Auto Snapshot**: Browser click/navigate/tab-switch actions now automatically include page snapshots, with human-readable action descriptions
- 📄 **Website Changelog**: Added changelog page to the website, auto-syncing CHANGELOG content

### Improvements
- 📎 Merged document and image upload buttons in AI panel for a cleaner UI
- 🔧 Simplified agent tool display, showing tool call details and skill loading information only in debug mode

### Bug Fixes
- 🔧 Fixed Word table style with cell row height being too large
- 🔧 Fixed model selection to be per-tab independent, resolving cross-terminal model misuse and ineffective switching during execution
- 🔧 Removed changelog navigation link icon on website for consistent styling

## v8.19.5

### New Features
- 📅 **Calendar Todos**: Added todo/task management support for CalDAV calendars, with automatic detection of providers that don't support todos
- 🌐 **Browser Snapshot**: Added `browser_snapshot` tool to capture page accessibility tree snapshots for better page understanding
- 📝 **Word Style Management**: Enhanced Word skill with improved style management and configuration support

### Improvements
- 🔧 Updated TypeScript configuration to support ES2020
- 🔄 Refactored calendar parameter naming and risk levels
- 🧹 Removed AI assistant quick commands

### Bug Fixes
- 🔧 Fixed calendar connection output format
- 🔧 Fixed calendar strict mode user confirmation logic
- 🔧 Fixed browser snapshot filtering to exclude invisible elements
- 🔧 Fixed browser timeout when clicking links that open new windows
- 🔧 Fixed browser snapshot ref mechanism issues
- 🔧 Fixed scheduler timer early-firing causing duplicate task execution

## v8.19.4

### New Features
- 📝 **Markdown File Opening**: Local file names now support direct click-to-open

### Improvements
- 📝 Updated scheduled task description to prevent infinite loops
- 📝 Updated local file write tool description and warning messages

## v8.19.3

### New Features
- 📊 **Excel File Reading**: Built-in file reader now supports reading Excel files (.xlsx, .xls)
- 🤖 **AI Error Messages**: Enhanced error handling with user-friendly error messages

### Improvements
- 📊 Updated Excel reading row limit and documentation
- 🔧 Optimized AI service error handling and connection timeout configuration
- 📄 File reader tool now displays the name of the file being read

### Bug Fixes
- 🔧 Fixed skill metadata duplication after user skill updates
- 🔧 Removed unnecessary onnxruntime-node dependency

## v8.19.2

### Bug Fixes
- 🔧 Fixed Chinese path paste encoding issue on Windows

## v8.19.1

### Bug Fixes
- 🔧 Updated media device permission handler to support clipboard access

## v8.19.0

### New Features
- 🛠️ **Skill Creator**: Added user skill creation module for easy custom skill development
- 📧 **Email Certificate Support**: Added support for self-signed certificates

### Improvements
- 🚀 **Simplified Setup**: Greatly simplified the setup wizard, keeping only API Key configuration
- 📧 **Email Display Optimization**: Optimized email information display format, address handling, and output summary
- 🧹 **Code Simplification**: Removed reflection mechanism code, simplified skill loading output

### Bug Fixes
- 🔧 Ensured scheduled tasks only execute in newly created tabs
- 🔧 Ensured rejectUnauthorized field has default value for old email accounts

## v8.18.3

### Bug Fixes
- 🔧 Fixed password input box unclickable issue when enabling knowledge base during first-run setup on Windows

## v8.18.2

### New Features
- 🎨 **Default Theme**: Changed default theme to blue theme
- 📊 **Task Count Display**: Scheduler now shows pending task count

### Bug Fixes
- 🔧 Fixed speech recognition not working on Windows
- 🔧 Fixed Chinese Windows path encoding issue
- 🔧 Fixed IPC structured clone error

## v8.18.1

### Improvements
- 📝 Improved schedule_create tool description to guide AI for correct instruction separation

## v8.18.0

### New Features
- ⏰ **Scheduled Tasks**: Added scheduled task feature with cron expression support for Agent execution

### Improvements
- 📝 Improved plan execution prompts to allow archiving plans when tasks complete early

## v8.17.3

### Bug Fixes
- 🔧 Prevented write_file tool from creating Word documents, only plain text allowed
- 🔧 Prevented Esc key event bubbling

### New Features
- 🎤 Added speech recognition error handling and prompt functionality

## v8.17.2

### Bug Fixes
- 🔧 Fixed Windows terminal Chinese path encoding issue
- 🔧 Fixed blank email account creation issue

### Improvements
- 📦 Cleaned unnecessary files to optimize model package

## v8.17.1

### Improvements
- 📦 Added pre-build model download script

## v8.17.0

### Speech Recognition
- 🎤 **Voice Input**: Brand new speech recognition feature for voice-to-text input
- 🗣️ **High-Quality Model**: Integrated Alibaba Fun-ASR sherpa-onnx model with Chinese/English support
- ✍️ **Punctuation Restoration**: Automatic punctuation, no manual input needed

## v8.16.0

### New Features
- 📅 **Calendar Management**: New calendar feature for viewing and managing schedules
- 🔧 **Skill Uninstall**: Skill management now supports uninstalling installed skills

## v8.15.0

### New Features
- 🎮 **Steam Support**: Added Steam version support
- 🔀 **Download Source Switch**: Support for switching software download sources

### AI Enhancements
- 🔄 **Parallel Tool Execution**: Support for parallel tool execution, improving task processing efficiency
- 📝 **Context Optimization**: Optimized conversation history context retention strategy

## v8.14.0

### Architecture Refactoring
- 🏗️ **Agent Service Refactoring**: Complete rewrite of Agent service using object-oriented approach for better maintainability
- 🔧 **Prompt Builder Class**: Refactored prompt building logic into PromptBuilder class, streamlined prompts and tool constraints
- 🗑️ **Code Cleanup**: Removed deprecated progress detector and task planner code

### AI Enhancements
- 🕐 **Time Awareness**: Added current time to AI prompts to enhance AI's temporal reasoning
- 🔄 **Network Retry Mechanism**: Added automatic retry for AI network request errors
- ⏱️ **Connection Timeout Optimization**: Increased AI request connection timeout to 60 seconds for better stability
- 🧠 **Thinking Content Display**: Enhanced AI debug features with thinking content visualization

### UI Improvements
- 🔀 **Feature Consolidation**: Merged AI Assistant and AI Chat into a unified interface
- 📊 **Debug UI Optimization**: Optimized debug interface by consolidating tool call steps for better clarity
- 🖥️ **Settings Window**: Enlarged settings window for improved visual experience
- ✨ **Streaming Output**: Optimized streaming output styles and step creation logic

### Task Management
- 💾 **Execution Plan Persistence**: Added persistence support for terminal execution plans
- 🧹 **History Memory Cleanup**: Added task history memory cleanup feature
- 📝 **Markdown Rendering**: Added Markdown rendering support in Debug Console

### Testing & Quality
- 🧪 **Unit Testing**: Added unit tests and code coverage reporting

### Bug Fixes
- Fixed tool call progress display
- Fixed task memory retrieval
- Fixed streaming conversation content not displaying
- Fixed ESC key event propagation issue
- Resolved blank plan generation issue

## v8.13.0

### User Skills System
- 🧩 **User-defined Skills**: Support for custom SKILL.md files in the skills directory
  - Compatible with Claude Skill L1+L2 standard
  - Progressive loading mechanism for better performance
  - YAML frontmatter support for skill metadata (name, description, version, enabled)
  - In-app skill management with enable/disable toggle
- 🔧 **ask_user Tool**: New tool for Agent to ask user questions when more information is needed

### AI Enhancements
- 🔍 **AI Debug Console**: New debugging interface for AI interactions
- 📏 **Context Length Check**: Automatic conversation context length monitoring
- ⏱️ **Request Timeout Handling**: Added timeout mechanism for AI requests with friendly error messages

### UI Improvements
- 📝 **Auto-resize Input**: Text input area now supports adaptive height

## v8.12.0

### Word Document Processing Skill
- 📝 New `word` skill for session-based Word document creation and editing
  - Create new documents and open existing ones
  - Add paragraphs, headings (level 1-6), lists, tables, images, page breaks
  - Insert table of contents (TOC), hyperlinks, bookmarks, comments
  - Rich styling options: font, size, bold/italic/underline, color, highlight, alignment, first-line indent
  - Built-in official document format support (Chinese government document styles)
  - Read document content (converted to Markdown format)
  - Export to PDF (requires Microsoft Word or LibreOffice)
  - Automatic backup mechanism

## v8.9.3

### New Skills
- 🌐 **Browser Automation Skill**: New `browser` skill powered by Playwright for web automation
  - Supports navigation, screenshot, click, type, scroll operations
  - Login state save/restore functionality
- 📧 **Email Management Skill**: New `email` skill with IMAP/SMTP support
  - Read, search, send, and delete emails

### Agent Tool Enhancements
- `edit_file` - Precise file editing (search & replace)
- `file_search` - Fast file search (macOS Spotlight / Windows Everything)
- `ask_user` - Ask user questions for more information
- `send_input` - Send text input to terminal
- `wait` - Wait for specified time
- `check_terminal_status` - Check terminal status

## v8.7.0

### Skills System
- 🧩 Brand new extensible skill architecture with on-demand loading
- 📊 **Excel Processing Skill**: First built-in skill for session-based Excel read/write operations
- ⚙️ Upgraded to Electron 37 for better performance and compatibility

## v8.4.0

### New Features
- 📎 **@ Mentions**: Input supports `@file` for file references and `@docs` for knowledge base documents
- 📋 **AI Rules**: Custom AI instructions and preferences
- 💬 **Chat History**: View recent sessions and continue previous conversations
- 🌐 **Character Encoding**: SSH and local terminal support GBK, Big5, Shift_JIS, etc.
- 🔄 **Auto Update**: In-app update check, download and install
- 📊 **Session Sorting**: Sort by recently used time

### Improvements
- 🤖 Embedding model upgraded to bge-small-zh-v1.5
- 🧠 Enhanced memory conflict handling
- 🎨 New Ayu Mirage theme and sponsor-exclusive themes (Gold, Sakura, Rosé Pine)

## v8.0.0

### Dual-Pane File Manager
- 📂 Full-featured dual-pane file manager
  - Left-right dual-panel layout for local and remote file operations
  - Directory tree navigation
  - File preview for text files
  - Path editing and breadcrumb navigation
  - Keyboard shortcuts support (Ctrl/Cmd+A, ESC, etc.)
  - Context menu operations
- 🔖 **File Bookmarks**: Quick bookmark frequently used directories

### Other Improvements
- 📋 Plan archiving and clearing support
- 🎨 New themes: Solarized Light, GitHub Light
- 🖥️ Right-click to open file manager, enhanced prompt parsing, close confirmation

## v7.7.0
- ⚡ Async knowledge base loading for faster startup
- 🌍 AI response language follows interface language
- 📖 Added English README

## v7.6.0
- 🔀 Drag-and-drop session sorting
- 💡 Random tips on welcome page

## v7.5.0
- 🔧 Unified terminal service abstraction
- 📊 Intelligent progress detection
- 🛠️ Optimized tool executor and risk assessment

## v7.0.0
- 🏗️ Modular Agent service refactoring
- 🔍 BM25 keyword search for knowledge base
- 🔐 Encrypted storage for sensitive configurations

## v6.0.0
- 🖥️ Screen content service for intelligent terminal analysis
- 📝 Independent command execution service
- 🌐 Improved internationalization support

## v5.0.0
- 🤖 Task planner optimization
- 📊 Real-time token usage monitoring
- 🧠 Enhanced host profile and environment memory

## v4.5.0

### Terminal Awareness System
- Comprehensive state detection: idle, busy, waiting for input, stuck
- Smart input recognition: password, confirmation, selection, pager, editor
- Output pattern analysis: progress bar, compilation, test, log stream
- Stuck detection with automatic suggestions

### Smart Command Handling
- Four-level risk assessment (safe/moderate/dangerous/blocked)
- Auto-correction for problematic commands
- Auto-conversion for interactive commands (top → top -bn1)
- Timed execution for continuous commands

### Dynamic Task Planning
- Task complexity analysis
- Multiple execution strategies (default/conservative/aggressive/diagnostic)
- Dynamic plan adjustment, step retry, alternative solutions

## v4.1.0
- 🧠 Optimized vector retrieval performance
- 📖 Improved document chunking algorithm
- 🔍 Added `search_knowledge` tool for Agent

## v4.0.0

### Local Knowledge Base (RAG)
- 📚 Brand new offline knowledge base feature
- 🧠 Built-in local Embedding model (bge-small-zh-v1.5), runs completely offline
- 💾 Efficient vector storage based on LanceDB
- 📄 Supports PDF, Word, TXT, Markdown formats
- 📖 Smart chunking strategies: fixed length, paragraph, semantic
- 🔗 Deep integration with Agent for automatic document retrieval

## v3.0.0

### MCP Protocol Support
- 🔌 Full support for Model Context Protocol (MCP) standard
- 🚀 Supports both stdio and SSE transport modes
- 🧩 Auto-aggregation of tools, resources, and prompts from multiple servers
- 📦 Built-in templates for Filesystem, GitHub, PostgreSQL, etc.
- 🎛️ Visual MCP server management interface

## v2.2.0
- 📁 Visual SFTP file browser
- 📤 File upload, download, delete, rename support
- 📊 Real-time transfer progress display
- 👁️ Text file preview

## v2.1.0
- 🔍 Smart terminal state detection
- 💡 Operation tips
- 🛡️ Strict mode optimization
- 🧹 Unified ANSI escape sequence handling
- ⏹️ Enhanced Agent abort handling

## v2.0.0
- 🚀 AI Agent mode for automated task execution
- 🔧 Rich toolset: command execution, terminal control, file operations, memory
- ⚠️ Strict mode with dangerous command confirmation
- ⏱️ Configurable command timeout
- 📜 Agent task history

## v1.0.0
- 🖥️ Cross-platform terminal features
- 🔐 SSH connection support
- 💬 AI chat assistant
- 📥 Xshell session import

