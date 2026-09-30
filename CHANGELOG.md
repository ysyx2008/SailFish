# Changelog

All notable changes to SailFish will be documented in this file.

## v11.13.0 (2026-09-30) (Latest)

> New “Approve for me” mode, which interrupts you far less often. New built-in Coding skill, for advanced users to enable themselves. Many smaller improvements.

### New Features
- 🎯 **Approve for me**: Dangerous actions are checked against what you said in this conversation. A match is approved for you; anything that does not match still asks. You can choose it on the task bar and the home input, and the choice is remembered. Reach uses the same path on the desktop, the web, and instant messaging. After you reopen a conversation and say “continue,” the original request still counts. Instant messaging keeps a single line of explanation
- 🎯 **Coding skill** (off by default): Open a local project, search by content, find files by name, and edit several places in one file. If an edit does not match, none of it is applied. After an edit, syntax is checked and only errors introduced this time are reported, across seventeen common languages. Each turn keeps a checkpoint you can roll back. Checkpoints leave the project’s own version history untouched, are kept for seven days, and skip files that are too large. If the project changes after you confirm, you are asked again. Search is included with the app
- 🎯 **A note with each command**: A command can carry a short explanation. Progress shows the explanation first, then the command. Commands that will finish are watched until they do. Long-running services are marked and left alone, and a long watch checks in on its own. If you send a message in the middle, it is answered first and watching resumes; if you stop, the command stops too
- 🎯 **Usage hidden by default**: Token use under the input stays hidden until you turn it on in Settings. Hovering shows how much of the prompt was served from cache. The figures sit on separate lines so they stay readable

### Improvements
- ⚡ **Dispatched assistants are easier to tell apart**: The name shows what each one is doing. They leave the terminal you are looking at alone and work on this machine. High-risk actions go through the same approval as this conversation
- ⚡ **Terminal ability appears when there is a terminal**: An independent assistant gains terminal-related ability only after it has a terminal
- ⚡ **Reopening Reach starts cleaner**: Skills from the previous session are not loaded automatically. When an instant-message or web remote session comes in, the context bar on desktop Reach updates with it
- ⚡ **Context is compacted the same way**: Compacting started by the assistant and compacting you start by hand put the earlier text away the same way
- ⚡ **The window is easier to drag**: The assistant top bar stays in place so the window can be dragged; model names in the conversation use a short form. When the plan bar is too narrow, the title and the progress wrap onto two lines. Host names on split panes stay faint until the pointer enters the pane

### Bug Fixes
- 🐛 **A full backup no longer fails because the browser cache is in use**
- 🐛 **Word preview no longer resizes back and forth at the width where the scrollbar appears**
- 🐛 **When a document fills the window, it leaves room for the Windows window buttons**, so Save and Open stay visible
- 🐛 **Git actions that would discard work ask first, even in relaxed mode**
- 🐛 **When a jump host does not allow port forwarding, the reason is explained**, instead of appearing connected
- 🐛 **Semantic search can finish loading without a GPU**, and no longer quits during startup
- 🐛 **The task-complete mark stays at the end of this conversation**, rather than under something said in the middle
- 🐛 **After you approve, the result no longer adds an “Approved” mark**
- 🐛 **Replacement text is written as given**; a `$&` in it is no longer treated as a replacement token
- 🐛 **Dropdowns on Windows can be used normally**, and no longer draw outside the window as a black block
- 🐛 **When a skill description already has a title, it is no longer repeated on every turn**

## v11.12.0 (2026-09-23)

> Web search can use Zhipu or Kimi, and you can ask the assistant to switch. A benchmark compares models and machines on the same set of tasks.

### New Features
- 🎯 **Web search adds Zhipu and Kimi**: Either works in China. Search and chat use separate models; the cheaper tier is the default, and Settings can switch to higher recall. The same platform key does not need to be entered again for search. You can also ask the assistant to see which provider is in use and switch it. Keys are never read back, and switching one does not clear the others
- 🎯 **Benchmark console**: Compare models and machines on the same tasks. It measures time to first token and output speed across context lengths, then tool round-trips and three concurrent requests, and finishes with a score you can compare. Each length runs three times by default and keeps the middle result. Lengths stay fixed so a casual edit cannot break the comparison

### Bug Fixes
- 🐛 **A stuck watch no longer blocks the next run**; the overview duration counts from when this run started
- 🐛 **A message with an image that is already on screen is no longer erased by a later one**
- 🐛 **A dispatch card shows only this batch**, not the whole roster
- 🐛 **The next queued message starts on its own**, and its images go with it
- 🐛 **You can still type while context is being compacted**; anything sent then waits in the queue and continues afterward
- 🐛 **Unsupported artifact types say which kinds can be opened**, instead of pointing at the tool that generates slides
- 🐛 **When a connector cannot reach the network, the message is readable**, and you can retry all of them at once
- 🐛 **Semantic search still works without a discrete GPU**, only more slowly
- 🐛 **Creating a file that already exists saves over it**, instead of rewriting the whole piece

## v11.11.0 (2026-09-16)

> Send and queue shortcuts can be changed. Multiple terminal panes can be rearranged. Context compacting is more complete, and you can compact by hand.

### New Features
- 🎯 **Richer context compacting**: Type `/compact` in the input to compact even when there is still room. Settings have four levels (More / Balanced / Less / Off) for how proactive the secretary is; near-full and a manual compact are unchanged. Compacted text and the previous turn come back through the same path
- 🎯 **Custom send and queue shortcuts**: Enter still sends and ⌘/Ctrl+Enter still queues by default, and only in the input. Shortcuts in Settings are ordered by how often they are used
- 🎯 **Rearrange terminal panes**: Drag side-by-side panes to swap them; drop a host or the plus button on an edge to open a new one. A remote connection shows the pane first; a failure stays in that pane

### Improvements
- ⚡ **Token use shows speed**: Hover the usage to see how fast this stretch is coming out; after it stops, that becomes the average for the stretch that just finished
- ⚡ **Very long commands are written to a file**: When a command is too long, the generated text is saved on the machine that will run it, and only the path is sent

### Bug Fixes
- 🐛 **Two chats no longer steal the browser from each other**
- 🐛 **Very large HTML artifact previews can be scrolled and dragged**
- 🐛 **In a full-window artifact, the tab bar leaves room for the window buttons**
- 🐛 **When the output cap equals the window, input quota is no longer reduced to zero**
- 🐛 **Large chart data is no longer poured back into the chat over and over**
- 🐛 **Bold next to Chinese punctuation no longer shows leftover asterisks**
- 🐛 **Canceling a connection no longer shows an English error you cannot use**
- 🐛 **A message sent while connecting is no longer dropped**
- 🐛 **A pane that is still connecting no longer stacks another reconnect**

## v11.10.0 (2026-09-08)

> Documents can fill the window for reading, with the conversation tucked into a bar at the bottom. In a web preview, you can select a passage and have only that part changed. Hosts can be added, edited, or removed by asking the secretary, and the host list is easier to use.

### New Features
- 🎯 **Fill the window with a document**: Artifacts can fill the window; the conversation becomes a bar at the bottom. The input floats over the document; the same button enters and leaves this view
- 🎯 **Select text on a web page to edit**: Select text in an HTML preview; the assistant changes only that passage
- 🎯 **Manage hosts in conversation**: Ask the secretary to add, edit, or remove a host. Create one from a group header; right-click to open a terminal or split into the current session
- 🎯 **Interface zoom**: Zoom the entire interface in or out from Settings

### Improvements
- ⚡ **Reopened chats keep more**: Tasks reopen with the original text and only hand off when the context is full. Reach keeps a process summary after you close it, and handoffs come back with it
- ⚡ **Dangerous-command blocking is more precise**: Only blocks destructive operations aimed at the whole disk, the boot partition, or the Windows system drive; ordinary cleanup is no longer blocked by mistake
- ⚡ **Hard-deny command rules**: A rule can be set to always deny; rules can only be tightened, not loosened
- ⚡ **Attachments use system icons**
- ⚡ **Word and Excel opened to the panel can be previewed directly**

### Bug Fixes
- 🐛 **Todo due dates can be picked normally**
- 🐛 **Large SSH output no longer freezes the window**
- 🐛 **Dialogs you are filling in no longer close when you click the overlay**
- 🐛 **Editing a host no longer closes the dialog when you use the sidebar**
- 🐛 **Full-text search finds attachment names**
- 🐛 **An empty Reach chat shows a QR code when WeChat is not connected**
- 🐛 **Word preview first-line indent matches the document**
- 🐛 **Empty model replies explain what happened and what to try**
- 🐛 **Images received in WeChat can be used as files, as they can in tasks**
- 🐛 **An overdue account asks you to top up**, instead of treating it as rate-limiting or switching models
- 🐛 **A hard-blocked command still reports the original command to the parent agent**
- 🐛 **⌘/Ctrl+W closes only the current artifact tab**, not the whole panel

## v11.9.0 (2026-08-31)


> Skills are visible now — no longer hidden. You can select a range in a spreadsheet and hand it to the assistant. Official-document previews follow the original fonts and page.

### New Features
- 🎯 **Skills in plain sight**: What's on in this chat sits above the input; `@` or the star to add or drop them. They come back when you reopen; you can turn the row off in Settings
- 🎯 **Select cells, then edit**: Circle a range in the preview; the chat only changes that block, and the preview refreshes right away
- 🎯 **Remembers the machine it worked on**: When the assistant works on a host in a visible terminal, that host's notes are updated

### Improvements
- ⚡ **Word preview follows the original**: Fonts come from the document; the page scales down when the pane is narrow
- ⚡ **Questions come with a suggestion**: The secretary marks the option it prefers; tap to answer
- ⚡ **Pasted images stay with the chat**: Clipboard pictures are kept in history and still there when you reopen
- ⚡ **Memory length is adjustable**: Each note stays at 5,000 characters by default, up to 20,000; clearing requires typing to confirm
- ⚡ **Artifact panel follows the window**: Scales with resize; double-click the title-bar gap to maximize
- ⚡ **Plugins are back in Settings**

### Bug Fixes
- 🐛 **You can interrupt Reach on the desktop**: While the secretary is speaking, Enter joins this conversation
- 🐛 **A failed WeChat reply is no longer treated as a crash**
- 🐛 **Deleted chats no longer linger in search**
- 🐛 **Huge command output no longer freezes the window**
- 🐛 **Sending files alone works** — no need to add empty text
- 🐛 **Interrupted work stops at once**
- 🐛 **A few light-theme details were hard to see**

## v11.8.0 (2026-08-24)

> The assistant can dispatch sub-agents and open a terminal in the same chat. An SSH session can also work on this machine. The welcome page is rebuilt; work and artifacts are easier to follow. If a model stalls, it switches; when a task has a result, you hear a sound.

### New Features
- 🎯 **New sub-agents**: Dispatch several at once; they start immediately and report back. They stay in this task, so you can follow up, wait a bit, or stop them. Dangerous work still asks you — they won't sign off on your behalf
- 🎯 **Terminal in the assistant**: In a standalone assistant chat, the terminal and files sit with the conversation; you can move the chat onto a real terminal when you need to
- 🎯 **SSH sessions can use this machine**: Read and write local files and run local commands from an SSH session, without opening a separate local window
- 🎯 **Collapse the work into one line**: Thinking, tools, and search can fold up; what it says stays outside. Strict mode always stays expanded
- 🎯 **Artifact tabs**: Switch files with tabs, or a dropdown when they overflow; zoom web previews; select text in Word and ask right there
- 🎯 **A sound when something happens**: Done, failed, waiting for your approval, or when the secretary reaches out — volume is adjustable

### Improvements
- ⚡ **Rebuilt welcome page**: Same features, new layout and empty state — quieter, less decoration
- ⚡ **Switch models when one keeps failing**: Retries show a countdown; if the current model keeps failing, it tries the next one in your list
- ⚡ **Long chats hand off automatically**: Near the limit, the AI picks what matters and continues; models with a small context window warn you once
- ⚡ **Settings grouped by job**: Sidebar recategorized, Security on its own, system pages share one look. Diagnostics no longer shows an “all clear” bar, and dump counts don't stay yellow
- ⚡ **Queued messages can be edited and reordered**: Drag to change the order
- ⚡ **Default models updated**: Presets match current mainline models; DeepSeek includes vision by default
- ⚡ **Ask the secretary to change models**: View, add, or remove AI models by asking; the one in use is blocked from deletion
- ⚡ **Misc**: Cancel an SSH connect in progress; WeChat shows yellow when connected but not yet able to send; title-bar buttons aligned; sidebar avatar matches Awaken; extension skills listed first; split panes show which machine they are on

### Bug Fixes
- 🐛 **Knowledge base can recover**: Rebuilds the index when a backup can't; won't fill the disk if recovery fails
- 🐛 **Windows freeze and broken Copy**: SSH disconnect no longer waits on the remote; app-wide Copy works again
- 🐛 **Reopened history was only a one-line summary**: Compresses conversation by conversation instead of dropping the detail
- 🐛 **WeChat attachments blocked the next poll**: Batch downloads no longer stall incoming messages
- 🐛 **Sending only an image no longer auto-fills “Please describe this image”**
- 🐛 **Terminal went black after a long time away**: The screen is redrawn when you come back
- 🐛 **Misc**: Confirm dialogs covering Settings; Reach timeline crowded out by notices; Esc closes Todos; plans must be checked off as you go; large scanned PDFs no longer skipped whole; clearing a number in Settings no longer jumps to 0

## v11.7.0 (2026-08-18)

> A new three-column layout: navigate on the left, work in the middle, artifacts on the right. Queue the next message while a task is running. After a crash, copy a summary to send us.

### New Features
- 🎯 **Three-column layout**: New chat, Reach, Terminal, and recent conversations on the left; the current work in the middle; artifacts on the right, gone when collapsed. No full-width title bar. The sidebar opens and closes, and you can go back and forward.
- 🎯 **Queue the next message**: While a task is running, ⌘/Ctrl+Enter queues it for when the task finishes; Enter still inserts into the current task. Queued items sit above the input and can be removed.
- 🎯 **Crash summary**: Prompted after a crash or unexpected last exit; copy a redacted summary to send us, or export a full diagnostics pack from Settings
- 🎯 **Easier artifacts**: Switch files from a list at the top of the chat; Word / Excel / PDF use system icons; Excel preview can switch sheets
- 🎯 **Search conversation text**: Type to filter titles, Enter to search the body. New chats appear after the first message; task titles refresh every few turns from the whole conversation, and manual edits are kept
- 🎯 **MCP connects when enabled**: No more manual connect; the UI calls them Connectors
- 🎯 **Token use this chat**: Usage shown next to the model name
- 🎯 **Readable PDF text**: Pages with a text layer are extracted; scans stay as images
- 🎯 **WPS files**: `.wps` / `.et` open directly; older formats that won't open ask you to resave
- 🎯 **Todos into a new task**: Right-click “Do this for me / Schedule it” to start a new chat

### Improvements
- ⚡ **Cheaper DeepSeek default**: First-run setup uses V4 Flash
- ⚡ **Longer replies**: Default max output raised to 32K
- ⚡ **Volcengine media skill**: Image-to-image and longer video

### Bug Fixes
- 🐛 **Knowledge search goes empty / memory spikes**: The service recovers after a drop, instead of silently returning nothing or leaving extra processes
- 🐛 **Word edits not saved, or a whole paragraph going bold**
- 🐛 **Light terminal hard to read**: White highlights such as port numbers disappear
- 🐛 **Misc**: Search kept running after Stop; skill preview not found; standalone browser window pulled back to attach

## v11.6.0 (2026-08-11)

> Artifacts are easier to edit, preview, and send to your phone; long chats make room automatically; Settings is tidier.

### New Features
- 🎯 **Real Markdown editing**: edit artifacts WYSIWYG in place — select text, use shortcuts, and avoid stepping on AI edits of the same doc
- 🎯 **Live HTML/URL preview**: open in an embedded browser with an address bar; one-tap screenshot back into the chat to follow up
- 🎯 **Send artifacts to phone**: push from the panel straight to a connected IM channel
- 🎯 **Make room in long chats**: oversized command/file reads land on disk with a pointer; near the limit, the AI summarizes before continuing
- 🎯 **General settings**: launch at login and language live under General; Settings grouped into System / AI / Integrations
- 🎯 **SSH that reconnects**: reconnect after disconnect; the AI can ensure the link is up before working

### Improvements
- ⚡ **Clearer artifact names**: fewer machine-looking IDs; long filenames stay readable in the picker
- ⚡ **Clearer todo progress**: remaining-time bands plus a hover peek card
- ⚡ **Simpler pane controls**: open, close, and split live in one place

### Bug Fixes
- 🐛 **Lost images on resume / companion**: images no longer vanish when switching models or using cache
- 🐛 **Companion stuck on old model**: companion follows the global active model after you switch
- 🐛 **Windows focus after launch**: fewer interruptions during startup so the input can take focus again
- 🐛 **SSH reconnect loses the terminal**: reconnect keeps the same identity so the list still matches
- 🐛 **Skill install failure**: skills with companion files install cleanly
- 🐛 **Misc**: calendar reminder defaults, heartbeat secretary tone, macOS filename quote links, and more

## v11.5.0 (2026-07-27)

> Speech recognition is download-on-demand; MCP is easier to discover; plus a Windows fix for freezes and black terminals.

### New Features
- 🎯 **On-demand speech**: models no longer ship in the installer (smaller download); install from Settings when needed, or import locally — uninstall anytime
- 🎯 **Download progress**: speed and time remaining while installing; keeps going if you leave Settings; notifies you when done
- 🎯 **Clearer MCP usage**: each MCP can say when to use it; the AI loads them on demand instead of dumping everything into context

### Improvements
- ⚡ **Longer Watch runs**: default timeout 5 → 15 minutes so heavier tasks are less often cut off mid-run

### Bug Fixes
- 🐛 **Windows freeze / black terminal**: failed knowledge-base startup no longer retries in a loop and stalls the UI; terminal recovers if GPU rendering drops
- 🐛 **Missing packaged files**: unpack the knowledge-base dependencies that were left out of the Windows build

## v11.4.1 (2026-07-23)

> Hotfix: Windows startup/runtime main-thread blocking that made the window show "Not Responding".

### Bug Fixes
- 🐛 **Windows not responding**: defer Browser Bridge install to async so it no longer blocks the Electron message pump
- 🐛 **Knowledge worker**: add missing asar unpack deps; desktop worker failures no longer silently fall back to the main process
- 🐛 **Wakeup feedback loop**: add AI profile pre-check and circuit breaker with backoff and user notification on repeated failures

## v11.4.0 (2026-07-22)

> Watch becomes a standalone ops panel with concurrent runs; todos gain due-soon reminders and importance sorting; MCP tools load progressively by server to cut context cost.

### New Features
- 🎯 **Standalone Watch panel**: Watch moves out of Awaken; ops overview is a top-level nav with wide dual-pane layout and upcoming/history master–detail
- 🎯 **Concurrent Watch runs**: different watches can run in parallel (soft cap 5); always via the assistant agent — no PTY sidecar
- 🎯 **Todo due-soon reminders**: due-soon section with theme color steps; sort by importance with remaining-time progress tint
- 🎯 **MCP progressive disclosure**: load a whole server’s tools at once instead of dumping every schema into context
- 🎯 **Context composition breakdown**: hover the mini context bar for a token/char tree; expand on demand

### Improvements
- ⚡ **Wakeup vs Watch history buckets**: user Watch overview and wakeup history no longer crowd each other; wakeup history forced to L4 with a tighter load cap
- ⚡ **Companion empty state**: leaner copy, WeChat QR more prominent

### Bug Fixes
- 🐛 **Todo Tab flicker**: opening the todo panel acknowledges overdue so the badge stops flashing
- 🐛 **Command safety**: free-zone downgrade only accepts lexically absolute paths (blocks `cd && rm` bypass); refused commands return a neutral tool result
- 🐛 **Packaging & models**: embedding model download verifies integrity before baking into the package
- 🐛 **UI**: startup / knowledge / backup share one bottom status bar; light-theme confirm cards use semantic tint; drop duplicate spinner while a Watch is running
- 🐛 **Misc**: Word front-matter title no longer leaks into body; MCP discoverability; companion “create task from here” anchor slicing; companion Tab title syncs after language switch

## v11.3.2 (2026-07-20)

> Hotfix: packaged native module load failure.

### Bug Fixes
- 🐛 **Packaged native modules**: `asarUnpack` includes `node-pty` / `keytar` so they load after packaging

## v11.3.1 (2026-07-17)

> Welcome-page “first meeting” invite for the birth chat; sub-agent oversized results archived for on-demand read-back; fixes for macOS LAN SSH and OSS delta updates.

### Improvements
- ⚡ **Welcome “first meeting”**: no longer auto-open Hub after Setup; welcome page invites the birth conversation with a wave animation and “Sure / Later”
- ⚡ **Sub-agent oversized result archive**: results over ~8000 characters are written to scratch with a pointer + summary; the parent can `read_file` on demand
- ⚡ **OEM `features.bond`**: enterprise builds can turn off bond tone and playful copy; open-source default remains on
- ⚡ **Todo TodoService**: extract a service class so api/executor/render share one source of truth; soften completed-item checkmarks
- ⚡ **Browser assistant UI**: selector + single focused panel; tighten terminology and troubleshooting

### Bug Fixes
- 🐛 **macOS LAN SSH**: add Bonjour / mDNS probes to trigger Local Network permission; fix packaged builds hitting `EHOSTUNREACH` to VMs / LAN hosts
- 🐛 **OSS delta updates**: use a single Range request (OSS rejects multipart Range); drop pre-install sync backup
- 🐛 **Hub session retention**: switching to Todos / Companion and back keeps the current Hub session
- 🐛 **Browser assistant**: fix Windows Firefox Native Host registry path; merge Chromium Chrome/Edge into one selector path to avoid dual green status
- 🐛 **Welcome logo**: restore infinite float animation

## v11.3.0 (2026-07-16)

> Ships local secretary todos and full userData backup/restore.

### New Features
- 🎯 **Local secretary todos**: `TODO.json` replaces free-form `TODO.md`; fixed todo Tab beside companion; optional migration prompt from legacy TODO.md
- 🎯 **Full data backup & restore**: Data Management packs the entire userData tree as a zip, with progress, validation, and STORE optimization for already-compressed / large files
- 🎯 **CLI install & sandbox**: install the `sailfish` command; share desktop real data with relaxed confirmation by default; `--sandbox` isolates runtime data while borrowing AI Profiles / credentials
- 🎯 **SSO sign-in**: login / persist / refresh / gating and workbench token access (`features.sso`, off by default)

### Improvements
- ⚡ **Config rolling backups**: recover from rolling backups when the main config is corrupt
- ⚡ **Interactive attachments & paths**: open attachments via click / context menu with typed Lucide icons; local paths in chat and tool_call are clickable
- ⚡ **Non-blocking update hint**: update prompt moved to a bottom-right badge card
- ⚡ **IM inbound rich media**: show images inline with vision context; pre-parse documents into documentContext
- ⚡ **Session persistence**: meta + jsonl incremental checkpoints; async LLM short titles in the task sidebar; titles owned by AgentRecord
- ⚡ **Context & risk policy**: session-scoped context bar; unified confirm matrix by execution mode; free-zone writes under `/tmp` skip confirmation
- ⚡ **WeChat / Watch / misc**: persist QR credentials on confirm and refresh only when the tab is visible; pin failing watches; lazy calendar connect; idle history warm-up; macOS occlusion throttling

### Bug Fixes
- 🐛 **AI connectivity**: retry TLS handshake drops by `err.code`; readable test-connection errors; fall back when profileId is invalid
- 🐛 **WeChat progress messages**: send the first body immediately
- 🐛 **Command audit / context**: expand `~` paths to avoid free false negatives; protect skill results; remove per-step tool-result micro-compression
- 🐛 **UI / CLI / history**: textarea measure collapse, artifact splitter mouse release, cold-load pin-to-bottom; protect indexes when sharing userData; scan the watch tree in getAgentRecords
- 🐛 **CLI knowledge exit**: dispose in-process ORT embedding before exit so knowledge commands no longer SIGABRT
- 🐛 **Optional OEM config**: use open-source defaults when `oem.config.ts` is absent; apply override when present; no longer force-generate the file

## v11.2.2 (2026-07-13)

> Tasks and companion chats are now split into two dedicated entry points, and the security and command-audit system has been overhauled-consolidated into a single shell-AST channel with user-configurable risk policies and command rules. Under the hood, the conversation layer completes the Conversation aggregate-root refactor, laying the groundwork for upcoming session capabilities.

### Improvements
- ⚡ **Message-list virtual scroll migrated to virtua**: replaces vue-virtual-scroller with built-in height measurement and scroll adjustment, removing hand-rolled FLIP/ResizeObserver compensation and improving stability for dynamic heights + stick-to-bottom streaming (especially on Windows)
- ⚡ **FLIP smooth shift when pinned to bottom**: after content grows while pinned, apply a reverse translateY on the Virtualizer root then spring back; intentional jump-to-bottom still hard-cuts with a brief FLIP suppress to avoid fighting on start
- ⚡ **CLI branded as `sailfish`**: help/usage match the command name; `npm run sailfish` is the primary npm entry (`sft`/`cli` remain aliases); on macOS install the PATH shim from Settings → Data Management

### Bug Fixes
- 🐛 **Textarea measure no longer jolts the message list**: skip writing style while typing on the same line; only collapse-and-remeasure when deleting shrinks height; stick-to-bottom ResizeObserver only pins when content grows
- 🐛 **Streaming stick-to-bottom without micro-jumps or false bounce**: chase the bottom with exponential scrollTop approach (no cubic FLIP easing); target changes only increase remain so velocity stays continuous

## v11.2.1 (2026-07-12)

> Tasks and companion chats are now split into two dedicated entry points, and the security and command-audit system has been overhauled-consolidated into a single shell-AST channel with user-configurable risk policies and command rules. Under the hood, the conversation layer completes the Conversation aggregate-root refactor, laying the groundwork for upcoming session capabilities.

### New Features
- 🎯 **Agent scratch auto-cleanup**: new `scratchCleanupMaxAgeDays` config (default 7 days, 0 disables); cleans expired files under `agent-workspace/scratch/` on startup, keeping `.gitkeep`; a new "Agent temporary files" card in the data-management page
- 🎯 **Windows PowerShell uses official AST audit**: when the default shell is PowerShell, subcommands are extracted via `Parser::ParseInput`, reusing the whitelist and path partitions so cmdlets like `Remove-Item` are no longer flagged high-risk across the board; cmd fallback and parse failures still fall back to regex

### Improvements
- ⚡ **Scratch cleanup instructions moved to workspace rules**: relocated from the `write_text_file` tool description into the system-prompt private-workspace rules, keeping long copy off a generic tool
- ⚡ **Workbench monorepo design doc v2**: simplifies the v1 plan based on re-verified conclusions, clarifying business-workbench responsibilities and dependencies to keep core and business teams in sync

### Bug Fixes
- 🐛 **PTY shell context alignment**: pty.create now returns shellPath/shellKind so tab.systemInfo matches the spawned shell; removed the redundant pty:getDefaultShell IPC, unified Windows probe logic, and made buildHostEnvironment fall back to profile.shell when systemInfo is unknown
- 🐛 **Windows conversation-list scroll bounce**: suppressed FLIP and shrink-to-bottom during message-sending / debug tool_result / task-completion phases; streaming reflow switched to hard-cut; improved virtual-height estimation and reserved a scrollbar slot

## v11.2.0 (2026-07-12)

> Tasks and companion chats are now split into two dedicated entry points, and the security and command-audit system has been overhauled-consolidated into a single shell-AST channel with user-configurable risk policies and command rules. Under the hood, the conversation layer completes the Conversation aggregate-root refactor, laying the groundwork for upcoming session capabilities.

### New Features
- 🎯 **Task / Companion dual entry points**: a persistent task button on the tab bar plus a dedicated companion tab; companion sessions merge and restore the most recent N history items, with all channels flowing into a single line; Watch messages are routed to the companion tab instead of creating standalone tabs that interrupt you
- 🎯 **Single-assistant Hub workbench model**: local assistant tabs are hidden from the tab bar by default and switched via the "Recent conversations" sidebar; right-click to promote into the tab bar; LRU recycles up to 5 Hub sessions
- 🎯 **Wakeup becomes the fourth conversation kind**: split out from Watch-Watch stays per-execution amnesia to avoid cross-contamination, while wakeup retains history to inform decisions; the watch overview panel hides high-frequency heartbeat streams by default
- 🎯 **Security & command-audit overhaul**:
  - Consolidated into a single shell-AST channel; the exec_argv tool entry is removed, closing the argv indirect-execution hole
  - User command rules: append risk baselines by command name; the confirmation dialog can add unknown commands directly to the rule library
  - Configurable risk policies: parse-failure/unknown-command risk is tiered per execution mode (strict/relaxed/free); manual addition of risk policies and allowlist entries; tiers presented as a radio-button group
  - System paths classified as critical/hardened, with /dev/null black-hole exemption
  - Built-in rules shown read-only; risk list tiered by destructiveness
  - "Always allow" moved to session memory (not persisted); routine ops commands downgraded to moderate risk
- 🎯 **Built-in map GeoJSON**: world / China province / city / district-level maps bundled locally, no network needed for live charts
- 🎯 **Knowledge base backup / restore**: backup and restore supported, avoiding full rebuilds after corruption
- 🎯 **Knowledge base Windows DML acceleration**: embedding inference switched to DirectML, auto-falling back to CPU on failure
- 🎯 **Independent Watch history tree**: watch/wakeup records stored under a separate `history/watch/`, eliminating main-index bloat
- 🎯 **macOS ⌘Q anti-misclick**: first press shows a prompt; a second confirmation is required to quit
- 🎯 **First-token playful copy**: random playful status lines and ultra-long-TTFT teases while waiting for the first token
- 🎯 **Bond milestone easter eggs**: toast on bond unlock; an 8% chance of a bond-themed sign-off in the task-complete footer; input placeholder picks from bond pools
- 🎯 **Email send confirmation card**: preview body and attachment list before sending email
- 🎯 **Browser bridge enhancements**: new `browser_close_tab` tool; Firefox MV3 site-wide permission guide and detection; generic tabs primitive, attach opens a new tab by default
- 🎯 **talk_to_user proactive fork**: proactive messages can fork a new task session from the companion tab
- 🎯 **talk_to_user result shows body**: tool-call results always display the sent body
- 🎯 **Watch retry button**: each row in the anomaly watch list can retry directly
- 🎯 **build:local --launch**: `npm run build:local` installs the --dir build to your machine and launches the app in the background

### Improvements
- ⚡ **Conversation domain-model refactor** (internal): introduced the Conversation aggregate root as the single source of truth; CONVERSATION_POLICY strategy table drives task/companion/watch/wakeup differences; ConversationManager becomes the read-side authority; AgentRecordStore aggregates history storage, HistoryService slimmed to an ops aggregate
- ⚡ **Credential encryption upgrade**: introduced the `g1:` self-managed master-key layer replacing safeStorage as the default scheme; v7 migration moves IM/bastion plaintext credentials into credential and upgrades e1:->g1:
- ⚡ **Context management**: extracted ContextWindowManager collaborator for unified token estimation; watch wakeup breadth-loading strategy + L3/L4 summaries with timestamps; local predictive compression (proactiveCompress) covers providers like DeepSeek that don't report errors; auto-compression fallback on context overflow to avoid conversation interruption
- ⚡ **Startup performance**: lazy-loaded terminal/Agent runtimes, shortening cold starts on low-spec Windows
- ⚡ **Companion merged view consolidated to backend**: frontend calls IPC, avoiding transcript contamination
- ⚡ **Watch noise reduction**: removed deliverProactiveMessage; proactive messages flow only via talk_to_user; silent/no-action/IM watches no longer send fallback notifications
- ⚡ **Unified Windows shell detection**: fixed intermittent command execution issues
- ⚡ **UI polish**: two-row welcome input + model selector (Cursor style); drag-and-drop history items to open tabs; top title prefers the Agent's custom name; companion tab empty state with product description and examples; extracted WelcomePanel and HistorySearchModal as standalone components

### Bug Fixes
- 🐛 **Streaming scroll**: fixed stick-to-bottom, scroll-up reading pushed away by new content, layout-jitter misjudged as off-bottom, scroll drift on tab switch, virtual-scroll bounce when loading history, height-estimate jitter during streaming thinking, and more; expanding a thinking block auto-scrolls into view and anchors to the clicked line
- 🐛 **Companion session continuity**: fixed lost context after companion restart (persistent-named agents rebuild working memory from the most recent N records); rooted out companion sessions splitting into two broken chains (sessionId reseeding + paired merge fields); talk_to_user no longer interrupts in-progress tasks or duplicates delivery
- 🐛 **Security**: patched the exec_argv indirect-execution hole, added indirection-guard; fixed CodeQL and Dependabot security alerts
- 🐛 **Command-audit false positives**: fixed env standalone, cp outside workspace, unwrapped wrappers, non-shell-interpreter inline code, redirect attribution, head/tail numeric shorthand flags, and other cases misjudged as dangerous; relaxed mode no longer confirms unknown commands; unknown commands default to moderate
- 🐛 **Bootstrap**: data-directory pointer file moved to a fixed location to avoid dev/prod divergence; unified dev/prod app name to SailFish with automatic migration of historical data dirs; legacy migration uses explicit markers instead of relying on directory emptiness
- 🐛 **Credentials**: MasterKey.persistSalt returns the final salt and retries on EEXIST empty-file read; corrupt e1: credentials self-heal by deletion, ending Keychain repeat prompts
- 🐛 **Token estimation**: fixed estimateTotalTokens missing images, causing companion to send images the AI couldn't receive
- 🐛 **Email**: test-connection now verifies SMTP, fixing "test succeeds but can't send"
- 🐛 **PDF**: fixed pdfjs 5.x failing to load CMap under Node, causing CJK PDF text loss
- 🐛 **Fork sessions**: fixed "new chat" losing recent context, custom-title suffix loss, IPC clone failures; fork-from-merged-view no longer loses proactive messages after truncation
- 🐛 **WeChat**: process-message digest merge mitigates personal-account rate limits; ASI trap preventing IM settings toggle after lazy-load; CDN upload 500
- 🐛 **Wakeup injection**: wakeup injection into companion context prefers reading steps, fixing duplicate proactive notifications
- 🐛 **UI**: fixed "preparing -> thinking" card flicker and scroll jump; Cmd+W closes a promoted assistant tab instead of the window when one is active; promoted assistant tabs jump to the adjacent tab on close; Hub task-complete reminders visibility and read clearing
- 🐛 **i18n**: dispatch_agents sub-task copy moved to t(); manage_workbench_artifacts streaming pre-card title translation completed
- 🐛 **Windows update**: auto-update skips the NSIS install-mode selection page

## v11.1.0 (2026-06-18)

> The assistant artifact panel is now fully available—preview and switch between generated documents, charts, and more in the sidebar, with a collapsible layout that stays out of your way. The browser bridge can control your existing Chrome or Firefox session without opening a new window, keeping site logins intact.

### New Features
- 🎯 **Artifact Panel**: Collapse/expand, interactive HTML preview, single preview with title dropdown; Agent can open/close the panel explicitly; artifacts stored by kind with Agent awareness synced
- 🎯 **Browser Bridge Attach Mode**: Control your open Chrome or Firefox directly—no new window, logins preserved; connection status dashboard; Chrome Web Store listing
- 🎯 **Knowledge GPU Acceleration**: Migrated to Transformers.js v4 with GPU embedding acceleration; improved index rebuild stability and orphan chunk cleanup
- 🎯 **Agent Scratch Workspace**: New `scratch/` temp directory; workspace protection narrowed to IDENTITY/SOUL only
- 🎯 **Home Watch Anomaly Badge**: Welcome page watch cards show anomaly count
- 🎯 **Mermaid Zoom**: Click to enlarge with fixed white background
- 🎯 **Resizable Welcome Sidebar**: Drag to resize recent conversations sidebar; width cached in localStorage to avoid layout jump on startup
- 🎯 **Sub-Agent Safety**: Block dangerous commands and clearly communicate system limits to sub-agents

### Improvements
- ⚡ **Browser Bridge Protocol v1**: Thin extension architecture; content extraction moved to desktop Readability
- ⚡ **Artifact History Externalization**: Persist regenerable content; canvasData no longer lost after resume
- ⚡ **UI Polish**: Successful tool_result hidden by default; knowledge/startup progress bars split and fixed to avoid layout bounce; AiPanel scroll position saved across tabs
- ⚡ **OEM Brand Override**: Unified window title and i18n strings
- ⚡ **Data Management**: Added assistant session count in storage stats
- ⚡ **CI**: Windows build heap limit, model file caching, Dependabot security PR routing fix

### Bug Fixes
- 🐛 **Terminal Tool Regression**: Fixed v11 terminal tools not working
- 🐛 **Browser Bridge Reconnect**: Auto-reconnect after restart
- 🐛 **Streaming Messages**: Scroll-to-bottom interruption and "new message" flicker; user supplement messages out of order or lost
- 🐛 **Artifact Panel**: Lost on resume, collapse bar icons, animation, PPT preview color mismatch, Electron tooltip, etc.
- 🐛 **Email Attachments**: ZIP GBK extraction and overwrite protection
- 🐛 **Image Preview**: Mac trackpad gestures, pointer-anchored zoom
- 🐛 **Build**: vue-tsc errors breaking Windows installer build
- 🐛 **Website**: Browser bridge privacy policy page title hidden under navbar

## v11.0.0 (2026-06-12)

> A redesigned home page—start conversations, browse and manage recent history, and switch back to your workspace without losing progress.

### New Features
- 🎯 **Redesigned Home Page**: Integrated composer on the welcome page to start assistant chats without opening a tab first; recent conversations sidebar with browse, pin, custom titles, and right-click rename/delete
- 🎯 **Persistent Home Entry**: Home button stays available while work is in progress; return to the welcome page anytime without losing conversation progress, with history linked to current work state

### Improvements
- ⚡ **Agent History Storage Hardening**: Per-session file storage with atomic writes; legacy data migrated automatically on startup

### Bug Fixes
- 🐛 **Main Process i18n**: Menu, quit confirmation, and other user-visible main-process strings now follow the selected language
- 🐛 TTS auto-read did not sync when the setting was enabled

## v10.43.2 (2026-06-10)

> Introduced the workbench architecture, abstracting terminal and assistant UIs into a composable region model to lay the foundation for future extensions such as a browser workbench; plus minor knowledge index and loading progress improvements and a few bug fixes.

### Improvements
- ⚡ **Workbench Architecture Refactor** (internal): Terminal and assistant UIs abstracted into a workbench model with composable, extensible regions—foundation for future workbench types
- ⚡ **Incremental Knowledge Index Repair**: On startup, missing vector/BM25 entries are repaired incrementally instead of a full rebuild; checkpoint support allows resuming after interruption
- ⚡ **Unified System Loading Progress**: Backend startup and knowledge index repair merged into a single loading bar
- ⚡ **Loading Progress UI**: Multiple progress bars no longer overlap; index repair copy updated to "repair"

### Bug Fixes
- 🐛 **PPT Card Layout**: Fixed missing titles/badges inside cards and normalized in-card document flow
- 🐛 **IM Duplicate Notifications**: `talk_to_user` no longer pushes duplicate tool-process notifications

## v10.43.1 (2026-06-08)

> Improved exec output truncation and updater dialog experience, plus fixes for stale streaming placeholders after network failures.

### Improvements
- ⚡ **Updater Version Summary**: The auto-update dialog now shows the current version's changelog summary with a link to the full release notes.
- ⚡ **Exec Output Truncation**: Command output uses 16KB line-level head/tail truncation with metadata; full lines are preserved when possible, falling back to character truncation only when necessary.
- ⚡ **Hide Redundant Tool Result Cards**: Successful file write/edit operations no longer show redundant tool_result cards for a cleaner chat interface.
- ⚡ **Website Performance**: Reduced CPU usage when the website page stays open.

### Bug Fixes
- 🐛 **Network Failure Placeholder Cleanup**: Stale streaming placeholder steps are now cleared after Agent network request failures, preventing the UI from getting stuck.

## v10.43.0 (2026-06-05)

> Agent 可以生成可编辑的 PowerPoint 了，技能 API Key 配置和文件发送等体验也打磨得更顺手。

### New Features
- 🎯 **PPT Generation**: Agent can now generate editable PowerPoint documents directly. HTML content is rendered via browser and mapped to native PPT elements (text, shapes, images), supporting real-time streaming progress, Canvas preview, and append-on-overflow.

### Improvements
- ⚡ **Skill API Key Management**: Configure API keys directly in skill cards with persistent status display. `load_user_skill` auto-injects keys into terminal environment, no more manual env vars.
- ⚡ **Context Progress Bar**: Progress bar now shows the actual model name being used for the current conversation.
- ⚡ **Async File Sending**: File uploads no longer block the UI. Agent asynchronously tracks progress and waits for results.
- ⚡ **Cleaner Non-debug Mode**: Tool success logs are hidden by default in non-debug mode for a cleaner chat interface.
- ⚡ **Improved Image Preview**: Multi-image preview reworked to a compact single-column list navigation.
- ⚡ **Windows First-start Optimization**: LanceDB moved to a separate utility process, eliminating the first-launch freeze on Windows.
- ⚡ **Non-blocking Knowledge Search**: BM25 index uses async I/O, no more UI stutter during knowledge base search.

### Bug Fixes
- 🐛 Fixed file message notification showing raw `{name}{size}` placeholders.
- 🐛 Fixed unescaped raw HTML in Markdown causing Meta Refresh injection risk.
- 🐛 Fixed base64 inline images in agent execution steps causing renderer crashes.
- 🐛 Reduced embedding batch size to prevent knowledge base processing overload.
- 🐛 WeChat CDN upload now uses idle detection instead of fixed timeout for more stable connections.

## v10.42.0 (2026-06-02)

> Customizable Tab names, Mermaid chart rendering in AI chat, API key test in AI settings, async history search, and several fixes.

### New Features
- 🎯 **Customizable Tab Names**: Double-click a tab title to enter inline editing mode. Press Enter/blur to save, Esc to cancel. Clearing the custom title restores the auto-generated title.
- 🎯 **Mermaid Chart Rendering in AI Chat**: Render ` ```mermaid ` code blocks as architecture diagrams, flowcharts, sequence diagrams, etc. Supports streaming progressive rendering, right-click copy/save as PNG/SVG/JPG.
- 🎯 **AI Settings: API Key Test & Model List**: Test API key and endpoint connectivity with latency display. Fetch available models from `/v1/models` and display in a dropdown. Auto-detect vision models and set modelType accordingly.

### Improvements
- ⚡ **Async History Search**: History search is now fully asynchronous, eliminating main thread freezing. Cold-start recall is parallelized for faster startup.

### Bug Fixes
- 🐛 Fixed Tab rename input focus and select-all failure caused by string refs in v-for.
- 🐛 Fixed updater dialog logic: show confirmation dialog when auto-download is off; skip redundant toast when auto-download is on.

## v10.41.1 (2026-05-30)

> Canvas preview improvements with open button and macOS update experience optimization.

### New Features
- 🎯 **Canvas Preview "Open" Button**: Added an "Open" button to the Canvas preview panel with a dropdown option to reveal the file in Finder/Explorer.
- 🎯 **macOS Update Optimization**: Update downloads now redirect to the official website and automatically select the correct version based on your interface language.

### Improvements
- 🎨 **Refined Canvas Open Button Style**: Polished the visual appearance of the open button in the preview panel.
- 📝 **Simplified Save Label**: Streamlined the save button text in Canvas preview for clarity.

### Bug Fixes
- 🔧 **Fixed Canvas Preview Gap**: Eliminated the unwanted gap between the assistant's conversation area and the Canvas preview panel.

## v10.41.0 (2026-05-29)

> Custom data directory with auto-migration, comprehensive WeChat stability improvements, and various bug fixes.

### New Features
- 🎯 **Custom Data Directory**: Users can now choose a custom data storage location; data auto-migrates on restart with a progress window
- 🎯 **Auto-Update Improvements**: Refined update notification and installation strategies
- 🎯 **MCP Tool Chinese Display Name**: Tool call steps now show Chinese display names for better readability

### Bug Fixes
- 🐛 **CI Build Failure**: Removed `references` in `tsconfig.json` to fix TS6305 error on clean CI environments
- 🐛 **WeChat Stability Overhaul**: Fixed message avalanches, duplicate sending, connection drops, long-task disconnects, message ordering, keepalive self-healing, and tool failure indicators — aligned with official 2.4.4 SDK
- 🐛 **Agent Onboarding**: Only shows automatically once; skip no longer repeats
- 🐛 **Excel Header Duplication**: Fixed repeated header rows and added pre-write validation
- 🐛 **Paste Logic Unification**: Word paste now only pastes plain text
- 🐛 **Concurrent Session Guard**: Prevented re-opening completed tasks while Agent is still running

### Tests
- 🧪 **WeChat Adapter Tests**: Aligned test assertions with actual implementation

## v10.40.1 (2026-05-24)

> Fixes Chinese PDF rendering, WeChat long-task disconnects, and Canvas Markdown preview issues, plus improvements to terminal batch commands and Word document handling.

### Improvements
- 🔧 **Batch Commands for Split Panes**: Batch commands can target split-pane windows and support range switching
- 🔧 **Word Style Extraction from Templates**: Automatically extract styles from docx templates to simplify formatting workflows
- 🔧 **Canvas Markdown Preview**: Defaults to preview mode; preview content can be quoted to AI with text selection and copy support
- 🔧 **Unified Word Title Conventions**: Standardized document title format with tolerance for `## title:` typos
- 🔧 **Chart White Background**: `render_echarts_option` now injects a white background by default

### Bug Fixes
- 🐛 **Chinese PDF Rendering Boxes**: Injected cMap and standard_fonts to fix missing glyphs
- 🐛 **PDF Packaging Render Failure**: Added pdfjs-config.mjs to asarUnpack for production PDF rendering
- 🐛 **WeChat Long-Task Disconnect**: Typing keepalive now spans the entire Agent task
- 🐛 **WeChat Delivery Failure Sync**: Delivery failures sync to IM and register sessions on inbound messages
- 🐛 **Canvas Shortcut & Focus Styles**: Fixed Markdown preview shortcut toggle and removed focus halo

## v10.40.0 (2026-05-18)

> Canvas Markdown panels now support editing and preview switching with AI reference, plus improved quoting, background task notifications, and more.

### New Features
- 🎯 **Markdown Panel Editing**: Canvas Markdown panels now support switching between edit and preview mode; content can be directly referenced into the AI input box

### Improvements
