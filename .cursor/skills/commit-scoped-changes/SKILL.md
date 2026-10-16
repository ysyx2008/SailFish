---
name: commit-scoped-changes
description: When committing or staging changes, only include files related to the current task or conversation; do not stage or commit unrelated modifications. Before committing, update docs/ideas.md when the change matches an existing idea. Use when the user asks to commit, stage, 提交, or when preparing to run git add/commit.
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
6. **提交前对想法本**（下面一节）。对得上的状态改动和功能放进同一次提交。

## 想法本

准备提交前打开 `docs/ideas.md`，只看「未完成」和「做成了但不上线」，对一下**这次改动**。条目怎么写仍按想法本规则，这里只规定提交时必须做的事。

- **对得上**：改那一条的状态，不要等以后再补。合进主线（`develop`）的挪到「已完成」；做了但还留在分支里、不准备这次合进去的，挪到「做成了但不上线」并写上分支名。**已落实**写用户能感知的结果。
- **对不上**：不动本子，也不要因为这次做了件本子里没有的事就新记一条。修复、重构、依赖升级通常对不上。
- **和代码一起交**：想法本的状态改动纳入本次提交，不要留在工作区里。
- **哈希后补**：提交完成后，把这次的短哈希写进对得上的那几条。若工作区因此只多了想法本这一处改动，再单独提交这一处，说明是补哈希。不要为了补哈希改写刚才那次提交。
- **不要顺手全本对照**。整本从「上次对照提交」重对一遍，只在用户说「对照一下 / 哪些做了」时做。

## 要求

- 只 `git add` 和 `git commit` 与当前需求、当前修复或当前功能相关的文件。
- 不要把未完成的重构、调试代码、别的功能改动、顺手改的格式/注释等一并提交。
- 每个 commit 保持语义清晰，便于回滚和 code review。

## 示例

- **当前任务**：修复 config 技能的某处逻辑 → 只提交 `electron/services/agent/skills/config/` 下相关文件；若同时改动了 `prompt-builder.ts` 且与本次修复无关，不提交。
- **当前任务**：新增一个 API → 只提交该 API 涉及的新增/修改文件，不把本地顺手改的格式化、注释等一起提交。
