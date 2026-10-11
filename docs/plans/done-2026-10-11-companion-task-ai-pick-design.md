# 联络「从这里创建任务」：AI 挑选相关对话

状态：已完成（2026-10-11）

设计取舍见 `electron/services/conversation/SPEC.md`「由 AI 挑相关的对话」。本文只写怎么做。

## 改动面（同属「联络 → 任务」这一条链）

| 文件 | 改什么 |
|---|---|
| `electron/services/conversation/companion-seed.ts`（新） | `CompanionSeedPicker`：候选简述、挑选说明文本、解析回复序号 → step id 列表 |
| `electron/services/conversation/conversation.ts` | 抽出 `prepareCompanionChunks`；新增 `listCompanionPickCandidates`；`extractTaskFromRecords` 支持 `pickedTaskStepIds`（命中则用 `selectPickedTaskChunks`，否则仍走时间窗口）；`isProactiveChunk` 提为私有静态 |
| `electron/services/conversation/companion.ts` | `listPickCandidates(liveRecord, opts)`；`extractTaskWithLiveOverlay` 透传 `pickedTaskStepIds`；record 汇集抽成私有方法 |
| `electron/services/agent/agent.ts` | 新增 `askOnConversationPrefix(instruction)`：在 cache 前缀后追加一条 user，问一次取文字；与交接小结共用同一段「追加指令 → 请求 → 不给正文则禁工具重试」 |
| `electron/services/agent/index.ts` | `extractTaskFromCompanion` 编排：列候选 → 挑选（热前缀 / 简述独立请求）→ 抽取；失败回退时间窗口 |
| `electron/services/agent/i18n.ts` | 挑选说明提示词（中 / 英） |
| `src/components/AiPanel.vue` + `src/i18n/locales/*/ai.ts` | 联络里点击后显示进度提示（点在主动提醒 / 任务回执上不弹，因为不挑选），结束后收起 |

## 关键做法

- 候选 = 抽取时本来就拿得到的各段用户对话（终点之前），上限 60 段；序号从 1 起按时间排，终点那段序号最大。
- 挑选结果用「用户话那一步的 id」传递，不用下标；挑选等待期间联络若有新消息，抽取重新汇集记录后仍能对上。
- 回复只接受数字与分隔符；解析不出任何有效序号 → 回退时间窗口。
- 热路径：联络 Agent 有 cache 前缀 → `前缀 + 挑选说明`，带 tools（schema 属前缀）；冷路径：无前缀 → 只发挑选说明（简述自带上下文）。
- 点在主动提醒、或候选只有终点一段 → 不发挑选。
- 挑选请求不限输出额度：带思考的模型会先想再答，限 4000 时端到端实测只想不答（`finish=length`、内容为空）。

## 端到端结论（真模型、真联络对话，2026-10-11）

- 热路径（接联络眼前前缀）：缓存命中约 99%，等 1.3～1.8 秒，5 次全部挑对（相关的两段 + 终点，无关的天气、午饭没带）。
- 冷路径（只发简述）：约 3 秒，3 次全部挑对；偶发带思考的模型会想十几秒。
- 提示词两处吃过亏：示例里写「例如 2,5,终点号」会被模型当成模板（终点是 5 时变成 2,5,5，模型只回 5）→ 去掉示例；没说明「新任务是全新对话、没带进去的它不知道」时模型把终点当成自足的 → 补上这条事实并中性说明漏选 / 多选各自的后果。

## 任务拆解

- [x] 1. `CompanionSeedPicker` + 单测（序号解析、非法回复、终点必带）
- [x] 2. `Conversation` 按 step id 挑选抽取 + 单测（整段带、前置提醒、终点之后不带、回退）
- [x] 3. `Companion` / `Agent.askOnConversationPrefix` / `AgentService` 编排 + 测试（挑选成功、失败回退、冷热路径）
- [x] 4. 界面进度提示 + i18n
- [x] 5. 回归 `test-cli.sh --no-ai`、审查、想法本
