/**
 * 技能面板里方向键走到哪个标签（加号 / 星标打开的多选面板）。
 * 标签宽度随名字长短、一行排几个不固定，所以上下不能按列数算：
 * 走到上一行 / 下一行里，水平方向离得最近的那个。只算位置，不碰界面。
 */

export interface TileBox {
  left: number
  top: number
  width: number
  height: number
}

export type FlowArrowKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'

export function isFlowArrowKey(key: string): key is FlowArrowKey {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight'
}

/** 隔壁一行里离得最近的那个；没有隔壁行就留在原地 */
function nearestInAdjacentRow(index: number, boxes: ReadonlyArray<TileBox | undefined>, downward: boolean): number {
  const cur = boxes[index]
  if (!cur) return index
  // 顶边相差不到半个标签高，算同一行（分组标题会把行隔开，但不影响这个判断）
  const sameRow = Math.max(1, cur.height / 2)
  const centerX = cur.left + cur.width / 2
  const others = boxes
    .map((box, i) => ({ box, i }))
    .filter((it): it is { box: TileBox; i: number } =>
      it.box !== undefined && (downward ? it.box.top > cur.top + sameRow : it.box.top < cur.top - sameRow)
    )
  if (others.length === 0) return index
  const rowTop = downward
    ? Math.min(...others.map(it => it.box.top))
    : Math.max(...others.map(it => it.box.top))
  let best = -1
  let bestDist = Infinity
  for (const { box, i } of others) {
    if (Math.abs(box.top - rowTop) > sameRow) continue
    const dist = Math.abs(box.left + box.width / 2 - centerX)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  return best < 0 ? index : best
}

/**
 * 方向键之后高亮落在哪个标签。
 * `boxes[i]` 是第 i 个标签在屏幕上的位置（量不到的留空，上下键就不考虑它）。
 */
export function moveInFlow(index: number, key: FlowArrowKey, boxes: ReadonlyArray<TileBox | undefined>): number {
  const count = boxes.length
  if (count <= 0) return 0
  const cur = Math.max(0, Math.min(index, count - 1))
  switch (key) {
    case 'ArrowLeft':
      return Math.max(0, cur - 1)
    case 'ArrowRight':
      return Math.min(count - 1, cur + 1)
    case 'ArrowUp':
      return nearestInAdjacentRow(cur, boxes, false)
    case 'ArrowDown':
      return nearestInAdjacentRow(cur, boxes, true)
  }
}
