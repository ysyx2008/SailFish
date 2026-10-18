# 回执那一轮的话，回到用户上一次说话的那条线（方案）

状态：已放弃（2026-10-18 讨论后改走「联络派完任务后，这一轮等着任务回来」，见 `done-2026-10-18-companion-holds-for-tasks-design.md`；本文未编码，保留供回看）

放弃原因：本文是给「联络那一轮已经收工」这个前提打补丁，要新写按渠道指定发送；而「最近联系过的渠道」不等于用户现在在哪。改成让那一轮挂着等任务回来后，渠道由那一轮自己决定，不需要这一套。

## 起因

联络派的任务做完，回执交给联络。联络闲着时另起一轮处理，这一轮整轮收成一行「处理了任务回执」，用户只看得到联络用 `talk_to_user` 发的话。真实记录（2026-10-18 22:43 / 22:44）里，联络两次收到回执，两次都把结果写成了完整回复（`final_result`），没调 `talk_to_user`——推理里写的是「用户就在对话现场，直接回复」。话被折叠，用户看着像任务卡住了。

## 为什么不是别的做法

- 把最终回复无条件走 `talk_to_user` 那条投递管道：IM 那条路发给「最近联系过的渠道」（30 天内有效），不看用户现在人在哪；联络这一轮写的任何话都会发出去，没法静默。已否决。
- 只在界面上把最终回复展开：不在联络页没有提醒，微信等渠道收不到。已否决。
- 只改提示词：上两次已验证模型不照做。已否决。

## 做法

「上一次在哪条线上聊」不用新造：Agent 每次开跑都记下这一轮的上下文，里面有 `remoteChannel`（桌面为空，IM 为平台名）；回执那一轮沿用它。

1. **收尾发话**（`agent.ts` 的 `finalizeRun`）：这一轮是回执轮（`internalNotice && noticeKind === 'task_receipt'`）、没被停、有正文、本轮 `run.steps` 里还没有 `proactive_notice`（即没调过 `talk_to_user`）→ 在 `final_result` 之前补一条 `proactive_notice` 步骤（界面照现有「对用户说的话」画，折叠逻辑不用改），并调用调用方给的 `reply(text, channel)`。`agent.ts` 只认步骤类型和回调，不出现工具名（过 `oop-boundary.test.ts`）。
2. **回调接线**（`index.ts` 的 `deliverCompanionReceipt`）：`deliverTaskReceipt` 的 opts 加可选 `reply`；这里给出的实现调 `deliverProactiveMessage`，`fromCompanion: true`，IM 只送 `channel` 对应的平台，桌面线（`channel` 为空）不走 IM。
3. **投递管道加「IM 送哪里」**（`proactive-deliver.ts`）：新增选项，默认保持「最近联系人」，已有调用方行为不变；可选「不走 IM」「只走某平台」。系统通知（窗口不在前台）沿用现有逻辑。
4. **IM 服务能指定平台**（`im.service.ts` 的 `sendNotification`）：新增可选 `platform`，只在该平台的有效联系人里找，找不到就失败，不退到别的平台。
5. **回执文案**（`agent/i18n.ts`，zh / en 各一条 `taskmgr.receipt.footer`，**需用户审核**）。

界面（`process-fold.ts` / `useAgentMode.ts`）不改：回执轮里 `proactive_notice` 本来就露在折叠行外面。

## 回执文案（待审）

现在：

> 这一轮用户看不到；要告诉用户的话用 talk_to_user。用户的答复用 manage_tasks confirm 或 instruct 转给那场。

改成：

> 这一轮你最后写下的正文，会送到用户上一次跟你说话的地方（桌面对话，或他当时用的聊天渠道）；不写正文就不会发。过程里写的话不发。这一轮里已经用 talk_to_user 说过的，正文不再重复发。要换个渠道找用户，用 talk_to_user。用户的答复用 manage_tasks confirm 或 instruct 转给那场。

英文同义。

## 会受影响 / 要注意

- 模型收尾爱说一句话：回执轮里写下的「收到，无需处理」之类也会发给用户。靠文案说明后果，先观察，不加规则。
- 重启后联络第一次收到回执时，没有「上一次的线」，按桌面处理。
- 微信那一路偶发失败（会话失效等）：只记日志，桌面对话里仍看得到。
- 回执送进联络正在回复的那一轮（用户开口的那一轮）时不走这条：那一轮本来就是用户看着的。
- CLI 无窗口：IM 之外没有别的渠道，行为与现在一致（最终正文仍在步骤里）。

## 涉及文件

| 文件 | 内容 |
|---|---|
| `electron/services/agent/agent.ts` | `deliverTaskReceipt` opts 加 `reply`；`finalizeRun` 回执轮收尾发话 |
| `electron/services/agent/index.ts` | `deliverCompanionReceipt` 提供 `reply` |
| `electron/services/agent/proactive-deliver.ts` | 新增 IM 送哪里的选项 |
| `electron/services/im/im.service.ts` | `sendNotification` 加 `platform` |
| `electron/services/agent/i18n.ts` | 回执尾巴文案（zh / en） |
| `electron/services/agent/__tests__/agent.test.ts` 等 | 见任务拆解 |

## 任务拆解

1. [ ] IM 能指定平台：`sendNotification({ platform })`；投递管道加选项。验收：单测——只送指定平台、找不到不退别家、默认行为不变（原有 `talk-to-user.test.ts` 不改仍绿）。
2. [ ] 回执轮收尾发话：`finalizeRun` + `reply`。验收：`agent.test.ts` 新增——有正文发一次并补 `proactive_notice`；已有 `proactive_notice` 不重复；无正文不发；被停不发；失败不发；用户开口的那一轮不发。
3. [ ] 接线 + 渠道取值：`deliverCompanionReceipt`。验收：桌面线不走 IM；IM 线只送该平台；渠道用已有 `IMPlatform` / `RemoteChannel`，不另起平行词汇。
4. [ ] 回执文案（经用户审核后落）。验收：用户确认文案；`oop-boundary.test.ts` 绿。
5. [ ] 回归 + 端到端：`bash electron/cli/test-cli.sh --no-ai`；用 `sailfish companion` 真起一遍「派任务 → 回执 → 联络收尾」，看最终是否多出一条对用户说的话、日志有无对不上的警告；桌面真机再看折叠行外是否露出。
6. [ ] 代码审查（claude-review）；`project-architecture.mdc` 里「由联络决定是否经 `talk_to_user` 告诉用户」一句同步；`docs/ideas.md` 对一遍；本文改 `done-` 前缀并改成「已完成」。
