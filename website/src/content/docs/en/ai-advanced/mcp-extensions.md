---
title: "MCP Extensions"
description: "Connect databases, APIs and external tools via the MCP protocol"
---

# MCP Extensions

MCP (Model Context Protocol) is an open protocol that lets AI connect to external tools. Through MCP, you can give SailFish's AI Agent direct access to query databases, call APIs, and operate various external services—like installing dedicated plugins for the AI.

## What is MCP

### Without MCP

When the AI needs to query a database, it must do so indirectly through the terminal:

```
You: How many users are in the users table?
AI: [Runs mysql -u root -p -e "SELECT COUNT(*) FROM users"]
    → Needs password, handles command-line output parsing...
```

### With MCP

The AI operates directly through structured interfaces:

```
You: How many users are in the users table?
AI: [Calls the MySQL MCP tool's query method]
    → Gets structured results directly, faster and more accurate
```

The MCP ecosystem includes many open-source tools covering databases, file systems, version control, cloud services, and more.

## Adding MCP Tools

### Using Preset Templates (Recommended)

SailFish includes preset templates for popular MCP tools:

1. Open **Settings** → **MCP Configuration**
2. Click **Add**
3. Select the tool you need from the template list (e.g., MySQL, PostgreSQL)
4. Fill in the required configuration (e.g., database address, username, password)
5. Save and enable

### Manual Configuration

If no preset fits your needs, you can manually configure any MCP-compatible tool:

1. Click **Add** → **Manual Configuration**
2. Fill in the configuration:

| Field | Description | Example |
|-------|-------------|---------|
| Name | Custom name for identification | "Production Database" |
| Transport | stdio (local process) or SSE (remote service) | stdio |
| Command | Command to start the MCP server (stdio mode) | `npx @modelcontextprotocol/server-mysql` |
| Arguments | Command-line arguments | `--host 10.0.1.50 --port 3306` |
| Environment variables | Variables passed to the MCP process | `MYSQL_PASSWORD=xxx` |
| URL | MCP server address (SSE mode) | `http://localhost:8080/sse` |

### Two Transport Modes

| Transport | How It Works | Use Case |
|-----------|--------------|----------|
| **stdio** | SailFish starts a local process and communicates via stdin/stdout | Most scenarios (recommended) |
| **SSE** | Connects to a remote HTTP server via Server-Sent Events | MCP service hosted on a remote server |

## Recommended MCP Tools

| MCP Tool | Function | Use Case |
|----------|----------|----------|
| **mysql** | Query and operate MySQL databases | Data analysis, DB operations |
| **postgres** | Query and operate PostgreSQL | Data analysis, DB operations |
| **sqlite** | Operate SQLite databases | Local data file analysis |
| **filesystem** | Enhanced file system operations | Complex file management |
| **git** | Git repository operations (commit, branch, log) | Code management and review |
| **fetch** | Send HTTP requests | REST API calls |
| **puppeteer** | Browser automation | Screenshots, web scraping |
| **memory** | Persistent knowledge graph | Storing structured information |
| **everything** | Windows file search | Quick file lookups |

> Browse the full MCP tool catalog at [MCP official directory](https://modelcontextprotocol.io).

## Using MCP Tools

Once MCP is configured, the AI automatically detects available tools and invokes them when needed. Just describe what you want in natural language:

### Database Queries

```
How many users registered in the last 7 days?
```

```
What's the total order amount for today in the orders table?
```

```
List products with stock below 10 in the products table
```

### API Calls

```
Call our internal API and get the current number of online users
```

### File Search

```
Search my entire computer for Word files with "report" in the filename
```

## Managing MCP Tools

From the MCP configuration section in Settings you can:

| Action | Description |
|--------|-------------|
| Enable/Disable | Temporarily turn off an MCP tool (without removing config) |
| Reconnect | Reconnect when the MCP process unexpectedly disconnects |
| View tool list | See which tools and parameters the MCP provides |
| Edit | Change configuration (e.g., database address) |
| Delete | Remove MCP configurations you no longer need |

## Troubleshooting

### MCP Tool Fails to Start

- Ensure the required npm package is installed (most MCP tools run via `npx`)
- Check that your Node.js version meets requirements (18+ recommended)
- Check SailFish logs for error details

### Database MCP Cannot Connect

- Verify database address, port, username, and password
- Ensure the database allows connections from your machine
- Check firewall rules for the database port

### MCP Tool Not Used by AI

- Confirm MCP status is "Connected"
- Try explicitly mentioning the feature in your prompt (e.g., "query the database")
- Check the MCP tool list to confirm it provides the capability you need
