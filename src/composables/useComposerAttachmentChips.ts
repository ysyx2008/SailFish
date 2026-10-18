/**
 * 输入框里的文件胶囊：把「附件列表」和「文字里的胶囊」接起来。
 *
 * - 新文件进来（拖放 / 加号 / 粘贴）→ 在落点或光标处插一枚胶囊；解析中的文件先以进度胶囊占位，
 *   解析完仍是同一枚（位置不跳）
 * - 用户在文字里删掉胶囊 → 对应文件一并撤下
 * - 文件列表被外部清空 / 移除 → 胶囊随之消失（不当作用户操作）
 * - 附件列表的先后始终与胶囊在文字里的先后一致，重新装回草稿文字时才能按顺序对上文件
 *
 * 对账规则在 composer-attachment-chips.ts（纯函数）；这里只管接线。
 */
import { toRaw, watch, type Ref } from 'vue'
import type { ChipAnchorTarget, ChipChangeSource, ChipOps } from '../components/ComposerEditor.vue'
import {
  boundKeys,
  isEmptyPlan,
  orderIdsByChips,
  planChipSync,
  removedChipKeys,
} from './composer-attachment-chips'

export interface ChipDoc {
  filename: string
  fileType: string
  fileSize: number
  filePath?: string
  error?: string
}

export interface ChipParsingDoc {
  requestId: string
  fileIndex: number
  filename: string
  fileSize: number
}

/** 解析中的文件与解析好的文件是不是同一个（用于让胶囊从进度态原地变成正式态） */
export const isSameAttachment = (
  a: { filename: string; fileSize: number },
  b: { filename: string; fileSize: number },
) => a.filename === b.filename && a.fileSize === b.fileSize

/** 编辑器对外提供给这里用的那几个方法 */
export interface ChipEditorHandle {
  getChipKeys: () => (string | null)[]
  applyChipOps: (ops: ChipOps) => void
  markAnchor: (target: ChipAnchorTarget) => void
  clearAnchor: () => void
  containsPoint: (x: number, y: number) => boolean
}

export type ChipView<P extends ChipParsingDoc, D extends ChipDoc> =
  | { kind: 'doc'; doc: D }
  | { kind: 'parsing'; doc: P }

/** 落点记多久（够解析中的小条露出来，过期当作用户没指定位置） */
const ANCHOR_TTL_MS = 8000

const parsingId = (p: ChipParsingDoc) => `p:${p.requestId}:${p.fileIndex}`

export function useComposerAttachmentChips<D extends ChipDoc, P extends ChipParsingDoc>(options: {
  editor: Ref<ChipEditorHandle | null | undefined>
  uploadedDocs: () => D[]
  /** 已露出的、尚未变成正式文件的解析中文件 */
  parsingDocs: () => P[]
  removeUploadedDoc: (index: number) => void
  reorderUploadedDocs?: (docs: D[]) => void
  /** 新胶囊刚插进文字（用户刚把文件放进来，编辑区可以接着打字了） */
  onInserted?: () => void
}) {
  const docIds = new WeakMap<object, string>()
  let nextDocId = 1
  /** 上一次看到的解析中文件，用来认出「谁解析完变成了哪个文件」 */
  let lastParsing: { id: string; filename: string; fileSize: number }[] = []
  /** 用户已撤掉胶囊、但还在解析的文件：解析完要把文件一并丢掉 */
  const dismissed = new Set<string>()
  /** 上次对过账的、已对上文件的胶囊 key */
  let lastBound: string[] = []
  let anchorTimer: ReturnType<typeof setTimeout> | null = null

  const docId = (doc: D) => docIds.get(toRaw(doc))

  /** 给新文件发 id；刚从解析中变过来的沿用解析中的 id，胶囊不用换 */
  function refreshIds() {
    const claimed = new Set<string>()
    for (const doc of options.uploadedDocs()) {
      const raw = toRaw(doc)
      const known = docIds.get(raw)
      if (known) {
        claimed.add(known)
        continue
      }
      const from = lastParsing.find(p => !claimed.has(p.id) && isSameAttachment(p, doc))
      const id = from ? from.id : `d${nextDocId++}`
      docIds.set(raw, id)
      claimed.add(id)
    }
    lastParsing = options.parsingDocs().map(p => ({
      id: parsingId(p),
      filename: p.filename,
      fileSize: p.fileSize,
    }))
  }

  /** 某枚胶囊现在该画成什么 */
  function chipView(key: string | null): ChipView<P, D> | null {
    if (!key) return null
    for (const doc of options.uploadedDocs()) {
      if (docId(doc) === key) return { kind: 'doc', doc }
    }
    for (const p of options.parsingDocs()) {
      if (parsingId(p) === key) return { kind: 'parsing', doc: p }
    }
    return null
  }

  function reconcile() {
    const editor = options.editor.value
    if (!editor) return
    refreshIds()

    const docs = options.uploadedDocs()
    const ids = docs.map(d => docId(d) as string)

    // 撤掉过胶囊的解析中文件，现在解析完了：文件一并丢掉（列表变动后会再对一次账）
    const dead = ids.map((id, i) => (dismissed.has(id) ? i : -1)).filter(i => i >= 0)
    if (dead.length > 0) {
      dead.reverse().forEach(i => options.removeUploadedDoc(i))
      return
    }

    const parsing = options.parsingDocs().filter(p => !dismissed.has(parsingId(p)))
    const itemIds = [...ids, ...parsing.map(parsingId)]

    const plan = planChipSync(editor.getChipKeys(), itemIds)
    if (!isEmptyPlan(plan)) editor.applyChipOps({ ...plan, insertAt: 'anchor' })
    if (plan.insert.length > 0) options.onInserted?.()

    const after = editor.getChipKeys()
    const ordered = orderIdsByChips(ids, after)
    if (ordered && options.reorderUploadedDocs) {
      const byId = new Map(ids.map((id, i) => [id, docs[i]]))
      options.reorderUploadedDocs(ordered.map(id => byId.get(id) as D))
    }
    lastBound = boundKeys(editor.getChipKeys())

    const alive = new Set([...ids, ...options.parsingDocs().map(parsingId)])
    for (const id of [...dismissed]) if (!alive.has(id)) dismissed.delete(id)
  }

  /** 编辑器报告胶囊变了 */
  function onChips(keys: (string | null)[], source: ChipChangeSource) {
    if (source === 'sync') {
      lastBound = boundKeys(keys)
      return
    }
    if (source === 'user') {
      const removed = removedChipKeys(lastBound, keys)
      lastBound = boundKeys(keys)
      for (const key of removed) removeItem(key)
      // 撤销把已撤下文件的胶囊又带了回来：没有文件可对，直接清掉
      const live = new Set<string>([
        ...options.uploadedDocs().map(d => docId(d)).filter((id): id is string => !!id),
        ...options.parsingDocs().map(parsingId),
      ])
      const orphans = keys.flatMap((key, index) => (key != null && !live.has(key) ? [index] : []))
      if (orphans.length > 0) options.editor.value?.applyChipOps({ remove: orphans })
      return
    }
    // 外部整体换了文字：胶囊都成了「没对上」的，按先后重新认领
    lastBound = []
    reconcile()
  }

  /** 撤掉某个文件（用户删了它的胶囊 / 点了 ×） */
  function removeItem(key: string) {
    const index = options.uploadedDocs().findIndex(d => docId(d) === key)
    if (index >= 0) {
      options.removeUploadedDoc(index)
      return
    }
    if (options.parsingDocs().some(p => parsingId(p) === key)) {
      dismissed.add(key)
      reconcile()
    }
  }

  /** 点胶囊上的 ×：文件与胶囊一起撤下 */
  function removeChip(key: string | null) {
    if (key) removeItem(key)
  }

  /** 记下文件即将落进来的位置；落点在编辑区内取松手处，否则放文末 */
  function markDrop(point: { x: number; y: number }) {
    const editor = options.editor.value
    if (!editor) return
    editor.markAnchor(editor.containsPoint(point.x, point.y) ? point : 'end')
    if (anchorTimer) clearTimeout(anchorTimer)
    anchorTimer = setTimeout(() => {
      anchorTimer = null
      options.editor.value?.clearAnchor()
    }, ANCHOR_TTL_MS)
  }

  // 先发 id（同步，保证解析中→解析好的瞬间能认出来），再对账（等界面渲染完：外层若同时换了文字，编辑器先吃进去）
  watch(
    () => [options.uploadedDocs().slice(), options.parsingDocs().map(parsingId)] as const,
    refreshIds,
    { flush: 'sync' },
  )
  watch(
    () => [options.uploadedDocs().slice(), options.parsingDocs().map(parsingId)] as const,
    reconcile,
    { flush: 'post' },
  )

  function dispose() {
    if (anchorTimer) clearTimeout(anchorTimer)
    anchorTimer = null
  }

  return { chipView, onChips, reconcile, removeChip, markDrop, docId, dispose }
}
