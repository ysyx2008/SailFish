/**
 * PDF 版面还原：把 pdfjs 的文本块按它在纸面上的位置拼回正文
 *
 * pdfjs 给出的文本块顺序是 PDF 内容流里的顺序，和人读的顺序不一定一致——
 * 实测一份法规，每条条文的末尾行被排在了前面，拼出来是「第二十八条 数据。
 * 第二十九条 使用价值。」这种残句。所以不能按给出的顺序拼，要按坐标还原。
 *
 * 纯函数，不碰文件和 pdfjs 实例，便于单测。
 */

/** 页眉页脚所在的上下边缘比例 */
const EDGE_BAND = 0.08

/** 边缘上的短行才算页眉页脚；相对正文行宽 */
const EDGE_SHORT_RATIO = 0.5

/** 行右端离正文右边界多近就算「这行是被排版断开的」，单位为字高的倍数 */
const CONTINUATION_SLACK = 1.6

/** 最宽的行至少要占到页宽这个比例，才认为这页存在「排到页边才换行」 */
const MIN_BODY_WIDTH_RATIO = 0.5

/**
 * @typedef {{ str: string, transform: number[], width?: number, height?: number }} PdfTextItem
 * @typedef {{ text: string, top: number, left: number, right: number, height: number }} LayoutLine
 * @typedef {{ x1: number, y1: number, x2: number, y2: number }} PageBox
 */

const CJK_RANGES = '\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef'
const CJK_RE = new RegExp(`[${CJK_RANGES}]`)
const LATIN_RE = /[A-Za-z0-9]/

const isCjk = (ch) => !!ch && CJK_RE.test(ch)
const isLatin = (ch) => !!ch && LATIN_RE.test(ch)

/**
 * 文本块的宽度。pdfjs 一定会给，但一旦缺了或是 0，拿 0 当宽度会让后面每个块
 * 都判成「离上一个很远」，于是块块之间插空格、中文被逐字割开。按字高估一个
 * 宽度，坏的方向至少是「少插空格」。
 * @param {PdfTextItem} item
 */
function widthOf(item) {
  if (item.width > 0) return item.width
  const height = item.height || 10
  const chars = [...(item.str || '')]
  return chars.reduce((sum, ch) => sum + (isCjk(ch) ? height : height * 0.5), 0)
}

/**
 * 同一行里把相邻文本块接起来。
 *
 * PDF 常把一行切成许多块，逐块补空格会把中文词割开，关键词检索首先受害；
 * 可中文之间那种明显的间隙（「第二十八条 证券…」里条号后的那一下）是排版
 * 分隔，得留住。所以按间隙大小判断，中文之间的门槛放宽到约半个字。
 * @param {PdfTextItem[]} items 已按横坐标排好
 */
function joinRow(items) {
  // 先量这一行里中文字之间惯常留多大空当。幻灯片标题常用宽字距排版，字字之间
  // 都空着，逐个补空格会把「大模型技术」拆成「大 模 型 技 术」，分词和检索都
  // 跟着坏掉。有了这个基准，只有明显超出常态的那一下才算分隔。
  const typicalCjkGap = medianOf(cjkGaps(items))

  let text = ''
  let prevRight = null

  for (const item of items) {
    const left = item.transform[4]
    const height = item.height || 10

    if (prevRight !== null) {
      const gap = left - prevRight
      const bothCjk = isCjk(text.slice(-1)) && isCjk(item.str[0])
      const threshold = bothCjk
        ? Math.max(height * 0.5, typicalCjkGap * 1.8)
        : height * 0.3
      if (gap > threshold) {
        text += ' '
      }
    }

    text += item.str
    prevRight = left + widthOf(item)
  }

  return text
}

/**
 * 行内相邻中文块之间的间隙。样本太少时不作为基准——一行里只有一处间隙时，
 * 它自己就是中位数，拿它当常态会把真正的分隔也当成字距。
 * @param {PdfTextItem[]} items
 */
function cjkGaps(items) {
  const gaps = []
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]
    const cur = items[i]
    if (isCjk(prev.str.slice(-1)) && isCjk(cur.str[0])) {
      gaps.push(cur.transform[4] - (prev.transform[4] + widthOf(prev)))
    }
  }
  return gaps.length >= 3 ? gaps : []
}

function medianOf(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 收掉中文字之间用来拉开字距的空格。
 *
 * 幻灯片标题常写成「大 模 型 技 术 前 沿」——有的是作者敲的空格，直接存在
 * PDF 文本里，排版好看但「大模型」就搜不到了。中文连写不会出现单字之间连着
 * 三个以上都隔空格的情况，所以按这个形状收，不碰「第二十八条 证券…」里那种
 * 单处分隔。
 * @param {string} text
 */
export function collapseCjkTracking(text) {
  return text.replace(
    new RegExp(`[${CJK_RANGES}](?: [${CJK_RANGES}]){2,}`, 'g'),
    run => run.replace(/ /g, '')
  )
}

/**
 * 把一页的文本块还原成若干行（已按从上到下排序）
 * @param {PdfTextItem[]} items
 * @returns {LayoutLine[]}
 */
export function buildLines(items) {
  const blocks = (items || []).filter(it => it && typeof it.str === 'string' && it.str.trim() !== '')
  /** @type {{ baseline: number, items: PdfTextItem[] }[]} */
  const rows = []

  for (const item of blocks) {
    const baseline = item.transform[5]
    const height = item.height || 10
    // 同一行的基线偶有零点几的抖动；阈值取字高的一半，够区分相邻两行
    const tolerance = Math.max(2, height * 0.5)
    const row = rows.find(r => Math.abs(r.baseline - baseline) <= tolerance)
    if (row) {
      row.items.push(item)
    } else {
      rows.push({ baseline, items: [item] })
    }
  }

  rows.sort((a, b) => b.baseline - a.baseline)

  return rows.map(row => {
    row.items.sort((a, b) => a.transform[4] - b.transform[4])
    const lefts = row.items.map(it => it.transform[4])
    const rights = row.items.map(it => it.transform[4] + widthOf(it))
    const heights = row.items.map(it => it.height || 10)
    return {
      text: collapseCjkTracking(joinRow(row.items)).trim(),
      top: row.baseline,
      left: Math.min(...lefts),
      right: Math.max(...rights),
      height: Math.max(...heights)
    }
  }).filter(line => line.text !== '')
}

/**
 * 去掉页眉页脚。
 *
 * 判据是几何的：落在页面上下边缘，并且明显比正文行短。页码、书眉都符合这个
 * 形状，而正文首行末行即使靠边也会铺到接近正文宽度。不按内容猜（比如认
 * 「第 N 页」这类写法），那种判断换个排版就失效。
 * 页边距特别窄的排版、或贴着页底的单行落款，有被误删的可能，所以删掉哪行要
 * 能说得出来——出事时得查得到，不能只是少了几个字。
 * @param {LayoutLine[]} lines
 * @param {PageBox} [pageBox] 未旋转的页面框；缺了就不去页眉页脚
 * @param {(line: LayoutLine) => void} [onStrip] 每删一行回调一次
 */
export function stripRunningHeads(lines, pageBox, onStrip) {
  const box = normalizeBox(pageBox)
  if (lines.length === 0 || !box) return lines

  const bodyWidth = quantileOf(lines.map(l => l.right - l.left), 0.5)
  if (bodyWidth <= 0) return lines

  const band = (box.y2 - box.y1) * EDGE_BAND
  const topEdge = box.y2 - band
  const bottomEdge = box.y1 + band

  return lines.filter(line => {
    const onEdge = line.top >= topEdge || line.top <= bottomEdge
    if (!onEdge) return true
    if ((line.right - line.left) >= bodyWidth * EDGE_SHORT_RATIO) return true
    onStrip?.(line)
    return false
  })
}

/**
 * 页面框必须是未旋转的那一个（pdfjs 的 page.view）。文本块坐标是绝对的用户
 * 空间坐标，不受页面旋转和裁剪影响；viewport 却已经旋转裁剪过了，拿它当尺子
 * 会在旋转页上把页面上方三分之一误当成页眉带，正文被整段删掉还不出声。
 * @param {PageBox | undefined} box
 */
function normalizeBox(box) {
  if (!box) return null
  const { x1, y1, x2, y2 } = box
  if (![x1, y1, x2, y2].every(v => Number.isFinite(v))) return null
  if (x2 <= x1 || y2 <= y1) return null
  return box
}

/** @param {number[]} values @param {number} q */
function quantileOf(values, q) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q))
  return sorted[idx]
}

/**
 * 把被排版断开的行接回整段。
 *
 * 判据同样是几何的：一行的右端顶到了正文右边界，说明它是因为排到页边才换行，
 * 下一行是它的续写；没顶到右边界的那行是段落真的结束了。中文正文每视觉行一个
 * 换行，不接回去会让一句话中间带着换行，关键词检索和切块都受影响。
 *
 * 正文右边界取各行右端的高分位数而不是最大值：页面上只要有一个比正文栏更宽
 * 的东西（越界的表格、右侧批注），最大值就被抬高，正文行于是全被判成「没排到
 * 右边界」，整页逐行断开。
 *
 * 还得先确认这页真有铺开的行：目录页、只剩一两句的末页全是短行，此时最宽的行
 * 也没铺开，照样当「顶到边界」会把本来各自成段的短句全粘成一团。给了页面框就
 * 能分辨这种页。
 * @param {LayoutLine[]} lines
 * @param {PageBox} [pageBox] 未旋转的页面框
 * @returns {string}
 */
export function joinParagraphs(lines, pageBox) {
  if (lines.length === 0) return ''

  const box = normalizeBox(pageBox)
  // 左右边界都取分位数而非极值：页面上只要有一个越界的东西，极值就被它带走
  const bodyLeft = quantileOf(lines.map(l => l.left), 0.1)
  const bodyRight = quantileOf(lines.map(l => l.right), 0.9)

  // 最宽的行都没占到页面一半，这页就没有「排到页边才换行」这回事
  if (box && bodyRight - box.x1 < (box.x2 - box.x1) * MIN_BODY_WIDTH_RATIO) {
    return lines.map(l => l.text).join('\n')
  }

  /** @type {string[]} */
  const paragraphs = []
  let current = ''

  const flush = () => {
    if (current !== '') {
      paragraphs.push(current)
      current = ''
    }
  }

  for (const line of lines) {
    // 居中行（左右留白大致相等）是标题，自成一段。长标题的右端也会逼近正文
    // 右边界，只看右端会把它和下一行粘起来
    const leftMargin = line.left - bodyLeft
    const rightMargin = bodyRight - line.right
    const centered = leftMargin > line.height
      && Math.abs(leftMargin - rightMargin) < line.height * 1.5

    if (centered) {
      flush()
      paragraphs.push(line.text)
      continue
    }

    // 续写接回去时，西文两端要留空格——中文连写不需要，但 "a long line" 接
    // "that wraps" 裸接会粘成一个词
    if (current !== '' && isLatin(current.slice(-1)) && isLatin(line.text[0])) {
      current += ' '
    }
    current += line.text
    if (line.right < bodyRight - line.height * CONTINUATION_SLACK) {
      flush()
    }
  }

  flush()
  return paragraphs.join('\n')
}

/**
 * 一页的完整还原：排序 → 去页眉页脚 → 接回段落
 * @param {PdfTextItem[]} items
 * @param {PageBox} [pageBox] 未旋转的页面框（pdfjs 的 page.view）
 * @param {(line: LayoutLine) => void} [onStrip] 删掉页眉页脚行时回调
 * @returns {string}
 */
export function reflowPage(items, pageBox, onStrip) {
  const lines = stripRunningHeads(buildLines(items), pageBox, onStrip)
  return joinParagraphs(lines, pageBox)
}

/**
 * 把 pdfjs 的 page.view 转成页面框
 * @param {number[] | undefined} view
 * @returns {PageBox | undefined}
 */
export function pageBoxFromView(view) {
  if (!Array.isArray(view) || view.length < 4) return undefined
  const [x1, y1, x2, y2] = view
  return { x1, y1, x2, y2 }
}
