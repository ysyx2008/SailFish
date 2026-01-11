/**
 * planner.ts 单元测试
 * 测试任务规划器的所有纯函数
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  analyzeTaskComplexity,
  generatePlanningPrompt,
  recommendStrategy,
  canRetryStep,
  getAlternativeApproach,
  createTaskPlan,
  updateStepStatus,
  addStep,
  removeStep,
  modifyStep,
  changeStrategy,
  retryStep,
  getPlanProgress,
  formatPlanAsText,
  isPlanComplete,
  isPlanFailed,
  TaskPlanner,
  type TaskPlan,
  type TaskStep
} from '../planner'

// ==================== analyzeTaskComplexity ====================

describe('analyzeTaskComplexity', () => {
  describe('complex tasks', () => {
    it.each([
      ['排查 nginx 服务无法启动的原因', 'troubleshooting'],
      ['诊断 MySQL 连接超时问题', 'diagnosis'],
      ['分析为什么服务器响应慢', 'analysis'],
      ['部署 Redis 集群并配置主从同步', 'deployment'],
      ['安装 Docker 并配置环境', 'installation'],
      ['搭建 Kubernetes 环境', 'setup'],
      ['迁移数据库到新服务器', 'migration'],
      ['备份并恢复 PostgreSQL', 'backup recovery'],
      ['升级系统内核', 'upgrade'],
      ['监控服务器性能', 'monitoring'],
      ['告警配置', 'alerting'],
      ['性能优化', 'optimization'],
      ['自动化部署脚本', 'automation'],
      ['批量处理所有服务', 'batch processing'],
      ['重启所有服务', 'all services'],
    ])('should detect complex task: %s (%s)', (task) => {
      expect(analyzeTaskComplexity(task)).toBe('complex')
    })
  })

  describe('moderate tasks', () => {
    it.each([
      ['配置 nginx 反向代理', 'config'],
      ['修改数据库配置文件', 'modify file'],
      ['查看日志并分析错误', 'view and analyze'],
      ['创建新用户', 'create'],
      ['设置防火墙规则', 'setup'],
      ['检查服务状态', 'check status'],
    ])('should detect moderate task: %s (%s)', (task) => {
      expect(analyzeTaskComplexity(task)).toBe('moderate')
    })

    it('should detect long tasks as moderate', () => {
      const longTask = 'a'.repeat(101)
      expect(analyzeTaskComplexity(longTask)).toBe('moderate')
    })
  })

  describe('simple tasks', () => {
    it.each([
      ['查看当前目录', 'view'],
      ['显示文件列表', 'display'],
      ['ls -la', 'command'],
      ['pwd', 'simple command'],
      ['whoami 是什么', 'what is'],
      ['执行 npm install', 'execute command'],
      ['运行测试命令', 'run command'],
    ])('should detect simple task: %s (%s)', (task) => {
      expect(analyzeTaskComplexity(task)).toBe('simple')
    })
  })
})

// ==================== generatePlanningPrompt ====================

describe('generatePlanningPrompt', () => {
  it('should return empty string for simple tasks', () => {
    const prompt = generatePlanningPrompt('查看文件', 'simple')
    expect(prompt).toBe('')
  })

  it('should return short prompt for moderate tasks', () => {
    const prompt = generatePlanningPrompt('配置 nginx', 'moderate')
    expect(prompt).toContain('任务规划')
    expect(prompt.length).toBeLessThan(300)
  })

  it('should return detailed prompt for complex tasks', () => {
    const prompt = generatePlanningPrompt('排查问题', 'complex')
    expect(prompt).toContain('复杂任务规划')
    expect(prompt).toContain('任务分析')
    expect(prompt).toContain('执行计划')
    expect(prompt).toContain('动态调整')
  })
})

// ==================== recommendStrategy ====================

describe('recommendStrategy', () => {
  it('should recommend diagnostic strategy for troubleshooting', () => {
    const result = recommendStrategy('诊断为什么服务挂了')
    expect(result.strategy).toBe('diagnostic')
    expect(result.confidence).toBeGreaterThan(0.8)
  })

  it('should recommend diagnostic for analysis tasks', () => {
    const result = recommendStrategy('排查网络问题的原因')
    expect(result.strategy).toBe('diagnostic')
  })

  it('should recommend conservative for production', () => {
    const result = recommendStrategy('更新配置', { isProduction: true })
    expect(result.strategy).toBe('conservative')
    expect(result.confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('should recommend conservative when mentioning production', () => {
    const result = recommendStrategy('更新生产环境配置')
    expect(result.strategy).toBe('conservative')
  })

  it('should recommend conservative with previous failures', () => {
    const result = recommendStrategy('安装软件', { previousFailures: 3 })
    expect(result.strategy).toBe('conservative')
  })

  it('should recommend aggressive for urgent tasks', () => {
    const result = recommendStrategy('紧急修复服务')
    expect(result.strategy).toBe('aggressive')
  })

  it('should recommend aggressive for immediate tasks', () => {
    const result = recommendStrategy('立即重启服务')
    expect(result.strategy).toBe('aggressive')
  })

  it('should recommend default for normal tasks', () => {
    const result = recommendStrategy('安装 nginx')
    expect(result.strategy).toBe('default')
  })
})

// ==================== canRetryStep ====================

describe('canRetryStep', () => {
  it('should allow retry when under max retries', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test step',
      purpose: 'Testing',
      status: 'failed',
      retryCount: 1,
      maxRetries: 2
    }
    expect(canRetryStep(step)).toBe(true)
  })

  it('should not allow retry when at max retries', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test step',
      purpose: 'Testing',
      status: 'failed',
      retryCount: 2,
      maxRetries: 2
    }
    expect(canRetryStep(step)).toBe(false)
  })

  it('should not allow retry for non-failed steps', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test step',
      purpose: 'Testing',
      status: 'completed',
      retryCount: 0,
      maxRetries: 2
    }
    expect(canRetryStep(step)).toBe(false)
  })

  it('should use default maxRetries of 2', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test step',
      purpose: 'Testing',
      status: 'failed',
      retryCount: 1
    }
    expect(canRetryStep(step)).toBe(true)
  })
})

// ==================== getAlternativeApproach ====================

describe('getAlternativeApproach', () => {
  it('should return existing alternative if defined', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test',
      purpose: 'Testing',
      status: 'failed',
      alternativeApproach: '使用备选方案'
    }
    expect(getAlternativeApproach(step)).toBe('使用备选方案')
  })

  it('should suggest sudo for permission denied', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test',
      purpose: 'Testing',
      status: 'failed'
    }
    const result = getAlternativeApproach(step, 'Permission denied')
    expect(result).toContain('sudo')
  })

  it('should suggest checking path for not found', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test',
      purpose: 'Testing',
      status: 'failed'
    }
    const result = getAlternativeApproach(step, 'File not found')
    expect(result).toContain('路径')
  })

  it('should suggest timeout handling', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test',
      purpose: 'Testing',
      status: 'failed'
    }
    const result = getAlternativeApproach(step, 'Connection timeout')
    expect(result).toContain('超时')
  })

  it('should suggest connection check', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test',
      purpose: 'Testing',
      status: 'failed'
    }
    const result = getAlternativeApproach(step, 'Connection refused')
    expect(result).toContain('连接')
  })

  it('should return default suggestion without error', () => {
    const step: TaskStep = {
      id: 'step_1',
      description: 'Test',
      purpose: 'Testing',
      status: 'failed'
    }
    const result = getAlternativeApproach(step)
    expect(result).toContain('换一种方法')
  })
})

// ==================== createTaskPlan ====================

describe('createTaskPlan', () => {
  it('should create plan with correct structure', () => {
    const plan = createTaskPlan('安装 nginx', '需要安装和配置', [
      { description: '安装软件包', purpose: '获取软件' },
      { description: '配置', purpose: '设置参数' }
    ])

    expect(plan.id).toMatch(/^plan_\d+_\w+$/)
    expect(plan.originalTask).toBe('安装 nginx')
    expect(plan.analysis).toBe('需要安装和配置')
    expect(plan.steps).toHaveLength(2)
    expect(plan.currentStepIndex).toBe(0)
    expect(plan.createdAt).toBeDefined()
    expect(plan.updatedAt).toBeDefined()
  })

  it('should set steps with correct initial state', () => {
    const plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: 'Purpose 1' }
    ])

    expect(plan.steps[0].id).toBe('step_1')
    expect(plan.steps[0].status).toBe('pending')
    expect(plan.steps[0].maxRetries).toBe(2)
    expect(plan.steps[0].retryCount).toBe(0)
  })

  it('should preserve checkpoint and alternativeApproach', () => {
    const plan = createTaskPlan('test', '', [
      { 
        description: 'Important step', 
        purpose: 'Critical', 
        checkpoint: true,
        alternativeApproach: '备选方案'
      }
    ])

    expect(plan.steps[0].checkpoint).toBe(true)
    expect(plan.steps[0].alternativeApproach).toBe('备选方案')
  })

  it('should accept options', () => {
    const plan = createTaskPlan('test', '', [], {
      strategy: 'conservative',
      riskAssessment: '低风险',
      successCriteria: ['服务正常', '无错误']
    })

    expect(plan.strategy).toBe('conservative')
    expect(plan.riskAssessment).toBe('低风险')
    expect(plan.successCriteria).toEqual(['服务正常', '无错误'])
  })
})

// ==================== updateStepStatus ====================

describe('updateStepStatus', () => {
  let plan: TaskPlan

  beforeEach(() => {
    plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' },
      { description: 'Step 2', purpose: '' },
      { description: 'Step 3', purpose: '' }
    ])
  })

  it('should update step status', () => {
    const updated = updateStepStatus(plan, 0, 'in_progress')
    expect(updated.steps[0].status).toBe('in_progress')
    expect(updated.steps[0].startTime).toBeDefined()
  })

  it('should record result on completion', () => {
    const updated = updateStepStatus(plan, 0, 'completed', '执行成功')
    expect(updated.steps[0].status).toBe('completed')
    expect(updated.steps[0].result).toBe('执行成功')
  })

  it('should record error on failure', () => {
    const updated = updateStepStatus(plan, 0, 'failed', undefined, '命令失败')
    expect(updated.steps[0].status).toBe('failed')
    expect(updated.steps[0].error).toBe('命令失败')
  })

  it('should increment retry count on failure', () => {
    const updated = updateStepStatus(plan, 0, 'failed')
    expect(updated.steps[0].retryCount).toBe(1)
  })

  it('should move to next step on completion', () => {
    const updated = updateStepStatus(plan, 0, 'completed')
    expect(updated.currentStepIndex).toBe(1)
  })

  it('should not move past last step', () => {
    let updated = updateStepStatus(plan, 0, 'completed')
    updated = updateStepStatus(updated, 1, 'completed')
    updated = updateStepStatus(updated, 2, 'completed')
    expect(updated.currentStepIndex).toBe(2)
  })

  it('should return original plan for invalid index', () => {
    const updated = updateStepStatus(plan, -1, 'completed')
    expect(updated).toBe(plan)

    const updated2 = updateStepStatus(plan, 99, 'completed')
    expect(updated2).toBe(plan)
  })

  it('should calculate actual duration', () => {
    let updated = updateStepStatus(plan, 0, 'in_progress')
    // Simulate some time passing
    updated.steps[0].startTime = Date.now() - 5000
    updated = updateStepStatus(updated, 0, 'completed')
    expect(updated.steps[0].actualDuration).toBeGreaterThanOrEqual(4)
  })
})

// ==================== addStep ====================

describe('addStep', () => {
  let plan: TaskPlan

  beforeEach(() => {
    plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' }
    ])
  })

  it('should add step at end by default', () => {
    const updated = addStep(plan, { description: 'Step 2', purpose: 'New' })
    expect(updated.steps).toHaveLength(2)
    expect(updated.steps[1].description).toBe('Step 2')
  })

  it('should add step at specified position', () => {
    const updated = addStep(plan, { description: 'New Step', purpose: '' }, 0)
    expect(updated.steps[0].description).toBe('New Step')
    expect(updated.steps[1].description).toBe('Step 1')
  })

  it('should record adjustment', () => {
    const updated = addStep(plan, { description: 'New', purpose: '' }, undefined, '需要额外步骤')
    expect(updated.adjustments).toHaveLength(1)
    expect(updated.adjustments![0].type).toBe('add_step')
    expect(updated.adjustments![0].reason).toBe('需要额外步骤')
  })
})

// ==================== removeStep ====================

describe('removeStep', () => {
  let plan: TaskPlan

  beforeEach(() => {
    plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' },
      { description: 'Step 2', purpose: '' },
      { description: 'Step 3', purpose: '' }
    ])
  })

  it('should remove step at index', () => {
    const updated = removeStep(plan, 1)
    expect(updated.steps).toHaveLength(2)
    expect(updated.steps[0].description).toBe('Step 1')
    expect(updated.steps[1].description).toBe('Step 3')
  })

  it('should adjust currentStepIndex when removing before current', () => {
    plan.currentStepIndex = 2
    const updated = removeStep(plan, 0)
    expect(updated.currentStepIndex).toBe(1)
  })

  it('should record adjustment with reason', () => {
    const updated = removeStep(plan, 0, '步骤不需要了')
    expect(updated.adjustments![0].reason).toBe('步骤不需要了')
  })

  it('should return original plan for invalid index', () => {
    expect(removeStep(plan, -1)).toBe(plan)
    expect(removeStep(plan, 99)).toBe(plan)
  })
})

// ==================== modifyStep ====================

describe('modifyStep', () => {
  let plan: TaskPlan

  beforeEach(() => {
    plan = createTaskPlan('test', '', [
      { description: 'Original', purpose: 'Original purpose' }
    ])
  })

  it('should modify step description', () => {
    const updated = modifyStep(plan, 0, { description: 'Modified' })
    expect(updated.steps[0].description).toBe('Modified')
  })

  it('should modify step purpose', () => {
    const updated = modifyStep(plan, 0, { purpose: 'New purpose' })
    expect(updated.steps[0].purpose).toBe('New purpose')
  })

  it('should add alternativeApproach', () => {
    const updated = modifyStep(plan, 0, { alternativeApproach: '备选' })
    expect(updated.steps[0].alternativeApproach).toBe('备选')
  })

  it('should record adjustment', () => {
    const updated = modifyStep(plan, 0, { description: 'New' }, '优化步骤')
    expect(updated.adjustments![0].type).toBe('modify_step')
    expect(updated.adjustments![0].reason).toBe('优化步骤')
  })

  it('should return original plan for invalid index', () => {
    expect(modifyStep(plan, -1, { description: 'test' })).toBe(plan)
  })
})

// ==================== changeStrategy ====================

describe('changeStrategy', () => {
  it('should change strategy', () => {
    const plan = createTaskPlan('test', '', [])
    const updated = changeStrategy(plan, 'conservative', '风险较高')
    expect(updated.strategy).toBe('conservative')
  })

  it('should record adjustment', () => {
    const plan = createTaskPlan('test', '', [], { strategy: 'default' })
    const updated = changeStrategy(plan, 'aggressive', '紧急任务')
    expect(updated.adjustments![0].type).toBe('change_strategy')
    expect(updated.adjustments![0].details).toContain('default')
    expect(updated.adjustments![0].details).toContain('aggressive')
  })
})

// ==================== retryStep ====================

describe('retryStep', () => {
  it('should reset step for retry', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' }
    ])
    plan = updateStepStatus(plan, 0, 'failed', undefined, 'Error')
    
    const updated = retryStep(plan, 0)
    expect(updated.steps[0].status).toBe('pending')
    expect(updated.steps[0].error).toBeUndefined()
    expect(updated.currentStepIndex).toBe(0)
  })

  it('should not retry if max retries exceeded', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' }
    ])
    // Fail 3 times (exceeds default maxRetries of 2)
    plan = updateStepStatus(plan, 0, 'failed')
    plan = updateStepStatus(plan, 0, 'failed')
    plan = updateStepStatus(plan, 0, 'failed')
    
    const updated = retryStep(plan, 0)
    expect(updated).toBe(plan) // Should return unchanged
  })

  it('should return original plan for invalid index', () => {
    const plan = createTaskPlan('test', '', [])
    expect(retryStep(plan, 0)).toBe(plan)
  })
})

// ==================== getPlanProgress ====================

describe('getPlanProgress', () => {
  it('should calculate progress correctly', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' },
      { description: 'Step 2', purpose: '' },
      { description: 'Step 3', purpose: '' },
      { description: 'Step 4', purpose: '' }
    ])
    
    plan = updateStepStatus(plan, 0, 'completed')
    plan = updateStepStatus(plan, 1, 'completed')
    
    const progress = getPlanProgress(plan)
    expect(progress.completed).toBe(2)
    expect(progress.total).toBe(4)
    expect(progress.percentage).toBe(50)
    expect(progress.currentStep?.description).toBe('Step 3')
  })

  it('should handle empty plan', () => {
    const plan = createTaskPlan('test', '', [])
    const progress = getPlanProgress(plan)
    expect(progress.completed).toBe(0)
    expect(progress.total).toBe(0)
    expect(progress.percentage).toBe(0)
    expect(progress.currentStep).toBeNull()
  })
})

// ==================== formatPlanAsText ====================

describe('formatPlanAsText', () => {
  it('should format plan with status icons', () => {
    let plan = createTaskPlan('安装软件', '需要安装', [
      { description: '下载', purpose: '' },
      { description: '安装', purpose: '' },
      { description: '配置', purpose: '' }
    ])
    
    plan = updateStepStatus(plan, 0, 'completed', '下载完成')
    plan = updateStepStatus(plan, 1, 'in_progress')
    
    const text = formatPlanAsText(plan)
    expect(text).toContain('任务计划')
    expect(text).toContain('安装软件')
    expect(text).toContain('✅')  // completed
    expect(text).toContain('🔄')  // in_progress
    expect(text).toContain('⏳')  // pending
    expect(text).toContain('👈 当前')
  })

  it('should include analysis if present', () => {
    const plan = createTaskPlan('test', '详细分析内容', [])
    const text = formatPlanAsText(plan)
    expect(text).toContain('分析')
    expect(text).toContain('详细分析内容')
  })
})

// ==================== isPlanComplete ====================

describe('isPlanComplete', () => {
  it('should return true when all steps completed', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' },
      { description: 'Step 2', purpose: '' }
    ])
    
    plan = updateStepStatus(plan, 0, 'completed')
    plan = updateStepStatus(plan, 1, 'completed')
    
    expect(isPlanComplete(plan)).toBe(true)
  })

  it('should return true when all steps completed or skipped', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' },
      { description: 'Step 2', purpose: '' }
    ])
    
    plan = updateStepStatus(plan, 0, 'completed')
    plan = updateStepStatus(plan, 1, 'skipped')
    
    expect(isPlanComplete(plan)).toBe(true)
  })

  it('should return false when steps pending', () => {
    const plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' }
    ])
    
    expect(isPlanComplete(plan)).toBe(false)
  })
})

// ==================== isPlanFailed ====================

describe('isPlanFailed', () => {
  it('should return true when any step failed', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' },
      { description: 'Step 2', purpose: '' }
    ])
    
    plan = updateStepStatus(plan, 0, 'completed')
    plan = updateStepStatus(plan, 1, 'failed')
    
    expect(isPlanFailed(plan)).toBe(true)
  })

  it('should return false when no steps failed', () => {
    let plan = createTaskPlan('test', '', [
      { description: 'Step 1', purpose: '' }
    ])
    
    plan = updateStepStatus(plan, 0, 'completed')
    
    expect(isPlanFailed(plan)).toBe(false)
  })
})

// ==================== TaskPlanner class ====================

describe('TaskPlanner', () => {
  let planner: TaskPlanner

  beforeEach(() => {
    planner = new TaskPlanner()
  })

  describe('analyzeTask', () => {
    it('should analyze task complexity and recommend strategy', () => {
      const result = planner.analyzeTask('排查 nginx 问题')
      expect(result.complexity).toBe('complex')
      expect(result.needsPlanning).toBe(true)
      expect(result.recommendedStrategy.strategy).toBe('diagnostic')
      expect(result.prompt).not.toBe('')
    })

    it('should not need planning for simple tasks', () => {
      const result = planner.analyzeTask('ls -la')
      expect(result.complexity).toBe('simple')
      expect(result.needsPlanning).toBe(false)
      expect(result.prompt).toBe('')
    })
  })

  describe('createPlan', () => {
    it('should create and store plan', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' }
      ])
      
      expect(planner.getPlan(plan.id)).toBeDefined()
    })
  })

  describe('updateStep', () => {
    it('should update step and return updated plan', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' }
      ])
      
      const updated = planner.updateStep(plan.id, 0, 'completed', 'Done')
      expect(updated?.steps[0].status).toBe('completed')
    })

    it('should return undefined for non-existent plan', () => {
      expect(planner.updateStep('non-existent', 0, 'completed')).toBeUndefined()
    })
  })

  describe('addStep', () => {
    it('should add step to existing plan', () => {
      const plan = planner.createPlan('test', '', [])
      const updated = planner.addStep(plan.id, { description: 'New', purpose: '' })
      expect(updated?.steps).toHaveLength(1)
    })
  })

  describe('removeStep', () => {
    it('should remove step from plan', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' },
        { description: 'Step 2', purpose: '' }
      ])
      
      const updated = planner.removeStep(plan.id, 0)
      expect(updated?.steps).toHaveLength(1)
    })
  })

  describe('modifyStep', () => {
    it('should modify step in plan', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Original', purpose: '' }
      ])
      
      const updated = planner.modifyStep(plan.id, 0, { description: 'Modified' })
      expect(updated?.steps[0].description).toBe('Modified')
    })
  })

  describe('changeStrategy', () => {
    it('should change plan strategy', () => {
      const plan = planner.createPlan('test', '', [])
      const updated = planner.changeStrategy(plan.id, 'aggressive', 'Urgent')
      expect(updated?.strategy).toBe('aggressive')
    })
  })

  describe('retryStep', () => {
    it('should retry failed step', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' }
      ])
      
      planner.updateStep(plan.id, 0, 'failed')
      const updated = planner.retryStep(plan.id, 0)
      expect(updated?.steps[0].status).toBe('pending')
    })
  })

  describe('getStepAlternative', () => {
    it('should return alternative for step', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' }
      ])
      
      planner.updateStep(plan.id, 0, 'failed', undefined, 'Permission denied')
      const alternative = planner.getStepAlternative(plan.id, 0)
      expect(alternative).toContain('sudo')
    })
  })

  describe('getProgress', () => {
    it('should return plan progress', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' },
        { description: 'Step 2', purpose: '' }
      ])
      
      planner.updateStep(plan.id, 0, 'completed')
      const progress = planner.getProgress(plan.id)
      expect(progress?.percentage).toBe(50)
    })

    it('should return null for non-existent plan', () => {
      expect(planner.getProgress('non-existent')).toBeNull()
    })
  })

  describe('getAdjustments', () => {
    it('should return plan adjustments', () => {
      const plan = planner.createPlan('test', '', [])
      planner.addStep(plan.id, { description: 'New', purpose: '' })
      
      const adjustments = planner.getAdjustments(plan.id)
      expect(adjustments).toHaveLength(1)
    })
  })

  describe('evaluatePlanStatus', () => {
    it('should evaluate completed plan', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' }
      ])
      
      planner.updateStep(plan.id, 0, 'completed')
      const status = planner.evaluatePlanStatus(plan.id)
      expect(status.overallStatus).toBe('completed')
    })

    it('should evaluate at-risk plan', () => {
      const plan = planner.createPlan('test', '', [
        { description: 'Step 1', purpose: '' },
        { description: 'Step 2', purpose: '' }
      ])
      
      planner.updateStep(plan.id, 0, 'failed')
      const status = planner.evaluatePlanStatus(plan.id)
      expect(status.overallStatus).toBe('at_risk')
      expect(status.retriableSteps).toContain(0)
    })
  })

  describe('cleanup', () => {
    it('should remove plan', () => {
      const plan = planner.createPlan('test', '', [])
      planner.cleanup(plan.id)
      expect(planner.getPlan(plan.id)).toBeUndefined()
    })
  })
})
