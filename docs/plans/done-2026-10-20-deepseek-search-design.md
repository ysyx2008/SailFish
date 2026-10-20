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

## 验收反馈：沿用模型密钥时密钥框不能空着（2026-10-20，追加）

用户验收时指出：模型里有密钥、搜索这边的框却空着，下面只写一句「已用模型密钥」，分不清到底有没有；并要求加显示/隐藏按钮，和模型设置页一样。智谱、Kimi 走的是同一个框，一并生效。

- 框本身仍是空的，沿用的那一把通过占位文字显示（默认 `sk-` + 圆点 + 末四位，字色与已填内容一致，不像空着）。不把模型密钥写进框里：写进去就成了搜索自己的密钥，模型那边换了密钥搜索不会跟着换；而且清空时会立刻被回填，没法重新输入。
- 右侧眼睛按钮，样式和说明文字与模型设置页一致（复用 `aiSettings.showApiKey / hideApiKey`）。点开时沿用的那一把显示全文；切换服务商时自动收回。
- 遮盖规则是个小的纯函数：16 位以下一个字都不露，其余只露开头 3 位、末尾 4 位。
- 没有抽成两页共用的组件：模型设置页不在这次范围内，两处各自写了同样几行样式。以后要收拢再单独做。

## 改动

| 任务 | 文件 | 验收 |
|---|---|---|
| 新 provider | `electron/services/web-search/providers/deepseek.ts` | 单测 + 真实请求 |
| 注册 | `electron/services/web-search/index.ts` | `initWebSearch` 后 `getProvider('deepseek')` 存在 |
| 类型与元数据 | `packages/shared-types/src/web-search.ts`（`WebSearchProviderId`、`WEB_SEARCH_PROVIDERS`、`WEB_SEARCH_MODEL_HOSTS`） | `model-key.test.ts` |
| 设置页 | `src/components/Settings/VoiceSettings.vue`（获取密钥链接、沿用时显示密钥、显示/隐藏按钮）、两份 `settings.ts`（`useModelKey.deepseek`、`providers.deepseek`）、`src/utils/mask-secret.ts` | vue-tsc + 真实窗口 |
| 配置技能 | `electron/services/agent/skills/config/tools.ts`（服务商枚举与说明）、`SPEC.md` | `web-search-settings.test.ts` |
| 测试 | `web-search/__tests__/deepseek.test.ts`、`model-key.test.ts`、`web-search-settings.test.ts` | vitest |

## 验证

- vitest 全量：344 个文件、4742 条通过。新增 `deepseek.test.ts`，并补了密钥沿用、配置技能、文案键三处用例；`src/i18n/web-search-copy.test.ts` 保证每个搜索服务商在中英文里都有说明（故意删一条英文提示时会报）。
- `tsc`（electron）、`vue-tsc`、eslint 通过。
- 真实端到端（临时数据目录，只从桌面借用模型配置里的密钥，不写桌面数据）：`websearch:test` 在搜索里没单独填密钥时用模型密钥搜通，返回 3 条带长摘要的结果；错误密钥时报错带 DeepSeek 原话（401）；214 字搜索词被截到 128 字后照样返回结果。
- 真实窗口（`launchApp` 静默起，预置一份 DeepSeek 模型）：设置 →「语音与搜索」里选 DeepSeek，有说明、「获取密钥」、没有档位项；模型里有 DeepSeek 密钥时框里显示 `sk-••••••••cdef` 并出现「已用模型设置里的 DeepSeek 密钥」提示，点眼睛显示全文、再点收回；另填一把后提示消失、框里是自己填的内容；清空后回到沿用；显示状态下切换服务商会自动收回；模型里没有密钥时框里是 `API Key`、没有提示。
- `bash electron/cli/test-cli.sh --no-ai` 回归：104 项，101 通过、0 失败、3 项因 `--no-ai` 跳过。
- 代码审查（Claude CLI）：提了两点。接口 200 但结构不对会被当成「没搜到」——已改成明确报错并补测试；README 里的服务商列表没带上 DeepSeek——对外文案，未动，留给用户定。
