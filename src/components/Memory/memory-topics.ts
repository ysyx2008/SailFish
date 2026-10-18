/**
 * 记忆列表里每项下面那一行：这份记忆讲了哪几个主题。
 * 记忆按「标题行 + 内容」分段，取标题行即可。
 */
export function memoryTopics(content: string, limit = 4): string[] {
  const headings: Array<{ level: number; text: string }> = []
  let inFence = false
  for (const line of content.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const match = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line)
    if (match) headings.push({ level: match[1].length, text: match[2] })
  }
  // 顶上的总标题（一级）不算主题；其余取最浅的那一层，子标题不挤占名额
  const deeper = headings.filter(h => h.level >= 2)
  const topLevel = Math.min(...(deeper.length > 0 ? deeper : headings).map(h => h.level))
  const picked = (deeper.length > 0 ? deeper : headings).filter(h => h.level === topLevel)
  return picked.slice(0, limit).map(h => h.text)
}
