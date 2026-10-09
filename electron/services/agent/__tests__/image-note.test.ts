import { describe, it, expect, beforeAll } from 'vitest'
import { updateLocale } from '../i18n'
import { buildPathOnlyImageNote, buildUserImageNote, collectImageAttachmentPaths, collectPathOnlyImagePaths } from '../image-note'

beforeAll(() => {
  updateLocale('zh-CN')
})

describe('collectImageAttachmentPaths', () => {
  it('只收带路径的图片附件', () => {
    expect(collectImageAttachmentPaths([
      { filename: 'a.png', filePath: '/tmp/a.png', fileSize: 10, fileType: 'png' },
      { filename: 'notes.pdf', filePath: '/tmp/notes.pdf', fileSize: 20, fileType: 'pdf' },
      { filename: 'orphan.png', fileSize: 10, fileType: 'png' },
    ])).toEqual(['/tmp/a.png'])
  })

  it('空附件返回空数组', () => {
    expect(collectImageAttachmentPaths()).toEqual([])
    expect(collectImageAttachmentPaths([])).toEqual([])
  })

  it('只留路径的图不算已经送去看的图', () => {
    const attachments = [
      { filename: 'small.png', filePath: '/tmp/small.png', fileSize: 10, fileType: 'png' },
      { filename: 'big.jpg', filePath: '/tmp/big.jpg', fileSize: 20, fileType: 'jpg', imagePathOnly: true },
    ]
    expect(collectImageAttachmentPaths(attachments)).toEqual(['/tmp/small.png'])
    expect(collectPathOnlyImagePaths(attachments)).toEqual(['/tmp/big.jpg'])
  })

  it('fileType 不像图但路径是图时仍收录', () => {
    expect(collectImageAttachmentPaths([
      { filename: 'pasted-image', filePath: '/tmp/history/images/pasted/pasted-1.png', fileSize: 10, fileType: 'pasted-image' },
    ])).toEqual(['/tmp/history/images/pasted/pasted-1.png'])
  })
})

describe('buildUserImageNote', () => {
  it('有视觉能力且有路径时写明磁盘位置', () => {
    const note = buildUserImageNote({
      count: 1,
      paths: ['/tmp/pasted/a.png'],
      visionAvailable: true,
    })
    expect(note).toContain('/tmp/pasted/a.png')
    expect(note).toContain('无需使用 read_file')
  })

  it('无路径时不提磁盘位置', () => {
    const note = buildUserImageNote({ count: 2, paths: [], visionAvailable: true })
    expect(note).toContain('2')
    expect(note).not.toContain('磁盘路径')
  })

  it('只留路径时说明图像内容没有送进来', () => {
    const note = buildPathOnlyImageNote(['/tmp/big.jpg'])
    expect(note).toContain('/tmp/big.jpg')
    expect(note).toContain('没有直接送进来')
    expect(note).not.toContain('read_file')
  })

  it('无视觉能力时仍告知路径', () => {
    const note = buildUserImageNote({
      count: 1,
      paths: ['/tmp/b.png'],
      visionAvailable: false,
    })
    expect(note).toContain('/tmp/b.png')
    expect(note).toContain('不具备视觉能力')
  })
})
