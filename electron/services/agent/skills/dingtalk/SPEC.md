# 钉钉技能 (DingTalk Skill)

## 职责

提供钉钉云端资源的读写能力，作为 Agent 技能按需加载。

## 资源类型

| resource   | 读 | 写 | API 类型 | 端点前缀 |
|------------|---|---|---------|---------|
| calendar   | 列出日历、日程列表、日程详情 | 创建/修改/删除日程 | 新 API v1.0 | `/v1.0/calendar/users/{unionId}/...` |
| todo       | 列出待办、待办详情 | 创建/更新/删除待办 | 新 API v1.0 | `/v1.0/todo/users/{unionId}/...` |
| attendance | 查询打卡记录 | — (只读) | 旧 API | `/attendance/list` |
| contact    | 查询部门列表、成员详情、部门成员 | — (只读) | 旧 API | `/topapi/v2/department/*`, `/topapi/v2/user/*` |
| approval   | 查询审批实例列表、实例详情 | 发起审批申请 | 旧 API | `/topapi/processinstance/*` |

## 工具

- `dingtalk_read` — 读取资源，参数 `resource` + 资源定位参数 + 筛选参数
- `dingtalk_write` — 写入资源，参数 `resource` + `action` + `data`

## 文件结构

| 文件 | 职责 |
|------|------|
| `types.ts` | `DingTalkResource`, `DingTalkReadArgs`, `DingTalkWriteArgs` 类型定义 |
| `session.ts` | access_token 管理、`oapi`（旧API）/ `api`（新API）通用请求方法 |
| `tools.ts` | 工具定义（Function Calling schema） |
| `executor.ts` | 执行入口 `executeDingTalkTool` + 各资源 handler |
| `index.ts` | 技能注册 |

## 凭证

复用 IM 配置中的钉钉凭证（`imDingTalkClientId` / `imDingTalkClientSecret`），无需额外配置。

## 依赖

- `config.service.ts` — 读取凭证
- `i18n.ts` — `dingtalk.*` 翻译 key
- `tools/misc.ts` — `dingtalk_` 前缀路由
- `skills/index.ts` — 技能注册入口

## 约束

- 钉钉有新旧两套 API：旧 API token 在 query string，新 API token 在 header
- access_token 有效期 2 小时，`session.ts` 自动提前 5 分钟刷新
- 日历和待办操作需要用户的 `union_id`，Agent 应先通过通讯录查询获取
- 考勤查询必须指定 `userid`，不支持无参查询
- 审批实例列表需要 `process_code`（审批模板编码）
- 日程时间使用 ISO 8601 格式，待办截止时间使用毫秒级时间戳
