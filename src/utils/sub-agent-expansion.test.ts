import { describe, expect, it } from 'vitest'
import { memberDetailStepId, subAgentExpansionKey, isSubAgentExpanded, toggleSubAgentExpansion, rememberSubAgentHeight, subAgentExpansionHeight, subAgentCollapsedHeight, rememberSubAgentCollapsedHeight } from './sub-agent-expansion'
describe('共用成员展开状态',()=>{
  it('任务、会话和名字有分隔符时也不串键',()=>{
    expect(memberDetailStepId('a:b','c','d')).not.toBe(memberDetailStepId('a','b:c','d'))
    expect(memberDetailStepId('a','task-a','同名')).not.toBe(memberDetailStepId('a','task-b','同名'))
  })
  it('展开时保留高度供重挂载读取，收起后释放',()=>{
    const key=subAgentExpansionKey(memberDetailStepId('height-session','step','成员'),'id')
    expect(isSubAgentExpanded(key)).toBe(false)
    toggleSubAgentExpansion(key);rememberSubAgentHeight(key,640)
    expect(subAgentExpansionHeight(key)).toBe(640)
    toggleSubAgentExpansion(key)
    expect(isSubAgentExpanded(key)).toBe(false)
    expect(subAgentExpansionHeight(key)).toBe(56)
  })
  it('收起的自然高度跨浮层重挂载保留，与展开占位互不覆盖',()=>{
    const key=subAgentExpansionKey(memberDetailStepId('compact','step','成员'),'id')
    rememberSubAgentCollapsedHeight(key,33.5)
    toggleSubAgentExpansion(key);rememberSubAgentHeight(key,640)
    expect(subAgentCollapsedHeight(key)).toBe(33.5)
    toggleSubAgentExpansion(key)
    expect(subAgentCollapsedHeight(key)).toBe(33.5)
    expect(subAgentExpansionHeight(key)).toBe(56)
  })

})
