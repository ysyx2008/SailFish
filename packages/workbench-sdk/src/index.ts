/**
 * @sailfish/workbench-sdk
 *
 * 工作台 SDK：类型 / 注册表 / prompt 解析 / bootstrap / AiPanel 正式出口。
 * AiPanel 实现仍在 desktop（依赖未解耦）；岗位定制靠 descriptor.agentPrompt/skills/mcpServers。
 */
export type {
  WorkbenchKind,
  WorkbenchDescriptor,
  WorkbenchAgentPromptTab,
  WorkbenchRendererProps,
  RegionSpec,
  RegionRole,
  RegionSide,
} from './types'

export {
  registerWorkbench,
  getWorkbenchDescriptor,
  listWorkbenchDescriptors,
  clearWorkbenchRegistryForTests,
} from './registry-store'

export { resolveWorkbenchAgentPrompt } from './resolve-workbench-agent-prompt'
export { bootstrapWorkbenchCapabilities } from './bootstrap'
export type { WorkbenchBootstrapResult } from './bootstrap'

/**
 * 平台壳请从子路径导入（勿塞进主入口，以免拉入 Vue 巨石）：
 * - `@sailfish/workbench-sdk/ai-panel`
 * - `@sailfish/workbench-sdk/expert-team`
 * - `@sailfish/workbench-sdk/terminal-tab-view`
 * - `@sailfish/workbench-sdk/terminal-pane-host`
 * - `@sailfish/workbench-sdk/workbench-shell`
 * - `@sailfish/workbench-sdk/toast`
 * - `@sailfish/workbench-sdk/markdown`
 * - 或 `@sailfish/workbench-sdk/platform`（汇总 re-export）
 */
