// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { provideTeamViewport, useTeamVisibility } from '../team-viewport'

afterEach(() => vi.unstubAllGlobals())
describe('团队视口绘制', () => {
  it('大团队首帧不建内容，共享观察器，焦点移走回收，卸载释放', async () => {
    const observers: FakeObserver[] = []
    class FakeObserver {
      targets = new Set<Element>()
      constructor(private callback: IntersectionObserverCallback) { observers.push(this) }
      observe(target: Element) { this.targets.add(target) }
      unobserve(target: Element) { this.targets.delete(target) }
      disconnect() { this.targets.clear() }
      show(target: Element, visible: boolean) { this.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    const Cell = defineComponent({ setup() { const {element,visible}=useTeamVisibility();return () => h('div',{ref:element,tabindex:0,class:'cell'},visible.value?h('span',{class:'content'},'成员'):null) } })
    const App = defineComponent({ setup() {provideTeamViewport(ref(true));return () => h('div',{class:'oc-body'},[h(Cell),h(Cell)])} })
    const host=document.createElement('div');document.body.append(host)
    const app=createApp(App);app.mount(host)
    try {
      await nextTick()
      expect(host.querySelectorAll('.content')).toHaveLength(0)
      expect(observers).toHaveLength(1)
      const cells=host.querySelectorAll<HTMLElement>('.cell')
      observers[0].show(cells[0],true)
      await nextTick()
      expect(host.querySelectorAll('.content')).toHaveLength(1)
      cells[1].focus()
      observers[0].show(cells[1],false)
      await nextTick()
      expect(host.querySelectorAll('.content')).toHaveLength(2)
      cells[0].focus()
      await nextTick()
      expect(host.querySelectorAll('.content')).toHaveLength(1)
    } finally { app.unmount();host.remove() }
    expect(observers[0].targets.size).toBe(0)
  })
  it.each([{ enabled: false, available: true }, { enabled: true, available: false }])('小团队或API不可用时直接展示：%j', async ({enabled,available}) => {
    const observer = vi.fn(function () { throw Error('不应创建观察器') })
    vi.stubGlobal('IntersectionObserver', available ? observer : undefined)
    const Cell = defineComponent({ setup() {const {element,visible}=useTeamVisibility();return () => h('div',{ref:element},visible.value?h('span',{class:'content'},'成员'):null)} })
    const App = defineComponent({setup(){provideTeamViewport(ref(enabled));return () => h('div',{class:'oc-body'},h(Cell))}})
    const host=document.createElement('div');document.body.append(host)
    const app=createApp(App);app.mount(host)
    try {await nextTick();expect(host.querySelectorAll('.content')).toHaveLength(1);expect(observer).not.toHaveBeenCalled()}
    finally {app.unmount();host.remove()}
  })

})
