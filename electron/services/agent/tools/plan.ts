/**
 * 计划/待办工具
 * 包括：创建计划、更新计划、清除计划
 */
import { t } from '../i18n'
import type { ToolExecutorConfig, ToolResult, AgentPlan } from './types'
import type { PlanStepStatus } from '../types'

/**
 * 生成唯一计划 ID
 */
function generatePlanId(): string {
  return `plan_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
}

/**
 * 检查计划是否已完成
 */
function isPlanFinished(plan: AgentPlan): boolean {
  return plan.steps.every(s => 
    s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  )
}

/**
 * 创建任务执行计划
 */
export function createPlan(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const title = args.title as string
  const stepsRaw = args.steps as Array<{ title: string; description?: string } | string>
  
  if (!title || typeof title !== 'string') {
    return { success: false, output: '', error: t('error.plan_title_required') }
  }
  
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    return { success: false, output: '', error: t('error.plan_steps_required') }
  }
  
  if (stepsRaw.length > 10) {
    return { success: false, output: '', error: t('error.plan_steps_max') }
  }
  
  // 标准化步骤格式：支持字符串数组或对象数组
  const stepsInput = stepsRaw.map((step, index) => {
    // 如果是字符串，转换为对象格式
    if (typeof step === 'string') {
      return { title: step, description: undefined }
    }
    // 如果是对象但没有 title，尝试用其他字段
    if (!step.title) {
      return { 
        title: step.description || `步骤 ${index + 1}`, 
        description: step.description 
      }
    }
    return step
  })
  
  const existingPlan = executor.getCurrentPlan()
  if (existingPlan) {
    if (isPlanFinished(existingPlan)) {
      const completedCount = existingPlan.steps.filter(s => s.status === 'completed').length
      const failedCount = existingPlan.steps.filter(s => s.status === 'failed').length
      const totalCount = existingPlan.steps.length
      const statusParts = [`${completedCount}/${totalCount} ${t('plan.status_completed')}`]
      if (failedCount > 0) statusParts.push(`${failedCount} ${t('plan.status_failed')}`)
      const statusSummary = statusParts.join(', ')
      
      executor.addStep({
        type: 'plan_archived',
        content: `${existingPlan.title} (${statusSummary})`,
        toolName: 'create_plan',
        plan: { ...existingPlan },
        riskLevel: 'safe'
      })
      
      executor.setCurrentPlan(undefined)
    } else {
      return { 
        success: false, 
        output: '', 
        error: t('error.plan_exists_use_clear', { title: existingPlan.title }) 
      }
    }
  }
  
  const now = Date.now()
  const plan: AgentPlan = {
    id: generatePlanId(),
    title,
    steps: stepsInput.map((step, index) => ({
      id: `step_${index}`,
      title: step.title,
      description: step.description,
      status: 'pending' as PlanStepStatus
    })),
    createdAt: now,
    updatedAt: now
  }
  
  executor.setCurrentPlan(plan)
  
  executor.addStep({
    type: 'plan_created',
    content: `${t('plan.create')}: ${title}`,
    toolName: 'create_plan',
    toolArgs: { title, steps: stepsInput.length },
    plan: plan,
    riskLevel: 'safe'
  })
  
  const stepsList = plan.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
  const output = `${t('plan.created', { title })}\n\n${t('plan.created_steps')}:\n${stepsList}\n\n${t('plan.created_hint')}`
  
  return { success: true, output }
}

/**
 * 更新计划步骤状态
 */
export function updatePlan(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const stepIndex = args.step_index as number
  const status = args.status as PlanStepStatus
  const result = args.result as string | undefined
  
  if (typeof stepIndex !== 'number' || stepIndex < 0) {
    return { success: false, output: '', error: t('error.step_index_positive') }
  }
  
  const validStatuses: PlanStepStatus[] = ['pending', 'in_progress', 'completed', 'failed', 'skipped']
  if (!validStatuses.includes(status)) {
    return { success: false, output: '', error: t('error.invalid_plan_status', { statuses: validStatuses.join(', ') }) }
  }
  
  const plan = executor.getCurrentPlan()
  if (!plan) {
    return { success: false, output: '', error: t('error.no_active_plan') }
  }
  
  if (stepIndex >= plan.steps.length) {
    return { success: false, output: '', error: t('error.step_index_out_of_range', { count: plan.steps.length, max: plan.steps.length - 1 }) }
  }
  
  const step = plan.steps[stepIndex]
  step.status = status
  step.result = result
  
  const now = Date.now()
  if (status === 'in_progress' && !step.startedAt) {
    step.startedAt = now
  }
  if (status === 'completed' || status === 'failed' || status === 'skipped') {
    step.completedAt = now
  }
  
  plan.updatedAt = now
  executor.setCurrentPlan(plan)
  
  const statusIcons: Record<PlanStepStatus, string> = {
    pending: '○',
    in_progress: '●',
    completed: '✓',
    failed: '✗',
    skipped: '–'
  }
  
  const stepInfo = `${t('plan.step_prefix', { index: stepIndex + 1 })}: ${step.title}`
  const statusText = `${statusIcons[status]} ${status}`
  const resultText = result ? ` - ${result}` : ''
  
  executor.addStep({
    type: 'plan_updated',
    content: `${stepInfo} → ${statusText}${resultText}`,
    toolName: 'update_plan',
    toolArgs: { step_index: stepIndex, status, result },
    plan: plan,
    riskLevel: 'safe'
  })
  
  const completedCount = plan.steps.filter(s => s.status === 'completed').length
  const totalCount = plan.steps.length
  const progressPercent = Math.round((completedCount / totalCount) * 100)
  
  const allDone = plan.steps.every(s => 
    s.status === 'completed' || s.status === 'failed' || s.status === 'skipped'
  )
  
  let output = t('plan.updated', { step: stepInfo, status })
  if (result) output += `\n${t('plan.result', { result })}`
  output += `\n\n${t('plan.progress', { completed: completedCount, total: totalCount, percent: progressPercent })}`
  
  if (allDone) {
    const failedCount = plan.steps.filter(s => s.status === 'failed').length
    if (failedCount > 0) {
      output += `\n\n⚠️ ${t('plan.complete_with_failures', { count: failedCount })}`
    } else {
      output += `\n\n✅ ${t('plan.complete_success')}`
    }
    output += `\n\n💡 ${t('plan.complete_hint')}`
  } else {
    const nextPendingIndex = plan.steps.findIndex(s => s.status === 'pending')
    if (nextPendingIndex !== -1) {
      output += `\n\n${t('plan.next_step', { index: nextPendingIndex + 1, title: plan.steps[nextPendingIndex].title })}`
    }
  }
  
  return { success: true, output }
}

/**
 * 归档当前计划
 */
export function clearPlan(
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): ToolResult {
  const reason = args.reason as string | undefined
  
  const plan = executor.getCurrentPlan()
  if (!plan) {
    return { success: true, output: t('plan.no_active_plan_to_clear') }
  }
  
  const completedCount = plan.steps.filter(s => s.status === 'completed').length
  const failedCount = plan.steps.filter(s => s.status === 'failed').length
  const skippedCount = plan.steps.filter(s => s.status === 'skipped').length
  const totalCount = plan.steps.length
  const progressPercent = Math.round((completedCount / totalCount) * 100)
  
  const statusParts = [`${completedCount}/${totalCount} ${t('plan.status_completed')}`]
  if (failedCount > 0) statusParts.push(`${failedCount} ${t('plan.status_failed')}`)
  if (skippedCount > 0) statusParts.push(`${skippedCount} ${t('plan.status_skipped')}`)
  const statusSummary = statusParts.join(', ')
  const reasonText = reason ? ` - ${reason}` : ''
  
  executor.addStep({
    type: 'plan_archived',
    content: `${plan.title} (${statusSummary})${reasonText}`,
    toolName: 'clear_plan',
    toolArgs: { reason },
    plan: { ...plan },
    riskLevel: 'safe'
  })
  
  executor.setCurrentPlan(undefined)
  
  let output = `${t('plan.archived', { title: plan.title })}\n${t('plan.archived_progress', { percent: progressPercent, summary: statusSummary })}`
  if (reason) output += `\n${t('plan.archived_reason', { reason })}`
  output += `\n\n${t('plan.archived_hint')}`
  
  return { success: true, output }
}
