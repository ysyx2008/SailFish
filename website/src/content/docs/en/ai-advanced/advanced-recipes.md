---
title: "Advanced Recipes"
description: "Real-world examples of combining multiple skills to unlock SailFish's full potential"
---

# Advanced Recipes

SailFish's skills load automatically based on your needs, and multiple skills can chain together seamlessly. Just **describe your end goal**, and the AI will orchestrate all necessary capabilities to get it done.

Here are some real-world examples of multi-skill workflows to spark your imagination.

## Resume Screening & Sorting

**Skills involved**: PDF / file reading + Excel + Word

**Scenario**: You've received a batch of resumes (PDFs or scans) and need to quickly screen for qualified candidates and compile a report.

```
I have 20 resumes (PDF) in ~/Desktop/Resumes/.
Screen for candidates with 3+ years of Java backend experience.
Compile everyone's key info (name, years of experience, tech stack, most recent company) into an Excel sheet.
Then pick the top 5 matches and generate a Word recommendation report with reasons.
```

The AI will:
1. Read each PDF resume and extract key information
2. Filter by criteria and generate an Excel summary
3. Select the best candidates and produce a Word report with recommendations

You can follow up:

```
Send the recommendation report to the HR lead via Feishu.
```

## Competitive Analysis Report

**Skills involved**: Browser + Excel + Word

**Scenario**: Research competitor products and compile a structured analysis.

```
Help me create a competitive analysis:
1. Search for the top AI terminal/agent products (at least 5)
2. Collect each product's core features, pricing, and target users
3. Organize into a comparison Excel spreadsheet
4. Write a competitive analysis Word report with feature comparison, strengths/weaknesses, and differentiation suggestions
```

## Automated Data Reporting

**Skills involved**: Terminal + Excel + Word + Email + Awaken Mode

**Scenario**: Periodically collect data from servers, generate reports, and distribute them.

```
Set up an automated task:
- Run every Monday at 9 AM
- Log into the production server and collect last week's API call volume, error rates, and response times
- Organize the data into an Excel sheet with trend comparisons
- Generate a "Weekly API Quality Report" Word document
- Email it to tech-team@company.com
```

The AI will create an Awaken Mode watch that automatically executes the entire workflow on schedule.

## Document Translation & Localization

**Skills involved**: PDF / Word + Word

**Scenario**: Translate technical documents or contracts while preserving formatting.

```
Read ~/Documents/API-Specification.pdf,
translate the content to Chinese while preserving the original chapter structure,
and generate a Chinese version as a Word document.
Keep technical terms in English with Chinese explanations in parentheses.
```

Or batch translation:

```
Translate all English Markdown files in ~/docs/ to Chinese.
Save translated files with the same names under ~/docs/zh/.
```

## Email-Driven Workflows

**Skills involved**: Email + Calendar + Excel + Word

**Scenario**: Automatically process specific emails, extract information, and take follow-up actions.

```
Please do the following:
1. Check my inbox for emails from *@supplier.com in the last 3 days
2. Extract pricing info from each (product name, unit price, quantity, delivery date)
3. Compile into a price comparison Excel sheet
4. If any quotes are under our budget (reference ~/budget.xlsx), create a follow-up reminder on my calendar
5. Generate a procurement recommendation Word document
```

## Web Data Collection & Analysis

**Skills involved**: Browser + Excel + Word + Email/IM

**Scenario**: Scrape data from websites for analysis.

```
Collect data from Hacker News:
1. Get today's top 30 stories
2. Record title, author, points, number of comments
3. Organize into Excel sorted by points
4. Write a brief trend analysis and send it to Slack
```

## Automated Ops Daily Report

**Skills involved**: Terminal + Knowledge Base + Word + IM + Awaken Mode

**Scenario**: Automatically collect status from multiple servers, generate daily reports, and push notifications.

```
Create a watch:
- Run daily at 5:30 PM
- Check these 3 servers (SSH already configured):
  web-server, db-server, app-server
- Collect: CPU/memory usage, disk space, service status, today's error logs
- Compare with yesterday's data (from knowledge base)
- Generate an Ops Daily Report Word document
- If anomalies found, notify me immediately via DingTalk; if all normal, send the report to the WeCom ops group
- Save today's data to the knowledge base for future comparison
```

## End-to-End Meeting Automation

**Skills involved**: Calendar + Email + Word + IM

**Scenario**: Automate the full meeting lifecycle from scheduling to minutes.

Before the meeting:

```
Check my schedule for tomorrow, find all meetings,
and send a reminder email to each meeting's attendees with the agenda.
```

After the meeting:

```
Help me create minutes for this afternoon's product review:
- Decided to delay v2.0 launch to end of March
- Adding "Data Export" feature, assigned to Wang Ming
- Design mockups due by next Wednesday
Create a Word minutes document, send it to all attendees via Feishu,
and create calendar reminders for the key milestones.
```

## Technical Research & Knowledge Building

**Skills involved**: Browser + Knowledge Base + Word

**Scenario**: Research a technical topic, compile documentation, and save to the knowledge base.

```
Research Kubernetes HPA (Horizontal Pod Autoscaler):
1. Search and read official docs and best practices
2. Understand configuration methods, metric types, and common pitfalls
3. Write a technical research document (Word) with: principles, config examples, production tips
4. Save key takeaways to the knowledge base for quick reference later
```

## Tips for Combining Skills

### Use Natural Language

No special syntax required—just describe the complete workflow. The AI will figure out which skills to load and in what order.

### Step-by-Step Works Too

If describing everything at once feels overwhelming, give instructions one at a time:

```
First, read all CSV files in ~/data/
```

```
Summarize the data by month and create an Excel file
```

```
Write an analysis report based on the Excel data and email it
```

Each step's results stay in the Agent's context, so subsequent steps can naturally reference earlier work.

### Leverage Awaken Mode

If a workflow needs to run **on a schedule**, set it up as a watch. The AI will automatically execute the entire pipeline at the specified time—you just review the results.

### Leverage the Knowledge Base

The knowledge base carries information across conversations. Save screening criteria, document templates, or common configurations there, and the AI will automatically reference them during tasks.

### Works Remotely Too

All these workflows can be triggered remotely via DingTalk, Feishu, WeCom, Slack, or Telegram. Fire off a message from anywhere and let the AI handle the rest.
