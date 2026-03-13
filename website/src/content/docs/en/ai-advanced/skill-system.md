---
title: "Skill System"
description: "Understand SailFish's skill extension mechanism, and how to install and manage skills"
---

# Skill System

Skills are SailFish's mechanism for extending AI capabilities. Each skill is a set of dedicated tools and prompts that let the AI complete tasks in a specific domain—like installing specialized modules for the AI.

## Built-in Skills

SailFish includes multiple built-in skills for office, operations, and collaboration:

| Skill | Function | Config Required |
|-------|----------|:----------------:|
| Word | Create and edit .docx documents | No |
| Excel | Read and write .xlsx files | No |
| PDF | Read and analyze PDF document content | No |
| Browser | Web browsing, screenshots, form filling, and automation | No |
| Email | View, send, and reply to email | Yes (email account) |
| Calendar & Tasks | View schedule, create events, set reminders | Yes (calendar) |
| Feishu | Operate Feishu spreadsheets, docs, calendar, etc. | Yes (Feishu app) |
| DingTalk | Operate DingTalk calendar, todos, approval flows | Yes (DingTalk app) |
| WeCom | Operate WeCom directory, schedule, approvals | Yes (WeCom app) |
| Awaken Mode | Create and manage automated watches | No |
| Personality | Customize AI speaking style and personality traits | No |
| Skill Creator | Let the AI write new skills | No |

Built-in skills do not require installation. Skills marked "Config Required" need account details filled in under Settings before use.

## How Skills Work

### Automatic Loading

You do not need to manually activate skills. SailFish **automatically determines** which skills to load based on your requests:

| What You Say | Skill Auto-Loaded |
|--------------|-------------------|
| "Help me write a report" | Word skill |
| "Check if I have new email" | Email skill |
| "Open Baidu and search" | Browser skill |
| "What's on my schedule today" | Calendar skill |
| "Check the server every morning at 9" | Awaken Mode skill |

### Skill Structure

Each skill is essentially a Markdown file (`SKILL.md`) containing:

- **Role definition**: The AI's identity and behavioral guidelines when using the skill
- **Tool descriptions**: Tool functions and parameter definitions (Function Calling format)
- **Usage examples**: Typical scenarios and conversation examples to guide AI usage
- **Notes**: Limitations, best practices, etc.

### Execution Flow

Using the Email skill as an example:

1. You say: "Send a meeting notice to team@company.com"
2. SailFish detects an email-related request and loads the Email skill
3. The AI gains access to tools like `send_email`
4. The AI calls `send_email` with recipient, subject, and body
5. SailFish's email service performs the actual send
6. The AI reports the result

## Skill Market

Community-contributed skills can be installed from the skill market:

### Browse and Install

1. Open **Settings** → **Skill Management** → **Skill Market**
2. Browse available skills; each has descriptions and example screenshots
3. Click **Install**

You can also browse all skills on the [Skill Market](/skills) page.

### Install via CLI

Install skills from the command line:

```bash
npm run sft -- skill:install <skill-name>
```

List installed skills:

```bash
npm run sft -- skill:list
```

## Managing Installed Skills

Under **Settings** → **Skill Management** you can:

- **View** the list of installed skills and their descriptions
- **Uninstall** skills you no longer need
- **View skill content** (the SKILL.md source to understand capabilities)
- **Update**: Reinstall to get the latest version

## Custom Skills

### Let the AI Create Skills

SailFish includes a "Skill Creator" that lets you ask the AI to write new skills:

```
Create a skill that can query my Jira to-do items
```

The AI will generate an SKILL.md file based on your needs; after you confirm, it becomes available.

### Manual Creation

If you're familiar with Markdown and Function Calling format, you can create skill files manually. Basic structure:

```markdown
# Skill Name

## Role
You are an XXX assistant...

## Tools

### tool_name
Description: What it does
Parameters:
- param1 (string): Parameter description
```

## Contributing Skills

If you create a useful skill, consider sharing it with the community:

1. Write an SKILL.md that defines the skill and its tools
2. Test to confirm it works
3. Submit a Pull Request to the [GitHub repository](https://github.com/ysyx2008/SailFish)
4. After review, it will appear in the skill market

Good skills should:

- Address a clear, specific use case
- Have well-defined tools and usage examples
- Include error handling and edge-case notes
