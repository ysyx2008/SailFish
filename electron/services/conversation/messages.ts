/**
 * 会话 transcript 切分纯函数 —— Agent 与 Conversation 共用的**唯一**实现。
 *
 * 背景：历史上「把一段连续 transcript 按真实 user 边界切成独立任务」这套逻辑在
 * `agent.ts`（恢复 / fork）和 `conversation.ts`（loadFromRecord）各抄了一份，是
 * 「改一处忘另一处」的典型裂缝。这里收敛成一组纯函数，两边都来调。
 *
 * 纯净：无实例状态、无 IO。task id 的生成方案由调用方通过 `makeId` 注入——
 * Agent 恢复路径用实例级单调序号（跨多次调用防同毫秒碰撞），fork / steps 路径用
 * 数组下标，行为与各自历史实现逐字节一致。
 */
import type { AgentStep, AgentStepRecord } from '@shared/types'
import type { RiskLevel } from '../agent/types'
import type { AiMessage } from '../ai.service'

/**
 * task id 生成策略。`index` = 当前已切出的任务数（即将 push 的这条的下标）。
 * - 实例单调序号方案：`() => `restored_${Date.now()}_${seq++}``（忽略 index）。
 * - 下标方案：`(i) => `restored_${baseTs}_${i}``。
 */
export type TaskIdFactory = (index: number) => string

export interface MessageTask {
  id: string
  userTask: string
  finalResult: string
  messages: AiMessage[]
}

export interface StepTask {
  id: string
  userTask: string
  finalResult: string
  steps: AgentStep[]
}

/**
 * 将连续 API 消息按「真实 user 边界」切分为独立任务。
 * `_systemInjected` 的 user 消息（图片占位 / 上下文压力警告等）不构成边界，并入当前任务。
 */
export function splitMessagesIntoTasks(messages: AiMessage[], makeId: TaskIdFactory): MessageTask[] {
  const tasks: MessageTask[] = []
  let currentTaskMessages: AiMessage[] = []
  let currentUserTask = ''

  for (const msg of messages) {
    const isRealUserBoundary = msg.role === 'user' && !msg._systemInjected

    if (isRealUserBoundary && currentTaskMessages.length > 0) {
      const lastAssistant = [...currentTaskMessages].reverse().find(
        m => m.role === 'assistant' && !m.tool_calls
      )
      tasks.push({
        id: makeId(tasks.length),
        userTask: currentUserTask,
        finalResult: lastAssistant?.content || '',
        messages: currentTaskMessages
      })
      currentTaskMessages = []
    }

    if (isRealUserBoundary) {
      currentUserTask = msg.content || ''
    }

    currentTaskMessages.push(msg)
  }

  if (currentTaskMessages.length > 0) {
    const lastAssistant = [...currentTaskMessages].reverse().find(
      m => m.role === 'assistant' && !m.tool_calls
    )
    tasks.push({
      id: makeId(tasks.length),
      userTask: currentUserTask,
      finalResult: lastAssistant?.content || '',
      messages: currentTaskMessages
    })
  }

  return tasks
}

/** 持久化 step 记录 → 运行时 step（补齐 images / subAgents / canvasData 等富内容字段）。 */
export function stepRecordToStep(s: AgentStepRecord): AgentStep {
  return {
    id: s.id,
    type: s.type as AgentStep['type'],
    content: s.content,
    images: s.images,
    echartsOption: s.echartsOption,
    attachments: s.attachments,
    toolName: s.toolName,
    /**
     * 关联的 tool_call ID——精确配对 tool_call ↔ tool_result 的钥匙。
     * 老记录可能缺失（字段后加），读侧按「缺 toolCallId 退化按 toolName」兼容。
     * 这里必须透传，否则 fork/restore 走 stepRecord→step→stepRecord 往返会丢字段，
     * 导致存盘后配对退化为按 toolName 匹配，并发同名工具调用会相互覆盖。
     */
    toolCallId: s.toolCallId,
    toolArgs: s.toolArgs,
    toolResult: s.toolResult,
    riskLevel: s.riskLevel as RiskLevel | undefined,
    timestamp: s.timestamp,
    webSearchResults: s.webSearchResults,
    success: s.success,
    askingStatus: s.askingStatus,
    askingAnswer: s.askingAnswer,
    autoReview: s.autoReview,
    subAgents: s.subAgents,
    canvasData: s.canvasData,
    hugeOutput: s.hugeOutput,
  }
}

/**
 * 降级路径：旧记录没有 messages 时，从 steps 按 `user_task` 切分重建任务列表。
 */
export function splitStepsIntoTasks(stepRecords: AgentStepRecord[], makeId: TaskIdFactory): StepTask[] {
  if (!stepRecords || stepRecords.length === 0) return []

  const tasks: StepTask[] = []
  let currentSteps: AgentStep[] = []
  let currentUserTask = ''

  for (const s of stepRecords) {
    const step = stepRecordToStep(s)

    if (s.type === 'user_task') {
      if (currentSteps.length > 0 && currentUserTask) {
        const lastFinal = [...currentSteps].reverse().find(st => st.type === 'final_result')
        tasks.push({
          id: makeId(tasks.length),
          userTask: currentUserTask,
          finalResult: lastFinal?.content || '',
          steps: currentSteps
        })
      }
      currentSteps = []
      currentUserTask = s.content || ''
    }

    currentSteps.push(step)
  }

  if (currentSteps.length > 0 && currentUserTask) {
    const lastFinal = [...currentSteps].reverse().find(st => st.type === 'final_result')
    tasks.push({
      id: makeId(tasks.length),
      userTask: currentUserTask,
      finalResult: lastFinal?.content || '',
      steps: currentSteps
    })
  }

  return tasks
}

/**
 * 按 `user_task` step 把会话步骤切成 chunk（每个 chunk = 一个任务的全部步骤）。
 * 用于 fork 截断到第 N 个 task。前置条件：steps 首元素为 user_task（由 initializeRun 保证）。
 *
 * 与 split* 不同，本函数**不接受 `makeId`**：chunk 仅用于按数量截断，不需要 task 身份/id。
 */
export function chunkStepsByUserTask(steps: AgentStep[]): AgentStep[][] {
  const chunks: AgentStep[][] = []
  let current: AgentStep[] = []
  for (const s of steps) {
    if (s.type === 'user_task' && current.length > 0) {
      chunks.push(current)
      current = []
    }
    current.push(s)
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * 联络「从这里创建任务」专用切段——与前端 `agentTaskGroups` 对齐：
 * - `user_task` 开新段
 * - 任务已结束后的 `proactive_notice`（当前段已有 final_result，或尚无 user_task）单独成段
 *   （前端此时会建独立 isProactive group，id = notice step.id）
 * - 进行中任务内的 notice 仍留在当前段
 *
 * 若仍用 {@link chunkStepsByUserTask}，结束后的 notice 会被并进上一段 user_task，
 * 用户点主动消息时锚点会错绑到上一句用户话，截止点随之滑偏。
 */
export function chunkStepsForCompanionExtract(steps: AgentStep[]): AgentStep[][] {
  const chunks: AgentStep[][] = []
  let current: AgentStep[] = []
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current)
      current = []
    }
  }

  for (const s of steps) {
    if (s.type === 'user_task') {
      flush()
      current.push(s)
      continue
    }
    if (s.type === 'proactive_notice') {
      const inActiveUserTask =
        current.some(x => x.type === 'user_task') &&
        !current.some(x => x.type === 'final_result')
      if (inActiveUserTask) {
        current.push(s)
      } else {
        flush()
        chunks.push([s])
      }
      continue
    }
    current.push(s)
  }
  flush()
  return chunks
}
