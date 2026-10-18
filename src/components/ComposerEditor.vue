<script setup lang="ts">
/**
 * 输入框的编辑区。
 *
 * 对外仍像一个多行文本框：v-model 是带换行的纯文本，光标是纯文本偏移量；
 * 内部是能在文字中间放行内块的编辑器，供后续图文混排使用。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Editor, Extension } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { UndoRedo, Placeholder } from '@tiptap/extensions'
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  COMPOSER_CHIP_CHAR,
  COMPOSER_CHIP_NODE,
  plainTextToDocJSON,
  docToPlainText,
  docChipKeys,
  docPosToOffset,
  offsetToDocPos,
} from '../composables/composer-editor-text'
import { AttachmentChip } from '../composables/composer-chip-node'

/** 文件胶囊的变动来源：用户编辑 / 外部整体换文字 / 外层按文件增减程序性调整 */
export type ChipChangeSource = 'user' | 'external' | 'sync'

/** 外层对胶囊提出的一批调整（下标按文字先后，对应调整前的文档） */
export interface ChipOps {
  bind?: { index: number; key: string }[]
  remove?: number[]
  /** 新胶囊的 key，依次插在同一处 */
  insert?: string[]
  /** 插在哪：落点锚点（没有则光标处） */
  insertAt?: 'anchor' | 'cursor'
}

/** 某个落点：屏幕坐标、文末，或当前光标 */
export type ChipAnchorTarget = { x: number; y: number } | 'end' | 'cursor'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  /** 要高亮的纯文本区间（斜杠命令名） */
  highlight?: { from: number; to: number } | null
}>()

const emit = defineEmits<{
  'update:modelValue': [text: string]
  /** 用户改动后：当前纯文本与光标偏移 */
  input: [payload: { text: string; cursor: number }]
  keydown: [event: KeyboardEvent]
  paste: [event: ClipboardEvent]
  compositionstart: []
  compositionend: []
  blur: []
  /** 文件胶囊的 key 列表（按文字先后；未绑定的为 null）变了 */
  chips: [keys: (string | null)[], source: ChipChangeSource]
}>()

defineSlots<{
  /** 一枚胶囊的内容；key 为空表示还没对上具体文件 */
  chip?: (props: { chipKey: string | null }) => unknown
}>()

const rootEl = ref<HTMLDivElement | null>(null)
let editor: Editor | null = null

const highlightKey = new PluginKey('composerHighlight')
const anchorKey = new PluginKey<number | null>('composerChipAnchor')
const CHIP_SYNC_META = 'composerChipSync'

interface ChipHost {
  id: number
  el: HTMLElement
  key: string | null
}
const chipHosts = shallowRef<ChipHost[]>([])
let nextHostId = 1

const chipHostCallbacks = {
  mount: (el: HTMLElement, key: string | null) => {
    chipHosts.value = [...chipHosts.value, { id: nextHostId++, el, key }]
  },
  update: (el: HTMLElement, key: string | null) => {
    chipHosts.value = chipHosts.value.map(h => (h.el === el ? { ...h, key } : h))
  },
  unmount: (el: HTMLElement) => {
    chipHosts.value = chipHosts.value.filter(h => h.el !== el)
  },
}

/** 记一个落点；之后文档怎么变，它都跟着走 */
const ChipAnchor = Extension.create({
  name: 'composerChipAnchor',
  addProseMirrorPlugins() {
    return [
      new Plugin<number | null>({
        key: anchorKey,
        state: {
          init: () => null,
          apply: (tr, value) => {
            const meta = tr.getMeta(anchorKey) as { pos: number | null } | undefined
            if (meta) return meta.pos
            return value == null ? null : tr.mapping.map(value)
          },
        },
      }),
    ]
  },
})

/** 回车换行：Shift+回车与回车一致，都另起一行（发送键由外层先行处理） */
const NewlineKeys = Extension.create({
  name: 'composerNewline',
  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => this.editor.commands.splitBlock(),
    }
  },
})

const RangeHighlight = Extension.create({
  name: 'composerRangeHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: highlightKey,
        props: {
          decorations: (state) => {
            const range = props.highlight
            if (!range || range.to <= range.from) return DecorationSet.empty
            const from = offsetToDocPos(state.doc, range.from)
            const to = offsetToDocPos(state.doc, range.to)
            if (to <= from) return DecorationSet.empty
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: 'composer-slash-token' }),
            ])
          },
        },
      }),
    ]
  },
})

function currentText(): string {
  return editor ? docToPlainText(editor.state.doc) : ''
}

function currentCursor(): number {
  if (!editor) return 0
  return docPosToOffset(editor.state.doc, editor.state.selection.from)
}

/** 外部改文字：整份换掉，清空撤销历史，光标放文末（与给文本框赋值一致） */
function applyExternalText(text: string) {
  if (!editor) return
  const view = editor.view
  const doc = view.state.schema.nodeFromJSON(plainTextToDocJSON(text))
  view.updateState(
    EditorState.create({
      doc,
      plugins: view.state.plugins,
      selection: Selection.atEnd(doc),
    })
  )
  lastChipKeys = docChipKeys(doc)
  emit('chips', lastChipKeys, 'external')
}

let lastChipKeys: (string | null)[] = []

function sameKeys(a: (string | null)[], b: (string | null)[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i])
}

function currentChipKeys(): (string | null)[] {
  return editor ? docChipKeys(editor.state.doc) : []
}

/** 记下落点（拖放松手处 / 文末 / 光标处）；文件稍后进来时胶囊插在这里 */
function markAnchor(target: ChipAnchorTarget) {
  if (!editor) return
  const { state, view } = editor
  let pos: number
  if (target === 'end') {
    pos = Selection.atEnd(state.doc).from
  } else if (target === 'cursor') {
    pos = state.selection.from
  } else {
    const hit = view.posAtCoords({ left: target.x, top: target.y })
    pos = hit ? hit.pos : Selection.atEnd(state.doc).from
    const $pos = state.doc.resolve(Math.min(pos, state.doc.content.size))
    if (!$pos.parent.inlineContent) pos = Selection.near($pos).from
  }
  view.dispatch(state.tr.setMeta(anchorKey, { pos }).setMeta('addToHistory', false))
}

function clearAnchor() {
  if (!editor || anchorKey.getState(editor.state) == null) return
  editor.view.dispatch(editor.state.tr.setMeta(anchorKey, { pos: null }).setMeta('addToHistory', false))
}

/**
 * 删掉某枚胶囊（点 ×）：与用户在文字里删掉它完全一样，进撤销历史，Cmd+Z 能找回。
 * 找不到这枚胶囊返回 false。
 */
function removeChipByKey(key: string): boolean {
  if (!editor) return false
  const { state, view } = editor
  const chipType = state.schema.nodes[COMPOSER_CHIP_NODE]
  let at = -1
  state.doc.descendants((node, pos) => {
    if (at >= 0) return false
    if (node.type === chipType && node.attrs.key === key) {
      at = pos
      return false
    }
    return true
  })
  if (at < 0) return false
  view.dispatch(state.tr.delete(at, at + 1))
  return true
}

/** 屏幕坐标是否落在编辑区内 */
function containsPoint(x: number, y: number): boolean {
  const dom = editor?.view.dom
  if (!dom) return false
  const r = dom.getBoundingClientRect()
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
}

/**
 * 外层按文件的增减，一次性调整胶囊；不当作用户输入。
 * 只有「放进新文件」这一种算一步撤销（Cmd+Z 能把这次放入撤掉），其余程序性调整不进撤销历史。
 */
function applyChipOps(ops: ChipOps) {
  if (!editor) return
  const { state, view } = editor
  const chipType = state.schema.nodes[COMPOSER_CHIP_NODE]
  const chips: number[] = []
  state.doc.descendants((node, pos) => {
    if (node.type === chipType) chips.push(pos)
  })
  const tr = state.tr
  for (const { index, key } of ops.bind ?? []) {
    const pos = chips[index]
    if (pos == null) continue
    tr.setNodeMarkup(pos, undefined, { key })
  }
  for (const index of ops.remove ?? []) {
    const pos = chips[index]
    if (pos == null) continue
    const from = tr.mapping.map(pos)
    tr.delete(from, from + 1)
  }
  const keys = ops.insert ?? []
  if (keys.length > 0) {
    const anchor = ops.insertAt === 'anchor' ? anchorKey.getState(state) : null
    const origin = Math.min(anchor ?? state.selection.from, state.doc.content.size)
    for (const key of keys) {
      tr.insert(tr.mapping.map(origin), chipType.create({ key }))
    }
    const after = tr.mapping.map(origin)
    tr.setSelection(TextSelection.near(tr.doc.resolve(after)))
    if (anchor != null) tr.setMeta(anchorKey, { pos: null })
    tr.scrollIntoView()
  }
  if (!tr.docChanged && !tr.selectionSet) return
  const onlyInsert = keys.length > 0 && !(ops.bind?.length) && !(ops.remove?.length)
  tr.setMeta('addToHistory', onlyInsert).setMeta(CHIP_SYNC_META, true)
  view.dispatch(tr)
}

/** 把纯文本按行插到当前选区（粘贴用） */
function insertPlainText(text: string) {
  if (!editor) return
  // 占位字符只属于胶囊，粘贴进来的当作不存在
  const lines = text.split(COMPOSER_CHIP_CHAR).join('').replace(/\r\n?/g, '\n').split('\n')
  // 每个换行一个段落，连续换行不合并
  const { state, view } = editor
  let tr = state.tr.deleteSelection()
  lines.forEach((line, index) => {
    if (index > 0) tr = tr.split(tr.selection.from)
    if (line) tr = tr.insertText(line)
  })
  view.dispatch(tr.scrollIntoView())
}

function hasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes('Files')
}

onMounted(() => {
  if (!rootEl.value) return
  editor = new Editor({
    element: rootEl.value,
    extensions: [
      Document,
      Paragraph,
      Text,
      UndoRedo,
      NewlineKeys,
      RangeHighlight,
      ChipAnchor,
      AttachmentChip.configure({ host: chipHostCallbacks }),
      Placeholder.configure({ placeholder: () => props.placeholder ?? '' }),
    ],
    content: plainTextToDocJSON(props.modelValue),
    editorProps: {
      attributes: { class: 'composer-editor-content', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
        emit('keydown', event)
        return event.defaultPrevented
      },
      handleDOMEvents: {
        paste: (_view, event) => {
          emit('paste', event)
          // 外层把它当附件接走了
          if (event.defaultPrevented) return true
          // 其余只收纯文本，不带格式
          const text = event.clipboardData?.getData('text/plain') ?? ''
          event.preventDefault()
          if (text) insertPlainText(text)
          return true
        },
        // 拖进来的文件交给外层的拖放处理，编辑器自己不吃
        drop: (_view, event) => hasFiles(event as DragEvent),
        dragover: (_view, event) => hasFiles(event as DragEvent),
        compositionstart: () => {
          emit('compositionstart')
          return false
        },
        compositionend: () => {
          emit('compositionend')
          return false
        },
        blur: () => {
          emit('blur')
          return false
        },
      },
    },
    onUpdate: ({ editor: e, transaction }) => {
      const text = docToPlainText(e.state.doc)
      const isSync = !!transaction.getMeta(CHIP_SYNC_META)
      emit('update:modelValue', text)
      if (!isSync) {
        emit('input', { text, cursor: docPosToOffset(e.state.doc, e.state.selection.from) })
      }
      const keys = docChipKeys(e.state.doc)
      if (!sameKeys(keys, lastChipKeys)) {
        lastChipKeys = keys
        emit('chips', keys, isSync ? 'sync' : 'user')
      }
    },
  })
  // 带着初始文字挂载时，光标放文末（与给文本框赋值一致）
  if (props.modelValue) {
    const { state, view } = editor
    view.dispatch(state.tr.setSelection(Selection.atEnd(state.doc)))
  }
  lastChipKeys = docChipKeys(editor.state.doc)
  emit('chips', lastChipKeys, 'external')
})

onBeforeUnmount(() => {
  editor?.destroy()
  editor = null
})

watch(
  () => props.modelValue,
  (value) => {
    if (value === currentText()) return
    applyExternalText(value)
  }
)

/** 占位文字、高亮区间变了但文档没变：补一个空事务让装饰重算 */
watch(
  () => [props.placeholder, props.highlight?.from, props.highlight?.to],
  () => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(highlightKey, true))
  }
)

defineExpose({
  focus: () => editor?.commands.focus(),
  getCursor: currentCursor,
  setCursor: (offset: number) => {
    if (!editor) return
    const { state, view } = editor
    const pos = offsetToDocPos(state.doc, offset)
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)))
  },
  /** 编辑区根元素（量高度、判断点击落点用） */
  getDom: () => editor?.view.dom as HTMLElement | undefined,
  getChipKeys: currentChipKeys,
  applyChipOps,
  removeChip: removeChipByKey,
  markAnchor,
  clearAnchor,
  containsPoint,
})
</script>

<template>
  <div class="composer-editor-wrap">
    <div ref="rootEl" class="composer-editor"></div>
    <!-- 每枚胶囊的内容由外层通过插槽画，搬进编辑器给它留的空壳里 -->
    <Teleport v-for="host in chipHosts" :key="host.id" :to="host.el">
      <slot name="chip" :chip-key="host.key" />
    </Teleport>
  </div>
</template>

<style scoped>
.composer-editor-wrap {
  display: block;
  width: 100%;
}

.composer-editor {
  display: block;
  width: 100%;
}

.composer-editor :deep(.composer-chip-host) {
  display: inline-flex;
  vertical-align: top;
  /* 用内边距而不是外边距：光标画在胶囊外框的边上，留白放在框里，光标才不会贴着胶囊边缘 */
  padding: 0 3px;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  cursor: default;
}

.composer-editor :deep(.ProseMirror) {
  display: block;
  width: 100%;
  padding: 7px 4px;
  font-size: 14px;
  font-family: inherit;
  color: var(--text-primary);
  background: transparent;
  border: none;
  outline: none;
  line-height: 1.4286;
  max-height: 360px;
  overflow-y: auto;
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  -webkit-user-select: text;
  user-select: text;
  cursor: text;
}

.composer-editor :deep(.ProseMirror p) {
  margin: 0;
}

.composer-editor :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
  color: var(--text-muted);
  opacity: 0.7;
}

.composer-editor :deep(.composer-slash-token) {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb), 0.14);
  border-radius: 4px;
  font-weight: 600;
}
</style>
