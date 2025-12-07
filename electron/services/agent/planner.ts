/**
 * Agent 任务规划器
 * 用于复杂任务的分解、规划和进度追踪
 * 借鉴 DeepAgent 的动态规划和策略调整能力
 */

// 任务步骤状态
export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'blocked'

// 步骤依赖类型
export type DependencyType = 'sequential' | 'conditional' | 'parallel'

// 任务步骤（增强版）
export interface TaskStep {
  id: string
  description: string
  purpose: string  // 这一步的目的
  status: TaskStepStatus
  result?: string
  error?: string
  // 新增：动态调整支持
  retryCount?: number        // 重试次数
  maxRetries?: number        // 最大重试次数
  alternativeApproach?: string  // 备选方案描述
  dependencies?: string[]    // 依赖的步骤 ID
  dependencyType?: DependencyType  // 依赖类型
  checkpoint?: boolean       // 是否为关键检查点
  estimatedDuration?: number // 预估耗时（秒）
  actualDuration?: number    // 实际耗时（秒）
  startTime?: number         // 开始时间
}

// 计划调整记录
export interface PlanAdjustment {
  timestamp: number
  type: 'add_step' | 'remove_step' | 'modify_step' | 'reorder' | 'change_strategy'
  reason: string
  details: string
}

// 执行策略
export type ExecutionStrategy = 'default' | 'conservative' | 'aggressive' | 'diagnostic'

// 任务计划（增强版）
export interface TaskPlan {
  id: string
  originalTask: string  // 用户原始任务描述
  analysis: string      // 任务分析
  steps: TaskStep[]
  currentStepIndex: number
  createdAt: number
  updatedAt: number
  // 新增：动态调整支持
  adjustments?: PlanAdjustment[]  // 计划调整历史
  strategy?: ExecutionStrategy    // 当前执行策略
  riskAssessment?: string         // 风险评估
  successCriteria?: string[]      // 成功标准
  fallbackPlan?: string           // 备选计划描述
}

// 任务复杂度
export type TaskComplexity = 'simple' | 'moderate' | 'complex'

// 策略建议
export interface StrategyRecommendation {
  strategy: ExecutionStrategy
  reason: string
  confidence: number  // 0-1
}

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
 * 生成任务计划提示（增强版）
 * 借鉴 DeepAgent 的端到端规划风格
 */
export function generatePlanningPrompt(task: string, complexity: TaskComplexity): string {
  if (complexity === 'simple') {
    return '' // 简单任务不需要额外规划提示
  }
  
  if (complexity === 'moderate') {
    return `
【任务规划】
中等复杂度任务。开始前：
1. 说明执行思路（1-2 句）
2. 列出 2-4 个关键步骤
3. 标注可能需要调整的环节
`
  }
  
  // 复杂任务 - 使用更结构化的规划格式
  return `
【复杂任务规划】

**📋 任务分析**
- 目标：（一句话）
- 风险点：（可能的问题）
- 检查点：（需要验证的关键节点）

**🔄 执行计划**
1. [步骤名] - 目的：xxx
2. [步骤名] - 目的：xxx
   ...

**⚡ 动态调整策略**
- 如果步骤 N 失败：[备选方案]
- 发现新信息时：重新评估后续步骤

---
制定计划后开始执行。执行中如需调整，说明原因后继续。
`
}

/**
 * 推荐执行策略
 */
export function recommendStrategy(task: string, context?: {
  previousFailures?: number
  systemLoad?: 'low' | 'medium' | 'high'
  isProduction?: boolean
}): StrategyRecommendation {
  const taskLower = task.toLowerCase()
  
  // 诊断类任务 -> 诊断策略
  if (/诊断|排查|分析|为什么|原因/.test(taskLower)) {
    return {
      strategy: 'diagnostic',
      reason: '任务需要深入分析，采用诊断策略',
      confidence: 0.85
    }
  }
  
  // 生产环境或高风险操作 -> 保守策略
  if (context?.isProduction || /生产|线上|重要/.test(taskLower)) {
    return {
      strategy: 'conservative',
      reason: '涉及生产环境，采用保守策略确保安全',
      confidence: 0.9
    }
  }
  
  // 之前有失败记录 -> 保守策略
  if (context?.previousFailures && context.previousFailures >= 2) {
    return {
      strategy: 'conservative',
      reason: '之前尝试有失败，切换到保守策略',
      confidence: 0.8
    }
  }
  
  // 紧急任务 -> 激进策略
  if (/紧急|立即|马上|尽快/.test(taskLower)) {
    return {
      strategy: 'aggressive',
      reason: '任务紧急，采用快速执行策略',
      confidence: 0.75
    }
  }
  
  return {
    strategy: 'default',
    reason: '常规任务，使用默认策略',
    confidence: 0.7
  }
}

/**
 * 评估步骤是否可以重试
 */
export function canRetryStep(step: TaskStep): boolean {
  const maxRetries = step.maxRetries ?? 2
  const currentRetries = step.retryCount ?? 0
  return currentRetries < maxRetries && step.status === 'failed'
}

/**
 * 获取步骤的备选方案建议
 */
export function getAlternativeApproach(step: TaskStep, errorMessage?: string): string {
  // 如果步骤已有备选方案，返回它
  if (step.alternativeApproach) {
    return step.alternativeApproach
  }
  
  // 根据错误类型推荐备选方案
  if (errorMessage) {
    const errorLower = errorMessage.toLowerCase()
    
    if (errorLower.includes('permission denied') || errorLower.includes('权限')) {
      return '尝试使用 sudo 或检查文件权限'
    }
    
    if (errorLower.includes('not found') || errorLower.includes('找不到')) {
      return '检查路径是否正确，或搜索文件位置'
    }
    
    if (errorLower.includes('timeout') || errorLower.includes('超时')) {
      return '增加超时时间或检查网络/服务状态'
    }
    
    if (errorLower.includes('connection') || errorLower.includes('连接')) {
      return '检查网络连接或服务是否运行'
    }
  }
  
  return '换一种方法尝试，或向用户询问更多信息'
}

/**
 * 创建新的任务计划（增强版）
 */
export function createTaskPlan(
  task: string, 
  analysis: string, 
  steps: Array<{ 
    description: string
    purpose: string
    checkpoint?: boolean
    alternativeApproach?: string
  }>,
  options?: {
    strategy?: ExecutionStrategy
    riskAssessment?: string
    successCriteria?: string[]
  }
): TaskPlan {
  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    originalTask: task,
    analysis,
    steps: steps.map((step, index) => ({
      id: `step_${index + 1}`,
      description: step.description,
      purpose: step.purpose,
      status: 'pending' as TaskStepStatus,
      checkpoint: step.checkpoint,
      alternativeApproach: step.alternativeApproach,
      maxRetries: 2,
      retryCount: 0
    })),
    currentStepIndex: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    adjustments: [],
    strategy: options?.strategy ?? 'default',
    riskAssessment: options?.riskAssessment,
    successCriteria: options?.successCriteria
  }
}

/**
 * 更新步骤状态（增强版）
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
  const step = updatedSteps[stepIndex]
  const now = Date.now()
  
  // 计算实际耗时
  let actualDuration = step.actualDuration
  if (step.startTime && (status === 'completed' || status === 'failed')) {
    actualDuration = Math.round((now - step.startTime) / 1000)
  }
  
  // 如果是失败状态，增加重试计数
  let retryCount = step.retryCount ?? 0
  if (status === 'failed') {
    retryCount++
  }
  
  updatedSteps[stepIndex] = {
    ...step,
    status,
    result,
    error,
    actualDuration,
    retryCount,
    startTime: status === 'in_progress' ? now : step.startTime
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
    updatedAt: now
  }
}

/**
 * 动态添加步骤
 */
export function addStep(
  plan: TaskPlan,
  step: { description: string; purpose: string; checkpoint?: boolean },
  position?: number,  // 插入位置，不传则追加到末尾
  reason?: string
): TaskPlan {
  const newStep: TaskStep = {
    id: `step_${Date.now()}_${Math.random().toString(36).substring(2, 4)}`,
    description: step.description,
    purpose: step.purpose,
    status: 'pending',
    checkpoint: step.checkpoint,
    maxRetries: 2,
    retryCount: 0
  }
  
  const updatedSteps = [...plan.steps]
  const insertPos = position ?? updatedSteps.length
  updatedSteps.splice(insertPos, 0, newStep)
  
  // 记录调整
  const adjustment: PlanAdjustment = {
    timestamp: Date.now(),
    type: 'add_step',
    reason: reason ?? '执行过程中发现需要额外步骤',
    details: `在位置 ${insertPos + 1} 添加步骤: ${step.description}`
  }
  
  return {
    ...plan,
    steps: updatedSteps,
    adjustments: [...(plan.adjustments ?? []), adjustment],
    updatedAt: Date.now()
  }
}

/**
 * 移除步骤
 */
export function removeStep(
  plan: TaskPlan,
  stepIndex: number,
  reason?: string
): TaskPlan {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    return plan
  }
  
  const removedStep = plan.steps[stepIndex]
  const updatedSteps = plan.steps.filter((_, i) => i !== stepIndex)
  
  // 调整当前步骤索引
  let newCurrentIndex = plan.currentStepIndex
  if (stepIndex < plan.currentStepIndex) {
    newCurrentIndex = Math.max(0, newCurrentIndex - 1)
  } else if (stepIndex === plan.currentStepIndex) {
    newCurrentIndex = Math.min(newCurrentIndex, updatedSteps.length - 1)
  }
  
  // 记录调整
  const adjustment: PlanAdjustment = {
    timestamp: Date.now(),
    type: 'remove_step',
    reason: reason ?? '步骤不再需要',
    details: `移除步骤 ${stepIndex + 1}: ${removedStep.description}`
  }
  
  return {
    ...plan,
    steps: updatedSteps,
    currentStepIndex: newCurrentIndex,
    adjustments: [...(plan.adjustments ?? []), adjustment],
    updatedAt: Date.now()
  }
}

/**
 * 修改步骤
 */
export function modifyStep(
  plan: TaskPlan,
  stepIndex: number,
  updates: Partial<Pick<TaskStep, 'description' | 'purpose' | 'alternativeApproach'>>,
  reason?: string
): TaskPlan {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    return plan
  }
  
  const updatedSteps = [...plan.steps]
  const originalStep = updatedSteps[stepIndex]
  updatedSteps[stepIndex] = {
    ...originalStep,
    ...updates
  }
  
  // 记录调整
  const adjustment: PlanAdjustment = {
    timestamp: Date.now(),
    type: 'modify_step',
    reason: reason ?? '根据执行情况调整步骤',
    details: `修改步骤 ${stepIndex + 1}: ${originalStep.description} -> ${updates.description ?? originalStep.description}`
  }
  
  return {
    ...plan,
    steps: updatedSteps,
    adjustments: [...(plan.adjustments ?? []), adjustment],
    updatedAt: Date.now()
  }
}

/**
 * 切换执行策略
 */
export function changeStrategy(
  plan: TaskPlan,
  newStrategy: ExecutionStrategy,
  reason: string
): TaskPlan {
  const adjustment: PlanAdjustment = {
    timestamp: Date.now(),
    type: 'change_strategy',
    reason,
    details: `策略从 ${plan.strategy ?? 'default'} 切换到 ${newStrategy}`
  }
  
  return {
    ...plan,
    strategy: newStrategy,
    adjustments: [...(plan.adjustments ?? []), adjustment],
    updatedAt: Date.now()
  }
}

/**
 * 重试失败的步骤
 */
export function retryStep(plan: TaskPlan, stepIndex: number): TaskPlan {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    return plan
  }
  
  const step = plan.steps[stepIndex]
  if (!canRetryStep(step)) {
    return plan
  }
  
  const updatedSteps = [...plan.steps]
  updatedSteps[stepIndex] = {
    ...step,
    status: 'pending',
    error: undefined,
    startTime: undefined
  }
  
  return {
    ...plan,
    steps: updatedSteps,
    currentStepIndex: stepIndex,
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
 * 任务规划管理器（增强版）
 */
export class TaskPlanner {
  private plans: Map<string, TaskPlan> = new Map()
  
  /**
   * 分析任务并决定是否需要规划
   */
  analyzeTask(task: string, context?: {
    previousFailures?: number
    isProduction?: boolean
  }): { 
    needsPlanning: boolean
    complexity: TaskComplexity
    prompt: string
    recommendedStrategy: StrategyRecommendation
  } {
    const complexity = analyzeTaskComplexity(task)
    const needsPlanning = complexity !== 'simple'
    const prompt = generatePlanningPrompt(task, complexity)
    const recommendedStrategy = recommendStrategy(task, context)
    
    return { needsPlanning, complexity, prompt, recommendedStrategy }
  }
  
  /**
   * 创建并保存计划
   */
  createPlan(
    task: string, 
    analysis: string, 
    steps: Array<{ description: string; purpose: string; checkpoint?: boolean; alternativeApproach?: string }>,
    options?: {
      strategy?: ExecutionStrategy
      riskAssessment?: string
      successCriteria?: string[]
    }
  ): TaskPlan {
    const plan = createTaskPlan(task, analysis, steps, options)
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
   * 动态添加步骤
   */
  addStep(
    planId: string,
    step: { description: string; purpose: string; checkpoint?: boolean },
    position?: number,
    reason?: string
  ): TaskPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    
    const updatedPlan = addStep(plan, step, position, reason)
    this.plans.set(planId, updatedPlan)
    return updatedPlan
  }
  
  /**
   * 移除步骤
   */
  removeStep(planId: string, stepIndex: number, reason?: string): TaskPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    
    const updatedPlan = removeStep(plan, stepIndex, reason)
    this.plans.set(planId, updatedPlan)
    return updatedPlan
  }
  
  /**
   * 修改步骤
   */
  modifyStep(
    planId: string,
    stepIndex: number,
    updates: Partial<Pick<TaskStep, 'description' | 'purpose' | 'alternativeApproach'>>,
    reason?: string
  ): TaskPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    
    const updatedPlan = modifyStep(plan, stepIndex, updates, reason)
    this.plans.set(planId, updatedPlan)
    return updatedPlan
  }
  
  /**
   * 切换执行策略
   */
  changeStrategy(planId: string, newStrategy: ExecutionStrategy, reason: string): TaskPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    
    const updatedPlan = changeStrategy(plan, newStrategy, reason)
    this.plans.set(planId, updatedPlan)
    return updatedPlan
  }
  
  /**
   * 重试失败的步骤
   */
  retryStep(planId: string, stepIndex: number): TaskPlan | undefined {
    const plan = this.plans.get(planId)
    if (!plan) return undefined
    
    const step = plan.steps[stepIndex]
    if (!step || !canRetryStep(step)) return undefined
    
    const updatedPlan = retryStep(plan, stepIndex)
    this.plans.set(planId, updatedPlan)
    return updatedPlan
  }
  
  /**
   * 获取步骤的备选方案
   */
  getStepAlternative(planId: string, stepIndex: number): string | undefined {
    const plan = this.plans.get(planId)
    if (!plan || stepIndex < 0 || stepIndex >= plan.steps.length) return undefined
    
    const step = plan.steps[stepIndex]
    return getAlternativeApproach(step, step.error)
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
   * 获取计划调整历史
   */
  getAdjustments(planId: string): PlanAdjustment[] {
    const plan = this.plans.get(planId)
    return plan?.adjustments ?? []
  }
  
  /**
   * 评估计划执行状态
   */
  evaluatePlanStatus(planId: string): {
    overallStatus: 'on_track' | 'at_risk' | 'blocked' | 'completed'
    blockedSteps: number[]
    retriableSteps: number[]
    suggestions: string[]
  } {
    const plan = this.plans.get(planId)
    if (!plan) {
      return {
        overallStatus: 'blocked',
        blockedSteps: [],
        retriableSteps: [],
        suggestions: ['计划不存在']
      }
    }
    
    const blockedSteps: number[] = []
    const retriableSteps: number[] = []
    const suggestions: string[] = []
    
    plan.steps.forEach((step, index) => {
      if (step.status === 'blocked') {
        blockedSteps.push(index)
      }
      if (canRetryStep(step)) {
        retriableSteps.push(index)
        suggestions.push(`步骤 ${index + 1} 可以重试`)
      }
    })
    
    // 判断整体状态
    let overallStatus: 'on_track' | 'at_risk' | 'blocked' | 'completed' = 'on_track'
    
    if (isPlanComplete(plan)) {
      overallStatus = 'completed'
    } else if (blockedSteps.length > 0) {
      overallStatus = 'blocked'
      suggestions.push('存在被阻塞的步骤，需要人工介入或更换方案')
    } else if (isPlanFailed(plan) && retriableSteps.length === 0) {
      overallStatus = 'blocked'
      suggestions.push('计划执行失败且无法重试')
    } else if (isPlanFailed(plan)) {
      overallStatus = 'at_risk'
      suggestions.push('部分步骤失败，但可以重试')
    }
    
    return { overallStatus, blockedSteps, retriableSteps, suggestions }
  }
  
  /**
   * 清理计划
   */
  cleanup(planId: string): void {
    this.plans.delete(planId)
  }
}

