---
title: 'Terminal Basics'
description: 'Learn how to use SailFish''s built-in terminal'
---

# Terminal Basics

SailFish includes a built-in terminal emulator where you can run commands, manage systems, and work with the AI. Even if you have never used a terminal before, the AI can help you get started quickly.

## Opening a Terminal

### Local Terminal

Open a terminal connected to your local machine:

1. Click the **"+"** button in the top tab bar
2. Select **"Local Terminal"**
3. A new terminal tab opens where you can type commands

### SSH Remote Terminal

Connect to a remote server:

1. Click a server in the connection list in the left sidebar
2. Or click **"+"** → **"SSH Connection"** and enter server details

> For detailed SSH setup, see [SSH Connection](/docs/server/ssh-connection).

## Terminal Interface

The terminal area has two parts:

- **Top: Command area** — The terminal window with dark background, showing command output
- **Bottom: AI chat area** — Where you type natural language to talk to the AI

You can type commands directly in the terminal (as in a normal terminal) or describe what you want in the AI chat and let the AI run commands for you.

## Basic Operations

### Typing Commands Manually

Type commands in the terminal and press Enter:

```bash
ls -la          # List files in current directory
pwd             # Show current path
cd /tmp         # Change to /tmp directory
```

### Asking the AI to Run Commands

Not sure which command to use? Describe your goal in the AI chat:

```
Show me which files in the current directory are larger than 100MB
```

The AI will choose the right command, run it, and explain the result.

### Having the AI Explain Output

If a command ran but you don’t understand the output, ask the AI:

```
What does that output mean? Any issues?
```

The AI can see the terminal output and help you analyze it.

## Multiple Tabs

You can run multiple terminal tabs at once:

- **New tab**: Click **"+"** in the tab bar or press `Ctrl/Cmd + T`
- **Switch tab**: Click a tab or press `Ctrl/Cmd + Tab`
- **Close tab**: Click the **"×"** on the tab or press `Ctrl/Cmd + W`
- **Rename tab**: Right‑click the tab and choose "Rename"
- **Reorder tabs**: Drag tabs to change their order

Example workflow: open tabs for production, test, and local, and switch as needed.

## Terminal Settings

Under **Settings → Terminal** you can customize:

- **Font and size**: Choose your preferred monospace font
- **Theme**: Several color schemes are available
- **Default shell**: On macOS/Linux you can switch between bash, zsh, etc.
- **Cursor style**: Block, underline, or bar

## Terminal and AI Collaboration

The terminal and AI work together. The AI can:

- See the current working directory and recent terminal output
- Run commands directly in the terminal
- Analyze output and point out issues
- Help troubleshoot errors from command output

You can run commands yourself and turn to the AI when something is unclear:

```
You: [Manually run docker-compose up and see errors]
You: Why did docker-compose fail to start?
AI: [Analyzes terminal output, finds port conflict, suggests fix]
```
