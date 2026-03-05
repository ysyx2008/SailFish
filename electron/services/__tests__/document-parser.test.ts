/**
 * document-parser.service.ts 单元测试
 * 测试文档解析服务的核心功能
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import * as crypto from 'crypto'

// Mock Electron 模块
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

import { DocumentParserService } from '../document-parser.service'

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
    async function createTestDocx(tempDir: string, options: { withImage?: boolean; withTable?: boolean; imageCount?: number } = {}): Promise<string> {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()

      const imgCount = options.imageCount ?? (options.withImage ? 1 : 0)

      // 1x1 red pixel PNG
      const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
      const pngBuffer = Buffer.from(pngBase64, 'base64')

      // Content_Types
      let contentTypes = '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      if (imgCount > 0) {
        contentTypes += '<Default Extension="png" ContentType="image/png"/>'
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
        expect(result.error).toContain('超过限制')
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
        expect(result.error).toContain('超过限制')
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
  })
})
