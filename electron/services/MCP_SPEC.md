# MCP Service SPEC

> Last verified: 2026-09-18

## 职责

MCP（Model Context Protocol）客户端。连接外部 MCP 连接器，聚合其提供的工具、资源和提示词，供 Agent 发现和调用。

## 设计目标

1. **面向用户的名称**：界面和秘书对用户说话时用「MCP 连接器」，不用「MCP 服务器」——后者对普通用户不好理解。设置页、向导、状态提示、以及秘书回复里都用连接器。配置文件里的技术字段名保持兼容，不必跟着改。
2. **`whenToUse`**：给模型看的短触发说明，进入 L1 目录；**新保存 / 新启用**必须非空且经用户确认（可改后确认，不可跳过留空）；取消 = 配置失败。内容由短 AI 出草稿，用户确认后才落盘；禁止静默写入未确认文案。
3. **老配置**：缺 `whenToUse` 仍可连接、可 `skill load`；升级时联络 **one-shot** 通知「这块升级了，可让我补或自己去设置」；**无**专用 `migrations/mcp-*.json` marker；防刷屏靠「仅本启跨过 schema v10 时通知一次」，「通知过了」靠联络历史。**通知时机避开启动窗口期**：等窗口首次获得用户焦点后再发出（用户一直不聚焦则超时兜底发出）——应用刚启动就弹系统通知，在 Windows 上会把窗口焦点态打坏，表现为所有输入框点不出光标、只能重启。
4. **skill 化**：已连接 MCP 进入 `skill` 工具目录（id = `mcp:<serverId>`）；用 `skill load/unload` 整包加载/卸载工具 schema；**废弃 `mcp_load`**；有已连接 MCP 时 **始终** defer（取消「≤10 工具全量直灌」）。
5. **目录文案**：有 `whenToUse` 用它作主句；否则回退 name + 工具名清单（兼容旧数据）。
6. **写完就能用，不必重启**：秘书或用户新保存、新启用一个连接器后，软件立刻在后台连上。当前这次对话里就可以加载它的工具，不必重启旗鱼、也不必去设置页再点一次连接。加载某连接器时，若已配置且已启用但还没连上，先连再加载工具。连不上不撤销刚才的配置，把失败原因告诉秘书。关掉或删掉时断开。
7. **启用即连接，状态是健康不是开关**：用户只管理启用/禁用。打开启用后软件自己连，关掉就断开。界面不再把「连接」「断开」「全部连接」当作日常主操作。连接状态只在出问题时出现（原因 + 重试）；一切正常不必强调「已连接」。启动时仍会尝试连上已启用的连接器。**还没连上不算失败**：刚启动或刚启用、正在连接时，不要提示连接失败、不要给出重试；只有真正连过并且失败了，才显示原因和重试。**正在连接要说人话**：用「连接中」和进度说明，不要用灰点变绿点让人猜是没连上还是坏了；连上后显示可用工具数即可。
8. **网络不通要说人话**：连不上如果是断网、超时、解析不到地址这类网络问题，直接告诉用户网络不通、检查网络后可以重试，不要甩程序内部的报错原文。多个连接器因同一网络问题一起失败时，标题说网络不通并一次重试全部即可，不必在每一行再重复同一句话，好把连接器名字看清。
9. **日志里不留连接器的密钥**：有的连接器把密钥放在地址里（`?api_key=…`、路径里一段令牌、地址前面的账号口令）。连接时写进日志的只有协议、主机和端口，地址的其余部分一律不进日志；地址解析不了时也不把原文写进去。连接失败时底层报错如果把整条地址原样带出来，日志和界面上的错误提示里同样只留这三样。stdio 方式的启动参数同理（常见 `--api-key …`），日志只记个数、不记内容。不靠猜哪一段像密钥——猜不全，漏了就是泄露。日志靠连接器名字区分是哪一个。
10. **不做**：关键词搜索式 preload；把 MCP 身份硬合并进 Skill 注册表 / `load_user_skill`；未确认静默写 `whenToUse`；把「必须重启客户端」当成新连接器生效的条件；把连接当成用户日常要点的开关。

## 文件 / 规模

| 路径 | 说明 |
|------|------|
| `electron/services/mcp.service.ts` | 连接、聚合、schema 转换、server 解析、目录 |
| `electron/services/mcp-progressive-constants.ts` | `mcp:` skill id 前缀等常量 |
| `electron/services/agent/mcp-tool-session.ts` | Agent 侧已 load **server** 的 sticky 集合 |
| `electron/services/mcp-tool-display.ts` | UI 展示名解析 |
| `electron/services/mcp-when-to-use.ts` | whenToUse 短 AI 草稿 |
| `electron/services/agent/mcp-when-to-use-notice.ts` | 升级联络 one-shot 通知 |
| `packages/shared-types/src/mcp.ts` | `McpServerConfig`（含可选 `whenToUse`） |

## 行为契约：工具渐进式披露

### 为什么做

用户常驻多个大型 MCP 时，若每轮把全部 tool schema 塞进上下文：连着 ≠ 在用，低频重武器仍每轮收税；单条描述也可能极长。Skill 已是「目录 → load 整包」；MCP 与之对齐同一心智与同一入口。

### 方案：与 skill 共用 load + 始终按 server 整包

| 已连接 MCP | Agent 看到的 tools |
|------------|-------------------|
| **无** | 核心工具（无 MCP schema） |
| **有** | 核心工具 + `skill`（目录含 `mcp:<id>`）+ 本会话已 load 的 server 下全部 schema（sticky，追加末尾） |

要点：

1. **L1**：`skill` description + system prompt「可用的 MCP 连接器」；有 `whenToUse` 优先，否则 name + 工具名。
2. **L2**：`skill load mcp:<serverId>`（或显示名 / 裸 id，经 `resolveServerRef`）→ 整包 schema。
3. **Sticky 单位是 server**：直到 `resetSession` / `cleanup` / `skill unload`；不设「最多 N 家」逐出。
4. **未 load 却调 `mcp_*`**：自动整包 load，提示下一轮重试。
5. Prompt cache：核心前缀不变；已 load schema 只追加末尾。

### 可发现性

- 目录带 `whenToUse` 或工具名线索；system prompt Tier 2 注入「可用的 MCP 连接器」，指引用 `skill load mcp:…`。
- 核心规则「能力优先」：MCP 与 skill 并列，按对口度择优。
- `web_search` description 提醒先确认专用能力（静态，不随 defer 切换）。

### 与 Skill 的对照

| 层 | Skill | MCP |
|----|-------|-----|
| L1 | 技能 id + description | `mcp:<id>` + whenToUse（或缺省回退） |
| L2 | `skill load` → 工具 + 正文 | `skill load mcp:…` → 该 server 全部工具 schema |
| 执行 | 调技能工具 | 调 `mcp_*` |

## 公开 API（渐进相关）

| 方法 | 用途 |
|------|------|
| `shouldDeferTools()` | 有已连接 MCP → true |
| `getServerCatalogText()` | 目录（优先 whenToUse），defer 时注入 system prompt |
| `resolveServerRef(ref)` | id、`mcp:id` 或显示名 → server |
| `getToolDefinitionsByServerIds(ids)` | 整包 schema |
| `getToolDefinitions()` / `getToolDefinitionsByNames` | 全量 / 按名 |

### McpToolSession

| 方法 | 用途 |
|------|------|
| `loadServer(serverId)` | sticky 整包 |
| `unloadServer(serverId)` | 从 sticky 移除 |
| `isServerLoaded` / `getLoadedServerIds` | 查询 |
| `clear()` | resetSession / cleanup |

## 关键约束

- defer 时不得注入全量 schema——仅目录 + 已 load server 的工具
- 映射表须覆盖全部已连接工具（含未 load 的），保证 `parseToolCallName` / `callTool`
- 已 load 追加在核心工具之后，保护 prompt cache 前缀
- stdio 子进程须清理；工具名冲突靠 `mcp_{serverId}_` 前缀
- 新保存或新启用后立刻连接；加载时若已配置已启用但未连接，先连再加载工具；连接失败不回滚配置
- 界面以启用/禁用为开关；连接失败才展示原因和重试，不把连接/断开当作日常主操作；正在连接或尚未开始连接不算失败，用「连接中」说明，不用灰点暗示故障
- 网络不通、超时、解析不到地址时用普通人能看懂的原因，不展示程序内部报错；同一网络问题导致多个连接器失败时，标题说明原因并一次重试全部，不必逐行重复同一句话
