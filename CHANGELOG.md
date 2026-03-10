# Changelog

All notable changes to SailFish will be documented in this file.

## v10.16.0 (2026-03-10) (Latest)

Expanded enterprise IM capabilities with new DingTalk and WeCom resources, and added Markdown-to-Office document generation.

### New Features
- 📄 **Markdown to Office**: Agent can now generate Word and Excel documents directly from local Markdown files
- 📌 **DingTalk Expanded Resources**: Added Bitable (multi-dimensional tables), Drive (DingDisk), and Wiki (knowledge base) resource support for DingTalk skill
- 💼 **WeCom Meeting**: Added meeting management resource support for WeCom skill
- 📂 **WeCom Drive & Docs**: Added WeDrive (cloud storage) and Document resource support for WeCom skill

### Bug Fixes
- 🔧 Fixed exec tool and `systemInfo.shell` cross-platform compatibility for Windows and Linux
- 🔧 Fixed model selection popup accidentally closing on stray clicks in Settings
- 🔧 Hidden L3 conversation records from Knowledge UI to reduce clutter

## v10.15.1 (2026-03-09)

This patch release streamlines session management with a leaner UI structure and smoother editing performance on Windows, while improving compatibility with vLLM's message validation behavior.

### Improvements
- ⚡ **Session Manager Refactor**: Extracted reusable composables and consolidated duplicate CSS, reducing `SessionManager` complexity and improving maintainability
- 🪟 **Smoother Windows Editing**: Moved the session edit modal into a dedicated child component to fix input lag on Windows

### Bug Fixes
- 🔧 **vLLM Compatibility**: Adjusted AI message validation to work with vLLM inference engine request format

## v10.15.0 (2026-03-09)

Deep enterprise IM integration — DingTalk and WeCom (Enterprise WeChat) skills bring calendar, approval, attendance, contacts, and more directly into Agent workflows.

### New Features
- 📌 **DingTalk Skill**: Full DingTalk integration — calendar events, to-do lists, attendance records, contact directory, and approval workflows, all accessible via Agent tools
- 💼 **WeCom (Enterprise WeChat) Skill**: Full WeCom integration — calendar management, approval processes, check-in records, and contact directory operations

### Improvements
- 📖 Updated IM documentation with detailed Feishu, DingTalk, and WeCom deep integration guides

### Bug Fixes
- 🔧 Fixed DingTalk todo list query API path
- 🔧 Fixed DingTalk parameter validation to run before credential check, improving error messages

## v10.14.0 (2026-03-09)

Full Feishu (Lark) integration with OAuth user authorization, a new three-file identity system for deeper Agent personalization, and L3 conversation vector search for long-term memory recall.

### New Features
- 🐦 **Feishu (Lark) Skill**: Full integration with Feishu — read/write Bitable, Docs, Sheets, Calendar, Tasks, and Drive; create new Bitable apps; supports OAuth user authorization so the Agent can operate on behalf of the user
- 🧬 **Three-File Identity System**: Agent personality now driven by three workspace files — `IDENTITY.md` (who am I), `SOUL.md` (how I behave), and `USER.md` (about the user) — replacing the old config string approach
- 🧠 **L3 Conversation Vector Search**: Historical conversations are now vectorized and auto-recalled via semantic search, enabling long-term memory across sessions
- 🎂 **Birth Conversation**: On first launch, the Agent initiates an introductory conversation to get to know the user
- 💭 **Thinking Process Folding**: Reasoning model thought process streams open during generation and auto-collapses when complete
- 🖼️ **Image Preview Enhancements**: Pending images in the input box are now clickable for preview; image viewer supports ESC to close and arrow key navigation
- 📝 **Custom Assistant Tab Title**: Assistant tabs now display the user-customized Agent name
- 📚 **Website Usage Guides**: Added 7 usage guide articles to the website
- 💬 **QQ Group Entry**: Menu and settings now include a QQ community group shortcut

### Improvements
- 🔧 Unified dynamic imports to static imports, eliminating Vite build warnings
- 🔧 Migrated terminal-specific prompts into the terminal skill content block
- 🔧 Merged MBTI settings into the Soul tab with improved layout
- 🔧 Sensor cards now use CSS Grid layout for consistent sizing
- 🔧 Awakening page redesigned to showcase the three-file identity system

### Bug Fixes
- 🔧 Fixed reasoning model deduplication logic overwriting `<details>` collapsible formatting
- 🔧 Fixed network error retry race condition and task failure status display
- 🔧 Fixed `talk_to_user` tool description to prevent models from calling it during normal conversation
- 🔧 Fixed missing `tool_result` steps after skill tool execution
- 🔧 Fixed Feishu OAuth endpoint upgrade and added scope declaration to resolve Unauthorized errors
- 🔧 Fixed `soul_craft`/`user_craft` tool routing and config whitelist gaps

## v10.13.1 (2026-03-06)

Significantly reduced token overhead through prompt and tool description optimization, added auto-update mirror support and data migration framework for smoother upgrades.

### Improvements
- ⚡ **Massive Token Optimization**: Restructured system prompts, merged and streamlined tool descriptions, and compressed skill/watch summaries — substantially reducing per-request token costs
- 🔄 **Auto-Update Mirror**: Added Alibaba Cloud OSS as an alternative update source with automatic speed testing and manual switching option
- 🏗️ **Data Migration Framework**: Introduced versioned migration system with normalize layer to ensure smooth upgrades for existing users
- 📎 **Unrestricted File Upload**: Removed file format restrictions — now supports uploading any file type
- 🏷️ **Vision Model Indicator**: Model selector dropdown now shows which models support vision capabilities
- 🖼️ **ICO Image Support**: `read_file` tool now handles ICO format with improved binary file detection
- ⚙️ **Model Config Dialog**: AI model configuration moved to a dialog form for better UX

### Bug Fixes
- 🔧 Fixed rare image formats being skipped by both processing pipelines simultaneously
- 🔧 Fixed network error retry insufficiency causing Agent to prematurely conclude tasks
- 🔧 Centralized Watch vs TODO judgment rules to prevent accidental Watch creation
- 🔧 Aligned frontend supported file format list with backend `detectFileType`
- 🔧 Included file path in AI context for uploaded documents
- 🔧 Added Excel format support and drag-drop failure toast to frontend file upload

## v10.13.0 (2026-03-04)

Introduced hybrid multimodal routing for automatic vision model switching, and significantly enhanced document parsing with PDF rendering, Word image extraction, and HTML-to-Markdown conversion.

### New Features
- 🧠 **Hybrid Multimodal Routing**: Main model automatically routes to its associated vision model when images are detected in the conversation, no manual switching needed
- 📄 **PDF Page Rendering**: Added PDF rendering capability for scanned PDFs — pre-renders first 5 pages and detects image-heavy pages for visual AI analysis
- 🖼️ **Word Image Extraction**: Document parser now extracts embedded images from Word (.docx) files with structured HTML output
- 🔄 **HTML-to-Markdown Conversion**: Document parsing pipeline now converts extracted HTML to clean Markdown for better AI consumption

### Improvements
- 📎 **Document Upload Image Separation**: Uploaded documents now separate preview images from full-resolution images for optimized processing
- 📊 **PDF Attachment Metadata**: PDF attachments now show page count and preview page count in attachment info
- 🐛 **AI Debug Console Images**: AI Debug Console now displays image content info instead of hiding it completely
- 💬 **Toast Reply History**: Desktop proactive notification replies now carry conversation history so the Agent remembers prior context
- 🏗️ **Unified Proactive Context Store**: Consolidated proactive context storage path, removing duplicate mechanism in IMService
- 👁️ **Unified Vision Capability Check**: Moved `hasVisionCapability` logic to backend ConfigService, removing fragile regex matching from frontend

### Bug Fixes
- 🔧 Fixed ParsedDocument not saving file path, causing Agent to search the entire filesystem
- 🔧 Fixed image mapping info missing, causing incorrect page numbers in document references
- 🔧 Fixed vision model attempting to use `read_file` on images instead of analyzing them directly
- 🔧 Fixed image uploads being pre-compressed — now sends original images with `detail:high` for better AI analysis

## v10.12.2 (2026-03-04)

Improved document upload handling, added Watch editing support, and fixed multiple Scheduler-to-Watch migration issues.

### New Features
- 📎 **Uploaded Files Display**: User messages now show the list of uploaded files with attachment metadata
- ✏️ **Watch Editing Panel**: Watch detail panel now supports direct editing, allowing users to fine-tune Watch configurations

### Improvements
- 📄 **Document Upload Refactor**: Switched to XML format for document context injection, simplifying how uploaded documents are referenced by the Agent
- 🌐 **Skill i18n**: Built-in skill names and descriptions now support Chinese/English switching
- 🐟 **Brand Update**: Updated GitHub repository references and Matrix Easter egg ASCII art to use "SailFish" branding
- 📸 **Updated Screenshots**: Added new screenshots showcasing AI Assistant, Skill Market, and Remote Agent features

### Bug Fixes
- 🔧 Fixed Scheduler→Watch migration failing after packaging due to dynamic import issues (switched to static import)
- 🔧 Fixed Scheduler→Watch migration not clearing old task data and stopping the deprecated Scheduler
- 🔧 Fixed Watch wakeup selecting the wrong IM platform when multiple platforms are connected simultaneously
- 🔧 Fixed Watch edit button not responding due to `structuredClone` unable to clone Vue Proxy objects
- 🔧 Fixed attachment label styling — removed filename truncation and improved color readability
- 🔧 Fixed malformed tool call arguments causing tasks to silently end instead of auto-retrying
- 🔧 Fixed type definitions and test assertions to match refactored document upload logic

## v10.12.1 (2026-03-01)

Refreshed app branding with a new logo across all platforms, and added an assistant avatar in standalone mode.

### Improvements
- 🎨 **New App Logo**: Replaced the application logo across all platforms (macOS, Windows, Linux), welcome page, website, and favicon
- 🐟 **Assistant Avatar**: Added a SailFish logo avatar next to AI messages in standalone assistant mode for a more polished chat experience
- 🖼️ **Welcome Page Layout**: Updated welcome page logo sizing and layout for better visual balance

## v10.12.0 (2026-02-28)

Agent now maintains TODO.md and CONTACTS.md for persistent task and contact tracking, with smarter awaken context injection and refined Watch reminder logic.

### New Features
- 📝 **TODO.md Management**: Agent can now maintain a `TODO.md` file to track user tasks and deadlines persistently
- 📇 **CONTACTS.md Management**: Agent can now maintain a `CONTACTS.md` address book for user contacts
- 🌅 **Awaken Context Summary**: Awaken mode now injects a recent activity summary so the Agent understands what the user has been doing

### Improvements
- 📋 **TODO/CONTACTS Mechanism Refinement**: Clarified the boundary between TODO document tracking and Watch-based reminders
- 🔕 **Hide Built-in Awaken Watch**: Built-in awaken Watch entries are now hidden in non-debug mode
- ⏰ **Smarter TODO Reminders**: Watch reminder logic now intelligently judges reminder timing based on task time spans
- 🌙 **Reduced Night-time Disturbance**: Optimized awaken prompts to minimize unnecessary notifications at night
- 🔧 **CI/CD Filename Fix**: Updated OSS upload and website download links to use new "SailFish" naming

### Bug Fixes
- 🔧 Fixed Feishu (Lark) silently reconnecting on disconnect instead of repeatedly notifying the user
- 🔧 Fixed IM messages showing raw `exec` tool name instead of the actual command being executed

## v10.11.3 (2026-02-28)

Improved AI model compatibility and robustness, with fixes for output truncation, token limits, and vision fallback, plus a new IM process message toggle.

### New Features
- 📩 **IM Process Message Toggle**: Added a "Send Process Messages" switch to reduce IM notification noise — when disabled, only final results and errors are sent

### Improvements
- 🏷️ **Product Name Update**: Changed productName from "SFTerm" to "SailFish" in build configuration

### Bug Fixes
- 🔧 Fixed vision fallback logic causing errors when sending images to text-only models like Zhipu GLM-5
- 🔧 Fixed `max_tokens` exceeding model limits for DeepSeek and other models, optimized default context length values
- 🔧 Fixed LLM API edge case handling where output truncation caused tasks to falsely appear completed
- 🔧 Fixed Orchestrator crash on output truncation (same issue as Agent)
- 🔧 Fixed IM `sendProcessMessages` toggle API rollback not working on failure
- 🔧 Fixed `flushTextBuffer` leaking intermediate text in silent mode during asking/needConfirm flows
- 🔧 Fixed IM replies showing `talk_to_user` context prefix
- 🔧 Fixed sensors starting sequentially instead of in parallel, causing AppLifecycle sensor not to start
- 🔧 Fixed `daysTogether` calculation not including the first use date
- 🔧 Fixed Awaken dialog not being persisted and greeting content repeating on IM reconnection

## v10.11.2 (2026-02-27)

Bug fixes for IM message routing, Watch system cleanup, and backend service initialization reliability.

### Improvements
- 🧹 **Watch Shared State Removed**: Removed cross-Watch shared state (sharedState) mechanism to simplify the Watch architecture
- 💡 **Awaken Interval Hint**: Added descriptive text to the Awaken interval input field for better clarity

### Bug Fixes
- 🔧 Fixed IM `talk_to_user` proactive messages and IM replies not routing to the correct tab with proper context continuity
- 🔧 Fixed event-bus using dynamic import causing module-not-found errors in packaged builds — switched to static import
- 🔧 Fixed backend service initialization depending on `did-finish-load` event, which could cause race conditions
- 🔧 Fixed `updateContextKnowledgeAsync` crashing with TypeError when `toolArgs` is undefined

## v10.11.1 (2026-02-27)

Internal improvements to prompt engineering and Agent relationship tracking, plus bug fixes for Awaken mode and Steam edition.

### Improvements
- 🤝 **Bond System**: Internal relationship tracking that quantifies the depth of user-Agent interactions over time
- 📝 **Prompt Builder Refactor**: Section-based array architecture for system prompts with standardized Markdown formatting
- 🌐 **Unified Chinese Prompts**: System prompts consolidated to Chinese, removing redundant English translations

### Bug Fixes
- 🔧 Fixed Awaken mode heartbeat sensor not auto-starting on launch
- 🔧 Fixed Steam edition exposing AI-related options in shortcut and data management settings
- 🔧 Fixed bond tone guidance overriding Soul definitions — Soul now takes precedence

## v10.11.0 (2026-02-27)

Keyboard shortcuts become fully customizable, the Sensor Loop gains app lifecycle awareness and universal probes, and the Awaken system refines its identity with "Soul" replacing "Personality".

### New Features
- ⌨️ **Keyboard Shortcut Customization**: Full shortcut settings page with customizable bindings for AI Assistant (⌘T), Local Terminal (⌘⇧T), SSH Terminal, and Voice Input
- 🔮 **App Lifecycle Sensor**: New sensor type that detects app lifecycle events (startup, shutdown) and checks milestone conditions
- 🔬 **Command & HTTP Probes**: Universal probe sensors for monitoring command outputs and HTTP endpoints

### Improvements
- 🧠 **Awaken "Soul" System**: "Personality" renamed to "Soul" with MBTI selection migrated to the Awaken panel
- 🎯 **Terminal-aware UI Controls**: AI buttons and menus dynamically adapt based on current terminal state
- 🤝 **Event-driven IM Greetings**: IM greetings now triggered by events, Agent autonomously decides how to greet
- ⚡ **Speech Model Preloading**: Voice model preloaded when configuring speech shortcuts for instant availability
- 🎨 **Shortcut Settings Redesign**: Redesigned keyboard shortcut settings interface with centered layout

### Bug Fixes
- 🔧 Fixed PTT voice input continuing to record after key release due to race condition
- 🔧 Fixed shortcut settings not refreshing after restoring defaults
- 🔧 Fixed legacy shortcut configurations not auto-migrating to new defaults
- 🔧 Fixed Awaken panel ESC close not syncing awakened state to main UI

## v10.10.0 (2026-02-26)

SailFish evolves from a passive tool into a proactive assistant — the Sensor Loop and Watch system enable AI to perceive environmental changes and act autonomously, Awaken Mode gives the Agent personality and initiative, alongside major infrastructure upgrades including Agent architecture decoupling, knowledge document refactoring, and Office style themes.

### New Features
- 🧠 **Sensor Loop & Watch System**: Complete Watch system with 4 sensor types (heartbeat, file-watch, calendar, email), 8 built-in templates, stateful workflows, event pool dispatch layer, and webhook support
- 🌅 **Awaken Mode**: AI transforms from a passive tool into a proactive assistant — personality-driven conversations, silent background execution, toast push notifications, and ECG heartbeat animation
- 🤖 **Anthropic Native API**: Claude models now use Anthropic's native API instead of the OpenAI compatibility layer
- 📊 **Excel Style Themes**: New style theme system with preset/custom styles and cell-level control; quick Markdown-to-Excel generation
- 📝 **Word Theme Extension**: Theme system extended to tables, code blocks, and quotes; Markdown ordered lists convert to Word numbered lists
- 📚 **L2 Knowledge Docs Refactor**: Each contextId now maps to a single structured Markdown document, replacing the old fragmented entries
- 🏗️ **Agent Architecture Refactor**: TerminalAgent → SailFish, decoupled from terminal dependency; new standalone AI assistant tab
- 🧩 **Tab Independent Rendering**: Each tab renders in its own self-contained div, preventing component destruction on tab switch
- 🎭 **Personality Skill**: Define Agent personality through natural conversation
- 🛠️ **Built-in Skills Display**: Settings page shows all built-in skills with enable/disable toggle
- 📦 **Shared Types System**: Created `shared/types/` to eliminate duplicate type definitions between frontend and backend
- 🎤 **Push-to-Talk**: Hold Ctrl key for voice input
- 🔍 **History Search**: Search agent history records with time range filtering
- 📋 **Unified Logging**: `electron-log` based logging with daily file rotation, configurable log levels
- 📁 **Agent Workspace**: Dedicated workspace directory for confirmation-free file operations
- 🖼️ **Image Reading**: `read_file` tool supports reading images and injecting AI vision context
- 🔌 **Feishu WebSocket**: WebSocket connection management with auto-reconnect for Feishu/Lark
- 🤖 **AI Templates**: New presets for Claude, Gemini, Grok, Mistral, Doubao, Zhipu, and Kimi

### Improvements
- 🔀 **Command Execution Split**: `execute_command` split into terminal (PTY) and assistant (exec) versions with configurable timeout (up to 600s)
- 🌐 **Remote Channels**: Remote channels now use assistant tab instead of terminal tab; WebChatService backend-driven architecture
- 📋 **Plan Steps**: `create_plan` step limit raised from 10 to 50
- 🧠 **Memory System**: Removed auto observation extraction; now uses semantic search on conversation history
- 🔔 **Watch Prompt Injection**: Active watch list summary injected into agent prompt for awareness
- 📱 **IM Tools**: IM tools now available in all modes, not just remote channels
- ⚙️ **Settings UI**: Bottom items side-by-side layout; memory/knowledge management embedded in settings page; skills page simplified to built-in/extension groups
- 🗑️ **Scheduler Deprecated**: Old scheduled tasks auto-migrate to Watch system; `schedule_*` tools marked deprecated
- 🚫 **NO_ACTION**: Agent can skip notifications for batched sensor events not worth reporting

### Bug Fixes
- 🔧 Fixed thinking model execution: user interruption no longer causes immediate "task completed"
- 🔧 Fixed remote conversations (IM/Web/Watch) now correctly marked as assistant mode
- 🔧 Fixed IM duplicate message sending with deduplication
- 🔧 Fixed AI timeout retry mechanism that was silently failing
- 🔧 Fixed Steam version: hidden residual AI function entries that caused review failure
- 🔧 Fixed heartbeat events now properly trigger event pool drain
- 🔧 Fixed email sensor: startup scan for missed unread emails; reconnect gap recovery
- 🔧 Fixed `did-finish-load` callback missing async causing startup failure
- 🔧 Fixed multi-channel IM proactive notification routing for single user
- 🔧 Fixed redundant `pwd` commands in terminal
- 🔧 Fixed IM file sending tool now available on all platforms
- 🔧 Fixed `send_image_to_chat` tool: image reading now compatible with non-vision AI models

## v10.9.0 (2026-02-21)

### New Features
- ⚙️ **Config Skill: Email & Calendar**: Config management skill now supports email and calendar account management

### Improvements
- 🎨 **Data Management Redesign**: Redesigned the Data Management settings page with a cleaner layout
- 🖌️ **Theme Order**: Moved Blue theme to the top of the theme list as the default highlight
- 🌐 **Browser Skill Hints**: Added capability and limitation hints to the browser skill, reducing unnecessary AI retries
- 🔍 **Agent File Search**: Agent prompt now guides AI to prefer `file_search` over `find`/`locate` for better results
- 💬 **IM Setup Prompt**: Added browser limitation hint to IM guided setup prompt

### Bug Fixes
- 🔧 IM: Fixed "connection disconnected" notification appearing twice when disconnecting
- 🔧 Single-instance lock now only activates in packaged builds, allowing dev and production to run simultaneously

## v10.8.0 (2026-02-20)

### New Features
- 🔗 **Deep Link (sailfish://)**: Support opening the app from the website skill examples to run tasks via `sailfish://run?task=...`
- 🛒 **Skill Market One-Click Install**: Install skills from the website skill market with a single click (deep link)
- 📋 **Skill List Uninstall**: One-click uninstall for installed skills in "My Skills" settings
- 🎴 **Skill Market Preview**: Clicking a card in the featured section opens the skill’s preview page
- 📊 **Unified Connection Panel**: Connection status popover shows IM channels and MCP servers side by side

### Improvements
- 🛒 Skill market: Removed "Recommended" category to avoid confusion with the featured block

### Bug Fixes
- 🔧 macOS: Cmd+Q now quits the app immediately after the first confirmation instead of requiring a second quit
- 🔧 ConnectionStatusPopover: Fixed remote channel count not displaying
- 🔧 Skill/Config: Agent can now manage MCP server configuration

## v10.6.0 (2026-02-20)

### New Features
- 🍎 **System Tray & Single Instance**: Added system tray icon and single-instance lock so the app can run in the background with one process
- 🔒 **Tray Stay Resident**: Window hides on Cmd+W instead of quitting; services keep running in the background
- ⚙️ **Config Skill**: New SailFish config management skill — Agent can read and update app settings via natural language
- 🛒 **Skill Market (CN)**: Added 12 new skills targeting Chinese users in the skill market

### Improvements
- 🌐 **Website**: Skills list is now auto-synced from the source directory during website build

### Bug Fixes
- 🔧 Feishu: Validate credentials before connecting and return clear errors to the user when invalid
- 🔧 Feishu: Fixed SDK connection error handling and adapter connection state management
- 🔧 Remote/IM: New task creates a tab without activating it to avoid stealing focus
- 🔧 Knowledge: Fixed repeated orphan cleanup on every startup after clearing host memory
- 🔧 AI Debug: Fixed copy button not working in the debug panel
- 🔧 CLI: Auto-detect local host and show an empty-history message when appropriate

## v10.5.0 (2026-02-19)

### New Features
- 🛒 **Skill Market**: Browse, search, install, and update community-shared skills directly from the in-app skill market, powered by a remote registry

## v10.4.1 (2026-02-19)

### New Features
- 🤖 **IM Guided Setup**: Added "AI Help Me Configure" button for each IM channel — launches an Agent that walks you through setup step-by-step

### Improvements
- 🧠 **AI-Managed Context**: Agent now autonomously manages conversation context instead of automatic compression, improving multi-turn dialogue quality
- 🌳 **Browser Form Detection**: Enhanced accessibility snapshot with required-field detection and form label extraction for better auto-filling in complex pages (e.g., Feishu)
- 📊 **Unified Logging System**: Introduced 5-level logging (debug/info/warn/error/silent) with configurable log level in AI settings
- 🏗️ **Agent Architecture Overhaul**: Session persistence moved to backend — Steps, context, and lifecycle now fully managed server-side for reliability
- 🧹 **Memory Quality**: Optimized memory system quality control strategy for more relevant recall
- 🐚 **IM CLI Commands**: Added `im:status`, `im:connect`, `im:disconnect` CLI commands for headless IM management

### Bug Fixes
- 🔧 Fixed Feishu MP4 video upload returning 400 error
- 🔧 Fixed `createTabWithTask` not auto-executing tasks due to timing issue
- 🔧 Fixed Agent debug mode toggle not taking effect
- 🔧 Fixed empty TaskMemory when restoring old history records

## v10.4.0 (2026-02-17)

### New Features
- 🖥️ **CLI Mode**: New pure Node.js CLI mode — run all backend services without Electron, ideal for headless servers and automation (`npm run sft`)
- 💼 **WeCom Integration**: Added WeCom (企业微信) as a new IM channel with full callback-based messaging support (Beta)
- 📖 **Per-Platform IM Docs**: Split IM setup guides into dedicated per-platform documents for DingTalk, Feishu, Slack, Telegram, and WeCom

### Improvements
- 🔒 **CLI Security Hardening**: Addressed security and code quality issues in the CLI module following code review
- 🧪 **CLI Test Suite Upgrade**: Upgraded CLI tests from smoke tests to comprehensive functional verification covering all 26 commands
- 📝 **Documentation Updates**: Updated README branding from SFTERM to SAILFISH, added Slack/Telegram channel links, simplified personal-use license description, removed outdated Roadmap

### Bug Fixes
- 🔧 Unified brand name to SailFish across the codebase; Agent now compresses context before reporting overflow instead of failing immediately

## v10.3.0 (2026-02-17)

### New Features
- 💬 **Slack & Telegram Integration**: Added Slack and Telegram as new IM channels, enabling Agent interaction through additional messaging platforms
- 🌐 **IM Module i18n**: Full internationalization support for the IM settings module

### Improvements
- 📖 **Bilingual IM Guides**: Split IM integration documentation into separate English and Chinese versions with dedicated Telegram setup instructions

### Bug Fixes
- 🔧 Fixed `ws` optional native dependency marked as rollup external for build compatibility
- 🔧 Fixed `@BotFather` `@` symbol escaping to prevent vue-i18n parsing errors
- 🔧 Fixed help documentation links to match renamed messaging-integration files
- 🔧 Synced vite-env.d.ts type declarations and hardened defensive access for IM adapters

## v10.2.0 (2026-02-16)

### New Features
- 🧠 **Observation Ledger**: Refactored memory system to an Observation Ledger model for structured knowledge retention
- 🎛️ **IM Execution Mode**: IM settings page now supports configuring Agent execution mode per channel
- 📖 **IM Setup Guides**: Redesigned IM settings help area with dedicated DingTalk/Feishu configuration guides
- ⚡ **Simplified Free Mode Confirmation**: Streamlined free mode secondary confirmation with IM settings sync
- 🔑 **Feishu Permissions**: Updated Feishu permission list and enabled text copying on the settings page

### Improvements
- 🏗️ **Split Settings Pages**: Separated remote access into independent IM and Web Service settings pages
- 📝 **README Branding**: Updated README branding and highlighted Remote Agent & GUI advantages

### Bug Fixes
- 🔧 Fixed vector search to use cosine distance and lowered pre-filter threshold for better knowledge retrieval
- 🔧 Fixed BM25 index using plaintext instead of encrypted content, resolving memory search failures
- 🔧 Fixed Remote Agent default mode display error and button layout issues
- 🔧 Fixed missing hostId in remote channel AgentContext
- 🔧 Fixed DingTalk/Feishu message ordering race condition with send queue
- 🔧 Fixed HostMemory types and enhanced settings recovery logic
- 🔧 Fixed macOS Spotlight search not supporting wildcard patterns
- 🔧 Fixed Feishu channel `ask_user` tool sending duplicate messages
- 🔧 Fixed Feishu message display and message ordering race condition

## v10.1.0 (2026-02-16)

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

