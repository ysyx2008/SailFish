<script setup lang="ts">
/**
 * 输入框的编辑区。
 *
 * 对外仍像一个多行文本框：v-model 是带换行的纯文本，光标是纯文本偏移量；
 * 内部是能在文字中间放行内块的编辑器，供后续图文混排使用。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Editor, Extension } from '@tiptap/core'
import Document from '@tiptap/extension-document'
import Paragraph from '@tiptap/extension-paragraph'
import Text from '@tiptap/extension-text'
import { UndoRedo, Placeholder } from '@tiptap/extensions'
import { EditorState, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import {
  plainTextToDocJSON,
  docToPlainText,
  docPosToOffset,
  offsetToDocPos,
} from '../composables/composer-editor-text'

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
}>()

const rootEl = ref<HTMLDivElement | null>(null)
let editor: Editor | null = null

const highlightKey = new PluginKey('composerHighlight')

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
}

/** 把纯文本按行插到当前选区（粘贴用） */
function insertPlainText(text: string) {
  if (!editor) return
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
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
    onUpdate: ({ editor: e }) => {
      const text = docToPlainText(e.state.doc)
      emit('update:modelValue', text)
      emit('input', { text, cursor: docPosToOffset(e.state.doc, e.state.selection.from) })
    },
  })
  // 带着初始文字挂载时，光标放文末（与给文本框赋值一致）
  if (props.modelValue) {
    const { state, view } = editor
    view.dispatch(state.tr.setSelection(Selection.atEnd(state.doc)))
  }
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
})
</script>

<template>
  <div ref="rootEl" class="composer-editor"></div>
</template>

<style scoped>
.composer-editor {
  display: block;
  width: 100%;
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
