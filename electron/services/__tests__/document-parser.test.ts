/**
 * document-parser.service.ts 单元测试
 * 测试文档解析服务的核心功能
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// Mock Electron 模块
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SFTerminal'),
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
      const tempFile = path.join(tempDir, `test-${Date.now()}.xlsx`)
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
      const tempFile = path.join(tempDir, `test-multi-${Date.now()}.xlsx`)
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
      const tempFile = path.join(tempDir, `test-formula-${Date.now()}.xlsx`)
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
