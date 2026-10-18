/**
 * 输入框里的「文件胶囊」节点：夹在文字中间的一个行内整块。
 *
 * 节点本身只记一个 key（对应哪个文件）；长什么样由外层的 Vue 组件画——
 * 这里只给每枚胶囊一个空壳元素，并把它的出现、换 key、消失通知出去。
 */
import { Node } from '@tiptap/core'
import { COMPOSER_CHIP_NODE } from './composer-editor-text'

export interface ChipHostCallbacks {
  mount: (el: HTMLElement, key: string | null) => void
  update: (el: HTMLElement, key: string | null) => void
  unmount: (el: HTMLElement) => void
}

/** 胶囊内标了此属性的元素（如 ×）自己处理鼠标事件，编辑器不当成选中胶囊 */
export const CHIP_ACTION_ATTR = 'data-chip-action'

export const AttachmentChip = Node.create<{ host: ChipHostCallbacks | null }>({
  name: COMPOSER_CHIP_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { host: null }
  },

  addAttributes() {
    return { key: { default: null } }
  },

  // 复制粘贴只认纯文本，胶囊不进剪贴板的 HTML
  parseHTML() {
    return []
  },

  renderHTML() {
    return ['span', { class: 'composer-chip-host' }]
  },

  // 光标紧挨着胶囊时，退格 / 向前删先选中它，再按一次才真删（防止手滑把文件删掉）
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { selection } = editor.state
        if (!selection.empty) return false
        const before = selection.$from.nodeBefore
        if (before?.type.name !== this.name) return false
        return editor.commands.setNodeSelection(selection.from - before.nodeSize)
      },
      Delete: ({ editor }) => {
        const { selection } = editor.state
        if (!selection.empty) return false
        const after = selection.$from.nodeAfter
        if (after?.type.name !== this.name) return false
        return editor.commands.setNodeSelection(selection.from)
      },
    }
  },

  addNodeView() {
    const host = this.options.host
    return ({ node }) => {
      const dom = document.createElement('span')
      dom.className = 'composer-chip-host'
      dom.contentEditable = 'false'
      host?.mount(dom, (node.attrs.key as string | null) ?? null)
      return {
        dom,
        update: (next) => {
          if (next.type.name !== COMPOSER_CHIP_NODE) return false
          host?.update(dom, (next.attrs.key as string | null) ?? null)
          return true
        },
        destroy: () => host?.unmount(dom),
        stopEvent: (event) => {
          const target = event.target as HTMLElement | null
          return !!target?.closest?.(`[${CHIP_ACTION_ATTR}]`)
        },
        ignoreMutation: () => true,
      }
    }
  },
})
