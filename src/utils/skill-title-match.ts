import { match } from 'pinyin-pro'

/**
 * 眼前这个标题是否对得上搜索框里的字。
 *
 * 标题原文里有这段字（不区分大小写）算对上。
 * 标题的拼音也对：全拼或每个字的声母，从某个字起连续写下去；
 * 正在打的最后一个字没写完，只要是拼音的开头也算。中间的字要写全，不能跳过。ü 写成 v 也行。
 * 空搜索算全部对上。
 */
const TITLE_PINYIN = {
  continuous: true,
  precision: 'first' as const,
  lastPrecision: 'start' as const,
  v: true,
}

export function skillTitleMatchesQuery(title: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (title.toLowerCase().includes(q)) return true
  return match(title, q, TITLE_PINYIN) != null
}
