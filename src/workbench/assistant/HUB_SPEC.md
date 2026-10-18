# 助手 Hub 交互模型 SPEC

> Last verified: 2026-08-18  
> 涵盖范围：`App.vue` / `TabBar.vue` / `RecentConversationsPanel.vue` / `terminal.ts` 中与助手 Hub 相关的所有交互规则。

---

## 一、设计目标

将过去"每个本地助手对话独占一个独立 Tab"的模型，改为**单一助手工作台（Hub）+ 最近对话侧栏**，使：
- 任意数量的本地助手对话共用一个工作台区域，通过侧栏切换
- 终端 Tab（local/ssh）保持独立全屏，不受影响
- 会话不再能"提升"为独立 Tab（2026-08-15 取消，见第七节）
- 外部渠道（IM/Watch 通知）统一汇集到**联络常驻 Tab**（`__companion__`）
- **新对话进侧栏**：用户发出第一条消息后，这条对话立刻出现在最近对话侧栏，并且已经写入历史；不必等第一次任务跑完。只点了「新对话」、还没说话，不进侧栏。任务进行中持续记下进度，崩溃后能从已写下的部分恢复。

---

## 一·A. 侧栏三地方（2026-08-14 更新）

> 产品级定位见 `.cursor/rules/project-architecture.mdc`「任务 / 联络 / 关切 / 唤醒」。壳层取舍见 `src/APP_SPEC.md` 设计目标。

固定入口在左侧，不再钉在顶栏。联络和终端点了是回这个地方；「新对话」点了就是开一个新的。

| 入口 | 行为 |
|---|---|
| **新对话** | 回到任务区，**保留**此前正在看的助手会话；没有则欢迎页。最近对话列表就是它的「多个」。 |
| **联络** | 打开那条常驻联络线；IM / 关切找人的消息都进这里。不清除任务区里正在看的会话。 |
| **终端** | 回到上次那个本机或远程工作台；一个都没有才进空页（打开本机 + 最近连接）。页内 tab 只挂本机和远程。 |
| **待办** | 在秘书菜单里。打开待办面，不清除任务区会话；切回新对话可恢复。 |

快捷键的跳转保持现状：新建助手仍打开那个对话，新建本机终端仍打开那个工作台，关掉后的去向也不另发明一套。

`displayedTabs` 同时排除：
1. 未提升的本地助手（`!tab.isRemote && !tab.isPromoted`）
2. `__companion__` tab（单独固定渲染）

`ensureCompanionTab()` 在 `initializeApp()` 最早调用，保证 `__companion__` tab 在整个 session 生命周期内始终存在。`closeTab` 对 `__companion__` 进行保护，永远返回 false。

**渲染与历史恢复**：联络 tab 走专属的 `CompanionWorkbench → AiPanel`（`kind='companion'`，与 assistant 平级；**只含聊天，无产出物面板/历史侧栏**，契约见 `workbench/companion/SPEC.md`），样式与普通助手一致且可从桌面直接续聊。IM/Gateway/桌面/Watch `talk_to_user` 的步骤都以 `agentId = __companion__` 通过标准 `agent:step` 流入同一会话。重启后联络 tab 挂载时恢复合并时间线（最近大约十段真对话，主动提醒不占名额；已灌进的现场提醒接到后面、不重复）。已经恢复过或正在跑任务则不动。合并逻辑真相源在后端联络关系线，前端不再自拼。后端会话连续性由持久命名 Agent 自身的 `restoreFromHistory`/`restoreRecentTaskMemory` 负责。<br/>**已知局限**：仅能恢复带 `agentKey` 的记录（2026-06-21 引入字段之后产生的）；更早的联络对话与普通助手任务在历史里无字段可区分，无法回填，不出现在联络 tab。

---

## 二、Tab 分类规则（⚠️ 新增功能必读）

所有 `TerminalTab` 按以下规则分为三类：

### A. TabBar 可见 Tab（`displayedTabs`）

出现在顶部 Tab 栏（滚动区），全屏独占主区：

| 类型 | 条件 |
|---|---|
| 终端 Tab | `tab.type === 'local'` 或 `'ssh'` |
| 已提升助手 | `tab.type === 'assistant' && tab.isPromoted === true && !tab.isRemote` |
| 远程助手（非联络） | `tab.type === 'assistant' && tab.isRemote === true && tab.agentId !== '__companion__'` |

### B. 联络常驻 Tab（固定在 TabBar，不进入滚动区）

```
tab.agentId === '__companion__'
```

由 `COMPANION_TAB_AGENT_ID` 常量标识，在 TabBar 中单独渲染于 `tab-pinned`，不可拖拽、不可关闭。

### C. Hub 会话（不在 TabBar）

不在 Tab 栏，由侧栏管理：

| 条件 |
|---|
| `tab.type === 'assistant' && !tab.isRemote && !tab.isPromoted` |

**判断公式（TabBar 过滤逻辑）**：
```
isDisplayed = !(tab.type === 'assistant' && !tab.isRemote && !tab.isPromoted)
              && tab.agentId !== '__companion__'
```

---

## 三、视图状态机

前端主区的显示状态由两个 Store 字段决定：

```
terminalStore.activeTabId          // TabBar 可见 tab 的 id（空字符串 = 无）
terminalStore.hubFocusedAssistantTabId  // Hub 当前聚焦会话的 tab id（空字符串 = 无）
```

### 状态优先级（从高到低）

```
1. 覆盖层（觉醒/设置/智能巡检）— 叠加在所有状态上，优先关闭
2. activeTabId 非空 → 全屏展示该 Tab（终端/提升助手/远程助手），侧栏隐藏
3. activeTabId 为空 && hubFocusedAssistantTabId 非空 → Hub 焦点模式（欢迎页 + 助手对话叠加），侧栏可见
4. activeTabId 为空 && hubFocusedAssistantTabId 为空 → 欢迎页，侧栏可见
```

### 关键 computed（`App.vue`）

```ts
// 主区当前渲染的 tab（activeTab 优先，否则是 Hub 焦点会话）
activeSurfaceTabId = activeTabId || hubFocusedTab?.id || ''

// 欢迎页：没有任何 surface tab 时显示
showWelcomePage = !showSmartPatrol && !activeSurfaceTabId

// 侧栏：activeTabId 为空时常驻（Hub 视图始终可见）
showRecallSidebar = !activeTabId && !showSmartPatrol && !isSteamBuild
```

---

## 四、侧栏（RecentConversationsPanel）规则

### 可见性

`showRecallSidebar = !activeTabId`（有 TabBar 可见 Tab 时隐藏，Hub 视图时常驻）

### 列表数据来源

两路合并，自动去重：

| 来源 | 说明 |
|---|---|
| `liveSessionSummaries`（computed from `terminalStore.tabs`） | 已启动但尚未落盘的进行中会话，显示在列表最前面；对话完成后由 summaries 接管，无重复 |
| `summaries`（后端 `history.listAgentSummaries`） | 已完成对话；`agent.onComplete` / `agent.onError` 时静默刷新 |

**实时会话条件**（出现在 liveSessionSummaries）：
```
tab.type === 'assistant' && !tab.isRemote && 
tab.agentState.userTask 非空 && 
tab.agentState.sessionId 非空 && 
sessionId 不在 summaryById 中（未落盘）
```

### 活跃高亮规则

**地方和条目要用两种语汇。** 侧栏上半是三个固定入口（回答「你在哪个地方」），下半是最近对话（回答「眼前是哪条对话」）。人在终端里看着某条终端会话时，两句话同时成立、两处就会同时亮——若都画成整块选中，看着像两个互斥的选中项在打架。所以地方用面（整块背景），当前这条对话用线（左侧一条细竖条加文字加深），不铺大面积背景。

| 状态 | 高亮方式 |
|---|---|
| Hub 焦点会话（当前可见）| 左侧竖条 + 文字加深 |
| 当前激活的终端 Tab 里的会话 | 左侧竖条 + 文字加深 |
| 已提升为独立 Tab | 显示「独立 tab」图标 |
| 后台运行中（用户看不见）| 显示运行中动画图标 |
| 后台需要确认（用户看不见）| 显示 attention 图标 |

**规则：当前用户正在看的会话（Hub 焦点 / 已提升活跃 tab）不显示运行中/attention 图标**，因为用户已经看到了。

**「正在看」以人眼前是什么为准，不以焦点还记着谁为准。** 离开任务区去了联络、待办、终端——包括一个终端也没开时停在的那张空终端页——记着的 Hub 焦点都不再算数：那条会话已经不在眼前，行不该继续亮着，运行中 / 待确认的图标也该照常提醒。

### 形态标识

终端会话与助手会话混在同一条列表里，必须一眼能分辨哪条来自终端：终端会话带图标，本机与远程共用同一个——认出「这条来自终端」就够了，是哪台机器不值得再占一种图形。主机名有用但太长，不占行宽，只在悬停时给出。

**行首图标的说明要「放上去就有」**（2026-10-18）。图标只有十来个像素，靠浏览器自带的提示要瞄准、再停将近一秒才出现，用户多半以为没有说明。所以图标上的说明鼠标一放上去马上弹出，不等；图标可悬停的范围比图形本身大一圈，不必瞄准那几个像素。终端图标与联络图标同一种做法。

**悬停提示不放会话正文**。终端会话的开头常常是整段粘贴进来的终端输出，鼠标一停就糊住半个窗口。终端会话悬停只给主机（行里看不到它），其余会话只把被行宽截掉的标题补全。

**只在记录能自证形态时才标**。一条会话说自己来自终端，就得给得出它当初绑的那个终端；给不出的一律不标。这是因为早期助手会话曾被误存成本地终端，那批历史数据不做改写——宁可不标，也不标错。

### 出身标识（2026-10-18）

联络派出去的任务，在列表里和用户自己开的长得一模一样。用户点开一条自己没开过头的对话会莫名其妙，也不知道它为什么没来问自己确认（联络派的任务默认由评审员代为把关，用户声明全自动才不再确认）。所以联络派的任务也带一个标志，和终端标志同一个位置、同一种做法：图标压低对比度、悬停才给说明，认出「这条是联络派的」就够了。图形用「纸飞机」，取「派出去」的意思：一开始用的是联络入口自己那个两个气泡的图标，放在行里像一条普通聊天，看不出是被派出来的，用户反馈不直观，所以换掉；联络入口自己的图标不变。

- **只回答「当初是谁建的」，不回答「最近谁说过话」**。建的时候定下、不再变：用户自己开的任务，联络事后再交代一句，不加标志；联络派的任务，用户接着聊，标志还在。
- **重启、从历史里重开都还在**。出身记在任务自己身上，不靠当时界面是否开着。
- **只对记下了出身的任务标**。这个功能之前联络派的任务当时没记，不补标、不去猜——宁可不标，也不标错，与形态标识同一条取舍。
- **和终端标志是两件事**：终端标志说它在哪台机器上跑，联络标志说它是谁派的。联络现在只能建无终端的任务，两个标志不会同时出现，不为将来预留排版。
- 行本身的悬停提示与其他助手会话一样，只把被行宽截掉的标题补全，不放会话正文。图标自己的说明是「联络派出的任务」，说明只出现在图标旁边。
- **标志只是辅助，更醒目的说明在对话顶上**（2026-10-18）：用户反馈光靠一个小图标，仍然很难猜到这是联络派出的任务。所以点开这场对话时，顶部居中另有一行字写明，见对话窗口规则。

### 点击行为

助手会话开了真终端仍是助手 Hub 会话，不进顶栏终端页、不改形态。点开一条会话必须落回它原本的形态：

会话的形态（本机 / 远程 / 助手）不可变，点开一条会话必须落回它原本的形态：

| 这条会话 | 点开后 |
|---|---|
| 助手会话 | 回到 Hub 主区，侧栏保留 |
| 终端会话，原终端还开着 | 切回那个终端，并展开 AI 侧栏——对话在那儿，面板收着等于没跳过去 |
| 终端会话，原终端已关闭 | 在助手区回看（见下方取舍） |
| 已提升独立 Tab / 远程助手 | 直接激活对应 Tab |

认回原终端不能只靠会话编号：终端的会话状态被清掉后编号就对不上了，此时仍要能凭这条记录记着的来源认回那个终端。侧栏的行高亮也按同一套认定，否则切过去了行还是灰的。

**已关闭终端会话的取舍**：维持现状，在助手区回看。同形态重建也回不到当时那台主机和那个目录，假装续上反而让 AI 按早已不存在的现场往下说。

**空闲预热只针对助手会话**。给终端会话预建助手 Tab 会反过来劫持点击——本该切回终端的，落进了预热出来的助手会话里。

**一条会话同一时刻只归属一个地方**。在助手区回看过的会话，之后被某个终端接着往下聊（原终端关了、换一个继续，会话不分叉），此时先前那份回看副本必须让位——否则同一条会话被两处记着，侧栏点击就可能落到那份不干活的副本上：终端那边在跑、甚至在等你确认，你却被送进一个静止的页面。让位的做法是把回看副本收走（它本就是只读缓存，随时能再打开）；正在跑或正等确认的一方永远不被收，真出现两处都在跑，宁可留着让问题暴露。

### 另开一聊（Fork）

`forkToAssistantTab` 创建的新会话**继承源会话的呈现形态**：

| 源会话 | 新分支 |
|---|---|
| Hub 侧栏会话 | `focusHubConversation`：留在 Hub，侧栏保留 |
| 终端 Tab 内 AI 面板 | 默认走 Hub（`focusHubConversation`） |

**禁止**对 Hub 会话 fork 后直接 `activeTabId = newTabId`——会导致侧栏隐藏且 Tab 栏也不显示该会话（悬空面板）。

侧栏即时可见：`restoreAgentHistory` 必须写入 `agentState.userTask`（`liveSessionSummaries` 依赖此字段；fork 落盘前靠实时列表展示，落盘后由 `summaries` 接管）。

**会话标题稳定**：`agentState.userTask` = 首条 user_task（与 HistoryService `record.userTask` 一致）。`clearAgentState(preserveSession)` 与 `setAgentRunning` 均不得覆盖已有标题，避免侧栏在运行中显示当前输入、完成后又跳回。

### 搜索与分组

- 搜索匹配：`userTask` + 用户自定义标题（`configStore.getConversationDisplayTitle`），不区分大小写
- 分组：按对话结束时间（`timestamp + duration`）倒序，按日期段分为"今天 / 昨天 / 具体日期"组
- 实时会话（liveSessionSummaries）始终排在所有历史条目前面，不受日期分组约束
- 置顶（pinned）会话单独提前展示，不进入日期分组

### 删除行为

| 场景 | 处理方式 |
|---|---|
| 已提升为独立 Tab | 阻止删除，提示用户先关闭 Tab |
| 实时会话（liveSession，尚未落盘）| 确认后只关闭 Tab（`closeTab`），不调 `history.deleteAgentRecord` |
| 已完成历史记录 | 确认后调 `history.deleteAgentRecord` + 清理 Hub 焦点 Tab（若存在）|

### 右键菜单

| 操作 | 行为 |
|---|---|
| 重命名 | 写入 `configStore` 自定义标题（以 summary.id 为 key） |
| 置顶 / 取消置顶 | `configStore.togglePinConversation` |
| 删除 | 见删除行为表格 |

---

## 五、新对话流程

```
欢迎页 Composer 提交 / TabBar「+」按钮
  └→ goToHome()（清空 activeTabId + hubFocusedAssistantTabId）
      欢迎页出现，输入框自动聚焦

用户在 Composer 输入内容并提交
  └→ createAssistantTab({ activate: false })  // 不激活，不进 TabBar
      focusHubConversation(newTabId)           // Hub 焦点，侧栏保留
      第一条消息发出后立刻写入历史并出现在侧栏（不必等第一次任务跑完）
      Agent run 发起，AiPanel 展示进行中状态
```

---

## 六、后台任务（Watch / Gateway）规则

**规则：后台任务不得自动切换用户视图。**

Watch 触发、Gateway 远程任务、IM 消息等触发的助手任务：
- 静默注入步骤到对应助手 tab（`addAgentStep` 但不激活）
- 不调用 `setActiveTab` / `focusHubConversation`
- 任务完成后通过 Toast 通知引导用户主动查看
- 侧栏 attention 图标（用户不在看该会话时）引导导航

违反此规则的改动会打断用户当前工作，严禁。

---

## 七、会话提升（已取消）

**对话不再能被「提升」成独立 Tab。** 壳层重排后顶栏 Tab 条已撤走，终端页那条只认本机 / SSH，提升出来的会话没有任何标签能承载它——用户既切不走也找不回，只剩一个凭空出现的全屏页面。

因此侧栏右键的「在新标签页中打开」、拖对话到 Tab 条 / 欢迎页这几个入口一并取消。对话的「多个」由最近对话列表表达，这已经够用。

新会话一律进 Hub 焦点流，在最近对话列表里有位置、能切换、能退回。

---

## 八、资源管理

### LRU 会话池

- **上限**：`HUB_SESSION_LIMIT = 5`（Hub 内非提升助手 tab）
- **触发**：`focusHubConversation` 时自动淘汰
- **豁免**：正在运行（`isRunning`）/ 待确认（`pendingConfirm`）/ 已提升（`isPromoted`）
- **淘汰策略**：按 `lastFocusedAt` 升序，最久未聚焦 & 空闲优先

### 并发软上限

- **上限**：`MAX_CONCURRENT_AGENTS = 8`
- **性质**：软限制（警告，不阻止手动操作），主要防 Watch/IM 批量涌入
- **`isAtConcurrencyLimit` computed**：超出时可用于提示 UI

---

## 九、退出确认计数

退出时弹框中"有意义的开放 tab"计数规则：

```
有意义 = t.type !== 'assistant'          // 终端 tab
        || t.isRemote                    // 远程助手
        || t.isPromoted                  // 已提升助手
        || (t.type === 'assistant' 
            && !t.isRemote 
            && !t.isPromoted 
            && t.agentState?.isRunning)  // Hub 中正在运行的助手
```

未提升、未运行的 Hub 会话不计入（用户随时可从历史恢复，无丢失风险）。

---

## 十、关键 Store Actions 速查

| Action | 作用 |
|---|---|
| `focusHubConversation(tabId)` | Hub 焦点切到指定会话，触发 LRU |
| `clearHubFocus()` | 清空 Hub 焦点，回欢迎页 |
| `goToHome()` | 清空 activeTabId + hubFocusedAssistantTabId，完全回欢迎页（侧栏「新建对话」） |
| `focusTaskArea()` | 退出联络/待办等可见面，切回任务区；**保留** hubFocusedAssistantTabId |
| `openTodos()` | 打开待办面；清空 activeTabId，**保留** hubFocusedAssistantTabId |
| `promoteConversationToTab(tabId)` | 提升为独立 Tab（**已无用户入口**，仅 fork 继承路径保留） |
| `openHistoryConversation(record)` | 从历史记录恢复会话到 Hub |
| `createAssistantTab({ activate })` | 创建新本地助手 tab；`activate: false` = 不进 TabBar |
| `setActiveTab(tabId)` | 激活 TabBar 可见 Tab（不清除 Hub 焦点） |
| `closeTab(tabId, force?)` | 关 tab；非提升助手 = 降级；提升/终端 = 销毁 |

---

## 十一、常见错误与防范

| 错误 | 后果 | 防范 |
|---|---|---|
| 后台任务调用 `setActiveTab` / `focusHubConversation` | 打断用户当前操作 | 后台路径只调 `addAgentStep` |
| 为 Hub 会话创建 tab 时传 `activate: true` | 会话意外出现在 TabBar | 本地助手 tab 创建一律 `activate: false` |
| 修改 Cmd+W 逻辑 | 影响全局快捷键行为 | 见 `src/APP_SPEC.md`，Cmd+W 是全局规则，不属于 Hub 模型 |
| 侧栏 attention 显示条件不过滤当前可见会话 | 干扰用户正在看的对话 | attention 图标仅对后台会话有效 |
| 删除实时会话时调用 `history.deleteAgentRecord` | 接口报错（记录未落盘）| 先检查 `liveSessionSummaries`，实时会话只关 tab |
