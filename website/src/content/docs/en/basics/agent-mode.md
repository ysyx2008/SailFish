---
title: 'Agent Mode'
description: 'Understand how the AI Agent autonomously plans and executes tasks'
---

# Agent Mode

Agent mode is SailFish's most powerful feature—the AI doesn't just chat; it **plans steps, calls tools, and completes tasks on its own**. You describe the goal, and the AI works like a capable assistant.

## What is an Agent?

Typical AI chat answers questions but cannot act. SailFish's Agent is different:

| Regular AI Chat | SailFish Agent |
|-----------------|----------------|
| Tells you what command to run | Runs the command for you |
| Gives you step-by-step instructions | Performs the steps automatically |
| Leaves you to fix problems | Investigates and fixes issues itself |

For example, if you say "Deploy the latest version to the staging environment," the Agent will:

1. Pull the latest code (git pull)
2. Install dependencies (npm install)
3. Build the project (npm run build)
4. Restart the service (systemctl restart app)
5. Verify the service is running
6. Report back to you

If a step fails, the Agent analyzes the cause and tries to fix it.

## Execution Modes

You control how much autonomy the Agent has. Use the mode switcher at the top of the chat area:

### Strict Mode

- **Every step needs your confirmation** before it runs
- Best for critical systems or when you're new to the Agent
- The AI shows the planned command and waits for you to click "Allow"

### Relaxed Mode — Recommended

- **Safe actions run automatically** (reading files, listing processes, etc.)
- **Risky actions require confirmation** (delete files, change configs, restart services, etc.)
- Balances efficiency and safety for daily use

### Free Mode

- **The AI runs everything on its own** without asking
- Best for fully trusted or non-critical environments
- Maximum speed but use with care

> **Recommendation**: Start with Relaxed mode, then consider Free mode once you're comfortable with the Agent's behavior.

## Risk Assessment

Before each operation, the Agent assigns a risk level:

| Level | Description | Examples |
|-------|-------------|----------|
| **Safe** | Read-only, no changes | List files, check processes, view disk usage |
| **Moderate** | May change content but usually recoverable | Create files, install packages, edit config |
| **Dangerous** | Risk of data loss or service interruption | Delete files, restart services, change permissions |
| **Blocked** | Very high risk | rm -rf /, formatting disks |

In Strict and Relaxed modes, operations at Moderate or higher trigger a confirmation dialog showing:

- The exact command to run
- The risk level
- "Allow" and "Deny" buttons

## Agent Workspace

The Agent has a private workspace directory (`agent-workspace`) for temporary files and drafts. File reads and writes inside this directory run without confirmation, even in Strict mode.

## Available Tools

The Agent can use:

- **Terminal commands**: Run commands on your machine or remote servers
- **File operations**: Read, create, edit, and delete files
- **Knowledge base**: Search and use information from your knowledge base
- **Memory management**: Store and recall important information
- **Skills**: Email, calendar, Word, browser, and other extensions
- **MCP tools**: External tools connected via the Model Context Protocol

## Viewing the Execution Process

While the Agent works, you see:

- **Reasoning**: What the AI is planning and why
- **Tool calls**: Which commands or operations it is running
- **Results**: Command output and the AI's analysis

Everything is visible so you always know what the Agent is doing.

## Interrupting Tasks

You can stop execution at any time:

- Click the **"Stop"** button to pause the current operation
- The AI stops the current step and waits for your next instructions
- You can redirect the Agent or try a different approach
