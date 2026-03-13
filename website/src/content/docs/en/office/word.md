---
title: "Word Documents"
description: "Let AI create and edit Word documents for you"
---

# Word Documents

SailFish's AI Agent can create professional Word documents (.docx), including reports, proposals, summaries, meeting notes, and more. Just describe what you need, and the AI will handle formatting and produce the Word file.

## Quick Start

Tell the AI what kind of document you need:

```
Write a project weekly report including work completed this week, issues encountered, and next week's plan
```

```
Generate a server health check report with CPU, memory, and disk usage
```

The AI will create a well-formatted Word document and tell you where it was saved.

## Document Format Support

AI-created Word documents support rich formatting elements:

| Element | Description |
|---------|-------------|
| Heading levels | H1, H2, H3 headings with automatic table of contents structure |
| Body paragraphs | Plain paragraph text with automatic layout |
| Ordered lists | 1. 2. 3. numbered lists |
| Unordered lists | Bullet lists |
| Tables | Data tables with headers |
| Bold/Italic | Text emphasis |

## Use Cases in Detail

### Work Reports

Have the AI generate reports from real data:

```
Based on this week's Git commits, write a weekly work summary including:
main tasks completed, code change stats, and next week's plan
```

```
Check the production servers and generate an ops weekly report as a Word document
```

The AI will run commands to collect data, then format it into a structured Word report.

### Technical Documentation

```
Turn our project's deployment process into a Word document,
including environment setup, deployment steps, verification, and rollback
```

```
Read README.md and convert it into a better-formatted Word document
```

### Data Analysis Reports

```
Analyze access.log for the last 24 hours and generate an analysis report
including: total visits, TOP 10 pages, error rate trends, suspicious IPs
```

```
Summarize error distribution in /var/log/syslog over the past week and generate a fault analysis report
```

### Meeting Notes

```
Organize these points into meeting notes:
1. Discussed Q2 product roadmap
2. Decided to launch user center redesign next week
3. Li Ming on frontend, Wang Hua on backend
4. Next meeting: Friday 3 PM
```

### Proposals

```
Write a MySQL database migration proposal.
Current: MySQL 5.7, target MySQL 8.0.
Include: risk assessment, migration steps, rollback plan, testing
```

## Let the AI Edit Existing Documents

The AI can also read and modify existing Word documents:

```
Read "Project Plan.docx" on my desktop and add a "Risk Control" section after Chapter 3
```

```
Open report.docx and update all dates to this month
```

## File Location and Retrieval

Generated Word documents are saved by default in the Agent workspace (`agent-workspace`). You can get them in several ways:

| Method | Action |
|--------|--------|
| View path | Ask the AI where the file was saved |
| Send to IM | Ask the AI to send the file to DingTalk/Feishu/WeCom/Slack |
| Move file | Ask the AI to move it (e.g., to the desktop) |
| Download | Find the file in the file manager and download |

Common commands:

```
Move the report we just generated to my desktop
```

```
Send this document to me via Feishu
```

## Working with Excel and PDF

SailFish can also work with Excel and PDF:

- **Excel**: Read and create .xlsx files for data analysis and tables
- **PDF**: Read PDF content for analysis and extraction

```
Read sales data from data.xlsx, summarize by month, and generate an analysis report as Word
```

```
Read the key terms from this contract PDF and create a summary Word document
```
