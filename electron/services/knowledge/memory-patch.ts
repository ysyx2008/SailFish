/**
 * 记忆按段增量更新：模型只交改了的段落，按标题并回原文。
 *
 * 约定（与更新说明里写给模型的一致）：
 * - 每段以标题行开头；标题与现有某段相同就整段替换，不同就接在末尾
 * - 标题下只写删除标记 = 删掉那一段；正文为空不算删除（多半是没写完），原样保留
 * - 没交的段落原样保留
 * 文档为空时，交来的内容就是整份文档。
 */

/** 删掉一段的显式标记，写在标题下面 */
export const MEMORY_SECTION_DELETE_MARK = '（删除）'

interface HeadingLine {
  index: number
  level: number
  title: string
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_RE = /^\s*(```|~~~)/

function scanHeadings(lines: readonly string[]): HeadingLine[] {
  const out: HeadingLine[] = []
  let inFence = false
  lines.forEach((line, index) => {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    const m = HEADING_RE.exec(line)
    if (m) out.push({ index, level: m[1].length, title: m[2] })
  })
  return out
}

function sameTitle(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  return norm(a) === norm(b)
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start].trim()) start++
  while (end > start && !lines[end - 1].trim()) end--
  return lines.slice(start, end)
}

/** 文档里分段用的那一级标题：出现最多的那级，并列取更深的（文档标题通常只出现一次） */
function sectionLevel(headings: readonly HeadingLine[]): number | undefined {
  if (headings.length === 0) return undefined
  const counts = new Map<number, number>()
  for (const h of headings) counts.set(h.level, (counts.get(h.level) ?? 0) + 1)
  let best: number | undefined
  let bestCount = 0
  for (const [level, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && level > best)) {
      best = level
      bestCount = count
    }
  }
  return best
}

interface PatchSection {
  title: string
  level: number
  body: string[]
}

/** 以改动里最浅的一级标题为段界切开；第一个标题之前的文字没有落脚处，丢弃 */
function splitPatch(lines: readonly string[]): PatchSection[] {
  const headings = scanHeadings(lines)
  if (headings.length === 0) return []
  const level = Math.min(...headings.map(h => h.level))
  const bounds = headings.filter(h => h.level === level)
  return bounds.map((h, i) => {
    const end = i + 1 < bounds.length ? bounds[i + 1].index : lines.length
    return { title: h.title, level, body: trimBlankEdges(lines.slice(h.index + 1, end)) }
  })
}

/**
 * 把一份改动并进当前文档。
 * @returns 合并后的文档；改动无法落脚（非空文档却没有任何标题）时返回 null
 */
export function mergeMemoryPatch(current: string, patch: string): string | null {
  const patchText = patch.trim()
  if (!patchText) return null
  if (!current.trim()) return `${patchText}\n`

  const sections = splitPatch(patchText.split(/\r?\n/))
  if (sections.length === 0) return null

  let lines = current.replace(/\s+$/, '').split(/\r?\n/)
  for (const section of sections) {
    if (section.body.length === 0) continue
    const remove = section.body.length === 1 && section.body[0].trim() === MEMORY_SECTION_DELETE_MARK
    const headings = scanHeadings(lines)
    const hit = headings.find(h => sameTitle(h.title, section.title))
    if (hit) {
      const next = headings.find(h => h.index > hit.index && h.level <= hit.level)
      const end = next ? next.index : lines.length
      const replacement = remove ? [] : [lines[hit.index], ...section.body, '']
      lines = [...lines.slice(0, hit.index), ...replacement, ...lines.slice(end)]
    } else if (!remove) {
      const level = sectionLevel(headings) ?? section.level
      lines = [...trimBlankEdges(lines), '', `${'#'.repeat(level)} ${section.title}`, ...section.body]
    }
  }

  return `${trimBlankEdges(lines).join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

/** 从模型回复里取出各份记忆的改动：只认首尾完整的块，被截断的那份不算 */
export function parseMemoryBlocks(response: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /<memory\s+id\s*=\s*["']?([^"'\s>]+)["']?\s*>([\s\S]*?)<\/memory>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(response)) !== null) {
    out.set(m[1].trim(), m[2])
  }
  return out
}
