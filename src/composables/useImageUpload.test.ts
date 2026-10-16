import { describe, it, expect } from 'vitest'
import { buildShrinkPasses, pendingImageToAttachment, type PendingImage } from './useImageUpload'

describe('pendingImageToAttachment', () => {
  it('没有路径则不生成附件', () => {
    const img: PendingImage = { id: '1', dataUrl: 'data:image/png;base64,xx', name: 'a.png', size: 12 }
    expect(pendingImageToAttachment(img)).toBeNull()
  })

  it('有路径则带上文件名与类型', () => {
    const img: PendingImage = {
      id: '1',
      dataUrl: 'data:image/png;base64,xx',
      name: 'shot.png',
      size: 24,
      filePath: '/tmp/history/images/pasted/shot.png',
    }
    expect(pendingImageToAttachment(img)).toEqual({
      filename: 'shot.png',
      filePath: '/tmp/history/images/pasted/shot.png',
      fileSize: 24,
      fileType: 'png',
    })
  })

  it('只留路径的图标明没有把图像送去看', () => {
    const img: PendingImage = {
      id: '1',
      dataUrl: '',
      name: 'photo.jpg',
      size: 6_500_000,
      filePath: '/Users/me/photo.jpg',
      pathOnly: true,
    }
    expect(pendingImageToAttachment(img)).toMatchObject({
      filePath: '/Users/me/photo.jpg',
      imagePathOnly: true,
    })
  })

  it('文件名无扩展名时用落盘路径的扩展名', () => {
    const img: PendingImage = {
      id: '1',
      dataUrl: 'data:image/png;base64,xx',
      name: 'pasted-image',
      size: 24,
      filePath: '/tmp/history/images/pasted/pasted-20260826-200000.png',
    }
    expect(pendingImageToAttachment(img)).toEqual({
      filename: 'pasted-20260826-200000.png',
      filePath: '/tmp/history/images/pasted/pasted-20260826-200000.png',
      fileSize: 24,
      fileType: 'png',
    })
  })
})

describe('buildShrinkPasses', () => {
  it('大图从 2560 长边开始，先降画质再缩小', () => {
    const passes = buildShrinkPasses(3024, 4032)
    expect(passes[0]).toEqual({ maxEdge: 2560, quality: 0.85 })
    expect(passes[1]).toEqual({ maxEdge: 2560, quality: 0.7 })
    expect(passes[2]).toEqual({ maxEdge: 2560, quality: 0.55 })
    expect(passes[3].maxEdge).toBeLessThan(2560)
    const edges = passes.map((pass) => pass.maxEdge)
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]).toBeLessThanOrEqual(edges[i - 1])
    }
    expect(Math.min(...edges)).toBeGreaterThanOrEqual(800)
  })

  it('比 2560 小的图不放大', () => {
    const passes = buildShrinkPasses(640, 480)
    expect(passes[0].maxEdge).toBe(640)
    expect(new Set(passes.map((pass) => pass.maxEdge))).toEqual(new Set([640]))
  })

  it('很长的图也从 2560 长边开始缩', () => {
    const passes = buildShrinkPasses(4500, 25171)
    expect(passes[0]).toEqual({ maxEdge: 2560, quality: 0.85 })
    expect(passes[passes.length - 1].maxEdge).toBeGreaterThanOrEqual(800)
  })
})
