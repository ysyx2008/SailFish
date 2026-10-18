# 觉醒里的「用户」并入记忆里的「用户」

状态：**未完成**（2026-10-18 落盘，等用户确认后开工）

设计目标已写入 `electron/services/knowledge/SPEC.md`「『关于用户』只有一份」。本文只写怎么做。

## 现状：两份关于用户的东西

| | 觉醒页「用户」 | 记忆里的「个人」 |
|---|---|---|
| 存放 | `agent-workspace/USER.md` | 上下文记忆 `personal` |
| 谁写 | 觉醒页手改；personality 技能的 `user_craft` | 每轮对话结束后记忆更新（`ContextKnowledgeService`） |
| 进提示词 | `PromptBuilder.buildUserProfileSection` →「# 关于用户」 | 记忆注入（已知信息） |
| 上限 | 1000 字 | 用户设置，默认 5000 字 |

同一个人的信息会在每轮开头进两次。

## 做法

| 位置 | 改什么 |
|---|---|
| `src/components/Awaken.vue` + `i18n awaken.*` | 去掉「用户」标签页及其读写、状态 |
| `electron/services/agent/prompt-builder.ts` | 去掉「关于用户」段（`buildUserProfileSection`、`readUserFile`），工作区文件说明里去掉 USER.md 一行 |
| `skills/personality/{tools,executor,index}.ts` + `agent/i18n.ts` | 去掉 `user_craft`；觉醒引导里「写用户信息」那一步改成：告诉用户这些会进「用户」记忆，由记忆更新写入（见待确认） |
| `electron/main.ts` / `preload.ts` / `vite-env.d.ts` | 身份文件读写的 `USER.md` 分支去掉 |
| `electron/migrations/vN-user-md-to-memory.ts`（新） | 旧 USER.md 并进 `personal` 记忆末尾，成段加标题；并进后总长超上限则不并、保留原文件并记日志（不静默截断）；并成功后原文件改名留底（不删） |
| `host-identity.ts` 标题「个人」 | 给 AI 看的标题同改叫「用户」，与界面一致 |
| `electron/services/knowledge/SPEC.md`、`agent/` 下相关 SPEC | 随设计更新 |
| 测试 | prompt-builder 测试去掉 USER.md 断言；personality 技能测试；迁移测试（并入、放不下、已并过不重复） |

已有的界面标签「用户」、排第一已完成（`a37318fc`）。

## 任务拆解

1. 迁移：旧 USER.md 并进用户记忆。验收：迁移单测（并入 / 放不下 / 幂等）+ 用真实数据副本跑一遍看合并后的文档。
2. 提示词与技能：不再注入「关于用户」，去掉 `user_craft`。验收：prompt-builder / personality 单测；CLI 回归。
3. 觉醒页去掉「用户」标签。验收：界面里没有，其余标签正常。
4. 收尾：SPEC、架构文档、想法本。

## 风险

- 觉醒引导流程原本让 AI 在觉醒时写 USER.md；去掉后新用户觉醒时的「用户」记忆要靠首轮对话后的自动更新写入，觉醒当场不会有。待确认里问。
- 迁移并入后，记忆里「用户」可能第一次接近上限。

## 待确认

- 旧 USER.md 放不下时的处理。
- 觉醒引导里原来让 AI 当场写用户信息，去掉后是否改成让 AI 通过现有记忆更新写入，还是在觉醒引导里直接写进「用户」记忆。
