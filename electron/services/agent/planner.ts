/**
 * Agent 任务规划器
 * 用于复杂任务的分解、规划和进度追踪
 */

// 任务步骤状态
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

// 任务步骤
export interface TaskStep {
  id: string
  description: string
  purpose: string  // 这一步的目的
  status: TaskStepStatus
  result?: string
  error?: string
}

// 任务计划
export interface TaskPlan {
  id: string
  originalTask: string  // 用户原始任务描述
  analysis: string      // 任务分析
  steps: TaskStep[]
  currentStepIndex: number
  createdAt: number
  updatedAt: number
}

// 任务复杂度
export type TaskComplexity = 'simple' | 'moderate' | 'complex'

/**
 * 分析任务复杂度
 */
export function analyzeTaskComplexity(task: string): TaskComplexity {
  const taskLower = task.toLowerCase()
  
  // 复杂任务关键词
  const complexPatterns = [
    /排查|诊断|分析.*原因|故障|问题|为什么/,
    /部署|安装.*配置|搭建.*环境/,
    /迁移|备份.*恢复|升级/,
    /监控|告警|性能.*优化/,
    /自动化|脚本.*批量/,
    /多个|所有|全部.*服务/,
  ]
  
  // 中等复杂度任务关键词
  const moderatePatterns = [
    /配置|修改.*文件/,
    /查看.*并.*分析/,
    /创建|设置/,
    /检查.*状态/,
  ]
  
  // 简单任务关键词
  const simplePatterns = [
    /查看|显示|列出/,
    /是什么|在哪/,
    /执行|运行.*命令/,
  ]
  
  // 检查复杂度
  for (const pattern of complexPatterns) {
    if (pattern.test(taskLower)) {
      return 'complex'
    }
  }
  
  for (const pattern of moderatePatterns) {
    if (pattern.test(taskLower)) {
      return 'moderate'
    }
  }
  
  // 检查任务长度 - 长任务通常更复杂
  if (task.length > 100) {
    return 'moderate'
  }
  
  return 'simple'
}

/**
 * 生成任务计划提示
 * 用于在 System Prompt 中引导 AI 生成结构化的计划
 */
export function generatePlanningPrompt(task: string, complexity: TaskComplexity): string {
  if (complexity === 'simple') {
    return '' // 简单任务不需要额外规划提示
  }
  
  if (complexity === 'moderate') {
    return `
【任务规划提示】
这是一个中等复杂度的任务。请在开始执行前：
1. 简要说明你的执行思路（2-3 句话）
2. 列出主要步骤（3-5 步）
3. 然后开始执行
`
  }
  
  // 复杂任务
  return `
【任务规划提示】
这是一个复杂任务，需要仔细规划。请按以下格式制定计划：

**【任务分析】**
- 任务目标：（用一句话概括）
- 难点/风险：（列出可能的困难）
- 前置条件：（需要先确认什么）

**【执行计划】**
1. 步骤一：xxx
   - 目的：xxx
   - 预期结果：xxx
2. 步骤二：xxx
   ...

**【开始执行】**
（确认计划后，开始执行第一步）

---
请先输出计划，确认无误后再执行。如果任务目标不清晰，请先向用户确认。
`
}

/**
 * 创建新的任务计划
 */
export function createTaskPlan(task: string, analysis: string, steps: Array<{ description: string; purpose: string }>): TaskPlan {
  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    originalTask: task,
    analysis,
    steps: steps.map((step, index) => ({
      id: `step_${index + 1}`,
      description: step.description,
      purpose: step.purpose,
      status: 'pending' as TaskStepStatus
    })),
    currentStepIndex: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

/**
 * 更新步骤状态
 */
export function updateStepStatus(
  plan: TaskPlan, 
  stepIndex: number, 
  status: TaskStepStatus, 
  result?: string,
  error?: string
): TaskPlan {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    return plan
  }
  
  const updatedSteps = [...plan.steps]
  updatedSteps[stepIndex] = {
    ...updatedSteps[stepIndex],
    status,
    result,
    error
  }
  
  // 如果当前步骤完成，移动到下一步
  let newCurrentIndex = plan.currentStepIndex
  if (status === 'completed' && stepIndex === plan.currentStepIndex) {
    newCurrentIndex = Math.min(stepIndex + 1, plan.steps.length - 1)
  }
  
  return {
    ...plan,
    steps: updatedSteps,
    currentStepIndex: newCurrentIndex,
    updatedAt: Date.now()
  }
}

/**
 * 获取计划执行进度
 */
export function getPlanProgress(plan: TaskPlan): { 
  completed: number
  total: number
  percentage: number
  currentStep: TaskStep | null
} {
  const completed = plan.steps.filter(s => s.status === 'completed').length
  const total = plan.steps.length
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0
  const currentStep = plan.steps[plan.currentStepIndex] || null
  
  return { completed, total, percentage, currentStep }
}

/**
 * 格式化计划为可读文本
 */
export function formatPlanAsText(plan: TaskPlan): string {
  const progress = getPlanProgress(plan)
  const statusIcons: Record<TaskStepStatus, string> = {
    pending: '⏳',
    in_progress: '🔄',
    completed: '✅',
    failed: '❌',
    skipped: '⏭️'
  }
  
  let text = `**任务计划** (进度: ${progress.percentage}%)\n\n`
  text += `📋 ${plan.originalTask}\n\n`
  
  if (plan.analysis) {
    text += `**分析**: ${plan.analysis}\n\n`
  }
  
  text += `**步骤**:\n`
  plan.steps.forEach((step, index) => {
    const icon = statusIcons[step.status]
    const current = index === plan.currentStepIndex ? ' 👈 当前' : ''
    text += `${icon} ${index + 1}. ${step.description}${current}\n`
    if (step.result) {
      text += `   结果: ${step.result}\n`
    }
    if (step.error) {
      text += `   错误: ${step.error}\n`
    }
  })
  
  return text
}

/**
 * 检查计划是否完成
 */
export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.steps.every(s => s.status === 'completed' || s.status === 'skipped')
}

/**
 * 检查计划是否失败
 */
export function isPlanFailed(plan: TaskPlan): boolean {
  return plan.steps.some(s => s.status === 'failed')
}

/**
 * 任务规划管理器
 */
export class TaskPlanner {
  private plans: Map<string, TaskPlan> = new Map()
  
  /**
   * 分析任务并决定是否需要规划
   */
  analyzeTask(task: string): { 
    needsPlanning: boolean
    complexity: TaskComplexity
    prompt: string 
  } {
    const complexity = analyzeTaskComplexity(task)
    const needsPlanning = complexity !== 'simple'
    const prompt = generatePlanningPrompt(task, complexity)
    
    return { needsPlanning, complexity, prompt }
  }
  
  /**
   * 创建并保存计划
   */
  createPlan(task: string, analysis: string, steps: Array<{ description: string; purpose: string }>): TaskPlan {
    const plan = createTaskPlan(task, analysis, steps)
    this.plans.set(plan.id, plan)
    return plan
  }
  
  /**
   * 获取计划
   */
  getPlan(planId: string): TaskPlan | undefined {
    return this.plans.get(planId)
  }
  
  /**
   * 更新计划步骤
   */
  updateStep(
    planId: string, 
    stepIndex: number, 
    status: TaskStepStatus, 
    result?: string,
    error?: string
  ): TaskPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    
    const updatedPlan = updateStepStatus(plan, stepIndex, status, result, error)
    this.plans.set(planId, updatedPlan)
    return updatedPlan
  }
  
  /**
   * 获取计划进度
   */
  getProgress(planId: string): ReturnType<typeof getPlanProgress> | null {
    const plan = this.plans.get(planId)
    if (!plan) return null
    return getPlanProgress(plan)
  }
  
  /**
   * 清理计划
   */
  cleanup(planId: string): void {
    this.plans.delete(planId)
  }
}

