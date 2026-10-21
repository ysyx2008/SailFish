/**
 * 日志和报错里怎么称呼一个 MCP 连接器地址。
 *
 * 密钥可能在查询串、路径、地址前面的账号口令里，没法靠猜哪一段是密钥，
 * 所以只留协议 + 主机 + 端口。解析不了时也不回显原文（原文里同样可能有密钥）。
 */

const UNPARSABLE = '(无法解析的地址)'
const NOT_HTTP = '(非 http(s) 地址)'

export function describeMcpEndpointForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return NOT_HTTP
    return url.origin
  } catch {
    return UNPARSABLE
  }
}

/**
 * 底层报错（如 fetch 拒绝带账号口令的地址）会把整条地址原样写进错误文字。
 * 连接时已知这条地址的确切写法，把它（原样写法和规范化写法）精确换成简称，不猜文字里哪段像密钥。
 */
export function scrubMcpEndpoint(text: string, rawUrl: string | undefined): string {
  if (!rawUrl) return text
  const label = describeMcpEndpointForLog(rawUrl)
  const known = new Set<string>([rawUrl])
  try {
    known.add(new URL(rawUrl).href)
  } catch {
    // 解析不了就只换原样写法
  }
  // 长的先换：规范化写法常是原样写法的延长（多一个结尾斜杠）
  let out = text
  for (const written of [...known].sort((a, b) => b.length - a.length)) {
    out = out.split(written).join(label)
  }
  return out
}
