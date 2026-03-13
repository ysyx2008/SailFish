---
title: 'AI Conversation'
description: 'Master the art of talking to AI for better results'
---

# AI Conversation

AI conversation is SailFish's core way of interacting. With a few best practices, you can help the AI understand your intent more accurately and complete tasks more efficiently.

## Basic Conversation Flow

1. Type your request in the input box and press Enter to send
2. The AI analyzes your intent and decides whether to answer directly or perform operations
3. If operations are needed, the AI calls tools (terminal commands, file operations, etc.)
4. The AI returns the execution results and analysis to you
5. You can continue the conversation or start a new task

## Tips for Writing Good Prompts

### Be Specific

The more concrete your description, the easier it is for the AI to understand:

| Less Effective | Better |
|----------------|--------|
| Look at some files | List files in /var/log modified in the last 3 days |
| Process the data | Sort data.csv by the second column, remove duplicates, save to result.csv |
| The server has problems | Check if nginx is running and start it if not |

### Break Down Complex Tasks

You don't need to describe everything in one message. Work step by step, like talking to a colleague:

```
You: Check the nginx status on the server
AI: [Runs systemctl status nginx, reports result]

You: Are there any 500 errors in the recent access logs?
AI: [Checks logs, finds 500 errors and analyzes causes]

You: Looks like a database connection timeout. Check MySQL status
AI: [Checks MySQL and provides analysis]
```

### Provide Context

Including relevant background helps the AI give better results:

```
Our web app runs in Docker with nginx as reverse proxy and Node.js backend.
Users report slow page loads—help me troubleshoot.
```

## Sending Images

SailFish supports sending images to the AI for analysis (requires a vision-capable model):

- **Paste screenshots**: Screenshot and press Ctrl/Cmd + V to paste into the chat
- **Drag and drop**: Drag image files onto the chat input area
- **Attachment button**: Click the attachment icon in the input box to choose files

Typical use cases:

- Capture an error screen and ask "How do I fix this error?"
- Send a webpage screenshot and ask "What's wrong with this layout?"
- Share a table screenshot for the AI to analyze data

> If your primary model doesn't support images (e.g., DeepSeek R1), you can configure an "associated vision model" (e.g., GPT-4o). SailFish will automatically switch when you send an image. See [Model Configuration](/docs/ai-advanced/model-config) for details.

## Conversation History

### Viewing History

All of your conversations are saved automatically. Click the history icon in the sidebar to browse past conversations, including:

- Chat content and AI replies
- Details of tool calls the AI made
- Timestamps

### Resuming a Conversation

Click a history entry to return to that context and continue. The AI will remember what was discussed before.

### Clearing the Conversation

Click "Clear conversation" in the chat area to start fresh. The AI will forget the current context and begin from scratch. Useful when you finish one task and want to switch to another.

## Context & Memory

### Session Context

Within a single conversation, the AI remembers what was said earlier. You can refer to prior content with phrases like "the one we mentioned" or "what you said above."

### Cross-Session Memory

SailFish uses a three-level memory system, so it can remember important information even across many conversations:

- **Task memory (L1)**: Recent task records, directly injected into the conversation
- **Knowledge docs (L2)**: Information you explicitly teach the AI (e.g., server configs, work habits), injected into the system prompt
- **Conversation records (L3)**: All past conversations, searchable and retrievable when needed

You can tell the AI "Remember: our production server IP is 10.0.1.100," and it will recall this in future requests.

## Multi-Model Switching

If you have multiple AI models configured, you can switch between them using the model selector at the top of the chat area:

- **Daily use with cheaper models**: e.g., DeepSeek (low cost, fast)
- **Complex tasks with stronger models**: e.g., Claude, GPT-4o (better reasoning)

Switching models does not lose the current conversation context.

## Interrupting Tasks

While the AI is working, you can always:

- **Stop the current operation**: Click the "Stop" button in the chat area
- **Reject a pending confirmation**: Click the "Deny" button

After an interrupt, the AI stops the current step and waits for your next instructions.
