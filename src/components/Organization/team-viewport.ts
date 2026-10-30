import { inject, onScopeDispose, provide, ref, watch, type InjectionKey, type Ref } from 'vue'

const viewportKey: InjectionKey<Ref<boolean>> = Symbol('team-viewport')
export const provideTeamViewport = (enabled: Ref<boolean>) => provide(viewportKey, enabled)

interface ViewportPool { observer: IntersectionObserver; targets: Map<Element, (visible: boolean) => void> }
const pools = new WeakMap<Element, ViewportPool>()

/** 同一滚动区共用观察器；两轴预读，保留原节点槽位和连线。 */
export function useTeamVisibility() {
  const enabled = inject(viewportKey, ref(false))
  const element = ref<HTMLElement | null>(null)
  const visible = ref(!enabled.value || typeof IntersectionObserver === 'undefined')
  let release: (() => void) | undefined
  watch([element, enabled], ([target, active]) => {
    release?.()
    release = undefined
    visible.value = !active || typeof IntersectionObserver === 'undefined'
    if (!target || !active || typeof IntersectionObserver === 'undefined') return
    const root = target.closest('.oc-body, .dock-panel')
    if (!root) { visible.value = true; return }
    let pool = pools.get(root)
    if (!pool) {
      const targets = new Map<Element, (visible: boolean) => void>()
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) targets.get(entry.target)?.(entry.isIntersecting)
      }, { root, rootMargin: '300px' })
      pool = { observer, targets }
      pools.set(root, pool)
    }
    const owner = pool
    let inRange = false
    const focus = () => { visible.value = true }
    const blur = () => { visible.value = inRange }
    target.addEventListener('focus', focus)
    target.addEventListener('blur', blur)
    owner.targets.set(target, value => { inRange = value; visible.value = value || target === document.activeElement })
    owner.observer.observe(target)
    release = () => {
      target.removeEventListener('focus', focus)
      target.removeEventListener('blur', blur)
      owner.observer.unobserve(target)
      owner.targets.delete(target)
      if (!owner.targets.size) { owner.observer.disconnect(); pools.delete(root) }
    }
  }, { flush: 'post' })
  onScopeDispose(() => release?.())
  return { element, visible }
}
