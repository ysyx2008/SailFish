# 企业微信技能 (WeCom Skill)

## 职责

提供企业微信云端资源的读写能力，作为 Agent 技能按需加载。

## 资源类型

| resource | 读 | 写 | 企微 API 端点前缀 |
|----------|---|---|------------------|
| calendar | 查询日历、列出日程、日程详情 | 创建/修改/删除日程 | `/oa/calendar/*`, `/oa/schedule/*` |
| approval | 查询审批模板、列出审批记录、审批详情 | 提交审批申请 | `/oa/gettemplate*`, `/oa/getapproval*`, `/oa/applyevent` |
| checkin  | 查询打卡记录 | — (只读) | `/checkin/getcheckindata` |
| contact  | 查询部门列表、成员详情、部门成员 | — (只读) | `/department/*`, `/user/*` |

## 工具

- `wecom_read` — 读取资源，参数 `resource` + 资源定位参数 + 筛选参数
- `wecom_write` — 写入资源，参数 `resource` + `action` + `data`

## 文件结构

| 文件 | 职责 |
|------|------|
| `types.ts` | `WeComResource`, `WeComReadArgs`, `WeComWriteArgs` 类型定义 |
| `session.ts` | access_token 管理、`apiPost`/`apiGet` 通用请求方法 |
| `tools.ts` | 工具定义（Function Calling schema） |
| `executor.ts` | 执行入口 `executeWeComTool` + 各资源 handler |
| `index.ts` | 技能注册 |

## 凭证

复用 IM 配置中的企业微信凭证（`imWeComCorpId` / `imWeComCorpSecret` / `imWeComAgentId`），无需额外配置。

## 依赖

- `config.service.ts` — 读取凭证
- `i18n.ts` — `wecom.*` 翻译 key
- `tools/misc.ts` — `wecom_` 前缀路由
- `skills/index.ts` — 技能注册入口

## 约束

- 所有 OA API 为 POST，通讯录 API 为 GET
- access_token 有效期 2 小时，`session.ts` 自动提前 5 分钟刷新
- 审批提交（`applyevent`）需要 `creator_userid`，Agent 应先通过通讯录查询
- 考勤查询必须指定 `userid`，企微 API 不支持无参查询
- 日程时间使用 Unix 秒级时间戳，executor 负责 ISO 8601 → Unix 转换
