/**
 * 把已发出的一句话里的「[附件：名称]」标记对回各个附件，让气泡里的文件和输入框一样嵌在句子里。
 *
 * 只做精确还原（发送时怎么写的，这里就怎么认），不做模糊识别：
 * 附件按先后逐个认领文字里的标记；找不到标记的附件原样留在 rest，由外层照旧排在气泡下方。
 */
export type InlineSegment<F> = { type: 'text'; text: string } | { type: 'file'; file: F }

export interface InlineSplit<F> {
  segments: InlineSegment<F>[]
  /** 没能对上位置的附件 */
  rest: F[]
  /** 是否至少有一个附件嵌进了句子 */
  hasInline: boolean
}

/**
 * @param markersFor 某个附件可能对应的标记文本（不同界面语言各一种写法）
 */
export function splitMessageByAttachments<F>(
  text: string,
  files: F[],
  markersFor: (file: F) => string[],
): InlineSplit<F> {
  const segments: InlineSegment<F>[] = []
  const rest: F[] = []
  let cursor = 0
  for (const file of files) {
    let best: { at: number; length: number } | null = null
    for (const marker of markersFor(file)) {
      if (!marker) continue
      const at = text.indexOf(marker, cursor)
      if (at >= 0 && (!best || at < best.at)) best = { at, length: marker.length }
    }
    if (!best) {
      rest.push(file)
      continue
    }
    if (best.at > cursor) segments.push({ type: 'text', text: text.slice(cursor, best.at) })
    segments.push({ type: 'file', file })
    cursor = best.at + best.length
  }
  if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) })
  const hasInline = segments.some(s => s.type === 'file')
  return { segments: hasInline ? segments : [{ type: 'text', text }], rest, hasInline }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 标题等纯文字场合：把标记还原成文件名本身（「[附件：a.pdf]」→「a.pdf」）。
 * @param renderMarker 给定名称，写出某一种界面语言下的标记（按各语言各调一次）
 */
export function markersToFileNames(text: string, renderMarkers: ((name: string) => string)[]): string {
  const SENTINEL = '\u0000'
  let result = text
  for (const render of renderMarkers) {
    const [prefix, suffix] = render(SENTINEL).split(SENTINEL)
    if (prefix === undefined || suffix === undefined) continue
    result = result.replace(new RegExp(`${escapeRegExp(prefix)}(.+?)${escapeRegExp(suffix)}`, 'g'), '$1')
  }
  return result
}
