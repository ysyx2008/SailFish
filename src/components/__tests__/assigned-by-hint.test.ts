/**
 * @vitest-environment jsdom
 */
/**
 * 对话顶栏正中那一行字：联络派出的任务写明「这是 XX 派出的任务」，XX 是智能体自己的名字
 * （用户起了名用用户的，没起用默认名）；其余什么都不出现。
 * 它不一直挂着：打开时淡入，停一阵淡出，用户自己滚动时再淡入。
 */
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '../../i18n/locales/zh-CN'
import enUS from '../../i18n/locales/en-US'
import appI18n, { setLocale } from '../../i18n'
import AssignedByHint from '../AssignedByHint.vue'

// 配置仓库一建出来就要连 Electron 的桥；这里只关心智能体的名字字段，换成一个同样响应式的替身
const configStub = vi.hoisted(() => ({ current: null as null | { agentName: string } }))
vi.mock('../../stores/config', () => ({ useConfigStore: () => configStub.current }))

/** 与组件里「最后一次触发后停留多久」一致，测试只认这个量级 */
const HOLD_MS = 1600

const mounted: Array<() => void> = []

interface HintState {
  active: boolean
  scrollSource: HTMLElement | null
}

function renderHint(
  assignedBy: unknown,
  opts: { locale?: 'zh-CN' | 'en-US'; active?: boolean; scrollSource?: HTMLElement | null } = {},
) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = reactive<HintState>({
    active: opts.active ?? true,
    scrollSource: opts.scrollSource ?? null,
  })
  const app = createApp({
    render: () => h(AssignedByHint, {
      assignedBy: assignedBy as string | undefined,
      active: state.active,
      scrollSource: state.scrollSource,
    }),
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

const hintOf = (host: HTMLElement) => host.querySelector('.assigned-by-hint')
const isShown = (host: HTMLElement) => hintOf(host)?.classList.contains('is-shown') ?? false

function makeScroller() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  mounted.push(() => el.remove())
  return el
}

beforeEach(() => {
  configStub.current = reactive({ agentName: '' })
  // 默认名取自应用本身的语言，不受运行环境的浏览器语言影响
  setLocale('zh-CN')
})

afterEach(() => {
  vi.useRealTimers()
  while (mounted.length) mounted.pop()!()
})

describe('AssignedByHint 顶栏里的出身说明', () => {
  it('用户给智能体起了名：写「这是 <用户起的名字> 派出的任务」，带图标，没有按钮', () => {
    configStub.current!.agentName = '小蓝'
    const { host } = renderHint('companion')
    const hint = hintOf(host)!
    expect(hint).not.toBeNull()
    expect(hint.textContent?.trim()).toBe('这是小蓝派出的任务')
    expect(hint.querySelector('svg')).not.toBeNull()
    expect(hint.querySelector('button')).toBeNull()
  })

  it('没起名（或只填了空格）：写默认名字，不再写「联络」', () => {
    const defaultName = appI18n.global.t('app.title')
    for (const blank of ['', '   ']) {
      configStub.current!.agentName = blank
      const text = hintOf(renderHint('companion').host)!.textContent?.trim()
      expect(text).toBe(`这是${defaultName}派出的任务`)
      expect(text).not.toContain('联络')
    }
  })

  it('英文界面有对应的说法', () => {
    configStub.current!.agentName = 'Jarvis'
    const { host } = renderHint('companion', { locale: 'en-US' })
    expect(hintOf(host)?.textContent?.trim()).toBe('This task was sent out by Jarvis')
  })

  it('名字改了，这一行跟着变，不用重开对话', async () => {
    const config = configStub.current!
    config.agentName = '小蓝'
    const { host } = renderHint('companion')
    expect(hintOf(host)?.textContent?.trim()).toBe('这是小蓝派出的任务')
    config.agentName = '阿鱼'
    await nextTick()
    expect(hintOf(host)?.textContent?.trim()).toBe('这是阿鱼派出的任务')
  })

  it('没记下出身（用户自己开的、老任务）：什么都不出现，滚动也不会冒出来', () => {
    const scroller = makeScroller()
    const { host } = renderHint(undefined, { scrollSource: scroller })
    scroller.dispatchEvent(new Event('wheel'))
    expect(hintOf(host)).toBeNull()
  })

  it('不认识的取值、撞上对象属性名的取值：不出现，宁可不标也不标错', () => {
    expect(hintOf(renderHint('nobody').host)).toBeNull()
    expect(hintOf(renderHint('constructor').host)).toBeNull()
  })
})

describe('AssignedByHint 淡入、淡出的时机', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('打开对话时淡入，停一阵就淡出', async () => {
    const { host } = renderHint('companion')
    await nextTick()
    expect(isShown(host)).toBe(true)

    vi.advanceTimersByTime(HOLD_MS - 100)
    await nextTick()
    expect(isShown(host)).toBe(true)

    vi.advanceTimersByTime(200)
    await nextTick()
    expect(isShown(host)).toBe(false)
    // 淡出不等于没有：元素还在，只是看不见
    expect(hintOf(host)).not.toBeNull()
  })

  it('用户滚动（滚轮、触屏）时再淡入；一直在滚就一直留着，停下才淡出', async () => {
    const scroller = makeScroller()
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()
    expect(isShown(host)).toBe(false)

    scroller.dispatchEvent(new Event('wheel'))
    await nextTick()
    expect(isShown(host)).toBe(true)

    // 持续滚动：每次都重新计时，过了一个完整的停留时长也不收
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(HOLD_MS - 300)
      scroller.dispatchEvent(new Event('touchmove'))
    }
    await nextTick()
    expect(isShown(host)).toBe(true)

    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('对话自己往下滚（输出时跟底）不算：只有 scroll 事件、没有用户输入，不淡入', async () => {
    const scroller = makeScroller()
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()

    for (let i = 0; i < 5; i++) scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('拖滚动条算滚动：按住期间的 scroll 一直让它留着，松手后的 scroll 不算', async () => {
    const scroller = makeScroller()
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()

    // 点在容器自己身上（而不是里面的内容）= 按在滚动条上
    scroller.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(isShown(host)).toBe(true)

    vi.advanceTimersByTime(HOLD_MS - 300)
    scroller.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(HOLD_MS - 300)
    await nextTick()
    expect(isShown(host)).toBe(true)

    window.dispatchEvent(new MouseEvent('mouseup'))
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()
    expect(isShown(host)).toBe(false)
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('松手时指针落在会拦住事件的元素上，也算松手：之后对话自己滚不会被当成用户在拖', async () => {
    const scroller = makeScroller()
    const blocker = document.createElement('div')
    blocker.addEventListener('mouseup', e => e.stopPropagation())
    document.body.appendChild(blocker)
    mounted.push(() => blocker.remove())
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()

    scroller.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(isShown(host)).toBe(true)

    blocker.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()
    expect(isShown(host)).toBe(false)

    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('按住滚动条后切走窗口、收不到松手：之后对话自己滚也不会被当成用户在拖', async () => {
    const scroller = makeScroller()
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()

    scroller.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    expect(isShown(host)).toBe(true)

    // 没有 mouseup，窗口直接失焦
    window.dispatchEvent(new Event('blur'))
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()
    expect(isShown(host)).toBe(false)

    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('只有左键按在滚动条上才算：右键不算', async () => {
    const scroller = makeScroller()
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()

    scroller.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2 }))
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('点在对话内容上不算按住滚动条', async () => {
    const scroller = makeScroller()
    const inner = document.createElement('p')
    scroller.appendChild(inner)
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()

    inner.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    scroller.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('切回这场对话算刚打开，再淡入一次；离开时立刻淡出', async () => {
    const { host, state } = renderHint('companion')
    await nextTick()
    vi.advanceTimersByTime(HOLD_MS + 100)
    await nextTick()
    expect(isShown(host)).toBe(false)

    state.active = false
    await nextTick()
    expect(isShown(host)).toBe(false)

    state.active = true
    await nextTick()
    await nextTick()
    expect(isShown(host)).toBe(true)

    state.active = false
    await nextTick()
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('不在眼前时用户的滚动不会让它出来', async () => {
    const scroller = makeScroller()
    const { host } = renderHint('companion', { active: false, scrollSource: scroller })
    await nextTick()
    scroller.dispatchEvent(new Event('wheel'))
    await nextTick()
    expect(isShown(host)).toBe(false)
  })

  it('卸载后不再监听滚动', async () => {
    const scroller = makeScroller()
    const addSpy = vi.spyOn(scroller, 'addEventListener')
    const removeSpy = vi.spyOn(scroller, 'removeEventListener')
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const { host } = renderHint('companion', { scrollSource: scroller })
    await nextTick()
    expect(addSpy).toHaveBeenCalled()

    mounted.pop()!() // 卸载这行字
    expect(removeSpy.mock.calls.map(c => c[0]).sort()).toEqual(['mousedown', 'scroll', 'touchmove', 'wheel'])
    // 挂在 window 上的松手、失焦监听也要摘掉，不然组件没了还留着
    const windowRemoved = windowRemoveSpy.mock.calls.map(c => c[0])
    expect(windowRemoved).toContain('mouseup')
    expect(windowRemoved).toContain('blur')
    expect(host.querySelector('.assigned-by-hint')).toBeNull()
  })
})
