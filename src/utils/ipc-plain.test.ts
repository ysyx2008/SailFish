import { describe, it, expect } from 'vitest'
import { reactive, ref } from 'vue'
import { toIpcPlain } from './ipc-plain'

/** 模拟 Electron IPC 的结构化克隆：响应式代理会被拒收 */
const cloneLikeIpc = (value: unknown) => {
  const proxyLike = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false
    if ((v as { __v_isReactive?: boolean }).__v_isReactive) return true
    return Object.values(v as object).some(proxyLike)
  }
  if (proxyLike(value)) throw new Error('An object could not be cloned.')
  return structuredClone(value)
}

describe('toIpcPlain', () => {
  it('排队队列里取出来的图片和附件是代理，直接送会被拒收；转成纯数据后能送', () => {
    const queue = ref([
      {
        id: 'a',
        images: ['data:image/png;base64,xx'],
        attachments: [{ filename: 'image.png', fileSize: 1 }],
      },
    ])
    const item = queue.value[0]

    expect(() => cloneLikeIpc(item.images)).toThrow()
    expect(() => cloneLikeIpc(item.attachments)).toThrow()

    expect(cloneLikeIpc(toIpcPlain(item.images))).toEqual(['data:image/png;base64,xx'])
    expect(cloneLikeIpc(toIpcPlain(item.attachments))).toEqual([{ filename: 'image.png', fileSize: 1 }])
  })

  it('没有值时原样返回', () => {
    expect(toIpcPlain(undefined)).toBeUndefined()
    expect(toIpcPlain(null)).toBeNull()
  })

  it('嵌套的响应式对象也能拆干净', () => {
    const ctx = reactive({ selectionScope: { excerpt: 'x', nested: { n: 1 } } })
    expect(cloneLikeIpc(toIpcPlain(ctx))).toEqual({ selectionScope: { excerpt: 'x', nested: { n: 1 } } })
  })
})
