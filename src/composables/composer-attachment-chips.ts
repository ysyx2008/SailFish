/**
 * 输入框文件胶囊 ←→ 附件列表 的对账规则（纯函数，不碰 DOM 与 Vue）。
 *
 * 胶囊（文字里的位置）与附件（列表里的文件）靠 key 一一对应。
 * 这里只回答「该怎么调胶囊才能对上」，调不调、谁来调由外层决定。
 */
import { COMPOSER_CHIP_CHAR } from './composer-editor-text'

export interface ChipPlan {
  /** 把还没对上文件的胶囊（按文字先后的下标）绑到某个文件 */
  bind: { index: number; key: string }[]
  /** 要删掉的胶囊下标：文件已不在了 / 重复 / 没有文件可对 */
  remove: number[]
  /** 还没有胶囊的文件，需要新插入（按附件顺序） */
  insert: string[]
}

/**
 * @param chipKeys 文字里各胶囊的 key（按文字先后；null = 还没对上）
 * @param itemIds  当前所有附件的 id（按附件顺序）
 */
export function planChipSync(chipKeys: (string | null)[], itemIds: string[]): ChipPlan {
  const valid = new Set(itemIds)
  const claimed = new Set<string>()
  const remove: number[] = []
  const unbound: number[] = []

  chipKeys.forEach((key, index) => {
    if (key == null) {
      unbound.push(index)
      return
    }
    // 文件没了，或同一个文件已有另一枚胶囊
    if (!valid.has(key) || claimed.has(key)) {
      remove.push(index)
      return
    }
    claimed.add(key)
  })

  // 没对上的胶囊（如重新装回草稿文字）按先后顺序认领还没胶囊的文件
  const free = itemIds.filter(id => !claimed.has(id))
  const bind: { index: number; key: string }[] = []
  for (const index of unbound) {
    const key = free.shift()
    if (key == null) remove.push(index)
    else bind.push({ index, key })
  }

  return {
    bind,
    remove: remove.sort((a, b) => a - b),
    insert: free,
  }
}

export function isEmptyPlan(plan: ChipPlan): boolean {
  return plan.bind.length === 0 && plan.remove.length === 0 && plan.insert.length === 0
}

/**
 * 附件列表的顺序与胶囊在文字里的先后不一致时，给出应有的顺序（按 id）；一致则返回 null。
 * 没有胶囊的文件排在最后，保持原有相对顺序。
 */
export function orderIdsByChips(ids: string[], chipKeys: (string | null)[]): string[] | null {
  const present = new Set(ids)
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const key of chipKeys) {
    if (key != null && present.has(key) && !seen.has(key)) {
      ordered.push(key)
      seen.add(key)
    }
  }
  for (const id of ids) if (!seen.has(id)) ordered.push(id)
  return ordered.every((id, i) => id === ids[i]) ? null : ordered
}

/** 用户删掉了哪些胶囊：之前对上文件的 key 里，现在少了的（按出现次数比较） */
export function removedChipKeys(before: string[], after: (string | null)[]): string[] {
  const left = new Map<string, number>()
  for (const key of after) if (key != null) left.set(key, (left.get(key) ?? 0) + 1)
  const removed: string[] = []
  for (const key of before) {
    const n = left.get(key) ?? 0
    if (n > 0) left.set(key, n - 1)
    else removed.push(key)
  }
  return removed
}

export function boundKeys(keys: (string | null)[]): string[] {
  return keys.filter((k): k is string => k != null)
}

// ---------------------------------------------------------------------------
// 文字里的胶囊 ←→ 给模型看的文本
// ---------------------------------------------------------------------------

/**
 * 发送时把占位字符换成每个文件的标记文本。
 * @param labels 各胶囊对应的标记文本（按文字先后）；缺的（胶囊没对上文件）当作没有
 */
export function chipsToMarkers(text: string, labels: (string | null)[]): string {
  let index = 0
  return text.replace(new RegExp(COMPOSER_CHIP_CHAR, 'g'), () => labels[index++] ?? '')
}

/**
 * 取回草稿 / 编辑排队消息时反过来：把文字里恰好是某个文件标记的地方还原成占位字符。
 * 标记按附件顺序逐个认领（同名文件的标记文本相同，出现一次认领一个）；没有对应文件的标记原样保留。
 */
export function markersToChips(text: string, markers: string[]): string {
  let result = ''
  let cursor = 0
  for (const marker of markers) {
    if (!marker) continue
    const at = text.indexOf(marker, cursor)
    if (at < 0) continue
    result += text.slice(cursor, at) + COMPOSER_CHIP_CHAR
    cursor = at + marker.length
  }
  return result + text.slice(cursor)
}
