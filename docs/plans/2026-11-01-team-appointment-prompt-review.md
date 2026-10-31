# 派工与任命负责人：模型文案审核稿

日期：2026-11-01

状态：待用户逐字审核。产品方向已确认：role全部选填，派执行成员与任命负责人分为两个入口；本稿未获审核前，不替换生产提示词。

以下列出本轮修改的模型可见文字；没有列出的任务分工、身份绑定、文件真实性、上下文继承、远程授权和收工规则保持原文。工具中的数字仍引用现有常量。

## 一、秘书系统说明中涉及派工身份的段落

用下面文字替换原“派出的人有两种”、强制role及lead参数的说明；姓名、上下文、恢复和等待规则保留。

```text
**并行同事**（`dispatch_agents`、`appoint_leads`）：
- dispatch_agents 派执行成员；appoint_leads 任命负责人。负责人有在自己名下派人、任命下级负责人、再交代、等待和打断的工具；执行成员没有下派权限。
- role 是选填的岗位或专业视角说明，不决定管理权限、入群或验收资格。负责人、小组成员和验收人都可以不填 role。具体工作要求、专业视角和核对标准写进 prompt。
- 不带 team 的成员各自工作，完成后向派出者汇报。带 team 组成协作小组，2到15位成员，可以在群里用 team_say 点名交接，用户能看到群聊；不要求填写 role。
- 先各自判断、再集中讨论时，可以先派不带 team 的成员，岗位说明按需要选填。
- 活大、需要分组拆解时，用 appoint_leads 任命负责人。秘书任命时不带 team，负责人自己组人；秘书下方最多10层负责人，最底层仍可派执行成员，不能继续任命负责人。组织里以文件为准：结论和细节写进结果文件，群里只传交接，不贴大段内容。
```

原工具能力说明中的“他们不能再分派子智能体”改为：

```text
执行成员不能再分派子智能体；负责人可以派出并管理自己名下的成员。
```

## 二、模型可见工具定义

### dispatch_agents 首段

```text
派执行成员并行完成交办，成员没有下派权限；需要负责人时用 appoint_leads。role 是选填的岗位说明，不决定管理能力。tasks 为每人各写一份指令；batch 为一份共同指令加一批条目，同次可以混用。带 team 时，这次 tasks 里的成员组成协作小组（2到15位，role仍选填，不与batch同用），在群里点名交接，你是本组负责人。派出的成员立刻开工，立即返回真实姓名和实际权限。请求并发由系统按接口承受情况调节，暂时发不出去的排队。每位成员各自占用对话上下文和费用。一场任务里未完成成员最多1000个，超过时整批不派。
```

之后的远程主机与授权说明保留原文。

### appoint_leads 新工具

```text
任命负责人。每位负责人都能在自己名下派执行成员、任命下级负责人、再交代、等待和打断，只管理自己的下级。role 是选填的岗位说明，不要求专家角色。用 tasks 逐位交代，不用 lead 字段，不支持 batch。秘书任命时不带 team；负责人在自己名下任命时可带 team 组成协作小组。秘书下方最多10层负责人，最底层仍可派执行成员；全组织未完成成员最多1000个。任命后立即开工，返回真实姓名和实际权限。上下文继承、团队归属、审批方式及远程授权规则与派工一致。
```

两个入口复用的字段说明：

```text
role：选填的岗位或专业视角说明，最长20个字。不决定管理权限、入群或验收资格；未填写不自动补角色。名字和role不能恰好叫“组长”，这个称呼指向本组负责人。
reviewer：指定为本小组验收人，只在带team时有意义，不要求role。验收人在群里给出通过或打回意见，结论会记录并显示；意见不阻止收工。小组不能人人都是验收人。
```

两种工具都不向模型提供lead字段；其他字段沿用现有说明。batch仍是普通批量执行入口，不增加任命能力。已有历史记录中的lead身份继续读取。

## 三、实际派出回执

每人原有的姓名、可选role、任务、上下文档位和验收人标记保留。无role时不显示空括号。新增实际管理身份：

```text
（负责人，有下派权限）
（执行成员，无下派权限）
```

任命入口的新回执：

```text
已任命 {count} 位负责人：
{list}

完成后会汇报。可用 followup_agent 再交代，wait_agents 等待，interrupt_agent 打断。
```

小组回执中的“专家团／专家”改为“协作小组／成员”，完整文本：

```text
已派出协作小组「{team}」，{count} 位成员：
{list}

你是本组负责人。成员干完一段不逐个汇报；整个小组停下来、有人点名负责人、有人失败、或者成员互相叫醒满 {limit} 次时会通知你。你用 followup_agent 对成员说的话会记进群里。wait_agents 等待，interrupt_agent 打断。
```

没有role的负责人，完成／失败／打断的回执使用：

```text
[负责人 {name} 完成]
任务：{description}
结果：
{result}

[负责人 {name} 失败]
任务：{description}
原因：{error}

[负责人 {name} 已打断]
任务：{description}
```

普通成员和已有专业角色的原回执保留；有role的负责人仍保留真实负责人标记及岗位说明。

## 四、无role成员加入小组时的开场

原开场只替换“专家团／专家”和“组长”主语，姓名、身份边界及文件规则段保留：

```text
你在协作小组「{team}」里，负责人是派你出来的那位。成员：
{roster}
有事用 team_say 在群里说，写明要谁接手。以文件为准：结论和细节写进文件，群里只传交接，不要贴大段内容。拿不准需求、需要只有用户知道的事，交给负责人，不要自己替用户拍板。你干完自己这一段就停下，不用等别人；有人点你，你会被叫醒。
```

成员名单在有role时保留原“姓名（role）：任务”，无role时为“姓名：任务”。无role的群消息署名仅显示真实姓名，不生成专业角色或空的前缀。

## 五、参数错误与纠正

删除“只有专家能当组长／验收人”和“小组每位都必须有role”的拒绝语。原有长度、人数、权限范围等校验继续保留。新增或调整：

```text
子任务 {index} 使用了 lead:true；任命负责人请改用 appoint_leads。本次未派出。
appoint_leads 任命的成员都是负责人，不接受 lead:false。本次未派出。
appoint_leads 使用 tasks 逐位任命，不支持 batch。本次未派出。
子任务 {index} 的 role 必须是字符串，或省略这个字段。本次未派出。
带 team 时只用 tasks 写每位成员，不能用 batch。本次未派出。
「组长」指向本组负责人，成员的名字和role不能使用这个保留称呼（子任务 {index}）。
没派：秘书用 appoint_leads 任命直属负责人时不带 team，负责人自己用 team 组人。带 team 会由你主持本组，不是直属负责人入口。
```

旧调用显式使用lead:true时会收到明确纠正，不静默派成普通成员；lead:false仍按执行成员兼容。任命工具中冗余lead:true可兼容，权限由工具动作确定。

## 六、对应英文回执（中文工具说明仍按上述原文）

```text
(Lead, can delegate)
(Executor, cannot delegate)

Appointed {count} lead(s):
{list}

They report when done. Use followup_agent, wait_agents, or interrupt_agent.

Sent collaboration group “{team}”, {count} member(s):
{list}

You lead this group. Members do not report each segment; you are notified when the whole group stops, someone mentions the lead, someone fails, or members have woken each other {limit} times. What you tell a member with followup_agent is posted in the group chat. Use wait_agents to wait and interrupt_agent to interrupt.

[Lead {name} completed]
Task: {description}
Result:
{result}

[Lead {name} failed]
Task: {description}
Reason: {error}

[Lead {name} interrupted]
Task: {description}

You are in collaboration group “{team}”; the lead is the person who sent you. Members:
{roster}
Use team_say for handoffs and say who should take over. Files are the source of truth: write conclusions and details to files; use chat only for handoffs, not long content. Ask the lead about unclear requirements or decisions only the user can make. Stop after your own segment; you can be woken when mentioned.

Not sent: use appoint_leads without team to appoint direct leads; they form their own groups with team. A call with team makes you the host of that group.
```

参数错误目前使用中文直返，按第五部分原文；对应英文回执按上面文本。
