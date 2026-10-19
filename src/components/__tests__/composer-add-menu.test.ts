/**
 * @vitest-environment jsdom
 *
 * 输入框加号的小菜单：两项、点哪项发哪项、什么时候收起、不抢输入框焦点。
 */
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it } from 'vitest'
import ComposerAddMenu from '../ComposerAddMenu.vue'

interface Harness {
  open: Ref<boolean>
  anchor: HTMLButtonElement
  editor: HTMLInputElement
  events: string[]
  menu: () => HTMLElement | null
  items: () => HTMLElement[]
  unmount: () => void
}

const mounted: Harness[] = []

function mountMenu(opts: { open?: boolean; focusFirst?: boolean } = {}): Harness {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: {
      'zh-CN': { ai: { attach: '添加文件', conversationSkillAdd: '添加技能', addMenu: '添加' } },
    },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const anchor = document.createElement('button')
  anchor.textContent = '+'
  const editor = document.createElement('input')
  document.body.append(anchor, editor)
  const open = ref(opts.open ?? true)
  const events: string[] = []

  const Parent = defineComponent({
    setup() {
      return () =>
        h(ComposerAddMenu, {
          open: open.value,
          anchor,
          focusFirst: opts.focusFirst,
          onClose: () => {
            events.push('close')
            open.value = false
          },
          onAttach: () => events.push('attach'),
          onSkill: () => events.push('skill'),
        })
    },
  })
  const app: App = createApp(Parent).use(i18n)
  app.mount(host)

  const harness: Harness = {
    open,
    anchor,
    editor,
    events,
    menu: () => document.body.querySelector<HTMLElement>('.composer-add-menu'),
    items: () => Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')),
    unmount: () => {
      app.unmount()
      host.remove()
      anchor.remove()
      editor.remove()
    },
  }
  mounted.push(harness)
  return harness
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('ComposerAddMenu', () => {
  it('没打开时不渲染任何东西', async () => {
    const h = mountMenu({ open: false })
    await nextTick()
    expect(h.menu()).toBeNull()
  })

  it('打开后是两项：添加文件、添加技能', async () => {
    const h = mountMenu()
    await nextTick()
    expect(h.menu()?.getAttribute('role')).toBe('menu')
    expect(h.items().map(el => el.textContent?.trim())).toEqual(['添加文件', '添加技能'])
  })

  it('点哪项就发出哪项', async () => {
    const h = mountMenu()
    await nextTick()
    h.items()[0].click()
    h.items()[1].click()
    expect(h.events).toEqual(['attach', 'skill'])
  })

  it('菜单项按下时不抢输入框的焦点', async () => {
    const h = mountMenu()
    await nextTick()
    for (const item of h.items()) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      item.dispatchEvent(down)
      expect(down.defaultPrevented).toBe(true)
    }
  })

  it('点了菜单和加号之外的地方就收起；点菜单自己、点加号自己不算', async () => {
    const h = mountMenu()
    await nextTick()
    h.menu()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    h.anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(h.events).toEqual([])
    h.editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(h.events).toEqual(['close'])
  })

  it('按 Esc 只关菜单，不再传给别处', async () => {
    const h = mountMenu()
    await nextTick()
    let reachedEditor = false
    h.editor.addEventListener('keydown', () => { reachedEditor = true })
    h.editor.focus()
    h.editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(h.events).toEqual(['close'])
    expect(reachedEditor).toBe(false)
  })

  it('焦点在输入框、用户接着打字，菜单让开；单按修饰键、按在加号上不算', async () => {
    const h = mountMenu()
    await nextTick()
    h.editor.focus()
    h.editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    h.anchor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(h.events).toEqual([])
    h.editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(h.events).toEqual(['close'])
  })

  it('收起之后不再监听外面的点击', async () => {
    const h = mountMenu()
    await nextTick()
    h.open.value = false
    await nextTick()
    expect(h.menu()).toBeNull()
    h.editor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    h.editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(h.events).toEqual([])
  })

  it('键盘打开时焦点落到第一项，上下键在两项之间走（到头绕回）', async () => {
    const h = mountMenu({ focusFirst: true })
    await nextTick()
    await nextTick()
    const [first, second] = h.items()
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(second)
    second.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(second)
  })

  it('聚焦第一项时菜单已经显示出来（还隐藏着的元素在真实浏览器里聚焦不上）', async () => {
    const seen: string[] = []
    const onFocusIn = (e: FocusEvent) => {
      const menu = (e.target as HTMLElement).closest<HTMLElement>('.composer-add-menu')
      if (menu) seen.push(menu.style.visibility)
    }
    document.addEventListener('focusin', onFocusIn)
    try {
      mountMenu({ focusFirst: true })
      await nextTick()
      await nextTick()
      await nextTick()
      expect(seen).toEqual([''])
    } finally {
      document.removeEventListener('focusin', onFocusIn)
    }
  })

  describe('摆放', () => {
    const rect = (r: { left: number; top: number; width: number; height: number }) => () =>
      ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}) }) as DOMRect

    function stubMenuSize(width: number, height: number) {
      const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
      const h = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => width })
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height })
      return () => {
        if (w) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', w)
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
        if (h) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', h)
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
      }
    }

    /** 加号按钮在 (40, plusTop)，32×32 */
    function mountAtPlus(plusTop: number) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const anchor = document.createElement('button')
      anchor.getBoundingClientRect = rect({ left: 40, top: plusTop, width: 32, height: 32 })
      document.body.appendChild(anchor)
      const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': { ai: {} } } })
      const app = createApp({ render: () => h(ComposerAddMenu, { open: true, anchor }) }).use(i18n)
      app.mount(host)
      return {
        menu: () => document.body.querySelector<HTMLElement>('.composer-add-menu')!,
        cleanup: () => { app.unmount(); host.remove(); anchor.remove() },
      }
    }

    it('贴着加号弹出：开在加号正上方，左边与加号对齐', async () => {
      const restore = stubMenuSize(176, 80)
      const m = mountAtPlus(600)
      try {
        await nextTick()
        await nextTick()
        expect(m.menu().style.top).toBe(`${600 - 6 - 80}px`)
        expect(m.menu().style.left).toBe('40px')
      } finally {
        m.cleanup()
        restore()
      }
    })

    it('加号上方放不下、下方更宽裕时开在加号正下方', async () => {
      const restore = stubMenuSize(176, 80)
      const m = mountAtPlus(40)
      try {
        await nextTick()
        await nextTick()
        expect(m.menu().style.top).toBe(`${40 + 32 + 6}px`)
      } finally {
        m.cleanup()
        restore()
      }
    })

    it('窗口太矮、两边都放不下时，菜单也不跑出窗口', async () => {
      const restore = stubMenuSize(176, 80)
      const original = Object.getOwnPropertyDescriptor(window, 'innerHeight')
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 150 })
      try {
        // 开在下方、但下方不够：贴着窗口底边（离边 8px）
        const below = mountAtPlus(30)
        await nextTick()
        await nextTick()
        expect(below.menu().style.top).toBe(`${150 - 8 - 80}px`)
        below.cleanup()
        // 开在上方、但上方不够：贴着窗口顶边（离边 8px）
        const above = mountAtPlus(80)
        await nextTick()
        await nextTick()
        expect(above.menu().style.top).toBe('8px')
        above.cleanup()
      } finally {
        if (original) Object.defineProperty(window, 'innerHeight', original)
        restore()
      }
    })

    it('靠右边时不跑出窗口右边', async () => {
      const restore = stubMenuSize(176, 80)
      const original = Object.getOwnPropertyDescriptor(window, 'innerWidth')
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 200 })
      try {
        const m = mountAtPlus(600)
        await nextTick()
        await nextTick()
        expect(m.menu().style.left).toBe(`${200 - 176 - 8}px`)
        m.cleanup()
      } finally {
        if (original) Object.defineProperty(window, 'innerWidth', original)
        restore()
      }
    })
  })

  it('鼠标打开时焦点不动，还在输入框里', async () => {
    const h = mountMenu({ focusFirst: false })
    h.editor.focus()
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(h.editor)
  })

  it('键盘打开、焦点在菜单里按 Esc：收起并把焦点还给加号', async () => {
    const h = mountMenu({ focusFirst: true })
    await nextTick()
    await nextTick()
    h.items()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await nextTick()
    expect(h.events).toEqual(['close'])
    expect(document.activeElement).toBe(h.anchor)
  })

  it('键盘打开、选了一项之后菜单收起：焦点回到加号，不掉到页面上', async () => {
    const h = mountMenu({ focusFirst: true })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(h.items()[0])
    h.items()[0].click()
    // 父级收到选择后收起菜单
    h.open.value = false
    await nextTick()
    expect(h.menu()).toBeNull()
    expect(h.events).toEqual(['attach'])
    expect(document.activeElement).toBe(h.anchor)
  })

  it('鼠标打开、焦点在输入框时收起菜单：不抢走输入框的焦点', async () => {
    const h = mountMenu({ focusFirst: false })
    h.editor.focus()
    await nextTick()
    h.open.value = false
    await nextTick()
    expect(document.activeElement).toBe(h.editor)
  })

  it('Tab 把焦点移出菜单就收起；在两项之间移动、回到加号都不算', async () => {
    const h = mountMenu({ focusFirst: true })
    await nextTick()
    await nextTick()
    const [first, second] = h.items()
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: second }))
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: h.anchor }))
    expect(h.events).toEqual([])
    first.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: h.editor }))
    expect(h.events).toEqual(['close'])
  })
})
