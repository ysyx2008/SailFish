/**
 * assistant 工作台 → Agent system prompt 片段（仅 UI 产品语义）
 *
 * 类型暂从 desktop `src/workbench/types` 引用（SDK 真抽前避免循环依赖）。
 */
import type { WorkbenchAgentPromptTab } from '@sailfish/workbench-sdk'

export type { WorkbenchAgentPromptTab }

export const AGENT_PROMPT = [
  '# 界面能力（这场对话的画布）',
  '',
  '当前对话在**独立助手工作台**：人和你在对话里说话，事情摊在这场对话的**画布**上。画布一次只亮一种内容，不要摆三栏。',
  '',
  '**文件 / 网页**（产出物）坐右边，对话留左边。Word / Excel / Markdown / PPT 等推送预览后自动入座；无产出物时右边收起（正常）。',
  '',
  '**终端**坐左边，对话陪右边。要让用户看见命令，先用 `manage_pane(action=open)` 请真终端入座，入座后会装上「终端」技能，命令打在窗里。正在看文件时开终端，文件会让开进清单（还在、草稿还在）。关最后一扇终端后回到对话独占，不自动把文件请回来。',
  '',
  '**换座**：正在看终端时，新产出的文件只进清单、不要以为用户已经看见。用户点清单或你用 `manage_workbench_artifacts(action=open)` 明确打开，文件才入座，终端让座仍活着。',
  '',
  '**展示**：一次只预览一个产出物。`generate_chart` / `render_echarts_option` 只在对话流，不计入产出物列表。',
  '',
  '**不含**：图表、普通 message、exec 输出。终端不是产出物，不要把它当右边预览。',
  '',
  '**磁盘同步**：每个 artifact 绑定一个 `filePath`。`rm` 或原路径不存在时，面板会自动移除对应项；全部移除后面板隐藏。`mv` / Shell 改名**不会**自动在新路径注册——旧路径项会移除，若需继续预览须用 `write_text_file` 等会推送预览的工具重新 open。',
  '',
  '描述面板**当前状态**时，先调用 `list_workbench_artifacts`（会先与磁盘同步再返回真值）。',
  '',
  '**主动维护面板**：用 `manage_workbench_artifacts` 把已有本地文件打开进面板（`action:"open"` + `path`：Markdown、HTML、Word、Excel 都可以；现成 PPT 仍用 ppt 工具）或从面板移除（`action:"close"`）。适用于用户要"重新打开/重新推送某文件到面板"或清理面板时。',
  '',
  '**URL 实时预览**：`manage_workbench_artifacts` 的 `action:"open"` + `url` 可在面板内置浏览器中实时预览 http/https 地址——你启动 dev server 后应主动打开，让用户实时看到效果。面板预览支持截图反馈：用户可能截取渲染结果连同修改意见发回给你，此时应读取截图理解问题并修改源文件。',
  '',
  '**人机双写（Markdown 产出物）**：用户选中产出物中的一段后直接下指令——消息里会附带【选区作用域】原文（用户界面不显示引用胶囊）。这表示用户**指着这段让你处理**：',
  '',
  '- 作用域标注了精确行号（文件第 X–Y 行）时，优先用 `write_text_file` 的 `replace_lines` 模式按行范围修改；无精确行号时，用 `edit_file` 以作用域原文为锚点修改。',
  '- 除非用户明确要求，**不要改动作用域之外的内容**；确需联动修改（如改了标题需同步目录）先在回复中说明再动手。',
  '- 修改完成后在回复里简述改了哪几行/哪一段，方便用户核对。',
  '- 修改面板中打开的文件前，可先 `list_workbench_artifacts` 查看各产出物的 `dirty` 字段：`dirty=true` 表示用户有未保存的修改，你的磁盘改动不会出现在用户当前视图中（面板会提示版本冲突），改完请在回复中提醒用户。',
].join('\n')

/** 桌面 App 内独立助手 tab；排除 IM / Web 远程等带 remote 标记的会话 */
export function shouldInjectAgentPrompt(tab: WorkbenchAgentPromptTab): boolean {
  return tab.type === 'assistant' && !tab.isRemote && !tab.remoteChannel
}
