import { afterEach, describe, expect, it } from 'vitest'
import {
  getEmbeddingInitDeviceCandidates,
  linuxHasGpu,
  resolvePipelineDevice,
} from '../embedding-device'

describe('linuxHasGpu', () => {
  it('有 nvidia 设备节点算有显卡', () => {
    expect(linuxHasGpu(path => path === '/dev/nvidia0', () => [])).toBe(true)
    expect(linuxHasGpu(path => path === '/dev/nvidiactl', () => [])).toBe(true)
  })

  it('有 render 节点算有显卡', () => {
    expect(linuxHasGpu(() => false, () => ['card0', 'renderD128'])).toBe(true)
  })

  it('没有设备节点算没有显卡', () => {
    expect(linuxHasGpu(() => false, () => {
      throw new Error('no dri')
    })).toBe(false)
    expect(linuxHasGpu(() => false, () => ['card0'])).toBe(false)
  })
})

describe('resolvePipelineDevice', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
    if (originalArch) Object.defineProperty(process, 'arch', originalArch)
  })

  function setPlatform(platform: string, arch: string) {
    Object.defineProperty(process, 'platform', { value: platform })
    Object.defineProperty(process, 'arch', { value: arch })
  }

  it('仅 CPU 保持 CPU', () => {
    expect(resolvePipelineDevice('cpu', false)).toBe('cpu')
    expect(getEmbeddingInitDeviceCandidates('cpu', false)).toEqual(['cpu'])
  })

  it('Linux 没有显卡时自动只用 CPU', () => {
    setPlatform('linux', 'x64')
    expect(resolvePipelineDevice('auto', false)).toBe('cpu')
    expect(getEmbeddingInitDeviceCandidates('auto', false)).toEqual(['cpu'])
  })

  it('Linux 有显卡时自动先试加速再回 CPU', () => {
    setPlatform('linux', 'x64')
    expect(resolvePipelineDevice('auto', true)).toBe('gpu')
    expect(getEmbeddingInitDeviceCandidates('auto', true)).toEqual(['gpu', 'cpu'])
  })

  it('Linux 非 x64 自动用 CPU', () => {
    setPlatform('linux', 'arm64')
    expect(resolvePipelineDevice('auto', true)).toBe('cpu')
  })
})
