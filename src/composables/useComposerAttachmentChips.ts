/**
 * 输入框里的文件胶囊：把「附件列表」和「文字里的胶囊」接起来。
 *
 * - 新文件进来（拖放 / 加号 / 粘贴）→ 在落点或光标处插一枚胶囊；解析中的文件先以进度胶囊占位，
 *   解析完仍是同一枚（位置不跳）
 * - 用户在文字里删掉胶囊 → 对应文件一并撤下；撤下的文件先收着，撤销（Cmd+Z）把胶囊带回来时文件跟着回来
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

/**
 * 解析中的文件与解析好的文件是不是同一个（用于让胶囊从进度态原地变成正式态）。
 * 认文件名和大小；文件夹没有有意义的大小（拖进来时系统报的是目录项自己的字节数，解析后不再带），只认名字。
 */
export const isSameAttachment = (
  a: { filename: string; fileSize: number; fileType?: string },
  b: { filename: string; fileSize: number; fileType?: string },
) => a.filename === b.filename && (a.fileType === 'folder' || b.fileType === 'folder' || a.fileSize === b.fileSize)

/** 编辑器对外提供给这里用的那几个方法 */
export interface ChipEditorHandle {
  getChipKeys: () => (string | null)[]
  applyChipOps: (ops: ChipOps) => void
  /** 按 key 删掉一枚胶囊（走用户编辑那条路，进撤销历史）；没找到返回 false */
  removeChip: (key: string) => boolean
  markAnchor: (target: ChipAnchorTarget) => void
  clearAnchor: () => void
  containsPoint: (x: number, y: number) => boolean
}

export type ChipView<P extends ChipParsingDoc, D extends ChipDoc> =
  | { kind: 'doc'; doc: D }
  | { kind: 'parsing'; doc: P }

/** 落点记多久（够解析中的小条露出来，过期当作用户没指定位置） */
const ANCHOR_TTL_MS = 8000

/** 撤下的文件最多先收这么多份（撤销历史再长也只找得回这些） */
const REMOVED_KEEP_MAX = 20

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
  /** 用户撤下的文件（按胶囊 key）：撤销把胶囊带回来时，文件从这里还回去 */
  const removedDocs = new Map<string, D>()
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

    // 撤掉过胶囊的解析中文件，现在解析完了：文件不留在附件里，但先收着，撤销还能找回（列表变动后会再对一次账）
    const dead = ids.map((id, i) => (dismissed.has(id) ? i : -1)).filter(i => i >= 0)
    if (dead.length > 0) {
      dead.forEach(i => keepRemoved(ids[i], docs[i]))
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

  function keepRemoved(key: string, doc: D) {
    removedDocs.delete(key)
    removedDocs.set(key, toRaw(doc) as D)
    while (removedDocs.size > REMOVED_KEEP_MAX) {
      const oldest = removedDocs.keys().next().value as string
      removedDocs.delete(oldest)
    }
  }

  /**
   * 撤销 / 重做把这几枚胶囊一起带回来了：能还的文件一次还回去，返回还回去的文件 id。
   * 必须整批一起还：附件列表由外层传进来，刚还回去的文件要等界面刷新才读得到，
   * 逐枚各自「在当前列表后追加」会让后一枚把前一枚盖掉。
   */
  function reviveAll(keys: string[]): string[] {
    const present = new Set(options.uploadedDocs().map(d => docId(d)))
    const parsingNow = new Set(options.parsingDocs().map(parsingId))
    const back: { id: string; doc: D }[] = []
    for (const key of keys) {
      // 解析中就被撤下的：还在解析的话，接着解析即可
      dismissed.delete(key)
      if (parsingNow.has(key) || present.has(key) || !options.reorderUploadedDocs) continue
      const doc = removedDocs.get(key)
      if (!doc) continue
      removedDocs.delete(key)
      back.push({ id: key, doc })
    }
    if (back.length === 0 || !options.reorderUploadedDocs) return []
    // 先追加到末尾；随后对账会按胶囊在文字里的先后重新排好
    options.reorderUploadedDocs([...options.uploadedDocs(), ...back.map(b => b.doc)])
    return back.map(b => b.id)
  }

  /** 编辑器报告胶囊变了 */
  function onChips(keys: (string | null)[], source: ChipChangeSource) {
    if (source === 'sync') {
      lastBound = boundKeys(keys)
      return
    }
    if (source === 'user') {
      const before = new Set(lastBound)
      const removed = removedChipKeys(lastBound, keys)
      lastBound = boundKeys(keys)
      removeItems(removed)
      const revived = reviveAll(keys.filter((key): key is string => key != null && !before.has(key)))
      // 撤销把胶囊带了回来、却没有文件可还（已发送、已换掉文字等）：没有文件可对，直接清掉
      const live = new Set<string>([
        ...options.uploadedDocs().map(d => docId(d)).filter((id): id is string => !!id),
        ...revived,
        ...options.parsingDocs().map(parsingId),
      ])
      const orphans = keys.flatMap((key, index) => (key != null && !live.has(key) ? [index] : []))
      if (orphans.length > 0) options.editor.value?.applyChipOps({ remove: orphans })
      return
    }
    // 外部整体换了文字：撤销历史随之清空，收着的文件不会再被找回；胶囊都成了「没对上」的，按先后重新认领
    removedDocs.clear()
    lastBound = []
    reconcile()
  }

  /**
   * 撤掉一批文件（用户删了它们的胶囊 / 点了 ×）。
   * 下标都取自同一份快照、从后往前删，不依赖外层的列表什么时候刷新。
   */
  function removeItems(keys: string[]) {
    if (keys.length === 0) return
    const docs = options.uploadedDocs()
    const parsingNow = new Set(options.parsingDocs().map(parsingId))
    const indexes: number[] = []
    let dismissedParsing = false
    for (const key of keys) {
      const index = docs.findIndex(d => docId(d) === key)
      if (index >= 0) {
        keepRemoved(key, docs[index])
        indexes.push(index)
      } else if (parsingNow.has(key)) {
        dismissed.add(key)
        dismissedParsing = true
      }
    }
    indexes.sort((a, b) => b - a).forEach(index => options.removeUploadedDoc(index))
    if (dismissedParsing) reconcile()
  }

  /** 点胶囊上的 ×：文件与胶囊一起撤下；与在文字里删掉它一样可以撤销 */
  function removeChip(key: string | null) {
    if (!key) return
    if (options.editor.value?.removeChip(key)) return
    removeItems([key])
  }

  /** 换了对话 / 换了一批文件来源：之前撤销历史里的胶囊不再有文件可还 */
  function resetRemoved() {
    removedDocs.clear()
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

  return { chipView, onChips, reconcile, removeChip, markDrop, docId, resetRemoved, dispose }
}
