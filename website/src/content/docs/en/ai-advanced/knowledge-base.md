---
title: 'Knowledge Base'
description: 'Build a private knowledge base and teach AI what it needs to know'
---

# Knowledge Base

SailFish's knowledge base lets you import documents and build a private repository. The AI can search this content to answer questions. It also has a multi-level memory system so it remembers what you teach it.

## Importing Documents

### Supported Formats

- **Markdown** (.md)
- **Plain text** (.txt)
- **PDF** (.pdf)
- **Word** (.docx)
- Other common document formats

### How to Import

1. Click the **Knowledge Base** icon in the left sidebar.
2. Click **Import Document**.
3. Select the file(s) to import.
4. Wait for processing to finish (SailFish segments documents and builds vector embeddings automatically).

Imported documents are split into small segments and indexed with vectors for efficient retrieval by the AI.

### Fully Local Processing

Document processing (chunking, embedding) runs entirely on your machine. Nothing is uploaded to external services. Your data stays on your computer.

## Using the Knowledge Base

After importing documents, the AI automatically searches the knowledge base when answering. You can also ask it to look things up directly:

```
According to the knowledge base, what is our deployment process?
```

```
Is there any documentation about database backups in the knowledge base?
```

## Three-Level Memory System

SailFish's AI uses a three-level memory structure that mimics human memory:

### L1 — Task Memory (Working Memory)

Recent task conversations are kept directly in context. Like things you just did, you remember each exchange.

- Managed automatically, no manual steps needed.
- More recent tasks are kept in more detail.
- Maximizes useful information within the token budget.

### L2 — Knowledge Documents (Long-Term Fact Memory)

Information you explicitly teach the AI or important facts it summarizes. Loaded automatically for each conversation. Like objective knowledge you retain without recalling specific events.

Example:

```
Remember: Our production database is at 10.0.1.50:3306, username app_user
```

In later conversations, the AI will automatically use this information.

- Organized by context (e.g. per host or user).
- Only high-value, frequently used facts.
- Each entry is worth the tokens it uses.

### L3 — Conversation Records (Episodic Memory)

Complete historical conversations are stored permanently. The AI can search and retrieve them when needed. Like full experiences you have to "think back" to recall.

```
You: How did we fix the nginx 502 error last time?
AI: [Searches history, finds related records, summarizes]
```

## Knowledge Base Management

From the knowledge base panel you can:

- **View** the list of imported documents.
- **Delete** documents you no longer need.
- **Search** within the knowledge base.
