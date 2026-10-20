/**
 * @vitest-environment jsdom
 *
 * 密钥框：平时遮住露头尾、点进去换成真实内容、眼睛看全文、留空沿用时框是空的。
 */
import { createApp, defineComponent, h, nextTick, ref, type App, type Ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it } from 'vitest'
import SecretInput from '../SecretInput.vue'

const KEY = 'sk-abcdefghijklmnop1234'
const MASKED = 'sk-••••••••1234'

interface Harness {
  model: Ref<string>
  input: () => HTMLInputElement
  toggle: () => HTMLButtonElement
  unmount: () => void
}

const mounted: Harness[] = []

function mountField(opts: { value?: string; reusedValue?: string; placeholder?: string } = {}): Harness {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-CN',
    messages: { 'zh-CN': { common: { secretInput: { show: '显示密钥', hide: '隐藏密钥' } } } },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const model = ref(opts.value ?? '')
  const Parent = defineComponent({
    setup() {
      return () =>
        h(SecretInput, {
          modelValue: model.value,
          reusedValue: opts.reusedValue,
          placeholder: opts.placeholder,
          'onUpdate:modelValue': (v: string) => {
            model.value = v
          },
        })
    },
  })
  const app: App = createApp(Parent).use(i18n)
  app.mount(host)
  const harness: Harness = {
    model,
    input: () => host.querySelector('input') as HTMLInputElement,
    toggle: () => host.querySelector('.secret-toggle') as HTMLButtonElement,
    unmount: () => {
      app.unmount()
      host.remove()
    },
  }
  mounted.push(harness)
  return harness
}

const focus = async (el: HTMLElement) => {
  el.dispatchEvent(new FocusEvent('focus'))
  await nextTick()
}
const blur = async (el: HTMLElement) => {
  el.dispatchEvent(new FocusEvent('blur'))
  await nextTick()
}
const click = async (el: HTMLElement) => {
  el.click()
  await nextTick()
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('SecretInput', () => {
  it('填了密钥，平时只读，显示头尾，明文不进输入框', () => {
    const { input } = mountField({ value: KEY })
    expect(input().readOnly).toBe(true)
    expect(input().value).toBe(MASKED)
    expect(input().value).not.toContain('abcdefghijklmnop')
  })

  it('点进去换成可编辑的真实内容（整排圆点），点到别处再遮回去', async () => {
    const { input } = mountField({ value: KEY })

    await focus(input())
    expect(input().readOnly).toBe(false)
    expect(input().type).toBe('password')
    expect(input().value).toBe(KEY)

    await blur(input())
    expect(input().readOnly).toBe(true)
    expect(input().type).toBe('text')
    expect(input().value).toBe(MASKED)
  })

  it('编辑时输入的内容回写给调用方', async () => {
    const { input, model } = mountField({ value: KEY })
    await focus(input())
    input().value = `${KEY}9`
    input().dispatchEvent(new Event('input'))
    await nextTick()
    expect(model.value).toBe(`${KEY}9`)
    expect(input().value).toBe(`${KEY}9`)
  })

  it('点眼睛看全文，再点遮回去；按钮文字跟着变', async () => {
    const { input, toggle } = mountField({ value: KEY })
    expect(toggle().title).toBe('显示密钥')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')

    await click(toggle())
    expect(input().type).toBe('text')
    expect(input().value).toBe(KEY)
    expect(toggle().title).toBe('隐藏密钥')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')

    await click(toggle())
    expect(input().value).toBe(MASKED)
    expect(toggle().title).toBe('显示密钥')
  })

  it('空框：可以直接填，占位用传进来的文字', async () => {
    const { input, model } = mountField({ placeholder: 'API Key' })
    expect(input().readOnly).toBe(false)
    expect(input().value).toBe('')
    expect(input().placeholder).toBe('API Key')

    input().value = KEY
    input().dispatchEvent(new Event('input'))
    await nextTick()
    expect(model.value).toBe(KEY)
  })

  it('留空沿用别处的密钥：框是空的，占位里是遮盖后的那一把，和自己填的一样', async () => {
    const reused = mountField({ reusedValue: KEY, placeholder: 'API Key' })
    const filled = mountField({ value: KEY })
    expect(reused.input().value).toBe('')
    expect(reused.input().placeholder).toBe(MASKED)
    expect(reused.input().placeholder).toBe(filled.input().value)
    expect(reused.input().classList.contains('secret-reused')).toBe(true)
    expect(reused.model.value).toBe('')
  })

  it('沿用时点眼睛，占位里是那一把的全文，框仍然是空的', async () => {
    const { input, toggle, model } = mountField({ reusedValue: KEY })
    await click(toggle())
    expect(input().placeholder).toBe(KEY)
    expect(input().value).toBe('')
    expect(model.value).toBe('')
  })

  it('沿用时用户另填一把，就显示自己填的，不再显示沿用的', async () => {
    const { input } = mountField({ reusedValue: KEY, value: 'own-key-abcdefghij9999' })
    expect(input().value).toBe('own••••••••9999')
    expect(input().classList.contains('secret-reused')).toBe(false)
  })
})
