# 联络（Companion）工作台 SPEC

> Last verified: 2026-10-01
> 范围：`src/workbench/companion/` + 渲染组件 `src/components/workbench/CompanionWorkbench.vue`。
> 工作台体系通用规则见 `src/workbench/SPEC.md`；联络的产品定位见 `.cursor/rules/project-architecture.mdc`「任务 / 联络 双入口模型」。

---

## 一、职责

联络（`__companion__`）工作台 = **仅聊天锚点区（AiPanel）**。

联络的定位是「人 / 常驻关系线」：IM / Gateway / 桌面多渠道汇入同一个 `__companion__` 会话，
AI 也能主动找人（`talk_to_user` / Watch 通知）。它不是「专注产出文件」的工作台，因此：

- **不含产出物面板**（那是独立助手工作台 `assistant` 专属）
- **不含历史对话侧栏**（Hub 层 `RecentConversationsPanel`，联络 tab 激活时本就不显示）

## 二、与工作台体系的关系

- `kind = 'companion'`，与 `assistant` **平级**（不是 assistant 的子类型）。
- `tab.type` 仍是 `'assistant'`（后端 Agent context mode 不变）；靠 `resolveWorkbenchKind(tab)`
  按 `agentId === '__companion__'` 映射到 `companion` 工作台。这是 `tab.type ≠ WorkbenchKind` 的典型例子。

## 三、关键文件

| 文件 | 职责 |
|---|---|
| `descriptor.ts` | 声明 `kind='companion'` / renderer，注册到体系 |
| `prompt.ts` | Agent prompt 片段归属地；当前无界面能力 → `undefined` |
| `CompanionWorkbench.vue` | 渲染器（在 `src/components/workbench/`），仅渲染全宽 `AiPanel` |

## 对话时间

联络是一条连续的线，旁边没有「每场对话的日期」可以看。打开之后要能分辨这段话是什么时候说的。

- 在说出口的话前面标时间，居中、灰色、小号，样子像「昨天 20:11」。
- 开头第一句会标。后面相邻两句隔了不到五分钟，不再重复标。
- 标的是说给对方听的：你发的、秘书说的、秘书主动找来的。中间在干活、在想，不单独标时间。
- 任务对话不加。任务列表里已经有最后沟通日期。

## 四、注意事项

- **UI 与 prompt 一致**：联络不挂产出物面板，且 `resolveWorkbenchAgentPrompt('companion', …)`
  返回 `undefined`（不注入产出物面板能力 prompt）。两者必须保持一致——别只改一处。
- **身份判断**用稳定常量 `'__companion__'`（见 `registry.ts COMPANION_AGENT_ID` / `stores/terminal.ts COMPANION_TAB_AGENT_ID`），不要用标题等脆弱匹配。
- **talk_to_user 桌面呈现**：Watch/IM 主动消息经 `watch:proactive-message` 注入联络 tab；进行中任务延迟、完成后 flush；step 类型为 `proactive_notice`（非 `user_task`/`final_result`）。IM 触发 companion run 时须收到 `agent:running` 才能正确延迟（见 `agent/SPEC.md`、`im/SPEC.md`）。
- **后续扩展**：联络若长出专属界面能力，在 `CompanionWorkbench.vue` 加区域、在 `prompt.ts` 导出片段即可，无需动 assistant 工作台。
- **空状态分流**：联络 tab 无历史消息时，欢迎说明走 `WelcomePanel.vue` 内的 `isCompanionTab` 分支（轻量居中：标题 + 多渠道/主动找你两点），不展示独立助手的能力网格/执行模式/注意事项，也不放示例 chips。`isCompanionTab` 由 AiPanel 按 `tab.agentId === COMPANION_AGENT_KEY` 派生传入，与 `resolveWorkbenchKind` 同源。
