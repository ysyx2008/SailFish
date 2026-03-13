---
title: "Knowledge Base"
description: "Build a private knowledge base and teach AI what it needs to know"
---

# Knowledge Base

SailFish lets you import documents to build a private knowledge base that the AI can search and reference. Combined with its multi-level memory system, the AI remembers what you teach it across sessions.

## Importing Documents

### Supported Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| Markdown | `.md` | Best format — preserves structure |
| Plain Text | `.txt` | Good for logs, notes, etc. |
| PDF | `.pdf` | Text extracted automatically |
| Word | `.docx` | Text and tables extracted |

### How to Import

1. Click the **Knowledge Base icon** in the left sidebar
2. Click "Import Document"
3. Select the file(s) you want to import (multi-select supported)
4. Wait for processing to complete

The processing pipeline includes:

- **Chunking**: Splits long documents into semantically coherent segments
- **Vector embedding**: Generates vector representations for each chunk (using a local embedding model)
- **Indexing**: Builds a vector index plus a BM25 keyword index, enabling both semantic and keyword search

### Fully Local Processing

All document processing runs entirely on your machine using the built-in embedding model (Transformers.js). Nothing is uploaded to any external service. Your data never leaves your computer.

### Import Tips

- **Choose high-value documents**: Project docs, runbooks, team guidelines — things you reference frequently
- **Keep documents up to date**: If content changes, delete the old version and re-import
- **Markdown works best**: Well-structured Markdown with clear headings produces the highest quality chunks
- **Avoid very large files**: Keep individual files under 10 MB for best performance

## Using the Knowledge Base

Once documents are imported, the AI automatically searches the knowledge base when it needs information. You can also ask it to look things up directly:

```
According to our knowledge base, what is the deployment process?
```

```
Is there anything in the knowledge base about database backups?
```

```
Look up the API docs for the user authentication section.
```

### How Retrieval Works

When the AI searches for information, it uses two retrieval methods simultaneously:

- **Semantic search**: Understands the meaning of your question and finds conceptually related content — even if the exact words differ
- **Keyword search (BM25)**: Matches exact terms, ideal for specific names, configuration keys, and technical identifiers

Results from both methods are merged and ranked. The most relevant content is injected into the AI's context.

## Three-Level Memory System

SailFish's AI has three memory tiers that mimic how human memory works:

### L1 — Task Memory (Working Memory)

Complete conversation records from the most recent tasks, kept directly in the context window. Like something you just did — you remember every detail.

- Managed automatically; no manual action required
- More recent tasks retain more detail; older ones are progressively compressed
- 5-level progressive compression: from full conversation down to a one-sentence summary, maximizing information within the token budget

### L2 — Knowledge Documents (Long-Term Factual Memory)

Information you explicitly teach the AI, or important facts the AI summarizes on its own. Loaded into context automatically at the start of every conversation.

For example, you tell the AI:

```
Remember: our production database is at 10.0.1.50:3306, username app_user
```

From that point on, the AI knows this in every conversation — no need to repeat it.

**How it's organized**:

- Per-context: each server gets its own "host profile" recording OS, installed software, network config, etc.
- Without a terminal, it's organized per user — storing personal preferences and work habits
- Only stores high-value, frequently reused facts; every entry is worth the tokens to auto-inject

**What belongs in L2**:

| Good fit | Not a good fit |
|----------|----------------|
| Server IPs, ports, credentials | One-off troubleshooting sessions |
| Project deployment processes | Temporary test data |
| Team coding standards | Full log contents |
| Common command aliases | Specific details of a single operation |

### L3 — Conversation Records (Episodic Memory)

Complete historical conversations are permanently saved. The AI can search them proactively using its tools. Like experiences you need to "think back" to recall.

```
You: How did we fix the nginx 502 error last time?
AI: [searches conversation history, finds relevant records, and summarizes]
```

**L2 vs L3**:

- L2 provides facts ("nginx listens on port 8080"), loaded automatically every time
- L3 provides experience ("how we debugged it last time"), loaded on demand via search
- With L3 as a safety net, L2 doesn't need to store everything — it can stay focused on core facts

## Managing the Knowledge Base

In the knowledge base panel you can:

- **View imported documents** — see the list and processing status
- **Search** the knowledge base — test retrieval quality
- **Delete** documents you no longer need (frees storage)

### CLI Operations

You can also manage the knowledge base from the command line:

```bash
npm run sft -- knowledge:list           # list imported documents
npm run sft -- knowledge:search "query" # search the knowledge base
```
