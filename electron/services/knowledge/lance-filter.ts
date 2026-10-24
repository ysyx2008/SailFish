/**
 * LanceDB / DataFusion 等值过滤。
 *
 * 当前这版会把未加反引号的驼峰列名归一成小写（`docId` → `docid`），
 * 双引号又当成字符串字面量，结果 `"docId" = '…'` 永远命中 0 行。
 * 必须用反引号包列名。lancedb-worker.js 里有一份同文，改这里要一起改。
 */
export function lanceEquals(column: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`invalid LanceDB column: ${column}`)
  }
  const escaped = String(value).replace(/'/g, "''")
  return `\`${column}\` = '${escaped}'`
}

/** 一次删多行时用。值很多就拆开，避免一条过滤长得过头。lancedb-worker.js 里有一份同文。 */
export const LANCE_IN_BATCH = 200

export function lanceIn(column: string, values: readonly string[]): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) {
    throw new Error(`invalid LanceDB column: ${column}`)
  }
  if (values.length === 0) {
    throw new Error('lanceIn requires at least one value')
  }
  const list = values.map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ')
  return `\`${column}\` IN (${list})`
}

export function lanceInBatches(column: string, values: readonly string[], batchSize = LANCE_IN_BATCH): string[] {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  const predicates: string[] = []
  for (let i = 0; i < unique.length; i += batchSize) {
    predicates.push(lanceIn(column, unique.slice(i, i + batchSize)))
  }
  return predicates
}
