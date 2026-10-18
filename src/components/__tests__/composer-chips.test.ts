/**
 * @vitest-environment jsdom
 *
 * 输入框里的文件胶囊：编辑器 + 对账接线放在一起跑（真编辑器，jsdom）。
 */
import { createApp, defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import ComposerEditor from '../ComposerEditor.vue'
import {
  useComposerAttachmentChips,
  type ChipDoc,
  type ChipEditorHandle,
  type ChipParsingDoc,
} from '../../composables/useComposerAttachmentChips'
import { COMPOSER_CHIP_CHAR as CHIP } from '../../composables/composer-editor-text'

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect as DOMRect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList
  document.elementFromPoint = () => null
})

const doc = (filename: string, fileSize = 100): ChipDoc => ({ filename, fileType: 'txt', fileSize })
const parsing = (filename: string, fileIndex = 0, fileSize = 100): ChipParsingDoc => ({
  requestId: 'r1',
  fileIndex,
  filename,
  fileSize,
})

interface Harness {
  text: Ref<string>
  docs: Ref<ChipDoc[]>
  parsingDocs: Ref<ChipParsingDoc[]>
  editor: () => ChipEditorHandle & { getCursor: () => number; setCursor: (n: number) => void; focus: () => void }
  api: ReturnType<typeof useComposerAttachmentChips<ChipDoc, ChipParsingDoc>>
  dom: () => HTMLElement
  chipLabels: () => (string | null)[]
  removed: number[]
  unmount: () => void
}

const mounted: Harness[] = []

function mountHarness(initialText = '', initialDocs: ChipDoc[] = []): Harness {
  const text = ref(initialText)
  const docs = ref<ChipDoc[]>(initialDocs)
  const parsingDocs = ref<ChipParsingDoc[]>([])
  const editorRef = ref<InstanceType<typeof ComposerEditor> | null>(null)
  const removed: number[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  let api!: Harness['api']
  const app = createApp(
    defineComponent({
      setup() {
        api = useComposerAttachmentChips<ChipDoc, ChipParsingDoc>({
          editor: editorRef as Ref<ChipEditorHandle | null>,
          uploadedDocs: () => docs.value,
          parsingDocs: () => parsingDocs.value,
          removeUploadedDoc: (index) => {
            removed.push(index)
            docs.value = docs.value.filter((_, i) => i !== index)
          },
          reorderUploadedDocs: (next) => {
            docs.value = next
          },
        })
        return () =>
          h(
            ComposerEditor,
            {
              ref: editorRef,
              modelValue: text.value,
              'onUpdate:modelValue': (v: string) => { text.value = v },
              onChips: api.onChips,
            },
            {
              chip: ({ chipKey }: { chipKey: string | null }) => {
                const view = api.chipView(chipKey)
                return h('span', { class: 't-chip' }, view ? view.doc.filename : '')
              },
            }
          )
      },
    })
  )
  app.mount(host)
  const harness: Harness = {
    text,
    docs,
    parsingDocs,
    editor: () => editorRef.value as unknown as ReturnType<Harness['editor']>,
    api,
    dom: () => host.querySelector('.ProseMirror') as HTMLElement,
    chipLabels: () => Array.from(host.querySelectorAll('.t-chip')).map(el => el.textContent),
    removed,
    unmount: () => { app.unmount(); host.remove() },
  }
  mounted.push(harness)
  return harness
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await nextTick()
}

function pressKey(el: HTMLElement, init: KeyboardEventInit) {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('文件胶囊接线', () => {
  it('新文件进来：光标处多一枚胶囊，文字里是占位字符', async () => {
    const h1 = mountHarness('看看 ')
    await settle()
    h1.docs.value = [doc('a.pdf')]
    await settle()
    expect(h1.text.value).toBe(`看看 ${CHIP}`)
    expect(h1.chipLabels()).toEqual(['a.pdf'])
  })

  it('一次进来几个文件：依次排在同一处', async () => {
    const h1 = mountHarness('ab')
    await settle()
    h1.editor().setCursor(1)
    h1.docs.value = [doc('a.pdf'), doc('b.pdf')]
    await settle()
    expect(h1.text.value).toBe(`a${CHIP}${CHIP}b`)
    expect(h1.chipLabels()).toEqual(['a.pdf', 'b.pdf'])
  })

  it('记过落点：胶囊落在落点而不是光标处', async () => {
    const h1 = mountHarness('hello')
    await settle()
    h1.editor().setCursor(0)
    h1.editor().markAnchor('end')
    h1.docs.value = [doc('a.pdf')]
    await settle()
    expect(h1.text.value).toBe(`hello${CHIP}`)
  })

  it('文字中间插入的文件排到列表对应位置（文件顺序跟文字走）', async () => {
    const h1 = mountHarness('')
    await settle()
    h1.docs.value = [doc('A')]
    await settle()
    h1.editor().setCursor(0)
    h1.docs.value = [...h1.docs.value, doc('B')]
    await settle()
    expect(h1.text.value).toBe(`${CHIP}${CHIP}`)
    expect(h1.chipLabels()).toEqual(['B', 'A'])
    expect(h1.docs.value.map(d => d.filename)).toEqual(['B', 'A'])
  })

  it('用户删掉胶囊：先选中、再按一次才删，文件一并撤下', async () => {
    const h1 = mountHarness('x')
    await settle()
    h1.docs.value = [doc('a.pdf')]
    await settle()
    h1.editor().focus()
    pressKey(h1.dom(), { key: 'Backspace' })
    await settle()
    // 第一下只选中
    expect(h1.docs.value).toHaveLength(1)
    expect(h1.dom().querySelector('.ProseMirror-selectednode')).not.toBeNull()
    pressKey(h1.dom(), { key: 'Backspace' })
    await settle()
    expect(h1.docs.value).toHaveLength(0)
    expect(h1.text.value).toBe('x')
  })

  it('撤销把已删文件的胶囊带回来：没有文件可对，胶囊不留', async () => {
    const h1 = mountHarness('x')
    await settle()
    h1.docs.value = [doc('a.pdf')]
    await settle()
    h1.editor().focus()
    pressKey(h1.dom(), { key: 'Backspace' })
    pressKey(h1.dom(), { key: 'Backspace' })
    await settle()
    expect(h1.docs.value).toHaveLength(0)
    pressKey(h1.dom(), { key: 'z', ctrlKey: true })
    pressKey(h1.dom(), { key: 'z', metaKey: true })
    await settle()
    expect(h1.docs.value).toHaveLength(0)
    expect(h1.chipLabels()).toEqual([])
    expect(h1.text.value).toBe('x')
  })

  it('点 ×：胶囊与文件一起撤下', async () => {
    const h1 = mountHarness('')
    await settle()
    h1.docs.value = [doc('a.pdf'), doc('b.pdf')]
    await settle()
    const key = h1.editor().getChipKeys()[0]
    h1.api.removeChip(key)
    await settle()
    expect(h1.docs.value.map(d => d.filename)).toEqual(['b.pdf'])
    expect(h1.chipLabels()).toEqual(['b.pdf'])
  })

  it('文件列表被外部清空：胶囊消失，不当作用户操作', async () => {
    const h1 = mountHarness('hi ')
    await settle()
    h1.docs.value = [doc('a.pdf')]
    await settle()
    h1.docs.value = []
    await settle()
    expect(h1.text.value).toBe('hi ')
    expect(h1.removed).toEqual([])
  })

  it('外部把带占位字符的文字装回来：按先后重新对上文件', async () => {
    const h1 = mountHarness('', [doc('A'), doc('B')])
    await settle()
    // 挂载时没有胶囊：两个文件各插一枚
    expect(h1.chipLabels()).toEqual(['A', 'B'])
    h1.text.value = `先看${CHIP}再看${CHIP}`
    await settle()
    expect(h1.chipLabels()).toEqual(['A', 'B'])
    expect(h1.docs.value.map(d => d.filename)).toEqual(['A', 'B'])
  })

  it('外部清空文字（发送时）不会撤掉文件', async () => {
    const h1 = mountHarness('')
    await settle()
    h1.docs.value = [doc('a.pdf')]
    await settle()
    h1.text.value = ''
    await settle()
    expect(h1.docs.value).toHaveLength(1)
    expect(h1.removed).toEqual([])
  })

  it('多出来的占位字符（没有对应文件）被清掉', async () => {
    const h1 = mountHarness(`a${CHIP}b${CHIP}`, [doc('only')])
    await settle()
    expect(h1.chipLabels()).toEqual(['only'])
    expect(h1.text.value).toBe(`a${CHIP}b`)
  })

  it('解析中的文件先占位，解析好后还是同一枚胶囊', async () => {
    const h1 = mountHarness('ab')
    await settle()
    h1.editor().setCursor(1)
    h1.parsingDocs.value = [parsing('big.pdf')]
    await settle()
    expect(h1.text.value).toBe(`a${CHIP}b`)
    const keyBefore = h1.editor().getChipKeys()[0]
    expect(keyBefore).toBe('p:r1:0')

    // 用户在解析期间继续打字，胶囊位置跟着文字走
    h1.editor().setCursor(0)
    h1.text.value = `X${h1.text.value}`
    await settle()

    h1.docs.value = [doc('big.pdf')]
    h1.parsingDocs.value = []
    await settle()
    expect(h1.editor().getChipKeys()).toEqual([keyBefore])
    expect(h1.text.value).toBe(`Xa${CHIP}b`)
    expect(h1.chipLabels()).toEqual(['big.pdf'])
  })

  it('解析失败的小条自己消失时，不会误删别的文件', async () => {
    const h1 = mountHarness('')
    await settle()
    h1.docs.value = [doc('ok.pdf')]
    h1.parsingDocs.value = [parsing('bad.pdf', 1)]
    await settle()
    expect(h1.chipLabels()).toHaveLength(2)
    h1.parsingDocs.value = []
    await settle()
    expect(h1.docs.value.map(d => d.filename)).toEqual(['ok.pdf'])
    expect(h1.chipLabels()).toEqual(['ok.pdf'])
  })

  it('解析中就撤掉胶囊：解析完文件也不留', async () => {
    const h1 = mountHarness('')
    await settle()
    h1.parsingDocs.value = [parsing('big.pdf')]
    await settle()
    h1.api.removeChip(h1.editor().getChipKeys()[0])
    await settle()
    expect(h1.chipLabels()).toEqual([])
    h1.docs.value = [doc('big.pdf')]
    h1.parsingDocs.value = []
    await settle()
    expect(h1.docs.value).toHaveLength(0)
    expect(h1.chipLabels()).toEqual([])
  })

  it('粘贴进来的占位字符不会变成胶囊', async () => {
    const h1 = mountHarness('')
    await settle()
    h1.editor().focus()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? `a${CHIP}b` : ''), files: [], items: [], types: ['text/plain'] },
    })
    h1.dom().dispatchEvent(event)
    await settle()
    expect(h1.text.value).toBe('ab')
  })
})
