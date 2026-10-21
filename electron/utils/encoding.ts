/**
 * Buffer 编码检测与解码工具
 *
 * 用于跨平台读取/解析"未知编码"的字节流（Windows 命令输出、文本文件等）。
 *
 * 设计哲学：与系统默认编码保持一致（"统一软件和操作系统的编码"），
 * 而不是猜测或试图强制 UTF-8。这是 Windows Terminal、VSCode terminal、
 * Conhost 等业界主流终端的标准做法。
 *
 * 检测分层（确定性优先）：
 *   1) BOM 检测 — 零误判
 *   2) UTF-8 严格校验 — 零误判，覆盖 ASCII 与显式 UTF-8 输出（如 node/python 脚本）
 *   3) 系统默认编码（Windows 走 chcp，其它平台 utf-8）— 确定值，零误判
 *
 * 为什么不用 chardet 之类的统计检测库：统计模型在短文本上极不可靠
 * （会把短 GBK 误判为 ISO-8859-7，把 windows-1252 误判为 GBK 等），
 * 而命令输出经常很短。系统默认编码是确定的，对 ANSI 程序输出永远正确。
 */
import { execSync } from 'child_process'
import iconv from 'iconv-lite'

/**
 * Windows 控制台代码页（chcp 输出的数字）→ iconv-lite 编码名映射。
 * 覆盖常见区域设置；未列出的代码页会回退到 'gbk'（中文场景兜底）。
 */
const CODE_PAGE_TO_ENCODING: Record<number, string> = {
  65001: 'utf-8',       // UTF-8
  936: 'gbk',           // 简体中文 GBK
  950: 'big5',          // 繁体中文 Big5
  932: 'shift_jis',     // 日语 Shift-JIS
  949: 'euc-kr',        // 韩语 EUC-KR
  1252: 'windows-1252', // 西欧
  1251: 'windows-1251', // 俄语
  874: 'windows-874',   // 泰语
  28591: 'iso-8859-1',  // Latin-1
}

let cachedSystemEncoding: string | null = null

/**
 * 探测系统默认 ANSI 编码（Windows 通过 chcp 命令获取活动代码页）。
 * 结果会被缓存，避免重复执行子进程。
 *
 * - macOS / Linux：永远返回 'utf-8'
 * - Windows：根据 chcp 输出映射到对应编码，未知代码页或探测失败回退 'gbk'
 *   （SailFish 的中文用户绝对主流场景，比 utf-8 兜底更不容易出错）
 */
export function getSystemEncoding(): string {
  if (cachedSystemEncoding) return cachedSystemEncoding

  if (process.platform !== 'win32') {
    cachedSystemEncoding = 'utf-8'
    return cachedSystemEncoding
  }

  try {
    // chcp 输出格式（中/英文系统通用）："Active code page: 936" / "活动代码页: 936"
    const output = execSync('chcp', {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    })
    const match = output.match(/(\d+)/)
    if (match) {
      const codePage = parseInt(match[1], 10)
      cachedSystemEncoding = CODE_PAGE_TO_ENCODING[codePage] || 'gbk'
      return cachedSystemEncoding
    }
  } catch {
    /* fallthrough to gbk */
  }

  cachedSystemEncoding = 'gbk'
  return cachedSystemEncoding
}

/**
 * 仅供测试：清除系统编码缓存。
 */
export function _resetSystemEncodingCache(): void {
  cachedSystemEncoding = null
}

/**
 * 仅供测试：直接覆盖系统编码（绕过 chcp 探测）。传 null 等价于 reset。
 */
export function _setSystemEncodingForTest(encoding: string | null): void {
  cachedSystemEncoding = encoding
}

/**
 * 验证 Buffer 是否为合法 UTF-8 编码。
 * @param allowTruncatedEnd 允许末尾的不完整多字节序列（用于部分读取/流式数据）
 */
export function isValidUtf8(buf: Buffer, allowTruncatedEnd = false): boolean {
  let i = 0
  while (i < buf.length) {
    const byte = buf[i]
    let continuationBytes: number

    if (byte <= 0x7F) {
      i++
      continue
    } else if ((byte & 0xE0) === 0xC0) {
      if (byte < 0xC2) return false
      continuationBytes = 1
    } else if ((byte & 0xF0) === 0xE0) {
      continuationBytes = 2
    } else if ((byte & 0xF8) === 0xF0) {
      if (byte > 0xF4) return false
      continuationBytes = 3
    } else {
      return false
    }

    if (i + continuationBytes >= buf.length) {
      return allowTruncatedEnd
    }

    for (let j = 1; j <= continuationBytes; j++) {
      if ((buf[i + j] & 0xC0) !== 0x80) return false
    }

    i += 1 + continuationBytes
  }
  return true
}

/**
 * 检测 Buffer 编码：BOM → UTF-8 严格校验 → 系统默认编码
 */
export function detectEncoding(buf: Buffer, allowTruncatedEnd = false): string {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf-8'
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf-16le'
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf-16be'
  if (isValidUtf8(buf, allowTruncatedEnd)) return 'utf-8'
  return getSystemEncoding()
}

/**
 * 按检测到的编码解码 Buffer，返回内容和编码名。UTF-8 BOM 会被跳过。
 */
export function decodeBuffer(buf: Buffer, allowTruncatedEnd = false): { content: string, encoding: string } {
  const encoding = detectEncoding(buf, allowTruncatedEnd)
  if (encoding === 'utf-8') {
    const start = (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) ? 3 : 0
    return { content: buf.toString('utf-8', start), encoding }
  }
  return { content: iconv.decode(buf, encoding), encoding }
}

/**
 * 末尾若是一个没写完的 UTF-8 字符，返回它占的字节数。
 * 整段都合法、或中间就有非法字节（例如 GBK）时返回 0，调用方整段解码。
 */
function incompleteUtf8TailLength(buf: Buffer): number {
  let i = 0
  while (i < buf.length) {
    const byte = buf[i]
    let continuationBytes: number
    if (byte <= 0x7F) {
      i++
      continue
    } else if ((byte & 0xE0) === 0xC0) {
      if (byte < 0xC2) return 0
      continuationBytes = 1
    } else if ((byte & 0xF0) === 0xE0) {
      continuationBytes = 2
    } else if ((byte & 0xF8) === 0xF0) {
      if (byte > 0xF4) return 0
      continuationBytes = 3
    } else {
      return 0
    }

    const available = buf.length - i - 1
    if (available < continuationBytes) {
      for (let j = 1; j <= available; j++) {
        if ((buf[i + j] & 0xC0) !== 0x80) return 0
      }
      return available + 1
    }

    for (let j = 1; j <= continuationBytes; j++) {
      if ((buf[i + j] & 0xC0) !== 0x80) return 0
    }
    i += 1 + continuationBytes
  }
  return 0
}

/**
 * 一段一段到来的字节。汉字占多个字节，段的边界可能落在字中间。
 * 没写完的字先留下，下一段补齐再解码。两股独立的输出各用一个，不能混用。
 */
export class ChunkTextDecoder {
  private tail: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): string {
    const buf = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk])
    const tailLen = incompleteUtf8TailLength(buf)
    if (tailLen === 0) {
      this.tail = Buffer.alloc(0)
      return buf.length === 0 ? '' : decodeBuffer(buf).content
    }
    this.tail = Buffer.from(buf.subarray(buf.length - tailLen))
    const complete = buf.subarray(0, buf.length - tailLen)
    return complete.length === 0 ? '' : decodeBuffer(complete).content
  }

  /** 流结束。剩下的半个字不再有后续，按整段解码。 */
  end(): string {
    if (this.tail.length === 0) return ''
    const rest = this.tail
    this.tail = Buffer.alloc(0)
    return decodeBuffer(rest).content
  }
}
