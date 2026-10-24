/**
 * SplitPane 树形结构纯函数操作集
 *
 * 抽离自 stores/terminal.ts，让递归树操作既可在 store 内复用，
 * 也能在不依赖 vue / Pinia / window 的环境下被单元测试。
 *
 * 这里不出现任何带副作用的逻辑（IPC / store 状态变更 / i18n）；
 * i18n 化的标签函数留在 store 内（updatePaneLabels）。
 */
import type { SplitPane } from './terminal'

/**
 * 在布局中查找标记为激活的终端窗格（仅返回第一个命中的；正常情况下应只有一个）
 */
export function findActivePaneInLayout(layout: SplitPane): SplitPane | null {
  if (layout.type === 'terminal') {
    return layout.isActive ? layout : null
  }
  for (const child of layout.children || []) {
    const found = findActivePaneInLayout(child)
    if (found) return found
  }
  return null
}

/**
 * 用 `newPane` 替换布局中 id 等于 `paneId` 的节点
 * 返回是否成功替换
 */
export function replacePaneInLayout(layout: SplitPane, paneId: string, newPane: SplitPane): boolean {
  if (!layout.children) return false
  for (let i = 0; i < layout.children.length; i++) {
    if (layout.children[i].id === paneId) {
      layout.children[i] = newPane
      return true
    }
    if (replacePaneInLayout(layout.children[i], paneId, newPane)) {
      return true
    }
  }
  return false
}

/**
 * 按 id 查找节点（可能是 split 容器，也可能是 terminal 窗格）
 */
export function findPaneById(layout: SplitPane, paneId: string): SplitPane | null {
  if (layout.id === paneId) {
    return layout
  }
  for (const child of layout.children || []) {
    const found = findPaneById(child, paneId)
    if (found) return found
  }
  return null
}

/**
 * 收集布局中所有"终端窗格"叶节点
 */
export function getAllTerminalPanes(layout: SplitPane): SplitPane[] {
  if (layout.type === 'terminal') {
    return [layout]
  }
  const panes: SplitPane[] = []
  for (const child of layout.children || []) {
    panes.push(...getAllTerminalPanes(child))
  }
  return panes
}

/**
 * 把子节点的所有字段提升到父节点本身（原地修改父节点）。
 *
 * 用于 split 容器移除其中一个子节点后只剩一个孩子时的"层级压缩"。
 * 不能简单 Object.assign：父节点上的 children/direction 等字段，子节点没有，
 * Object.assign 不会清掉它们，会导致脏状态（terminal 节点残留 direction 字段）。
 *
 * 保留 parent.id 不变，确保 vue 渲染层 :key 引用稳定不重挂。
 */
export function liftChildIntoParent(parent: SplitPane, child: SplitPane): void {
  const parentRecord = parent as unknown as Record<string, unknown>
  const childRecord = child as unknown as Record<string, unknown>
  for (const key of Object.keys(parentRecord)) {
    if (key === 'id') continue
    delete parentRecord[key]
  }
  for (const [key, value] of Object.entries(childRecord)) {
    if (key === 'id') continue
    parentRecord[key] = value
  }
}

/**
 * 从布局中移除 id 为 paneId 的节点。如果它的父节点移除后只剩一个子节点，
 * 该子节点会被原地提升为父节点本身（liftChildIntoParent）。
 *
 * 返回是否成功移除。
 */
export function removePaneFromLayout(layout: SplitPane, paneId: string): boolean {
  if (!layout.children) return false

  for (let i = 0; i < layout.children.length; i++) {
    if (layout.children[i].id === paneId) {
      layout.children.splice(i, 1)
      if (layout.children.length === 1) {
        liftChildIntoParent(layout, layout.children[0])
      }
      return true
    }
    if (removePaneFromLayout(layout.children[i], paneId)) {
      return true
    }
  }
  return false
}

/** 松手落在窗格的哪一条边 */
export type PaneEdge = 'left' | 'right' | 'top' | 'bottom'

export function edgeToSplit(edge: PaneEdge): {
  direction: 'horizontal' | 'vertical'
  place: 'before' | 'after'
} {
  if (edge === 'left') return { direction: 'horizontal', place: 'before' }
  if (edge === 'right') return { direction: 'horizontal', place: 'after' }
  if (edge === 'top') return { direction: 'vertical', place: 'before' }
  return { direction: 'vertical', place: 'after' }
}

export function findParentPane(layout: SplitPane, childId: string): SplitPane | null {
  for (const child of layout.children || []) {
    if (child.id === childId) return layout
    const found = findParentPane(child, childId)
    if (found) return found
  }
  return null
}

export function findPaneByPtyId(layout: SplitPane, ptyId: string): SplitPane | null {
  return getAllTerminalPanes(layout).find(p => p.ptyId === ptyId) ?? null
}

export function cloneTerminalLeaf(pane: SplitPane): SplitPane {
  return {
    id: pane.id,
    type: 'terminal',
    ptyId: pane.ptyId,
    terminalType: pane.terminalType,
    sshConfig: pane.sshConfig ? { ...pane.sshConfig } : undefined,
    sshSessionId: pane.sshSessionId,
    label: pane.label,
    isActive: pane.isActive,
    size: pane.size,
    isConnecting: pane.isConnecting,
    connectionError: pane.connectionError,
    hostKeyChanged: pane.hostKeyChanged ? { ...pane.hostKeyChanged } : undefined,
    connectAttemptId: pane.connectAttemptId
  }
}

function clearTerminalFields(node: SplitPane): void {
  delete node.ptyId
  delete node.terminalType
  delete node.sshConfig
  delete node.sshSessionId
  delete node.label
  delete node.isActive
  delete node.isConnecting
  delete node.connectionError
  delete node.hostKeyChanged
  delete node.connectAttemptId
}

export function equalizeSiblingSizes(children: SplitPane[]): void {
  if (children.length === 0) return
  const size = 100 / children.length
  for (const child of children) child.size = size
}

function nestLeafAtEdge(
  layout: SplitPane,
  target: SplitPane,
  incoming: SplitPane,
  edge: PaneEdge,
  newSplitId: string
): boolean {
  const { direction, place } = edgeToSplit(edge)
  const originalChild = cloneTerminalLeaf(target)
  originalChild.isActive = false
  incoming.isActive = true
  const children = place === 'before' ? [incoming, originalChild] : [originalChild, incoming]
  equalizeSiblingSizes(children)

  if (layout.id === target.id) {
    clearTerminalFields(layout)
    layout.type = 'split'
    layout.direction = direction
    layout.children = children
    return true
  }

  const splitContainer: SplitPane = {
    id: newSplitId,
    type: 'split',
    direction,
    size: target.size,
    children
  }
  return replacePaneInLayout(layout, target.id, splitContainer)
}

/**
 * 把 incoming 叶节点接到 target 叶的指定边。
 * 同一方向（或这一排还只有一扇）就加进这一排并均分，不对半嵌套。
 * 换方向才在那一格里切开。target 若已是整棵树的根，就地改成切开容器。
 */
export function splitLeafAtEdge(
  layout: SplitPane,
  targetPaneId: string,
  incoming: SplitPane,
  edge: PaneEdge,
  newSplitId: string
): boolean {
  const target = findPaneById(layout, targetPaneId)
  if (!target || target.type !== 'terminal') return false
  if (incoming.id === target.id) return false

  const { direction, place } = edgeToSplit(edge)
  incoming.isActive = true
  target.isActive = false

  const parent = findParentPane(layout, target.id)
  if (parent && parent.children && (parent.direction === direction || parent.children.length === 1)) {
    parent.direction = direction
    const idx = parent.children.findIndex(c => c.id === target.id)
    if (idx < 0) return false
    parent.children.splice(place === 'before' ? idx : idx + 1, 0, incoming)
    equalizeSiblingSizes(parent.children)
    return true
  }

  return nestLeafAtEdge(layout, target, incoming, edge, newSplitId)
}

function isAlreadyAtEdge(
  parent: SplitPane,
  sourceId: string,
  targetId: string,
  edge: PaneEdge
): boolean {
  const { direction, place } = edgeToSplit(edge)
  if (parent.direction !== direction || !parent.children) return false
  const si = parent.children.findIndex(c => c.id === sourceId)
  const ti = parent.children.findIndex(c => c.id === targetId)
  if (si < 0 || ti < 0) return false
  return place === 'before' ? si === ti - 1 : si === ti + 1
}

/**
 * 把已有叶节点搬到另一叶的边上。
 * 搬完后用 ptyId 再找目标——压缩层级可能改掉目标节点 id。
 */
export function movePaneToEdge(
  layout: SplitPane,
  sourcePaneId: string,
  targetPaneId: string,
  edge: PaneEdge,
  newSplitId: string
): boolean {
  if (sourcePaneId === targetPaneId) return false
  const source = findPaneById(layout, sourcePaneId)
  const target = findPaneById(layout, targetPaneId)
  if (!source || !target || source.type !== 'terminal' || target.type !== 'terminal') return false

  const sourceParent = findParentPane(layout, source.id)
  const targetParent = findParentPane(layout, target.id)
  if (
    sourceParent
    && sourceParent === targetParent
    && isAlreadyAtEdge(sourceParent, source.id, target.id, edge)
  ) {
    return false
  }

  if (
    sourceParent
    && sourceParent === targetParent
    && sourceParent.children?.length === 2
  ) {
    const { direction, place } = edgeToSplit(edge)
    const other = sourceParent.children.find(c => c.id !== source.id)
    if (!other) return false
    sourceParent.direction = direction
    sourceParent.children = place === 'before' ? [source, other] : [other, source]
    equalizeSiblingSizes(sourceParent.children)
    return true
  }

  const incoming = cloneTerminalLeaf(source)
  const targetPtyId = target.ptyId
  if (!targetPtyId) return false
  if (!removePaneFromLayout(layout, source.id)) return false

  const newTarget = layout.type === 'terminal' && layout.ptyId === targetPtyId
    ? layout
    : findPaneByPtyId(layout, targetPtyId)
  if (!newTarget) return false

  return splitLeafAtEdge(layout, newTarget.id, incoming, edge, newSplitId)
}
