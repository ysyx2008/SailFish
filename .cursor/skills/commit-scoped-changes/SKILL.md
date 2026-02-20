---
name: commit-scoped-changes
description: When committing or staging changes, only include files related to the current task or conversation; do not stage or commit unrelated modifications. Use when the user asks to commit, stage, 提交, or when preparing to run git add/commit.
---

# 只提交当前相关修改

执行或建议 git 提交时，**只提交与当前对话/任务直接相关的修改**，不把工作区里其他无关改动一并提交。

## 何时使用本技能

- 用户要求提交、stage、或说「提交一下」
- 你即将执行或建议 `git add` / `git commit` 时

## 步骤

1. **看当前任务**：根据本轮对话，明确「当前任务」是什么（例如：修复 config 技能、新增某 API、改某处文案）。
2. **看工作区**：运行 `git status`，列出所有已修改/未跟踪文件。
3. **划定范围**：只把**与当前任务直接相关**的文件纳入本次提交；其余视为无关，不 stage。
4. **执行提交**：
   - 只对相关文件执行 `git add <path>...`，再 `git commit`；
   - 或明确告诉用户：「以下文件与当前任务相关，建议只提交这些：…；以下文件未纳入本次提交：…」。
5. 若工作区存在明显与当前任务无关的修改，在提交后**简短提醒**用户还有未提交的改动（可列出文件），避免用户误以为都已提交。

## 要求

- 只 `git add` 和 `git commit` 与当前需求、当前修复或当前功能相关的文件。
- 不要把未完成的重构、调试代码、别的功能改动、顺手改的格式/注释等一并提交。
- 每个 commit 保持语义清晰，便于回滚和 code review。

## 示例

- **当前任务**：修复 config 技能的某处逻辑 → 只提交 `electron/services/agent/skills/config/` 下相关文件；若同时改动了 `prompt-builder.ts` 且与本次修复无关，不提交。
- **当前任务**：新增一个 API → 只提交该 API 涉及的新增/修改文件，不把本地顺手改的格式化、注释等一起提交。
