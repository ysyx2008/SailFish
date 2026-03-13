---
title: "Interface Overview"
description: "Get familiar with SailFish main interface layout and key areas"
---

# Interface Overview

When you open SailFish, you will see a dark-themed main interface. This page helps you quickly understand what each area does and where to find things.

## Layout Overview

The SailFish interface is divided into three main areas:

- **Left Sidebar** — Navigation and quick access
- **Center Main Area** — Core workspace for terminal / AI chat / file management, etc.
- **Top Tab Bar** — Multi-tab switching (similar to browser tabs)

## Left Sidebar

From top to bottom, the left sidebar contains:

### Connection Management

At the top is your server connection list. Here you can:

- View saved SSH servers
- Click a server name to connect
- Click the **"+"** button to add a new server

If you only use SailFish locally for now, you can ignore this area.

### Feature Entries

In the middle of the sidebar are several icon buttons for different modules:

- **Terminal** — Open local or SSH terminal
- **File Manager** — Browse and manage local / remote files
- **Knowledge Base** — Import documents to build a private AI knowledge base
- **Awaken Panel** — Manage AI proactive monitoring tasks (Awaken mode)

### Settings

At the bottom of the sidebar is the **⚙️ Settings** icon. Click it to open the settings page. All configurations are here: AI models, SSH keys, IM integrations, skill management, and more.

## Top Tab Bar

SailFish supports multi-tab operation, similar to browser tabs:

- Each terminal connection appears as a tab
- Click **"+"** to create a new tab
- Right-click a tab to rename, duplicate, or close it
- You can drag tabs to reorder them

You can have multiple tabs open at once—for example, one connected to production and one to a test environment—and switch between them as needed.

## Center Main Area

The content in the main area changes based on what you are doing:

### Terminal View

This is the most commonly used view. You will see a terminal window (similar to macOS Terminal or Windows CMD) where you can type commands. At the bottom of the terminal is the AI chat input box.

### AI Chat Area

In the area below the terminal (or in a separate chat panel), you will see the AI conversation area:

- **Input box** — Type what you want to say or describe your request
- **Conversation history** — AI replies and execution steps are shown here
- **Model selector** — Switch the active AI model at the top
- **Execution mode** — Controls how much human confirmation AI needs when executing tasks

### File Manager View

When you open the File Manager, you will see a file browsing interface similar to Finder or File Explorer, where you can browse, upload, download, and edit files.

## Quick Reference

| What You Want | Where to Find It |
|--------------|------------------|
| Configure AI model | Settings → AI Model Configuration |
| Add SSH server | Left sidebar "+" button, or Settings → SSH |
| Open local terminal | Click "+" on tab bar → Local Terminal |
| Chat with AI | Input box at bottom of terminal, or chat panel |
| Manage files | File Manager icon in left sidebar |
| Switch AI model | Model selector dropdown at top |
| Change execution mode | Execution mode button in chat area |
| View conversation history | History entry in sidebar |
| Open Awaken panel | Awaken icon in left sidebar |
| Install skills / MCP | Settings → Skill Management / MCP Configuration |

## Keyboard Shortcuts

SailFish supports several shortcuts for common actions:

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd + T` | New tab |
| `Ctrl/Cmd + W` | Close current tab |
| `Ctrl/Cmd + Tab` | Switch to next tab |
| `Ctrl/Cmd + ,` | Open settings |
| `Ctrl/Cmd + K` | Quick search |

## Interface Theme

SailFish uses a dark theme by default. If you prefer a light interface, you can change the terminal color scheme in Settings → Appearance.

## Next Step

Now that you know the SailFish interface, it is time to [have your first conversation with the AI](/docs/getting-started/first-conversation) and experience SailFish core capabilities.
