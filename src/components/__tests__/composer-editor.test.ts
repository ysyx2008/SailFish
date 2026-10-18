/**
 * @vitest-environment jsdom
 */
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import ComposerEditor from '../ComposerEditor.vue'

beforeAll(() => {
  // jsdom 没有布局：ProseMirror 滚动到光标时要读 Range 的矩形
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
  document.elementFromPoint = () => null
})

interface Harness {
  text: ReturnType<typeof ref<string>>
  keydowns: KeyboardEvent[]
  inputs: { text: string; cursor: number }[]
  editorRef: ReturnType<typeof ref<InstanceType<typeof ComposerEditor> | null>>
  dom: () => HTMLElement
  unmount: () => void
  onKeydown: (fn: (e: KeyboardEvent) => void) => void
  onPaste: (fn: (e: ClipboardEvent) => void) => void
}

const mounted: Harness[] = []

function mountEditor(initial = '', highlight: { from: number; to: number } | null = null): Harness {
  const text = ref(initial)
  const keydowns: KeyboardEvent[] = []
  const inputs: { text: string; cursor: number }[] = []
  const editorRef = ref<InstanceType<typeof ComposerEditor> | null>(null)
  let keydownHook: (e: KeyboardEvent) => void = () => {}
  let pasteHook: (e: ClipboardEvent) => void = () => {}
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(
    defineComponent({
      render: () =>
        h(ComposerEditor, {
          ref: editorRef,
          modelValue: text.value,
          placeholder: '说点什么',
          highlight,
          'onUpdate:modelValue': (v: string) => { text.value = v },
          onInput: (p: { text: string; cursor: number }) => inputs.push(p),
          onKeydown: (e: KeyboardEvent) => { keydowns.push(e); keydownHook(e) },
          onPaste: (e: ClipboardEvent) => pasteHook(e),
        }),
    })
  )
  app.mount(host)
  const harness: Harness = {
    text,
    keydowns,
    inputs,
    editorRef,
    dom: () => host.querySelector('.ProseMirror') as HTMLElement,
    unmount: () => { app.unmount(); host.remove() },
    onKeydown: (fn) => { keydownHook = fn },
    onPaste: (fn) => { pasteHook = fn },
  }
  mounted.push(harness)
  return harness
}

function pressKey(el: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

function paste(el: HTMLElement, data: Record<string, string>) {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => data[type] ?? '', files: [], items: [], types: Object.keys(data) },
  })
  el.dispatchEvent(event)
  return event
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('ComposerEditor', () => {
  it('把带换行的文字按行显示', async () => {
    const h1 = mountEditor('第一行\n第二行')
    await nextTick()
    const paragraphs = h1.dom().querySelectorAll('p')
    expect(Array.from(paragraphs).map(p => p.textContent)).toEqual(['第一行', '第二行'])
  })

  it('带初始文字挂载时光标在文末', async () => {
    const h1 = mountEditor('ab\ncd')
    await nextTick()
    expect(h1.editorRef.value!.getCursor()).toBe(5)
  })

  it('空输入显示占位文字', async () => {
    const h1 = mountEditor('')
    await nextTick()
    const first = h1.dom().querySelector('p')!
    expect(first.classList.contains('is-editor-empty')).toBe(true)
    expect(first.getAttribute('data-placeholder')).toBe('说点什么')
  })

  it('外部改文字：编辑区跟着变，光标在文末', async () => {
    const h1 = mountEditor('abc')
    await nextTick()
    h1.text.value = 'x\ny'
    await nextTick()
    const paragraphs = Array.from(h1.dom().querySelectorAll('p')).map(p => p.textContent)
    expect(paragraphs).toEqual(['x', 'y'])
    expect(h1.editorRef.value!.getCursor()).toBe(3)
  })

  it('外部设置不会回头触发输入事件', async () => {
    const h1 = mountEditor('')
    await nextTick()
    h1.text.value = '来自外部'
    await nextTick()
    expect(h1.inputs).toHaveLength(0)
  })

  it('Shift+回车换行，并告知外层按键', async () => {
    const h1 = mountEditor('ab')
    await nextTick()
    h1.editorRef.value!.setCursor(1)
    const event = pressKey(h1.dom(), { key: 'Enter', shiftKey: true })
    await nextTick()
    expect(h1.keydowns).toContain(event)
    expect(h1.text.value).toBe('a\nb')
    expect(h1.inputs.at(-1)).toEqual({ text: 'a\nb', cursor: 2 })
  })

  it('回车默认也换行', async () => {
    const h1 = mountEditor('ab')
    await nextTick()
    h1.editorRef.value!.setCursor(2)
    pressKey(h1.dom(), { key: 'Enter' })
    await nextTick()
    expect(h1.text.value).toBe('ab\n')
  })

  it('外层处理了按键（preventDefault）就不再换行', async () => {
    const h1 = mountEditor('ab')
    await nextTick()
    h1.editorRef.value!.setCursor(2)
    h1.onKeydown((e) => e.preventDefault())
    pressKey(h1.dom(), { key: 'Enter' })
    await nextTick()
    expect(h1.text.value).toBe('ab')
  })

  it('粘贴只收纯文本，保留每个换行', async () => {
    const h1 = mountEditor('')
    await nextTick()
    paste(h1.dom(), { 'text/plain': 'a\n\nb', 'text/html': '<b>a</b><p>b</p>' })
    await nextTick()
    expect(h1.text.value).toBe('a\n\nb')
  })

  it('粘贴插在光标处', async () => {
    const h1 = mountEditor('ad')
    await nextTick()
    h1.editorRef.value!.setCursor(1)
    paste(h1.dom(), { 'text/plain': 'b\nc' })
    await nextTick()
    expect(h1.text.value).toBe('ab\ncd')
  })

  it('外层把粘贴当附件接走后，不再插入文字', async () => {
    const h1 = mountEditor('')
    await nextTick()
    h1.onPaste((e) => e.preventDefault())
    paste(h1.dom(), { 'text/plain': '不该出现' })
    await nextTick()
    expect(h1.text.value).toBe('')
  })

  it('斜杠命令区间被高亮', async () => {
    const h1 = mountEditor('/compact 一下', { from: 0, to: 8 })
    await nextTick()
    const token = h1.dom().querySelector('.composer-slash-token')
    expect(token?.textContent).toBe('/compact')
  })

  it('文件拖入时编辑区不自己处理', async () => {
    const h1 = mountEditor('')
    await nextTick()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [], getData: () => '' } })
    h1.dom().dispatchEvent(drop)
    await nextTick()
    expect(h1.text.value).toBe('')
  })
})
