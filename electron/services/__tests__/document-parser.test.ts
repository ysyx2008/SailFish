/**
 * document-parser.service.ts 单元测试
 * 测试文档解析服务的核心功能
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'
import sharp from 'sharp'

// Mock Electron 模块
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

vi.mock('../pdf-text-extract.mjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pdf-text-extract.mjs')>()
  return {
    ...actual,
    extractPdfText: vi.fn(actual.extractPdfText),
  }
})

import { DocumentParserService } from '../document-parser.service'
import { extractPdfText } from '../pdf-text-extract.mjs'

describe('DocumentParserService', () => {
  let service: DocumentParserService

  beforeEach(() => {
    service = new DocumentParserService()
  })

  describe('detectFileType', () => {
    it('应该正确检测 PDF 文件', () => {
      expect(service.detectFileType('test.pdf')).toBe('pdf')
      expect(service.detectFileType('TEST.PDF')).toBe('pdf')
    })

    it('应该正确检测 Word 文件', () => {
      expect(service.detectFileType('test.docx')).toBe('docx')
      expect(service.detectFileType('test.doc')).toBe('doc')
    })

    it('应该正确检测 Excel 文件', () => {
      expect(service.detectFileType('test.xlsx')).toBe('xlsx')
      expect(service.detectFileType('test.xls')).toBe('xls')
      expect(service.detectFileType('TEST.XLSX')).toBe('xlsx')
    })

    it('应该正确检测文本类文件', () => {
      expect(service.detectFileType('test.txt')).toBe('txt')
      expect(service.detectFileType('test.md')).toBe('md')
      expect(service.detectFileType('test.json')).toBe('json')
      expect(service.detectFileType('test.xml')).toBe('xml')
      expect(service.detectFileType('test.html')).toBe('html')
      expect(service.detectFileType('test.csv')).toBe('csv')
    })

    it('应该通过 MIME 类型检测 Excel 文件', () => {
      expect(service.detectFileType('file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx')
      expect(service.detectFileType('file', 'application/vnd.ms-excel')).toBe('xls')
    })

    it('未知类型应返回 unknown', () => {
      expect(service.detectFileType('test.xyz')).toBe('unknown')
    })

    it('应该正确检测 WPS 文字和表格', () => {
      expect(service.detectFileType('报告.wps')).toBe('wps')
      expect(service.detectFileType('模板.wpt')).toBe('wps')
      expect(service.detectFileType('报表.et')).toBe('et')
      expect(service.detectFileType('表模板.ett')).toBe('et')
      expect(service.detectFileType('REPORT.WPS')).toBe('wps')
    })

    it('应该通过 MIME 类型检测 WPS 文件', () => {
      expect(service.detectFileType('file', 'application/wps-office.wps')).toBe('wps')
      expect(service.detectFileType('file', 'application/kswps')).toBe('wps')
      expect(service.detectFileType('file', 'application/wps-office.et')).toBe('et')
      expect(service.detectFileType('file', 'application/kset')).toBe('et')
    })
  })

  describe('parseDocument - Excel', () => {
    it('应该正确解析简单的 Excel 文件', async () => {
      // 创建一个临时 Excel 文件用于测试
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('测试表')
      
      // 添加表头和数据
      sheet.addRow(['姓名', '年龄', '城市'])
      sheet.addRow(['张三', 25, '北京'])
      sheet.addRow(['李四', 30, '上海'])
      
      // 保存到临时文件
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.xlsx`)
      await workbook.xlsx.writeFile(tempFile)
      
      try {
        const result = await service.parseDocument({
          name: 'test.xlsx',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        
        expect(result.fileType).toBe('xlsx')
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('测试表')
        expect(result.content).toContain('姓名')
        expect(result.content).toContain('张三')
        expect(result.content).toContain('北京')
        expect(result.pageCount).toBe(1) // 1 个工作表
      } finally {
        // 清理临时文件
        fs.unlinkSync(tempFile)
      }
    })

    it('应该处理多个工作表', async () => {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      
      const sheet1 = workbook.addWorksheet('销售数据')
      sheet1.addRow(['产品', '数量'])
      sheet1.addRow(['苹果', 100])
      
      const sheet2 = workbook.addWorksheet('库存数据')
      sheet2.addRow(['产品', '库存'])
      sheet2.addRow(['苹果', 500])
      
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-multi-${crypto.randomUUID()}.xlsx`)
      await workbook.xlsx.writeFile(tempFile)
      
      try {
        const result = await service.parseDocument({
          name: 'test.xlsx',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('销售数据')
        expect(result.content).toContain('库存数据')
        expect(result.pageCount).toBe(2)
        expect(result.metadata?.sheetCount).toBe('2')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应该处理带公式的单元格', async () => {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('公式测试')
      
      sheet.getCell('A1').value = 10
      sheet.getCell('A2').value = 20
      sheet.getCell('A3').value = { formula: 'SUM(A1:A2)', result: 30 }
      
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-formula-${crypto.randomUUID()}.xlsx`)
      await workbook.xlsx.writeFile(tempFile)
      
      try {
        const result = await service.parseDocument({
          name: 'test.xlsx',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        
        expect(result.error).toBeUndefined()
        // 应该显示公式的计算结果而不是公式本身
        expect(result.content).toContain('30')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })
  })

  describe('parseDocument - Word (.docx) 图片提取', () => {
    /**
     * 用 jszip 构造一个最小化的 .docx 文件（含正文文本 + 一张嵌入图片 + 一个表格）
     * .docx 本质是 zip，最少需要 [Content_Types].xml、word/document.xml、word/_rels/document.xml.rels、word/media/image1.png
     */
    async function createTestDocx(tempDir: string, options: {
      withImage?: boolean
      withTable?: boolean
      imageCount?: number
      emfWithEmbeddedPng?: boolean
      emfGarbage?: boolean
    } = {}): Promise<string> {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()

      const imgCount = options.imageCount ?? (options.withImage ? 1 : 0)
      const emfCount = (options.emfWithEmbeddedPng ? 1 : 0) + (options.emfGarbage ? 1 : 0)

      // 1x1 red pixel PNG（直接作为 png 嵌入时不走 EMF 筛选）
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
      const pngBuffer = Buffer.from(pngBase64, 'base64')
      const patterned = Buffer.alloc(64 * 64 * 3)
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const on = ((x >> 3) ^ (y >> 3)) & 1
          const i = (y * 64 + x) * 3
          const v = on ? 255 : 0
          patterned[i] = v
          patterned[i + 1] = v
          patterned[i + 2] = v
        }
      }
      const emfPng = await sharp(patterned, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer()
      const emfWithPng = Buffer.concat([Buffer.from([0x01, 0x00, 0x00, 0x00]), emfPng])
      const emfGarbage = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x20, 0x45, 0x4d, 0x46])

      // Content_Types
      let contentTypes = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      if (imgCount > 0) {
        contentTypes += '<Default Extension="png" ContentType="image/png"/>'
      }
      if (emfCount > 0) {
        contentTypes += '<Default Extension="emf" ContentType="image/x-emf"/>'
      }
      contentTypes += '</Types>'
      zip.file('[Content_Types].xml', contentTypes)

      // _rels/.rels
      zip.file('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
      )

      // word/_rels/document.xml.rels
      let docRels = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      for (let i = 0; i < imgCount; i++) {
        docRels += `<Relationship Id="rId${10 + i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`
      }
      if (options.emfWithEmbeddedPng) {
        docRels += '<Relationship Id="rId80" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image-emf.emf"/>'
      }
      if (options.emfGarbage) {
        docRels += '<Relationship Id="rId81" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image-junk.emf"/>'
      }
      docRels += '</Relationships>'
      zip.file('word/_rels/document.xml.rels', docRels)

      // word/document.xml — 所有命名空间声明在根元素
      const rootNs = [
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
        'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
        'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
      ].join(' ')

      let bodyContent = '<w:p><w:r><w:t>单元测试文档正文</w:t></w:r></w:p>'

      for (let i = 0; i < imgCount; i++) {
        bodyContent +=
          '<w:p><w:r><w:drawing>' +
            '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
              `<wp:extent cx="100" cy="100"/>` +
              `<wp:docPr id="${i + 1}" name="Picture ${i + 1}"/>` +
              '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
                '<pic:pic>' +
                  `<pic:nvPicPr><pic:cNvPr id="${i + 1}" name="image${i + 1}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
                  `<pic:blipFill><a:blip r:embed="rId${10 + i}"/></pic:blipFill>` +
                  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>' +
                '</pic:pic>' +
              '</a:graphicData></a:graphic>' +
            '</wp:inline>' +
          '</w:drawing></w:r></w:p>'
      }

      if (options.emfWithEmbeddedPng) {
        bodyContent +=
          '<w:p><w:r><w:drawing>' +
            '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
              '<wp:extent cx="100" cy="100"/>' +
              '<wp:docPr id="80" name="Picture EMF"/>' +
              '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
                '<pic:pic>' +
                  '<pic:nvPicPr><pic:cNvPr id="80" name="image-emf.emf"/><pic:cNvPicPr/></pic:nvPicPr>' +
                  '<pic:blipFill><a:blip r:embed="rId80"/></pic:blipFill>' +
                  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>' +
                '</pic:pic>' +
              '</a:graphicData></a:graphic>' +
            '</wp:inline>' +
          '</w:drawing></w:r></w:p>'
      }
      if (options.emfGarbage) {
        bodyContent +=
          '<w:p><w:r><w:drawing>' +
            '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
              '<wp:extent cx="100" cy="100"/>' +
              '<wp:docPr id="81" name="Picture junk"/>' +
              '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
                '<pic:pic>' +
                  '<pic:nvPicPr><pic:cNvPr id="81" name="image-junk.emf"/><pic:cNvPicPr/></pic:nvPicPr>' +
                  '<pic:blipFill><a:blip r:embed="rId81"/></pic:blipFill>' +
                  '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100" cy="100"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>' +
                '</pic:pic>' +
              '</a:graphicData></a:graphic>' +
            '</wp:inline>' +
          '</w:drawing></w:r></w:p>'
      }

      if (options.withTable) {
        bodyContent +=
          '<w:tbl>' +
          '<w:tr><w:tc><w:p><w:r><w:t>列A</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:t>列B</w:t></w:r></w:p></w:tc></w:tr>' +
          '<w:tr><w:tc><w:p><w:r><w:t>数据1</w:t></w:r></w:p></w:tc>' +
          '<w:tc><w:p><w:r><w:t>数据2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      }

      const docXml = `<?xml version="1.0" encoding="UTF-8"?><w:document ${rootNs}><w:body>${bodyContent}</w:body></w:document>`
      zip.file('word/document.xml', docXml)

      for (let i = 0; i < imgCount; i++) {
        zip.file(`word/media/image${i + 1}.png`, pngBuffer)
      }
      if (options.emfWithEmbeddedPng) {
        zip.file('word/media/image-emf.emf', emfWithPng)
      }
      if (options.emfGarbage) {
        zip.file('word/media/image-junk.emf', emfGarbage)
      }

      const tempFile = path.join(tempDir, `test-docx-${crypto.randomUUID()}.docx`)
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      fs.writeFileSync(tempFile, buf)
      return tempFile
    }

    it('extractImages=false 时不提取图片', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { withImage: true })

      try {
        const result = await service.parseDocument(
          { name: 'test.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: false }
        )
        expect(result.error).toBeUndefined()
        expect(result.fileType).toBe('docx')
        expect(result.content).toContain('单元测试文档正文')
        expect(result.images).toBeUndefined()
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('extractImages=true 时应提取嵌入图片', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { withImage: true })

      try {
        const result = await service.parseDocument(
          { name: 'test.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: true }
        )
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('单元测试文档正文')
        expect(result.images).toBeDefined()
        expect(result.images!.length).toBe(1)
        expect(result.images![0]).toMatch(/^data:image\/png;base64,/)
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('无图片的 docx，extractImages=true 不应产生 images', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { withImage: false })

      try {
        const result = await service.parseDocument(
          { name: 'test.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: true }
        )
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('单元测试文档正文')
        expect(result.images).toBeUndefined()
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应检测并记录表格数量', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { withImage: true, withTable: true })

      try {
        const result = await service.parseDocument(
          { name: 'test.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: true }
        )
        expect(result.error).toBeUndefined()
        expect(result.metadata?.tableCount).toBe('1')
        expect(result.content).toContain('列A')
        expect(result.content).toContain('数据1')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应正确提取多张图片', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { imageCount: 3 })

      try {
        const result = await service.parseDocument(
          { name: 'multi-img.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: true }
        )
        expect(result.error).toBeUndefined()
        expect(result.images).toBeDefined()
        expect(result.images!.length).toBe(3)
        result.images!.forEach(img => {
          expect(img).toMatch(/^data:image\/png;base64,/)
        })
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('EMF 内嵌 png 应转成 png data URL', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { emfWithEmbeddedPng: true })

      try {
        const result = await service.parseDocument(
          { name: 'emf.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: true }
        )
        expect(result.error).toBeUndefined()
        expect(result.images).toBeDefined()
        expect(result.images!.length).toBe(1)
        expect(result.images![0]).toMatch(/^data:image\/png;base64,/)
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('无法转换的 EMF 应丢掉，正文仍可用', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, { emfGarbage: true })

      try {
        const result = await service.parseDocument(
          { name: 'junk-emf.docx', path: tempFile, size: fs.statSync(tempFile).size },
          { extractImages: true }
        )
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('单元测试文档正文')
        expect(result.images).toBeUndefined()
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应保留 filePath', async () => {
      const tempDir = os.tmpdir()
      const tempFile = await createTestDocx(tempDir, {})

      try {
        const result = await service.parseDocument(
          { name: 'test.docx', path: tempFile, size: fs.statSync(tempFile).size }
        )
        expect(result.filePath).toBe(tempFile)
      } finally {
        fs.unlinkSync(tempFile)
      }
    })
  })

  describe('parseDocument - 通用行为', () => {
    it('文件不存在时应返回错误', async () => {
      const result = await service.parseDocument({
        name: 'nonexistent.txt',
        path: '/tmp/definitely-does-not-exist-' + crypto.randomUUID() + '.txt',
        size: 100
      })
      expect(result.error).toContain('文件不存在')
    })

    it('文件超过大小限制时应返回错误', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-size-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(tempFile, 'x')

      try {
        const result = await service.parseDocument(
          { name: 'big.txt', path: tempFile, size: 100 },
          { maxFileSize: 50 }
        )
        expect(result.skipped).toBe(true)
        expect(result.content).toContain('文件较大')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('已知类型超大文件应报错', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(tempFile, 'x')

      try {
        const result = await service.parseDocument(
          { name: 'big.txt', path: tempFile, size: 999_999_999 },
          { maxFileSize: 50 }
        )
        expect(result.skipped).toBe(true)
        expect(result.content).toContain('文件较大')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应能解析纯文本文件', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-txt-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(tempFile, '这是一段测试文本\n第二行内容')

      try {
        const result = await service.parseDocument({
          name: 'test.txt',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toBeUndefined()
        expect(result.fileType).toBe('txt')
        expect(result.content).toContain('这是一段测试文本')
        expect(result.content).toContain('第二行内容')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应能解析 Markdown 文件', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-md-${crypto.randomUUID()}.md`)
      fs.writeFileSync(tempFile, '# 标题\n\n正文内容\n\n- 列表项')

      try {
        const result = await service.parseDocument({
          name: 'test.md',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toBeUndefined()
        expect(result.fileType).toBe('md')
        expect(result.content).toContain('# 标题')
        expect(result.content).toContain('列表项')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('应能解析 JSON 文件', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-json-${crypto.randomUUID()}.json`)
      fs.writeFileSync(tempFile, JSON.stringify({ name: 'test', value: 42 }, null, 2))

      try {
        const result = await service.parseDocument({
          name: 'config.json',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toBeUndefined()
        expect(result.fileType).toBe('json')
        expect(result.content).toContain('"name"')
        expect(result.content).toContain('42')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('过长内容应被截断', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-long-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(tempFile, 'A'.repeat(500))

      try {
        const result = await service.parseDocument(
          { name: 'long.txt', path: tempFile, size: fs.statSync(tempFile).size },
          { maxTextLength: 100 }
        )
        expect(result.error).toBeUndefined()
        // 截断后内容以 100 字符 + 截断提示组成，总长度不应超过 100 + 提示文本长度
        expect(result.content).toContain('内容已截断')
        expect(result.content.indexOf('A'.repeat(100))).toBe(0)
      } finally {
        fs.unlinkSync(tempFile)
      }
    })
  })

  describe('parseDocuments - 批量解析', () => {
    it('应按顺序解析多个文件', async () => {
      const tempDir = os.tmpdir()
      const file1 = path.join(tempDir, `batch-1-${crypto.randomUUID()}.txt`)
      const file2 = path.join(tempDir, `batch-2-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(file1, '文件一内容')
      fs.writeFileSync(file2, '文件二内容')

      try {
        const results = await service.parseDocuments([
          { name: 'a.txt', path: file1, size: fs.statSync(file1).size },
          { name: 'b.txt', path: file2, size: fs.statSync(file2).size }
        ])
        expect(results).toHaveLength(2)
        expect(results[0].content).toContain('文件一内容')
        expect(results[1].content).toContain('文件二内容')
        expect(results[0].filename).toBe('a.txt')
        expect(results[1].filename).toBe('b.txt')
      } finally {
        fs.unlinkSync(file1)
        fs.unlinkSync(file2)
      }
    })

    it('批量解析中单个文件失败不应影响其他文件', async () => {
      const tempDir = os.tmpdir()
      const file1 = path.join(tempDir, `batch-ok-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(file1, '正常文件')

      try {
        const results = await service.parseDocuments([
          { name: 'ok.txt', path: file1, size: fs.statSync(file1).size },
          { name: 'bad.txt', path: '/tmp/no-such-file-' + crypto.randomUUID(), size: 100 }
        ])
        expect(results).toHaveLength(2)
        expect(results[0].error).toBeUndefined()
        expect(results[0].content).toContain('正常文件')
        expect(results[1].error).toContain('文件不存在')
      } finally {
        fs.unlinkSync(file1)
      }
    })

    it('批量解析应发送每个文件的进度事件', async () => {
      const tempDir = os.tmpdir()
      const file1 = path.join(tempDir, `batch-progress-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(file1, '进度测试')
      const events: Array<{ requestId: string; fileIndex: number; status: string; phase: string; percent: number }> = []

      try {
        const results = await service.parseDocuments([
          { name: 'ok.txt', path: file1, size: fs.statSync(file1).size },
          { name: 'missing.txt', path: '/tmp/no-such-file-' + crypto.randomUUID(), size: 100 }
        ], {
          requestId: 'test-progress',
          onProgress: (progress) => events.push(progress)
        })

        expect(results).toHaveLength(2)
        expect(events.some(e => e.requestId === 'test-progress' && e.fileIndex === 0 && e.status === 'queued')).toBe(true)
        expect(events.some(e => e.fileIndex === 1 && e.status === 'queued')).toBe(true)
        expect(events.some(e => e.fileIndex === 0 && e.status === 'completed' && e.percent === 100)).toBe(true)
        expect(events.some(e => e.fileIndex === 1 && e.status === 'failed' && e.phase === 'failed')).toBe(true)
      } finally {
        fs.unlinkSync(file1)
      }
    })
  })

  describe('parseDocument - unknown 类型智能分流', () => {
    it('未知扩展名的文本文件应自动读取内容', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.py`)
      fs.writeFileSync(tempFile, 'print("hello world")\n')

      try {
        const result = await service.parseDocument({
          name: 'script.py',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toBeUndefined()
        expect(result.fileType).toBe('unknown')
        expect(result.content).toContain('print("hello world")')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('二进制文件应返回空内容（元数据模式）', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.bin`)
      const buf = Buffer.alloc(256)
      for (let i = 0; i < 256; i++) buf[i] = i
      fs.writeFileSync(tempFile, buf)

      try {
        const result = await service.parseDocument({
          name: 'data.bin',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toBeUndefined()
        expect(result.content).toBe('')
        expect(result.filePath).toBe(tempFile)
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('小于 4 字节的文件应作为文本处理', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.dat`)
      fs.writeFileSync(tempFile, 'hi')

      try {
        const result = await service.parseDocument({
          name: 'tiny.dat',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toBeUndefined()
        expect(result.content).toBe('hi')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('unknown 类型超大文件不应报错，应走元数据模式', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.zip`)
      // 写一个含 null byte 的小文件，但声称 size 很大
      const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])
      fs.writeFileSync(tempFile, buf)

      try {
        const result = await service.parseDocument({
          name: 'archive.zip',
          path: tempFile,
          size: 999_999_999
        })
        expect(result.error).toBeUndefined()
        expect(result.content).toBe('')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('已知类型超大文件应报错', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `test-${crypto.randomUUID()}.txt`)
      fs.writeFileSync(tempFile, 'x')

      try {
        const result = await service.parseDocument(
          { name: 'big.txt', path: tempFile, size: 999_999_999 },
          { maxFileSize: 50 }
        )
        expect(result.skipped).toBe(true)
        expect(result.content).toContain('文件较大')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })
  })

  describe('formatAsContext', () => {
    it('有内容的文档应包含 path 和内容', () => {
      const result = service.formatAsContext([{
        filename: 'test.py',
        filePath: '/home/user/test.py',
        fileType: 'unknown',
        content: 'print("hello")',
        fileSize: 15,
        parseTime: 0
      }])
      expect(result).toContain('path="/home/user/test.py"')
      expect(result).toContain('print("hello")')
      expect(result).not.toContain('mode="metadata"')
    })

    it('无内容的文档应输出元数据模式', () => {
      const result = service.formatAsContext([{
        filename: 'data.zip',
        filePath: '/home/user/data.zip',
        fileType: 'unknown',
        content: '',
        fileSize: 1024 * 1024 * 15,
        parseTime: 0
      }])
      expect(result).toContain('mode="metadata"')
      expect(result).toContain('path="/home/user/data.zip"')
      expect(result).toContain('name="data.zip"')
      expect(result).toContain('size=')
    })

    it('错误文档应包含 error 属性', () => {
      const result = service.formatAsContext([{
        filename: 'broken.pdf',
        filePath: '/home/user/broken.pdf',
        fileType: 'pdf',
        content: '',
        fileSize: 100,
        parseTime: 0,
        error: '解析失败'
      }])
      expect(result).toContain('error="解析失败"')
      expect(result).toContain('path="/home/user/broken.pdf"')
    })

    it('混合文档应正确区分三种模式', () => {
      const result = service.formatAsContext([
        { filename: 'readme.md', filePath: '/a/readme.md', fileType: 'md', content: '# Hello', fileSize: 7, parseTime: 0 },
        { filename: 'app.exe', filePath: '/a/app.exe', fileType: 'unknown', content: '', fileSize: 5000, parseTime: 0 },
        { filename: 'bad.pdf', filePath: '/a/bad.pdf', fileType: 'pdf', content: '', fileSize: 100, parseTime: 0, error: '损坏' },
      ])
      expect(result).toContain('# Hello')
      expect(result).toContain('mode="metadata"')
      expect(result).toContain('error="损坏"')
    })
  })

  describe('renderPdfPages - 参数校验', () => {
    it('文件不存在时应抛出错误', async () => {
      await expect(
        service.renderPdfPages('/tmp/no-such-pdf-' + crypto.randomUUID() + '.pdf', [1])
      ).rejects.toThrow('PDF file not found')
    })

    it('空页码数组应抛出错误', async () => {
      const tempDir = os.tmpdir()
      const tempFile = path.join(tempDir, `empty-pages-${crypto.randomUUID()}.pdf`)
      fs.writeFileSync(tempFile, 'dummy')
      try {
        await expect(
          service.renderPdfPages(tempFile, [])
        ).rejects.toThrow('pageNumbers must be a non-empty array')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })
  })

  describe('parseDocument - WPS', () => {
    async function createMinimalDocx(filePath: string): Promise<void> {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()
      zip.file('[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>'
      )
      zip.file('_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>'
      )
      zip.file('word/document.xml',
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>WPS文字正文</w:t></w:r></w:p></w:body></w:document>'
      )
      fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
    }

    it('新版 WPS 文字应按 Word 抽出正文', async () => {
      const tempFile = path.join(os.tmpdir(), `test-wps-${crypto.randomUUID()}.wps`)
      await createMinimalDocx(tempFile)
      try {
        const result = await service.parseDocument({
          name: '报告.wps',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.fileType).toBe('wps')
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('WPS文字正文')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('WPS 文字模板应按 Word 抽出正文', async () => {
      const tempFile = path.join(os.tmpdir(), `test-wpt-${crypto.randomUUID()}.wpt`)
      await createMinimalDocx(tempFile)
      try {
        const result = await service.parseDocument({
          name: '模板.wpt',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.fileType).toBe('wps')
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('WPS文字正文')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('新版 WPS 表格应按 Excel 抽出正文', async () => {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('工资')
      sheet.addRow(['姓名', '金额'])
      sheet.addRow(['王五', 8000])
      const tempFile = path.join(os.tmpdir(), `test-et-${crypto.randomUUID()}.et`)
      await workbook.xlsx.writeFile(tempFile)
      try {
        const result = await service.parseDocument({
          name: '工资.et',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.fileType).toBe('et')
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('王五')
        expect(result.content).toContain('8000')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('WPS 表格模板应按 Excel 抽出正文', async () => {
      const ExcelJS = await import('exceljs')
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('模板')
      sheet.addRow(['项目', '预算'])
      sheet.addRow(['差旅', 3000])
      const tempFile = path.join(os.tmpdir(), `test-ett-${crypto.randomUUID()}.ett`)
      await workbook.xlsx.writeFile(tempFile)
      try {
        const result = await service.parseDocument({
          name: '预算.ett',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.fileType).toBe('et')
        expect(result.error).toBeUndefined()
        expect(result.content).toContain('差旅')
        expect(result.content).toContain('3000')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('老格式 WPS 文字应提示另存为 Word，不给乱码', async () => {
      const tempFile = path.join(os.tmpdir(), `legacy-wps-${crypto.randomUUID()}.wps`)
      const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00])
      fs.writeFileSync(tempFile, ole)
      try {
        const result = await service.parseDocument({
          name: '旧稿.wps',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.fileType).toBe('wps')
        expect(result.error).toMatch(/另存为 Word/)
        expect(result.content).toBe('')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('非 Office 包的 .wps 应提示另存，不把原文当正文', async () => {
      const tempFile = path.join(os.tmpdir(), `text-wps-${crypto.randomUUID()}.wps`)
      fs.writeFileSync(tempFile, '这不是WPS文档，只是普通文字')
      try {
        const result = await service.parseDocument({
          name: '假文件.wps',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.error).toMatch(/另存为 Word/)
        expect(result.content).toBe('')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })

    it('老格式 WPS 表格应提示另存为 Excel，不给乱码', async () => {
      const tempFile = path.join(os.tmpdir(), `legacy-et-${crypto.randomUUID()}.et`)
      const ole = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0x00, 0x00])
      fs.writeFileSync(tempFile, ole)
      try {
        const result = await service.parseDocument({
          name: '旧表.et',
          path: tempFile,
          size: fs.statSync(tempFile).size
        })
        expect(result.fileType).toBe('et')
        expect(result.error).toMatch(/另存为 Excel/)
        expect(result.content).toBe('')
      } finally {
        fs.unlinkSync(tempFile)
      }
    })
  })

  describe('checkCapabilities', () => {
    it('应该包含 xlsx 能力检查', async () => {
      const capabilities = await service.checkCapabilities()
      expect(capabilities).toHaveProperty('xlsx')
      expect(typeof capabilities.xlsx).toBe('boolean')
    })
  })

  describe('getSupportedTypes', () => {
    it('应该包含 Excel 类型', async () => {
      // 先初始化
      await service.checkCapabilities()
      
      const types = service.getSupportedTypes()
      const xlsxType = types.find(t => t.extension === '.xlsx')
      const xlsType = types.find(t => t.extension === '.xls')
      
      expect(xlsxType).toBeDefined()
      expect(xlsxType?.description).toContain('Excel')
      expect(xlsType).toBeDefined()
    })

    it('应该包含 WPS 文字和表格类型', async () => {
      await service.checkCapabilities()
      const types = service.getSupportedTypes()
      expect(types.find(t => t.extension === '.wps')?.description).toContain('WPS')
      expect(types.find(t => t.extension === '.wpt')?.description).toContain('WPS')
      expect(types.find(t => t.extension === '.et')?.description).toContain('WPS')
      expect(types.find(t => t.extension === '.ett')?.description).toContain('WPS')
    })
  })

  describe('parseDocument - PDF', () => {
    it('文字 PDF 应抽出正文且不报错', async () => {
      const { filePath, size, cleanup } = writeTempPdf(makeTextPdf('Hello SailFish'))
      try {
        const result = await service.parseDocument({
          name: 'hello.pdf',
          path: filePath,
          size
        })
        expect(result.fileType).toBe('pdf')
        expect(result.error).toBeUndefined()
        expect(result.content).toMatch(/Hello SailFish/)
      } finally {
        cleanup()
      }
    })

    it('有文字层时即使页里有图也不整页渲预览', async () => {
      const { filePath, size, cleanup } = writeTempPdf(makeTextPdfWithTinyImage('Hello SailFish'))
      vi.mocked(extractPdfText).mockResolvedValueOnce({
        content: 'Hello SailFish\n发票号码：123',
        pageCount: 1,
        totalPages: 1,
        pdfType: 'TextBased',
        pagesNeedingOcr: [],
        extractor: 'layout',
      })
      const renderSpy = vi.spyOn(service as unknown as { renderPdfPages: (...args: unknown[]) => Promise<unknown> }, 'renderPdfPages')
      try {
        const result = await service.parseDocument(
          { name: 'invoice-like.pdf', path: filePath, size },
          { extractImages: true }
        )
        expect(result.fileType).toBe('pdf')
        expect(result.error).toBeUndefined()
        expect(result.content).toMatch(/发票号码/)
        expect(result.images).toBeUndefined()
        expect(result.metadata?.pdfType).toBe('TextBased')
        expect(renderSpy).not.toHaveBeenCalled()
      } finally {
        renderSpy.mockRestore()
        cleanup()
      }
    })

    it('PDF 超过普通文档体积上限仍应解析，不整份跳过', async () => {
      const { filePath, cleanup } = writeTempPdf(makeTextPdf('Hello SailFish'))
      try {
        const result = await service.parseDocument(
          { name: 'big-scan.pdf', path: filePath, size: 20 * 1024 * 1024 },
          { maxFileSize: 10 * 1024 * 1024 }
        )
        expect(result.skipped).not.toBe(true)
        expect(result.error).toBeUndefined()
        expect(result.content).toMatch(/Hello SailFish/)
      } finally {
        cleanup()
      }
    })

    it('PDF 超过渲图硬上限才跳过', async () => {
      const { filePath, cleanup } = writeTempPdf(makeTextPdf('Hello SailFish'))
      try {
        const result = await service.parseDocument({
          name: 'huge.pdf',
          path: filePath,
          size: 1001 * 1024 * 1024
        })
        expect(result.skipped).toBe(true)
        expect(result.content).toContain('文件较大')
      } finally {
        cleanup()
      }
    })

    it('混合 PDF 应渲需要看图的页', async () => {
      const { filePath, size, cleanup } = writeTempPdf(makeTextPdf('封面目录'))
      vi.mocked(extractPdfText).mockResolvedValueOnce({
        content: '封面目录',
        pageCount: 78,
        totalPages: 78,
        pdfType: 'Mixed',
        pagesNeedingOcr: [3, 4, 5, 6, 7, 8],
        extractor: 'layout',
      })
      const renderSpy = vi.spyOn(
        service as unknown as { renderPdfPages: (...args: unknown[]) => Promise<unknown> },
        'renderPdfPages'
      ).mockResolvedValue({ images: ['data:image/jpeg;base64,QQ=='], totalPages: 78 })
      try {
        const result = await service.parseDocument(
          { name: 'mixed-audit.pdf', path: filePath, size },
          { extractImages: true }
        )
        expect(result.metadata?.pdfType).toBe('Mixed')
        expect(result.content).toMatch(/封面目录/)
        expect(result.images).toEqual(['data:image/jpeg;base64,QQ=='])
        expect(renderSpy).toHaveBeenCalledWith(
          filePath,
          [3, 4, 5, 6, 7],
          undefined,
          expect.any(Function)
        )
      } finally {
        renderSpy.mockRestore()
        cleanup()
      }
    })
  })
})

function writeTempPdf(pdf: Buffer): { filePath: string; size: number; cleanup: () => void } {
  const filePath = path.join(os.tmpdir(), `parse-pdf-${crypto.randomUUID()}.pdf`)
  fs.writeFileSync(filePath, pdf)
  return { filePath, size: pdf.length, cleanup: () => { try { fs.unlinkSync(filePath) } catch { /* ignore */ } } }
}

function makeTextPdf(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\n`
  return assemblePdf([
    '%PDF-1.4\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}endstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ])
}

/** 文字层 + 1×1 图：旧逻辑会因「页里有图」整页渲预览，本次改动后不应再渲。 */
function makeTextPdfWithTinyImage(text: string): Buffer {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\nq 10 0 0 10 72 700 cm /Im1 Do Q\n`
  const imageBytes = Buffer.from([255, 0, 0])
  return assemblePdf([
    '%PDF-1.4\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> >> endobj\n',
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}endstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
    Buffer.concat([
      Buffer.from(`6 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageBytes.length} >> stream\n`),
      imageBytes,
      Buffer.from('\nendstream endobj\n'),
    ]),
  ])
}

function assemblePdf(objects: Array<string | Buffer>): Buffer {
  const parts = objects.map((o) => (typeof o === 'string' ? Buffer.from(o) : o))
  const offsets: number[] = []
  let cursor = 0
  for (const part of parts) {
    offsets.push(cursor)
    cursor += part.length
  }
  const objectCount = parts.length - 1
  let xref = `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objectCount; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer << /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
  return Buffer.concat([...parts, Buffer.from(xref + trailer)])
}
