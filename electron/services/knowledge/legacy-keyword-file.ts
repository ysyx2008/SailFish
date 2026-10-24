/**
 * 旧版的整本关键词索引文件（bm25-index.json）。
 *
 * 关键词检索并入向量表之后不再有人写它。留一段时间是为了换回旧版时不必重建：
 * 从旧版最后一次写它算起 7 天后清掉，释放磁盘（实测 205MB）。
 * 已经清掉的话，换回的旧版会自己把词索引补回来，只是要等一阵。
 */
import * as fs from 'fs'
import * as path from 'path'

export const LEGACY_KEYWORD_FILE = 'bm25-index.json'
/** 旧版写文件时的临时文件，恢复时会优先拿它 */
const LEGACY_TEMP_FILE = `${LEGACY_KEYWORD_FILE}.tmp`

export const LEGACY_KEYWORD_FILE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

export type LegacyKeywordFileOutcome = 'absent' | 'kept' | 'removed'

/**
 * 旧文件还在且已闲置超过宽限期就删掉。
 * 只看文件自己的修改时间：新版从不写它，所以这个时间就是旧版最后一次写它的时间。
 */
export async function retireLegacyKeywordFile(
  knowledgeDir: string,
  now: number = Date.now(),
): Promise<LegacyKeywordFileOutcome> {
  const names = [LEGACY_KEYWORD_FILE, LEGACY_TEMP_FILE]
  const present: { file: string; mtimeMs: number }[] = []
  for (const name of names) {
    const file = path.join(knowledgeDir, name)
    try {
      present.push({ file, mtimeMs: (await fs.promises.stat(file)).mtimeMs })
    } catch {
      // 不在就不在
    }
  }
  if (present.length === 0) return 'absent'

  const lastWrite = Math.max(...present.map(entry => entry.mtimeMs))
  if (now - lastWrite < LEGACY_KEYWORD_FILE_GRACE_MS) return 'kept'

  for (const entry of present) {
    await fs.promises.unlink(entry.file)
  }
  return 'removed'
}
