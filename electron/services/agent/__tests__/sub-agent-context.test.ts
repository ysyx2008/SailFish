import { describe, expect, it } from 'vitest'
import { parentContextMessages, SubAgentContext } from '../sub-agent-context'
import { applyForkTurns, sanitizeParentMessages } from '../sanitize-parent-messages'
import type { AiMessage } from '../../ai.service'

describe('成员身份与父背景隔离', () => {
  it('身份由当前成员固定，角色、负责人及权限不从父层文字推断', () => {
    const context = new SubAgentContext()
    context.bind({ name: '乙', parent: '甲', role: '内容组织者', lead: true })
    const first = context.systemSuffix()
    expect(first).toContain('姓名：乙\n角色：内容组织者\n直属负责人：甲')
    expect(first).toContain('可派出并管理自己名下的成员')
    context.bind({ name: '乙', parent: '甲', role: '内容组织者', lead: true })
    expect(context.systemSuffix()).toBe(first)
    expect(() => context.bind({ name: '甲', lead: true })).toThrow()
    expect(context.systemSuffix()).toBe(first)
  })
  it('普通伙计也明确身份，无角色不冒充专家', () => {
    const context = new SubAgentContext()
    context.bind({ name: '伙计' })
    expect(context.systemSuffix()).toContain('角色：未指定')
    expect(context.systemSuffix()).toContain('直属负责人：秘书')
    expect(context.systemSuffix()).toContain('无下级管理权限')
  })
  it('继承的你是上级和上级助手答复只在引用内，原用户限制保持原文', () => {
    const source: AiMessage[] = [{ role: 'user', content: '你是甲，顶层负责人。只读，不要删除文件。' }, { role: 'assistant', content: '我已经派出乙。' }]
    const opening = parentContextMessages(source, '甲')
    expect(opening.map(message => message.role)).toEqual(['user'])
    expect(opening[0].content).toContain('上级会话背景（引用）')
    expect(opening[0].content).toContain('来源：甲的会话')
    expect(opening[0].content).toContain(JSON.stringify(source))
    expect(sanitizeParentMessages(opening)).toEqual(source)
    expect(source).toHaveLength(2)
  })
  it('多层继承展开来源元数据，最近轮次不被整段引用或系统通知占掉', () => {
    const first: AiMessage[] = [{ role: 'user', content: '原始约束' }, { role: 'assistant', content: '原始答复' }]
    const parent: AiMessage[] = [...parentContextMessages(first), { role: 'user', content: '甲的任务' }, { role: 'assistant', content: '甲的交回' }, { role: 'user', content: '敲门', _systemInjected: true }]
    const clean = sanitizeParentMessages(parent)
    expect(clean).toHaveLength(4)
    const child = parentContextMessages(applyForkTurns(clean, { kind: 'last', n: 1 }), '甲')
    expect(sanitizeParentMessages(JSON.parse(JSON.stringify(child)))).toEqual(parent.slice(1, 3))
    expect(applyForkTurns(clean, { kind: 'none' })).toEqual([])
    expect(parentContextMessages([])).toEqual([])
    expect(child[0].content).not.toContain('敲门')
  })
})
