export interface PdfTextItem {
  str: string
  transform: number[]
  width?: number
  height?: number
}

export interface LayoutLine {
  text: string
  top: number
  left: number
  right: number
  height: number
}

/** 未旋转的页面框（pdfjs 的 page.view），文本块坐标与它同一坐标系 */
export interface PageBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export function collapseCjkTracking(text: string): string

export function buildLines(items: PdfTextItem[]): LayoutLine[]

export function stripRunningHeads(lines: LayoutLine[], pageBox?: PageBox): LayoutLine[]

export function joinParagraphs(lines: LayoutLine[], pageBox?: PageBox): string

export function reflowPage(items: PdfTextItem[], pageBox?: PageBox): string

export function pageBoxFromView(view: number[] | undefined): PageBox | undefined
