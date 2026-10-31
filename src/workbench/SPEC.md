# 工作台（Workbench）体系 SPEC

> Last verified: 2026-09-10
> 范围：`src/workbench/`（体系类型、注册、prompt 解析）+ `src/components/workbench/`（渲染组件）。
> 单个工作台的契约见各自子目录的 SPEC（assistant 见 `assistant/HUB_SPEC.md` + `assistant/artifact/SPEC.md`；联络见 `companion/SPEC.md`）。

---

## 一、心智模型

- **团队观察界面（2026-10-31）**：查看团队固定铺满工作区，不显示会话对话或浮动输入；点成员、群聊和成果只在右侧固定详情区查看，不提供详情全屏模式。详情可拖动调宽，开合或调宽不改变画布排列与当前阅读位置。关闭详情回完整团队总览，关闭团队恢复原会话或工作面及输入草稿。普通产出物铺满时的浮动对话仍保留。团队契约详见 Agent SPEC。
- **一个 Tab = 一个工作台实例**。工作台 = 一个常驻**锚点区** + 若干可显隐的**辅助区**，区域间可拖分隔条调比例。
- **助手是对话 + 这场对话的画布（2026-08-19 确认，2026-08-25 补）**：早期「Agent + Canvas」就是这个——对话是人，画布是桌，桌上可以摊任何内容。产出物栏是桌的一部分（文件/预览），不是另一套东西；终端也上同一张桌。画布没有固定边，按入座内容的角色坐：终端是工作面，坐左边，对话陪右边；文件和网页是参照，坐右边，对话留左边。人可以把正在看的文件临时铺满——文件变成工作面，对话退成一句提醒和浮在文档上的输入；座位仍是「空 / 终端 / 文件」，铺满不是第四个座位。一次只有一个座位，点清单换谁入座，让开的还在桌上。不要三栏。没有东西入座时，对话独占主区。换一场对话就换一块桌，不跟别的任务混。这不是把这场对话改成终端页。终端页（本机/远程）自己的关页即散场，不受影响。
- **换座（2026-08-19 确认）**：正在看产出物时助手打开终端，终端入座，文件让开进清单（草稿还在）。正在看终端时助手又产出文件，只进清单、不抢座位。人点清单（或助手明确要打开给用户看）才把文件请回来，终端让座仍活着。当前这份离座（关最后一扇终端 / 收起这份文件）后回到对话独占，不自动把另一份请回来。
- **终端入座后的顶栏（2026-08-18 确认）**：左边终端栏也要有自己的顶栏，和右边对话栏齐平。顶栏可以拖动窗口。关掉终端（标题栏关掉，或关掉最后一扇）就离座，人不走。侧栏收起时顶栏必须给窗口按钮让位，标题不能被挡住。
- **侧栏开合只让最左那一栏给窗口按钮让位（2026-08-19 确认）**：终端入座后左边是终端、右边是对话。折叠历史对话侧栏时，只有贴着窗口左沿的那一栏（终端标题栏）给红绿灯 / 侧栏开关让位；右边对话栏不贴窗口左沿，顶栏上的「严格/宽松/自由」和主机信息必须留在对话栏自己的顶栏里，不要跟着侧栏跑。没开终端、对话独占主区时，对话顶栏才吃左侧让位。
- **独立助手的终端只要标题、不要标签条（2026-08-19 确认）**：一个对话一个 Agent，多开标签没有意义，连标签条都不要。终端入座后，左边顶栏只要一个标题（如「本地终端」或 SSH 名），不要终端页那种标签条、不要加号、不要左右滚动。标题栏要能关，或留着明显的关闭；关了仍离座回对话。换座靠清单。不要把这场对话改成终端页。终端页（本机 / 远程）仍然可以多开标签，每个标签一个 Agent，那边不要动。同一场对话里把窗口分屏可以留（还是这一个 Agent 的多扇窗）。
- **终端页窗格可拖着排放，边上用来新建（2026-09-10 确认）**：已经并排的几扇，抓住顶上的机器名拖到另一扇边上换位置。从主机列表或新建按钮拖到眼前窗口边上，松手就在那边新开。不要把已打开的标签拖进去合并。这套只给终端页，助手对话页不做。不做成浮动、重叠或独立系统窗口。同一方向再加一扇要均分，不要一层层对半切；换方向才在那一格里劈开。拖主机过来先出窗格、显示正在连接，连不上也在那一扇里说，不要干等再弹超时。正在连接或连不上时，对话照样能发，字不能丢。四边落点要够大，中间只留一小块空着。
- **分隔线与主机信息（2026-08-19 确认）**：终端入座后，左边终端和右边对话之间要有和终端页一样的竖向分隔线。终端离座后，这台终端的主机信息不要留着。
- **终端页也是三栏（2026-08-19 确认）**：侧栏、终端、对话各占一栏，各栏自己的顶栏贴到窗口上沿。不要再在两栏上头压一条通栏菜单。独立助手终端入座之后，看上去就应该和终端页一样。这时候折的是右边对话，按钮钉在窗口上，不跟着栏走，和历史侧栏那个开关一样。钉住之后还要能点；位置和第一排对齐，并让开窗口控件。看文件时折的仍是右边画布，不要和折对话搅成一颗按钮。
- **终端栏标签必须看得见（2026-08-19 确认）**：三栏之后终端顶栏比以前窄，标签一多就会横向溢出。新开的那一块、以及点到被挤到栏外的那一块，必须自动滚进看得见的地方。对话栏开合或侧栏让位让顶栏变窄时，当前这块标签也得还在视野里。
- **工作台类型 ≠ 终端类型**。`WorkbenchKind` 是 `TerminalType`（`local`/`ssh`/`assistant`）的**超集**：同一 `tab.type='assistant'` 可以映射到不同工作台（如普通助手 `assistant` vs 联络 `companion`）。这就是为什么需要一个 `tab → kind` 映射函数，而不能直接拿 `tab.type` 当工作台类型。
- **渲染两种方式**（见 `types.ts`）：
  - **renderer（逃生口）**：工作台有特殊 chrome 时给一个专属组件，直接渲染整个工作台。当前所有内置工作台都走这条。
  - **regions（声明式）**：无特殊 chrome 时只声明区域，交给通用 `WorkbenchShell` 渲染（预留）。

---

## 二、核心概念（`types.ts`）

| 概念 | 说明 |
|---|---|
| `WorkbenchKind` | 工作台类型，`TerminalType \| 'companion'`。registry 的查表 key。 |
| `WorkbenchDescriptor` | 一种工作台一条：`{ kind, renderer?, regions?, availableInSteam? }`，集中登记在 registry。 |
| `RegionSpec` | 区域声明（anchor / toggle、左右侧、默认显隐、可否调尺寸），声明式工作台用。 |

---

## 三、两个注入入口（最易漏）

新增工作台**必须**接通这两处，否则只是建了个孤岛：

| 入口 | 函数 | 调用点 | 作用 |
|---|---|---|---|
| **渲染** | `resolveWorkbenchRenderer(kind)` (`registry.ts`) | `App.vue`（`<component :is>`） | 决定 tab 用哪个组件渲染 |
| **Prompt** | `resolveWorkbenchAgentPrompt(kind, tab)` (`resolve-workbench-agent-prompt.ts`) | `useAgentMode.ts` | 注入工作台专属 system prompt 片段（→ `AgentContext.workbenchPrompt`，后端 `prompt-builder.ts` 原样透传） |

两处调用点都先经 **`resolveWorkbenchKind(tab)`**（`registry.ts`）把 tab 映射成 `WorkbenchKind`——这是"tab → 工作台类型"的**唯一**映射点，所有按身份分流的逻辑都收敛于此，不散落到组件里。

---

## 四、目录约定

| 层 | 位置 | 内容 |
|---|---|---|
| **逻辑 / 描述符** | `src/workbench/<kind>/` 或 `@sailfish/workbench-<kind>` | `descriptor.ts` + `prompt.ts`；assistant 真相源在 `packages/workbench-assistant`；样例台 `packages/workbench-sample` |
| **渲染组件** | `src/components/workbench/` 或包内 | `<Kind>Workbench.vue`；assistant 经 `@/` 引用 AiPanel / artifact（P2 前） |

> 终端类工作台（local/ssh）的 renderer 复用 `TerminalTabView`（Terminal 实例 Teleport 保命池所需），不在 `components/workbench/` 下。

---

## 五、新增一个工作台 Checklist

以新增 `companion` 为例（一种 `tab.type='assistant'` 但外观独立的工作台）：

1. **建目录** `src/workbench/companion/`。
2. **`descriptor.ts`** — `{ kind: 'companion', renderer: CompanionWorkbench, availableInSteam: false }`。
3. **`prompt.ts`** — 导出 prompt 片段与注入判据；若无界面能力可注入，让 `resolveWorkbenchAgentPrompt` 对该 kind 返回 `undefined`。
4. **渲染组件** `src/components/workbench/CompanionWorkbench.vue`。
5. **注册** `registry.ts`：加入 `DESCRIPTORS`。
6. **映射**（仅当 `kind ≠ tab.type`）：在 `resolveWorkbenchKind(tab)` 里按稳定身份（如 `agentId === '__companion__'`）返回该 kind。
7. **prompt 解析** `resolve-workbench-agent-prompt.ts`：处理新 kind 分支。
8. **导出** `index.ts`：按需 re-export descriptor / prompt 常量。
9. **测试** `__tests__/prompts.test.ts`：补该 kind 的注入用例。
10. **文档**：写 `companion/SPEC.md`（指向类型而非复制），必要时同步 `assistant/HUB_SPEC.md`。

---

## 六、约定与注意

- **Steam 构建回退**：`availableInSteam: false` 的工作台在 Steam 版回退到 `TerminalTabView`（见 `resolveWorkbenchRenderer`）。助手类（assistant/companion）均为 false。
- **不要为 tab.type 复制第二套枚举**：`WorkbenchKind` 只在"工作台外观确实独立于终端类型"时才扩展（如 companion），扩展后必须配套 `resolveWorkbenchKind` 映射，否则 `tab.type` 永远查不到它。
- **prompt 注入条件改动**需同步 `prompts.test.ts`。
- **身份判断用稳定常量**（如 `COMPANION_TAB_AGENT_ID`），不要用标题/关键词等脆弱匹配。
