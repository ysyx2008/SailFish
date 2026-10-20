# 联网搜索接入 DeepSeek · 方案

状态：**已完成**（2026-10-20 落盘，同日做完；等用户验收）

设计目标已写进：`electron/services/web-search/SPEC.md` 设计目标第二段；配置技能的行为承诺同步在 `electron/services/agent/skills/config/SPEC.md`。

## 要解决的事

DeepSeek 在 2026-10-17 开放了独立的 Search / Fetch 接口。用户的理由是价格：搜索按成功次数收费，比博查便宜得多。这次只接 Search；Fetch 对应「读网页」，另一个模块，不混进来。

## 接口事实（来自官方文档）

- `POST https://api.deepseek.com/v1/tools/search`，`Authorization: Bearer <与对话相同的密钥>`。
- 请求：`query`（1~128 个 Unicode 字符）、`count`（1~50，默认 10）、`need_content`（默认 false）、`ori_question`、`localization`。
- 响应：`results[]`，每项有 `title / url / snippet（100~200 字，面向界面）/ summary（600~800 字，面向模型）/ content / site_name / date / authority / rerank_score`。没有结果时是空数组。
- 错误是 OpenAI 兼容格式 `{ error: { message } }`；402 余额不足，429 限流，5xx 与 408 可重试。
- 计费：成功且非空的请求才收费；失败、空结果、超时不收。QPS 100。

## 已定的取舍

- 只有一档，不设 `extraFields`，设置页和配置技能都不出现档位。
- `need_content` 恒为 false。`WebSearchResult.content` 会进 `AgentStepRecord` 持久化，整页正文会让历史体积上涨；需要全文时 AI 走 `web_fetch`。
- `snippet` 取 `summary`，没有时退回接口的 `snippet`。界面只显示标题和域名，摘要只给模型读，所以取给模型的那一段。
- 搜索词按 Unicode 码点截到 128 再搜（与智谱一致），记一条 warn。
- 超时 30 秒；调用方传了 `signal` 时与超时合并（`AbortSignal.any`），不像旧 provider 那样传了 signal 就丢掉超时。
- 密钥与对话模型同一把：`WEB_SEARCH_MODEL_HOSTS` 加 `deepseek: ['api.deepseek.com']`，复用已有的 `webSearchKeyFromModelProfiles`，不新建第二套。
- 默认服务商仍是博查，不改。
- 不带发布时间 / 权威度 / 排序分：要带需改 `WebSearchResult` 通用格式，所有 provider 受影响，另议。
- 不传 `ori_question`：`WebSearchOptions` 里没有「用户原话」，要传需改 `web_search` 工具与选项类型，另议。

## 改动

| 任务 | 文件 | 验收 |
|---|---|---|
| 新 provider | `electron/services/web-search/providers/deepseek.ts` | 单测 + 真实请求 |
| 注册 | `electron/services/web-search/index.ts` | `initWebSearch` 后 `getProvider('deepseek')` 存在 |
| 类型与元数据 | `packages/shared-types/src/web-search.ts`（`WebSearchProviderId`、`WEB_SEARCH_PROVIDERS`、`WEB_SEARCH_MODEL_HOSTS`） | `model-key.test.ts` |
| 设置页 | `src/components/Settings/VoiceSettings.vue`（获取密钥链接）、两份 `settings.ts`（`useModelKey.deepseek`、`providers.deepseek`） | vue-tsc + 目视 |
| 配置技能 | `electron/services/agent/skills/config/tools.ts`（服务商枚举与说明）、`SPEC.md` | `web-search-settings.test.ts` |
| 测试 | `web-search/__tests__/deepseek.test.ts`、`model-key.test.ts`、`web-search-settings.test.ts` | vitest |

## 验证

- vitest：web-search 与 config 技能相关 8 个文件通过。
- `tsc`（electron）、`vue-tsc`、eslint 通过。
- 真实端到端（临时数据目录，只从桌面借用模型配置里的密钥，不写桌面数据）：`websearch:test` 在搜索里没单独填密钥时用模型密钥搜通，返回 3 条带长摘要的结果；错误密钥时日志和报错都带 DeepSeek 原话（401）；214 字搜索词被截到 128 字后照样返回结果。
- `bash electron/cli/test-cli.sh --no-ai` 回归。
