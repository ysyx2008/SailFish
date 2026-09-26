/**
 * 编程技能（默认关闭，用户在设置里打开）
 * 打开本机项目、按内容搜、按模式找文件、一次改多处、改后查语法。设计目标见同目录 SPEC.md。
 */
import { registerSkill } from '../registry'
import type { Skill } from '../types'
import { codingTools, codingSkillContent } from './tools'
import { CodingState, CODING_SKILL_ID } from './state'
import { SyntaxGuard } from './syntax-guard'
import { checkpointKeeper } from './checkpoint-keeper'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('CodingSkill')
const syntaxGuard = new SyntaxGuard()

const codingSkill: Skill = {
  id: CODING_SKILL_ID,
  name: '编程',
  description:
    '在本机项目里写代码、改代码、修 bug：打开项目目录（看结构、git 状态、检查与测试命令、项目约定），按内容搜代码、按模式找文件、同一文件一次改多处，改完自动提示可能新引入的语法错误，每轮自动留检查点、可以撤回。做软件开发类任务时加载。',
  tools: codingTools,
  content: codingSkillContent,
  defaultEnabled: false,
  inheritToSubAgents: true,
  workingDirectory: data => new CodingState(data).root,
  onRunStart: async ctx => checkpointKeeper.onRunStart(ctx),
  wrapToolCall: (call, proceed, ctx) => checkpointKeeper.guard(ctx.data, () => syntaxGuard.wrap(call, proceed, ctx)),
}

try {
  registerSkill(codingSkill)
} catch (error) {
  log.error('Failed to register:', error)
}

export { codingSkill }
export { executeCodingTool } from './executor'
