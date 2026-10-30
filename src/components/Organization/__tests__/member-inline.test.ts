// @vitest-environment jsdom
import { createApp, h, nextTick, ref, type App } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OrganizationMemberDetail from '../OrganizationMemberDetail.vue'
vi.mock('vue-i18n', () => ({useI18n:()=>({t:(key:string)=>key})}))
const settle=async()=>{await nextTick();await Promise.resolve();await nextTick()}
let app: App | undefined
let host: HTMLDivElement | undefined
afterEach(()=>{app?.unmount();host?.remove();vi.unstubAllGlobals();vi.useRealTimers()})
describe('层级成员的早期内嵌卡片',()=>{
  it('收起时不读取完整记录，原地展开才读原会话，收起停止刷新',async()=>{
    vi.useFakeTimers()
    const read=vi.fn(async()=>({id:'inline-a',name:'inline-a',description:'核对',status:'running',result:'真实核对结果',steps:[{id:'read',tool:'read_file',args:'/tmp/example',status:'completed'}]}))
    vi.stubGlobal('electronAPI',{history:{readTeamMember:read}})
    Object.defineProperty(window,'electronAPI',{value:{history:{readTeamMember:read}},configurable:true})
    host=document.createElement('div');document.body.append(host)
    app=createApp({render:()=>h(OrganizationMemberDetail,{inline:true,sessionId:'original-session',member:{id:'inline-a',name:'inline-a',description:'核对',role:'审阅',status:'running'},focusActive:false})});app.mount(host)
    await settle()
    expect(read).not.toHaveBeenCalled()
    expect(host.querySelector('.sub-agent-detail')).toBeNull()
    const header=host.querySelector<HTMLElement>('.sub-agent-header')!
    header.click();await settle()
    expect(read).toHaveBeenCalledWith('original-session','inline-a')
    expect(host.querySelector('.sub-agent-detail')?.textContent).toContain('真实核对结果')
    expect(host.querySelector('.om-header')).toBeNull()
    header.click();await settle()
    expect(host.querySelector('.sub-agent-detail')).toBeNull()
    await vi.advanceTimersByTimeAsync(2500)
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('收起后不接收迟到记录，重新展开读取最新结果',async()=>{
    let resolveOld: ((value:unknown)=>void) | undefined
    const read=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve})).mockResolvedValue({id:'inline-b',name:'inline-b',description:'核对',status:'completed',result:'最新结果'})
    Object.defineProperty(window,'electronAPI',{value:{history:{readTeamMember:read}},configurable:true})
    host=document.createElement('div');document.body.append(host)
    app=createApp({render:()=>h(OrganizationMemberDetail,{inline:true,sessionId:'original-session',member:{id:'inline-b',name:'inline-b',description:'核对',status:'completed'},focusActive:false})});app.mount(host)
    const header=host.querySelector<HTMLElement>('.sub-agent-header')!
    header.click();await settle();header.click();await settle()
    resolveOld?.({id:'inline-b',name:'inline-b',status:'completed',result:'旧结果'});await settle()
    header.click();await settle()
    expect(host.querySelector('.sub-agent-detail')?.textContent).toContain('最新结果')
    expect(host.querySelector('.sub-agent-detail')?.textContent).not.toContain('旧结果')
  })
  it('同会话同名成员换任务后不会沿用上一次展开与结果',async()=>{
    const step=ref('task-a')
    const read=vi.fn().mockResolvedValueOnce({id:'inline-c',name:'inline-c',status:'completed',result:'前一任务结果'}).mockResolvedValue({id:'inline-c',name:'inline-c',status:'completed',result:'当前任务结果'})
    Object.defineProperty(window,'electronAPI',{value:{history:{readTeamMember:read}},configurable:true})
    host=document.createElement('div');document.body.append(host)
    app=createApp({render:()=>h(OrganizationMemberDetail,{inline:true,stepId:step.value,sessionId:'same-session',member:{id:'inline-c',name:'inline-c',description:'核对',status:'completed'},focusActive:false})});app.mount(host)
    host.querySelector<HTMLElement>('.sub-agent-header')!.click();await settle()
    expect(host.textContent).toContain('前一任务结果')
    step.value='task-b';await settle()
    expect(host.querySelector('.sub-agent-detail')).toBeNull()
    expect(read).toHaveBeenCalledTimes(1)
    host.querySelector<HTMLElement>('.sub-agent-header')!.click();await settle()
    expect(host.querySelector('.sub-agent-detail')?.textContent).toContain('当前任务结果')
    expect(host.querySelector('.sub-agent-detail')?.textContent).not.toContain('前一任务结果')
  })

})
