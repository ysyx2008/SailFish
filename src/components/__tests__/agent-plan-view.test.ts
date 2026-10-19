/**
 * @vitest-environment jsdom
 */
/**
 * 计划卡片：计划暂停后要在界面上看得见。
 * 暂停时卡在「进行中」的那一步不再转圈、不再高亮，卡片标出「已暂停」；恢复后回到正常样子。
 */
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPlan, AgentPlanStep, PlanStepStatus } from '@shared/types'
import zhCN from '../../i18n/locales/zh-CN'
import enUS from '../../i18n/locales/en-US'
import AgentPlanView from '../AgentPlanView.vue'

const mounted: Array<() => void> = []

function step(index: number, status: PlanStepStatus, extra: Partial<AgentPlanStep> = {}): AgentPlanStep {
  return { id: `step_${index}`, title: `第 ${index + 1} 步`, status, ...extra }
}

function makePlan(statuses: PlanStepStatus[], paused?: boolean, stepExtra: Partial<AgentPlanStep> = {}): AgentPlan {
  return {
    id: 'plan_1',
    title: '评审项目',
    steps: statuses.map((status, i) => step(i, status, status === 'in_progress' ? stepExtra : {})),
    paused,
    createdAt: 1,
    updatedAt: 1,
  }
}

function renderPlan(plan: AgentPlan, opts: { compact?: boolean; locale?: 'zh-CN' | 'en-US' } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = reactive<{ plan: AgentPlan }>({ plan })
  const app = createApp({
    render: () => h(AgentPlanView, { plan: state.plan, compact: opts.compact ?? false }),
  })
  app.use(createI18n({
    legacy: false,
    locale: opts.locale ?? 'zh-CN',
    messages: { 'zh-CN': zhCN, 'en-US': enUS },
  }))
  app.mount(host)
  mounted.push(() => { app.unmount(); host.remove() })
  return { host, state }
}

afterEach(() => {
  while (mounted.length) mounted.pop()!()
})

describe('AgentPlanView 暂停显示（展开）', () => {
  it('没暂停：进行中的那一步转圈，没有「已暂停」', () => {
    const { host } = renderPlan(makePlan(['completed', 'in_progress', 'pending']))
    expect(host.querySelector('.step-spinner')).not.toBeNull()
    expect(host.querySelector('.paused-badge')).toBeNull()
    expect(host.querySelector('.is-paused')).toBeNull()
    expect(host.querySelector('.top-progress-bar.paused')).toBeNull()
  })

  it('暂停后：标出「已暂停」，卡在进行中的那一步不再转圈', () => {
    const { host } = renderPlan(makePlan(['completed', 'in_progress', 'pending'], true))
    expect(host.querySelector('.paused-badge')?.textContent).toContain('已暂停')
    expect(host.querySelector('.step-spinner')).toBeNull()
    expect(host.querySelector('.step-icon.paused')).not.toBeNull()
    expect(host.querySelector('.plan-step.in_progress.paused')).not.toBeNull()
    expect(host.querySelector('.top-progress-bar.paused')).not.toBeNull()
    expect(host.querySelector('.agent-plan.is-paused')).not.toBeNull()
  })

  it('暂停后：那一步里还在动的小进度条也收起来', () => {
    const progress = { value: 40, isIndeterminate: true, statusText: '处理中' }
    const running = renderPlan(makePlan(['in_progress', 'pending'], false, { progress }))
    expect(running.host.querySelector('.step-progress')).not.toBeNull()

    const paused = renderPlan(makePlan(['in_progress', 'pending'], true, { progress }))
    expect(paused.host.querySelector('.step-progress')).toBeNull()
  })

  it('恢复后：同一张卡片回到正常样子', async () => {
    const { host, state } = renderPlan(makePlan(['completed', 'in_progress', 'pending'], true))
    expect(host.querySelector('.paused-badge')).not.toBeNull()

    // 恢复时后端会把卡住的步骤重置为待办并清掉暂停标记
    state.plan = makePlan(['completed', 'pending', 'pending'], false)
    await nextTick()
    expect(host.querySelector('.paused-badge')).toBeNull()
    expect(host.querySelector('.is-paused')).toBeNull()
    expect(host.querySelector('.step-icon.paused')).toBeNull()

    // 接着开下一步：又是正常的进行中，转圈回来
    state.plan = makePlan(['completed', 'in_progress', 'pending'], false)
    await nextTick()
    expect(host.querySelector('.step-spinner')).not.toBeNull()
    expect(host.querySelector('.top-progress-bar.paused')).toBeNull()
  })

  it('暂停和失败同时出现：以暂停为准，失败的那一步自己仍标红', () => {
    const { host } = renderPlan(makePlan(['failed', 'in_progress', 'pending'], true))
    expect(host.querySelector('.paused-badge')).not.toBeNull()
    expect(host.querySelector('.agent-plan.is-paused')).not.toBeNull()
    expect(host.querySelector('.agent-plan.has-failed')).toBeNull()
    expect(host.querySelector('.top-progress-bar.paused')).not.toBeNull()
    expect(host.querySelector('.top-progress-bar.failed')).toBeNull()
    expect(host.querySelector('.plan-step.failed')).not.toBeNull()
    expect(host.querySelector('.step-spinner')).toBeNull()
  })

  it('有失败但没暂停：照常按失败显示', () => {
    const { host } = renderPlan(makePlan(['failed', 'in_progress', 'pending'], false))
    expect(host.querySelector('.agent-plan.has-failed')).not.toBeNull()
    expect(host.querySelector('.top-progress-bar.failed')).not.toBeNull()
    expect(host.querySelector('.paused-badge')).toBeNull()
  })

  it('暂停标记还在，但步骤都收尾了：按做完显示，不再说已暂停', () => {
    const { host } = renderPlan(makePlan(['completed', 'skipped'], true))
    expect(host.querySelector('.paused-badge')).toBeNull()
    expect(host.querySelector('.is-paused')).toBeNull()
    expect(host.querySelector('.is-completed')).not.toBeNull()
  })

  it('暂停时没有进行中的步骤（都在待办）：照样标出已暂停，没有暂停图标', () => {
    const { host } = renderPlan(makePlan(['completed', 'pending'], true))
    expect(host.querySelector('.paused-badge')).not.toBeNull()
    expect(host.querySelector('.step-icon.paused')).toBeNull()
  })

  it('英文界面显示 Paused', () => {
    const { host } = renderPlan(makePlan(['in_progress'], true), { locale: 'en-US' })
    expect(host.querySelector('.paused-badge')?.textContent).toContain('Paused')
  })
})

describe('AgentPlanView 暂停显示（折叠）', () => {
  it('没暂停：折叠行显示正在做的那一步和转圈', () => {
    const { host } = renderPlan(makePlan(['completed', 'in_progress', 'pending']), { compact: true })
    expect(host.querySelector('.current-step-spinner')).not.toBeNull()
    expect(host.querySelector('.paused-hint')).toBeNull()
  })

  it('暂停后：折叠行显示「已暂停」，不再转圈', () => {
    const { host } = renderPlan(makePlan(['completed', 'in_progress', 'pending'], true), { compact: true })
    expect(host.querySelector('.paused-hint')?.textContent).toContain('已暂停')
    expect(host.querySelector('.current-step-spinner')).toBeNull()
    expect(host.querySelector('.top-progress-bar.paused')).not.toBeNull()
  })
})
