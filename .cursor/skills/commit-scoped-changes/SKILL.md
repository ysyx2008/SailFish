---
name: commit-scoped-changes
description: When committing or staging changes, only include files related to the current task or conversation; do not stage or commit unrelated modifications. Before committing, update docs/ideas.md when the change matches an existing idea. After a commit lands on develop or main, retitle the chat to 「【已合入】<what this work does>」, a short line in the conversation's language. Use when a stage of work is done and checked (committing is the agent's job), when the user asks to commit, stage, 提交, or when preparing to run git add/commit.
---

# 兼容入口

执行前先完整读取仓库根目录下的 `.agents/skills/commit-scoped-changes/SKILL.md`；流程只在该文件维护。
