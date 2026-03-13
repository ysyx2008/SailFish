---
title: "First Conversation"
description: "Have your first conversation with the AI and experience SailFish core capabilities"
---

# First Conversation

Setup is complete and you know the interface. Now it is time to experience SailFish core capability—chatting with the AI and having it work for you.

## Say Your First Words

In the chat input box at the bottom of the terminal, type:

```
Hello, please introduce yourself
```

Press Enter to send. The AI will respond with a self-introduction and explain what it can do.

**Congratulations! You have successfully started a conversation with the AI.**

## Try Having the AI Execute Tasks

SailFish AI does not just chat—it can actually perform operations. Try these examples:

### Example 1: System Information

```
Show me my computer's OS version and memory usage
```

The AI will run appropriate system commands (such as `uname -a`, `free -h`, etc.) and explain the results in plain language.

### Example 2: File Management

```
List all files on my desktop
```

The AI will run file listing commands and show you the files on your desktop.

### Example 3: Get Help

```
How do I use the tar command? I want to compress a folder into .tar.gz
```

The AI will give you complete command examples and explanations that you can copy and use directly.

## How the AI Works

When you send a request that requires action, the AI follows this flow:

1. **Understand your need** — The AI analyzes what you said and what outcome you want
2. **Plan the steps** — If the task is complex, the AI breaks it into multiple steps
3. **Invoke tools** — The AI executes commands, reads and writes files, etc.
4. **Show results** — It presents the execution results and analysis back to you

In the chat area, you can see the AI "thinking process" and "tool calls"—everything is transparent.

## Execution Mode: Controlling How Autonomous the AI Is

SailFish offers three execution modes so you can control the AI level of autonomy:

| Mode | Description | Best For |
|------|-------------|----------|
| **Strict** | AI asks for your confirmation before every step | Getting started, or when working on critical systems |
| **Relaxed** | Safe actions run automatically, risky actions require confirmation | Daily use, balances efficiency and safety |
| **Free** | AI executes fully on its own, no questions asked | When you trust the AI or work in non-critical environments |

> **Beginner tip**: Start with "Relaxed" mode. The AI will automatically run safe actions (such as viewing files or reading info); for risky actions (such as deleting files or changing config), it will show a confirmation dialog so you can review and decide.

You can switch modes anytime using the execution mode button at the top of the chat area.

## Risk Confirmation

When the AI is about to perform a potentially risky action (such as deleting files or restarting a service), it will:

1. **Pause execution** and show the exact command it plans to run
2. **Label the risk level** (safe / moderate / dangerous / blocked)
3. **Wait for your confirmation**: You can choose "Allow" or "Deny"

This ensures the AI will not do dangerous things without your knowledge.

## Conversation Tips

A few tips to help the AI understand you better:

### Be Clear About What You Want

```
❌ "Help me process that file"
✅ "Sort /home/user/data.csv by the second column, remove duplicate rows, and save to /tmp/result.csv"
```

### You Can Take It Step by Step

You do not need to say everything in one message. Start with a general direction, then add details based on the AI reply:

```
You: "Check the nginx status"
AI: [Runs command and reports]
You: "Are there any 500 errors in the access log recently?"
AI: [Checks log and analyzes]
You: "Restart nginx for me"
AI: [Asks for confirmation, then executes]
```

### Provide Context

If you have discussed something with the AI before, you can continue in the same thread. The AI remembers the current conversation context.

```
You: "For that disk space issue earlier, help me clean up logs older than 30 days in /var/log"
```

### Send Images

SailFish lets you send screenshots or images for the AI to analyze (requires a vision-capable model):

- Paste a screenshot (Ctrl/Cmd + V)
- Drag an image into the chat input box
- Use the attachment button next to the input box

For example, send a screenshot of an error and ask "How do I fix this error?"

## Conversation History

Every conversation with the AI is saved automatically. You can find earlier conversations in the sidebar history and review or resume tasks.

## Clear Conversation

To start a brand new conversation (without earlier context), click the "Clear conversation" button in the chat area. The AI will forget the previous conversation and start fresh.

## Congratulations!

By now you have learned the basics of SailFish:

- ✅ Installed SailFish
- ✅ Configured AI service
- ✅ Learned the interface layout
- ✅ Had a conversation with the AI
- ✅ Understood execution modes and risk confirmation

## What to Explore Next

The getting started guide ends here. Depending on your needs, you can explore:

- **Want to learn more about AI conversation?** → [AI Conversation](/docs/basics/ai-conversation)
- **Want to connect to remote servers?** → [SSH Connection](/docs/server/ssh-connection)
- **Want AI to handle complex tasks automatically?** → [Agent Mode](/docs/basics/agent-mode)
- **Want to configure multiple AI models?** → [Model Configuration](/docs/ai-advanced/model-config)
- **Want AI to monitor and notify proactively?** → [Awaken Mode](/docs/awaken/awaken-intro)
- **Want to control it from your phone?** → [Remote Access Overview](/docs/remote-access/overview)
