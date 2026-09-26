import { describe, it, expect } from 'vitest'
import {
  formatPreviewCellValue,
  previewCellCss,
  previewTableExtent,
  renderExcelWorkbookPreviewHtml,
  type PreviewWorksheet
} from '../preview-html'

function sheet(
  name: string,
  rows: unknown[][],
  extras?: { rowCount?: number; columnCount?: number; merges?: PreviewWorksheet['merges'] }
): PreviewWorksheet {
  return {
    name,
    rowCount: extras?.rowCount ?? rows.length,
    columnCount: extras?.columnCount ?? (rows[0]?.length ?? 0),
    merges: extras?.merges,
    eachRow(_opts, cb) {
      rows.forEach((vals, i) => {
        cb({
          eachCell(_cOpts, cellCb) {
            vals.forEach((value, j) => cellCb({ value }, j + 1))
          }
        }, i + 1)
      })
    }
  }
}

describe('previewTableExtent', () => {
  it('普通表按实际大小，不截', () => {
    expect(previewTableExtent(120, 25)).toEqual({ rows: 120, cols: 25 })
    expect(previewTableExtent(0, 0)).toEqual({ rows: 0, cols: 0 })
  })

  it('超大表才截到不卡的上限', () => {
    expect(previewTableExtent(8000, 10)).toEqual({ rows: 5000, cols: 10 })
    expect(previewTableExtent(20, 200)).toEqual({ rows: 20, cols: 150 })
    expect(previewTableExtent(2000, 80)).toEqual({ rows: 1000, cols: 80 })
  })
})

describe('renderExcelWorkbookPreviewHtml', () => {
  it('空工作簿', () => {
    expect(renderExcelWorkbookPreviewHtml([])).toContain('这份工作簿是空的')
  })

  it('单表不渲染切表标签', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['A', 'B'], [1, 2]])
    ])
    expect(html).toContain('data-sheet="Sheet1"')
    expect(html).toContain('>A<')
    expect(html).toContain('data-r="1" data-c="1"')
    expect(html).not.toContain('sheet-tabs')
    expect(html).not.toContain(' hidden')
  })

  it('多表默认展示第一张，其余隐藏，底部可切', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('收入', [['x']]),
      sheet('支出', [['y']])
    ])
    expect(html).toContain('sheet-tabs')
    expect(html).toContain('data-sheet="收入"')
    expect(html).toContain('data-sheet="支出"')
    expect(html).toMatch(/sheet-pane" data-sheet="收入">/)
    expect(html).toMatch(/sheet-pane" data-sheet="支出" hidden>/)
    expect(html).toContain('sheet-tab active')
    expect(html).toContain('>x<')
    expect(html).toContain('>y<')
  })

  it('指定 activeSheet 时停在那张', () => {
    const html = renderExcelWorkbookPreviewHtml(
      [sheet('收入', [['x']]), sheet('支出', [['y']])],
      { activeSheet: '支出' }
    )
    expect(html).toMatch(/sheet-pane" data-sheet="收入" hidden>/)
    expect(html).toMatch(/sheet-pane" data-sheet="支出">/)
    expect(html).toContain('data-sheet="支出">支出</span>')
  })

  it('空表仍保留 pane，并写明是空的', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('空表', [], { rowCount: 0, columnCount: 0 }),
      sheet('有数', [['ok']])
    ])
    expect(html).toContain('class="sheet-empty"')
    expect(html).toContain('这张表是空的')
    expect(html).toContain('sheet-tabs')
    expect(html).toContain('data-sheet="空表"')
  })

  it('只有空格子的表也写明是空的，不画一片空白格', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('空白', [['', ''], ['', '']], { rowCount: 2, columnCount: 2 })
    ])
    expect(html).toContain('这张表是空的')
    expect(html).not.toContain('<table>')
  })

  it('高亮只落在当前展示的表', () => {
    const html = renderExcelWorkbookPreviewHtml(
      [sheet('A', [[1]]), sheet('B', [[2]])],
      { activeSheet: 'A', highlights: { modified: new Set(['1,1']) } }
    )
    const paneA = html.slice(html.indexOf('data-sheet="A"'), html.indexOf('data-sheet="B"'))
    const paneB = html.slice(html.indexOf('data-sheet="B"'))
    expect(paneA).toContain('class="num modified"')
    expect(paneB).not.toContain('modified')
  })

  it('横向合并只出一格并带 colspan，被盖住的格不重复画', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['标题', '', ''], [1, 2, 3]], { merges: ['A1:C1'] })
    ])
    expect(html).toContain('colspan="3"')
    expect(html).toContain('>标题<')
    const dataRow = html.match(/<td class="row-header">1<\/td>(.*?)<\/tr>/)?.[1] ?? ''
    expect(dataRow.match(/<td/g)?.length).toBe(1)
    expect(dataRow).not.toContain('<td></td>')
  })

  it('纵向合并带 rowspan，后续行跳过被盖住的格', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['类', 'a'], ['', 'b'], ['', 'c']], { merges: ['A1:A3'] })
    ])
    expect(html).toContain('rowspan="3"')
    expect(html).toContain('>类<')
    const row2 = html.match(/<td class="row-header">2<\/td>(.*?)<\/tr>/)?.[1] ?? ''
    expect(row2.match(/<td/g)?.length).toBe(1)
    expect(row2).toContain('>b<')
  })

  it('矩形合并同时带 colspan 与 rowspan', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['块', '', 'x'], ['', '', 'y']], { merges: ['A1:B2'] })
    ])
    expect(html).toContain('colspan="2"')
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('class="merged"')
    expect(html).toContain('>块<')
  })

  it('合并区能把预览列数撑开，避免标题只占一列', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', [['总表']], { columnCount: 1, merges: ['A1:D1'] })
    ])
    expect(html).toContain('<th>D</th>')
    expect(html).toContain('colspan="4"')
    expect(html).toContain('>总表<')
  })

  it('中等表整张画出，不再按 100 行 20 列截断', () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      Array.from({ length: 25 }, (_, j) => (i === 0 ? `c${j + 1}` : i * 25 + j))
    )
    const html = renderExcelWorkbookPreviewHtml([sheet('Sheet1', rows)])
    expect(html).toContain('<th>Y</th>')
    expect(html).toContain('<td class="row-header">120</td>')
    expect(html).not.toContain('显示 ')
  })

  it('列数大到会卡才截断并标明只预览了一部分', () => {
    const wide = [Array.from({ length: 151 }, (_, i) => i + 1)]
    const html = renderExcelWorkbookPreviewHtml([
      sheet('Sheet1', wide, { rowCount: 1, columnCount: 151 })
    ])
    expect(html).toContain('<th>ET</th>')
    expect(html).not.toContain('<th>EU</th>')
    expect(html).toContain('class="sheet-truncated"')
    expect(html).toContain('只预览了 150/151 列，后面没有画出来')
  })

  it('带 sheet 前缀的合并区也能解析', () => {
    const html = renderExcelWorkbookPreviewHtml([
      sheet('收入', [['合计']], { merges: ["'收入'!A1:B1"] })
    ])
    expect(html).toContain('colspan="2"')
  })
})

describe('formatPreviewCellValue', () => {
  it('文字公式原样显示', () => {
    expect(formatPreviewCellValue({ value: '=SUM(销售明细!G2:G16)' })).toBe('=SUM(销售明细!G2:G16)')
  })

  it('真正在算的公式显示值', () => {
    expect(formatPreviewCellValue({
      value: { formula: 'SUM(销售明细!G2:G16)', result: 97100 }
    })).toBe('97100')
  })

  it('文本格式的公式显示原文，不换成缓存值', () => {
    expect(formatPreviewCellValue({
      value: { formula: 'SUMIF(销售明细!B2:B16,"投资银行部",销售明细!G2:G16)', result: 38200 },
      numFmt: '@'
    })).toBe('=SUMIF(销售明细!B2:B16,"投资银行部",销售明细!G2:G16)')
    expect(formatPreviewCellValue({
      value: { formula: 'COUNT(A1:A10)', result: 15 },
      style: { quotePrefix: true }
    })).toBe('=COUNT(A1:A10)')
  })
})

describe('previewCellCss', () => {
  it('无样式不输出', () => {
    expect(previewCellCss({ value: 'x' })).toBe('')
  })

  it('字体、颜色、底色、对齐写成内联 CSS', () => {
    const css = previewCellCss({
      value: '标题',
      font: { name: '微软雅黑', size: 14, bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
      alignment: { horizontal: 'center', vertical: 'middle' }
    })
    expect(css).toContain("font-family:'微软雅黑'")
    expect(css).toContain('font-size:14pt')
    expect(css).toContain('font-weight:700')
    expect(css).toContain('color:#FFFFFF')
    expect(css).toContain('background-color:#4472C4')
    expect(css).toContain('text-align:center')
    expect(css).toContain('vertical-align:middle')
  })

  it('主题色按格子编号解析：1 是默认黑字，不是白', () => {
    const css = previewCellCss({
      value: 'x',
      font: { color: { theme: 1 } },
      fill: { fgColor: { theme: 4 } }
    })
    expect(css).toContain('color:#000000')
    expect(css).toContain('background-color:#4472C4')
  })

  it('主题色带 tint 时变浅或变深', () => {
    const css = previewCellCss({
      value: 'x',
      fill: { fgColor: { theme: 4, tint: 0.4 } }
    })
    expect(css).toMatch(/background-color:#[8A-F][0-9A-F]{5}/)
    expect(css).not.toContain('background-color:#4472C4')
  })

  it('字体名去掉引号和尖括号，避免污染 HTML', () => {
    const css = previewCellCss({
      value: 'x',
      font: { name: 'Arial";color:red' }
    })
    expect(css).toBe("font-family:'Arialcolor:red'")
  })
})

describe('renderExcelWorkbookPreviewHtml 样式', () => {
  it('格子带上字体和颜色', () => {
    const html = renderExcelWorkbookPreviewHtml([{
      name: 'Sheet1',
      rowCount: 1,
      columnCount: 1,
      eachRow(_opts, cb) {
        cb({
          eachCell(_cOpts, cellCb) {
            cellCb({
              value: '标题',
              font: { bold: true, color: { argb: 'FFFFFFFF' } },
              fill: { fgColor: { argb: 'FF2B579A' } }
            }, 1)
          }
        }, 1)
      }
    }])
    expect(html).toContain('font-weight:700')
    expect(html).toContain('color:#FFFFFF')
    expect(html).toContain('background-color:#2B579A')
    expect(html).toContain('>标题<')
  })

  it('只有底色没有字的格子也画出来，不当空表', () => {
    const html = renderExcelWorkbookPreviewHtml([{
      name: 'Sheet1',
      rowCount: 1,
      columnCount: 1,
      eachRow(_opts, cb) {
        cb({
          eachCell(_cOpts, cellCb) {
            cellCb({
              value: '',
              fill: { fgColor: { argb: 'FFFFC000' } }
            }, 1)
          }
        }, 1)
      }
    }])
    expect(html).toContain('<table>')
    expect(html).toContain('background-color:#FFC000')
    expect(html).not.toContain('这张表是空的')
  })
})

describe('renderExcelWorkbookPreviewHtml + ExcelJS', () => {
  it('从真实工作表读取合并区', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.getCell('A1').value = '标题'
    ws.mergeCells('A1:C1')
    ws.getCell('A2').value = 1
    ws.getCell('B2').value = 2
    ws.getCell('C2').value = 3

    const html = renderExcelWorkbookPreviewHtml(wb.worksheets as unknown as readonly PreviewWorksheet[])
    expect(html).toContain('colspan="3"')
    expect(html).toContain('>标题<')
    const dataRow = html.match(/<td class="row-header">1<\/td>(.*?)<\/tr>/)?.[1] ?? ''
    expect(dataRow.match(/<td/g)?.length).toBe(1)
  })

  it('从真实工作表带上字体和颜色', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    const cell = ws.getCell('A1')
    cell.value = '标题'
    cell.font = { name: '微软雅黑', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
    cell.alignment = { horizontal: 'center' }

    const html = renderExcelWorkbookPreviewHtml(wb.worksheets as unknown as readonly PreviewWorksheet[])
    expect(html).toContain("font-family:'微软雅黑'")
    expect(html).toContain('font-size:16pt')
    expect(html).toContain('font-weight:700')
    expect(html).toContain('color:#FFFFFF')
    expect(html).toContain('background-color:#4472C4')
    expect(html).toContain('text-align:center')
  })

  it('写盘再读回后预览仍带颜色', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    const cell = ws.getCell('A1')
    cell.value = '标题'
    cell.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2B579A' } }

    const buf = await wb.xlsx.writeBuffer()
    const loaded = new ExcelJS.Workbook()
    await loaded.xlsx.load(buf)

    const html = renderExcelWorkbookPreviewHtml(loaded.worksheets as unknown as readonly PreviewWorksheet[])
    expect(html).toContain('font-weight:700')
    expect(html).toContain('color:#FFFFFF')
    expect(html).toContain('background-color:#2B579A')
  })

  it('读回后默认文字色是黑，不是白', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.getCell('A1').value = '工号'
    ws.getCell('A1').font = { bold: true, color: { argb: 'FFFFFFFF' } }
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
    ws.getCell('B4').value = '老刘'
    ws.getCell('B4').alignment = { vertical: 'middle' }

    const buf = await wb.xlsx.writeBuffer()
    const loaded = new ExcelJS.Workbook()
    await loaded.xlsx.load(buf)
    const html = renderExcelWorkbookPreviewHtml(loaded.worksheets as unknown as readonly PreviewWorksheet[])
    const body = html.match(/data-r="4" data-c="2"[^>]*style="([^"]*)"/)?.[1] ?? ''
    expect(body).not.toContain('color:#FFFFFF')
    if (body.includes('color:')) expect(body).toContain('color:#000000')
    expect(html).toContain('color:#FFFFFF')
    expect(html).toContain('>老刘<')
  })

  it('文字公式列显示原文，真正在算的列显示值', async () => {
    const ExcelJS = await import('exceljs')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('统计汇总')
    ws.getCell('C1').value = '公式'
    ws.getCell('D1').value = '结果'
    ws.getCell('C2').value = '=SUM(销售明细!G2:G16)'
    ws.getCell('C2').numFmt = '@'
    ws.getCell('D2').value = { formula: 'SUM(销售明细!G2:G16)', result: 97100 }
    const asFormulaButText = ws.getCell('C3')
    asFormulaButText.value = { formula: 'COUNT(销售明细!G2:G16)', result: 15 }
    asFormulaButText.numFmt = '@'

    const buf = await wb.xlsx.writeBuffer()
    const loaded = new ExcelJS.Workbook()
    await loaded.xlsx.load(buf)
    const html = renderExcelWorkbookPreviewHtml(loaded.worksheets as unknown as readonly PreviewWorksheet[])
    expect(html).toContain('>=SUM(销售明细!G2:G16)<')
    expect(html).toContain('>=COUNT(销售明细!G2:G16)<')
    expect(html).toContain('>97100<')
    const c3 = html.match(/data-r="3" data-c="3"[^>]*>([^<]*)</)?.[1]
    expect(c3).not.toBe('15')
  })
})
